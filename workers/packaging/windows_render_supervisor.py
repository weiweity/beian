"""Windows-only native bridge entry; not enabled by production startup.

Protocol: one bounded JSON request line, followed by a live control pipe. EOF
or CANCEL is cancellation (including Node crash). Worker receives a separate
closed stdin containing only request JSON. Result includes exact container exit
evidence only after active_processes == 0; supervisor close alone is not proof.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import threading
import time

from windows_job_native import WindowsJobError
from windows_owned_job import job_object_name, recover_owned_job, run_owned_job


def supervise(execution_id: str, stream, output, errors):
    name = job_object_name(execution_id)
    raw = stream.readline(65537)
    if len(raw) > 65536 or not raw.endswith(b"\n"):
        raise WindowsJobError("supervisor_request_budget")
    request = json.loads(raw)
    if not isinstance(request, dict):
        raise WindowsJobError("supervisor_request_schema")
    timeout = request.get("timeout_ms")
    if type(timeout) is not int or not 1 <= timeout <= 1_260_000:
        raise WindowsJobError("supervisor_deadline")
    cancelled = threading.Event()

    def watch_parent():
        # No unbounded control line allocation. Any byte or EOF means stop.
        stream.read(1)
        cancelled.set()

    threading.Thread(target=watch_parent, daemon=True).start()
    os.environ["BEIAN_RENDER_JOB_OBJECT"] = name
    entry = Path(__file__).resolve().with_name("render_generation.py")
    result = run_owned_job([sys.executable, str(entry), "-", "--execution-id", execution_id], raw,
        execution_id=execution_id, cwd=str(entry.parent), deadline=time.monotonic() + timeout / 1000,
        cancelled=cancelled.is_set, emit_stderr=lambda chunk: (errors.write(chunk), errors.flush()))
    lines = result["stdout"].decode("utf-8").strip().splitlines()
    answer = json.loads(lines[-1]) if lines else None
    if not isinstance(answer, dict):
        raise WindowsJobError("supervisor_worker_json")
    answer["containment"] = {"protocol": "windows-job-object/1", "execution_id": execution_id,
                             "active_processes": 0, "parent_exited": True}
    output.write((json.dumps(answer, ensure_ascii=False) + "\n").encode("utf-8"))
    output.flush()
    return result["returncode"]


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(args) == 2 and args[0] in {"--recover", "--cancel-owned"}:
            result = recover_owned_job(args[1], cancel=args[0] == "--cancel-owned")
            print(json.dumps({"schema": "render-job-recovery/1", "execution_id": args[1], "state": result}))
            return 0
        if len(args) != 2 or args[0] != "--execution-id":
            raise WindowsJobError("supervisor_arguments")
        if os.name != "nt":
            raise WindowsJobError("process_containment_unavailable")
        return supervise(args[1], sys.stdin.buffer, sys.stdout.buffer, sys.stderr.buffer)
    except Exception as error:
        cause = str(error) if isinstance(error, WindowsJobError) else "supervisor_failed"
        print(json.dumps({"ok": False, "schema": "packaging-render-generation-result/1",
                          "code": "render_generation_failed", "cause": cause}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
