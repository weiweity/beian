"""Bounded Job Object lifecycle, with a portable backend seam for model tests.

No native success is inferred from those tests. Missing APIs, ambiguous state,
timeout while waiting for tree exit, or recovery access errors fail closed.
"""
from __future__ import annotations

import hashlib
import math
import queue
import re
import threading
import time

from windows_job_native import NativeWindowsJobs, WindowsJobError

MAX_TRANSPORT_BYTES = 1024 * 1024
MAX_MEMORY_BYTES = 8 * 1024 ** 3


def job_object_name(execution_id: str) -> str:
    if not isinstance(execution_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,96}:[a-zA-Z0-9_-]{1,96}:[a-f0-9]{32}", execution_id):
        raise WindowsJobError("job_execution_identity")
    # Global namespace survives a service/session change during recovery. Default
    # kernel-object DACL still applies; access denied must remain unknown.
    return "Global\\beian-render-" + hashlib.sha256(execution_id.encode("ascii")).hexdigest()


def _pump(stream, name, events, stopped):
    try:
        while not stopped.is_set():
            data = stream.read(65536)
            while not stopped.is_set():
                try:
                    events.put((name, data), timeout=0.02)
                    break
                except queue.Full:
                    continue
            if not data:
                return
    except (OSError, ValueError):
        stopped.set()


def _send(stream, payload, done):
    try:
        offset = 0
        while offset < len(payload):
            count = stream.write(payload[offset:])
            if not count:
                break
            offset += count
    except (OSError, ValueError):
        pass
    finally:
        stream.close()
        done.set()


def run_owned_job(command, payload: bytes, *, execution_id: str, cwd: str,
                  deadline: float, memory_bytes: int = 4 * 1024 ** 3,
                  cancelled=lambda: False, emit_stderr=lambda _chunk: None,
                  backend=None, clock=time.monotonic, pause=time.sleep):
    name = job_object_name(execution_id)
    if not isinstance(payload, bytes) or len(payload) > 65536 or type(memory_bytes) is not int or not 0 < memory_bytes <= MAX_MEMORY_BYTES:
        raise WindowsJobError("job_budget")
    if not math.isfinite(deadline) or clock() >= deadline or cancelled():
        raise WindowsJobError("job_cancelled_or_expired")
    native = backend if backend is not None else NativeWindowsJobs()
    job = native.create(name, memory_bytes)
    process = None
    stopped = threading.Event()
    events = queue.Queue(maxsize=8)
    stdin_done = threading.Event()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    eof = set()
    failure = None
    cleanup_deadline = None
    confirmed = False
    try:
        process = native.launch_in_job(job, command, cwd)
        threading.Thread(target=_send, args=(process["stdin"], payload, stdin_done), daemon=True).start()
        for key in buffers:
            threading.Thread(target=_pump, args=(process[key], key, events, stopped), daemon=True).start()
        while True:
            now = clock()
            try:
                code, active = native.state(job, process)
                if native.memory_exceeded(job):
                    failure = failure or "job_memory_budget"
            except WindowsJobError:
                code, active = None, None
                failure = failure or "job_accounting_unknown"
            if cancelled() or now >= deadline:
                failure = failure or "job_cancelled_or_expired"
            if stopped.is_set():
                failure = failure or "job_pipe_failure"
            # Drain bounded batches so a log flood cannot starve cancellation.
            for _ in range(8):
                try:
                    key, chunk = events.get_nowait()
                except queue.Empty:
                    break
                if not chunk:
                    eof.add(key)
                elif len(buffers[key]) + len(chunk) > MAX_TRANSPORT_BYTES:
                    failure = failure or "job_transport_budget"
                else:
                    buffers[key].extend(chunk)
                    if key == "stderr":
                        emit_stderr(chunk)
            if failure and cleanup_deadline is None:
                cleanup_deadline = now + 2.0
                try:
                    native.terminate(job)
                except WindowsJobError:
                    failure = "job_termination_unconfirmed"
            if code is not None and active == 0:
                confirmed = True
                if failure:
                    raise WindowsJobError(failure)
                if len(eof) == 2 and stdin_done.is_set():
                    return {"returncode": code, "stdout": bytes(buffers["stdout"]),
                            "execution_id": execution_id, "active_processes": 0}
            if cleanup_deadline is not None and now >= cleanup_deadline:
                raise WindowsJobError("job_exit_unconfirmed")
            pause(0.02)
    finally:
        stopped.set()
        if not confirmed:
            try:
                native.terminate(job)
            except WindowsJobError:
                pass  # No PID fallback; close retains kernel KILL_ON_JOB_CLOSE.
        native.close(job, process)
        if process:
            for key in ("stdin", "stdout", "stderr"):
                try:
                    process[key].close()
                except (OSError, ValueError):
                    pass


def recover_owned_job(execution_id: str, *, cancel=False, backend=None,
                      clock=time.monotonic, pause=time.sleep):
    native = backend if backend is not None else NativeWindowsJobs()
    job = native.open(job_object_name(execution_id))
    if job is None:
        return "missing"
    try:
        _code, active = native.state(job)
        if active == 0:
            return "missing"
        if not cancel:
            return "present"
        native.terminate(job)  # Exact named kernel handle, independent of PID reuse.
        until = clock() + 2.0
        while clock() < until:
            if native.state(job)[1] == 0:
                return "missing"
            pause(0.02)
        return "unknown"
    except WindowsJobError:
        return "unknown"
    finally:
        native.close(job)
