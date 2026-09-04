from __future__ import annotations

import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
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
    return {
        key: hashlib.sha256(f"identity:{key}".encode("utf-8")).hexdigest()
        for key in eval_mod.IDENTITY_HASH_KEYS
    }


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
        "byte_size": measured(4096, "byte", "test"),
        "sha256": measured("b" * 64, None, "test"),
        "pixel_sha256": measured("c" * 64, None, "test"),
        "white_separation": measured(
            {
                "edge_mean_luma": 220.0,
                "delta_vs_white": 35.0,
                "delta_vs_silver": 8.0,
                "edge_pixel_count": 8,
            },
            "8bit_luma",
            "test",
        ),
        "alpha_border": measured(
            {
                "contour_count": 16,
                "interior_edge_count": 8,
                "fringe_count": 8,
                "transparent_touch_count": 0,
            },
            "1",
            "test",
        ),
    }


def _complete_outputs(eval_mod, *, type_frequency: bool = False) -> dict:
    outputs = {
        key: copy.deepcopy(_measured_surface(eval_mod))
        for key in (
            "front_right",
            "back_left",
            "front_right_card",
            "back_left_card",
            *(f"read_{face}" for face in eval_mod.ALL_FACES),
        )
    }
    outputs["glb"] = {
        "byte_size": eval_mod.measured(4096, "byte", "test"),
        "sha256": eval_mod.measured("d" * 64, None, "test"),
    }
    if type_frequency:
        outputs["type_fidelity"] = {
            "read_front": eval_mod.measured(
                {
                    "text": eval_mod.measured(12.5, "1", "test"),
                    "barcode": eval_mod.measured(20.0, "1", "test"),
                },
                None,
                "test",
            )
        }
    return outputs


def _approvable_report(eval_mod) -> dict:
    identity = eval_mod.collect_source_identity()
    canonical_fixture_hashes = eval_mod.canonical_fixture_input_sha256s()
    fixtures = []
    for fixture_id, (family, role) in eval_mod.EXPECTED_FIXTURE_CONTRACT.items():
        supported = family == eval_mod.RECTANGULAR_CARTON_FAMILY
        fixtures.append(
            {
                "fixture_id": fixture_id,
                "packaging_family": family,
                "family_status": "measured" if supported else "unsupported",
                "role": role,
                "input_sha256": canonical_fixture_hashes[fixture_id],
                "artwork_sha256": "4" * 64 if supported else None,
                "artwork_script_sha256": "5" * 64 if supported else None,
                "render_profile_sha256": "6" * 64 if supported else None,
                "rendered": supported,
                "outputs": _complete_outputs(eval_mod, type_frequency=role == "type_frequency") if supported else {},
            }
        )
    aggregate_input_sha256 = eval_mod.fixture_matrix_input_sha256(fixtures)
    identity["input_sha256"] = aggregate_input_sha256
    return {
        "schema": eval_mod.REPORT_SCHEMA,
        "phase": "RF-00",
        "ok": True,
        "exit_code": 0,
        "input_sha256": aggregate_input_sha256,
        "identity": identity,
        "identity_verified_after_run": True,
        "product_behavior_changed": False,
        "blender": {
            "available": True,
            "status": "measured",
            "version": eval_mod.measured("Blender 5.2.0 LTS", None, "test"),
        },
        "python_version": eval_mod.measured("3.14.4", None, "test"),
        "current_render": {},
        "dependency_versions": _complete_deps(),
        "fixtures": fixtures,
    }


def _attempt_baseline(eval_mod, report: dict, approved: Path, evidence_dir: Path) -> dict:
    evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = evidence_dir / "rf00-approval-evidence.json"
    eval_mod.write_json(evidence, report)
    eval_mod.write_json(evidence_dir / "rf00-report.json", report)
    return eval_mod.maybe_write_approved_baseline(
        report,
        approved,
        update_baseline=True,
        output_dir=evidence_dir,
        evidence_report_path=evidence,
    )


def _carton(fid: str, family: str = "rectangular_carton_v1", role: str = "white_separation") -> dict:
    return {
        "id": fid,
        "packaging_family": family,
        "role": role,
        "label": fid,
        "dimensions_mm": {"width": 40.0, "depth": 30.0, "height": 50.0},
        "artwork": {"fill_rgb": [250, 250, 250], "pattern": "solid"},
    }


