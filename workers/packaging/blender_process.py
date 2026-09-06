"""Bounded Blender pipe capture for the isolated generation bridge.

No new session/group: descendants stay inside the Node-owned process group.
This module proves only its direct child's exit. The bridge must still wait for
the entire owned group. Windows capture requires verified native Job membership;
the main bridge's Windows creation gate remains disabled pending native evidence.
"""

from __future__ import annotations

import os
import math
import selectors
import subprocess
import time

MAX_LOG_BYTES = 8 * 1024 * 1024


class BlenderProcessError(RuntimeError):
    def __init__(self, cause: str, output: bytes = b""):
        super().__init__(cause)
        self.cause = cause
        self.output = output


def run_bounded_blender(
    command: list[str], *, deadline: float, log_limit: int = MAX_LOG_BYTES,
    termination_grace_s: float = 2.0,
) -> subprocess.CompletedProcess[bytes]:
    if not 0 < log_limit <= MAX_LOG_BYTES or not 0 < termination_grace_s <= 2.0:
        raise BlenderProcessError("blender_capture_budget")
    if not math.isfinite(deadline) or time.monotonic() >= deadline:
        raise BlenderProcessError("blender_timeout")
    if os.name == "nt":
        from windows_blender_capture import capture_job_blender
        return capture_job_blender(command, deadline=deadline, log_limit=log_limit,
            termination_grace_s=termination_grace_s, error_type=BlenderProcessError)
    if os.name != "posix":
        raise BlenderProcessError("process_containment_unavailable")
    # Never use communicate/capture_output: those accumulate unbounded bytes.
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, bufsize=0)
    output = bytearray()
    failure: str | None = None
    stopping_at: float | None = None
    exited_at: float | None = None
    eof = False
    selector = None
    try:
        selector = selectors.DefaultSelector()
        assert process.stdout is not None
        os.set_blocking(process.stdout.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ)
        while True:
            now = time.monotonic()
            code = process.poll()
            if now >= deadline and failure is None:
                failure = "blender_timeout"
            if code is not None:
                exited_at = now if exited_at is None else exited_at
                if eof:
                    break
                if now - exited_at >= termination_grace_s:
                    failure = failure or "blender_output_drain"
                    break
            elif failure is not None:
                if stopping_at is None:
                    stopping_at = now
                    process.terminate()  # Only this Popen-owned direct child.
                elif now - stopping_at >= termination_grace_s:
                    process.kill()
                if now - stopping_at >= 2 * termination_grace_s:
                    break  # Node still owns/fences any unconfirmed processes.
            for key, _events in selector.select(timeout=0.02):
                try:
                    chunk = os.read(key.fd, 64 * 1024)
                except BlockingIOError:
                    continue
                if not chunk:
                    eof = True
                    selector.unregister(key.fileobj)
                    continue
                available = log_limit - len(output)
                output.extend(chunk[:available])
                if len(chunk) > available:
                    failure = failure or "blender_log_budget"
        if failure:
            raise BlenderProcessError(failure, bytes(output))
        return subprocess.CompletedProcess(command, process.returncode, bytes(output), b"")
    finally:
        if selector is not None:
            selector.close()
        if process.stdout is not None:
            process.stdout.close()
        if process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=termination_grace_s)
            except subprocess.TimeoutExpired:
                # Never claim group release here; Node's existing barrier owns it.
                pass
