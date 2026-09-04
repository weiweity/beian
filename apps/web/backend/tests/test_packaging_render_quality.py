from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image, ImageDraw
import pytest


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
REPO = PACKAGING.parents[1]
EVAL_PATH = PACKAGING / "tools" / "render_quality_eval.py"
MANIFEST_PATH = PACKAGING / "fixtures" / "render-quality" / "manifest.json"
FORBIDDEN_CONTENT = (
    "达肤妍",
    "江华",
    "jianghua",
    "伸美",
    "刘籽烨",
    "weiweity",
    "客户稿",
    "商标",
)
BACKEND_DATA = REPO / "apps" / "web" / "backend" / "data"


def eval_module():
    spec = importlib.util.spec_from_file_location("packaging_render_quality_eval", EVAL_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _complete_identity(eval_mod) -> dict:
    return {key: f"{index:x}" * 64 for index, key in enumerate(eval_mod.IDENTITY_HASH_KEYS, start=10)}


def _complete_deps() -> dict:
    return {
        "python": "3.14.4",
        "pillow": "12.3.0",
        "pymupdf": "1.28.2",
        "blender": "Blender 5.2.0 LTS",
    }


def _measured_surface(eval_mod) -> dict:
    measured = eval_mod.measured
    return {
        "pixel_size": measured([64, 64], "px", "test"),
        "pixel_sha256": measured("c" * 64, None, "test"),
        "white_separation": measured({"edge_pixel_count": 8}, "8bit_luma", "test"),
        "alpha_border": measured({"contour_count": 8}, "1", "test"),
    }


def _carton(fid: str, family: str = "rectangular_carton_v1", role: str = "white_separation") -> dict:
    return {
        "id": fid,
        "packaging_family": family,
        "role": role,
        "label": fid,
        "dimensions_mm": {"width": 40.0, "depth": 30.0, "height": 50.0},
        "artwork": {"fill_rgb": [250, 250, 250], "pattern": "solid"},
    }


def test_fixture_manifest_is_parseable_with_unique_ids():
    eval_mod = eval_module()
    manifest = eval_mod.load_fixture_manifest()
    assert manifest["schema"] == "beian-render-quality-fixtures/1"
    fixtures = eval_mod.list_fixtures(manifest)
    ids = [item["id"] for item in fixtures]
    assert len(ids) == len(set(ids))
    assert len(ids) >= 7
    roles = {item["id"]: item["role"] for item in fixtures}
    assert "rf00-white-carton" in roles
    assert "rf00-dark-carton" in roles
    assert "rf00-tall-carton" in roles
    assert "rf00-wide-carton" in roles
    assert "rf00-type-frequency" in roles
    assert "rf00-alpha-edge" in roles
    negative = [item for item in fixtures if item["packaging_family"] != eval_mod.RECTANGULAR_CARTON_FAMILY]
    assert negative
    assert all(item["packaging_family"] != eval_mod.RECTANGULAR_CARTON_FAMILY for item in negative)


def test_fixture_ids_and_input_sha256_are_stable(tmp_path: Path):
    eval_mod = eval_module()
    manifest = eval_mod.load_fixture_manifest()
    first = [eval_mod.fixture_input_sha256(item) for item in eval_mod.list_fixtures(manifest)]
    second = [eval_mod.fixture_input_sha256(item) for item in eval_mod.list_fixtures(manifest)]
    assert first == second
    assert all(len(digest) == 64 for digest in first)
    white = eval_mod.fixture_by_id(manifest, "rf00-white-carton")
    dark = eval_mod.fixture_by_id(manifest, "rf00-dark-carton")
    assert white["packaging_family"] == eval_mod.RECTANGULAR_CARTON_FAMILY
    assert eval_mod.fixture_input_sha256(white) != eval_mod.fixture_input_sha256(dark)
    materialized = [
        eval_mod.materialize_fixture(white, tmp_path / "one"),
        eval_mod.materialize_fixture(white, tmp_path / "two"),
    ]
    assert materialized[0]["input_sha256"] == materialized[1]["input_sha256"]
    assert materialized[0]["artwork_sha256"] == materialized[1]["artwork_sha256"]
    pdf = Path(materialized[0]["artwork_pdf"])
    assert pdf.is_file()
    assert materialized[0]["artwork_sha256"] == hashlib.sha256(pdf.read_bytes()).hexdigest()
    assert materialized[0]["artwork_script_sha256"] != materialized[0]["artwork_sha256"]


def test_fixtures_contain_no_real_brand_or_customer_content(tmp_path: Path):
    eval_mod = eval_module()
    manifest_text = MANIFEST_PATH.read_text(encoding="utf-8")
    eval_text = EVAL_PATH.read_text(encoding="utf-8")
    for token in FORBIDDEN_CONTENT:
        assert token not in manifest_text
        assert token not in eval_text
    manifest = eval_mod.load_fixture_manifest()
    for fixture in eval_mod.list_fixtures(manifest):
        if eval_mod.family_status(fixture) == "unsupported":
            continue
        prepared = eval_mod.materialize_fixture(fixture, tmp_path / fixture["id"])
        pdf_text = Path(prepared["artwork_pdf"]).read_bytes()
        for token in FORBIDDEN_CONTENT:
            assert token.encode("utf-8") not in pdf_text


def test_family_comes_from_declared_field_not_color_or_filename():
    eval_mod = eval_module()
    white = eval_mod.fixture_by_id(eval_mod.load_fixture_manifest(), "rf00-white-carton")
    spoofed = dict(white)
    spoofed["id"] = "rf00-spoof-cylinder"
    spoofed["packaging_family"] = "cylinder_v1"
    spoofed["artwork"] = dict(white["artwork"])
    assert eval_mod.family_status(spoofed) == "unsupported"
    assert eval_mod.family_status(white) == "measured"


def test_unsupported_family_is_marked_and_not_rendered_as_carton(tmp_path: Path):
    eval_mod = eval_module()
    manifest = eval_mod.load_fixture_manifest()
    negative = [
        item
        for item in eval_mod.list_fixtures(manifest)
        if item["packaging_family"] != eval_mod.RECTANGULAR_CARTON_FAMILY
    ]
    assert negative
    report = eval_mod.run_eval(
        output_dir=tmp_path / "out",
        approved_baseline_path=tmp_path / "approved.json",
        update_baseline=False,
        render_blender=False,
    )
    by_id = {item["fixture_id"]: item for item in report["fixtures"]}
    for item in negative:
        record = by_id[item["id"]]
        assert record["family_status"] == "unsupported"
        assert record["rendered"] is False
        assert record.get("blender_invoked") is False
        assert not (tmp_path / "out" / item["id"] / "resolved_job.json").exists()


def test_normal_run_does_not_overwrite_approved_baseline(tmp_path: Path):
    eval_mod = eval_module()
    approved = tmp_path / "approved.json"
    payload = {"schema": "beian-render-quality-baseline/1", "frozen": True, "marker": "do-not-touch"}
    approved.write_text(json.dumps(payload), encoding="utf-8")
    before = approved.read_bytes()
    before_mtime = approved.stat().st_mtime_ns
    eval_mod.run_eval(
        output_dir=tmp_path / "out",
        approved_baseline_path=approved,
        update_baseline=False,
        render_blender=False,
    )
    assert approved.read_bytes() == before
    assert approved.stat().st_mtime_ns == before_mtime


def test_metrics_only_update_baseline_does_not_write(tmp_path: Path):
    eval_mod = eval_module()
    approved = tmp_path / "approved.json"
    report = eval_mod.run_eval(
        output_dir=tmp_path / "out",
        approved_baseline_path=approved,
        update_baseline=True,
        render_blender=False,
    )
    assert report["ok"] is True
    assert report["baseline"]["updated"] is False
    assert report["baseline"]["status"] == "refused"
    assert report["baseline"]["reason"] in {
        "blender_unavailable",
        "not_rendered:rf00-white-carton",
        "report_not_ok",
        "identity_mismatch:blender",
    }
    assert not approved.exists()


def test_failed_blender_run_does_not_create_or_change_approved_baseline(tmp_path: Path):
    eval_mod = eval_module()
    approved = tmp_path / "approved.json"
    marker = {"schema": "beian-render-quality-baseline/1", "marker": "keep"}
    approved.write_text(json.dumps(marker), encoding="utf-8")
    before = approved.read_bytes()
    missing = tmp_path / "no-such-blender"
    report = eval_mod.run_eval(
        output_dir=tmp_path / "out",
        approved_baseline_path=approved,
        update_baseline=True,
        render_blender=True,
        blender_executable=missing,
    )
    assert report["ok"] is False
    assert report["exit_code"] == 2
    assert report["baseline"]["updated"] is False
    assert report["baseline"]["status"] == "refused"
    assert approved.read_bytes() == before
    created = tmp_path / "created.json"
    eval_mod.run_eval(
        output_dir=tmp_path / "out-2",
        approved_baseline_path=created,
        update_baseline=True,
        render_blender=True,
        blender_executable=missing,
    )
    assert not created.exists()


def test_maybe_write_baseline_requires_complete_success(tmp_path: Path):
    eval_mod = eval_module()
    approved = tmp_path / "approved.json"
    failed = {
        "ok": False,
        "input_sha256": "a" * 64,
        "identity": {"evaluator_sha256": "b" * 64},
        "blender": {"available": True},
        "fixtures": [],
        "python_version": {"status": "measured", "value": "3.14.4"},
        "current_render": {},
    }
    result = eval_mod.maybe_write_approved_baseline(failed, approved, update_baseline=True)
    assert result["updated"] is False
    assert result["reason"] == "report_not_ok"
    assert not approved.exists()

    front = _measured_surface(eval_mod)
    identity = _complete_identity(eval_mod)
    success = {
        "ok": True,
        "input_sha256": identity["input_sha256"],
        "identity": identity,
        "blender": {"available": True, "status": "measured"},
        "python_version": {"status": "measured", "value": "3.14.4"},
        "current_render": {},
        "dependency_versions": _complete_deps(),
        "fixtures": [
            {
                "fixture_id": "rf00-white-carton",
                "packaging_family": "rectangular_carton_v1",
                "family_status": "measured",
                "role": "white_separation",
                "input_sha256": identity["input_sha256"],
                "artwork_sha256": "4" * 64,
                "rendered": True,
                "outputs": {
                    "front_right": front,
                    "front_right_card": front,
                    "read_front": front,
                },
            }
        ],
    }
    written = eval_mod.maybe_write_approved_baseline(success, approved, update_baseline=True)
    assert written["updated"] is True
    assert approved.is_file()
    stored = json.loads(approved.read_text(encoding="utf-8"))
    assert stored["identity"]["evaluator_sha256"] == identity["evaluator_sha256"]
    mismatched = dict(success)
    mismatched["identity"] = dict(success["identity"])
    mismatched["identity"]["evaluator_sha256"] = "9" * 64
    refused = eval_mod.maybe_write_approved_baseline(mismatched, approved, update_baseline=True)
    assert refused["updated"] is False
    assert refused["reason"] == "identity_mismatch:evaluator_sha256"
    assert json.loads(approved.read_text(encoding="utf-8"))["identity"]["evaluator_sha256"] == identity["evaluator_sha256"]


def test_blender_missing_is_not_fake_green(tmp_path: Path):
    eval_mod = eval_module()
    missing = tmp_path / "no-such-blender"
    report = eval_mod.run_eval(
        output_dir=tmp_path / "out",
        approved_baseline_path=tmp_path / "approved.json",
        update_baseline=False,
        render_blender=True,
        blender_executable=missing,
    )
    assert report["ok"] is False
    assert report["blender"]["available"] is False
    assert report["blender"]["reason"] == "blender_executable_missing"
    assert report["exit_code"] != 0
    measured = [item for item in report["fixtures"] if item["family_status"] == "measured"]
    assert measured
    assert all(item["rendered"] is False for item in measured)


def test_cli_missing_blender_exits_nonzero(tmp_path: Path):
    missing = tmp_path / "missing-blender"
    proc = subprocess.run(
        [
            sys.executable,
            str(EVAL_PATH),
            "--output-dir",
            str(tmp_path / "cli-out"),
            "--blender",
            str(missing),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    combined = proc.stdout + proc.stderr
    assert "blender_executable_missing" in combined
    assert "Traceback" not in proc.stderr
    assert not (PACKAGING / "fixtures" / "render-quality" / "baselines" / "rf00-current.json").exists()


def test_cli_rejects_manifest_flag_and_dangerous_paths(tmp_path: Path):
    proc = subprocess.run(
        [sys.executable, str(EVAL_PATH), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0
    assert "--update-baseline" in proc.stdout
    assert "--manifest" not in proc.stdout
    missing = tmp_path / "missing-blender"
    trap = BACKEND_DATA / "rf00-trap-should-not-exist"
    proc = subprocess.run(
        [
            sys.executable,
            str(EVAL_PATH),
            "--output-dir",
            str(trap),
            "--blender",
            str(missing),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "product task data directory" in proc.stdout
    assert not trap.exists()
    eval_mod = eval_module()
    with pytest.raises(eval_mod.EvalError):
        eval_mod.load_fixture_manifest(tmp_path / "evil.json")
    with pytest.raises(eval_mod.EvalError):
        eval_mod.run_eval(
            output_dir=tmp_path / "out",
            fixtures=[_carton("../escaped")],
            approved_baseline_path=tmp_path / "approved.json",
            render_blender=False,
        )


def test_output_size_collection_is_correct(tmp_path: Path):
    eval_mod = eval_module()
    image_path = tmp_path / "card.png"
    Image.new("RGBA", (1440, 1200), (250, 250, 250, 255)).save(image_path)
    metrics = eval_mod.collect_image_metrics(image_path)
    assert metrics["pixel_size"]["status"] == "measured"
    assert metrics["pixel_size"]["value"] == [1440, 1200]
    assert metrics["byte_size"]["value"] == image_path.stat().st_size
    assert metrics["sha256"]["value"] == hashlib.sha256(image_path.read_bytes()).hexdigest()
    with Image.open(image_path) as opened:
        pixel_key = f"{opened.mode}:{opened.size[0]}x{opened.size[1]}:".encode("ascii") + opened.tobytes()
    assert metrics["pixel_sha256"]["value"] == hashlib.sha256(pixel_key).hexdigest()
    assert metrics["white_separation"]["status"] == "unavailable"
    assert metrics["white_separation"]["reason"] == "no_product_contour"
    assert metrics["alpha_border"]["status"] == "unavailable"


def test_contour_metrics_use_product_silhouette_not_canvas_frame(tmp_path: Path):
    eval_mod = eval_module()
    image = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 59, 59), fill=(250, 250, 250, 255))
    path = tmp_path / "silhouette.png"
    image.save(path)
    metrics = eval_mod.collect_image_metrics(path)
    alpha = metrics["alpha_border"]
    sep = metrics["white_separation"]
    assert alpha["status"] == "measured"
    assert alpha["value"]["contour_count"] > 0
    assert sep["status"] == "measured"
    assert sep["value"]["edge_pixel_count"] > 0
    assert "product_mean_luma" not in sep["value"]
    empty = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    empty_path = tmp_path / "empty.png"
    empty.save(empty_path)
    empty_metrics = eval_mod.collect_image_metrics(empty_path)
    assert empty_metrics["white_separation"]["status"] == "unavailable"
    assert empty_metrics["white_separation"]["reason"] == "no_product_contour"


def test_type_fidelity_uses_known_roi_and_marks_stills_unavailable(tmp_path: Path):
    eval_mod = eval_module()
    panel = Image.new("L", (200, 320), 245)
    draw = ImageDraw.Draw(panel)
    for x in range(10, 180, 4):
        draw.line((x, 50, x, 100), fill=10, width=2)
    panel_path = tmp_path / "panel_front.png"
    panel.save(panel_path)
    spec = {
        "id": "rf00-type-frequency",
        "packaging_family": "rectangular_carton_v1",
        "role": "type_frequency",
        "dimensions_mm": {"width": 50.0, "depth": 40.0, "height": 80.0},
        "artwork": {
            "fill_rgb": [245, 245, 245],
            "pattern": "type_frequency",
            "type_roi_mm": {"text": [1.2, 1.0, 48.8, 9.5], "barcode": [1.2, 11.0, 48.4, 26.0]},
        },
    }
    fidelity = eval_mod.collect_type_fidelity(spec, {"front": str(panel_path)})
    assert fidelity["read_front"]["status"] == "measured"
    assert fidelity["read_front"]["value"]["barcode"]["status"] == "measured"
    assert fidelity["read_front"]["value"]["barcode"]["value"] > 0
    assert fidelity["full"]["status"] == "unavailable"
    assert fidelity["full"]["reason"] == "type_roi_not_projected_through_oblique_still"
    assert fidelity["card"]["status"] == "unavailable"
    solid = _carton("rf00-white-carton")
    none = eval_mod.collect_type_fidelity(solid, {"front": str(panel_path)})
    assert none["read_front"]["status"] == "unavailable"
    assert none["read_front"]["reason"] == "no_type_roi"


def test_missing_metrics_are_unavailable_not_zero(tmp_path: Path):
    eval_mod = eval_module()
    missing = eval_mod.collect_image_metrics(tmp_path / "nope.png")
    for key in ("pixel_size", "byte_size", "sha256", "pixel_sha256", "alpha_border", "white_separation"):
        assert missing[key]["status"] == "unavailable"
        assert "value" not in missing[key] or missing[key]["value"] is None
        assert missing[key]["reason"]
        assert missing[key].get("value") != 0
    report = eval_mod.run_eval(
        output_dir=tmp_path / "out",
        approved_baseline_path=tmp_path / "approved.json",
        update_baseline=False,
        render_blender=False,
    )
    assert report["blender"]["status"] == "unavailable"
    assert report["blender"].get("value") not in (0, 0.0, "0")
    samples = report["current_render"]["samples"]
    if samples["status"] == "unavailable":
        assert samples.get("value") not in (0, 0.0)
    assert "evaluator_sha256" in report["identity"]
    assert report["identity"]["render_profile_sha256"]


def test_eval_does_not_read_backend_data_or_real_jobs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    opened: list[str] = []
    real_open = Path.open

    def guarded_open(self: Path, *args, **kwargs):
        opened.append(str(self))
        resolved = self if self.is_absolute() else Path.cwd() / self
        try:
            resolved = resolved.resolve()
        except OSError:
            resolved = self
        if resolved == BACKEND_DATA or BACKEND_DATA in resolved.parents:
            raise AssertionError(f"eval opened product data path: {self}")
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded_open)
    eval_mod = eval_module()
    eval_mod.run_eval(
        output_dir=tmp_path / "out",
        approved_baseline_path=tmp_path / "approved.json",
        update_baseline=False,
        render_blender=False,
    )
    assert not any("backend/data" in path.replace("\\", "/") for path in opened)


def test_eval_cli_help_mentions_update_baseline():
    proc = subprocess.run(
        [sys.executable, str(EVAL_PATH), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0
    assert "--update-baseline" in proc.stdout
    assert "--output-dir" in proc.stdout


def test_identity_compatible_is_closed_set_and_missing_fields_fail(tmp_path: Path):
    eval_mod = eval_module()
    identity = _complete_identity(eval_mod)
    deps = _complete_deps()
    existing = {"identity": identity, "dependency_versions": deps, "input_sha256": identity["input_sha256"]}
    incoming = {"identity": dict(identity), "dependency_versions": dict(deps), "input_sha256": identity["input_sha256"]}
    ok, reason = eval_mod.identity_compatible(existing, incoming)
    assert ok is True
    assert reason == "ok"
    for key in eval_mod.IDENTITY_HASH_KEYS:
        mutated = {"identity": dict(identity), "dependency_versions": dict(deps), "input_sha256": identity["input_sha256"]}
        mutated["identity"][key] = "mutated-" + key
        ok, reason = eval_mod.identity_compatible(existing, mutated)
        assert ok is False, key
        assert reason == f"identity_mismatch:{key}", key
        missing = {"identity": dict(identity), "dependency_versions": dict(deps), "input_sha256": identity["input_sha256"]}
        missing["identity"].pop(key)
        if key == "input_sha256":
            missing.pop("input_sha256", None)
        ok, reason = eval_mod.identity_compatible(existing, missing)
        assert ok is False, key
        assert reason == f"identity_mismatch:{key}", key
    for key in eval_mod.DEPENDENCY_VERSION_KEYS:
        mutated = {"identity": dict(identity), "dependency_versions": dict(deps), "input_sha256": identity["input_sha256"]}
        mutated["dependency_versions"][key] = "mutated-" + key
        ok, reason = eval_mod.identity_compatible(existing, mutated)
        assert ok is False, key
        assert reason == f"identity_mismatch:{key}", key
        missing = {"identity": dict(identity), "dependency_versions": dict(deps), "input_sha256": identity["input_sha256"]}
        missing["dependency_versions"].pop(key)
        ok, reason = eval_mod.identity_compatible(existing, missing)
        assert ok is False, key
        assert reason == f"identity_mismatch:{key}", key
    approved = tmp_path / "approved.json"
    front = _measured_surface(eval_mod)
    success = {
        "ok": True,
        "input_sha256": identity["input_sha256"],
        "identity": identity,
        "blender": {"available": True, "status": "measured"},
        "python_version": {"status": "measured", "value": "3.14.4"},
        "current_render": {},
        "dependency_versions": deps,
        "fixtures": [
            {
                "fixture_id": "rf00-white-carton",
                "packaging_family": "rectangular_carton_v1",
                "family_status": "measured",
                "role": "white_separation",
                "input_sha256": identity["input_sha256"],
                "rendered": True,
                "outputs": {"front_right": front, "front_right_card": front, "read_front": front},
            }
        ],
    }
    assert eval_mod.maybe_write_approved_baseline(success, approved, update_baseline=True)["updated"] is True
    before = approved.read_bytes()
    for key in ("camera_frame_sha256", "template_sha256", "manifest_sha256"):
        changed = dict(success)
        changed["identity"] = dict(identity)
        changed["identity"][key] = "changed-" + key
        result = eval_mod.maybe_write_approved_baseline(changed, approved, update_baseline=True)
        assert result["updated"] is False
        assert result["reason"] == f"identity_mismatch:{key}"
        assert approved.read_bytes() == before
    changed_blender = dict(success)
    changed_blender["dependency_versions"] = dict(deps)
    changed_blender["dependency_versions"]["blender"] = "Blender 9.9.9"
    result = eval_mod.maybe_write_approved_baseline(changed_blender, approved, update_baseline=True)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:blender"
    assert approved.read_bytes() == before
    top_only = dict(success)
    top_only["identity"] = dict(identity)
    top_only["input_sha256"] = "top-changed-" + "0" * 48
    result = eval_mod.maybe_write_approved_baseline(top_only, approved, update_baseline=True)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:input_sha256"
    assert approved.read_bytes() == before
    nested_only = dict(success)
    nested_only["identity"] = dict(identity)
    nested_only["identity"]["input_sha256"] = "nested-changed-" + "0" * 45
    result = eval_mod.maybe_write_approved_baseline(nested_only, approved, update_baseline=True)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:input_sha256"
    assert approved.read_bytes() == before
    missing_top = dict(success)
    missing_top["identity"] = dict(identity)
    missing_top.pop("input_sha256")
    result = eval_mod.maybe_write_approved_baseline(missing_top, approved, update_baseline=True)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:input_sha256"
    assert approved.read_bytes() == before
    missing_nested = dict(success)
    missing_nested["identity"] = dict(identity)
    missing_nested["identity"].pop("input_sha256")
    result = eval_mod.maybe_write_approved_baseline(missing_nested, approved, update_baseline=True)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:input_sha256"
    assert approved.read_bytes() == before
    conflicted = json.loads(approved.read_text(encoding="utf-8"))
    conflicted["input_sha256"] = "conflict-top-" + "0" * 50
    conflicted["identity"] = dict(conflicted["identity"])
    conflicted["identity"]["input_sha256"] = "conflict-nested-" + "0" * 47
    approved.write_text(json.dumps(conflicted), encoding="utf-8")
    conflicted_bytes = approved.read_bytes()
    result = eval_mod.maybe_write_approved_baseline(success, approved, update_baseline=True)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:input_sha256"
    assert approved.read_bytes() == conflicted_bytes


def test_type_fidelity_inner_unavailable_rejects_baseline(tmp_path: Path):
    eval_mod = eval_module()
    front = _measured_surface(eval_mod)
    fake_type = {
        "read_front": eval_mod.measured(
            {
                "text": eval_mod.unavailable("missing_text", unit="1"),
                "barcode": eval_mod.unavailable("missing_barcode", unit="1"),
            },
            None,
            "outer measured inner unavailable",
        )
    }
    item = {
        "family_status": "measured",
        "role": "type_frequency",
        "rendered": True,
        "outputs": {
            "front_right": front,
            "front_right_card": front,
            "read_front": front,
            "type_fidelity": fake_type,
        },
    }
    ok, reason = eval_mod.required_metrics_complete(item)
    assert ok is False
    assert reason == "unavailable:type_fidelity.read_front.text"
    identity = _complete_identity(eval_mod)
    report = {
        "ok": True,
        "input_sha256": identity["input_sha256"],
        "identity": identity,
        "blender": {"available": True, "status": "measured"},
        "dependency_versions": _complete_deps(),
        "python_version": {"status": "measured", "value": "3.14.4"},
        "current_render": {},
        "fixtures": [dict(item, fixture_id="rf00-type-frequency", packaging_family="rectangular_carton_v1", input_sha256=identity["input_sha256"])],
    }
    approved = tmp_path / "approved.json"
    result = eval_mod.maybe_write_approved_baseline(report, approved, update_baseline=True)
    assert result["updated"] is False
    assert result["reason"] == "unavailable:type_fidelity.read_front.text"
    assert not approved.exists()
    item["outputs"]["type_fidelity"] = {
        "read_front": eval_mod.measured(
            {
                "text": eval_mod.measured(12.5, "1", "text roi"),
                "barcode": eval_mod.measured(20.0, "1", "barcode roi"),
            },
            None,
            "both leaves measured",
        )
    }
    ok, reason = eval_mod.required_metrics_complete(item)
    assert ok is True
    assert reason == "ok"


def test_output_dir_and_baseline_path_authorization(tmp_path: Path):
    eval_mod = eval_module()
    with pytest.raises(eval_mod.EvalError, match="outside the repository"):
        eval_mod.run_eval(
            output_dir=REPO / "rf00-inside-repo",
            approved_baseline_path=tmp_path / "approved.json",
            render_blender=False,
        )
    with pytest.raises(eval_mod.EvalError, match="source files"):
        eval_mod.maybe_write_approved_baseline(
            {"ok": False},
            EVAL_PATH,
            update_baseline=False,
        )
    out = tmp_path / "out"
    out.mkdir()
    with pytest.raises(eval_mod.EvalError, match="rf00-report.json"):
        eval_mod.assert_approved_baseline_path(out / "rf00-report.json", output_dir=out)
    swapped_out = Path(str(out).swapcase())
    with pytest.raises(eval_mod.EvalError, match="rf00-report.json"):
        eval_mod.assert_approved_baseline_path(swapped_out / "rf00-report.json", output_dir=out)
    with pytest.raises(eval_mod.EvalError, match="output_dir"):
        eval_mod.assert_approved_baseline_path(swapped_out / "child.json", output_dir=out)
    mixed = Path(str(REPO / "docs").swapcase())
    with pytest.raises(eval_mod.EvalError, match="outside the repository"):
        eval_mod.assert_output_dir(mixed)
    link = tmp_path / "repo-link"
    link.symlink_to(REPO, target_is_directory=True)
    with pytest.raises(eval_mod.EvalError, match="outside the repository"):
        eval_mod.assert_output_dir(link / "workers")
    missing = tmp_path / "missing-blender"
    proc = subprocess.run(
        [
            sys.executable,
            str(EVAL_PATH),
            "--output-dir",
            str(tmp_path / "cli-out"),
            "--approved-baseline",
            str(EVAL_PATH),
            "--blender",
            str(missing),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "approved baseline" in proc.stdout.lower() or "baselines" in proc.stdout
    proc = subprocess.run(
        [
            sys.executable,
            str(EVAL_PATH),
            "--output-dir",
            str(tmp_path / "cli-out"),
            "--approved-baseline",
            str(tmp_path / "outside.json"),
            "--blender",
            str(missing),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "baselines" in proc.stdout
    proc = subprocess.run(
        [
            sys.executable,
            str(EVAL_PATH),
            "--output-dir",
            str(REPO / "docs"),
            "--blender",
            str(missing),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "outside the repository" in proc.stdout


def test_wb_data_dir_rejects_children_symlinks_and_swapcase(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    eval_mod = eval_module()
    data = tmp_path / "product-data"
    data.mkdir()
    monkeypatch.setenv("WB_DATA_DIR", str(data))
    with pytest.raises(eval_mod.EvalError, match="configured data directory"):
        eval_mod.assert_output_dir(data)
    with pytest.raises(eval_mod.EvalError, match="configured data directory"):
        eval_mod.assert_output_dir(data / "jobs" / "nested")
    link = tmp_path / "data-link"
    link.symlink_to(data, target_is_directory=True)
    with pytest.raises(eval_mod.EvalError, match="configured data directory"):
        eval_mod.assert_output_dir(link)
    with pytest.raises(eval_mod.EvalError, match="configured data directory"):
        eval_mod.assert_output_dir(link / "jobs")
    swapped = Path(str(data).swapcase())
    with pytest.raises(eval_mod.EvalError, match="configured data directory"):
        eval_mod.assert_output_dir(swapped)
    with pytest.raises(eval_mod.EvalError, match="configured data directory"):
        eval_mod.assert_approved_baseline_path(Path(str(data).swapcase()) / "baseline.json")