def _install_successful_fake_pipeline(eval_mod, monkeypatch: pytest.MonkeyPatch, blender: Path) -> None:
    class FakePipeline:
        @staticmethod
        def preflight_product(product, project_dir, _output_dir, *_args):
            fixture_dir = Path(project_dir)
            assets_dir = fixture_dir / "assets"
            assets_dir.mkdir(mode=0o700, exist_ok=False)
            assets = {}
            for face in eval_mod.ALL_FACES:
                path = assets_dir / f"panel_{face}.png"
                panel = Image.new("RGB", (200, 320), (242, 242, 242))
                if product["code"] == "rf00-type-frequency" and face == "front":
                    draw = ImageDraw.Draw(panel)
                    for x in range(4, 196, 4):
                        draw.line((x, 4, x, 180), fill=(12, 12, 12), width=2)
                panel.save(path)
                assets[face] = str(path)
            resolved_job = fixture_dir / "resolved_job.json"
            job = {
                "project_dir": str(fixture_dir),
                "resolved_job_path": str(resolved_job),
                "outputs": {
                    "blend": str(fixture_dir / "scene.blend"),
                    "front_right": str(fixture_dir / "front_right.png"),
                    "back_left": str(fixture_dir / "back_left.png"),
                    "glb": str(fixture_dir / "model.glb"),
                    "front_right_ground": str(fixture_dir / "front_right_ground.png"),
                    "back_left_ground": str(fixture_dir / "back_left_ground.png"),
                    "front_right_set": str(fixture_dir / "front_right_set.png"),
                    "back_left_set": str(fixture_dir / "back_left_set.png"),
                },
                "assets": assets,
                "preflight_elapsed_s": 0.01,
            }
            resolved_job.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
            return job

        @staticmethod
        def run_blender_job(job, executable):
            assert Path(executable) == blender
            outputs = job["outputs"]
            for key in ("front_right", "back_left"):
                path = Path(outputs[key])
                image = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
                ImageDraw.Draw(image).rectangle((16, 12, 79, 83), fill=(244, 244, 244, 255))
                image.save(path)
                card = path.with_name(f"{path.stem}_card.png")
                image.resize((64, 64), Image.Resampling.LANCZOS).save(card)
                outputs[f"{key}_card"] = str(card)
            Path(outputs["blend"]).write_bytes(b"BLENDER-fake-render-contract")
            Path(outputs["glb"]).write_bytes(b"glTF-fake-render-contract")
            job["blender_elapsed_s"] = 0.02
            job["render_resolution"] = [96, 96]
            return job

    blender.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    blender.chmod(0o700)
    monkeypatch.setattr(eval_mod, "_load_pipeline", lambda: FakePipeline)
    monkeypatch.setattr(
        eval_mod,
        "blender_version_text",
        lambda _path: eval_mod.measured("Blender 5.2.0 LTS", None, "fake version probe"),
    )
    monkeypatch.setattr(
        eval_mod,
        "probe_blender_runtime",
        lambda _path: {
            "engine": eval_mod.measured("BLENDER_EEVEE_NEXT", None, "fake runtime probe"),
            "samples": eval_mod.measured(64, "1", "fake runtime probe"),
        },
    )


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
    template = json.loads(Path(materialized[0]["template"]).read_text(encoding="utf-8"))
    assert "raster_width_px" not in template
    assert template["render_profile_id"] == "compat-legacy-v0"


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

    success = _approvable_report(eval_mod)
    written = _attempt_baseline(eval_mod, success, approved, tmp_path / "evidence")
    assert written["updated"] is True
    assert approved.is_file()
    stored = json.loads(approved.read_text(encoding="utf-8"))
    assert stored["identity"]["evaluator_sha256"] == success["identity"]["evaluator_sha256"]
    assert stored["evidence_report_sha256"] == hashlib.sha256(
        (tmp_path / "evidence" / "rf00-approval-evidence.json").read_bytes()
    ).hexdigest()
    mismatched = dict(success)
    mismatched["identity"] = dict(success["identity"])
    mismatched["identity"]["evaluator_sha256"] = "9" * 64
    refused = _attempt_baseline(eval_mod, mismatched, approved, tmp_path / "evidence")
    assert refused["updated"] is False
    assert refused["reason"] == "identity_mismatch:evaluator_sha256"
    assert json.loads(approved.read_text(encoding="utf-8"))["identity"]["evaluator_sha256"] == success["identity"]["evaluator_sha256"]


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


def test_render_profile_sha256_changes_when_registry_sampling_changes(
    tmp_path: Path,
):
    eval_mod = eval_module()
    contract = eval_mod._load_render_contract()
    original = eval_mod.render_profile_sha256()
    assert original == eval_mod.render_profile_sha256()
    baseline = eval_mod.current_template_render()
    assert baseline["render_spec"]["sampling"]
    assert baseline["render_spec"]["registry_sha256"]
    assert baseline["render_spec"]["renderer"]["profile_sha256"]
    assert baseline["render_spec"]["outputs"]
    assert baseline["render_spec"]["geometry"]
    assert baseline["render_spec"]["material"]
    assert baseline["render_spec"]["shots"]
    assert baseline["render_spec"]["color"]

    payload = json.loads(
        (PACKAGING / "profiles" / "render-profiles.v1.json").read_text(
            encoding="utf-8"
        )
    )
    profile = next(item for item in payload["profiles"] if item["id"] == "compat-legacy-v0")
    profile["sampling"] = dict(profile["sampling"])
    profile["sampling"]["minimum_face_pixels_per_mm"] = (
        float(profile["sampling"]["minimum_face_pixels_per_mm"]) + 1.0
    )
    profile["declared_sha256"] = contract.profile_declared_sha256(profile)
    mutated = tmp_path / "render-profiles.v1.json"
    mutated.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    changed = eval_mod.render_profile_sha256(registry_path=mutated)
    mutated_template = eval_mod.current_template_render(registry_path=mutated)
    assert changed != original
    assert mutated_template["render"] == baseline["render"]
    assert (
        mutated_template["render_spec"]["sampling"]["minimum_face_pixels_per_mm"]
        != baseline["render_spec"]["sampling"]["minimum_face_pixels_per_mm"]
    )
    assert not (PACKAGING / "fixtures" / "render-quality" / "baselines" / "rf00-current.json").exists()


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
    success = _approvable_report(eval_mod)
    identity = success["identity"]
    deps = success["dependency_versions"]
    evidence = tmp_path / "identity-evidence"
    assert _attempt_baseline(eval_mod, success, approved, evidence)["updated"] is True
    before = approved.read_bytes()
    for key in ("camera_frame_sha256", "template_sha256", "manifest_sha256"):
        changed = dict(success)
        changed["identity"] = dict(identity)
        changed["identity"][key] = "changed-" + key
        result = _attempt_baseline(eval_mod, changed, approved, evidence)
        assert result["updated"] is False
        assert result["reason"] == f"identity_mismatch:{key}"
        assert approved.read_bytes() == before
    changed_blender = dict(success)
    changed_blender["dependency_versions"] = dict(deps)
    changed_blender["dependency_versions"]["blender"] = "Blender 9.9.9"
    changed_blender["blender"] = copy.deepcopy(success["blender"])
    changed_blender["blender"]["version"]["value"] = "Blender 9.9.9"
    result = _attempt_baseline(eval_mod, changed_blender, approved, evidence)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:blender"
    assert approved.read_bytes() == before
    top_only = dict(success)
    top_only["identity"] = dict(identity)
    top_only["input_sha256"] = "top-changed-" + "0" * 48
    result = _attempt_baseline(eval_mod, top_only, approved, evidence)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:input_sha256"
    assert approved.read_bytes() == before
    nested_only = dict(success)
    nested_only["identity"] = dict(identity)
    nested_only["identity"]["input_sha256"] = "nested-changed-" + "0" * 45
    result = _attempt_baseline(eval_mod, nested_only, approved, evidence)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:input_sha256"
    assert approved.read_bytes() == before
    missing_top = dict(success)
    missing_top["identity"] = dict(identity)
    missing_top.pop("input_sha256")
    result = _attempt_baseline(eval_mod, missing_top, approved, evidence)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:input_sha256"
    assert approved.read_bytes() == before
    missing_nested = dict(success)
    missing_nested["identity"] = dict(identity)
    missing_nested["identity"].pop("input_sha256")
    result = _attempt_baseline(eval_mod, missing_nested, approved, evidence)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:input_sha256"
    assert approved.read_bytes() == before
    conflicted = json.loads(approved.read_text(encoding="utf-8"))
    conflicted["input_sha256"] = "conflict-top-" + "0" * 50
    conflicted["identity"] = dict(conflicted["identity"])
    conflicted["identity"]["input_sha256"] = "conflict-nested-" + "0" * 47
    approved.write_text(json.dumps(conflicted), encoding="utf-8")
    conflicted_bytes = approved.read_bytes()
    result = _attempt_baseline(eval_mod, success, approved, evidence)
    assert result["updated"] is False
    assert result["reason"] == "identity_mismatch:input_sha256"
    assert approved.read_bytes() == conflicted_bytes


