from __future__ import annotations

import ctypes
import io
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
if str(PACKAGING) not in sys.path:
    sys.path.insert(0, str(PACKAGING))

from windows_job_native import Accounting, BasicLimit, ExtendedLimit, NativeWindowsJobs, StartupInfoEx, WindowsJobError
from windows_owned_job import job_object_name, recover_owned_job, run_owned_job

EXECUTION = "synthetic:mutation:" + "a" * 32


class ModelJobs:
    """Kernel-contract model, explicitly NOT Windows native evidence."""
    def __init__(self, states=None, output=b"{}\n", fault=None):
        self.states = list(states or [(0, 0)])
        self.output = output
        self.fault = fault
        self.calls = []
        self.time = 0.0
        self.process = None

    def clock(self):
        return self.time

    def pause(self, seconds):
        self.time += seconds
        time.sleep(0)  # Yield to bounded pipe pump threads without wall-clock delay.

    def create(self, name, memory):
        self.calls.append(("create_with_limits", name, memory))
        if self.fault == "create":
            raise WindowsJobError("job_create_failed")
        return object()

    def open(self, name):
        self.calls.append(("open_by_execution_not_pid", name))
        if self.fault == "absent":
            return None
        if self.fault == "access":
            raise WindowsJobError("job_recovery_unknown")
        return object()

    def launch_in_job(self, job, command, cwd):
        self.calls.append(("atomic_job_list_launch", job))
        if self.fault == "launch":
            raise WindowsJobError("job_atomic_assignment_unavailable")
        self.process = {"handle": object(), "pid": 777, "stdin": io.BytesIO(),
                        "stdout": io.BytesIO(self.output), "stderr": io.BytesIO(b"STAGE validate\n")}
        return self.process

    def state(self, job, process=None):
        self.calls.append(("state_from_handle", job))
        if self.fault == "query":
            raise WindowsJobError("job_accounting_unknown")
        if len(self.states) > 1:
            return self.states.pop(0)
        return self.states[0]

    def memory_exceeded(self, job):
        return self.fault == "memory"

    def terminate(self, job):
        self.calls.append(("terminate_job_handle", job))
        if self.fault == "terminate":
            raise WindowsJobError("job_terminate_failed")
        if self.fault != "query":
            self.states = [(1, 0)]

    def close(self, job, process=None):
        self.calls.append(("close_kill_on_last_handle", job))


def model_run(model, **kwargs):
    return run_owned_job([sys.executable, "synthetic"], b"{}", execution_id=EXECUTION, cwd=str(PACKAGING),
        deadline=kwargs.pop("deadline", 10.0), backend=model, clock=model.clock, pause=model.pause, **kwargs)


def test_windows_native_layout_uses_windows_widths_even_on_model_host():
    assert ctypes.sizeof(Accounting) == 48
    if ctypes.sizeof(ctypes.c_void_p) == 8:
        assert ctypes.sizeof(BasicLimit) == 64
        assert ctypes.sizeof(ExtendedLimit) == 144
        assert ctypes.sizeof(StartupInfoEx) == 112
    if os.name != "nt":
        with pytest.raises(WindowsJobError, match="containment_unavailable"):
            NativeWindowsJobs()


def test_name_is_bound_to_whole_execution_not_reused_pid():
    assert job_object_name(EXECUTION) != job_object_name(EXECUTION.replace("a" * 32, "b" * 32))
    assert job_object_name(EXECUTION).startswith("Global\\beian-render-")
    for invalid in ("777", "job:mutation", EXECUTION + "/", EXECUTION.upper(), None):
        with pytest.raises(WindowsJobError, match="execution_identity"):
            job_object_name(invalid)


def test_parent_exit_and_closed_pipes_are_not_tree_completion():
    model = ModelJobs(states=[(0, 2), (0, 1), (0, 0)])
    result = model_run(model)
    assert result["stdout"] == b"{}\n"
    assert result["active_processes"] == 0
    assert result["execution_id"] == EXECUTION
    assert len([call for call in model.calls if call[0] == "state_from_handle"]) >= 3
    assert model.calls[0][0] == "create_with_limits"
    assert model.calls[1][0] == "atomic_job_list_launch"
    assert model.calls[-1][0] == "close_kill_on_last_handle"


@pytest.mark.parametrize("fault", ["create", "launch", "query", "terminate", "memory"])
def test_native_model_failures_never_fall_back_to_pid_or_claim_completion(fault):
    model = ModelJobs(states=[(None, 1)], fault=fault)
    with pytest.raises(WindowsJobError):
        model_run(model, deadline=0.1)
    operations = [call[0] for call in model.calls]
    assert not any("pid_kill" in operation for operation in operations)
    if fault != "create":
        assert operations[-1] == "close_kill_on_last_handle"
    else:
        assert "atomic_job_list_launch" not in operations


