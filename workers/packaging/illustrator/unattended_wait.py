from __future__ import annotations

import json
from typing import Any


PROGRESS_SCHEMA = "illustrator-job-progress/1"
SAVING_STAGES = frozenset({
    "opening",
    "inventory",
    "saving_full_pdf",
    "saving_artwork_pdf",
    "writing_result",
    "closing",
})
STALL_SECONDS = 60
SAVING_STALL_SECONDS = 300
MAX_JOB_SECONDS = 900
OUTER_SECONDS = 1260
PIPE_TIMEOUT_MS_MIN = 30_000
PIPE_TIMEOUT_MS_MAX = OUTER_SECONDS * 1000


def clamp_timeout_ms(timeout_seconds: int) -> int:
    return max(PIPE_TIMEOUT_MS_MIN, min(PIPE_TIMEOUT_MS_MAX, int(timeout_seconds) * 1000))


def parse_job_sidecar(raw: str | None, attempt_id: str) -> dict[str, Any] | None:
    if not raw or not str(raw).strip() or not attempt_id:
        return None
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if str(payload.get("schema") or "") != PROGRESS_SCHEMA:
        return None
    if str(payload.get("attempt_id") or "") != attempt_id:
        return None
    return payload


def progress_stage(payload: dict[str, Any] | None) -> str:
    if not payload:
        return ""
    return str(payload.get("stage") or "")


def kill_forbidden(stage: str) -> bool:
    return stage in SAVING_STAGES


def wait_decision(
    *,
    elapsed_s: float,
    stage: str | None,
    progress_age_s: float | None,
    has_matching_result: bool,
    process_exited: bool,
) -> str:
    """Return wait | kill | done for the unattended job waiter."""
    if process_exited:
        return "done"
    current_stage = str(stage or "")
    if kill_forbidden(current_stage):
        return "wait"
    stalled = progress_age_s is not None and progress_age_s >= STALL_SECONDS
    if has_matching_result:
        if stalled:
            return "kill"
        return "wait"
    if stalled or elapsed_s >= MAX_JOB_SECONDS:
        return "kill"
    return "wait"


def worker_exit_during_saving_must_not_fence(stage: str) -> bool:
    return kill_forbidden(stage)