def test_type_fidelity_inner_unavailable_rejects_baseline(tmp_path: Path):
    eval_mod = eval_module()
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
        "outputs": _complete_outputs(eval_mod, type_frequency=True),
    }
    item["outputs"]["type_fidelity"] = fake_type
    ok, reason = eval_mod.required_metrics_complete(item)
    assert ok is False
    assert reason == "unavailable:type_fidelity.read_front.text"
    report = _approvable_report(eval_mod)
    type_record = next(record for record in report["fixtures"] if record["role"] == "type_frequency")
    type_record["outputs"] = copy.deepcopy(item["outputs"])
    approved = tmp_path / "approved.json"
    result = _attempt_baseline(eval_mod, report, approved, tmp_path / "type-evidence")
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


def test_manifest_validation_rejects_malformed_fixture_contracts():
    eval_mod = eval_module()
    base = {
        "schema": eval_mod.MANIFEST_SCHEMA,
        "phase": "RF-00",
        "supported_baseline_family": eval_mod.RECTANGULAR_CARTON_FAMILY,
        "fixtures": [_carton("rf00-contract")],
    }
    invalid_payloads = []

    wrong_family = copy.deepcopy(base)
    wrong_family["supported_baseline_family"] = "cylinder_v1"
    invalid_payloads.append(wrong_family)

    bad_dimensions = copy.deepcopy(base)
    bad_dimensions["fixtures"][0]["dimensions_mm"]["width"] = float("nan")
    invalid_payloads.append(bad_dimensions)

    bad_fill = copy.deepcopy(base)
    bad_fill["fixtures"][0]["artwork"]["fill_rgb"] = [255, -1, 300]
    invalid_payloads.append(bad_fill)

    mismatched_type = copy.deepcopy(base)
    mismatched_type["fixtures"][0]["role"] = "type_frequency"
    invalid_payloads.append(mismatched_type)

    bad_roi = copy.deepcopy(base)
    bad_roi["fixtures"][0]["role"] = "type_frequency"
    bad_roi["fixtures"][0]["artwork"] = {
        "fill_rgb": [240, 240, 240],
        "pattern": "type_frequency",
        "type_roi_mm": {"text": [0, 0, 100, 10], "barcode": [1, 11, 20, 20]},
    }
    invalid_payloads.append(bad_roi)

    for payload in invalid_payloads:
        with pytest.raises(eval_mod.EvalError):
            eval_mod.validate_manifest_payload(payload)


def test_raster_width_rejects_invalid_and_over_budget_pages():
    eval_mod = eval_module()
    for page in ([float("nan"), 10.0], [10.0, 0.0], ["bad", 10.0], [10_000.0, 10_000.0]):
        with pytest.raises(eval_mod.EvalError):
            eval_mod.raster_width_px(page)


def test_output_dir_must_be_new_leaf_and_preserves_precreated_links(tmp_path: Path):
    eval_mod = eval_module()
    for broad in (Path("/"), Path.home(), Path(eval_mod.tempfile.gettempdir())):
        with pytest.raises(eval_mod.EvalError, match="dedicated new leaf"):
            eval_mod.assert_output_dir(broad)

    sentinel = tmp_path / "sentinel.txt"
    sentinel.write_text("keep", encoding="utf-8")
    output_dir = tmp_path / "occupied-output"
    output_dir.mkdir()
    (output_dir / "fixture-spec.json").symlink_to(sentinel)
    os.link(sentinel, output_dir / "source.ai")
    with pytest.raises(eval_mod.EvalError, match="new non-existing leaf"):
        eval_mod.run_eval(
            output_dir=output_dir,
            approved_baseline_path=tmp_path / "approved.json",
            render_blender=False,
        )
    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert sentinel.stat().st_nlink == 2


