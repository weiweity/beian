"""RF07 studio contract and controlled colour experiment behaviour."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import importlib.util
import inspect
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

from PIL import Image
import pytest

from test_packaging_render_contract import (
    carton_job,
    contract_module,
    refresh_profile_hash,
    write_registry,
)
from test_packaging_render_materials import (
    PUBLISHED_PROFILE_SHA256,
)
from test_packaging_studio_contract import VectorStub, apply_contract, studio_lights
from test_packaging_render_quality_experiment import FakeScene, complete_pass, fake_lights, write_still


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
DRIVER_PATH = PACKAGING / "tools" / "render_quality_color_experiment.py"
WRAPPER_PATH = PACKAGING / "tools" / "render_quality_color_experiment_blender.py"
EXPERIMENTAL_STUDIO_REGISTRY = PACKAGING / "profiles" / "experiments" / "rf07-studio-color.v1.json"
RF06_PROFILE = PACKAGING / "profiles" / "experiments" / "rf06-materials.v1.json"
F_PROFILE_ID = "packshot-f-v1"
EXPLICIT_STUDIO = "normalized-three-area-explicit-v1"
CANDIDATES = ("Standard", "Khronos PBR Neutral", "AgX")
FIXTURES = ("rf00-white-carton", "rf00-dark-carton", "rf00-tall-carton", "rf00-wide-carton")
TALL = {"width": 40.0, "depth": 40.0, "height": 180.0}
WIDE = {"width": 100.0, "depth": 50.0, "height": 30.0}
WHITE = {"width": 47.5, "depth": 47.5, "height": 177.5}
DARK = {"width": 47.5, "depth": 47.5, "height": 177.5}


def complete_fixed_scene(**overrides) -> dict:
    payload = {
        "meshes": [
            {
                "name": "Box_Core",
                "geometry_sha256": {"status": "measured", "value": "a" * 64, "method": "mesh vertices/polygons"},
                "uv_sha256": {
                    "status": "unavailable",
                    "reason": "core_has_no_uv",
                    "method": "mesh.uv_layers",
                },
                "vertex_count": {"status": "measured", "value": 8, "method": "mesh.vertices", "unit": "1"},
            },
            {
                "name": "front",
                "geometry_sha256": {"status": "measured", "value": "b" * 64, "method": "mesh vertices/polygons"},
                "uv_sha256": {"status": "measured", "value": "c" * 64, "method": "mesh.uv_layers"},
                "vertex_count": {"status": "measured", "value": 4, "method": "mesh.vertices", "unit": "1"},
            },
        ],
        "materials": [
            {
                "name": "MAT_front",
                "nodes": [
                    {
                        "name": "Principled BSDF",
                        "type": "ShaderNodeBsdfPrincipled",
                        "inputs": {
                            "Coat Weight": 0.0,
                            "Roughness": 0.52,
                            "Coat Weight_linked": False,
                        },
                    },
                    {
                        "name": "Normal Map",
                        "type": "ShaderNodeNormalMap",
                        "inputs": {"Strength": 0.12, "Strength_linked": False},
                    },
                    {
                        "name": "Image Texture",
                        "type": "ShaderNodeTexImage",
                        "image": {"sha256": "d" * 64, "color_space": "sRGB", "packed": True},
                    },
                ],
                "links": [["Image Texture", "Color", "Principled BSDF", "Base Color"]],
            }
        ],
        "seed": {
            "status": "unavailable",
            "reason": "eevee_has_no_sampling_seed",
            "method": "scene.eevee seed/hash_offset",
        },
        "frame": {
            "current": {"status": "measured", "value": 1, "method": "scene.frame_current"},
            "subframe": {"status": "measured", "value": 0.0, "method": "scene.frame_subframe"},
        },
    }
    payload.update(overrides)
    return payload


def complete_rf07_pass(candidate: str, key: str = "front_right") -> dict:
    payload = complete_pass(key, "d" * 64, "nonce")
    payload["candidate"] = candidate
    payload["variant"] = candidate
    payload["output_key"] = key
    payload["render"]["view_transform"] = {
        "status": "measured",
        "value": candidate,
        "method": "view_settings.view_transform",
    }
    payload["fixed_scene"] = complete_fixed_scene()
    payload["pass_complete"] = True
    payload["lights_contract_ok"] = True
    return payload


class FakeWorldColor:
    def __init__(self, rgba=(1.0, 1.0, 1.0, 1.0)):
        self.type = "BACKGROUND"
        self.inputs = {"Color": SimpleNamespace(default_value=list(rgba))}


def fake_world(rgb=(1.0, 1.0, 1.0)):
    return SimpleNamespace(
        color=tuple(rgb),
        use_nodes=True,
        node_tree=SimpleNamespace(nodes=[FakeWorldColor((*rgb, 1.0))]),
    )


def driver_module():
    spec = importlib.util.spec_from_file_location("packaging_rf07_driver_test", DRIVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wrap_module():
    spec = importlib.util.spec_from_file_location("packaging_rf07_wrap_test", WRAPPER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def explicit_studio_block() -> dict:
    return {
        "profile": EXPLICIT_STUDIO,
        "projection": "ORTHOGRAPHIC",
        "master_resolution_px": [3000, 3600],
        "views": ["front_right", "back_left"],
        "camera_mode": "dimension-fit",
        "camera_ortho_scale_mm": None,
        "front_rotation_deg": 0,
        "back_rotation_deg": 180,
        "world_strength": 0.62,
        "light_energy_scale": 4,
        "exact_white_background": True,
        "rig_reference_mm": 180.0,
        "fill_energy_multiplier": 0.35,
        "key_elevation_delta_deg": -15.0,
        "reference_target_mm": [0.0, 0.0, 90.0],
        "camera_space_shots": True,
        "world_hdri": False,
        "world_color": [1.0, 1.0, 1.0],
        "lights": {
            "key": {
                "name": "Key softbox",
                "location_mm": [-135.0, -190.0, 275.0],
                "type": "AREA",
                "shape": "RECTANGLE",
                "size_mm": 120.0,
                "size_y_mm": 150.0,
                "energy_base": 105000.0,
                "energy_ratio": 1.0,
            },
            "fill": {
                "name": "Fill softbox",
                "location_mm": [155.0, -120.0, 175.0],
                "type": "AREA",
                "shape": "SQUARE",
                "size_mm": 110.0,
                "energy_base": 62000.0,
                "energy_ratio": 0.35,
            },
            "rim": {
                "name": "Rim softbox",
                "location_mm": [-90.0, 210.0, 280.0],
                "type": "AREA",
                "shape": "RECTANGLE",
                "size_mm": 70.0,
                "size_y_mm": 1.0,
                "energy_base": 72000.0,
                "energy_ratio": 1.0,
            },
        },
    }


def studio_candidate_profile(profile_id: str = "packshot-studio-explicit-v1") -> dict:
    rf06 = json.loads(RF06_PROFILE.read_text(encoding="utf-8"))
    white = deepcopy(next(item for item in rf06["profiles"] if item["id"] == "packshot-material-white-none-v1"))
    white.pop("profile_sha256", None)
    white["id"] = profile_id
    white["renderer"]["shadow_pool_size_mb"] = 1024
    white["studio"] = explicit_studio_block()
    return white


def signed_studio_registry(contract, profiles: list[dict], path: Path) -> Path:
    payload = {"schema": "packaging-render-profile-registry/1", "profiles": []}
    for profile in profiles:
        signed = deepcopy(profile)
        refresh_profile_hash(contract, signed)
        payload["profiles"].append(signed)
    return write_registry(path, payload)


def test_rf06_and_published_identities_stay_byte_identical():
    contract = contract_module()
    production = contract.load_profile_registry()
    assert hashlib.sha256(RF06_PROFILE.read_bytes()).hexdigest() == (
        "e4570c46c0cc3d479c3746585c97149316b3ce413db348fb0c3bd74c57253873"
    )
    for profile_id, digest in PUBLISHED_PROFILE_SHA256.items():
        assert production["profiles"][profile_id]["profile_sha256"] == digest
    f_studio = production["profiles"][F_PROFILE_ID]["studio"]
    assert f_studio["profile"] == "normalized-three-area-f-v1"
    assert set(f_studio) == {
        "profile",
        "projection",
        "master_resolution_px",
        "views",
        "camera_mode",
        "camera_ortho_scale_mm",
        "front_rotation_deg",
        "back_rotation_deg",
        "world_strength",
        "light_energy_scale",
        "exact_white_background",
        "rig_reference_mm",
        "fill_energy_multiplier",
        "key_elevation_delta_deg",
    }
    assert "lights" not in f_studio
    assert production["profiles"][F_PROFILE_ID]["color"]["view_transform"] == "Standard"
    assert "packshot-studio-explicit-v1" not in production["profiles"]


def test_legacy_and_f_profiles_reject_explicit_light_fields():
    contract = contract_module()
    legacy = contract.load_profile_registry()["profiles"]["compat-legacy-v0"]["studio"].copy()
    legacy["lights"] = explicit_studio_block()["lights"]
    with pytest.raises(contract.RenderContractError, match="旧灯光不得携带"):
        contract._normalize_studio(legacy, "studio")
    f_studio = contract.load_profile_registry()["profiles"][F_PROFILE_ID]["studio"].copy()
    f_studio["world_hdri"] = False
    with pytest.raises(contract.RenderContractError, match="旧灯光不得携带"):
        contract._normalize_studio(f_studio, "studio")


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (lambda studio: studio.pop("lights"), "显式棚光缺少合同字段"),
        (lambda studio: studio.pop("reference_target_mm"), "显式棚光缺少合同字段"),
        (lambda studio: studio.pop("world_hdri"), "显式棚光缺少合同字段"),
        (lambda studio: studio.update(world_hdri=True), "显式棚光禁止 HDRI"),
        (lambda studio: studio.update(camera_space_shots=False), "正反 shot 必须保持相机空间灯位"),
        (lambda studio: studio["lights"].pop("rim"), "显式棚光必须声明 key/fill/rim"),
        (
            lambda studio: studio["lights"].update(key=studio["lights"]["key"] | {"energy_ratio": 0.5}),
            "key/rim 能量比必须为 1",
        ),
        (
            lambda studio: studio["lights"]["fill"].update(energy_ratio=1.0),
            "fill 能量比必须等于 fill_energy_multiplier",
        ),
        (lambda studio: studio.update(sku="white-box"), r"未知字段：sku"),
        (lambda studio: studio.update(artwork_mean_rgb=[0.9, 0.9, 0.9]), r"未知字段：artwork_mean_rgb"),
    ],
    ids=(
        "missing-lights",
        "missing-reference-target",
        "missing-world-hdri",
        "world-hdri-enabled",
        "camera-space-disabled",
        "missing-rim",
        "key-energy-ratio",
        "fill-energy-ratio",
        "sku-content-route",
        "artwork-mean-content-route",
    ),
)
def test_explicit_studio_rejects_missing_illegal_or_content_routed_fields(tmp_path, mutate, match):
    contract = contract_module()
    studio = explicit_studio_block()
    mutate(studio)
    with pytest.raises(contract.RenderContractError, match=match) as raised:
        contract._normalize_studio(studio, "studio")
    assert raised.value.code == "render_contract_invalid"
    assert "声明 hash" not in str(raised.value)
    assert raised.value.details.get("field") != "studio.declared_sha256"

    profile = studio_candidate_profile()
    refresh_profile_hash(contract, profile)
    original_declared = profile["declared_sha256"]
    mutate(profile["studio"])
    path = tmp_path / "bad-studio.json"
    write_registry(path, {"schema": "packaging-render-profile-registry/1", "profiles": [profile]})
    with pytest.raises(contract.RenderContractError, match=match) as loaded:
        contract.load_profile_registry(path)
    assert loaded.value.code == "render_contract_invalid"
    assert "声明 hash" not in str(loaded.value)
    assert original_declared.startswith("sha256:")


def test_scaled_lights_are_size_only_and_ignore_artwork_color():
    contract = contract_module()
    studio = contract._normalize_studio(explicit_studio_block(), "studio")
    signature = inspect.signature(contract.scaled_explicit_studio_lights)
    assert "color" not in signature.parameters
    assert "sku" not in signature.parameters
    assert "layer" not in signature.parameters
    tall = contract.scaled_explicit_studio_lights(studio, TALL)
    wide = contract.scaled_explicit_studio_lights(studio, WIDE)
    white = contract.scaled_explicit_studio_lights(studio, WHITE)
    dark = contract.scaled_explicit_studio_lights(studio, DARK)
    assert white == dark
    assert tall["scale"] == pytest.approx(1.0)
    assert wide["scale"] == pytest.approx(100.0 / 180.0)
    key_ref = studio["lights"]["key"]
    fill_ref = studio["lights"]["fill"]
    rim_ref = studio["lights"]["rim"]
    assert tall["lights"]["fill"]["location_mm"] == pytest.approx(fill_ref["location_mm"])
    assert tall["lights"]["rim"]["location_mm"] == pytest.approx(rim_ref["location_mm"])
    assert tall["lights"]["key"]["size_mm"] == pytest.approx(key_ref["size_mm"])
    assert wide["lights"]["key"]["size_mm"] == pytest.approx(key_ref["size_mm"] * wide["scale"])
    fill_energy_ref = 62000.0 * 4.0 * (100.0 / 180.0) ** 2 * 0.35
    assert wide["lights"]["fill"]["energy"] == pytest.approx(fill_energy_ref)
    assert wide["lights"]["key"]["location_mm"] != pytest.approx(key_ref["location_mm"])
    key_offset = [a - b for a, b in zip(tall["lights"]["key"]["location_mm"], (0.0, 0.0, 90.0))]
    original_offset = [a - b for a, b in zip(key_ref["location_mm"], (0.0, 0.0, 90.0))]
    assert math.hypot(key_offset[0], key_offset[1], key_offset[2]) == pytest.approx(
        math.hypot(*original_offset)
    )
    assert math.atan2(key_offset[1], key_offset[0]) == pytest.approx(math.atan2(original_offset[1], original_offset[0]))
    assert tall["camera_space_shots"] is True
    assert tall["world_hdri"] is False


def test_apply_studio_contract_explicit_matches_scaled_helper_and_keeps_f():
    contract = contract_module()
    studio = contract._normalize_studio(explicit_studio_block(), "studio")
    expected = contract.scaled_explicit_studio_lights(studio, WIDE)
    lights = studio_lights()
    aim = []
    apply = apply_contract(Vector=VectorStub, math=math, look_at=lambda light, target: aim.append(tuple(target)))
    world = fake_world()
    apply(
        SimpleNamespace(eevee=SimpleNamespace(shadow_pool_size="512"), world=world),
        {
            "dimensions_mm": WIDE,
            "render": {
                "studio_profile": EXPLICIT_STUDIO,
                "shadow_pool_size_mb": 1024,
                "light_energy_scale": 4.0,
                "rig_reference_mm": 180.0,
                "fill_energy_multiplier": 0.35,
                "key_elevation_delta_deg": -15.0,
            },
            "render_spec": {"shots": studio},
        },
        lights,
    )
    assert tuple(world.color) == pytest.approx((1.0, 1.0, 1.0))
    assert tuple(lights[0].location) == pytest.approx(tuple(expected["lights"]["key"]["location_mm"]))
    assert lights[1].data.energy == pytest.approx(expected["lights"]["fill"]["energy"])
    assert lights[2].data.size_y == pytest.approx(expected["lights"]["rim"]["size_y_mm"])
    f_lights = studio_lights()
    apply(
        SimpleNamespace(eevee=SimpleNamespace(shadow_pool_size="512")),
        {
            "dimensions_mm": WIDE,
            "render": {
                "studio_profile": "normalized-three-area-f-v1",
                "shadow_pool_size_mb": 1024,
                "rig_reference_mm": 180,
                "fill_energy_multiplier": 0.35,
                "key_elevation_delta_deg": -15,
            },
        },
        f_lights,
    )
    assert f_lights[0].data.energy == pytest.approx(105000.0 * 4.0 * (100.0 / 180.0) ** 2)


def test_explicit_nonwhite_world_color_is_applied_and_read_back():
    contract = contract_module()
    studio = contract._normalize_studio(explicit_studio_block(), "studio")
    studio["world_color"] = [0.2, 0.4, 0.6]
    scaled = contract.scaled_explicit_studio_lights(studio, WHITE)
    assert scaled["world_color"] == pytest.approx([0.2, 0.4, 0.6])
    world = fake_world((1.0, 1.0, 1.0))
    lights = studio_lights()
    apply = apply_contract(Vector=VectorStub, math=math, look_at=lambda *_args: None)
    apply(
        SimpleNamespace(eevee=SimpleNamespace(shadow_pool_size="512"), world=world),
        {
            "dimensions_mm": WHITE,
            "render": {
                "studio_profile": EXPLICIT_STUDIO,
                "shadow_pool_size_mb": 1024,
                "light_energy_scale": 4.0,
                "rig_reference_mm": 180.0,
                "fill_energy_multiplier": 0.35,
                "key_elevation_delta_deg": -15.0,
            },
            "render_spec": {"shots": studio},
        },
        lights,
    )
    assert tuple(world.color) == pytest.approx((0.2, 0.4, 0.6))
    background = world.node_tree.nodes[0].inputs["Color"].default_value
    assert tuple(background[:3]) == pytest.approx((0.2, 0.4, 0.6))
    f_world = fake_world((1.0, 1.0, 1.0))
    apply(
        SimpleNamespace(eevee=SimpleNamespace(shadow_pool_size="512"), world=f_world),
        {
            "dimensions_mm": WHITE,
            "render": {
                "studio_profile": "normalized-three-area-f-v1",
                "shadow_pool_size_mb": 1024,
                "rig_reference_mm": 180,
                "fill_energy_multiplier": 0.35,
                "key_elevation_delta_deg": -15,
            },
        },
        studio_lights(),
    )
    assert tuple(f_world.color) == pytest.approx((1.0, 1.0, 1.0))
    assert tuple(f_world.node_tree.nodes[0].inputs["Color"].default_value[:3]) == pytest.approx((1.0, 1.0, 1.0))


def test_experimental_studio_plan_does_not_register_production(tmp_path):
    contract = contract_module()
    assert contract.EXPERIMENTAL_STUDIO_REGISTRY_PATH == EXPERIMENTAL_STUDIO_REGISTRY
    production = contract.load_profile_registry()
    experimental = contract.load_experimental_studio_registry()
    assert "packshot-studio-explicit-v1" in experimental["profiles"]
    assert "packshot-studio-explicit-v1" not in production["profiles"]
    plan = contract.render_plan_for_experimental_studio_job(carton_job(), "packshot-studio-explicit-v1")
    published = contract.render_plan_for_new_job(carton_job(), "packshot-carton-geometry-v1")
    assert plan["fingerprint_token"] != published["fingerprint_token"]
    assert plan["render"]["studio_profile"] == EXPLICIT_STUDIO
    assert plan["spec"]["shots"]["lights"]["key"]["energy_base"] == 105000.0
    assert plan["spec"]["color"]["view_transform"] == "Standard"
    with pytest.raises(contract.RenderContractError):
        contract.render_plan_for_new_job(carton_job(), "packshot-studio-explicit-v1")


def test_declaration_rejects_duplicate_missing_and_illegal_candidates():
    driver = driver_module()
    wrap = wrap_module()
    good = driver.load_declaration()
    assert list(good["candidates"]) == list(CANDIDATES)
    assert list(good["fixtures"]) == list(FIXTURES)
    for payload, match in (
        ({**good, "candidates": ["Standard", "Standard", "AgX"]}, "duplicate"),
        ({**good, "candidates": ["Standard", "AgX"]}, "missing"),
        ({**good, "candidates": ["Standard", "AgX", "Filmic"]}, "unsupported"),
        ({**good, "fixtures": ["rf00-white-carton"]}, "fixture"),
    ):
        with pytest.raises(Exception, match=match):
            driver.validate_declaration(payload)


def test_declaration_hash_mismatch_fails_before_render(tmp_path, monkeypatch):
    driver = driver_module()
    wrap = wrap_module()
    declaration = driver.load_declaration()
    root = tmp_path / "rf07-root"
    root.mkdir()
    dest, digest = driver.write_declaration_copy(root, declaration)
    (root / "declaration.sha256").write_text("0" * 64 + "\n", encoding="utf-8")
    with pytest.raises(Exception, match="declaration"):
        driver.assert_preregistered_declaration(root, declaration)
    assert digest != "0" * 64
    assert dest.is_file()


def test_empty_shell_three_transforms_is_not_identity():
    driver = driver_module()
    shells = [
        {"render": {"view_transform": {"status": "measured", "value": name, "method": "t"}}}
        for name in CANDIDATES
    ]
    assert driver.fixed_scene_identity_ok(shells) is False


def test_scene_identity_allows_only_view_transform_difference():
    driver = driver_module()
    wrap = wrap_module()
    receipts = [complete_rf07_pass(name) for name in CANDIDATES]
    assert driver.fixed_scene_identity_ok(receipts) is True
    tampered = deepcopy(receipts)
    tampered[1]["render"]["exposure"] = {"status": "measured", "value": 0.3, "method": "t"}
    assert driver.fixed_scene_identity_ok(tampered) is False
    lights = deepcopy(receipts)
    lights[1]["lights"][0]["energy"]["value"] = 9
    assert driver.fixed_scene_identity_ok(lights) is False
    look = deepcopy(receipts)
    look[2]["render"]["look"] = {"status": "measured", "value": "AgX - High Contrast", "method": "view_settings.look"}
    assert driver.fixed_scene_identity_ok(look) is False
    two = receipts[:2]
    assert driver.fixed_scene_identity_ok(two) is False
    assert wrap.COLOR_CANDIDATES == CANDIDATES


@pytest.mark.parametrize(
    "field,mutator",
    [
        ("coat", lambda scene: scene["materials"][0]["nodes"][0]["inputs"].__setitem__("Coat Weight", 1.0)),
        ("normal", lambda scene: scene["materials"][0]["nodes"][1]["inputs"].__setitem__("Strength", 0.9)),
        ("uv", lambda scene: scene["meshes"][1]["uv_sha256"].__setitem__("value", "e" * 64)),
        ("colorspace", lambda scene: scene["materials"][0]["nodes"][2]["image"].__setitem__("color_space", "Non-Color")),
        ("packed", lambda scene: scene["materials"][0]["nodes"][2]["image"].__setitem__("sha256", "f" * 64)),
        ("seed", lambda scene: scene.__setitem__("seed", {"status": "measured", "value": 7, "method": "scene.cycles.seed"})),
    ],
)
def test_fixed_scene_mutations_break_identity(field, mutator):
    driver = driver_module()
    receipts = [complete_rf07_pass(name) for name in CANDIDATES]
    mutator(receipts[1]["fixed_scene"])
    assert driver.fixed_scene_identity_ok(receipts) is False, field


def test_empty_jobs_finalize_is_not_ok_even_if_caller_passes_true(tmp_path):
    driver = driver_module()
    report = driver.finalize_experiment_report(
        jobs=[],
        suite="matrix",
        root=tmp_path,
        declaration=driver.load_declaration(),
        identity_ok=True,
        outputs_closed=True,
        human_approval=None,
    )
    assert report["ok"] is False
    assert report["complete"] is False
    assert report["decision"]["kept_view_transform"] == "Standard"


def _smoke_jobs(tmp_path, *, mutate=None):
    driver = driver_module()
    mapping = driver.anonymous_candidate_map("a" * 64, CANDIDATES)
    inverse = {name: label for label, name in mapping.items()}
    jobs = []
    for candidate in CANDIDATES:
        label = inverse[candidate]
        job_dir = tmp_path / "jobs" / "rf00-white-carton" / label
        job_dir.mkdir(parents=True)
        outputs = {}
        hashes = {}
        passes = []
        for key in ("front_right", "back_left"):
            path = job_dir / f"{key}.png"
            Image.new("RGBA", (8, 8), (12, 24, 36, 255)).save(path)
            outputs[key] = str(path)
            hashes[key] = hashlib.sha256(path.read_bytes()).hexdigest()
            passes.append(complete_rf07_pass(candidate, key))
            passes[-1]["output_sha256"] = hashes[key]
        jobs.append(
            {
                "fixture_id": "rf00-white-carton",
                "candidate": candidate,
                "anonymous_label": label,
                "complete": True,
                "outputs": outputs,
                "output_hashes": hashes,
                "passes": passes,
                "project_dir": str(job_dir),
            }
        )
    if mutate:
        mutate(jobs)
    return driver, jobs


def test_finalize_smoke_complete_jobs_and_rejects_bad_sets(tmp_path):
    driver, jobs = _smoke_jobs(tmp_path)
    ok = driver.finalize_experiment_report(
        jobs=jobs,
        suite="smoke",
        root=tmp_path,
        declaration=driver.load_declaration(),
    )
    assert ok["ok"] is True
    assert ok["complete"] is True

    missing = driver.finalize_experiment_report(
        jobs=jobs[:2],
        suite="smoke",
        root=tmp_path,
        declaration=driver.load_declaration(),
    )
    assert missing["ok"] is False

    dup = deepcopy(jobs)
    dup[2] = deepcopy(dup[0])
    duplicate = driver.finalize_experiment_report(
        jobs=dup,
        suite="smoke",
        root=tmp_path,
        declaration=driver.load_declaration(),
    )
    assert duplicate["ok"] is False

    unknown = deepcopy(jobs)
    unknown[0]["candidate"] = "Filmic"
    bad_candidate = driver.finalize_experiment_report(
        jobs=unknown,
        suite="smoke",
        root=tmp_path,
        declaration=driver.load_declaration(),
    )
    assert bad_candidate["ok"] is False

    Path(jobs[0]["outputs"]["back_left"]).unlink()
    missing_still = driver.finalize_experiment_report(
        jobs=jobs,
        suite="smoke",
        root=tmp_path,
        declaration=driver.load_declaration(),
    )
    assert missing_still["ok"] is False


@pytest.mark.parametrize("failure", ["source", "anonymous", "job"])
def test_complete_images_cannot_override_execution_failure(tmp_path, failure):
    driver, jobs = _smoke_jobs(tmp_path)
    flags = {}
    if failure == "source":
        flags["identity_ok"] = False
    elif failure == "anonymous":
        flags["outputs_closed"] = False
    else:
        jobs[0]["complete"] = False
    report = driver.finalize_experiment_report(
        jobs=jobs, suite="smoke", root=tmp_path, **flags,
    )
    assert report["ok"] is False
    assert report["complete"] is False


def test_finalize_rejects_swapped_candidates_and_non_image_outputs(tmp_path):
    driver, jobs = _smoke_jobs(tmp_path)
    jobs[0]["candidate"], jobs[1]["candidate"] = jobs[1]["candidate"], jobs[0]["candidate"]
    swapped = driver.finalize_experiment_report(
        jobs=jobs,
        suite="smoke",
        root=tmp_path,
        declaration=driver.load_declaration(),
    )
    assert swapped["ok"] is False
    assert swapped["complete"] is False

    driver, jobs = _smoke_jobs(tmp_path / "json-as-png")
    fake = tmp_path / "json-as-png" / "not-an-image.json"
    fake.write_text("{}", encoding="utf-8")
    jobs[0]["outputs"]["front_right"] = str(fake)
    jobs[0]["output_hashes"]["front_right"] = driver.sha256_file(fake)
    jobs[0]["passes"][0]["output_sha256"] = jobs[0]["output_hashes"]["front_right"]
    not_image = driver.finalize_experiment_report(
        jobs=jobs,
        suite="smoke",
        root=tmp_path / "json-as-png",
        declaration=driver.load_declaration(),
    )
    assert not_image["ok"] is False


def test_finalize_rejects_hash_change_after_write(tmp_path):
    driver, jobs = _smoke_jobs(tmp_path)
    Path(jobs[0]["outputs"]["front_right"]).write_bytes(b"changed-bytes-not-the-original-png")
    report = driver.finalize_experiment_report(
        jobs=jobs,
        suite="smoke",
        root=tmp_path,
        declaration=driver.load_declaration(),
    )
    assert report["ok"] is False
    assert report["complete"] is False


def test_partial_output_and_unavailable_transform_are_not_complete(tmp_path):
    driver = driver_module()
    wrap = wrap_module()
    jobs = [
        {"fixture_id": "rf00-white-carton", "candidate": "Standard", "complete": True, "anonymous_label": "A"},
        {"fixture_id": "rf00-white-carton", "candidate": "AgX", "complete": False, "anonymous_label": "B", "error": "color_transform_unsupported"},
        {"fixture_id": "rf00-white-carton", "candidate": "Khronos PBR Neutral", "complete": True, "anonymous_label": "C"},
    ]
    report = driver.finalize_experiment_report(
        jobs=jobs,
        suite="smoke",
        root=tmp_path,
        declaration=driver.load_declaration(),
        identity_ok=True,
        outputs_closed=True,
        human_approval=None,
    )
    assert report["ok"] is False
    assert report["complete"] is False
    assert report["decision"]["kept_view_transform"] == "Standard"
    assert report["decision"]["status"] == "awaiting_human_approval"
    assert report["decision"]["winner"] is None

    class RejectingView:
        def __init__(self):
            self.look = "None"
            self.exposure = 0.0
            self._transform = "Standard"

        @property
        def view_transform(self):
            return self._transform

        @view_transform.setter
        def view_transform(self, value):
            self._transform = self._transform

    with pytest.raises(wrap.ExperimentError, match="color_transform_unsupported"):
        wrap.apply_view_transform(
            SimpleNamespace(view_settings=RejectingView()),
            "AgX",
            look="None",
            exposure=0.0,
        )


def test_missing_human_approval_keeps_standard_and_does_not_invent_thresholds():
    driver = driver_module()
    decision = driver.select_color_winner(
        automatic={"white_separation": {"status": "measured", "value": {"delta_vs_white": 12}}},
        human_approval=None,
        p0_thresholds=None,
    )
    assert decision["status"] == "awaiting_human_approval"
    assert decision["kept_view_transform"] == "Standard"
    assert decision["winner"] is None
    assert decision["p0_thresholds"]["status"] == "not_assessed"
    assert decision["private_artwork_blind_review"]["status"] == "not_assessed"
    assert decision["baseline_updated"] is False
    assert decision["production_profile_frozen"] is False
    assert decision["quality_improvement"] == "not_assessed"
    assert "threshold" not in json.dumps(decision).lower() or decision["p0_thresholds"]["reason"]


def test_anonymous_outputs_do_not_name_candidates(tmp_path):
    driver = driver_module()
    mapping = driver.anonymous_candidate_map("a" * 64, CANDIDATES)
    assert set(mapping) == {"A", "B", "C"}
    assert set(mapping.values()) == set(CANDIDATES)
    sheet = tmp_path / "contact-sheet.png"
    rows = []
    for fixture_id in FIXTURES:
        cells = []
        for label in ("A", "B", "C"):
            path = tmp_path / "anonymous" / label / fixture_id / "front_right.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGBA", (32, 40), (200, 200, 200, 255)).save(path)
            cells.append((label, path))
        rows.append((fixture_id, cells))
    driver.write_anonymous_contact_sheet(rows, sheet)
    pixels = Image.open(sheet).convert("RGB").tobytes()
    payload = json.dumps({"sheet": str(sheet), "rows": [[item[0] for item in cells] for _, cells in rows]})
    for name in CANDIDATES:
        assert name.encode("utf-8") not in pixels
        assert name not in payload
        assert name.lower() not in str(sheet).lower()
    map_path = tmp_path / "candidate-map.json"
    driver.write_candidate_map(map_path, mapping, "a" * 64)
    saved = json.loads(map_path.read_text(encoding="utf-8"))
    assert saved["labels"] == mapping
    assert "Standard" in saved["labels"].values()


def test_metrics_do_not_fake_delta_e_or_hairline_from_whole_frame(tmp_path):
    driver = driver_module()
    eval_mod = driver.eval_module()
    path = tmp_path / "front_right.png"
    Image.new("RGBA", (64, 80), (240, 240, 240, 255)).save(path)
    metrics = eval_mod.collect_image_metrics(path)
    report = driver.automatic_metrics_for_still(
        fixture_id="rf00-white-carton",
        still_key="front_right",
        path=path,
        eval_mod=eval_mod,
    )
    assert report["white_separation"]["status"] in {"measured", "unavailable"}
    assert report["delta_e"]["status"] == "unavailable"
    assert "whole" in report["delta_e"]["reason"] or "roi" in report["delta_e"]["reason"]
    assert report["hairline_fidelity"]["status"] in {"unavailable", "not_assessed"}
    assert metrics["white_separation"]["status"] in {"measured", "unavailable"}
    assert "mean" not in json.dumps(report["delta_e"]).lower() or "not" in report["delta_e"]["reason"]


def test_import_and_dry_run_do_not_call_blender_or_write(monkeypatch, tmp_path):
    driver = driver_module()
    wrap = wrap_module()
    env_before = dict(__import__("os").environ)
    assert "bpy" not in wrap.__dict__
    report = driver.run_experiment(suite="matrix", render=False)
    assert report["render"] is False
    assert report["blender_subprocess_invoked"] is False
    assert report["wrote_files"] is False
    assert report["decision"]["kept_view_transform"] == "Standard"
    assert dict(__import__("os").environ) == env_before
    monkeypatch.setattr(driver, "create_experiment_root", lambda: tmp_path / "should-not-exist")
    dry = driver.run_experiment(suite="matrix", render=False)
    assert dry["wrote_files"] is False
    assert not (tmp_path / "should-not-exist").exists()


def test_transform_readback_none_enum_is_not_treated_as_support():
    wrap = wrap_module()

    class NoneEnumView:
        def __init__(self):
            self.look = "None"
            self.exposure = 0.0
            self._transform = "Standard"

        @property
        def view_transform(self):
            return self._transform

        @view_transform.setter
        def view_transform(self, value):
            self._transform = "NONE"

    fake = SimpleNamespace(view_settings=NoneEnumView())
    with pytest.raises(wrap.ExperimentError, match="color_transform_unsupported"):
        wrap.apply_view_transform(fake, "Khronos PBR Neutral", look="None", exposure=0.0)


def test_round_timeout_does_not_start_next_job():
    driver = driver_module()
    assert driver.remaining_job_budget(100.0, now=50.0, job_timeout=300) == 50.0
    assert driver.remaining_job_budget(100.0, now=100.0, job_timeout=300) == 0
    assert driver.remaining_job_budget(100.0, now=120.0, job_timeout=300) == 0
    assert driver.remaining_job_budget(500.0, now=100.0, job_timeout=300) == 300


class _Rf07Pipeline:
    def __init__(self, run_job):
        self.BLENDER_SCRIPT = Path("/original/render_job.py")
        self.run_blender_job = run_job


class _Rf07Eval:
    def load_fixture_manifest(self):
        return {}

    def fixture_by_id(self, _manifest, fixture_id):
        return {
            "id": fixture_id,
            "dimensions_mm": WHITE,
            "artwork": {"fill_rgb": [240, 240, 240]},
        }

    def materialize_fixture(self, _spec, dest):
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "source.ai").write_bytes(b"synthetic-not-customer")
        return dest


def _rf07_rfe02(pipeline):
    return SimpleNamespace(
        resolve_blender=lambda _explicit, _eval_mod: (Path("/synthetic/blender"), None),
        assert_experiment_root_allowed=lambda root: Path(root),
        _load_pipeline=lambda: pipeline,
    )


def _stub_receipt(job, **fields):
    envelope = json.loads(Path(os.environ["BEIAN_RF07_JOB"]).read_text(encoding="utf-8"))
    payload = {
        "complete": False,
        "passes": [],
        "candidate": envelope["candidate"],
        "declaration_sha256": envelope["declaration_sha256"],
    }
    payload.update(fields)
    Path(job["project_dir"], wrap_module().JOB_RECEIPT_NAME).write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


def _run_rf07_render(driver, monkeypatch, tmp_path, run_job, **kwargs):
    wrap = wrap_module()
    pipeline = _Rf07Pipeline(run_job)
    monkeypatch.setattr(driver, "rfe02_module", lambda: _rf07_rfe02(pipeline))
    monkeypatch.setattr(driver, "eval_module", _Rf07Eval)
    monkeypatch.setattr(driver, "wrapper_module", lambda: wrap)
    root = tmp_path / "rf07-isolated"
    report = driver.run_experiment(
        suite="smoke",
        render=True,
        blender_executable=Path("/synthetic/blender"),
        output=root,
        **kwargs,
    )
    return wrap, pipeline, root, report


def test_rf07_missing_blender_fails_closed_without_samples(tmp_path, monkeypatch):
    driver = driver_module()
    env_before = dict(os.environ)

    def refuse_root(*_args, **_kwargs):
        raise AssertionError("missing Blender must not create an experiment root")

    monkeypatch.setattr(driver, "create_experiment_root", refuse_root)
    report = driver.run_experiment(
        suite="smoke",
        render=True,
        blender_executable=tmp_path / "no-such-blender",
        output=tmp_path / "should-not-exist",
    )
    assert report["ok"] is False
    assert report["complete"] is False
    assert report["samples_written"] is False
    assert report["blender_subprocess_invoked"] is False
    assert report["failure_reason"] == "blender_executable_missing"
    assert report["decision"]["kept_view_transform"] == "Standard"
    assert report["decision"]["winner"] is None
    assert not (tmp_path / "should-not-exist").exists()
    assert dict(os.environ) == env_before

    proc = subprocess.run(
        [
            sys.executable,
            str(DRIVER_PATH),
            "--suite",
            "smoke",
            "--render",
            "--blender",
            str(tmp_path / "missing-blender"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 2
    assert "blender_executable_missing" in proc.stdout
    assert "pip install" not in proc.stdout
    assert "Traceback" not in proc.stderr
    printed = json.loads(proc.stdout)
    assert printed["ok"] is False
    assert printed["blender_subprocess_invoked"] is False


def test_rf07_render_failure_restores_script_and_stops_remaining_jobs(tmp_path, monkeypatch):
    driver = driver_module()
    env_key = "BEIAN_RF07_JOB"
    monkeypatch.setenv(env_key, "sentinel-before")
    calls = []

    def fail_job(job, _executable, **_kwargs):
        calls.append(Path(os.environ[env_key]).name)
        assert Path(os.environ[env_key]).is_file()
        raise RuntimeError("synthetic blender crash")

    wrap, pipeline, root, report = _run_rf07_render(driver, monkeypatch, tmp_path, fail_job)
    assert pipeline.BLENDER_SCRIPT == Path("/original/render_job.py")
    assert os.environ.get(env_key) == "sentinel-before"
    assert calls == ["rf07-job-envelope.json"]
    assert report["ok"] is False
    assert report["complete"] is False
    assert report["failure_reason"] == "blender_render_failed"
    assert report["blender_subprocess_invoked"] is True
    assert len(report["jobs"]) == 1
    assert report["jobs"][0]["complete"] is False
    assert report["jobs"][0]["error_type"] == "RuntimeError"
    assert json.loads((root / "report.json").read_text(encoding="utf-8"))["failure_reason"] == "blender_render_failed"
    assert wrap.ENV_JOB == env_key


def test_rf07_round_timeout_does_not_start_remaining_jobs(tmp_path, monkeypatch):
    driver = driver_module()
    wrap_mod = wrap_module()
    started = []
    budgets = {"n": 0}

    def budget(*_args, **_kwargs):
        budgets["n"] += 1
        return 300.0 if budgets["n"] == 1 else 0.0

    monkeypatch.setattr(driver, "remaining_job_budget", budget)

    def first_only(job, _executable, **_kwargs):
        started.append(job["code"])
        _stub_receipt(job, complete=True)
        return job

    _wrap, pipeline, _root, report = _run_rf07_render(driver, monkeypatch, tmp_path, first_only)
    assert started == ["rf00-white-carton"]
    assert budgets["n"] == 2
    assert pipeline.BLENDER_SCRIPT == Path("/original/render_job.py")
    assert report["ok"] is False
    assert report["complete"] is False
    assert report["failure_reason"] == "experiment_round_timeout"
    assert len(report["jobs"]) == 2
    assert report["jobs"][1]["error"] == "experiment_round_timeout"
    assert report["jobs"][1]["complete"] is False


def test_rf07_blender_timeout_restores_env_and_does_not_kill_unrelated(tmp_path, monkeypatch):
    driver = driver_module()
    env_key = "BEIAN_RF07_JOB"
    monkeypatch.setenv(env_key, "timeout-sentinel")

    def boom(_job, _executable, **_kwargs):
        raise subprocess.TimeoutExpired(cmd="blender", timeout=1)

    sentinel = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        _wrap, pipeline, _root, report = _run_rf07_render(driver, monkeypatch, tmp_path, boom)
        assert sentinel.poll() is None
        assert pipeline.BLENDER_SCRIPT == Path("/original/render_job.py")
        assert os.environ.get(env_key) == "timeout-sentinel"
        assert report["ok"] is False
        assert report["failure_reason"] == "blender_render_failed"
        assert report["jobs"][0]["error_type"] == "TimeoutExpired"
        assert "killall" not in DRIVER_PATH.read_text(encoding="utf-8")
        assert "killall" not in WRAPPER_PATH.read_text(encoding="utf-8")
    finally:
        sentinel.kill()
        sentinel.wait()


def test_rf07_wrapper_main_requires_envelope_and_declaration_hash(tmp_path, monkeypatch):
    wrap = wrap_module()
    monkeypatch.delenv(wrap.ENV_JOB, raising=False)
    with pytest.raises(SystemExit, match="BEIAN_RF07_JOB missing"):
        wrap.run_experimental_main()
    declaration = tmp_path / "declaration.json"
    declaration.write_text("{}", encoding="utf-8")
    envelope = tmp_path / "envelope.json"
    envelope.write_text(
        json.dumps(
            {
                "schema": wrap.ENVELOPE_SCHEMA,
                "candidate": "Standard",
                "declaration_path": str(declaration),
                "declaration_sha256": "0" * 64,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv(wrap.ENV_JOB, str(envelope))
    with pytest.raises(SystemExit, match="declaration hash mismatch"):
        wrap.run_experimental_main()
    assert not (tmp_path / wrap.JOB_RECEIPT_NAME).exists()


@pytest.mark.parametrize("outcome", ["missing_file", "error", "main_before_studio"])
def test_rf07_wrapper_main_persists_failure_evidence(tmp_path, monkeypatch, outcome):
    wrap = wrap_module()
    declaration = tmp_path / "declaration.json"
    declaration.write_text("{}", encoding="utf-8")
    envelope = tmp_path / "envelope.json"
    envelope.write_text(
        json.dumps(
            {
                "schema": wrap.ENVELOPE_SCHEMA,
                "candidate": "AgX",
                "look": "None",
                "exposure": 0.0,
                "declaration_path": str(declaration),
                "declaration_sha256": wrap._rfe02().sha256_file(declaration),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv(wrap.ENV_JOB, str(envelope))
    outputs = {
        "front_right": str(tmp_path / "front_right.png"),
        "back_left": str(tmp_path / "back_left.png"),
        "glb": str(tmp_path / "model.glb"),
        "blend": str(tmp_path / "scene.blend"),
    }
    job = {
        "project_dir": str(tmp_path),
        "outputs": outputs,
        "dimensions_mm": WHITE,
        "assets": {},
    }
    snapshot = tmp_path / "job.json"
    snapshot.write_text(json.dumps(job), encoding="utf-8")
    scene = FakeScene()
    scene.frame_current = 1
    scene.frame_subframe = 0.0
    renderer = SimpleNamespace(job_path_from_argv=lambda: snapshot)

    def original_still(_scene, path):
        if outcome == "error":
            raise RuntimeError("rf07 renderer failed")
        if outcome != "missing_file":
            write_still(Path(path))

    def original_main():
        if outcome == "main_before_studio":
            raise RuntimeError("rf07 renderer failed")
        renderer.add_studio(job)
        for key in ("front_right", "back_left"):
            renderer.render_still(scene, outputs[key])

    renderer.add_studio = lambda _job: scene.camera
    renderer.render_still = original_still
    renderer.main = original_main
    monkeypatch.setattr(wrap, "load_product_renderer", lambda: renderer)
    monkeypatch.setitem(
        sys.modules,
        "bpy",
        SimpleNamespace(
            data=SimpleNamespace(objects=fake_lights()),
            context=SimpleNamespace(scene=scene),
        ),
    )
    if outcome == "missing_file":
        with pytest.raises(SystemExit, match="rf07 evidence incomplete"):
            wrap.run_experimental_main()
    else:
        with pytest.raises(RuntimeError, match="rf07 renderer failed"):
            wrap.run_experimental_main()
    receipt_path = tmp_path / wrap.JOB_RECEIPT_NAME
    assert receipt_path.is_file()
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["candidate"] == "AgX"
    assert receipt["complete"] is False
    assert receipt["quality_improvement"] == "not_assessed"
    if outcome == "error":
        assert len(receipt["passes"]) == 1
        assert receipt["passes"][0]["pass_complete"] is False
        assert receipt["passes"][0]["error_type"] == "RuntimeError"
    elif outcome == "missing_file":
        assert len(receipt["passes"]) == 2
        assert all(item["pass_complete"] is False for item in receipt["passes"])
        assert not Path(outputs["front_right"]).exists()
    else:
        assert receipt["passes"] == []
        assert not Path(outputs["front_right"]).exists()


def test_declaration_look_and_exposure_must_stay_contracted():
    driver = driver_module()
    good = driver.load_declaration()
    with pytest.raises(Exception, match="look/exposure"):
        driver.validate_declaration({**good, "look": "AgX - High Contrast"})
    with pytest.raises(Exception, match="look/exposure"):
        driver.validate_declaration({**good, "exposure": 0.3})
    with pytest.raises(Exception, match="suite must be smoke or matrix"):
        driver.run_experiment(suite="full", render=False)


def test_anonymous_contact_sheet_refuses_overwrite_and_empty_cells(tmp_path):
    driver = driver_module()
    dest = tmp_path / "contact-sheet.png"
    dest.write_bytes(b"preserve")
    with pytest.raises(Exception, match="must be new"):
        driver.write_anonymous_contact_sheet([], dest)
    assert dest.read_bytes() == b"preserve"
    missing = tmp_path / "fresh-sheet.png"
    with pytest.raises(Exception, match="no_readable_stills"):
        driver.write_anonymous_contact_sheet(
            [("rf00-white-carton", [("A", tmp_path / "missing.png")])],
            missing,
        )
    assert not missing.exists()


def test_explicit_reference_target_must_be_rig_center_and_scaled_helper_rejects_f():
    contract = contract_module()
    studio = explicit_studio_block()
    studio["reference_target_mm"] = [0.0, 0.0, 0.0]
    with pytest.raises(contract.RenderContractError, match="参考目标必须是参考尺寸中心"):
        contract._normalize_studio(studio, "studio")
    f_studio = contract.load_profile_registry()["profiles"][F_PROFILE_ID]["studio"]
    with pytest.raises(contract.RenderContractError, match="只有显式棚光才能按参考尺寸缩放"):
        contract.scaled_explicit_studio_lights(f_studio, WHITE)


def test_apply_studio_contract_explicit_missing_lights_or_world_fails_closed():
    apply = apply_contract(Vector=VectorStub, math=math, look_at=lambda *_a: None)
    studio = explicit_studio_block()
    job = {
        "dimensions_mm": WHITE,
        "render": {
            "studio_profile": EXPLICIT_STUDIO,
            "shadow_pool_size_mb": 1024,
            "light_energy_scale": 4.0,
            "rig_reference_mm": 180.0,
            "fill_energy_multiplier": 0.35,
            "key_elevation_delta_deg": -15.0,
        },
        "render_spec": {"shots": studio},
    }
    with pytest.raises(RuntimeError, match="explicit lights missing"):
        apply(SimpleNamespace(eevee=SimpleNamespace(shadow_pool_size="512"), world=fake_world()), job, studio_lights()[:2])
    broken = deepcopy(studio)
    broken.pop("world_color")
    job["render_spec"] = {"shots": broken}
    with pytest.raises(RuntimeError, match="world_color missing"):
        apply(SimpleNamespace(eevee=SimpleNamespace(shadow_pool_size="512"), world=fake_world()), job, studio_lights())
    job["render_spec"] = {"shots": studio}
    with pytest.raises(RuntimeError, match="world missing"):
        apply(SimpleNamespace(eevee=SimpleNamespace(shadow_pool_size="512")), job, studio_lights())
    silent = fake_world()
    silent.use_nodes = False
    with pytest.raises(RuntimeError, match="world background missing"):
        apply(SimpleNamespace(eevee=SimpleNamespace(shadow_pool_size="512"), world=silent), job, studio_lights())


def test_rf07_unusable_blender_and_incomplete_receipt_fail_closed(tmp_path, monkeypatch):
    driver = driver_module()
    wrap = wrap_module()
    unusable = tmp_path / "blender-not-exec"
    unusable.write_text("not-an-executable\n", encoding="utf-8")
    report = driver.run_experiment(
        suite="smoke",
        render=True,
        blender_executable=unusable,
        output=tmp_path / "unusable-out",
    )
    assert report["ok"] is False
    assert report["blender_subprocess_invoked"] is False
    assert report["failure_reason"] == "blender_executable_unusable"
    assert not (tmp_path / "unusable-out").exists()

    def incomplete(job, _executable, **_kwargs):
        _stub_receipt(job, complete=False, error="still_missing")
        return job

    _wrap, pipeline, _root, incomplete_report = _run_rf07_render(driver, monkeypatch, tmp_path, incomplete)
    assert pipeline.BLENDER_SCRIPT == Path("/original/render_job.py")
    assert incomplete_report["ok"] is False
    assert incomplete_report["failure_reason"] == "still_missing"
    assert incomplete_report["jobs"][0]["complete"] is False
    assert len(incomplete_report["jobs"]) == 1
    assert not (_root / "contact-sheet.png").exists()
    assert incomplete_report.get("contact_sheet") is None


def test_rf07_create_experiment_root_is_isolated_and_prefixed():
    driver = driver_module()
    root = driver.create_experiment_root()
    try:
        assert root.name.startswith("beian-rf07-")
        assert root.is_dir()
        repo = Path(__file__).resolve().parents[4]
        assert repo not in root.resolve().parents and root.resolve() != repo
        trap = repo / "docs" / "rf07-trap-should-not-remain"
        with pytest.raises(Exception, match="repository worktree"):
            driver.create_experiment_root(output=trap)
        assert not trap.exists()
    finally:
        if root.is_dir() and not any(root.iterdir()):
            root.rmdir()


def test_rf00_ruler_still_pins_add_studio_standard_default():
    eval_mod = driver_module().eval_module()
    declared = eval_mod.declared_current_render()
    assert declared["view_transform"]["status"] == "measured"
    assert declared["view_transform"]["value"] == "Standard"
    assert declared["view_transform"]["method"] == "render_job view_transform default"
    source = (PACKAGING / "blender" / "render_job.py").read_text(encoding="utf-8")
    assert 'render_config.get("view_transform", "Standard")' in source


def test_rf07_identity_change_during_render_fails_closed(tmp_path, monkeypatch):
    driver = driver_module()
    before = driver.collect_experiment_identity()
    after = {**before, "driver_sha256": "f" * 64}
    states = iter((before, after))
    monkeypatch.setattr(driver, "collect_experiment_identity", lambda: next(states))

    def ok_job(job, _executable, **_kwargs):
        _stub_receipt(job, complete=True)
        return job

    _wrap, _pipeline, _root, report = _run_rf07_render(driver, monkeypatch, tmp_path, ok_job)
    assert report["ok"] is False
    assert report["failure_reason"] == "identity_changed_during_run"
    assert report["decision"]["kept_view_transform"] == "Standard"
    assert report.get("wrote_rf00_baseline") is False


def test_rf07_render_still_before_add_studio_fails_closed(tmp_path):
    wrap = wrap_module()
    ctx = wrap.ExperimentContext(
        candidate="Standard",
        look="None",
        exposure=0.0,
        declaration_sha256="a" * 64,
        snapshot_sha256="b" * 64,
        source_identity={"wrapper_sha256": "c" * 64},
        list_lights=lambda: fake_lights(),
        scene=lambda: FakeScene(),
    )
    wrapped = wrap.make_render_still(lambda *_a: None, ctx)
    with pytest.raises(wrap.ExperimentError, match="render_still before add_studio"):
        wrapped(FakeScene(), tmp_path / "front_right.png")
    assert ctx.passes == []


def test_capture_fixed_scene_detects_live_mutations():
    wrap = wrap_module()

    class Vec:
        def __init__(self, *values):
            self.x, self.y, *rest = values + (0,)
            if len(values) == 2:
                self.x, self.y = values
                self.z = 0
            else:
                self.x, self.y, self.z = values[:3]

        def __iter__(self):
            return iter((self.x, self.y, self.z) if hasattr(self, "z") else (self.x, self.y))

        def __getitem__(self, index):
            return (self.x, self.y, self.z)[index]

    class Sock:
        def __init__(self, value, linked=False):
            self.default_value = value
            self.is_linked = linked
            self.identifier = "Value"
            self.name = "Value"

    class Image:
        def __init__(self, payload=b"png-a", colorspace="sRGB"):
            self.packed_file = SimpleNamespace(data=payload)
            self.filepath = "/tmp/same-name.png"
            self.colorspace_settings = SimpleNamespace(name=colorspace)
            self.size = (2, 2)
            self.pixels = [0.1, 0.2, 0.3, 1.0] * 4

    class Node:
        def __init__(self, name, bl_idname, inputs, image=None):
            self.name = name
            self.bl_idname = bl_idname
            self.type = bl_idname
            self.inputs = inputs
            self.image = image

    class Mesh:
        def __init__(self, uvs=True):
            self.vertices = [SimpleNamespace(co=Vec(0, 0, 0)), SimpleNamespace(co=Vec(1, 0, 0))]
            self.polygons = [SimpleNamespace(vertices=(0, 1))]
            self.uv_layers = [SimpleNamespace(name="UVMap", data=[SimpleNamespace(uv=Vec(0.1, 0.2))])] if uvs else []
            self.materials = []

    coat = Sock(0.0)
    strength = Sock(0.12)
    image = Image()
    bsdf = Node("Principled BSDF", "ShaderNodeBsdfPrincipled", {"Coat Weight": coat, "Roughness": Sock(0.52)})
    nmap = Node("Normal Map", "ShaderNodeNormalMap", {"Strength": strength})
    tex = Node("Image Texture", "ShaderNodeTexImage", {}, image=image)
    material = SimpleNamespace(
        name="MAT_front",
        node_tree=SimpleNamespace(
            nodes=[bsdf, nmap, tex],
            links=[SimpleNamespace(
                from_node=tex, from_socket=SimpleNamespace(identifier="Color"),
                to_node=bsdf, to_socket=SimpleNamespace(identifier="Base Color"),
            )],
        ),
    )
    mesh = Mesh()
    mesh.materials = [material]
    obj = SimpleNamespace(name="front", type="MESH", data=mesh, hide_render=False, matrix_world=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]])
    scene = SimpleNamespace(
        objects=[obj],
        frame_current=1,
        frame_subframe=0.0,
        render=SimpleNamespace(engine="BLENDER_EEVEE_NEXT"),
        eevee=SimpleNamespace(),
        cycles=None,
    )
    first = wrap.capture_fixed_scene(scene)
    strength.default_value = 0.9
    mutated_normal = wrap.capture_fixed_scene(scene)
    strength.default_value = 0.12
    coat.default_value = 1.0
    mutated_coat = wrap.capture_fixed_scene(scene)
    coat.default_value = 0.0
    mesh.uv_layers[0].data[0].uv = Vec(0.9, 0.8)
    mutated_uv = wrap.capture_fixed_scene(scene)
    mesh.uv_layers[0].data[0].uv = Vec(0.1, 0.2)
    image.colorspace_settings.name = "Non-Color"
    mutated_cs = wrap.capture_fixed_scene(scene)
    image.colorspace_settings.name = "sRGB"
    image.packed_file = SimpleNamespace(data=b"png-b")
    mutated_packed = wrap.capture_fixed_scene(scene)
    image.packed_file = SimpleNamespace(data=b"png-a")
    scene.cycles = SimpleNamespace(seed=3)
    mutated_seed = wrap.capture_fixed_scene(scene)
    assert first != mutated_normal
    assert first != mutated_coat
    assert first != mutated_uv
    assert first != mutated_cs
    assert first != mutated_packed
    assert first != mutated_seed
    receipts = [complete_rf07_pass(name) for name in CANDIDATES]
    receipts[0]["fixed_scene"] = first
    receipts[1]["fixed_scene"] = mutated_normal
    receipts[2]["fixed_scene"] = first
    driver = driver_module()
    assert driver.fixed_scene_identity_ok(receipts) is False


@pytest.mark.native
def test_native_blender_sets_and_reads_back_color_transforms():
    import shutil
    import subprocess
    import tempfile

    blender = shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender"
    assert Path(blender).exists()
    script = Path(tempfile.mkdtemp(prefix="beian-rf07-native-")) / "probe.py"
    out = script.with_suffix(".json")
    script.write_text(
        "import json, bpy\n"
        f"dest={str(out)!r}\n"
        "scene=bpy.context.scene\n"
        "rows=[]\n"
        "for name in ['Standard','Khronos PBR Neutral','AgX']:\n"
        "    scene.view_settings.view_transform=name\n"
        "    scene.view_settings.look='None'\n"
        "    rows.append({'requested':name,'actual':str(scene.view_settings.view_transform),'look':str(scene.view_settings.look)})\n"
        "    if str(scene.view_settings.view_transform)!=name:\n"
        "        raise SystemExit('color_transform_unsupported:'+name)\n"
        "json.dump({'ok':True,'rows':rows}, open(dest,'w'))\n",
        encoding="utf-8",
    )
    completed = subprocess.run(
        [blender, "--background", "--factory-startup", "--python-exit-code", "1", "--python", str(script)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode == 0, (completed.stdout + completed.stderr)[-2000:]
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["ok"] is True
    assert [row["actual"] for row in payload["rows"]] == list(CANDIDATES)


@pytest.mark.native
def test_native_fixed_scene_mutations_are_detected(tmp_path):
    import shutil
    import subprocess

    blender = shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender"
    assert Path(blender).exists()
    script = tmp_path / "mutate.py"
    out = tmp_path / "mutate.json"
    wrapper = str(WRAPPER_PATH)
    script.write_text(
        "import importlib.util, json, bpy\n"
        f"spec=importlib.util.spec_from_file_location('rf07w', {wrapper!r})\n"
        "mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)\n"
        "bpy.ops.mesh.primitive_plane_add()\n"
        "obj=bpy.context.object\n"
        "obj.name='front'\n"
        "mesh=obj.data\n"
        "if not mesh.uv_layers:\n"
        "    mesh.uv_layers.new(name='UVMap')\n"
        "img=bpy.data.images.new('panel', 4, 4, alpha=True)\n"
        "img.pixels=[0.2,0.3,0.4,1.0]*(4*4)\n"
        "img.pack()\n"
        "mat=bpy.data.materials.new('MAT_front')\n"
        "mat.use_nodes=True\n"
        "nodes=mat.node_tree.nodes\n"
        "bsdf=next(n for n in nodes if n.type=='BSDF_PRINCIPLED')\n"
        "tex=nodes.new('ShaderNodeTexImage'); tex.image=img\n"
        "nmap=nodes.new('ShaderNodeNormalMap'); nmap.inputs['Strength'].default_value=0.12\n"
        "mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])\n"
        "mesh.materials.append(mat)\n"
        "scene=bpy.context.scene\n"
        "base=mod.capture_fixed_scene(scene)\n"
        "rows={'base_ok': True}\n"
        "nmap.inputs['Strength'].default_value=0.9\n"
        "rows['normal']=base!=mod.capture_fixed_scene(scene)\n"
        "nmap.inputs['Strength'].default_value=0.12\n"
        "if 'Coat Weight' in bsdf.inputs:\n"
        "    bsdf.inputs['Coat Weight'].default_value=1.0\n"
        "    rows['coat']=base!=mod.capture_fixed_scene(scene)\n"
        "    bsdf.inputs['Coat Weight'].default_value=0.0\n"
        "else:\n"
        "    rows['coat']=False\n"
        "mesh.uv_layers.active.data[0].uv=(0.7,0.8)\n"
        "rows['uv']=base!=mod.capture_fixed_scene(scene)\n"
        "base=mod.capture_fixed_scene(scene)\n"
        "img.colorspace_settings.name='Non-Color'\n"
        "rows['colorspace']=base!=mod.capture_fixed_scene(scene)\n"
        "base=mod.capture_fixed_scene(scene)\n"
        "img.pixels=[0.9,0.1,0.1,1.0]*(4*4)\n"
        "img.pack()\n"
        "rows['packed']=base!=mod.capture_fixed_scene(scene)\n"
        "base=mod.capture_fixed_scene(scene)\n"
        "obj.location.x+=0.2; bpy.context.view_layer.update()\n"
        "rows['transform']=base!=mod.capture_fixed_scene(scene)\n"
        "mix=nodes.new('ShaderNodeMixRGB')\n"
        "base=mod.capture_fixed_scene(scene)\n"
        "mix.inputs[2].default_value=(0.1,0.2,0.3,1.0)\n"
        "rows['multiply_color']=base!=mod.capture_fixed_scene(scene)\n"
        "base=mod.capture_fixed_scene(scene)\n"
        "mix.blend_type='MULTIPLY'\n"
        "rows['node_operation']=base!=mod.capture_fixed_scene(scene)\n"
        "base=mod.capture_fixed_scene(scene)\n"
        "eevee=getattr(scene,'eevee',None)\n"
        "if hasattr(scene,'cycles'):\n"
        "    scene.cycles.seed=11\n"
        "    rows['seed']=base!=mod.capture_fixed_scene(scene)\n"
        "else:\n"
        "    rows['seed']=True\n"
        f"json.dump(rows, open({str(out)!r},'w'))\n"
        "if not all(rows[k] for k in ('normal','coat','uv','colorspace','packed','transform','multiply_color','node_operation','seed')):\n"
        "    raise SystemExit('mutation_not_detected:'+json.dumps(rows))\n",
        encoding="utf-8",
    )
    completed = subprocess.run(
        [blender, "--background", "--factory-startup", "--python-exit-code", "1", "--python", str(script)],
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert completed.returncode == 0, (completed.stdout + completed.stderr)[-4000:]
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["normal"] is True
    assert payload["coat"] is True
    assert payload["uv"] is True
    assert payload["colorspace"] is True
    assert payload["packed"] is True
    assert payload["transform"] is True
    assert payload["multiply_color"] is True
    assert payload["node_operation"] is True
    assert payload["seed"] is True
