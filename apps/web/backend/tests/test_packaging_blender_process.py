from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import time

import pytest

PATH = Path(__file__).resolve().parents[4] / "workers/packaging/blender_process.py"
spec = importlib.util.spec_from_file_location("bounded_blender_process_test", PATH)
assert spec and spec.loader
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


@pytest.mark.skipif(os.name != "posix", reason="Windows owned process container is not wired")
@pytest.mark.parametrize("stream", [1, 2])
def test_pipe_output_is_bounded_and_owned_child_exits(monkeypatch, stream):
    spawned = []
    original = capture.subprocess.Popen

    def record(*args, **kwargs):
        child = original(*args, **kwargs)
        spawned.append(child)
        assert not kwargs.get("start_new_session", False)
        return child

    monkeypatch.setattr(capture.subprocess, "Popen", record)
    with pytest.raises(capture.BlenderProcessError) as caught:
        capture.run_bounded_blender([sys.executable, "-c", f"import os;os.write({stream},b'x'*2000000)"],
                                    deadline=time.monotonic()+3, log_limit=4096, termination_grace_s=0.05)
    assert caught.value.cause == "blender_log_budget"
    assert len(caught.value.output) == 4096
    assert spawned[0].poll() is not None


@pytest.mark.skipif(os.name != "posix", reason="Windows owned process container is not wired")
def test_hung_owned_child_is_killed_without_unbounded_wait(monkeypatch):
    spawned = []
    original = capture.subprocess.Popen

    def record(*args, **kwargs):
        child = original(*args, **kwargs)
        spawned.append(child)
        return child

    monkeypatch.setattr(capture.subprocess, "Popen", record)
    started = time.monotonic()
    with pytest.raises(capture.BlenderProcessError) as caught:
        capture.run_bounded_blender([sys.executable, "-c",
            "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('ready',flush=True);time.sleep(10)"],
            deadline=started+0.2, termination_grace_s=0.05)
    assert caught.value.cause == "blender_timeout"
    assert b"ready" in caught.value.output
    assert time.monotonic()-started < 2
    assert spawned[0].poll() is not None


@pytest.mark.skipif(os.name != "posix", reason="Windows owned process container is not wired")
def test_complete_capture_keeps_both_streams_and_exit_status():
    result = capture.run_bounded_blender([sys.executable, "-c",
        "import os;os.write(1,b'out');os.write(2,b'err');raise SystemExit(7)"], deadline=time.monotonic()+3)
    assert result.returncode == 7
    assert b"out" in result.stdout and b"err" in result.stdout


def test_expired_deadline_does_not_spawn(monkeypatch):
    monkeypatch.setattr(capture.subprocess, "Popen", lambda *a, **k: pytest.fail("must not spawn"))
    with pytest.raises(capture.BlenderProcessError):
        capture.run_bounded_blender(["unused"], deadline=time.monotonic()-1)


@pytest.mark.skipif(os.name != "posix", reason="Windows owned process container is not wired")
def test_pipe_setup_failure_stops_only_its_owned_child(monkeypatch):
    spawned = []
    original = capture.subprocess.Popen

    def record(*args, **kwargs):
        child = original(*args, **kwargs)
        spawned.append(child)
        return child

    def unavailable():
        raise OSError("synthetic selector setup failure")

    monkeypatch.setattr(capture.subprocess, "Popen", record)
    monkeypatch.setattr(capture.selectors, "DefaultSelector", unavailable)
    try:
        with pytest.raises(OSError, match="synthetic selector"):
            capture.run_bounded_blender([sys.executable, "-c", "import time;time.sleep(10)"],
                                        deadline=time.monotonic()+3, termination_grace_s=0.05)
        assert spawned[0].poll() is not None
    finally:
        if spawned and spawned[0].poll() is None:
            spawned[0].kill()
            spawned[0].wait(timeout=1)