def test_materialize_fixture_rejects_existing_generation_directory(tmp_path: Path):
    eval_mod = eval_module()
    sentinel = tmp_path / "sentinel.txt"
    sentinel.write_text("keep", encoding="utf-8")
    destination = tmp_path / "fixture"
    destination.mkdir()
    (destination / "fixture-spec.json").symlink_to(sentinel)
    with pytest.raises(eval_mod.EvalError, match="fixture directory must be new"):
        eval_mod.materialize_fixture(_carton("rf00-existing"), destination)
    assert sentinel.read_text(encoding="utf-8") == "keep"


def test_rendered_output_contract_rejects_escape_symlink_and_hardlink(tmp_path: Path):
    eval_mod = eval_module()
    fixture_dir = tmp_path / "fixture"
    assets_dir = fixture_dir / "assets"
    assets_dir.mkdir(parents=True)
    expected_assets = {}
    for face in eval_mod.ALL_FACES:
        path = assets_dir / f"panel_{face}.png"
        Image.new("RGB", (8, 8), (255, 255, 255)).save(path)
        expected_assets[face] = path
    expected_outputs = {
        "front_right": fixture_dir / "front.png",
        "back_left": fixture_dir / "back.png",
        "glb": fixture_dir / "box.glb",
    }
    for path in expected_outputs.values():
        path.write_bytes(b"generated")
    front_card = fixture_dir / "front_card.png"
    back_card = fixture_dir / "back_card.png"
    front_card.write_bytes(b"generated")
    back_card.write_bytes(b"generated")
    outputs = {
        **{key: str(path) for key, path in expected_outputs.items()},
        "front_right_card": str(front_card),
        "back_left_card": str(back_card),
    }
    job = {"outputs": outputs, "assets": {key: str(path) for key, path in expected_assets.items()}}

    escaped = copy.deepcopy(job)
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"outside")
    escaped["outputs"]["front_right"] = str(outside)
    with pytest.raises(eval_mod.EvalError, match="path changed"):
        eval_mod.validate_rendered_paths(escaped, fixture_dir, expected_outputs, expected_assets)

    expected_outputs["front_right"].unlink()
    os.link(outside, expected_outputs["front_right"])
    with pytest.raises(eval_mod.EvalError, match="hard link"):
        eval_mod.validate_rendered_paths(job, fixture_dir, expected_outputs, expected_assets)


def test_preflight_uses_persisted_job_and_requires_unique_exact_output_paths(tmp_path: Path):
    eval_mod = eval_module()
    fixture_dir = tmp_path / "fixture"
    assets_dir = fixture_dir / "assets"
    assets_dir.mkdir(parents=True)
    assets = {}
    for face in eval_mod.ALL_FACES:
        path = assets_dir / f"panel_{face}.png"
        path.write_bytes(b"panel")
        assets[face] = str(path)
    resolved_job = fixture_dir / "resolved_job.json"
    outputs = {
        key: str(fixture_dir / f"{key}.png")
        for key in eval_mod.BLENDER_OUTPUT_KEYS
    }
    outputs["blend"] = str(fixture_dir / "scene.blend")
    outputs["glb"] = str(fixture_dir / "model.glb")
    job = {
        "project_dir": str(fixture_dir),
        "resolved_job_path": str(resolved_job),
        "outputs": outputs,
        "assets": assets,
    }
    resolved_job.write_text(json.dumps(job), encoding="utf-8")
    expected_outputs, expected_assets = eval_mod.validate_preflight_paths(job, fixture_dir)
    assert set(expected_outputs) == set(eval_mod.BLENDER_OUTPUT_KEYS)
    assert set(expected_assets) == set(eval_mod.ALL_FACES)

    resolved_job.write_text("{}", encoding="utf-8")
    with pytest.raises(eval_mod.EvalError, match="does not match"):
        eval_mod.validate_preflight_paths(job, fixture_dir)
    resolved_job.write_text(json.dumps(job), encoding="utf-8")

    aliased = copy.deepcopy(job)
    aliased["outputs"]["back_left"] = aliased["outputs"]["front_right"]
    resolved_job.write_text(json.dumps(aliased), encoding="utf-8")
    with pytest.raises(eval_mod.EvalError, match="paths must be unique"):
        eval_mod.validate_preflight_paths(aliased, fixture_dir)

    card_collision = copy.deepcopy(job)
    card_collision["outputs"]["back_left"] = str(fixture_dir / "front_right_card.png")
    resolved_job.write_text(json.dumps(card_collision), encoding="utf-8")
    with pytest.raises(eval_mod.EvalError, match="paths must be unique"):
        eval_mod.validate_preflight_paths(card_collision, fixture_dir)

    unknown = copy.deepcopy(job)
    unknown["outputs"]["outside"] = str(tmp_path / "outside.png")
    resolved_job.write_text(json.dumps(unknown), encoding="utf-8")
    with pytest.raises(eval_mod.EvalError, match="output keys"):
        eval_mod.validate_preflight_paths(unknown, fixture_dir)

    case_variant = fixture_dir.with_name(fixture_dir.name.swapcase())
    try:
        case_variant.mkdir()
    except FileExistsError:
        pass
    if not os.path.samefile(case_variant, fixture_dir):
        wrong_project = copy.deepcopy(job)
        wrong_project["project_dir"] = str(case_variant)
        resolved_job.write_text(json.dumps(wrong_project), encoding="utf-8")
        with pytest.raises(eval_mod.EvalError, match="project_dir escaped"):
            eval_mod.validate_preflight_paths(wrong_project, fixture_dir)


