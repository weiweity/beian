from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path

from PIL import Image, ImageDraw
import pytest

from test_packaging_render_quality import (
    EVAL_PATH,
    PACKAGING,
    _approvable_report,
    _carton,
    _complete_deps,
    _complete_identity,
    _install_successful_fake_pipeline,
    eval_module,
)


LAYERS_PATH = PACKAGING / "quality_layers.py"


def layers_module():
    spec = importlib.util.spec_from_file_location("packaging_quality_layers_rf10_test", LAYERS_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_three_layers_are_independent_and_machine_pass_does_not_accept_human():
    ql = layers_module()
    result = ql.classify_quality_layers(
        render_requested=True,
        blender_ready=True,
        identity_verified=True,
        runtime_complete=True,
        baseline_present=True,
        baseline_status="ok",
        fixture_metrics_ok=True,
    )
    assert result["runtime_hard"]["status"] == "pass"
    assert result["fixture_regression_hard"]["status"] == "pass"
    assert result["human_acceptance"] == "pending"
    assert result["warning_human"]["human_acceptance"] == "pending"
    assert result["production_ready"] is False
    assert result["official_machine_green"] is True
    assert result["runtime_hard"]["blocks_current"] is False
    assert result["fixture_regression_hard"]["blocks_current"] is False
    assert result["fixture_regression_hard"]["visual_task_fail"] is False


def test_human_acceptance_stays_caller_supplied_even_when_machine_fails():
    ql = layers_module()
    rejected = ql.classify_quality_layers(
        render_requested=True,
        blender_ready=True,
        identity_verified=True,
        runtime_complete=True,
        baseline_present=True,
        baseline_status="ok",
        fixture_metrics_ok=True,
        human_acceptance="rejected",
    )
    assert rejected["runtime_hard"]["status"] == "pass"
    assert rejected["human_acceptance"] == "rejected"
    pending = ql.classify_quality_layers(
        render_requested=True,
        blender_ready=False,
        blender_failure_reason="blender_executable_missing",
        identity_verified=True,
        runtime_complete=False,
        baseline_present=False,
        human_acceptance="pending",
    )
    assert pending["runtime_hard"]["status"] == "fail"
    assert pending["human_acceptance"] == "pending"
    assert pending["production_ready"] is False


def test_missing_blender_is_runtime_fail_not_green():
    ql = layers_module()
    result = ql.classify_quality_layers(
        render_requested=True,
        blender_ready=False,
        blender_failure_reason="blender_executable_missing",
        identity_verified=True,
        runtime_complete=False,
        baseline_present=False,
    )
    assert result["runtime_hard"]["status"] == "fail"
    assert result["runtime_hard"]["blocks_current"] is True
    assert "blender_executable_missing" in result["runtime_hard"]["reasons"]
    assert result["fixture_regression_hard"]["status"] == "not-run"
    assert result["official_machine_green"] is False
    assert result["human_acceptance"] == "pending"


def test_missing_baseline_is_fixture_absent_not_visual_fail():
    ql = layers_module()
    result = ql.classify_quality_layers(
        render_requested=True,
        blender_ready=True,
        identity_verified=True,
        runtime_complete=True,
        baseline_present=False,
    )
    assert result["runtime_hard"]["status"] == "pass"
    assert result["fixture_regression_hard"]["status"] == "baseline_absent"
    assert result["fixture_regression_hard"]["visual_task_fail"] is False
    assert result["fixture_regression_hard"]["blocks_current"] is False
    assert result["official_machine_green"] is False
    assert result["human_acceptance"] == "pending"


def test_baseline_mismatch_fails_only_fixture_regression():
    ql = layers_module()
    result = ql.classify_quality_layers(
        render_requested=True,
        blender_ready=True,
        identity_verified=True,
        runtime_complete=True,
        baseline_present=True,
        baseline_status="identity_mismatch",
        baseline_reason="identity_mismatch:render_profile_sha256",
        fixture_metrics_ok=True,
    )
    assert result["runtime_hard"]["status"] == "pass"
    assert result["runtime_hard"]["blocks_current"] is False
    assert result["fixture_regression_hard"]["status"] == "baseline_mismatch"
    assert result["fixture_regression_hard"]["visual_task_fail"] is False
    assert result["fixture_regression_hard"]["blocks_current"] is False
    assert result["machine_metrics"]["fixture_regression"] == "baseline_mismatch"
    assert result["machine_metrics"]["runtime_integrity"] == "pass"
    assert result["warning_human"]["status"] in {"warn", "observed"}
    assert result["official_machine_green"] is False


def test_runtime_incomplete_blocks_current_and_does_not_claim_fixture_pass():
    ql = layers_module()
    result = ql.classify_quality_layers(
        render_requested=True,
        blender_ready=True,
        identity_verified=True,
        runtime_complete=False,
        runtime_reason="unavailable:glb.sha256",
        baseline_present=True,
        baseline_status="ok",
        fixture_metrics_ok=True,
    )
    assert result["runtime_hard"]["status"] == "fail"
    assert result["runtime_hard"]["blocks_current"] is True
    assert result["fixture_regression_hard"]["status"] == "not-run"
    assert result["official_machine_green"] is False


def test_metric_fingerprint_compare_is_exact_and_closed():
    ql = layers_module()
    baseline = {"rf00-white-carton": {"front_right.pixel_sha256": "a" * 64, "glb.sha256": "b" * 64}}
    current = copy.deepcopy(baseline)
    assert ql.compare_fixture_metric_fingerprints(current, baseline) == (True, "ok")
    changed = copy.deepcopy(baseline)
    changed["rf00-white-carton"]["glb.sha256"] = "c" * 64
    ok, reason = ql.compare_fixture_metric_fingerprints(changed, baseline)
    assert ok is False
    assert reason == "metric_regression:rf00-white-carton:glb.sha256"
    missing = {"rf00-white-carton": {"front_right.pixel_sha256": "a" * 64}}
    ok, reason = ql.compare_fixture_metric_fingerprints(missing, baseline)
    assert ok is False
    assert reason == "metric_missing:rf00-white-carton:glb.sha256"


def test_runtime_quality_report_never_sets_human_or_production_ready():
    ql = layers_module()
    payload = ql.build_runtime_quality_report(action="render-candidate", runtime_gate="pass")
    assert payload["status"] == "layered"
    assert payload["wired"] is True
    assert payload["runtime_gate"] == "pass"
    assert payload["fixture_regression"] == "not-run"
    assert payload["human_acceptance"] == "pending"
    assert payload["production_ready"] is False
    failed = ql.build_runtime_quality_report(action="render-candidate", runtime_gate="fail", reasons=["glb"])
    assert failed["runtime_gate"] == "fail"
    assert failed["human_acceptance"] == "pending"
    with pytest.raises(ValueError, match="validate_prepare"):
        ql.build_runtime_quality_report(action="validate", runtime_gate="pass")


def test_run_eval_without_blender_exposes_runtime_fail_and_pending_human(tmp_path: Path):
    eval_mod = eval_module()
    report = eval_mod.run_eval(
        output_dir=tmp_path / "out",
        approved_baseline_path=tmp_path / "approved.json",
        update_baseline=False,
        render_blender=True,
        blender_executable=tmp_path / "missing-blender",
    )
    layers = report["quality_layers"]
    assert report["ok"] is False
    assert layers["runtime_hard"]["status"] == "fail"
    assert layers["runtime_hard"]["blocks_current"] is True
    assert layers["fixture_regression_hard"]["status"] == "not-run"
    assert layers["human_acceptance"] == "pending"
    assert report["human_acceptance"] == "pending"
    assert report["render_quality"]["human_acceptance"] == "pending"
    assert report["render_quality"]["production_ready"] is False
    assert report["render_quality"]["machine_metrics"]["runtime_integrity"] == "fail"
    sampling = report["render_quality"]["face_sampling"]
    assert sampling["status"] in {"declared", "unavailable"}
    if sampling["status"] == "declared":
        front = sampling["faces"]["front"]
        assert front["source_ppm"]["status"] == "unavailable"
        assert front["source_ppm"]["reason"]


def test_run_eval_without_render_request_does_not_overwrite_baseline(tmp_path: Path):
    eval_mod = eval_module()
    approved = tmp_path / "approved.json"
    approved.write_text(json.dumps({"schema": "beian-render-quality-baseline/1", "marker": "keep"}), encoding="utf-8")
    before = approved.read_bytes()
    report = eval_mod.run_eval(
        output_dir=tmp_path / "out",
        approved_baseline_path=approved,
        update_baseline=False,
        render_blender=False,
    )
    layers = report["quality_layers"]
    assert layers["runtime_hard"]["status"] == "not-run"
    assert layers["fixture_regression_hard"]["status"] == "not-run"
    assert layers["human_acceptance"] == "pending"
    assert approved.read_bytes() == before


def test_fake_render_baseline_mismatch_is_not_visual_task_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    eval_mod = eval_module()
    blender = tmp_path / "blender"
    _install_successful_fake_pipeline(eval_mod, monkeypatch, blender)
    first = eval_mod.run_eval(
        output_dir=tmp_path / "run-1",
        approved_baseline_path=tmp_path / "approved.json",
        update_baseline=True,
        render_blender=True,
        blender_executable=blender,
    )
    assert first["quality_layers"]["runtime_hard"]["status"] == "pass"
    assert first["quality_layers"]["fixture_regression_hard"]["status"] == "baseline_absent"
    assert first["baseline"]["updated"] is True
    assert first["human_acceptance"] == "pending"

    drifted = json.loads((tmp_path / "approved.json").read_text(encoding="utf-8"))
    drifted["identity"] = dict(drifted["identity"])
    drifted["identity"]["render_profile_sha256"] = "9" * 64
    (tmp_path / "approved.json").write_text(json.dumps(drifted, indent=2) + "\n", encoding="utf-8")
    second = eval_mod.run_eval(
        output_dir=tmp_path / "run-2",
        approved_baseline_path=tmp_path / "approved.json",
        update_baseline=False,
        render_blender=True,
        blender_executable=blender,
    )
    layers = second["quality_layers"]
    assert layers["runtime_hard"]["status"] == "pass"
    assert layers["fixture_regression_hard"]["status"] == "baseline_mismatch"
    assert layers["fixture_regression_hard"]["visual_task_fail"] is False
    assert layers["human_acceptance"] == "pending"
    assert second["render_quality"]["machine_metrics"]["fixture_regression"] == "baseline_mismatch"
    assert second["baseline"]["updated"] is False


def test_fake_render_metric_tamper_fails_fixture_not_human(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    eval_mod = eval_module()
    blender = tmp_path / "blender"
    _install_successful_fake_pipeline(eval_mod, monkeypatch, blender)
    first = eval_mod.run_eval(
        output_dir=tmp_path / "base",
        approved_baseline_path=tmp_path / "approved.json",
        update_baseline=True,
        render_blender=True,
        blender_executable=blender,
    )
    assert first["baseline"]["updated"] is True
    stored = json.loads((tmp_path / "approved.json").read_text(encoding="utf-8"))
    for item in stored["fixtures"]:
        if item.get("family_status") == "unsupported":
            continue
        glb = item["outputs"]["glb"]["sha256"]
        glb["value"] = "e" * 64
        break
    (tmp_path / "approved.json").write_text(json.dumps(stored, indent=2) + "\n", encoding="utf-8")
    second = eval_mod.run_eval(
        output_dir=tmp_path / "changed",
        approved_baseline_path=tmp_path / "approved.json",
        update_baseline=False,
        render_blender=True,
        blender_executable=blender,
    )
    layers = second["quality_layers"]
    assert layers["runtime_hard"]["status"] == "pass"
    assert layers["fixture_regression_hard"]["status"] == "fail"
    assert "metric_regression" in ",".join(layers["fixture_regression_hard"]["reasons"])
    assert layers["human_acceptance"] == "pending"
    assert layers["official_machine_green"] is False


def test_measured_source_ppm_uses_read_panels_and_marks_resample_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    eval_mod = eval_module()
    blender = tmp_path / "blender"
    _install_successful_fake_pipeline(eval_mod, monkeypatch, blender)
    report = eval_mod.run_eval(
        output_dir=tmp_path / "ppm",
        approved_baseline_path=tmp_path / "approved.json",
        update_baseline=False,
        render_blender=True,
        blender_executable=blender,
    )
    sampling = report["render_quality"]["face_sampling"]
    assert sampling["faces"]["front"]["source_ppm"]["status"] == "measured"
    assert sampling["faces"]["front"]["target_ppm"]["status"] == "measured"
    assert sampling["resample_count"]["status"] == "unavailable"
    assert sampling["resample_count"]["reason"]
    assert report["quality_layers"]["human_acceptance"] == "pending"


def test_explicit_temp_baseline_update_does_not_touch_official_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    eval_mod = eval_module()
    official = PACKAGING / "fixtures" / "render-quality" / "baselines" / "rf00-current.json"
    assert not official.exists()
    blender = tmp_path / "blender"
    _install_successful_fake_pipeline(eval_mod, monkeypatch, blender)
    report = eval_mod.run_eval(
        output_dir=tmp_path / "temp-base",
        approved_baseline_path=tmp_path / "temp-approved.json",
        update_baseline=True,
        render_blender=True,
        blender_executable=blender,
    )
    assert report["baseline"]["updated"] is True
    assert (tmp_path / "temp-approved.json").is_file()
    assert not official.exists()
    assert report["human_acceptance"] == "pending"
