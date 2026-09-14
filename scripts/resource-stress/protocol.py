"""R04 measurement protocol: identity, preflight, sampling, validity.

Reuses the 2026-09-08 resource-stress sampling contract (ps process-tree RSS,
output-dir disk walk, foreign-load classification). This is not a product
quality evaluator and does not start Blender, browsers, or Illustrator.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import os
import platform
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

SCHEMA = "beian-r04-measurement-harness/v1"
SAMPLE_INTERVAL_S = 0.2
FOREIGN_CPU = 50.0
FOREIGN_HIGH_CPU_COMMS = ("python", "node", "chrome", "illustrator")
MAX_FACE_PIXELS = 32_000_000
PS_ARGS = ["ps", "-axo", "pid=,ppid=,rss=,pcpu=,comm="]

IDENTITY_FILES = (
    "VERSION",
    "package-lock.json",
    "workers/packaging/structure_v2/artwork.py",
    "workers/packaging/render_contract.py",
    "workers/packaging/profiles/render-profiles.v1.json",
    "workers/packaging/fixtures/render-quality/manifest.json",
    "workers/packaging/tools/render_quality_eval.py",
    "apps/web/server/src/jobs.ts",
    "apps/web/server/src/uploads.ts",
    "apps/web/server/src/renderGenerationBudget.ts",
    "apps/web/server/src/auth.ts",
    "apps/web/server/src/index.ts",
    "apps/web/server/src/mockup.ts",
    "apps/web/server/src/releaseAdmission.ts",
)

HARNESS_FILES = (
    "cli.py",
    "protocol.py",
    "scenarios.py",
    "synthetic_child.py",
    "evidence.py",
    "plan.py",
    "behavior_fixtures.json",
    "probes/__init__.py",
    "probes/node_argv.mjs",
    "probes/face_probe.py",
    "probes/render_probe.py",
    "probes/upload-probe.mjs",
    "probes/queue-probe.mjs",
    "probes/budget-probe.mjs",
)

OBSERVATION_LIMITS = (
    "sampled peaks are a lower bound, not an absolute peak; short spikes can miss the 200ms poll",
    "process-tree RSS is a sum of each process RSS and may double-count shared pages",
    "tree RSS is not system physical memory and does not include GPU VRAM",
    "32MP (MAX_FACE_PIXELS) is a single-image pixel cap, not a process memory budget",
    "foreign-load detection cannot guarantee exclusion of all system noise",
    "zero foreign alerts is not proof the machine was exclusive (desktop, idle browsers, indexing remain)",
    "disk walks can miss short-lived files between samples; allocated bytes follow st_blocks",
    "this Mac process-group cleanup is not Windows Job Object verification",
    "headroom is only emitted from an observed free-space fact; otherwise unavailable",
)

PIXEL_CAP = {
    "maximum_face_pixels": MAX_FACE_PIXELS,
    "is_process_memory_budget": False,
    "note": "32MP is the single-face pixel cap from render_contract.MAX_FACE_PIXELS, not RSS/headroom",
}

OWNED_PROCESS_POLICY = {
    "manage": "only process groups this tool created via start_new_session",
    "kill_by_name": False,
    "windows_job_object": "not-verified",
    "sigkill_orphan": "unavailable: SIGKILL of the harness cannot run cleanup",
}


def observation_limits() -> list[str]:
    return list(OBSERVATION_LIMITS)


def parse_ps_table(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        parts = line.split(None, 4)
        if len(parts) != 5:
            continue
        try:
            rows.append(
                {
                    "pid": int(parts[0]),
                    "ppid": int(parts[1]),
                    "rss_bytes": int(parts[2]) * 1024,
                    "cpu": float(parts[3]),
                    "comm": parts[4],
                }
            )
        except ValueError:
            continue
    return rows


def snapshot_processes() -> list[dict[str, Any]]:
    raw = subprocess.check_output(PS_ARGS, text=True)
    return parse_ps_table(raw)


def process_tree(rows: list[dict[str, Any]], root_pid: int) -> set[int]:
    ids = {root_pid}
    changed = True
    while changed:
        changed = False
        for row in rows:
            if row["ppid"] in ids and row["pid"] not in ids:
                ids.add(row["pid"])
                changed = True
    return ids


def tree_rss_bytes(rows: list[dict[str, Any]], owned_pids: set[int]) -> int:
    return sum(row["rss_bytes"] for row in rows if row["pid"] in owned_pids)


def _identity_text(row: dict[str, Any]) -> str:
    return f"{row.get('comm', '')} {row.get('command', '')}".lower()


def is_foreign(row: dict[str, Any], owned_pids: set[int], self_pid: int) -> bool:
    if row["pid"] in owned_pids or row["pid"] == self_pid:
        return False
    text = _identity_text(row)
    if "blender" in text:
        return True
    if any(token in text for token in ("resource-stress", "measurement-harness")):
        return True
    if row["cpu"] > FOREIGN_CPU and any(name in text for name in FOREIGN_HIGH_CPU_COMMS):
        return True
    return False


def classify_foreign(
    rows: list[dict[str, Any]],
    owned_pids: set[int],
    self_pid: int | None = None,
) -> list[dict[str, Any]]:
    me = os.getpid() if self_pid is None else self_pid
    return [row for row in rows if is_foreign(row, owned_pids, me)]


def preflight_from_rows(
    rows: list[dict[str, Any]],
    *,
    owned_pids: set[int] | None = None,
    self_pid: int | None = None,
) -> dict[str, Any]:
    me = os.getpid() if self_pid is None else self_pid
    owned = {me} if owned_pids is None else set(owned_pids) | {me}
    suspects = classify_foreign(rows, owned, me)
    reasons = []
    if suspects:
        reasons.append("foreign_render_or_stress_load")
    eligible = not reasons
    return {
        "ok": eligible,
        "budget_eligible": eligible,
        "foreign_load": suspects,
        "reasons": reasons,
        "limits": [
            "detection uses the 2026-09-08 ps comm/cpu protocol plus optional command text",
            "cannot guarantee exclusion of all system noise",
        ],
    }


def _git(repo: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def _sha256_file(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _tool_version(argv: list[str]) -> dict[str, Any]:
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"status": "unavailable", "reason": str(exc)}
    text = (result.stdout or result.stderr).strip()
    if result.returncode != 0 or not text:
        return {"status": "unavailable", "reason": text or f"exit {result.returncode}"}
    return {"status": "observed", "value": text.splitlines()[0]}


def collect_identity(repo: Path) -> dict[str, Any]:
    repo = Path(repo)
    missing: list[str] = []
    head = _git(repo, "rev-parse", "HEAD")
    branch = _git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    if not head:
        missing.append("git HEAD")
    version_path = repo / "VERSION"
    version = version_path.read_text(encoding="utf-8").strip() if version_path.is_file() else None
    if not version:
        missing.append("VERSION")
    files: dict[str, str] = {}
    for rel in IDENTITY_FILES:
        digest = _sha256_file(repo / rel)
        if digest is None:
            missing.append(rel)
        else:
            files[rel] = digest
    # --repo identifies the measured product; the executing harness may live in another checkout.
    harness_dir = Path(__file__).resolve().parent
    harness_files = {name: _sha256_file(harness_dir / name) for name in HARNESS_FILES}
    missing.extend(f"harness:{name}" for name, digest in harness_files.items() if digest is None)
    probe_files = {name: digest for name, digest in harness_files.items() if name.startswith("probes/")}
    identity = {
        "schema": SCHEMA,
        "head": head,
        "branch": branch,
        "version": version,
        "files": files,
        "harness": {"directory": str(harness_dir), "files": harness_files, "probes": probe_files},
        "missing": missing,
        "complete": not missing,
        "platform": platform.platform(),
        "python": {"status": "observed", "value": sys.version.split()[0]},
        "node": _tool_version(["node", "--version"]),
        "pixel_cap": PIXEL_CAP,
    }
    return identity


def disk_usage(path: Path) -> dict[str, int]:
    logical = 0
    allocated = 0
    if not path.exists():
        return {"logical": 0, "allocated": 0}
    for item in path.rglob("*"):
        if not item.is_file() or item.is_symlink():
            continue
        try:
            stat = item.stat()
        except FileNotFoundError:
            continue
        logical += stat.st_size
        allocated += stat.st_blocks * 512
    return {"logical": logical, "allocated": allocated}


def disk_available(path: Path) -> dict[str, Any]:
    probe = path if path.exists() else path.parent
    try:
        stat = os.statvfs(probe)
    except OSError as exc:
        return {"status": "unavailable", "reason": str(exc)}
    return {
        "status": "observed",
        "available_bytes": stat.f_bavail * stat.f_frsize,
        "source": "statvfs.f_bavail",
        "path": str(probe),
    }


def memory_available(*, sysconf: Callable[[str], int] | None = None) -> dict[str, Any]:
    lookup = os.sysconf if sysconf is None else sysconf
    try:
        pages = int(lookup("SC_AVPHYS_PAGES"))
        page = int(lookup("SC_PAGE_SIZE"))
    except (ValueError, OSError, TypeError, AttributeError) as exc:
        return {
            "status": "unavailable",
            "reason": f"no available-memory fact ({exc}); total RAM is not headroom",
        }
    if pages < 0 or page <= 0:
        return {
            "status": "unavailable",
            "reason": "sysconf available pages not a usable fact on this platform; total RAM is not headroom",
        }
    return {
        "status": "observed",
        "available_bytes": pages * page,
        "source": "sysconf SC_AVPHYS_PAGES",
    }


def headroom(path: Path, *, sysconf: Callable[[str], int] | None = None) -> dict[str, Any]:
    return {
        "disk": disk_available(path),
        "memory": memory_available(sysconf=sysconf),
        "note": "headroom is observed free space, not a frozen product budget",
    }


def budget_validity(
    *,
    identity: dict[str, Any],
    preflight: dict[str, Any],
    runs: list[dict[str, Any]],
    workload_kind: str,
    exclusive: bool,
) -> dict[str, Any]:
    reasons: list[str] = []
    if not identity.get("complete"):
        reasons.append("identity_incomplete")
    if not runs:
        reasons.append("no_measurements")
    if any(run.get("exit_code") != 0 or run.get("cancelled") or run.get("launch_error") for run in runs):
        reasons.append("unsuccessful_run")
    if any(not run.get("samples") for run in runs):
        reasons.append("samples_missing")
    if not exclusive:
        reasons.append("not_exclusive_run")
    if workload_kind != "product":
        reasons.append("synthetic_workload")
    if not preflight.get("budget_eligible"):
        reasons.append("preflight_foreign_or_incomplete")
    if any(run.get("measurement_errors") for run in runs):
        reasons.append("measurement_failed")
    if any(run.get("foreign_load") for run in runs):
        reasons.append("foreign_load_during_run")
    return {
        "budget_valid": not reasons,
        "reasons": reasons,
        "cannot_freeze_budget": True,
        "pixel_cap": PIXEL_CAP,
    }


def _send_owned(pgid: int, sig: int) -> None:
    """Signal only the session we created. Never raise into a signal handler."""
    for send in (os.killpg, os.kill):
        try:
            send(pgid, sig)
            return
        except ProcessLookupError:
            return
        except OSError:
            continue


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return False
    return True


def stop_owned_group(pgid: int | None, *, grace_s: float = 0.5) -> None:
    if not pgid:
        return
    _send_owned(pgid, signal.SIGTERM)
    deadline = time.monotonic() + grace_s
    while time.monotonic() < deadline:
        if not _group_alive(pgid):
            return
        time.sleep(0.05)
    _send_owned(pgid, signal.SIGKILL)


def _load_timing(target: Path) -> dict[str, Any]:
    path = target / "timing.json"
    if not path.is_file():
        return {
            "queued_seconds": {
                "status": "unavailable",
                "reason": "workload did not persist queue timing",
            },
            "running_seconds": None,
            "source": None,
        }
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "queued_seconds": {"status": "unavailable", "reason": str(exc)},
            "running_seconds": None,
            "source": str(path),
        }
    if not isinstance(payload, dict):
        payload = {}
    queued = payload.get("queued_seconds")
    running = payload.get("running_seconds")
    out: dict[str, Any] = {"source": "workload timing.json"}
    if type(queued) in (int, float) and math.isfinite(queued) and queued >= 0:
        out["queued_seconds"] = {"status": "observed", "seconds": float(queued)}
    else:
        out["queued_seconds"] = {"status": "unavailable", "reason": "timing.json missing queued_seconds"}
    if type(running) in (int, float) and math.isfinite(running) and running >= 0:
        out["running_seconds"] = {"status": "observed", "seconds": float(running)}
    else:
        out["running_seconds"] = {"status": "unavailable", "reason": "timing.json missing running_seconds"}
    return out


def measure_command(
    name: str,
    command: list[str],
    *,
    cwd: Path,
    output_dir: Path,
    sample_interval_s: float = SAMPLE_INTERVAL_S,
    snapshot_fn: Callable[[], list[dict[str, Any]]] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    env: dict[str, str] | None = None,
    self_pid: int | None = None,
) -> dict[str, Any]:
    """Run one command under the 2026-09-08 sampling protocol.

    Failures still persist metrics and the child exit code. Only the process
    group created here is eligible for cleanup.
    """
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name):
        raise ValueError("name must be a single safe path component")
    if not math.isfinite(sample_interval_s) or sample_interval_s <= 0:
        raise ValueError("sample interval must be finite and positive")
    raw_snapshot = snapshot_fn or snapshot_processes
    measurement_errors: list[str] = []
    def take_snapshot():
        try:
            return raw_snapshot()
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            measurement_errors.append(str(exc))
            return []
    me = os.getpid() if self_pid is None else self_pid
    target = Path(output_dir) / name
    target.mkdir(parents=True, exist_ok=False)
    stdout_path = Path(output_dir) / f"{name}.stdout.log"
    stderr_path = Path(output_dir) / f"{name}.stderr.log"
    before = take_snapshot()
    disk_before = disk_usage(target)
    samples: list[dict[str, Any]] = []
    foreign: list[dict[str, Any]] = []
    launch_error = None
    state: dict[str, Any] = {"cancelled": False, "pgid": None}
    proc: subprocess.Popen[bytes] | None = None
    start = time.monotonic()
    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    child_env["RUNNER_TEMP"] = str(target)
    child_env["PYTHONDONTWRITEBYTECODE"] = "1"

    def handle_signal(signum: int, _frame: object) -> None:
        state["cancelled"] = True
        try:
            stop_owned_group(state["pgid"])
        except Exception:
            return

    def requested_cancel() -> bool:
        return bool(state["cancelled"] or (cancel_check and cancel_check()))

    def record(rows: list[dict[str, Any]], root_pid: int | None) -> None:
        owned = process_tree(rows, root_pid) if root_pid else set()
        owned_rows = [row for row in rows if row["pid"] in owned]
        suspects = classify_foreign(rows, owned, me)
        if suspects:
            foreign.append({"t": time.monotonic() - start, "processes": suspects})
        samples.append(
            {
                "t": time.monotonic() - start,
                "rss_bytes": tree_rss_bytes(rows, owned),
                "rss_note": "sampled tree sum; not an absolute peak; shared pages may be counted twice",
                "processes": owned_rows,
                "disk": disk_usage(target),
            }
        )

    previous_term = signal.getsignal(signal.SIGTERM)
    previous_int = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    try:
        with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open(
            "w", encoding="utf-8"
        ) as stderr:
            try:
                proc = subprocess.Popen(
                    command,
                    cwd=str(cwd),
                    env=child_env,
                    stdout=stdout,
                    stderr=stderr,
                    start_new_session=True,
                )
                state["pgid"] = proc.pid
            except OSError as exc:
                launch_error = str(exc)
            else:
                while True:
                    if measurement_errors or requested_cancel():
                        state["cancelled"] = True
                        stop_owned_group(proc.pid)
                    rows = take_snapshot()
                    record(rows, proc.pid)
                    code = proc.poll()
                    if code is not None:
                        break
                    if state["cancelled"]:
                        try:
                            proc.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            stop_owned_group(proc.pid, grace_s=0)
                            proc.wait(timeout=2)
                        break
                    try:
                        time.sleep(sample_interval_s)
                    except InterruptedError:
                        continue
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGINT, previous_int)
        if proc is not None:
            # The leader may have exited while descendants still own this group.
            stop_owned_group(proc.pid)
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass

    exit_code = None if proc is None else proc.returncode
    cancelled = bool(state["cancelled"])
    if launch_error and exit_code is None:
        exit_code = 127
    elapsed = time.monotonic() - start
    disk_after = disk_usage(target)
    timing = _load_timing(target)
    if timing.get("running_seconds") is None:
        timing["running_seconds"] = {
            "status": "observed",
            "seconds": elapsed,
            "source": "process lifetime",
        }
    result = {
        "schema": SCHEMA,
        "name": name,
        "command": command,
        "cwd": str(cwd),
        "exit_code": exit_code,
        "launch_error": launch_error,
        "measurement_errors": measurement_errors,
        "cancelled": cancelled,
        "seconds": elapsed,
        "sample_interval_s": sample_interval_s,
        "platform": platform.platform(),
        "before": before,
        "samples": samples,
        "foreign_load": foreign,
        "peak_tree_rss_bytes": max((sample["rss_bytes"] for sample in samples), default=0),
        "peak_rss_note": "sampled lower bound, not an absolute peak",
        "peak_disk_logical": max((sample["disk"]["logical"] for sample in samples), default=0),
        "peak_disk_allocated": max((sample["disk"]["allocated"] for sample in samples), default=0),
        "disk_before": disk_before,
        "disk_after": disk_after,
        "disk_delta": {
            "logical": disk_after["logical"] - disk_before["logical"],
            "allocated": disk_after["allocated"] - disk_before["allocated"],
        },
        "queue_run_times": timing,
        "owned_process_policy": OWNED_PROCESS_POLICY,
        "pixel_cap": PIXEL_CAP,
        "after": take_snapshot(),
    }
    metrics_path = Path(output_dir) / f"{name}.metrics.json"
    metrics_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    result["metrics_path"] = str(metrics_path)
    return result


def command_summary(run: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "name",
        "command",
        "cwd",
        "exit_code",
        "cancelled",
        "launch_error",
        "seconds",
        "peak_tree_rss_bytes",
        "disk_delta",
        "queue_run_times",
    )
    return {key: run.get(key) for key in keys}


def render_report_md(bundle: dict[str, Any]) -> str:
    validity = bundle.get("validity", {})
    identity = bundle.get("identity", {})
    rows = []
    for run in bundle.get("runs", []):
        rss = run.get("peak_tree_rss_bytes") or 0
        rows.append(
            f"| {run.get('name')} | {run.get('exit_code')} | {run.get('seconds'):.3f} | "
            f"{rss / 1048576:.1f} | {len(run.get('foreign_load') or [])} | "
            f"{'yes' if run.get('cancelled') else 'no'} |"
        )
    matrix_rows = []
    for scene in bundle.get("matrix", []):
        matrix_rows.append(
            f"| {scene.get('id')} | {scene.get('coverage')} | {scene.get('this_round')} | "
            f"{scene.get('status')} |"
        )
    limits = "\n".join(f"- {item}" for item in bundle.get("observation_limits", OBSERVATION_LIMITS))
    reasons = ", ".join(validity.get("reasons") or []) or "(none)"
    return f"""# R04 测量工具报告

