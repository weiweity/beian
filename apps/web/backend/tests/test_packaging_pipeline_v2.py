from __future__ import annotations

from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

from PIL import Image
import pymupdf
import pytest

from packaging_structure_fixture import semantic_box


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"


def test_blender_only_without_resolved_job_fails_closed(tmp_path: Path):
    pipe = pipeline_module()
    with pytest.raises(pipe.PipelineError) as raised:
        pipe.load_blender_only_jobs(
            [{"code": "deadbeef"}],
            tmp_path,
            tmp_path,
        )
    assert "已出图棚" in str(raised.value)


def pipeline_module():
    spec = importlib.util.spec_from_file_location("packaging_pipeline_v2", PACKAGING / "pipeline.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_artwork(path: Path) -> Path:
    mm_to_pt = 72.0 / 25.4
    document = pymupdf.open()
    page = document.new_page(width=120 * mm_to_pt, height=90 * mm_to_pt)
    faces = {
        "back": ((0, 20, 30, 70), (28, 96, 120)),
        "left": ((30, 20, 50, 70), (51, 113, 82)),
        "front": ((50, 20, 80, 70), (117, 35, 46)),
        "right": ((80, 20, 100, 70), (191, 145, 64)),
        "top": ((50, 70, 80, 90), (100, 69, 127)),
        "bottom": ((50, 0, 80, 20), (55, 111, 145)),
    }
    for rect, rgb in faces.values():
        page.draw_rect(
            pymupdf.Rect(*(value * mm_to_pt for value in rect)),
            color=None,
            fill=tuple(value / 255 for value in rgb),
        )
    # Asymmetric corner marks make a rotated or mirrored face fail even when
    # its center color still looks correct.
    for rect, _rgb in faces.values():
        x0, y0, x1, y1 = rect
        page.draw_rect(
            pymupdf.Rect(*((value * mm_to_pt) for value in (x0 + 1, y0 + 1, x0 + 5, y0 + 5))),
            color=None,
            fill=(1, 1, 1),
        )
        page.draw_rect(
            pymupdf.Rect(*((value * mm_to_pt) for value in (x1 - 5, y1 - 5, x1 - 1, y1 - 1))),
            color=None,
            fill=(0, 0, 0),
        )
    document.save(path)
    document.close()
    return path


def prepare_v2_product(tmp_path: Path) -> tuple[dict, Path]:
    source = tmp_path / "source.ai"
    source.write_bytes(b"private-ai-fixture")
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    sidecar = tmp_path / "source.ai.structure.json"
    sidecar.write_text(json.dumps(semantic_box(source_hash=source_hash)), encoding="utf-8")
    artwork = write_artwork(tmp_path / "artwork.pdf")
    template = tmp_path / "render-profile.json"
    template.write_text(
        json.dumps(
            {
                "template_id": "v2-test-render-profile",
                "raster_width_px": 1200,
                "render_profile_id": "compat-legacy-v0",
                "glb_tolerance_mm": 0.5,
            }
        ),
        encoding="utf-8",
    )
    return (
        {
            "code": "V2BOX",
            "slug": "semantic",
            "display_name": "语义结构测试盒",
            "source_ai": source.name,
            "template": template.name,
            "structure_engine": "v2",
            "structure_sidecar": sidecar.name,
            "artwork_pdf": artwork.name,
        },
        source,
    )


def test_pipeline_v2_uses_resolved_geometry_and_exact_artwork(tmp_path: Path):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    job = pipeline.preflight_product(
        product,
        tmp_path,
        output,
        False,
        {"enabled": False},
        False,
    )
    assert job["structure_engine"] == "v2"
    assert job["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    assert job["input_mode"] == "semantic_sidecar"
    assert job["illustrator_invoked"] is False
    assert all(Path(path).is_file() for path in job["assets"].values())
    assert job["render_spec"]["sampling"]["legacy_raster_width_px"] == 10_000
    assert job["face_texture_sizes"]["front"] == [2_500, 4_167]
    assert job["face_texture_sizes"]["right"] == [1_667, 4_167]
    expected_centers = {
        "front": (117, 35, 46),
        "right": (191, 145, 64),
        "back": (28, 96, 120),
        "left": (51, 113, 82),
        "top": (100, 69, 127),
        "bottom": (55, 111, 145),
    }
    for face, rgb in expected_centers.items():
        with Image.open(job["assets"][face]).convert("RGB") as image:
            center = image.getpixel((image.width // 2, image.height // 2))
            width_mm = 20 if face in {"left", "right"} else 30
            height_mm = 20 if face in {"top", "bottom"} else 50
            top_left = image.getpixel(
                (round(image.width * 3 / width_mm), round(image.height * 3 / height_mm))
            )
            bottom_right = image.getpixel(
                (
                    round(image.width * (width_mm - 3) / width_mm),
                    round(image.height * (height_mm - 3) / height_mm),
                )
            )
        assert center == pytest.approx(rgb, abs=2), face
        assert top_left == pytest.approx((255, 255, 255), abs=5), face
        assert bottom_right == pytest.approx((0, 0, 0), abs=5), face
    resolution = json.loads(Path(job["structure_resolution_path"]).read_text(encoding="utf-8"))
    assert resolution["status"] == "ready"

    seed_required_outputs(job)
    pipeline.save_json(Path(job["project_dir"]) / "pipeline_result.json", job)
    cached = pipeline.preflight_product(
        product,
        tmp_path,
        output,
        False,
        {"enabled": False},
        False,
    )
    assert cached["cache_hit"] is True


def test_pipeline_v2_never_falls_back_to_layer_name_guessing(tmp_path: Path):
    pipeline = pipeline_module()
    product, source = prepare_v2_product(tmp_path)
    product.pop("structure_sidecar")
    source.with_name(source.name + ".structure.json").unlink()
    with pytest.raises(pipeline.PipelineHold) as raised:
        pipeline.preflight_product(
            product,
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": False},
            False,
        )
    assert raised.value.code == "structure_semantics_missing"
    assert raised.value.status == "review_required"


def test_illustrator_structure_export_accepts_a_windows_executable_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = pipeline_module()
    source = tmp_path / "source.ai"
    source.write_bytes(b"ai")
    illustrator = tmp_path / "Illustrator.exe"
    illustrator.write_bytes(b"exe")

    captured: dict[str, object] = {}

    def fake_run(command, capture_output, text):
        config_path = Path(command[2])
        config = json.loads(config_path.read_text(encoding="utf-8"))
        captured.update(config)
        for key in ("full_pdf", "print_pdf", "structure_json"):
            Path(config[key]).write_bytes(b"output")
        Path(config["result_json"]).write_text(
            json.dumps(
                {
                    "success": True,
                    "full_pdf": config["full_pdf"],
                    "print_pdf": config["print_pdf"],
                    "structure_json": config["structure_json"],
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, "ok", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    result = pipeline.run_illustrator_structure_export(
        source,
        tmp_path / "project",
        {"application": str(illustrator)},
        proposal_layers=["供应商结构候选"],
        print_layers=["印刷"],
    )
    assert result["success"] is True
    assert captured["proposal_layers"] == ["供应商结构候选"]
    assert captured["print_layers"] == ["印刷"]


def test_legacy_illustrator_fallback_accepts_a_windows_executable_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = pipeline_module()
    source = tmp_path / "source.ai"
    source.write_bytes(b"not-pdf-compatible")
    template = tmp_path / "template.json"
    template.write_text("{}", encoding="utf-8")
    illustrator = tmp_path / "Illustrator.exe"
    illustrator.write_bytes(b"exe")

    class ReachedWorker(RuntimeError):
        pass

    def reached_worker(*_args, **_kwargs):
        raise ReachedWorker("legacy Windows worker reached")

    monkeypatch.setattr(pipeline.sys, "platform", "win32")
    monkeypatch.setattr(pipeline, "run_illustrator_fallback", reached_worker)
    with pytest.raises(ReachedWorker, match="worker reached"):
        pipeline.preflight_product(
            {
                "code": "LEGACY",
                "slug": "windows",
                "display_name": "Windows legacy fallback",
                "source_ai": source.name,
                "template": template.name,
            },
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": True, "application": str(illustrator)},
            False,
        )


def test_windows_illustrator_bridge_changes_invalidate_pipeline_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = pipeline_module()
    source = tmp_path / "source.ai"
    template = tmp_path / "template.json"
    runner = tmp_path / "run_export.vbs"
    source.write_bytes(b"ai")
    template.write_text("{}", encoding="utf-8")
    runner.write_text("bridge-v1", encoding="utf-8")
    monkeypatch.setattr(pipeline, "ILLUSTRATOR_WINDOWS_RUNNER", runner)

    first = pipeline.job_fingerprint(source, template, {"structure_engine": "v2"})
    runner.write_text("bridge-v2", encoding="utf-8")
    second = pipeline.job_fingerprint(source, template, {"structure_engine": "v2"})

    assert first != second


def test_preflight_cli_writes_a_prepared_manifest_without_starting_blender(tmp_path: Path):
    product, _source = prepare_v2_product(tmp_path)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "output_root": str(tmp_path / "output"),
                "blender_executable": str(tmp_path / "missing-blender"),
                "illustrator": {"enabled": False},
                "generate_ppt": False,
                "products": [product],
            }
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [sys.executable, str(PACKAGING / "pipeline.py"), str(manifest), "--preflight-only"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    report = json.loads(process.stdout.strip().splitlines()[-1])
    assert report["mode"] == "preflight"
    prepared_path = Path(report["prepared_manifest"])
    assert prepared_path.is_file()
    prepared = json.loads(prepared_path.read_text(encoding="utf-8"))
    assert prepared["products"][0]["structure_engine"] == "v2"
    assert Path(prepared["products"][0]["structure_sidecar"]).is_file()
    assert Path(prepared["products"][0]["artwork_pdf"]).is_file()
    assert "STAGE structure" in process.stderr


def test_preflight_cli_returns_recoverable_structure_control_json(tmp_path: Path):
    product, source = prepare_v2_product(tmp_path)
    product.pop("structure_sidecar")
    source.with_name(source.name + ".structure.json").unlink()
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "output_root": str(tmp_path / "output"),
                "illustrator": {"enabled": False},
                "products": [product],
            }
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [sys.executable, str(PACKAGING / "pipeline.py"), str(manifest), "--preflight-only"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 3
    control = json.loads(process.stderr.strip().splitlines()[-1])
    assert control["kind"] == "structure_resolution"
    assert control["structure_status"] == "review_required"
    assert control["code"] == "structure_semantics_missing"
    assert Path(control["resolution_path"]).is_file()
    assert Path(control["details"]["artwork_preview"]).is_file()


FACES = ("front", "right", "back", "left", "top", "bottom")
OUTPUT_KEYS = (
    "blend",
    "glb",
    "front_right",
    "back_left",
    "front_right_ground",
    "back_left_ground",
    "front_right_set",
    "back_left_set",
)


def contract_module():
    spec = importlib.util.spec_from_file_location(
        "packaging_render_contract_pipeline_v2", PACKAGING / "render_contract.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


IDENTITY_KEYS = (
    "render_contract_hash",
    "render_profile_id",
    "render_profile_sha256",
    "render_registry_sha256",
)
COMPAT_RENDER = {
    "substrate_rgba": [0.7, 0.7, 0.7, 1.0],
    "resolution_x": 3000,
    "resolution_y": 3600,
    "camera_ortho_scale_mm": 224.0,
    "front_rotation_deg": 0.0,
    "back_rotation_deg": 180.0,
    "material_roughness": 0.52,
    "material_specular_ior": 0.08,
    "exact_white_background": True,
    "view_transform": "Standard",
    "look": "None",
    "exposure": 0.0,
    "world_strength": 0.62,
    "light_energy_scale": 4.0,
}


def identity_of(payload: dict) -> dict:
    return {key: payload[key] for key in IDENTITY_KEYS}


def seed_required_outputs(job: dict) -> None:
    for key, raw in job["outputs"].items():
        dest = Path(raw)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if key == "glb":
            dest.write_bytes(b"glTF" + b"\x02\x00\x00\x00\x0c\x00\x00\x00")
        elif key == "blend":
            dest.write_bytes(b"BLENDER-v293")
        else:
            Image.new("RGB", (8, 8), (1, 2, 3)).save(dest)


def blender_measurement_result(snapshot: dict, **overrides) -> dict:
    payload = {
        "code": snapshot["code"],
        "outputs": snapshot["outputs"],
        "execution_nonce": snapshot["execution_nonce"],
        "glb_dimensions_mm": {"x": 1.0, "y": 1.0, "z": 1.0},
        "glb_dimension_error_mm": {"x": 0.0, "y": 0.0, "z": 0.0},
        "glb_dimensions_mm_sorted": [1.0, 1.0, 1.0],
        "glb_dimension_error_mm_sorted": [0.0, 0.0, 0.0],
        "render_resolution": [
            int(snapshot["render"]["resolution_x"]),
            int(snapshot["render"]["resolution_y"]),
        ],
        "blender_elapsed_s": 0.01,
    }
    payload.update(overrides)
    return payload


def write_png(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), (200, 10, 10)).save(path)
    return path


def write_legacy_blender_job(
    tmp_path: Path,
    *,
    spec: dict | None = None,
    **overrides,
) -> dict:
    pipeline = pipeline_module()
    project = tmp_path / "LEGACYBOX"
    assets = project / "assets"
    assets.mkdir(parents=True)
    job = {
        "code": "LEGACYBOX",
        "slug": "relight",
        "display_name": "历史花盒",
        "pipeline_version": "1.4.0",
        "structure_engine": "v2",
        "project_dir": str(project),
        "structure_schema": "packaging-structure/1",
        "structure_hash": "sha256:" + "a" * 64,
        "dimensions_mm": {"width": 47.5, "depth": 47.5, "height": 177.5},
        "assets": {
            face: str(write_png(assets / f"panel_{face}.png")) for face in FACES
        },
        "outputs": {
            "blend": str(project / "LEGACYBOX_relight_white_studio.blend"),
            "glb": str(project / "LEGACYBOX_relight.glb"),
            "front_right": str(project / "LEGACYBOX_relight_front_right_white.png"),
            "back_left": str(project / "LEGACYBOX_relight_back_left_white.png"),
        },
        "render": dict(COMPAT_RENDER),
    }
    job.update(overrides)
    if spec is not None:
        job["render_spec"] = spec
        renderer = spec.get("renderer") or {}
        if spec.get("render_contract_hash"):
            job["render_contract_hash"] = spec["render_contract_hash"]
        if renderer.get("profile"):
            job["render_profile_id"] = renderer["profile"]
        if renderer.get("profile_sha256"):
            job["render_profile_sha256"] = renderer["profile_sha256"]
        if spec.get("registry_sha256"):
            job["render_registry_sha256"] = spec["registry_sha256"]
        contract = contract_module()
        try:
            job["render"] = contract.current_renderer_config(spec)
        except contract.RenderContractError:
            pass
    for path in job["outputs"].values():
        Path(path).write_bytes(b"original-output")
    resolved_path = project / "resolved_job.json"
    pipeline.save_json(resolved_path, job)
    job["resolved_job_path"] = str(resolved_path)
    return job


def test_pipeline_v2_persists_profile_resolved_spec_and_locked_render_params(
    tmp_path: Path,
):
    pipeline = pipeline_module()
    contract = contract_module()
    product, _source = prepare_v2_product(tmp_path)
    job = pipeline.preflight_product(
        product,
        tmp_path,
        tmp_path / "output",
        False,
        {"enabled": False},
        False,
    )
    spec = job["render_spec"]
    expected = contract.resolve_render_spec(
        {
            "schema": "resolved-packaging-job/3",
            "structure_schema": job["structure_schema"],
            "structure_hash": job["structure_hash"],
            "dimensions_mm": job["dimensions_mm"],
            "faces": {face: {} for face in FACES},
            "validation": {"status": "accepted", "errors": [], "warnings": []},
        },
        "compat-legacy-v0",
        {},
    )

    assert spec["schema"] == "packaging-render-spec/1"
    assert spec["source"] == "profile_resolved"
    assert spec["renderer"]["profile"] == "compat-legacy-v0"
    assert spec["render_contract_hash"] == expected["render_contract_hash"]
    assert job["render"] == contract.current_renderer_config(spec)
    assert job["render"] == {
        "substrate_rgba": [0.7, 0.7, 0.7, 1.0],
        "resolution_x": 3000,
        "resolution_y": 3600,
        "camera_ortho_scale_mm": 224.0,
        "front_rotation_deg": 0.0,
        "back_rotation_deg": 180.0,
        "material_roughness": 0.52,
        "material_specular_ior": 0.08,
        "exact_white_background": True,
        "view_transform": "Standard",
        "look": "None",
        "exposure": 0.0,
        "world_strength": 0.62,
        "light_energy_scale": 4.0,
    }
    persisted = json.loads(Path(job["resolved_job_path"]).read_text(encoding="utf-8"))
    assert persisted["render_spec"] == spec
    assert persisted["render"] == job["render"]
    assert identity_of(job) == identity_of(persisted)
    assert job["render_contract_hash"] == spec["render_contract_hash"]
    assert job["render_profile_id"] == "compat-legacy-v0"
    assert job["render_profile_sha256"] == spec["renderer"]["profile_sha256"]
    assert job["render_registry_sha256"] == spec["registry_sha256"]
    assert set(job["outputs"]) == set(OUTPUT_KEYS)


def test_preflight_report_carries_the_same_render_contract_identity(tmp_path: Path):
    product, _source = prepare_v2_product(tmp_path)
    manifest = tmp_path / "manifest.json"
    output = tmp_path / "output"
    manifest.write_text(
        json.dumps(
            {
                "output_root": str(output),
                "blender_executable": str(tmp_path / "missing-blender"),
                "illustrator": {"enabled": False},
                "generate_ppt": False,
                "products": [product],
            }
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [sys.executable, str(PACKAGING / "pipeline.py"), str(manifest), "--preflight-only"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    report = json.loads(process.stdout.strip().splitlines()[-1])
    job = report["products"][0]
    resolved = json.loads(Path(job["resolved_job_path"]).read_text(encoding="utf-8"))
    result = json.loads(
        (Path(job["project_dir"]) / "pipeline_result.json").read_text(encoding="utf-8")
    ) if (Path(job["project_dir"]) / "pipeline_result.json").is_file() else job
    identity = identity_of(job)
    assert report["mode"] == "preflight"
    assert report["pipeline_version"] == "1.5.1"
    assert identity_of(resolved) == identity
    assert identity["render_contract_hash"] == job["render_spec"]["render_contract_hash"]
    assert resolved["fingerprint"] == job["fingerprint"]
    if result is not job:
        assert identity_of(result) == identity


def test_missing_render_profile_id_fails_before_face_assets_or_blender(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    template = tmp_path / "render-profile.json"
    payload = json.loads(template.read_text(encoding="utf-8"))
    payload.pop("render_profile_id")
    template.write_text(json.dumps(payload), encoding="utf-8")
    called = {"faces": 0}

    def boom(*_args, **_kwargs):
        called["faces"] += 1
        raise AssertionError("render_face_assets must not run without a profile")

    monkeypatch.setattr(pipeline, "render_face_assets", boom)
    with pytest.raises(pipeline.PipelineError) as raised:
        pipeline.preflight_product(
            product,
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": False},
            False,
        )
    assert raised.value.code == "render_contract_invalid"
    assert called["faces"] == 0
    assets = tmp_path / "output" / "V2BOX" / "assets"
    assert not assets.exists() or not any(assets.glob("panel_*.png"))


@pytest.mark.parametrize(
    ("template_patch", "code"),
    [
        ({"render_profile_id": "not-registered"}, "render_profile_unsupported"),
        ({"output_request": {"dimensions_mm": {}}}, "render_contract_invalid"),
        ({"output_request": {"ground_pass": 1}}, "render_contract_invalid"),
    ],
)
def test_unknown_profile_and_illegal_output_request_fail_closed(
    tmp_path: Path, template_patch: dict, code: str
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    template = tmp_path / "render-profile.json"
    current = json.loads(template.read_text(encoding="utf-8"))
    current.update(template_patch)
    template.write_text(json.dumps(current), encoding="utf-8")
    with pytest.raises(pipeline.PipelineError) as raised:
        pipeline.preflight_product(
            product,
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": False},
            False,
        )
    assert raised.value.code == code


def test_profile_hash_registry_hash_structure_hash_and_output_request_cache_miss(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    contract = contract_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    first = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    result_path = Path(first["project_dir"]) / "pipeline_result.json"

    def restore_cache() -> None:
        seed_required_outputs(first)
        pipeline.save_json(result_path, first)

    restore_cache()
    hit = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    assert hit["cache_hit"] is True

    template = tmp_path / "render-profile.json"
    payload = json.loads(template.read_text(encoding="utf-8"))
    payload["render_profile_id"] = "smoke-v1"
    template.write_text(json.dumps(payload), encoding="utf-8")
    profile_miss = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    assert profile_miss["cache_hit"] is False
    assert profile_miss["render_spec"]["renderer"]["profile"] == "smoke-v1"
    assert (
        profile_miss["render_spec"]["render_contract_hash"]
        != first["render_spec"]["render_contract_hash"]
    )

    payload["render_profile_id"] = "compat-legacy-v0"
    payload["output_request"] = {"ground_pass": False, "white_set_pass": False}
    template.write_text(json.dumps(payload), encoding="utf-8")
    restore_cache()
    output_miss = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    assert output_miss["cache_hit"] is False
    assert output_miss["render_spec"]["outputs"]["ground_pass"] == "disabled"

    payload.pop("output_request")
    template.write_text(json.dumps(payload), encoding="utf-8")
    restore_cache()
    source = tmp_path / product["source_ai"]
    structure = {
        "schema": "resolved-packaging-job/3",
        "structure_schema": "packaging-structure/1",
        "structure_hash": first["structure_hash"],
        "dimensions_mm": first["dimensions_mm"],
        "faces": {face: {} for face in FACES},
        "validation": {"status": "accepted", "errors": [], "warnings": []},
    }
    default_plan = contract.render_plan_for_new_job(structure, "compat-legacy-v0", None)
    product_payload = {
        **product,
        "structure_hash": first["structure_hash"],
        "render_plan_token": default_plan["fingerprint_token"],
    }
    structure_miss = dict(product_payload)
    structure_miss["structure_hash"] = "sha256:" + "f" * 64
    assert pipeline.job_fingerprint(
        source, template, structure_miss, extra_paths=(template,)
    ) != pipeline.job_fingerprint(
        source, template, product_payload, extra_paths=(template,)
    )

    reformatted = tmp_path / "registry.json"
    reformatted.write_text(
        json.dumps(
            json.loads(
                (PACKAGING / "profiles" / "render-profiles.v1.json").read_text(
                    encoding="utf-8"
                )
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    reformatted_plan = contract.render_plan_for_new_job(
        structure, "compat-legacy-v0", None, registry_path=reformatted
    )
    assert (
        reformatted_plan["identity"]["render_registry_sha256"]
        != default_plan["identity"]["render_registry_sha256"]
    )
    assert reformatted_plan["fingerprint_token"] != default_plan["fingerprint_token"]
    changed_fp = pipeline.job_fingerprint(
        source,
        template,
        {
            **product,
            "structure_hash": first["structure_hash"],
            "render_plan_token": reformatted_plan["fingerprint_token"],
        },
        extra_paths=(template,),
    )
    assert changed_fp != pipeline.job_fingerprint(
        source, template, product_payload, extra_paths=(template,)
    )


def test_old_pipeline_result_without_render_spec_is_not_a_cache_hit(tmp_path: Path):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    job = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    seed_required_outputs(job)
    stale = deepcopy(job)
    stale.pop("render_spec")
    pipeline.save_json(Path(job["project_dir"]) / "pipeline_result.json", stale)
    missed = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    assert missed["cache_hit"] is False
    assert missed["render_spec"]["source"] == "profile_resolved"


def test_matching_fingerprint_still_requires_existing_output_files(tmp_path: Path):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    job = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    seed_required_outputs(job)
    pipeline.save_json(Path(job["project_dir"]) / "pipeline_result.json", job)
    Path(job["outputs"]["front_right"]).unlink()
    missed = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    assert missed["cache_hit"] is False


def test_canonical_spec_whitespace_does_not_change_contract_hash_in_fingerprint():
    pipeline = pipeline_module()
    contract = contract_module()
    source = PACKAGING / "pipeline.py"
    template = PACKAGING / "templates" / "flower_box_47_5x47_5x177_5.json"
    plan = contract.render_plan_for_new_job(
        {
            "schema": "resolved-packaging-job/3",
            "structure_schema": "packaging-structure/1",
            "structure_hash": "sha256:" + "a" * 64,
            "dimensions_mm": {"width": 47.5, "depth": 47.5, "height": 177.5},
            "faces": {face: {} for face in FACES},
            "validation": {"status": "accepted", "errors": [], "warnings": []},
        },
        "compat-legacy-v0",
        None,
    )
    compact = json.loads(json.dumps(plan["spec"], separators=(",", ":")))
    pretty = json.loads(json.dumps(plan["spec"], indent=4))
    product = {
        "structure_engine": "v2",
        "structure_hash": plan["spec"]["geometry"]["structure_hash"],
        "render_plan_token": plan["fingerprint_token"],
    }
    first = pipeline.job_fingerprint(source, template, product)
    second = pipeline.job_fingerprint(
        source,
        template,
        {
            "structure_engine": "v2",
            "structure_hash": pretty["geometry"]["structure_hash"],
            "render_plan_token": plan["fingerprint_token"],
        },
    )
    assert compact["render_contract_hash"] == pretty["render_contract_hash"]
    assert first == second
    mutated = dict(product)
    mutated["render_plan_token"] = "sha256:" + "b" * 64
    assert pipeline.job_fingerprint(source, template, mutated) != first


def test_blender_only_revalidates_complete_spec_and_rejects_tampered_hash(
    tmp_path: Path,
):
    pipeline = pipeline_module()
    contract = contract_module()
    spec = contract.resolve_render_spec(
        {
            "schema": "resolved-packaging-job/3",
            "structure_schema": "packaging-structure/1",
            "structure_hash": "sha256:" + "a" * 64,
            "dimensions_mm": {"width": 47.5, "depth": 47.5, "height": 177.5},
            "faces": {face: {} for face in FACES},
            "validation": {"status": "accepted", "errors": [], "warnings": []},
        },
        "compat-legacy-v0",
        {},
    )
    write_legacy_blender_job(tmp_path, spec=spec)
    jobs = pipeline.load_blender_only_jobs(
        [{"code": "LEGACYBOX"}], tmp_path, tmp_path
    )
    assert jobs[0]["render_spec"]["source"] == "profile_resolved"
    assert jobs[0]["render"] == contract.current_renderer_config(spec)

    tampered = deepcopy(spec)
    tampered["render_contract_hash"] = "sha256:" + "c" * 64
    write_legacy_blender_job(tmp_path / "tampered", spec=tampered)
    with pytest.raises(pipeline.PipelineError) as raised:
        pipeline.load_blender_only_jobs(
            [{"code": "LEGACYBOX"}],
            tmp_path / "tampered",
            tmp_path / "tampered",
        )
    assert raised.value.code == "render_contract_invalid"


def test_blender_only_synthesizes_legacy_spec_only_for_historical_jobs(
    tmp_path: Path,
):
    pipeline = pipeline_module()
    contract = contract_module()
    write_legacy_blender_job(tmp_path)
    jobs = pipeline.load_blender_only_jobs(
        [{"code": "LEGACYBOX"}], tmp_path, tmp_path
    )
    spec = jobs[0]["render_spec"]
    disk = json.loads(
        (tmp_path / "LEGACYBOX" / "resolved_job.json").read_text(encoding="utf-8")
    )
    assert spec["source"] == "legacy_synthesized"
    assert spec["renderer"]["profile"] == "compat-legacy-v0"
    assert "render_spec" not in disk
    assert jobs[0]["render"] == contract.current_renderer_config(spec)


def test_blender_only_legacy_job_without_structure_facts_does_not_guess_family(
    tmp_path: Path,
):
    pipeline = pipeline_module()
    write_legacy_blender_job(tmp_path, structure_hash=None, structure_schema=None)
    with pytest.raises(pipeline.PipelineError) as raised:
        pipeline.load_blender_only_jobs(
            [{"code": "LEGACYBOX"}], tmp_path, tmp_path
        )
    assert raised.value.code in {
        "render_family_unsupported",
        "render_contract_invalid",
    }

    write_legacy_blender_job(
        tmp_path / "unknown-family", packaging_family="flexible_pouch_v1"
    )
    with pytest.raises(pipeline.PipelineError) as raised:
        pipeline.load_blender_only_jobs(
            [{"code": "LEGACYBOX"}],
            tmp_path / "unknown-family",
            tmp_path / "unknown-family",
        )
    assert raised.value.code == "render_family_unsupported"


def test_blender_only_failure_does_not_rewrite_resolved_job_or_stills(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    write_legacy_blender_job(tmp_path)
    jobs = pipeline.load_blender_only_jobs(
        [{"code": "LEGACYBOX"}], tmp_path, tmp_path
    )
    resolved_path = Path(jobs[0]["resolved_job_path"])
    front = Path(jobs[0]["outputs"]["front_right"])
    original_resolved = resolved_path.read_bytes()
    original_front = front.read_bytes()

    def boom(*_args, **_kwargs):
        raise pipeline.PipelineError("重渲棚失败")

    monkeypatch.setattr(pipeline, "run_blender_job", boom)
    with pytest.raises(pipeline.PipelineError, match="重渲棚失败"):
        pipeline.run_blender_relight(jobs[0], tmp_path / "missing-blender")
    assert resolved_path.read_bytes() == original_resolved
    assert front.read_bytes() == original_front
    disk = json.loads(resolved_path.read_text(encoding="utf-8"))
    assert "render_spec" not in disk


def test_successful_blender_only_writeback_keeps_spec_hash_and_render_aligned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    contract = contract_module()
    write_legacy_blender_job(tmp_path)
    jobs = pipeline.load_blender_only_jobs(
        [{"code": "LEGACYBOX"}], tmp_path, tmp_path
    )

    def fake_blender(job, _blender, **_kwargs):
        for path in job["outputs"].values():
            Path(path).write_bytes(b"relit-output")
        return job

    monkeypatch.setattr(pipeline, "run_blender_job", fake_blender)
    rendered = pipeline.run_blender_relight(jobs[0], tmp_path / "missing-blender")
    disk = json.loads(Path(rendered["resolved_job_path"]).read_text(encoding="utf-8"))
    spec = disk["render_spec"]
    assert spec["source"] == "legacy_synthesized"
    assert spec == contract.validate_render_spec(spec)
    assert disk["render"] == contract.current_renderer_config(spec)
    assert identity_of(disk) == identity_of(rendered)
    assert disk["render_contract_hash"] == spec["render_contract_hash"]
    assert Path(disk["outputs"]["front_right"]).read_bytes() == b"relit-output"
    assert set(disk["outputs"]) == {
        "blend",
        "glb",
        "front_right",
        "back_left",
    }


def test_blender_only_cli_fails_closed_without_blender(tmp_path: Path):
    write_legacy_blender_job(tmp_path)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "output_root": str(tmp_path),
                "blender_executable": str(tmp_path / "missing-blender"),
                "illustrator": {"enabled": False},
                "generate_ppt": False,
                "products": [{"code": "LEGACYBOX"}],
            }
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [
            sys.executable,
            str(PACKAGING / "pipeline.py"),
            str(manifest),
            "--blender-only",
            "--no-ppt",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 2
    payload = json.loads(process.stderr.strip().splitlines()[-1])
    assert payload["ok"] is False
    assert "Blender" in payload["error"]
    disk = json.loads((tmp_path / "LEGACYBOX" / "resolved_job.json").read_text(encoding="utf-8"))
    assert "render_spec" not in disk
    assert Path(disk["outputs"]["front_right"]).read_bytes() == b"original-output"


def test_v2_template_falsy_output_request_fails_closed(tmp_path: Path):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    template = tmp_path / "render-profile.json"
    payload = json.loads(template.read_text(encoding="utf-8"))
    payload["output_request"] = False
    template.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(pipeline.PipelineError) as raised:
        pipeline.preflight_product(
            product, tmp_path, tmp_path / "output", False, {"enabled": False}, False
        )
    assert raised.value.code == "render_contract_invalid"


def test_non_v2_registered_template_path_does_not_raise_keyerror(tmp_path: Path):
    pipeline = pipeline_module()
    source = tmp_path / "art.pdf"
    document = pymupdf.open()
    document.new_page(width=1498.67, height=1446)
    document.save(str(source))
    document.close()
    template = tmp_path / "square.json"
    template.write_text(
        json.dumps(
            {
                "template_id": "square",
                "description": "方形花盒",
                "expected_page_points": [2833.5, 1507.67],
                "page_size_tolerance_ratio": 0.02,
                "dimensions_mm": {"width": 10, "depth": 10, "height": 20},
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(pipeline.PipelineError) as raised:
        pipeline.preflight_product(
            {
                "code": "t1",
                "slug": "t1",
                "display_name": "t",
                "source_ai": source.name,
                "template": template.name,
            },
            tmp_path,
            tmp_path / "out",
            False,
            {},
            False,
        )
    assert raised.value.__class__.__name__ == "PipelineError"
    assert "render_profile_id" not in str(raised.value).lower()


def _assert_blender_subprocess_not_called(pipeline, job, tmp_path, monkeypatch):
    called = {"run": 0}

    def boom(*_args, **_kwargs):
        called["run"] += 1
        raise AssertionError("subprocess must not start")

    monkeypatch.setattr(pipeline.subprocess, "run", boom)
    with pytest.raises(pipeline.PipelineError) as raised:
        pipeline.run_blender_job(job, tmp_path / "missing-blender")
    assert called["run"] == 0
    return raised


def test_run_blender_job_rejects_disk_tamper_before_subprocess(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    job = pipeline.preflight_product(
        product, tmp_path, tmp_path / "output", False, {"enabled": False}, False
    )
    disk_path = Path(job["resolved_job_path"])
    tampered = json.loads(disk_path.read_text(encoding="utf-8"))
    tampered["render_spec"]["render_contract_hash"] = "sha256:" + "c" * 64
    pipeline.save_json(disk_path, tampered)
    raised = _assert_blender_subprocess_not_called(pipeline, job, tmp_path, monkeypatch)
    assert "篡改" in str(raised.value) or raised.value.code == "render_contract_invalid"


@pytest.mark.parametrize("missing_key", IDENTITY_KEYS)
def test_run_blender_job_rejects_missing_disk_identity_before_subprocess(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, missing_key: str
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    job = pipeline.preflight_product(
        product, tmp_path, tmp_path / "output", False, {"enabled": False}, False
    )
    disk_path = Path(job["resolved_job_path"])
    tampered = json.loads(disk_path.read_text(encoding="utf-8"))
    tampered.pop(missing_key)
    pipeline.save_json(disk_path, tampered)
    raised = _assert_blender_subprocess_not_called(pipeline, job, tmp_path, monkeypatch)
    assert raised.value.code == "render_contract_invalid"


def test_run_blender_job_rejects_disk_flat_render_tamper_before_subprocess(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    job = pipeline.preflight_product(
        product, tmp_path, tmp_path / "output", False, {"enabled": False}, False
    )
    disk_path = Path(job["resolved_job_path"])
    tampered = json.loads(disk_path.read_text(encoding="utf-8"))
    tampered["render"]["resolution_x"] = 1
    pipeline.save_json(disk_path, tampered)
    raised = _assert_blender_subprocess_not_called(pipeline, job, tmp_path, monkeypatch)
    assert raised.value.code == "render_contract_invalid"


def test_run_blender_job_rejects_disk_output_escape_before_subprocess(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    job = pipeline.preflight_product(
        product, tmp_path, tmp_path / "output", False, {"enabled": False}, False
    )
    outside = tmp_path / "stolen.png"
    Image.new("RGB", (8, 8)).save(outside)
    disk_path = Path(job["resolved_job_path"])
    tampered = json.loads(disk_path.read_text(encoding="utf-8"))
    tampered["outputs"]["front_right"] = str(outside)
    pipeline.save_json(disk_path, tampered)
    raised = _assert_blender_subprocess_not_called(pipeline, job, tmp_path, monkeypatch)
    assert raised.value.code == "render_contract_invalid" or "本单目录" in str(raised.value)


def test_blender_only_rejects_out_of_tree_symlink_and_duplicate_outputs(tmp_path: Path):
    pipeline = pipeline_module()
    outside = tmp_path / "outside.png"
    Image.new("RGB", (8, 8)).save(outside)
    write_legacy_blender_job(
        tmp_path / "escape",
        outputs={
            "blend": str(tmp_path / "escape" / "LEGACYBOX" / "LEGACYBOX_relight_white_studio.blend"),
            "glb": str(tmp_path / "escape" / "LEGACYBOX" / "LEGACYBOX_relight.glb"),
            "front_right": str(outside),
            "back_left": str(tmp_path / "escape" / "LEGACYBOX" / "LEGACYBOX_relight_back_left_white.png"),
        },
    )
    with pytest.raises(pipeline.PipelineError, match="本单目录"):
        pipeline.load_blender_only_jobs(
            [{"code": "LEGACYBOX"}], tmp_path / "escape", tmp_path / "escape"
        )

    project = write_legacy_blender_job(tmp_path / "dup")
    same = project["outputs"]["front_right"]
    write_legacy_blender_job(
        tmp_path / "dup2",
        outputs={
            "blend": str(tmp_path / "dup2" / "LEGACYBOX" / "LEGACYBOX_relight_white_studio.blend"),
            "glb": str(tmp_path / "dup2" / "LEGACYBOX" / "LEGACYBOX_relight.glb"),
            "front_right": same,
            "back_left": same,
        },
    )
    # rewrite inside dup2 project with duplicate dests
    inner = tmp_path / "dup2" / "LEGACYBOX"
    shared = inner / "shared.png"
    Image.new("RGB", (8, 8)).save(shared)
    job = json.loads((inner / "resolved_job.json").read_text(encoding="utf-8"))
    job["outputs"]["front_right"] = str(shared)
    job["outputs"]["back_left"] = str(shared)
    pipeline.save_json(inner / "resolved_job.json", job)
    with pytest.raises(pipeline.PipelineError, match="重复"):
        pipeline.load_blender_only_jobs(
            [{"code": "LEGACYBOX"}], tmp_path / "dup2", tmp_path / "dup2"
        )

    linked = write_legacy_blender_job(tmp_path / "link")
    front = Path(linked["outputs"]["front_right"])
    alias = front.with_name("alias.png")
    alias.symlink_to(front)
    job = json.loads(Path(linked["resolved_job_path"]).read_text(encoding="utf-8"))
    job["outputs"]["front_right"] = str(alias)
    pipeline.save_json(Path(linked["resolved_job_path"]), job)
    with pytest.raises(pipeline.PipelineError, match="符号链接"):
        pipeline.load_blender_only_jobs(
            [{"code": "LEGACYBOX"}], tmp_path / "link", tmp_path / "link"
        )


def test_relight_failpoints_roll_back_all_original_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    write_legacy_blender_job(tmp_path)
    jobs = pipeline.load_blender_only_jobs(
        [{"code": "LEGACYBOX"}], tmp_path, tmp_path
    )
    resolved_path = Path(jobs[0]["resolved_job_path"])
    originals = {
        key: Path(path).read_bytes()
        for key, path in jobs[0]["outputs"].items()
    }
    original_resolved = resolved_path.read_bytes()

    def fake_blender(job, _blender, **_kwargs):
        for path in job["outputs"].values():
            Path(path).write_bytes(b"new-relight")
        return job

    monkeypatch.setattr(pipeline, "run_blender_job", fake_blender)

    def fail_nth(stage, **details):
        if stage == "replace_output" and details.get("index") == 2:
            raise pipeline.PipelineError("failpoint-replace")

    monkeypatch.setattr(pipeline, "relight_commit_failpoint", fail_nth)
    with pytest.raises(pipeline.PipelineError, match="failpoint-replace"):
        pipeline.run_blender_relight(jobs[0], tmp_path / "missing-blender")
    assert resolved_path.read_bytes() == original_resolved
    for key, data in originals.items():
        assert Path(jobs[0]["outputs"][key]).read_bytes() == data

    def fail_job(stage, **_details):
        if stage == "write_resolved_job":
            raise pipeline.PipelineError("failpoint-job")

    monkeypatch.setattr(pipeline, "relight_commit_failpoint", fail_job)
    with pytest.raises(pipeline.PipelineError, match="failpoint-job"):
        pipeline.run_blender_relight(jobs[0], tmp_path / "missing-blender")
    assert resolved_path.read_bytes() == original_resolved
    for key, data in originals.items():
        assert Path(jobs[0]["outputs"][key]).read_bytes() == data
    disk = json.loads(resolved_path.read_text(encoding="utf-8"))
    assert "render_spec" not in disk


def test_cache_misses_for_escape_duplicate_empty_and_wrong_format(tmp_path: Path):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    job = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    result_path = Path(job["project_dir"]) / "pipeline_result.json"

    def miss_after(mutate) -> None:
        seed_required_outputs(job)
        payload = deepcopy(job)
        mutate(payload)
        pipeline.save_json(result_path, payload)
        missed = pipeline.preflight_product(
            product, tmp_path, output, False, {"enabled": False}, False
        )
        assert missed["cache_hit"] is False

    outside = tmp_path / "stolen.png"
    Image.new("RGB", (8, 8)).save(outside)

    def escape(payload):
        payload["outputs"]["front_right"] = str(outside)

    miss_after(escape)

    def duplicate(payload):
        payload["outputs"]["back_left"] = payload["outputs"]["front_right"]

    miss_after(duplicate)

    def empty(payload):
        Path(payload["outputs"]["glb"]).write_bytes(b"")

    miss_after(empty)

    def wrong_format(payload):
        Path(payload["outputs"]["front_right"]).write_bytes(b"not-a-png")

    miss_after(wrong_format)


def test_full_run_persists_identity_and_existing_report_structure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    blender = tmp_path / "blender"
    blender.write_bytes(b"fake-blender")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "output_root": str(output),
                "blender_executable": str(blender),
                "illustrator": {"enabled": False},
                "generate_ppt": False,
                "products": [product],
            }
        ),
        encoding="utf-8",
    )

    def fake_blender(job, _exe, **_kwargs):
        seed_required_outputs(job)
        return job

    monkeypatch.setattr(pipeline, "run_blender_job", fake_blender)
    monkeypatch.setattr(
        sys,
        "argv",
        ["pipeline.py", str(manifest), "--no-ppt"],
    )
    assert pipeline.main() == 0
    report = json.loads((output / "pipeline_report.json").read_text(encoding="utf-8"))
    job = report["products"][0]
    result = json.loads(
        (Path(job["project_dir"]) / "pipeline_result.json").read_text(encoding="utf-8")
    )
    resolved = json.loads(Path(job["resolved_job_path"]).read_text(encoding="utf-8"))
    identity = identity_of(job)
    assert report["success"] is True
    assert report["pipeline_version"] == "1.5.1"
    assert "sla_pass" in report
    assert set(job["outputs"]) >= {
        "blend",
        "glb",
        "front_right",
        "back_left",
    }
    assert identity_of(result) == identity
    assert identity_of(resolved) == identity
    assert identity["render_profile_id"] == "compat-legacy-v0"


PRODUCTION_TEMPLATE = PACKAGING / "templates" / "flower_box_47_5x47_5x177_5.json"
SMOKE_TEMPLATE = PACKAGING / "templates" / "flower_box_illustrator_smoke.json"


def _small_v1_thumbnail(source, output_dir, width_px):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    out = output_dir / f"{Path(source).stem}.png"
    Image.new("RGB", (500, 266), (240, 240, 240)).save(out)
    return out


def _write_v1_pdf(path: Path, layer_name: str) -> Path:
    document = pymupdf.open()
    page = document.new_page(width=2833.5, height=1507.67)
    ocg = document.add_ocg(layer_name)
    page.draw_rect(pymupdf.Rect(10, 10, 200, 200), color=None, fill=(0.8, 0.8, 0.8), oc=ocg)
    document.save(str(path))
    document.close()
    return path


def test_non_v2_production_template_preflight_reaches_resolved_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    monkeypatch.setattr(pipeline, "render_pdf_thumbnail", _small_v1_thumbnail)
    source = _write_v1_pdf(tmp_path / "art.pdf", "印刷")
    job = pipeline.preflight_product(
        {
            "code": "V1PROD",
            "slug": "diag",
            "display_name": "V1 生产模板诊断",
            "source_ai": source.name,
            "template": str(PRODUCTION_TEMPLATE),
        },
        tmp_path,
        tmp_path / "out",
        False,
        {"enabled": False},
        False,
    )
    assert job.get("structure_engine") != "v2"
    assert "render_spec" not in job
    assert job["render"]["resolution_x"] == 3000
    assert job["render"]["resolution_y"] == 3600
    assert job["render"]["substrate_rgba"] == [1.0, 1.0, 1.0, 1.0]
    persisted = json.loads(Path(job["resolved_job_path"]).read_text(encoding="utf-8"))
    assert persisted["render"] == job["render"]


def test_non_v2_smoke_template_preflight_reaches_resolved_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    monkeypatch.setattr(pipeline, "render_pdf_thumbnail", _small_v1_thumbnail)
    source = _write_v1_pdf(tmp_path / "art.pdf", "图层 1")
    job = pipeline.preflight_product(
        {
            "code": "V1SMOKE",
            "slug": "diag",
            "display_name": "V1 smoke 诊断",
            "source_ai": source.name,
            "template": str(SMOKE_TEMPLATE),
        },
        tmp_path,
        tmp_path / "out",
        False,
        {"enabled": False},
        False,
    )
    assert job["render"]["resolution_x"] == 1200
    assert job["render"]["resolution_y"] == 1440
    assert job["template_id"] == "flower_box_illustrator_smoke"


def test_relight_optional_new_outputs_roll_back_on_late_failpoints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    write_legacy_blender_job(tmp_path)
    jobs = pipeline.load_blender_only_jobs(
        [{"code": "LEGACYBOX"}], tmp_path, tmp_path
    )
    original_job = deepcopy(jobs[0])
    resolved_path = Path(jobs[0]["resolved_job_path"])
    original_resolved = resolved_path.read_bytes()
    project = Path(jobs[0]["project_dir"])
    original_names = {
        path.name for path in project.rglob("*") if path.is_file()
    }

    def fake_blender(job, _blender, **_kwargs):
        for path in job["outputs"].values():
            Path(path).write_bytes(b"new-relight")
        extra = Path(job["project_dir"]) / "LEGACYBOX_relight_front_right_ground.png"
        extra.write_bytes(b"new-ground")
        job["outputs"]["front_right_ground"] = str(extra)
        return job

    monkeypatch.setattr(pipeline, "run_blender_job", fake_blender)

    def fail_job(stage, **_details):
        if stage == "write_resolved_job":
            raise pipeline.PipelineError("failpoint-job")

    monkeypatch.setattr(pipeline, "relight_commit_failpoint", fail_job)
    with pytest.raises(pipeline.PipelineError, match="failpoint-job"):
        pipeline.run_blender_relight(jobs[0], tmp_path / "missing-blender")
    assert resolved_path.read_bytes() == original_resolved
    assert jobs[0] == original_job
    disk = json.loads(resolved_path.read_text(encoding="utf-8"))
    assert "render_spec" not in disk
    assert not (project / "LEGACYBOX_relight_front_right_ground.png").exists()
    assert {path.name for path in project.rglob("*") if path.is_file()} == original_names

    def fail_optional(stage, **details):
        if stage == "replace_output" and details.get("key") == "front_right_ground":
            raise pipeline.PipelineError("failpoint-optional")

    monkeypatch.setattr(pipeline, "relight_commit_failpoint", fail_optional)
    with pytest.raises(pipeline.PipelineError, match="failpoint-optional"):
        pipeline.run_blender_relight(jobs[0], tmp_path / "missing-blender")
    assert resolved_path.read_bytes() == original_resolved
    assert jobs[0] == original_job
    assert not (project / "LEGACYBOX_relight_front_right_ground.png").exists()


def test_cache_misses_hardlink_case_alias_and_unknown_output_key(tmp_path: Path):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    job = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    result_path = Path(job["project_dir"]) / "pipeline_result.json"

    def miss_after(mutate) -> None:
        seed_required_outputs(job)
        payload = deepcopy(job)
        mutate(payload)
        pipeline.save_json(result_path, payload)
        missed = pipeline.preflight_product(
            product, tmp_path, output, False, {"enabled": False}, False
        )
        assert missed["cache_hit"] is False

    def hardlink(payload):
        front = Path(payload["outputs"]["front_right"])
        back = Path(payload["outputs"]["back_left"])
        if back.exists() or back.is_symlink():
            back.unlink()
        os.link(front, back)

    miss_after(hardlink)

    def case_alias(payload):
        front = Path(payload["outputs"]["front_right"])
        payload["outputs"]["back_left"] = str(front.with_name(front.name.upper()))

    miss_after(case_alias)

    def unknown_key(payload):
        extra = Path(payload["project_dir"]) / "evil.bin"
        extra.write_bytes(b"nope")
        payload["outputs"]["evil"] = str(extra)

    miss_after(unknown_key)


def _pipeline_render_contract():
    return sys.modules["render_contract"]


def test_preflight_cache_boundary_loads_registry_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    job = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    seed_required_outputs(job)
    pipeline.save_json(Path(job["project_dir"]) / "pipeline_result.json", job)
    contract_mod = _pipeline_render_contract()
    real = contract_mod.load_profile_registry
    calls = {"n": 0}

    def wrapped(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(contract_mod, "load_profile_registry", wrapped)
    cached = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    assert cached["cache_hit"] is True
    assert calls["n"] == 1


def test_run_blender_job_loads_registry_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    job = pipeline.preflight_product(
        product, tmp_path, tmp_path / "output", False, {"enabled": False}, False
    )
    contract_mod = _pipeline_render_contract()
    real = contract_mod.load_profile_registry
    calls = {"n": 0}

    def wrapped(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    def fake_run(command, *_args, **_kwargs):
        snapshot = json.loads(Path(command[-1]).read_text(encoding="utf-8"))
        project = Path(job["project_dir"])
        seed_required_outputs(job)
        pipeline.save_json(
            project / "blender_result.json",
            blender_measurement_result(snapshot, render_resolution=[3000, 3600]),
        )
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(contract_mod, "load_profile_registry", wrapped)
    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    pipeline.run_blender_job(job, tmp_path / "missing-blender")
    assert calls["n"] == 1


def test_blender_only_load_loads_registry_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    write_legacy_blender_job(tmp_path)
    contract_mod = _pipeline_render_contract()
    real = contract_mod.load_profile_registry
    calls = {"n": 0}

    def wrapped(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(contract_mod, "load_profile_registry", wrapped)
    pipeline.load_blender_only_jobs([{"code": "LEGACYBOX"}], tmp_path, tmp_path)
    assert calls["n"] == 1


def test_cache_misses_when_previous_project_dir_widens_outside_outputs(
    tmp_path: Path,
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    job = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    seed_required_outputs(job)
    parent = Path(job["project_dir"]).parent
    escaped = parent / "escaped_ground.png"
    Image.new("RGB", (8, 8)).save(escaped)
    payload = deepcopy(job)
    payload["project_dir"] = str(parent)
    payload["outputs"] = dict(job["outputs"])
    payload["outputs"]["front_right_ground"] = str(escaped)
    pipeline.save_json(Path(job["project_dir"]) / "pipeline_result.json", payload)
    missed = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    assert missed["cache_hit"] is False


def test_cache_misses_for_missing_outside_symlink_duplicate_hardlink_case_assets(
    tmp_path: Path,
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    job = pipeline.preflight_product(
        product, tmp_path, output, False, {"enabled": False}, False
    )
    result_path = Path(job["project_dir"]) / "pipeline_result.json"

    def miss_after(mutate) -> None:
        seed_required_outputs(job)
        for face, raw in job["assets"].items():
            dest = Path(raw)
            if dest.is_symlink() or dest.exists():
                dest.unlink()
            Image.new("RGB", (8, 8), (10, 20, 30)).save(dest)
        payload = deepcopy(job)
        mutate(payload)
        pipeline.save_json(result_path, payload)
        missed = pipeline.preflight_product(
            product, tmp_path, output, False, {"enabled": False}, False
        )
        assert missed["cache_hit"] is False

    def missing(payload):
        Path(payload["assets"]["top"]).unlink()

    miss_after(missing)

    def outside(payload):
        stolen = tmp_path / "panel_front.png"
        Image.new("RGB", (8, 8)).save(stolen)
        payload["assets"] = dict(payload["assets"])
        payload["assets"]["front"] = str(stolen)

    miss_after(outside)

    def symlink_asset(payload):
        front = Path(payload["assets"]["front"])
        real = front.with_name("panel_front_real.png")
        if real.exists() or real.is_symlink():
            real.unlink()
        front.rename(real)
        front.symlink_to(real)

    miss_after(symlink_asset)

    def duplicate(payload):
        payload["assets"] = dict(payload["assets"])
        payload["assets"]["back"] = payload["assets"]["front"]

    miss_after(duplicate)

    def hardlink(payload):
        front = Path(payload["assets"]["front"])
        back = Path(payload["assets"]["back"])
        if back.exists() or back.is_symlink():
            back.unlink()
        os.link(front, back)

    miss_after(hardlink)

    def case_alias(payload):
        front = Path(payload["assets"]["front"])
        payload["assets"] = dict(payload["assets"])
        payload["assets"]["back"] = str(front.with_name(front.name.upper()))

    miss_after(case_alias)


def test_blender_only_and_execution_reject_illegal_assets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    write_legacy_blender_job(tmp_path / "missing")
    job_path = tmp_path / "missing" / "LEGACYBOX" / "resolved_job.json"
    payload = json.loads(job_path.read_text(encoding="utf-8"))
    Path(payload["assets"]["left"]).unlink()
    pipeline.save_json(job_path, payload)
    with pytest.raises(pipeline.PipelineError):
        pipeline.load_blender_only_jobs(
            [{"code": "LEGACYBOX"}], tmp_path / "missing", tmp_path / "missing"
        )

    linked = write_legacy_blender_job(tmp_path / "link-asset")
    front = Path(linked["assets"]["front"])
    alias = front.with_name("alias.png")
    alias.symlink_to(front)
    disk = json.loads(Path(linked["resolved_job_path"]).read_text(encoding="utf-8"))
    disk["assets"] = dict(disk["assets"])
    disk["assets"]["front"] = str(alias)
    pipeline.save_json(Path(linked["resolved_job_path"]), disk)
    with pytest.raises(pipeline.PipelineError):
        pipeline.load_blender_only_jobs(
            [{"code": "LEGACYBOX"}],
            tmp_path / "link-asset",
            tmp_path / "link-asset",
        )


def test_run_blender_job_uses_private_snapshot_against_toctou(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    job = pipeline.preflight_product(
        product, tmp_path, tmp_path / "output", False, {"enabled": False}, False
    )
    disk_path = Path(job["resolved_job_path"])
    original_x = job["render"]["resolution_x"]
    seen = {"snapshot_x": None}

    def fake_run(command, *_args, **_kwargs):
        snapshot = json.loads(Path(command[-1]).read_text(encoding="utf-8"))
        seen["snapshot_x"] = snapshot["render"]["resolution_x"]
        tampered = json.loads(disk_path.read_text(encoding="utf-8"))
        tampered["render"]["resolution_x"] = 1
        pipeline.save_json(disk_path, tampered)
        seed_required_outputs(job)
        pipeline.save_json(
            Path(job["project_dir"]) / "blender_result.json",
            blender_measurement_result(
                snapshot,
                render_resolution=[original_x, snapshot["render"]["resolution_y"]],
            ),
        )
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    rendered = pipeline.run_blender_job(job, tmp_path / "missing-blender")
    assert seen["snapshot_x"] == original_x
    assert rendered["render"]["resolution_x"] == original_x
    assert rendered["glb_dimensions_mm"]["x"] == 1.0
    assert "execution_nonce" not in rendered


def test_blender_result_injection_is_rejected_before_cards(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    job = pipeline.preflight_product(
        product, tmp_path, tmp_path / "output", False, {"enabled": False}, False
    )
    outside = tmp_path / "outside-dir"
    outside.mkdir()
    victim = outside / "front_right_white_card.png"

    def fake_run(command, *_args, **_kwargs):
        snapshot = json.loads(Path(command[-1]).read_text(encoding="utf-8"))
        seed_required_outputs(job)
        polluted = dict(snapshot["outputs"])
        polluted["front_right"] = str(outside / "front_right_white.png")
        Path(polluted["front_right"]).write_bytes(b"not-from-this-job")
        pipeline.save_json(
            Path(job["project_dir"]) / "blender_result.json",
            blender_measurement_result(
                snapshot,
                outputs=polluted,
                project_dir=str(outside),
                render={"resolution_x": 1},
                render_spec={"schema": "nope"},
                glb_dimensions_mm={"x": 9.0, "y": 9.0, "z": 9.0},
            ),
        )
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    with pytest.raises(pipeline.PipelineError):
        pipeline.run_blender_job(job, tmp_path / "missing-blender")
    assert not victim.exists()
    assert job["render"]["resolution_x"] != 1
    assert "render_spec" in job
    assert job["project_dir"] != str(outside)


def test_run_blender_job_rejects_stale_blender_result_without_this_round_nonce(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    job = pipeline.preflight_product(
        product, tmp_path, tmp_path / "output", False, {"enabled": False}, False
    )
    seed_required_outputs(job)
    front = Path(job["outputs"]["front_right"])
    original_front = front.read_bytes()
    original_spec = deepcopy(job["render_spec"])
    project = Path(job["project_dir"])
    pipeline.save_json(
        project / "blender_result.json",
        {
            "code": job["code"],
            "outputs": job["outputs"],
            "execution_nonce": "stale-nonce",
            "glb_dimensions_mm": {"x": 9.0, "y": 9.0, "z": 9.0},
            "glb_dimension_error_mm": {"x": 0.0, "y": 0.0, "z": 0.0},
            "glb_dimensions_mm_sorted": [9.0, 9.0, 9.0],
            "glb_dimension_error_mm_sorted": [0.0, 0.0, 0.0],
            "render_resolution": [1, 1],
            "blender_elapsed_s": 0.01,
        },
    )

    def fake_run(command, *_args, **_kwargs):
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    with pytest.raises(pipeline.PipelineError):
        pipeline.run_blender_job(job, tmp_path / "missing-blender")
    assert front.read_bytes() == original_front
    assert front.is_file()
    assert job.get("glb_dimensions_mm") != {"x": 9.0, "y": 9.0, "z": 9.0}
    assert job["render_spec"] == original_spec
    assert job["render"]["resolution_x"] != 1
    assert "execution_nonce" not in job


def prepare_v1_diagnostic_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[object, dict]:
    pipeline = pipeline_module()
    monkeypatch.setattr(pipeline, "render_pdf_thumbnail", _small_v1_thumbnail)
    source = _write_v1_pdf(tmp_path / "art.pdf", "印刷")
    job = pipeline.preflight_product(
        {
            "code": "V1PROD",
            "slug": "diag",
            "display_name": "V1 生产模板诊断",
            "source_ai": source.name,
            "template": str(PRODUCTION_TEMPLATE),
        },
        tmp_path,
        tmp_path / "out",
        False,
        {"enabled": False},
        False,
    )
    assert job.get("structure_engine") != "v2"
    assert "render_spec" not in job
    return pipeline, job


def test_run_blender_job_v1_rejects_stale_blender_result_without_this_round_nonce(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline, job = prepare_v1_diagnostic_job(tmp_path, monkeypatch)
    seed_required_outputs(job)
    front = Path(job["outputs"]["front_right"])
    original_front = front.read_bytes()
    original_render = deepcopy(job["render"])
    pipeline.save_json(
        Path(job["project_dir"]) / "blender_result.json",
        {
            "code": job["code"],
            "outputs": job["outputs"],
            "glb_dimensions_mm": {"x": 9.0, "y": 9.0, "z": 9.0},
            "glb_dimension_error_mm": {"x": 0.0, "y": 0.0, "z": 0.0},
            "glb_dimensions_mm_sorted": [9.0, 9.0, 9.0],
            "glb_dimension_error_mm_sorted": [0.0, 0.0, 0.0],
            "render_resolution": [1, 1],
            "blender_elapsed_s": 0.01,
        },
    )

    def fake_run(command, *_args, **_kwargs):
        snapshot_path = Path(command[-1])
        assert snapshot_path.resolve() != Path(job["resolved_job_path"]).resolve()
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        assert snapshot["execution_nonce"]
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    with pytest.raises(pipeline.PipelineError):
        pipeline.run_blender_job(job, tmp_path / "missing-blender")
    assert front.read_bytes() == original_front
    assert job.get("glb_dimensions_mm") != {"x": 9.0, "y": 9.0, "z": 9.0}
    assert job["render"] == original_render
    assert job["render"]["resolution_x"] != 1
    assert "execution_nonce" not in job


def test_run_blender_job_v1_accepts_this_round_nonce_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline, job = prepare_v1_diagnostic_job(tmp_path, monkeypatch)
    original_path = Path(job["resolved_job_path"]).resolve()
    seen = {"snapshot_path": None, "nonce": None}

    def fake_run(command, *_args, **_kwargs):
        snapshot_path = Path(command[-1]).resolve()
        seen["snapshot_path"] = snapshot_path
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        seen["nonce"] = snapshot["execution_nonce"]
        seed_required_outputs(job)
        pipeline.save_json(
            Path(job["project_dir"]) / "blender_result.json",
            blender_measurement_result(snapshot),
        )
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    rendered = pipeline.run_blender_job(job, tmp_path / "missing-blender")
    assert seen["snapshot_path"] is not None
    assert seen["snapshot_path"] != original_path
    assert seen["nonce"]
    assert rendered["glb_dimensions_mm"] == {"x": 1.0, "y": 1.0, "z": 1.0}
    assert rendered["render_resolution"] == [3000, 3600]
    assert "execution_nonce" not in rendered
    disk = json.loads(original_path.read_text(encoding="utf-8"))
    assert "execution_nonce" not in disk


@pytest.mark.parametrize("failure", ["serialization", "replace"])
def test_save_json_failure_preserves_original_and_cleans_temp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
):
    pipeline = pipeline_module()
    dest = tmp_path / "resolved_job.json"
    original = b'{"generation": "old"}\n'
    dest.write_bytes(original)
    if failure == "serialization":
        payload = {"generation": "new", "invalid": object()}
        expected_error = TypeError
    else:
        payload = {"generation": "new"}
        expected_error = OSError

        def reject_replace(source, target):
            assert Path(source).is_file()
            assert Path(target) == dest
            raise OSError("replace denied")

        monkeypatch.setattr(pipeline.os, "replace", reject_replace)
    with pytest.raises(expected_error):
        pipeline.save_json(dest, payload)
    assert dest.read_bytes() == original
    assert list(tmp_path.iterdir()) == [dest]


@pytest.mark.parametrize("outcome", ["success", "subprocess_error", "invalid_result"])
def test_blender_snapshot_is_removed_after_success_or_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, outcome: str
):
    pipeline, job = prepare_v1_diagnostic_job(tmp_path, monkeypatch)
    original_path = Path(job["resolved_job_path"])
    original_bytes = original_path.read_bytes()
    snapshots = []

    def fake_run(command, *_args, **_kwargs):
        snapshot_path = Path(command[-1])
        snapshots.append(snapshot_path)
        assert snapshot_path.is_file()
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        if outcome == "subprocess_error":
            raise OSError("subprocess unavailable")
        seed_required_outputs(job)
        result = blender_measurement_result(snapshot)
        if outcome == "invalid_result":
            result["execution_nonce"] = "old-round"
        pipeline.save_json(Path(job["project_dir"]) / "blender_result.json", result)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    if outcome == "success":
        pipeline.run_blender_job(job, tmp_path / "missing-blender")
    else:
        expected_error = OSError if outcome == "subprocess_error" else pipeline.PipelineError
        with pytest.raises(expected_error):
            pipeline.run_blender_job(job, tmp_path / "missing-blender")
    assert len(snapshots) == 1
    assert not snapshots[0].exists()
    assert not snapshots[0].parent.exists()
    assert original_path.read_bytes() == original_bytes


def test_relight_uses_verified_original_assets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pipeline = pipeline_module()
    write_legacy_blender_job(tmp_path)
    jobs = pipeline.load_blender_only_jobs(
        [{"code": "LEGACYBOX"}], tmp_path, tmp_path
    )
    original_assets = {
        face: Path(path).resolve() for face, path in jobs[0]["assets"].items()
    }
    original_project = Path(jobs[0]["project_dir"]).resolve()
    seen = {"assets": None, "project_dir": None}

    def fake_run(command, *_args, **_kwargs):
        snapshot = json.loads(Path(command[-1]).read_text(encoding="utf-8"))
        seen["assets"] = {
            face: Path(path).resolve() for face, path in snapshot["assets"].items()
        }
        seen["project_dir"] = Path(snapshot["project_dir"]).resolve()
        for key, raw in snapshot["outputs"].items():
            dest = Path(raw)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if key == "glb":
                dest.write_bytes(b"glTF" + b"\x02\x00\x00\x00\x0c\x00\x00\x00")
            elif key == "blend":
                dest.write_bytes(b"BLENDER-v293")
            else:
                Image.new("RGB", (8, 8), (4, 5, 6)).save(dest)
        pipeline.save_json(
            Path(snapshot["project_dir"]) / "blender_result.json",
            blender_measurement_result(snapshot),
        )
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    rendered = pipeline.run_blender_relight(jobs[0], tmp_path / "missing-blender")
    assert seen["assets"] == original_assets
    assert seen["project_dir"] != original_project
    assert Path(rendered["outputs"]["front_right"]).is_file()
    assert Path(rendered["outputs"]["front_right"]).parent == original_project