def test_rendered_output_contract_checks_cards_and_every_face_asset(tmp_path: Path):
    eval_mod = eval_module()
    fixture_dir = tmp_path / "fixture"
    assets_dir = fixture_dir / "assets"
    assets_dir.mkdir(parents=True)
    expected_assets = {}
    for face in eval_mod.ALL_FACES:
        path = assets_dir / f"panel_{face}.png"
        path.write_bytes(b"panel")
        expected_assets[face] = path
    expected_outputs = {
        "front_right": fixture_dir / "front.png",
        "back_left": fixture_dir / "back.png",
        "glb": fixture_dir / "box.glb",
    }
    outputs = {key: str(path) for key, path in expected_outputs.items()}
    for path in expected_outputs.values():
        path.write_bytes(b"render")
    for source_key, card_key in (("front_right", "front_right_card"), ("back_left", "back_left_card")):
        card = expected_outputs[source_key].with_name(f"{expected_outputs[source_key].stem}_card.png")
        card.write_bytes(b"card")
        outputs[card_key] = str(card)
    job = {"outputs": outputs, "assets": {key: str(path) for key, path in expected_assets.items()}}
    eval_mod.validate_rendered_paths(job, fixture_dir, expected_outputs, expected_assets)

    outside = tmp_path / "outside.bin"
    outside.write_bytes(b"outside")
    for key in ("front_right_card", "back_left_card"):
        changed = copy.deepcopy(job)
        changed["outputs"][key] = str(outside)
        with pytest.raises(eval_mod.EvalError, match=f"path changed:{key}"):
            eval_mod.validate_rendered_paths(changed, fixture_dir, expected_outputs, expected_assets)
    for face in eval_mod.ALL_FACES:
        changed = copy.deepcopy(job)
        changed["assets"][face] = str(outside)
        with pytest.raises(eval_mod.EvalError, match=f"path changed:{face}"):
            eval_mod.validate_rendered_paths(changed, fixture_dir, expected_outputs, expected_assets)

    front_card = Path(outputs["front_right_card"])
    front_card.unlink()
    front_card.symlink_to(outside)
    with pytest.raises(eval_mod.EvalError, match="stay under|regular file"):
        eval_mod.validate_rendered_paths(job, fixture_dir, expected_outputs, expected_assets)
    front_card.unlink()
    front_card.write_bytes(b"card")

    bottom = expected_assets["bottom"]
    bottom.unlink()
    os.link(outside, bottom)
    with pytest.raises(eval_mod.EvalError, match="hard link"):
        eval_mod.validate_rendered_paths(job, fixture_dir, expected_outputs, expected_assets)


def test_approved_baseline_rejects_directory_symlink_and_hardlink(tmp_path: Path):
    eval_mod = eval_module()
    directory = tmp_path / "baseline-dir"
    directory.mkdir()
    with pytest.raises(eval_mod.EvalError, match="regular file"):
        eval_mod.assert_approved_baseline_path(directory)

    target = tmp_path / "target.json"
    target.write_text("{}\n", encoding="utf-8")
    symlink = tmp_path / "symlink.json"
    symlink.symlink_to(target)
    with pytest.raises(eval_mod.EvalError, match="symbolic link"):
        eval_mod.assert_approved_baseline_path(symlink)

    hardlink = tmp_path / "hardlink.json"
    os.link(target, hardlink)
    with pytest.raises(eval_mod.EvalError, match="hard link"):
        eval_mod.assert_approved_baseline_path(hardlink)


def test_positive_baseline_authorization_does_not_casefold_distinct_roots(tmp_path: Path):
    eval_mod = eval_module()
    root = tmp_path / "render-quality" / "baselines"
    assert eval_mod._is_within_authorized_root(root / "rf00.json", root) is True
    distinct = tmp_path / "render-QUALITY" / "baselines" / "rf00.json"
    if not (tmp_path / "render-QUALITY").exists():
        assert eval_mod._is_within_authorized_root(distinct, root) is False


def test_baseline_lock_rejects_symlink_and_hardlink_without_touching_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    eval_mod = eval_module()
    lock_root = tmp_path / "locks"
    lock_root.mkdir()
    monkeypatch.setattr(eval_mod, "BASELINE_LOCK_ROOT", lock_root)
    approved = tmp_path / "approved.json"
    victim = tmp_path / "victim"
    victim.write_bytes(b"")
    lock_path = lock_root / f"{eval_mod.sha256_text(str(approved))}.lock"
    lock_path.symlink_to(victim)
    with pytest.raises(eval_mod.EvalError, match="lock file"):
        with eval_mod.approved_baseline_lock(approved):
            pass
    assert victim.read_bytes() == b""

    lock_path.unlink()
    os.link(victim, lock_path)
    with pytest.raises(eval_mod.EvalError, match="unique regular file"):
        with eval_mod.approved_baseline_lock(approved):
            pass
    assert victim.read_bytes() == b""


