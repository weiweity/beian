"""Behavior judgments and descriptive aggregates, never resource budgets."""

from __future__ import annotations

import math
import statistics


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
