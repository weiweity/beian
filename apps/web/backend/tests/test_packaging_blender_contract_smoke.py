from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

from test_packaging_render_quality import PACKAGING, _install_successful_fake_pipeline, eval_module


SMOKE_PATH = PACKAGING / "tools" / "blender_contract_smoke.py"


def smoke_module():
    spec = importlib.util.spec_from_file_location("packaging_blender_contract_smoke", SMOKE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_smoke_requires_runner_temp(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    smoke = smoke_module()
    monkeypatch.delenv("RUNNER_TEMP", raising=False)
    code = smoke.main(["--blender", str(tmp_path / "missing")])
    assert code == 2
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["ok"] is False
    assert payload["error"] == "runner_temp_missing"
    assert payload["human_acceptance"] == "pending"
    assert payload["production_ready"] is False


def test_smoke_missing_blender_is_not_green(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    smoke = smoke_module()
    runner = tmp_path / "runner-temp"
    runner.mkdir()
    monkeypatch.setenv("RUNNER_TEMP", str(runner))
    code = smoke.main(["--blender", str(tmp_path / "no-blender")])
    assert code == 2
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["ok"] is False
    assert payload["quality_layers"]["runtime_hard"] == "fail"
    assert payload["quality_layers"]["human_acceptance"] == "pending"
    assert payload["quality_layers"]["production_ready"] is False
    written = list(runner.glob("beian-blender-contract-smoke-*"))
    assert written
    assert all(path.resolve().is_relative_to(runner.resolve()) for path in written)


def test_smoke_fake_blender_writes_only_runner_temp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    smoke = smoke_module()
    eval_mod = eval_module()
    blender = tmp_path / "blender"
    _install_successful_fake_pipeline(eval_mod, monkeypatch, blender)
    monkeypatch.setattr(smoke, "load_eval", lambda: eval_mod)
    monkeypatch.setattr(smoke, "verify_rendered_contract", lambda *_args, **_kwargs: None)
    runner = tmp_path / "runner-temp"
    runner.mkdir()
    monkeypatch.setenv("RUNNER_TEMP", str(runner))
    monkeypatch.delenv("WB_DATA_DIR", raising=False)
    code = smoke.main(["--blender", str(blender)])
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0
    assert payload["ok"] is True
    assert payload["quality_layers"]["runtime_hard"] == "pass"
    assert payload["quality_layers"]["human_acceptance"] == "pending"
    assert payload["quality_layers"]["production_ready"] is False
    assert payload["timeout_budget_status"] == "candidate_not_hangzhou_frozen"
    out = Path(payload["output_dir"])
    assert out.resolve().is_relative_to(runner.resolve())
    assert (out / "rf00-report.json").is_file()
    official = PACKAGING / "fixtures" / "render-quality" / "baselines" / "rf00-current.json"
    assert not official.exists()


def test_smoke_does_not_open_product_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    smoke = smoke_module()
    eval_mod = eval_module()
    blender = tmp_path / "blender"
    _install_successful_fake_pipeline(eval_mod, monkeypatch, blender)
    monkeypatch.setattr(smoke, "load_eval", lambda: eval_mod)
    monkeypatch.setattr(smoke, "verify_rendered_contract", lambda *_args, **_kwargs: None)
    data = tmp_path / "customer-data"
    data.mkdir()
    (data / "jobs").mkdir()
    monkeypatch.setenv("WB_DATA_DIR", str(data))
    runner = tmp_path / "runner-temp"
    runner.mkdir()
    monkeypatch.setenv("RUNNER_TEMP", str(runner))
    opened: list[str] = []
    real_open = Path.open

    def guarded_open(self: Path, *args, **kwargs):
        opened.append(str(self))
        resolved = self if self.is_absolute() else Path.cwd() / self
        try:
            resolved = resolved.resolve()
        except OSError:
            resolved = self
        if resolved == data or data in resolved.parents:
            raise AssertionError(f"smoke opened product data path: {self}")
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded_open)
    assert smoke.main(["--blender", str(blender)]) == 0
    assert not any("customer-data" in path.replace("\\", "/") for path in opened)


def test_smoke_glb_contract_failure_is_runtime_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    smoke = smoke_module()
    eval_mod = eval_module()
    blender = tmp_path / "blender"
    _install_successful_fake_pipeline(eval_mod, monkeypatch, blender)
    monkeypatch.setattr(smoke, "load_eval", lambda: eval_mod)
    runner = tmp_path / "runner-temp"
    runner.mkdir()
    monkeypatch.setenv("RUNNER_TEMP", str(runner))
    code = smoke.main(["--blender", str(blender)])
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 2
    assert payload["ok"] is False
    assert payload["failure_reason"] == "runtime_glb_quality"
    assert payload["quality_layers"]["runtime_hard"] == "fail"
    assert payload["quality_layers"]["human_acceptance"] == "pending"
    assert payload["quality_layers"]["production_ready"] is False


def test_smoke_hash_mismatch_is_runtime_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    smoke = smoke_module()
    eval_mod = eval_module()
    blender = tmp_path / "blender"
    _install_successful_fake_pipeline(eval_mod, monkeypatch, blender)
    monkeypatch.setattr(smoke, "load_eval", lambda: eval_mod)
    real_verify = smoke.verify_rendered_contract

    def tamper_then_verify(module, report):
        output_dir = Path(report["output_dir"])
        for item in report["fixtures"]:
            if item.get("rendered") is not True:
                continue
            glb = output_dir / item["fixture_id"] / "model.glb"
            glb.write_bytes(glb.read_bytes() + b"tamper")
        return real_verify(module, report)

    monkeypatch.setattr(smoke, "verify_rendered_contract", tamper_then_verify)
    runner = tmp_path / "runner-temp"
    runner.mkdir()
    monkeypatch.setenv("RUNNER_TEMP", str(runner))
    code = smoke.main(["--blender", str(blender)])
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 2
    assert payload["failure_reason"] == "generation_hash_mismatch"
    assert payload["quality_layers"]["runtime_hard"] == "fail"
    assert payload["quality_layers"]["human_acceptance"] == "pending"


def test_smoke_rejects_product_generation_seal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    smoke = smoke_module()
    eval_mod = eval_module()
    blender = tmp_path / "blender"
    _install_successful_fake_pipeline(eval_mod, monkeypatch, blender)
    monkeypatch.setattr(smoke, "load_eval", lambda: eval_mod)
    real_run = eval_mod.run_eval

    def seal_then_report(**kwargs):
        report = real_run(**kwargs)
        (Path(report["output_dir"]) / "generation.json").write_text("{}", encoding="utf-8")
        return report

    monkeypatch.setattr(eval_mod, "run_eval", seal_then_report)
    runner = tmp_path / "runner-temp"
    runner.mkdir()
    monkeypatch.setenv("RUNNER_TEMP", str(runner))
    code = smoke.main(["--blender", str(blender)])
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 2
    assert payload["failure_reason"] == "generation_product_seal_forbidden"
    assert payload["quality_layers"]["production_ready"] is False
