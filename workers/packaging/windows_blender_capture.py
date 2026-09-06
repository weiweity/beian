"""Windows pipe capture only inside a verified native owned Job Object."""
from __future__ import annotations

import os
import queue
import re
import subprocess
import threading
import time

from windows_job_native import NativeWindowsJobs


def capture_job_blender(command, *, deadline, log_limit, termination_grace_s, error_type):
    name = os.environ.get("BEIAN_RENDER_JOB_OBJECT", "")
    if not re.fullmatch(r"Global\\beian-render-[a-f0-9]{64}", name):
        raise error_type("process_containment_unavailable")
    NativeWindowsJobs().assert_current_member(name)
    # CreateProcess children inherit the owning Job; no BREAKAWAY flag.
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, bufsize=0)
    events = queue.Queue(maxsize=4)
    stopped = threading.Event()
    output = bytearray()

    def pump():
        try:
            while not stopped.is_set():
                chunk = process.stdout.read(65536)
                while not stopped.is_set():
                    try:
                        events.put(chunk, timeout=0.02)
                        break
                    except queue.Full:
                        continue
                if not chunk:
                    break
        except (OSError, ValueError):
            stopped.set()

    threading.Thread(target=pump, daemon=True).start()
    eof = False
    try:
        while True:
            if time.monotonic() >= deadline:
                raise error_type("blender_timeout", bytes(output))
            if stopped.is_set():
                raise error_type("blender_pipe_failed", bytes(output))
            try:
                chunk = events.get(timeout=0.02)
                if not chunk:
                    eof = True
                remaining = log_limit - len(output)
                output.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    raise error_type("blender_log_budget", bytes(output))
            except queue.Empty:
                pass
            if process.poll() is not None and eof:
                return subprocess.CompletedProcess(command, process.returncode, bytes(output), b"")
    finally:
        stopped.set()
        if process.poll() is None:
            process.kill()  # Retained Popen Windows handle, not taskkill/PID lookup.
            try:
                process.wait(timeout=termination_grace_s)
            except subprocess.TimeoutExpired:
                pass  # Outer native job owner still requires active count zero.
        process.stdout.close()
