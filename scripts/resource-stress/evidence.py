"""Behavior judgments and descriptive aggregates, never resource budgets."""

from __future__ import annotations

import json
import math
import statistics
from pathlib import Path
from typing import Any

NEVER_CLASSES = {
    "expected_reject",
    "harness_synthetic",
    "synthetic_observe",
    "cancel_observe",
    "q05_observe",
    "simulated_l0",
}


def judge_synthetic(item: dict, run: dict) -> dict:
    reasons = []
    if run.get("launch_error"):
        reasons.append("launch_error")
    if run.get("measurement_errors"):
        reasons.append("measurement_errors")
    if not isinstance(run.get("samples"), list) or not run["samples"]:
        reasons.append("no_samples")
    if type(run.get("exit_code")) is not int:
        reasons.append("exit_unobserved")
    if item.get("cancel_after_s") is not None:
        if run.get("cancelled") is not True or type(run.get("exit_code")) is not int:
            reasons.append("expected_cancel_not_observed")
    elif run.get("cancelled") or run.get("exit_code") != item["expect_exit"]:
        reasons.append("unexpected_exit_or_cancel")
    return {
        "scenario": item["id"],
        "expected_exit": item["expect_exit"],
        "expected_cancel": item.get("cancel_after_s") is not None,
        "passed": not reasons,
        "reasons": reasons,
        "budget_effective": False,
        "fail_close": [],
    }


def read_result_json(output_dir: Path, name: str) -> dict[str, Any] | None:
    path = Path(output_dir) / name / "result.json"
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _never_budget(spec: dict[str, Any], validity: dict[str, Any] | None) -> list[str]:
    fail_close: list[str] = []
    klass = spec.get("class")
    eligibility = spec.get("eligibility")
    if eligibility == "NEVER" or klass in NEVER_CLASSES:
        if validity and validity.get("budget_valid") is True:
            fail_close.append("tool_claimed_valid_on_never_class")
    return fail_close