def test_render_failure_aborts_later_fixtures_and_no_supported_fixture_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    eval_mod = eval_module()
    blender = tmp_path / "blender"
    blender.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    blender.chmod(0o700)
    monkeypatch.setattr(
        eval_mod,
        "blender_version_text",
        lambda _path: eval_mod.measured("Blender 5.2.0 LTS", None, "fake version probe"),
    )
    monkeypatch.setattr(
        eval_mod,
        "probe_blender_runtime",
        lambda _path: {
            "engine": eval_mod.measured("BLENDER_EEVEE_NEXT", None, "fake runtime probe"),
            "samples": eval_mod.measured(64, "1", "fake runtime probe"),
        },
    )

    class FailingPipeline:
        @staticmethod
        def preflight_product(*_args):
            raise eval_mod.EvalError("synthetic preflight failure")

    monkeypatch.setattr(eval_mod, "_load_pipeline", lambda: FailingPipeline)
    report = eval_mod.run_eval(
        output_dir=tmp_path / "aborted",
        fixtures=[_carton("rf00-first"), _carton("rf00-second")],
        approved_baseline_path=tmp_path / "approved.json",
        render_blender=True,
        blender_executable=blender,
    )
    assert report["ok"] is False
    assert report["failure_reason"] == "render_contract_invalid"
    assert report["fixtures"][0]["skip_reason"] == "render_contract_invalid"
    assert report["fixtures"][1]["skip_reason"] == "render_aborted_after_failure"
    assert report["fixtures"][1]["blender_invoked"] is False

    unsupported = _carton("rf00-cylinder", family="cylinder_v1", role="unsupported_family")
    unsupported_report = eval_mod.run_eval(
        output_dir=tmp_path / "unsupported-only",
        fixtures=[unsupported],
        approved_baseline_path=tmp_path / "approved-unsupported.json",
        render_blender=True,
        blender_executable=blender,
    )
    assert unsupported_report["ok"] is False
    assert unsupported_report["failure_reason"] == "no_supported_fixtures"
    assert unsupported_report["fixtures"][0]["family_status"] == "unsupported"
    assert unsupported_report["fixtures"][0]["blender_invoked"] is False


def test_fake_blender_cli_success_reaches_metrics_contact_sheet_and_baseline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    eval_mod = eval_module()
    blender = tmp_path / "blender"
    _install_successful_fake_pipeline(eval_mod, monkeypatch, blender)
    baseline_root = tmp_path / "baselines"
    baseline_root.mkdir()
    approved = baseline_root / "rf00-current.json"
    monkeypatch.setattr(eval_mod, "APPROVED_BASELINE_ROOT", baseline_root)

    exit_code = eval_mod.main(
        [
            "--output-dir",
            str(tmp_path / "successful-run"),
            "--approved-baseline",
            str(approved),
            "--update-baseline",
            "--blender",
            str(blender),
        ]
    )
    assert exit_code == 0
    summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert summary["ok"] is True
    assert summary["exit_code"] == 0
    assert summary["baseline"]["updated"] is True

    output_dir = tmp_path / "successful-run"
    report = json.loads((output_dir / "rf00-report.json").read_text(encoding="utf-8"))
    evidence = json.loads((output_dir / "rf00-approval-evidence.json").read_text(encoding="utf-8"))
    stored = json.loads(approved.read_text(encoding="utf-8"))
    assert report["ok"] is True
    assert report["baseline"]["updated"] is True
    assert evidence["baseline"]["status"] == "pending"
    assert Path(report["contact_sheet"]["value"]).is_file()
    assert stored["evidence_report_sha256"] == hashlib.sha256(
        (output_dir / "rf00-approval-evidence.json").read_bytes()
    ).hexdigest()
    assert len(stored["fixtures"]) == len(eval_mod.EXPECTED_FIXTURE_CONTRACT)
    for item in report["fixtures"]:
        if item["family_status"] == "unsupported":
            assert item["rendered"] is False
            continue
        assert item["rendered"] is True
        assert eval_mod.required_metrics_complete(item) == (True, "ok")


def test_required_metrics_cover_both_views_all_read_faces_and_glb():
    eval_mod = eval_module()
    item = {
        "family_status": "measured",
        "role": "white_separation",
        "outputs": _complete_outputs(eval_mod),
    }
    assert eval_mod.required_metrics_complete(item) == (True, "ok")
    for group in ("back_left", "back_left_card", "read_bottom", "glb"):
        changed = copy.deepcopy(item)
        changed["outputs"].pop(group)
        complete, reason = eval_mod.required_metrics_complete(changed)
        assert complete is False
        assert group in reason


def test_required_metric_schemas_reject_measured_but_invalid_values():
    eval_mod = eval_module()
    item = {
        "family_status": "measured",
        "role": "white_separation",
        "outputs": _complete_outputs(eval_mod),
    }
    mutations = (
        ("front_right", "pixel_size", eval_mod.measured([64, 0], "px", "test")),
        ("front_right", "byte_size", eval_mod.measured(None, "byte", "test")),
        ("front_right", "sha256", eval_mod.measured("A" * 64, None, "test")),
        ("front_right", "pixel_sha256", eval_mod.measured("short", None, "test")),
        ("front_right", "white_separation", eval_mod.measured({"edge_pixel_count": 8}, "1", "test")),
        (
            "front_right",
            "alpha_border",
            eval_mod.measured(
                {
                    "contour_count": 8,
                    "interior_edge_count": 8,
                    "fringe_count": 8,
                    "transparent_touch_count": 0,
                },
                "1",
                "test",
            ),
        ),
        ("glb", "byte_size", eval_mod.measured(0, "byte", "test")),
    )
    for group, key, value in mutations:
        changed = copy.deepcopy(item)
        changed["outputs"][group][key] = value
        complete, reason = eval_mod.required_metrics_complete(changed)
        assert complete is False
        assert reason == f"invalid:{group}.{key}"


