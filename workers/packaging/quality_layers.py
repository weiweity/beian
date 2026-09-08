"""RF-10 three-layer quality classification.

Pure functions: no disk, no Blender, no HTTP. Callers supply already-collected
facts. Machine results never write human_acceptance or production_ready.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from hmac import compare_digest
from typing import Any


LAYER_SCHEMA = "packaging-render-quality-layers/1"
RENDER_QUALITY_SCHEMA = "packaging-render-quality/1"
HUMAN_PENDING = "pending"
HUMAN_ACCEPTED = "accepted"
HUMAN_REJECTED = "rejected"
ALLOWED_HUMAN = (HUMAN_PENDING, HUMAN_ACCEPTED, HUMAN_REJECTED)


def _reasons(*parts: str | None) -> list[str]:
    return [item for item in parts if isinstance(item, str) and item.strip()]


def classify_quality_layers(
    *,
    render_requested: bool,
    blender_ready: bool,
    blender_failure_reason: str | None = None,
    identity_verified: bool,
    identity_reason: str | None = None,
    runtime_complete: bool,
    runtime_reason: str | None = None,
    baseline_present: bool,
    baseline_status: str | None = None,
    baseline_reason: str | None = None,
    fixture_metrics_ok: bool | None = None,
    fixture_metrics_reason: str | None = None,
    observations: Sequence[Mapping[str, Any]] | None = None,
    sampling: Mapping[str, Any] | None = None,
    human_acceptance: str = HUMAN_PENDING,
) -> dict[str, Any]:
    """Split runtime / fixture-regression / human results.

    ``human_acceptance`` is caller-supplied only. Passing machine pass does not
    change it; this function never promotes pending → accepted.
    ``baseline_mismatch`` is a fixture-regression status, not a visual fail.
    """
    if human_acceptance not in ALLOWED_HUMAN:
        raise ValueError("human_acceptance_invalid")
    notes = [dict(item) for item in observations or ()]

    if not render_requested:
        runtime_status = "not-run"
        runtime_reasons = ["render_not_requested"]
        runtime_blocks = False
    elif not blender_ready:
        runtime_status = "fail"
        runtime_reasons = _reasons(blender_failure_reason, "blender_unavailable")
        runtime_blocks = True
    elif not identity_verified:
        runtime_status = "fail"
        runtime_reasons = _reasons(identity_reason, "identity_changed_during_run")
        runtime_blocks = True
    elif not runtime_complete:
        runtime_status = "fail"
        runtime_reasons = _reasons(runtime_reason, "runtime_incomplete")
        runtime_blocks = True
    else:
        runtime_status = "pass"
        runtime_reasons = []
        runtime_blocks = False

    fixture_can_run = render_requested and blender_ready and runtime_complete and identity_verified
    if not fixture_can_run:
        fixture_status = "not-run"
        fixture_reasons = _reasons(
            blender_failure_reason if render_requested and not blender_ready else None,
            runtime_reason if render_requested and blender_ready and not runtime_complete else None,
            identity_reason if render_requested and blender_ready and not identity_verified else None,
            "fixture_regression_not_run",
        )
    elif not baseline_present:
        fixture_status = "baseline_absent"
        fixture_reasons = _reasons(baseline_reason) or ["approved_baseline_absent"]
    elif baseline_status == "identity_mismatch":
        fixture_status = "baseline_mismatch"
        fixture_reasons = _reasons(baseline_reason, "baseline_identity_mismatch")
    elif baseline_status == "invalid":
        fixture_status = "fail"
        fixture_reasons = _reasons(baseline_reason, "approved_baseline_invalid")
    elif fixture_metrics_ok is False:
        fixture_status = "fail"
        fixture_reasons = _reasons(fixture_metrics_reason, "fixture_metric_regression")
    elif fixture_metrics_ok is True and baseline_status == "ok":
        fixture_status = "pass"
        fixture_reasons = []
    else:
        fixture_status = "not-run"
        fixture_reasons = _reasons(fixture_metrics_reason, "fixture_regression_not_run")

    if notes:
        visual_status = "warn"
    elif runtime_status == "pass":
        visual_status = "observed"
    else:
        visual_status = "not-run"

    machine_metrics = {
        "runtime_integrity": runtime_status,
        "fixture_regression": fixture_status,
        "visual_observations": visual_status,
    }
    official_machine_green = runtime_status == "pass" and fixture_status == "pass"
    return {
        "schema": LAYER_SCHEMA,
        "runtime_hard": {
            "status": runtime_status,
            "reasons": runtime_reasons,
            "blocks_current": runtime_blocks,
        },
        "fixture_regression_hard": {
            "status": fixture_status,
            "reasons": fixture_reasons,
            "blocks_current": False,
            "visual_task_fail": False,
        },
        "warning_human": {
            "status": visual_status,
            "observations": notes,
            "human_acceptance": human_acceptance,
            "blocks_current": False,
        },
        "machine_metrics": machine_metrics,
        "human_acceptance": human_acceptance,
        "production_ready": False,
        "official_machine_green": official_machine_green,
        "sampling": dict(sampling) if isinstance(sampling, Mapping) else {
            "status": "unavailable",
            "reason": "sampling_not_supplied",
        },
    }


def _fingerprint_values_equal(left: Any, right: Any) -> bool:
    """Exact compare. Use compare_digest only for equal-length strings."""
    if isinstance(left, str) and isinstance(right, str):
        return len(left) == len(right) and compare_digest(left, right)
    return left == right


def compare_fixture_metric_fingerprints(
    current: Mapping[str, Mapping[str, Any]],
    baseline: Mapping[str, Mapping[str, Any]],
) -> tuple[bool, str]:
    """Exact measured-fingerprint compare. No tolerance. Missing keys fail closed."""
    if not isinstance(current, Mapping) or not isinstance(baseline, Mapping):
        return False, "fixture_fingerprint_invalid"
    current_ids = set(current)
    baseline_ids = set(baseline)
    if current_ids != baseline_ids:
        missing = sorted(baseline_ids - current_ids)
        extra = sorted(current_ids - baseline_ids)
        if missing:
            return False, f"fixture_missing:{missing[0]}"
        return False, f"fixture_unexpected:{extra[0]}"
    for fixture_id in sorted(baseline_ids):
        left = baseline[fixture_id]
        right = current[fixture_id]
        if not isinstance(left, Mapping) or not isinstance(right, Mapping):
            return False, f"fixture_fingerprint_invalid:{fixture_id}"
        if set(left) != set(right):
            absent = sorted(set(left) - set(right))
            added = sorted(set(right) - set(left))
            if absent:
                return False, f"metric_missing:{fixture_id}:{absent[0]}"
            return False, f"metric_unexpected:{fixture_id}:{added[0]}"
        for key in sorted(left):
            if not _fingerprint_values_equal(left[key], right[key]):
                return False, f"metric_regression:{fixture_id}:{key}"
    return True, "ok"


def build_runtime_quality_report(
    *,
    action: str,
    runtime_gate: str,
    sampling: Mapping[str, Any] | None = None,
    reasons: Sequence[str] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Worker-facing packaging-render-quality/1 payload for a real job.

    Fixture regression is always not-run here: this is not the synthetic suite.
    human_acceptance stays pending. production_ready stays false.
    """
    if runtime_gate not in ("pass", "fail", "not-run"):
        raise ValueError("runtime_gate_invalid")
    if action in ("validate", "prepare") and runtime_gate == "pass":
        raise ValueError("validate_prepare_cannot_claim_runtime_pass")
    visual = "not-run"
    fixture = "not-run"
    default_note = (
        "runtime 产物完整性与资源合同已接线；夹具回归未在真实任务上运行；"
        "人工验收独立 pending。不得当作视觉通过或 production-ready"
    )
    if runtime_gate == "fail":
        default_note = "runtime hard gate 失败；候选不得切换 current；不是真实任务视觉评分"
    elif runtime_gate == "not-run":
        default_note = "本动作未执行候选产物 runtime 门；人工验收独立 pending"
    payload = {
        "schema": RENDER_QUALITY_SCHEMA,
        "status": "layered",
        "wired": True,
        "runtime_gate": runtime_gate,
        "fixture_regression": fixture,
        "visual_observations": visual,
        "machine_metrics": {
            "runtime_integrity": runtime_gate,
            "fixture_regression": fixture,
            "visual_observations": visual,
        },
        "human_acceptance": HUMAN_PENDING,
        "production_ready": False,
        "sampling": dict(sampling) if isinstance(sampling, Mapping) else {
            "status": "unavailable",
            "reason": "not_collected_for_this_action",
        },
        "note": note or default_note,
        "reasons": list(reasons or ()),
    }
    return payload


def render_quality_document(
    layers: Mapping[str, Any],
    *,
    render_contract_hash: Any,
    engine: Any,
    blender_version: Any,
    master_resolution_px: Any,
    face_sampling: Mapping[str, Any],
    passes: Mapping[str, Any],
) -> dict[str, Any]:
    """ADR-007 §13.1 internal report block. No public download keys."""
    return {
        "schema": RENDER_QUALITY_SCHEMA,
        "render_contract_hash": render_contract_hash,
        "engine": engine,
        "blender_version": blender_version,
        "master_resolution_px": master_resolution_px,
        "face_sampling": dict(face_sampling),
        "passes": dict(passes),
        "machine_metrics": dict(layers.get("machine_metrics") or {}),
        "human_acceptance": layers.get("human_acceptance") or HUMAN_PENDING,
        "production_ready": False,
    }