def _check_sampling(run: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    if run.get("launch_error"):
        reasons.append("launch_error")
    if run.get("measurement_errors"):
        reasons.append("measurement_errors")
    if not isinstance(run.get("samples"), list) or not run["samples"]:
        reasons.append("no_samples")
    return reasons


def _check_result(spec: dict[str, Any], result: dict[str, Any] | None) -> list[str]:
    reasons: list[str] = []
    if not spec.get("requires_result"):
        return reasons
    if result is None:
        reasons.append("missing_result")
        return reasons
    expected = spec.get("expected_error")
    if result.get("ok") is not True:
        reasons.append("result_not_ok")
    if spec.get("class") == "expected_reject" or expected is not None:
        if result.get("expected_error") != expected:
            reasons.append("error_class_mismatch")
    rows = result.get("rows")
    if spec.get("class") in {"product_face", "expected_reject"}:
        if not isinstance(rows, list) or not rows:
            reasons.append("missing_result")
        else:
            for row in rows:
                if expected is not None and row.get("error") != expected:
                    reasons.append("error_class_mismatch")
                if expected is None and row.get("error"):
                    reasons.append("error_class_mismatch")
                if row.get("staging_left"):
                    reasons.append("cleanup_failed")
    if spec.get("probe") == "upload-probe.mjs":
        log = result.get("log")
        if not isinstance(log, list) or not log:
            reasons.append("missing_result")
        else:
            phases = [row.get("phase") for row in log if isinstance(row, dict)]
            if "two-reserved-third-429" not in phases:
                reasons.append("error_class_mismatch")
            if "both-discarded" not in phases or "slot-reacquired-and-released" not in phases:
                reasons.append("cleanup_failed")
    if spec.get("probe") == "queue-probe.mjs" and result.get("maxActive") != 1:
        reasons.append("error_class_mismatch")
    if spec.get("probe") == "budget-probe.mjs":
        if not isinstance(rows, list) or len(rows) != 4:
            reasons.append("missing_result")
        else:
            by_mode = {row.get("mode"): row for row in rows if isinstance(row, dict)}
            if by_mode.get("disk-exhaustion", {}).get("cause") != "disk_budget":
                reasons.append("error_class_mismatch")
            if by_mode.get("cancel", {}).get("cause") != "cancelled":
                reasons.append("error_class_mismatch")
    if spec.get("probe") == "render_probe.py":
        layers = result.get("quality_layers") or {}
        if layers.get("runtime_hard", {}).get("status") != "pass":
            reasons.append("error_class_mismatch")
    return list(dict.fromkeys(reasons))


def judge_scene(
    spec: dict[str, Any],
    run: dict[str, Any],
    result: dict[str, Any] | None,
    validity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    reasons = _check_sampling(run)
    expected_exit = spec.get("expect_exit")
    cancelled = run.get("cancelled") is True
    if spec.get("class") == "expected_reject":
        if type(run.get("exit_code")) is not int:
            reasons.append("exit_unobserved")
        elif expected_exit is not None and run.get("exit_code") != expected_exit:
            reasons.append("unexpected_exit_or_cancel")
        # Historical face probe exits 0 when the expected error matches; that
        # is still an expected_exit=0 observation, not a skipped exit check.
    elif spec.get("class") == "cancel_observe" and spec.get("probe") == "budget-probe.mjs":
        if type(run.get("exit_code")) is not int:
            reasons.append("exit_unobserved")
        elif expected_exit is not None and run.get("exit_code") != expected_exit:
            reasons.append("unexpected_exit_or_cancel")
    else:
        if type(run.get("exit_code")) is not int:
            reasons.append("exit_unobserved")
        elif expected_exit is not None and run.get("exit_code") != expected_exit:
            reasons.append("unexpected_exit_or_cancel")
        if cancelled and spec.get("class") not in {"cancel_observe"}:
            reasons.append("unexpected_exit_or_cancel")
    reasons.extend(_check_result(spec, result))
    fail_close = _never_budget(spec, validity)
    reasons.extend(fail_close)
    unique = list(dict.fromkeys(reasons))
    behavior_ok = not [item for item in unique if item != "tool_claimed_valid_on_never_class"]
    return {
        "scenario": spec.get("id"),
        "expected_exit": expected_exit,
        "expected_error": spec.get("expected_error"),
        "passed": not unique,
        "behavior_ok": behavior_ok,
        "reasons": unique,
        "fail_close": fail_close,
        "budget_effective": False,
        "original_budget_valid": None if validity is None else validity.get("budget_valid"),
    }


def summarize_rounds(rounds: list[dict], requested: int) -> dict:
    by_scene: dict[str, list[dict]] = {}
    for row in rounds:
        # Keep failed round evidence, but never mix it into successful observations.
        if row["exit_code"] == 0 and row["behavior_passed"] is True:
            for run in row["runs"]:
                by_scene.setdefault(run["name"], []).append(run)
    summaries = {}
    for name, runs in by_scene.items():
        fields = {}
        for key in ("seconds", "peak_tree_rss_bytes"):
            values = [r.get(key) for r in runs]
            valid = [v for v in values if type(v) in (int, float) and math.isfinite(v) and v >= 0]
            fields[key] = {
                "status": "observed" if len(valid) == len(values) else "not_assessed",
                "count": len(valid),
                "min": min(valid) if valid else None,
                "median": statistics.median(valid) if valid else None,
                "max": max(valid) if valid else None,
            }
        summaries[name] = fields
    return {
        "schema": "beian-r04-synthetic-rounds/1",
        "requested_rounds": requested,
        "completed_rounds": len(rounds),
        "behavior_passed": len(rounds) == requested and all(
            r["exit_code"] == 0 and r["behavior_passed"] is True for r in rounds
        ),
        "budget_valid": False,
        "budget_effective": False,
        "retried": False,
        "rounds": rounds,
        "summary": summaries,
        "note": "min/median/max of synthetic observations only; no percentiles or formal budgets",
    }