def test_baseline_requires_exact_fixture_matrix():
    eval_mod = eval_module()
    report = _approvable_report(eval_mod)
    assert eval_mod.report_allows_baseline(report) == (True, "ok")

    missing = copy.deepcopy(report)
    missing["fixtures"] = missing["fixtures"][1:]
    assert eval_mod.report_allows_baseline(missing) == (False, "fixture_contract_mismatch")

    unsupported_only = copy.deepcopy(report)
    unsupported_only["fixtures"] = [item for item in unsupported_only["fixtures"] if item["family_status"] == "unsupported"]
    assert eval_mod.report_allows_baseline(unsupported_only) == (False, "fixture_contract_mismatch")

    wrong_role = copy.deepcopy(report)
    wrong_role["fixtures"][0]["role"] = "dark_levels"
    allowed, reason = eval_mod.report_allows_baseline(wrong_role)
    assert allowed is False
    assert reason.startswith("fixture_contract_mismatch:")


def test_baseline_requires_closed_report_provenance_contract():
    eval_mod = eval_module()
    report = _approvable_report(eval_mod)
    mutations = (
        ("schema", "not-rf00", "report_schema_mismatch"),
        ("phase", "RF-99", "report_phase_mismatch"),
        ("exit_code", 1, "report_exit_code_mismatch"),
        ("identity_verified_after_run", False, "identity_not_verified_after_run"),
        ("product_behavior_changed", True, "product_behavior_change_not_allowed"),
    )
    for key, value, expected_reason in mutations:
        changed = copy.deepcopy(report)
        changed[key] = value
        assert eval_mod.report_allows_baseline(changed) == (False, expected_reason)

    for blender_change, expected_reason in (
        ({"status": "unavailable"}, "blender_unavailable"),
        ({"version": eval_mod.unavailable("missing")}, "blender_version_unavailable"),
    ):
        changed = copy.deepcopy(report)
        changed["blender"].update(blender_change)
        assert eval_mod.report_allows_baseline(changed) == (False, expected_reason)

    fixture_hash_changed = copy.deepcopy(report)
    fixture_hash_changed["fixtures"][0]["input_sha256"] = "f" * 64
    assert eval_mod.report_allows_baseline(fixture_hash_changed) == (
        False,
        "fixture_provenance_mismatch:rf00-white-carton",
    )

    self_consistent_but_not_canonical = copy.deepcopy(report)
    changed_fixture = self_consistent_but_not_canonical["fixtures"][0]
    changed_fixture["input_sha256"] = "f" * 64
    changed_input = eval_mod.fixture_matrix_input_sha256(self_consistent_but_not_canonical["fixtures"])
    self_consistent_but_not_canonical["input_sha256"] = changed_input
    self_consistent_but_not_canonical["identity"]["input_sha256"] = changed_input
    assert eval_mod.report_allows_baseline(self_consistent_but_not_canonical) == (
        False,
        f"fixture_provenance_mismatch:{changed_fixture['fixture_id']}",
    )

    for key in ("artwork_sha256", "artwork_script_sha256", "render_profile_sha256"):
        missing_provenance = copy.deepcopy(report)
        missing_provenance["fixtures"][0][key] = None
        allowed, reason = eval_mod.report_allows_baseline(missing_provenance)
        assert allowed is False
        assert reason.endswith(f":{key}")

    dependency_mismatch = copy.deepcopy(report)
    dependency_mismatch["python_version"]["value"] = "0.0.0"
    assert eval_mod.report_allows_baseline(dependency_mismatch) == (False, "dependency_version_mismatch")


def test_baseline_requires_matching_persisted_evidence(tmp_path: Path):
    eval_mod = eval_module()
    report = _approvable_report(eval_mod)
    approved = tmp_path / "approved.json"
    output_dir = tmp_path / "evidence"
    output_dir.mkdir()

    missing = eval_mod.maybe_write_approved_baseline(
        report,
        approved,
        update_baseline=True,
        output_dir=output_dir,
        evidence_report_path=output_dir / "rf00-approval-evidence.json",
    )
    assert missing["reason"] == "approval_evidence_invalid"
    assert not approved.exists()

    altered = copy.deepcopy(report)
    altered["ok"] = False
    eval_mod.write_json(output_dir / "rf00-approval-evidence.json", altered)
    eval_mod.write_json(output_dir / "rf00-report.json", altered)
    mismatch = eval_mod.maybe_write_approved_baseline(
        report,
        approved,
        update_baseline=True,
        output_dir=output_dir,
        evidence_report_path=output_dir / "rf00-approval-evidence.json",
    )
    assert mismatch["reason"] == "approval_evidence_mismatch"
    assert not approved.exists()


def test_baseline_refuses_evidence_changed_after_validation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    eval_mod = eval_module()
    report = _approvable_report(eval_mod)
    output_dir = tmp_path / "evidence"
    output_dir.mkdir()
    evidence = output_dir / "rf00-approval-evidence.json"
    eval_mod.write_json(evidence, report)
    eval_mod.write_json(output_dir / "rf00-report.json", report)

    @contextmanager
    def mutate_evidence(_path):
        evidence.write_text('{"changed":true}\n', encoding="utf-8")
        yield

    monkeypatch.setattr(eval_mod, "approved_baseline_lock", mutate_evidence)
    approved = tmp_path / "approved.json"
    result = eval_mod.maybe_write_approved_baseline(
        report,
        approved,
        update_baseline=True,
        output_dir=output_dir,
        evidence_report_path=evidence,
    )
    assert result["updated"] is False
    assert result["reason"] == "approval_evidence_changed_during_update"
    assert not approved.exists()


