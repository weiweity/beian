"""RF-08 projection Jacobian sampling and face pixel budget."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from PIL import Image
import pymupdf
import pytest

from test_packaging_render_contract import carton_job, contract_module
from test_packaging_structure_artwork import artwork_pdf, resolved_fixture


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
if str(PACKAGING) not in sys.path:
    sys.path.insert(0, str(PACKAGING))

from camera_frame import (  # noqa: E402
    FACE_AXES,
    blender_camera_axes,
    face_jacobian_ppm,
    face_source_point,
    face_world_point,
    ortho_frustum_mm,
    project_face_sampling,
    resolved_shot_camera,
    rotate_z,
)
from render_geometry import _source_point  # noqa: E402
from structure_v2 import ArtworkMappingError, render_face_assets  # noqa: E402


FACES = ("front", "right", "back", "left", "top", "bottom")
EXPERIMENTAL_REGISTRY = PACKAGING / "profiles" / "experiments" / "rf08-projection-sampling.v1.json"
PROFILE_ID = "packshot-projection-sampling-v1"
CUBE = {"width": 80.0, "depth": 80.0, "height": 80.0}
TALL = {"width": 40.0, "depth": 40.0, "height": 180.0}
WIDE = {"width": 160.0, "depth": 40.0, "height": 30.0}
SKINNY = {"width": 20.0, "depth": 120.0, "height": 40.0}
WHITE = {"width": 47.5, "depth": 47.5, "height": 177.5}


def dimension_fit_shots(**overrides) -> dict:
    shots = {
        "projection": "ORTHOGRAPHIC",
        "master_resolution_px": [3000, 3600],
        "views": ["front_right", "back_left"],
        "camera_mode": "dimension-fit",
        "camera_ortho_scale_mm": None,
        "front_rotation_deg": 0.0,
        "back_rotation_deg": 180.0,
    }
    shots.update(overrides)
    return shots


def sampling_limits(**overrides) -> dict:
    payload = {
        "strategy": "projection-jacobian-v1",
        "minimum_face_pixels_per_mm": 20.0,
        "maximum_face_pixels_per_mm": 64.0,
        "maximum_face_pixels": 32_000_000,
        "oversample_ratio": 1.5,
        "legacy_raster_width_px": 10000,
    }
    payload.update(overrides)
    return payload


def experimental_plan(dimensions: dict, profile_id: str = PROFILE_ID):
    contract = contract_module()
    return contract.render_plan_for_experimental_projection_job(
        carton_job(dimensions=dimensions),
        profile_id,
    )


def test_face_basis_matches_render_geometry_source_point():
    sizes = (47.5, 47.5, 177.5)
    for face in FACES:
        for u, v in ((0.0, 0.0), (0.5, 0.5), (1.0, 0.25)):
            assert face_source_point(face, u, v, *sizes) == pytest.approx(
                _source_point(face, u, v, sizes)
            )


def test_two_shots_take_max_projected_ppm_per_face():
    report = project_face_sampling(WHITE, dimension_fit_shots(), sampling_limits())
    front = report["faces"]["front"]
    back = report["faces"]["back"]
    assert front["projected_max_ppm"] == max(
        front["shots"]["front_right"]["projected_max_ppm"],
        front["shots"]["back_left"]["projected_max_ppm"],
    )
    assert back["projected_max_ppm"] == max(
        back["shots"]["front_right"]["projected_max_ppm"],
        back["shots"]["back_left"]["projected_max_ppm"],
    )
    turned = project_face_sampling(
        WIDE,
        dimension_fit_shots(back_rotation_deg=45.0),
        sampling_limits(),
    )
    assert (
        turned["faces"]["front"]["shots"]["front_right"]["projected_max_ppm"]
        != turned["faces"]["front"]["shots"]["back_left"]["projected_max_ppm"]
    )
    assert turned["faces"]["front"]["projected_max_ppm"] == max(
        turned["faces"]["front"]["shots"]["front_right"]["projected_max_ppm"],
        turned["faces"]["front"]["shots"]["back_left"]["projected_max_ppm"],
    )
    assert front["projected_min_ppm"] <= front["projected_max_ppm"]
    for face in FACES:
        assert face in report["per_face_target_pixels_per_mm"]
        row = report["faces"][face]
        expected = max(
            20.0,
            row["projected_max_ppm"] * 1.5,
        )
        assert row["untruncated_target_ppm"] == pytest.approx(round(expected, 6))


@pytest.mark.parametrize("dimensions", [CUBE, TALL, WIDE, SKINNY, WHITE])
def test_jacobian_changes_with_box_aspect(dimensions: dict):
    cube = project_face_sampling(CUBE, dimension_fit_shots(), sampling_limits())
    other = project_face_sampling(dimensions, dimension_fit_shots(), sampling_limits())
    if dimensions == CUBE:
        assert other["faces"]["front"]["projected_max_ppm"] == pytest.approx(
            cube["faces"]["front"]["projected_max_ppm"]
        )
        return
    assert other["per_face_target_pixels_per_mm"] != cube["per_face_target_pixels_per_mm"]


def test_output_resolution_and_camera_scale_change_sampling_demand():
    base = project_face_sampling(WHITE, dimension_fit_shots(), sampling_limits())
    denser = project_face_sampling(
        WHITE,
        dimension_fit_shots(master_resolution_px=[6000, 7200]),
        sampling_limits(),
    )
    assert denser["faces"]["front"]["projected_max_ppm"] == pytest.approx(
        base["faces"]["front"]["projected_max_ppm"] * 2.0, rel=1e-6
    )
    pinned = project_face_sampling(
        WHITE,
        dimension_fit_shots(
            camera_mode="legacy-pinned",
            camera_ortho_scale_mm=400.0,
        ),
        sampling_limits(),
    )
    assert pinned["faces"]["front"]["projected_max_ppm"] != pytest.approx(
        base["faces"]["front"]["projected_max_ppm"]
    )


def test_illegal_basis_and_non_finite_values_fail_closed():
    with pytest.raises(ValueError):
        project_face_sampling(
            {"width": 0.0, "depth": 40.0, "height": 40.0},
            dimension_fit_shots(),
            sampling_limits(),
        )
    with pytest.raises(ValueError):
        project_face_sampling(
            {"width": float("nan"), "depth": 40.0, "height": 40.0},
            dimension_fit_shots(),
            sampling_limits(),
        )
    with pytest.raises(ValueError):
        project_face_sampling(
            WHITE,
            dimension_fit_shots(views=["side_mystery"]),
            sampling_limits(),
        )


def test_untruncated_demand_records_required_and_allowed_without_clamping():
    report = project_face_sampling(
        {"width": 400.0, "depth": 400.0, "height": 400.0},
        dimension_fit_shots(master_resolution_px=[8000, 9600]),
        sampling_limits(),
    )
    assert report["budget_violations"]
    for row in report["budget_violations"]:
        assert row["required_pixels_per_mm"] > row["allowed_pixels_per_mm"] or (
            row["required_pixels"] > row["allowed_pixels"]
        )
        assert row["required_pixels"] == row["required_size_px"][0] * row["required_size_px"][1]
        assert "projected_max_ppm" in row


def test_experimental_profile_resolves_projection_targets_not_minimum_floor():
    plan = experimental_plan(WHITE)
    sampling = plan["sampling"]
    assert sampling["strategy"] == "projection-jacobian-v1"
    assert sampling["oversample_ratio"] == 1.5
    expected = project_face_sampling(
        WHITE,
        plan["spec"]["shots"],
        sampling,
    )
    assert sampling["per_face_target_pixels_per_mm"] == expected["per_face_target_pixels_per_mm"]
    assert any(
        value != sampling["minimum_face_pixels_per_mm"]
        for value in sampling["per_face_target_pixels_per_mm"].values()
    )
    assert plan["projection"]["faces"]["front"]["projected_max_ppm"] > 0
    identity = contract_module().render_plan_for_new_job(
        carton_job(dimensions=WHITE),
        "compat-legacy-v0",
    )
    assert identity["sampling"]["strategy"] == "minimum-floor-v1"
    assert set(identity["sampling"]["per_face_target_pixels_per_mm"].values()) == {20.0}
    assert identity["fingerprint_token"] != plan["fingerprint_token"]


def test_production_registry_does_not_register_projection_profile():
    contract = contract_module()
    registry = contract.load_profile_registry()
    assert PROFILE_ID not in registry["profiles"]
    assert list(registry["profiles"]) == [
        "compat-legacy-v0",
        "packshot-neutral-v1",
        "smoke-v1",
        "packshot-f-v1",
        "packshot-carton-geometry-v1",
    ]


def test_projection_budget_exceeded_returns_required_allowed_before_artwork(tmp_path: Path):
    contract = contract_module()
    huge = carton_job(dimensions={"width": 500.0, "depth": 500.0, "height": 500.0})
    with pytest.raises(contract.RenderContractError) as raised:
        contract.render_plan_for_experimental_projection_job(huge, PROFILE_ID)
    assert raised.value.code == "render_texture_budget_exceeded"
    details = raised.value.details
    assert details["required_pixels"] > details["allowed_pixels"]
    assert details["allowed_pixels"] == 32_000_000
    assert "required_size_px" in details
    assert not (tmp_path / "assets").exists()


def test_projection_does_not_silently_clamp_to_maximum_ppm():
    contract = contract_module()
    tiny = {"width": 10.0, "depth": 10.0, "height": 10.0}
    demand = project_face_sampling(tiny, dimension_fit_shots(), sampling_limits())
    assert demand["budget_violations"]
    assert demand["budget_violations"][0]["required_pixels_per_mm"] == 67.5
    assert demand["budget_violations"][0]["allowed_pixels_per_mm"] == 64.0
    with pytest.raises(contract.RenderContractError) as raised:
        contract.render_plan_for_experimental_projection_job(
            carton_job(dimensions=tiny),
            PROFILE_ID,
        )
    assert raised.value.code == "render_texture_budget_exceeded"
    assert raised.value.details["required_pixels_per_mm"] == 67.5
    assert raised.value.details["allowed_pixels_per_mm"] == 64.0
    assert raised.value.details["required_pixels_per_mm"] != 64.0


def test_projection_artwork_uses_per_face_targets_and_one_affine(tmp_path: Path, monkeypatch):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    resolved = resolved_fixture()
    targets = {face: 20.0 for face in FACES}
    projection = project_face_sampling(
        resolved["dimensions_mm"],
        dimension_fit_shots(),
        sampling_limits(),
    )
    affine_calls = {"count": 0}
    original = Image.Image.transform

    def counted(self, *args, **kwargs):
        affine_calls["count"] += 1
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "transform", counted)
    destination = tmp_path / "assets"
    report: dict = {}
    sizes = render_face_assets(
        source,
        resolved,
        destination,
        sampling_strategy="projection-jacobian-v1",
        face_target_pixels_per_mm=targets,
        max_raster_pixels=32_000_000,
        projection=projection,
        sampling_report=report,
    )
    for face, size in sizes.items():
        width_mm = float(resolved["dimensions_mm"][FACE_AXES[face][0]])
        height_mm = float(resolved["dimensions_mm"][FACE_AXES[face][1]])
        assert size[0] >= math.ceil(width_mm * targets[face]) - 1
        assert size[1] >= math.ceil(height_mm * targets[face]) - 1
        row = report["faces"][face]
        assert row["source_ppm"] >= targets[face] - 1e-6
        assert row["target_ppm"] == pytest.approx(targets[face])
        assert row["resample_count"] in {1, 2}
        assert row["projected_max_ppm"] == projection["faces"][face]["projected_max_ppm"]
        assert row["projected_min_ppm"] == projection["faces"][face]["projected_min_ppm"]
    assert affine_calls["count"] % 6 == 0
    assert 6 <= affine_calls["count"] <= 12
    assert report["strategy"] == "projection-jacobian-v1"


def test_projection_artwork_failure_does_not_leave_mixed_faces(tmp_path: Path, monkeypatch):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    resolved = resolved_fixture()
    destination = tmp_path / "assets"
    destination.mkdir()
    stale = destination / "panel_front.png"
    Image.new("RGBA", (8, 8), (9, 9, 9, 255)).save(stale)
    calls = {"n": 0}
    original = pymupdf.Page.get_pixmap

    def fail_after_first(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] > 1:
            raise RuntimeError("boom")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(pymupdf.Page, "get_pixmap", fail_after_first)
    with pytest.raises((ArtworkMappingError, RuntimeError)):
        render_face_assets(
            source,
            resolved,
            destination,
            sampling_strategy="projection-jacobian-v1",
            face_target_pixels_per_mm={face: 20.0 for face in FACES},
        )
    written = list(destination.glob("panel_*.png"))
    assert written == [stale]
    assert Image.open(stale).size == (8, 8)


def test_projection_artwork_does_not_allocate_over_budget(tmp_path: Path, monkeypatch):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    resolved = resolved_fixture()
    monkeypatch.setattr(pymupdf.Page, "get_pixmap", lambda *_args, **_kwargs: pytest.fail("allocated"))
    with pytest.raises(ArtworkMappingError) as raised:
        render_face_assets(
            source,
            resolved,
            tmp_path / "assets",
            sampling_strategy="projection-jacobian-v1",
            face_target_pixels_per_mm={face: 64.0 for face in FACES},
            max_raster_pixels=65_536,
        )
    assert raised.value.code == "render_texture_budget_exceeded"
    assert raised.value.details["required_pixels"] > raised.value.details["allowed_pixels"]
    assert not (tmp_path / "assets").exists() or not list((tmp_path / "assets").glob("panel_*.png"))


def test_projection_artwork_uses_heterogeneous_per_face_targets(tmp_path: Path):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    resolved = resolved_fixture()
    targets = {face: 20.0 for face in FACES}
    targets["front"] = 32.0
    sizes = render_face_assets(
        source,
        resolved,
        tmp_path / "assets",
        sampling_strategy="projection-jacobian-v1",
        face_target_pixels_per_mm=targets,
        max_raster_pixels=32_000_000,
    )
    width_mm = float(resolved["dimensions_mm"]["width"])
    height_mm = float(resolved["dimensions_mm"]["height"])
    assert sizes["front"][0] >= math.ceil(width_mm * 32.0) - 1
    assert sizes["front"][1] >= math.ceil(height_mm * 32.0) - 1
    top_w = float(resolved["dimensions_mm"][FACE_AXES["top"][0]])
    assert sizes["front"][0] > math.ceil(top_w * 20.0)


def test_tampered_projection_targets_fail_closed_after_rehash():
    contract = contract_module()
    plan = experimental_plan(WHITE)
    spec = json.loads(json.dumps(plan["spec"]))
    spec["sampling"]["per_face_target_pixels_per_mm"]["front"] = spec["sampling"][
        "minimum_face_pixels_per_mm"
    ]
    spec["render_contract_hash"] = contract.render_contract_sha256(spec)
    with pytest.raises(contract.RenderContractError) as raised:
        contract.validate_render_spec(spec, registry_path=EXPERIMENTAL_REGISTRY)
    assert raised.value.code == "render_contract_invalid"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"sampling_strategy": "not-a-strategy", "face_target_pixels_per_mm": {face: 20.0 for face in FACES}},
        {"sampling_strategy": "projection-jacobian-v1", "face_target_pixels_per_mm": {"front": 20.0}},
        {"sampling_strategy": "projection-jacobian-v1", "face_target_pixels_per_mm": {face: True for face in FACES}},
        {"sampling_strategy": "projection-jacobian-v1", "face_target_pixels_per_mm": {face: float("nan") for face in FACES}},
    ],
)
def test_projection_artwork_rejects_invalid_strategy_and_targets(tmp_path: Path, kwargs):
    with pytest.raises(ArtworkMappingError) as raised:
        render_face_assets(
            artwork_pdf(tmp_path / "a.pdf"),
            resolved_fixture(),
            tmp_path / "assets",
            **kwargs,
        )
    assert raised.value.code == "structure_limit_exceeded"


def test_empty_views_and_undersized_oversample_fail_closed():
    with pytest.raises(ValueError):
        project_face_sampling(WHITE, dimension_fit_shots(views=[]), sampling_limits())
    with pytest.raises(ValueError):
        project_face_sampling(WHITE, dimension_fit_shots(), sampling_limits(oversample_ratio=0.5))


def test_promote_interrupt_restores_previous_generation(tmp_path: Path, monkeypatch):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    resolved = resolved_fixture()
    destination = tmp_path / "assets"
    targets = {face: 20.0 for face in FACES}
    render_face_assets(
        source,
        resolved,
        destination,
        sampling_strategy="projection-jacobian-v1",
        face_target_pixels_per_mm=targets,
    )
    original = {path.name: path.read_bytes() for path in sorted(destination.glob("panel_*.png"))}
    assert len(original) == 6
    real_replace = os.replace
    seen = {"n": 0}

    def wrapped(src, dst, *args, **kwargs):
        dest = Path(dst)
        if dest.parent == destination and dest.name.startswith("panel_") and dest.suffix == ".png":
            seen["n"] += 1
            if seen["n"] == 2:
                raise PermissionError("injected promote failure")
        return real_replace(src, dst, *args, **kwargs)

    monkeypatch.setattr(os, "replace", wrapped)
    with pytest.raises(PermissionError):
        render_face_assets(
            source,
            resolved,
            destination,
            sampling_strategy="projection-jacobian-v1",
            face_target_pixels_per_mm=targets,
        )
    restored = {path.name: path.read_bytes() for path in sorted(destination.glob("panel_*.png"))}
    assert restored == original
    assert list(destination.glob(".face-staging-*")) == []
    assert list(destination.glob(".face-backup-*")) == []


def test_legacy_profile_still_uses_minimum_floor_and_old_hash():
    contract = contract_module()
    registry = contract.load_profile_registry()
    assert (
        registry["profiles"]["compat-legacy-v0"]["declared_sha256"]
        == "sha256:abf8256356f1d6d7b780411cc9210a195e1253ae304e0aceb1bcba0fe672aab4"
    )
    spec = contract.resolve_render_spec(carton_job(), "compat-legacy-v0", {})
    assert spec["sampling"]["strategy"] == "minimum-floor-v1"
    assert spec["sampling"]["per_face_target_pixels_per_mm"]["front"] == 20.0


def test_projection_contract_change_is_a_cache_identity_change():
    contract = contract_module()
    projection = experimental_plan(WHITE)
    legacy = contract.render_plan_for_new_job(carton_job(dimensions=WHITE), "compat-legacy-v0")
    assert projection["identity"]["render_contract_hash"] != legacy["identity"]["render_contract_hash"]
    denser = project_face_sampling(
        WHITE,
        {**projection["spec"]["shots"], "master_resolution_px": [4000, 4800]},
        projection["sampling"],
    )
    assert denser["per_face_target_pixels_per_mm"] != projection["sampling"]["per_face_target_pixels_per_mm"]


def test_ortho_frustum_uses_largest_render_edge():
    assert ortho_frustum_mm(224.0, 3000, 3600) == pytest.approx(
        (224.0 * 3000 / 3600, 224.0)
    )
    assert ortho_frustum_mm(224.0, 3600, 3000) == pytest.approx(
        (224.0, 224.0 * 3000 / 3600)
    )


@pytest.mark.native
def test_native_blender_camera_matches_python_framing_and_records_sampling(tmp_path: Path):
    blender = shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender"
    assert Path(blender).exists(), "explicit native check needs Blender"
    plan = experimental_plan(WHITE)
    shots = plan["spec"]["shots"]
    python_cam = resolved_shot_camera(
        WHITE["width"],
        WHITE["depth"],
        WHITE["height"],
        math.radians(float(shots["front_rotation_deg"])),
        shots,
    )
    script = tmp_path / "probe_camera.py"
    out = tmp_path / "probe_camera.json"
    script.write_text(
        "import json, math, sys\n"
        f"sys.path.insert(0, {str(PACKAGING)!r})\n"
        "from camera_frame import camera_location_mm, camera_target_mm, camera_ortho_scale_mm, aabb_after_z_rotation\n"
        "import bpy\n"
        "from mathutils import Vector\n"
        "w,d,h=47.5,47.5,177.5\n"
        "yaw=0.0\n"
        "sw,sd,sh=aabb_after_z_rotation(w,d,h,yaw)\n"
        "loc=camera_location_mm(sw,sd,sh)\n"
        "target=camera_target_mm(sw,sd,sh)\n"
        "scale=camera_ortho_scale_mm(sw,sd,sh)\n"
        "bpy.ops.object.camera_add(location=loc)\n"
        "cam=bpy.context.object\n"
        "cam.data.type='ORTHO'\n"
        "cam.data.ortho_scale=scale\n"
        "direction=Vector(target)-cam.location\n"
        "cam.rotation_euler=direction.to_track_quat('-Z','Y').to_euler()\n"
        "bpy.context.view_layer.update()\n"
        "mw=list(cam.matrix_world)\n"
        "json.dump({'location':list(cam.location),'ortho_scale':float(cam.data.ortho_scale),"
        "'blender':bpy.app.version_string,'matrix':[list(row) for row in mw]}, open("
        f"{str(out)!r}, 'w'))\n",
        encoding="utf-8",
    )
    started = time.perf_counter()
    completed = subprocess.run(
        [blender, "--background", "--factory-startup", "--python-exit-code", "1", "--python", str(script)],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    elapsed = time.perf_counter() - started
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["ortho_scale"] == pytest.approx(python_cam["ortho_scale_mm"])
    assert payload["location"] == pytest.approx(python_cam["location_mm"], rel=1e-5, abs=1e-5)
    x_axis, y_axis, z_axis = blender_camera_axes(python_cam["location_mm"], python_cam["target_mm"])
    matrix = payload["matrix"]
    assert [matrix[0][0], matrix[1][0], matrix[2][0]] == pytest.approx(x_axis, rel=1e-4, abs=1e-4)
    assert [matrix[0][1], matrix[1][1], matrix[2][1]] == pytest.approx(y_axis, rel=1e-4, abs=1e-4)
    assert [matrix[0][2], matrix[1][2], matrix[2][2]] == pytest.approx(z_axis, rel=1e-4, abs=1e-4)
    native_receipt = tmp_path / "rf08-native-camera.json"
    native_receipt.write_text(
        json.dumps(
            {
                "blender_version": payload["blender"],
                "contract_hash": plan["identity"]["render_contract_hash"],
                "ortho_scale_mm": payload["ortho_scale"],
                "elapsed_s": round(elapsed, 3),
                "python_targets": plan["sampling"]["per_face_target_pixels_per_mm"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    assert native_receipt.stat().st_size > 0


@pytest.mark.native
def test_native_blender_records_projection_sampling_and_output_metrics(tmp_path: Path):
    blender = shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender"
    assert Path(blender).exists(), "explicit native check needs Blender"
    plan = experimental_plan(WHITE)
    assets = {}
    for face, axes in FACE_AXES.items():
        ppm = plan["sampling"]["per_face_target_pixels_per_mm"][face]
        width_px = max(8, math.ceil(WHITE[axes[0]] * ppm))
        height_px = max(8, math.ceil(WHITE[axes[1]] * ppm))
        path = tmp_path / "assets" / f"panel_{face}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGBA", (width_px, height_px), (40, 80, 120, 255)).save(path)
        assets[face] = str(path)
    job = {
        **carton_job(dimensions=WHITE),
        "code": "synthetic-rf08",
        "slug": "projection",
        "display_name": "synthetic-rf08",
        "source_ai": "SYNTHETIC_NOT_CUSTOMER",
        "project_dir": str(tmp_path),
        "assets": assets,
        "glb_tolerance_mm": 0.5,
        "render_spec": plan["spec"],
        "render": plan["render"],
        "face_sampling": {
            "strategy": plan["sampling"]["strategy"],
            "faces": plan["projection"]["faces"],
        },
        "execution_nonce": "rf08-native",
        **plan["identity"],
        "outputs": {
            "glb": str(tmp_path / "box.glb"),
            "blend": str(tmp_path / "box.blend"),
            "front_right": str(tmp_path / "front_right.png"),
            "back_left": str(tmp_path / "back_left.png"),
        },
    }
    job_path = tmp_path / "job.json"
    job_path.write_text(json.dumps(job), encoding="utf-8")
    started = time.perf_counter()
    completed = subprocess.run(
        [
            blender,
            "--background",
            "--factory-startup",
            "--python-exit-code",
            "1",
            "--python",
            str(PACKAGING / "blender" / "render_job.py"),
            "--",
            str(job_path),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    elapsed = time.perf_counter() - started
    assert completed.returncode == 0, (completed.stdout + completed.stderr)[-4000:]
    result = json.loads((tmp_path / "blender_result.json").read_text(encoding="utf-8"))
    assert result["execution_nonce"] == "rf08-native"
    assert result["face_sampling"]["strategy"] == "projection-jacobian-v1"
    assert result["master_resolution_px"] == [3000, 3600]
    assert result["view_transform"] == "Standard"
    front = Image.open(tmp_path / "front_right.png")
    back = Image.open(tmp_path / "back_left.png")
    assert front.size == (3000, 3600)
    assert back.size == (3000, 3600)
    receipt = {
        "blender_version": result["blender_version"],
        "engine": result["engine"],
        "contract_hash": plan["identity"]["render_contract_hash"],
        "samples": result["samples"],
        "pixel_filter": result["pixel_filter"],
        "master_resolution_px": result["master_resolution_px"],
        "elapsed_s": round(elapsed, 3),
        "blender_elapsed_s": result["blender_elapsed_s"],
        "front_right_bytes": (tmp_path / "front_right.png").stat().st_size,
        "back_left_bytes": (tmp_path / "back_left.png").stat().st_size,
        "glb_bytes": (tmp_path / "box.glb").stat().st_size,
        "targets": plan["sampling"]["per_face_target_pixels_per_mm"],
    }
    (tmp_path / "rf08-native-render.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    assert receipt["front_right_bytes"] > 10_000
    assert receipt["glb_bytes"] > 1_000