状态：本文件由 `scripts/resource-stress` 生成，只证明工具与轻量合成场景；**不是 R04 整项验收，不是独占性能预算**。

## 身份

- HEAD：`{identity.get('head')}`
- 分支：`{identity.get('branch')}`
- VERSION：`{identity.get('version')}`
- 身份完整：{identity.get('complete')}
- 缺失：{identity.get('missing') or []}

## 有效性

- budget_valid：{validity.get('budget_valid')}
- 原因：{reasons}
- 32MP 不是进程内存预算：{PIXEL_CAP['note']}

## 观测限制

{limits}

## 场景覆盖（旧矩阵映射）

| id | 覆盖 | 本轮 | 状态 |
|---|---|---|---|
{os.linesep.join(matrix_rows)}

## 本轮采样

采样峰值是下界；树 RSS 相加可能重复计共享页。失败场景仍保留指标和退出码。

| 步骤 | 退出码 | 墙钟秒 | 采样树RSS MiB | 外部高负载采样数 | 取消 |
|---|---:|---:|---:|---:|---|
{os.linesep.join(rows)}

## 未验证

- 未启动 Blender / 浏览器压力负载
- 未冻结预算、未改产品限制
- 未把 Mac 进程组清理写成 Windows Job Object
- 正式独占测量需主 agent 后续串行安排
"""