def test_baseline_compare_and_swap_preserves_concurrent_change(tmp_path: Path):
    eval_mod = eval_module()
    baseline = tmp_path / "baseline.json"
    eval_mod.write_json(baseline, {"generation": "one"})
    old_sha = hashlib.sha256(baseline.read_bytes()).hexdigest()
    eval_mod.write_json(baseline, {"generation": "two"})
    before = baseline.read_bytes()
    with pytest.raises(eval_mod.EvalError, match="changed during update"):
        eval_mod.atomic_write_json_cas(baseline, {"generation": "three"}, expected_sha256=old_sha)
    assert baseline.read_bytes() == before


def test_source_bundle_identity_changes_when_dependency_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    eval_mod = eval_module()
    first = tmp_path / "first.py"
    second = tmp_path / "second.py"
    first.write_text("VALUE = 1\n", encoding="utf-8")
    second.write_text("VALUE = 2\n", encoding="utf-8")
    original = eval_mod.source_bundle_sha256((first, second))
    second.write_text("VALUE = 3\n", encoding="utf-8")
    assert eval_mod.source_bundle_sha256((first, second)) != original
    expected = {
        eval_mod.PIPELINE_PATH,
        eval_mod.DIELINE_PATH,
        eval_mod.WHITE_BACKGROUND_PATH,
        eval_mod.RENDER_CONTRACT_PATH,
        *eval_mod.STRUCTURE_V2_PATHS,
    }
    assert eval_mod.ARTWORK_PATH in expected
    assert eval_mod.RENDER_CONTRACT_PATH in expected
    assert eval_mod.collect_source_identity()["pipeline_sha256"] == eval_mod.source_bundle_sha256(tuple(expected))
    assert eval_mod.collect_source_identity()["render_job_sha256"] == eval_mod.source_bundle_sha256(
        (eval_mod.RENDER_JOB_PATH, eval_mod.GLB_VERIFY_PATH)
    )
    glb_verify = tmp_path / "glb_verify.py"
    glb_verify.write_text("VALUE = 1\n", encoding="utf-8")
    monkeypatch.setattr(eval_mod, "GLB_VERIFY_PATH", glb_verify)
    before = eval_mod.collect_source_identity()["render_job_sha256"]
    glb_verify.write_text("VALUE = 2\n", encoding="utf-8")
    assert eval_mod.collect_source_identity()["render_job_sha256"] != before


def test_identity_change_during_run_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    eval_mod = eval_module()
    first = eval_mod.collect_source_identity()
    second = dict(first)
    second["pipeline_sha256"] = "f" * 64
    identities = iter((first, second))
    monkeypatch.setattr(eval_mod, "collect_source_identity", lambda: dict(next(identities)))
    report = eval_mod.run_eval(
        output_dir=tmp_path / "identity-change",
        approved_baseline_path=tmp_path / "approved.json",
        render_blender=False,
    )
    assert report["ok"] is False
    assert report["failure_reason"] == "identity_changed_during_run"
    assert report["identity_verified_after_run"] is False
    assert not (tmp_path / "approved.json").exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable permission contract")
def test_non_executable_blender_is_stable_failure(tmp_path: Path):
    eval_mod = eval_module()
    fake = tmp_path / "blender"
    fake.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    fake.chmod(0o600)
    report = eval_mod.run_eval(
        output_dir=tmp_path / "non-executable",
        fixtures=[_carton("rf00-one")],
        approved_baseline_path=tmp_path / "approved.json",
        render_blender=True,
        blender_executable=fake,
    )
    assert report["ok"] is False
    assert report["failure_reason"] == "blender_executable_unusable"
    assert report["blender"]["available"] is False
    assert (tmp_path / "non-executable" / "rf00-report.json").is_file()


@pytest.mark.skipif(os.name == "nt", reason="POSIX fake Blender executable")
def test_blender_probe_and_render_failures_are_stable_reports(tmp_path: Path):
    eval_mod = eval_module()
    probe_fail = tmp_path / "probe-fail"
    probe_fail.write_text("#!/bin/sh\nexit 7\n", encoding="utf-8")
    probe_fail.chmod(0o700)
    probe_report = eval_mod.run_eval(
        output_dir=tmp_path / "probe-output",
        fixtures=[_carton("rf00-probe")],
        approved_baseline_path=tmp_path / "approved-probe.json",
        render_blender=True,
        blender_executable=probe_fail,
    )
    assert probe_report["failure_reason"] == "blender_version_probe_failed"
    assert probe_report["exit_code"] != 0

    render_fail = tmp_path / "render-fail"
    render_fail.write_text(
        "#!/bin/sh\n"
        "if [ \"$1\" = \"--version\" ]; then echo 'Blender 5.2.0 LTS'; exit 0; fi\n"
        "case \" $* \" in\n"
        "  *' --python-expr '*) echo 'RF00_PROBE {\"engine_identifiers\":[\"BLENDER_EEVEE_NEXT\"],\"engine_chosen\":\"BLENDER_EEVEE_NEXT\",\"samples\":64,\"sample_field\":\"taa_render_samples\"}'; exit 0;;\n"
        "esac\n"
        "exit 9\n",
        encoding="utf-8",
    )
    render_fail.chmod(0o700)
    render_report = eval_mod.run_eval(
        output_dir=tmp_path / "render-output",
        fixtures=[_carton("rf00-render")],
        approved_baseline_path=tmp_path / "approved-render.json",
        render_blender=True,
        blender_executable=render_fail,
    )
    assert render_report["ok"] is False
    assert render_report["failure_reason"] == "blender_render_failed"
    assert render_report["fixtures"][0]["render_error_type"] == "PipelineError"
    assert (tmp_path / "render-output" / "rf00-report.json").is_file()