@pytest.mark.parametrize("failure", ["deadline", "cancel", "stdout"])
def test_deadline_cancel_log_flood_terminate_handle_and_wait_for_zero(failure):
    model = ModelJobs(states=[(None, 1)], output=b"x" * (2 * 1024 * 1024) if failure == "stdout" else b"{}")
    with pytest.raises(WindowsJobError, match="job_(cancelled_or_expired|transport_budget)"):
        model_run(model, deadline=0.1 if failure == "deadline" else 10,
                  cancelled=lambda: failure == "cancel" and model.time >= 0.04)
    assert any(call[0] == "terminate_job_handle" for call in model.calls)
    assert model.calls[-1][0] == "close_kill_on_last_handle"


def test_expired_request_and_invalid_budget_do_not_create_container_or_process():
    model = ModelJobs()
    with pytest.raises(WindowsJobError):
        model_run(model, deadline=0)
    with pytest.raises(WindowsJobError):
        model_run(model, memory_bytes=10 * 1024 ** 3)
    assert model.calls == []


@pytest.mark.parametrize("fault,expected", [("absent", "missing"), (None, "present"), ("query", "unknown")])
def test_restart_recovery_uses_exact_execution_job_and_unknown_stays_unknown(fault, expected):
    model = ModelJobs(states=[(0, 1)], fault=fault)
    assert recover_owned_job(EXECUTION, backend=model) == expected
    assert model.calls[0] == ("open_by_execution_not_pid", job_object_name(EXECUTION))
    assert not any(call[0] == "terminate_job_handle" for call in model.calls)


def test_recovery_cancel_waits_for_active_zero_and_access_errors_cannot_release():
    model = ModelJobs(states=[(0, 1)])
    assert recover_owned_job(EXECUTION, cancel=True, backend=model, clock=model.clock, pause=model.pause) == "missing"
    assert any(call[0] == "terminate_job_handle" for call in model.calls)
    with pytest.raises(WindowsJobError, match="recovery_unknown"):
        recover_owned_job(EXECUTION, backend=ModelJobs(fault="access"))


@pytest.mark.skipif(os.name != "nt" or os.environ.get("BEIAN_TEST_WINDOWS_JOB") != "1", reason="explicit Windows native owned-container evidence")
def test_native_job_waits_for_actual_grandchild_and_recovery_after_exit(tmp_path):
    command = [sys.executable, "-c", "import subprocess,sys;subprocess.Popen([sys.executable,'-c','import time;time.sleep(.3)']);print('{}')"]
    start = time.monotonic()
    result = run_owned_job(command, b"", execution_id=EXECUTION, cwd=str(tmp_path), deadline=start + 10)
    assert result["returncode"] == 0 and result["active_processes"] == 0
    assert time.monotonic() - start >= 0.3
    assert recover_owned_job(EXECUTION) == "missing"


@pytest.mark.skipif(os.name != "nt" or os.environ.get("BEIAN_TEST_WINDOWS_JOB") != "1", reason="explicit Windows native cancellation and memory evidence")
@pytest.mark.parametrize("reason", ["cancel", "memory"])
def test_native_limits_stop_tree_and_do_not_leave_named_container(tmp_path, reason):
    identity = EXECUTION.replace("mutation", reason)
    script = "import time;time.sleep(30)" if reason == "cancel" else "x=bytearray(512*1024*1024)"
    start = time.monotonic()
    with pytest.raises(WindowsJobError, match="job_cancelled_or_expired" if reason == "cancel" else "job_memory_budget"):
        run_owned_job([sys.executable, "-c", script], b"", execution_id=identity, cwd=str(tmp_path),
            deadline=start + 10, memory_bytes=128*1024*1024,
            cancelled=lambda: reason == "cancel" and time.monotonic() - start > 0.15)
    assert recover_owned_job(identity) == "missing"


@pytest.mark.skipif(os.name != "nt" or os.environ.get("BEIAN_TEST_WINDOWS_JOB") != "1", reason="explicit Windows native crash-before-resume evidence")
def test_native_supervisor_crash_after_atomic_creation_before_resume_leaves_no_job(tmp_path):
    identity = EXECUTION.replace("mutation", "crash")
    script = tmp_path / "crash_before_resume.py"
    script.write_text(
        "import os,sys\n"
        f"sys.path.insert(0,{str(PACKAGING)!r})\n"
        "from windows_job_native import NativeWindowsJobs\n"
        "from windows_owned_job import job_object_name\n"
        "native=NativeWindowsJobs()\n"
        "native.api.ResumeThread=lambda handle: os._exit(91)\n"
        f"job=native.create(job_object_name({identity!r}),128*1024*1024)\n"
        f"native.launch_in_job(job,[sys.executable,'-c','import time;time.sleep(30)'],{str(tmp_path)!r})\n"
    )
    result = subprocess.run([sys.executable,str(script)], capture_output=True, timeout=10)
    assert result.returncode == 91, result.stderr
    until = time.monotonic() + 5
    while recover_owned_job(identity) != "missing" and time.monotonic() < until:
        time.sleep(0.02)
    assert recover_owned_job(identity) == "missing"
