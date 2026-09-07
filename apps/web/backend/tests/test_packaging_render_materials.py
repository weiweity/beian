from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image
import pytest

from test_packaging_render_contract import (
    FACES,
    REGISTRY_PATH,
    assert_error,
    carton_job,
    contract_module,
    refresh_profile_hash,
    registry_payload,
    write_registry,
)
from test_packaging_glb_verify import (
    _material_artifact,
    _runtime_artifact,
    _write_artifact,
    glb_verify,
)


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
EXPERIMENTAL_REGISTRY = PACKAGING / "profiles" / "experiments" / "rf06-materials.v1.json"
CURRENT_TEMPLATE = PACKAGING / "templates" / "flower_box_47_5x47_5x177_5.json"
PUBLISHED_PROFILE_SHA256 = {
    "compat-legacy-v0": "sha256:abf8256356f1d6d7b780411cc9210a195e1253ae304e0aceb1bcba0fe672aab4",
    "packshot-neutral-v1": "sha256:c8bb8bd09d65edc143c042da83ebfcade2c16bca11abc572c6faae3e890fcf5d",
    "smoke-v1": "sha256:5737d719bc6c56bde25e5c6ea1cd0ed8864821f0f0e8798ef4c0a88f80765165",
    "packshot-f-v1": "sha256:04074941381245d98b1787c4f993fe6951e9dba8657c851461eb4818ebf0a538",
    "packshot-carton-geometry-v1": "sha256:74a17949ac80cd1f3fa34640dcaf246a8a656dc78989e0b08589cb2306860aca",
}
KRAFT_RGBA = [0.55, 0.38, 0.18, 1.0]
MICRO_NORMAL = {
    "kind": "procedural-micro-v1",
    "size_px": 64,
    "seed": 7,
    "strength": 0.12,
    "color_space": "Non-Color",
}


def carton_geometry_profile() -> dict:
    return deepcopy(
        next(
            profile
            for profile in registry_payload()["profiles"]
            if profile["id"] == "packshot-carton-geometry-v1"
        )
    )


def material_candidate(
    profile_id: str,
    *,
    substrate: str = "white-card-default-v1",
    finish: str = "none",
    rgba: list[float] | None = None,
    roughness: float = 0.52,
    specular: float = 0.08,
    extra: dict | None = None,
) -> dict:
    profile = carton_geometry_profile()
    profile.pop("profile_sha256", None)
    profile["id"] = profile_id
    profile["geometry"]["rectangular_carton_v1"]["substrate_profile"] = substrate
    profile["material"] = {
        "substrate_profile": substrate,
        "print_layer": "process-ink-v1",
        "finish_profile": finish,
        "spot_finish_mask": None,
        "substrate_rgba": list(rgba or [0.7, 0.7, 0.7, 1.0]),
        "roughness": roughness,
        "specular_ior_level": specular,
        "ink_color_space": "sRGB",
        "core_roughness": 0.6,
        "core_specular_ior_level": 0.5,
        "substrate_micro_normal": deepcopy(MICRO_NORMAL),
        "glb_export": {
            "roughness": True,
            "clearcoat": False,
            "normal": True,
            "extensions": [],
        },
        **(extra or {}),
    }
    return profile


def unsigned_registry(profiles: list[dict], path: Path) -> Path:
    payload = {"schema": "packaging-render-profile-registry/1", "profiles": []}
    for profile in profiles:
        item = deepcopy(profile)
        item["declared_sha256"] = "sha256:" + "0" * 64
        payload["profiles"].append(item)
    return write_registry(path, payload)


def signed_registry(contract, profiles: list[dict], path: Path) -> Path:
    payload = {"schema": "packaging-render-profile-registry/1", "profiles": []}
    for profile in profiles:
        signed = deepcopy(profile)
        refresh_profile_hash(contract, signed)
        payload["profiles"].append(signed)
    return write_registry(path, payload)


def layers_of(contract, material: dict) -> dict:
    return contract.resolved_material_layers(material)


def test_published_registry_keeps_legacy_visual_identities_without_new_material_fields():
    contract = contract_module()
    production = contract.load_profile_registry()
    assert list(production["profiles"]) == list(PUBLISHED_PROFILE_SHA256)
    for profile_id, digest in PUBLISHED_PROFILE_SHA256.items():
        profile = production["profiles"][profile_id]
        assert profile["profile_sha256"] == digest
        material = profile["material"]
        assert set(material) == {
            "substrate_profile",
            "print_layer",
            "finish_profile",
            "spot_finish_mask",
            "substrate_rgba",
            "roughness",
            "specular_ior_level",
        }
        assert material["substrate_profile"] == "white-card-default-v1"
        assert material["finish_profile"] == "none"
        assert material["roughness"] == 0.52
        assert material["specular_ior_level"] == 0.08
        spec = contract.resolve_render_spec(carton_job(), profile_id)
        flat = contract.current_renderer_config(spec)
        assert "material_coat_weight" not in flat
        assert "ink_color_space" not in flat
        assert spec["color"]["view_transform"] == "Standard"
    assert json.loads(CURRENT_TEMPLATE.read_text(encoding="utf-8"))["render_profile_id"] == "compat-legacy-v0"
    matrix = contract.render_capability_matrix()
    assert all(
        entry["substrate_profile"] == "white-card-default-v1"
        for entries in matrix.values()
        for entry in entries
    )


@pytest.mark.parametrize(
    "substrate",
    ["dark-paper-v1", "metal-paper-v1", "pearl-paper-v1", "kraft"],
)
def test_unknown_or_implicit_substrate_names_fail_closed(tmp_path, substrate):
    contract = contract_module()
    profile = material_candidate("packshot-material-invalid-v1", substrate=substrate)
    unsigned_registry([profile], tmp_path / "bad.json")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.load_profile_registry(tmp_path / "bad.json"),
    )


@pytest.mark.parametrize("finish", ["spot-uv-v1", "foil-stamping-v1", "window-v1", "matte"])
def test_unknown_or_spot_finish_names_fail_closed(tmp_path, finish):
    contract = contract_module()
    profile = material_candidate("packshot-material-invalid-v1", finish=finish)
    unsigned_registry([profile], tmp_path / "bad.json")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.load_profile_registry(tmp_path / "bad.json"),
    )


def test_spot_mask_without_independent_semantics_is_unsupported(tmp_path):
    contract = contract_module()
    profile = material_candidate("packshot-material-invalid-v1")
    profile["material"]["spot_finish_mask"] = "panel_front.png"
    unsigned_registry([profile], tmp_path / "bad.json")
    assert_error(
        contract,
        "render_finish_mask_unsupported",
        lambda: contract.load_profile_registry(tmp_path / "bad.json"),
    )


def test_new_material_fields_are_rejected_on_legacy_spec_without_changing_old_hash():
    contract = contract_module()
    spec = contract.resolve_render_spec(carton_job(), "packshot-carton-geometry-v1")
    before = spec["render_contract_hash"]
    spec["material"]["coat_weight"] = 1.0
    spec["material"]["coat_roughness"] = 0.08
    spec["render_contract_hash"] = contract.render_contract_sha256(spec)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_render_spec(spec),
    )
    fresh = contract.resolve_render_spec(carton_job(), "packshot-carton-geometry-v1")
    assert fresh["render_contract_hash"] == before


@pytest.mark.parametrize(
    "mutate",
    [
        lambda material: material.update({"coat_weight": True}),
        lambda material: material.update({"coat_weight": 1.0, "coat_roughness": float("nan")}),
        lambda material: material.update({"ink_color_space": "Linear"}),
        lambda material: material["substrate_micro_normal"].update({"color_space": "sRGB"}),
        lambda material: material["substrate_micro_normal"].update({"size_px": 4096}),
        lambda material: material["substrate_micro_normal"].update({"seed": -1}),
        lambda material: material.update({"glb_export": {"roughness": True, "clearcoat": True, "normal": True, "extensions": []}}),
    ],
)
def test_new_schema_fields_reject_type_range_colorspace_and_unbounded_normals(tmp_path, mutate):
    contract = contract_module()
    profile = material_candidate(
        "packshot-material-invalid-v1",
        finish="overall-gloss-varnish-v1",
        extra={
            "coat_weight": 1.0,
            "coat_roughness": 0.08,
            "glb_export": {
                "roughness": True,
                "clearcoat": True,
                "normal": True,
                "extensions": ["KHR_materials_clearcoat"],
            },
        },
    )
    mutate(profile["material"])
    unsigned_registry([profile], tmp_path / "bad.json")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.load_profile_registry(tmp_path / "bad.json"),
    )


def test_none_and_matte_cannot_smuggle_coat_fields(tmp_path):
    contract = contract_module()
    profile = material_candidate(
        "packshot-material-invalid-v1",
        extra={"coat_weight": 0.2, "coat_roughness": 0.1},
    )
    unsigned_registry([profile], tmp_path / "bad.json")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.load_profile_registry(tmp_path / "bad.json"),
    )


def test_gloss_requires_explicit_coat_and_glb_declaration(tmp_path):
    contract = contract_module()
    profile = material_candidate(
        "packshot-material-invalid-v1",
        finish="overall-gloss-varnish-v1",
        roughness=0.22,
    )
    unsigned_registry([profile], tmp_path / "bad.json")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.load_profile_registry(tmp_path / "bad.json"),
    )


def test_geometry_and_material_substrate_must_match(tmp_path):
    contract = contract_module()
    profile = material_candidate("packshot-material-invalid-v1", substrate="kraft-card-v1", rgba=KRAFT_RGBA)
    profile["geometry"]["rectangular_carton_v1"]["substrate_profile"] = "white-card-default-v1"
    unsigned_registry([profile], tmp_path / "bad.json")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.load_profile_registry(tmp_path / "bad.json"),
    )


def test_experimental_candidates_cover_white_kraft_and_overall_finishes(tmp_path):
    contract = contract_module()
    profiles = [
        material_candidate("packshot-material-white-none-v1"),
        material_candidate(
            "packshot-material-kraft-none-v1",
            substrate="kraft-card-v1",
            rgba=KRAFT_RGBA,
            roughness=0.58,
            specular=0.06,
            extra={"core_roughness": 0.62},
        ),
        material_candidate(
            "packshot-material-white-matte-v1",
            finish="overall-matte-lamination-v1",
            roughness=0.86,
            specular=0.04,
            extra={"core_roughness": 0.86},
        ),
        material_candidate(
            "packshot-material-white-gloss-v1",
            finish="overall-gloss-varnish-v1",
            roughness=0.22,
            specular=0.18,
            extra={
                "coat_weight": 1.0,
                "coat_roughness": 0.08,
                "glb_export": {
                    "roughness": True,
                    "clearcoat": True,
                    "normal": True,
                    "extensions": ["KHR_materials_clearcoat"],
                },
            },
        ),
    ]
    registry_path = signed_registry(contract, profiles, tmp_path / "rf06.json")
    registry = contract.load_profile_registry(registry_path)
    production = contract.load_profile_registry()
    assert "packshot-material-kraft-none-v1" not in production["profiles"]
    kraft = contract.resolve_render_spec(
        carton_job(),
        "packshot-material-kraft-none-v1",
        registry_path=registry_path,
    )
    white = contract.resolve_render_spec(
        carton_job(),
        "packshot-material-white-none-v1",
        registry_path=registry_path,
    )
    matte = contract.resolve_render_spec(
        carton_job(),
        "packshot-material-white-matte-v1",
        registry_path=registry_path,
    )
    gloss = contract.resolve_render_spec(
        carton_job(),
        "packshot-material-white-gloss-v1",
        registry_path=registry_path,
    )
    published = contract.resolve_render_spec(carton_job(), "packshot-carton-geometry-v1")
    assert kraft["material"]["substrate_profile"] == "kraft-card-v1"
    assert kraft["material"]["substrate_rgba"] == KRAFT_RGBA
    assert matte["material"]["finish_profile"] == "overall-matte-lamination-v1"
    assert gloss["material"]["coat_weight"] == 1.0
    assert kraft["render_contract_hash"] != white["render_contract_hash"]
    assert white["render_contract_hash"] != published["render_contract_hash"]
    assert contract.current_renderer_config(gloss, registry_path=registry_path)["material_coat_weight"] == 1.0
    assert "material_coat_weight" not in contract.current_renderer_config(published)
    assert registry["registry_sha256"] != production["registry_sha256"]


def test_experimental_spec_replays_through_blender_geometry_entry_without_registry_path():
    contract = contract_module()
    plan = contract.render_plan_for_experimental_material_job(
        carton_job(), "packshot-material-kraft-none-v1"
    )
    job = {
        **carton_job(),
        "render_spec": plan["spec"],
        "render": plan["render"],
        **plan["identity"],
    }
    geometry = contract.renderer_geometry_config(job)
    assert geometry["family"] == "rectangular_carton_v1"
    assert geometry["closure_detail"] == "closed-carton-shell-v1"
    assert geometry["substrate_profile"] == "kraft-card-v1"
    layers = contract.material_runtime_from_job(job)
    assert layers["substrate"]["profile"] == "kraft-card-v1"
    replayed = contract.validate_render_spec(plan["spec"])
    assert replayed["material"]["substrate_profile"] == "kraft-card-v1"
    with pytest.raises(contract.RenderContractError):
        contract.render_plan_for_new_job(carton_job(), "packshot-material-kraft-none-v1")


def test_diagnostic_entry_does_not_register_production_defaults():
    contract = contract_module()
    path = contract.EXPERIMENTAL_MATERIAL_REGISTRY_PATH
    assert path == EXPERIMENTAL_REGISTRY
    assert path != contract.DEFAULT_REGISTRY_PATH
    production = contract.load_profile_registry()
    experimental = contract.load_experimental_material_registry()
    for profile_id in (
        "packshot-material-white-none-v1",
        "packshot-material-kraft-none-v1",
        "packshot-material-white-matte-v1",
        "packshot-material-white-gloss-v1",
    ):
        assert profile_id not in production["profiles"]
        assert profile_id in experimental["profiles"]
    plan = contract.render_plan_for_experimental_material_job(
        carton_job(), "packshot-material-kraft-none-v1"
    )
    assert plan["identity"]["render_profile_id"] == "packshot-material-kraft-none-v1"
    assert plan["spec"]["material"]["substrate_profile"] == "kraft-card-v1"
    with pytest.raises(contract.RenderContractError):
        contract.render_plan_for_new_job(carton_job(), "packshot-material-kraft-none-v1")


def test_material_layers_are_resolved_in_one_place_and_do_not_guess_from_artwork():
    contract = contract_module()
    published = contract.resolve_render_spec(carton_job(), "packshot-carton-geometry-v1")
    layers = layers_of(contract, published["material"])
    assert set(layers) >= {"substrate", "ink", "overall_finish", "spot_finish", "still", "glb_export"}
    assert layers["substrate"]["profile"] == "white-card-default-v1"
    assert layers["ink"]["print_layer"] == "process-ink-v1"
    assert layers["ink"]["color_space"] == "sRGB"
    assert layers["ink"]["alpha"] == "MASK"
    assert layers["overall_finish"]["profile"] == "none"
    assert layers["spot_finish"]["supported"] is False
    assert layers["spot_finish"]["mask"] is None
    assert layers["still"]["coat"] is False
    assert layers["still"]["normal"] is False
    assert layers["glb_export"]["clearcoat"] is False
    assert layers["glb_export"]["normal"] is False
    brown = carton_job()
    brown["average_color"] = [0.55, 0.38, 0.18]
    brown["sku"] = "KRAFT-001"
    brown["filename"] = "kraft-box.ai"
    resolved = contract.resolve_render_spec(brown, "packshot-carton-geometry-v1")
    assert resolved["material"]["substrate_profile"] == "white-card-default-v1"
    assert resolved["material"]["substrate_rgba"] == [0.7, 0.7, 0.7, 1.0]


def test_experimental_layers_keep_core_opaque_and_declare_color_spaces():
    contract = contract_module()
    experimental = contract.load_experimental_material_registry()
    gloss = experimental["profiles"]["packshot-material-white-gloss-v1"]["material"]
    layers = layers_of(contract, gloss)
    plan = contract.blender_material_plan(layers)
    assert plan["ink_color_space"] == "sRGB"
    assert plan["normal_color_space"] == "Non-Color"
    assert plan["alpha"] == "MASK"
    assert plan["core_opaque"] is True
    assert plan["face_use_coat"] is True
    assert plan["core_use_coat"] is False
    assert plan["use_normal"] is True
    assert layers["still"]["coat"] is True
    assert layers["glb_export"]["extensions"] == ["KHR_materials_clearcoat"]
    kraft = experimental["profiles"]["packshot-material-kraft-none-v1"]["material"]
    kraft_layers = layers_of(contract, kraft)
    assert kraft_layers["substrate"]["rgba"] == KRAFT_RGBA
    assert kraft_layers["still"]["coat"] is False
    assert kraft_layers["still"]["normal"] is True


def test_micro_normal_bytes_are_bounded_deterministic_and_non_color():
    contract = contract_module()
    first = contract.substrate_micro_normal_png_bytes(MICRO_NORMAL)
    second = contract.substrate_micro_normal_png_bytes(MICRO_NORMAL)
    other = contract.substrate_micro_normal_png_bytes({**MICRO_NORMAL, "seed": 8})
    assert first == second
    assert other != first
    decoded = glb_verify()._decode_png_rgba(first)
    assert decoded["width"] == 64
    assert decoded["height"] == 64
    assert decoded["transparent_pixels"] == 0
    pixels = _png_rgba_bytes(first)
    blues = pixels[2::4]
    assert min(blues) >= 200
    assert contract.blender_material_plan(
        layers_of(
            contract,
            material_candidate("packshot-material-white-none-v1")["material"],
        )
    )["normal_color_space"] == "Non-Color"


def test_new_material_parameters_enter_fingerprint_and_miss_old_cache():
    contract = contract_module()
    published = contract.render_plan_for_new_job(carton_job(), "packshot-carton-geometry-v1")
    experimental = contract.render_plan_for_experimental_material_job(
        carton_job(), "packshot-material-white-none-v1"
    )
    kraft = contract.render_plan_for_experimental_material_job(
        carton_job(), "packshot-material-kraft-none-v1"
    )
    gloss = contract.render_plan_for_experimental_material_job(
        carton_job(), "packshot-material-white-gloss-v1"
    )
    assert published["fingerprint_token"] != experimental["fingerprint_token"]
    assert experimental["fingerprint_token"] != kraft["fingerprint_token"]
    assert kraft["fingerprint_token"] != gloss["fingerprint_token"]
    assert published["spec"]["material"]["roughness"] == 0.52
    assert published["render"]["material_roughness"] == 0.52
    assert published["render"]["view_transform"] == "Standard"


def test_legacy_job_runtime_does_not_invent_coat_or_spot_finish():
    contract = contract_module()
    job = {
        "render": {
            "substrate_rgba": [0.7, 0.7, 0.7, 1.0],
            "material_roughness": 0.52,
            "material_specular_ior": 0.08,
        }
    }
    layers = contract.material_runtime_from_job(job)
    assert layers["overall_finish"]["profile"] == "none"
    assert layers["still"]["coat"] is False
    assert layers["still"]["normal"] is False
    assert layers["spot_finish"]["supported"] is False
    assert layers["visual"]["core_roughness"] == 0.6
    assert layers["visual"]["face_roughness"] == 0.52
    assert layers["visual"]["core_specular_ior_level"] == 0.5
    assert layers["visual"]["specular_ior_level"] == 0.08
    published = contract.resolve_render_spec(carton_job(), "packshot-carton-geometry-v1")
    assert "core_specular_ior_level" not in published["material"]
    assert published["render_contract_hash"] == contract.render_contract_sha256(published)
    plan = contract.blender_material_plan(contract.resolved_material_layers(published["material"]))
    assert plan["core_specular_ior_level"] == 0.5
    assert plan["ink_specular_ior_level"] == 0.08
    assert plan["core_use_coat"] is False
    assert plan["face_use_coat"] is False


def test_white_and_kraft_core_parameters_are_explicit_and_uncoated():
    contract = contract_module()
    white = contract.load_experimental_material_registry()["profiles"]["packshot-material-white-none-v1"]["material"]
    kraft = contract.load_experimental_material_registry()["profiles"]["packshot-material-kraft-none-v1"]["material"]
    gloss = contract.load_experimental_material_registry()["profiles"]["packshot-material-white-gloss-v1"]["material"]
    white_plan = contract.blender_material_plan(layers_of(contract, white))
    kraft_plan = contract.blender_material_plan(layers_of(contract, kraft))
    gloss_plan = contract.blender_material_plan(layers_of(contract, gloss))
    assert white_plan["substrate_rgba"] == [0.7, 0.7, 0.7, 1.0]
    assert white_plan["core_roughness"] == 0.6
    assert white_plan["core_specular_ior_level"] == 0.5
    assert kraft_plan["substrate_rgba"] == KRAFT_RGBA
    assert kraft_plan["core_roughness"] == 0.62
    assert kraft_plan["core_specular_ior_level"] == 0.5
    assert gloss_plan["face_use_coat"] is True
    assert gloss_plan["core_use_coat"] is False
    assert gloss_plan["ink_specular_ior_level"] == 0.18
    assert gloss_plan["core_specular_ior_level"] == 0.5
    assert gloss_plan["core_roughness"] == 0.6


def test_synthetic_glb_reports_missing_clearcoat_instead_of_self_declaring_support(tmp_path):
    contract = contract_module()
    module = glb_verify()
    artifact, assets = _material_artifact(module, tmp_path)
    for material in artifact.document["materials"][:6]:
        material["pbrMetallicRoughness"]["roughnessFactor"] = 0.22
    artifact.document["materials"][-1]["pbrMetallicRoughness"]["roughnessFactor"] = 0.6
    layers = layers_of(
        contract,
        material_candidate(
            "packshot-material-white-gloss-v1",
            finish="overall-gloss-varnish-v1",
            roughness=0.22,
            specular=0.18,
            extra={
                "coat_weight": 1.0,
                "coat_roughness": 0.08,
                "glb_export": {
                    "roughness": True,
                    "clearcoat": True,
                    "normal": True,
                    "extensions": ["KHR_materials_clearcoat"],
                },
            },
        )["material"],
    )
    report = module.compare_glb_pbr_capability(artifact, layers)
    assert report["ok"] is False
    assert any(error["code"] == "glb_clearcoat_not_exported" for error in report["errors"])
    assert report["still"]["coat"] is True
    assert report["glb_declared"]["clearcoat"] is True
    assert report["glb_observed"]["clearcoat"] is False


def test_synthetic_glb_accepts_exported_clearcoat_normal_and_keeps_mask_artwork(tmp_path):
    contract = contract_module()
    module = glb_verify()
    artifact, assets = _pbr_carton_artifact(module, contract, tmp_path)
    layers = _gloss_layers(contract)
    pbr = module.compare_glb_pbr_capability(artifact, layers)
    assert pbr["ok"], pbr
    material_report = module.compare_glb_material_contract(
        artifact, assets, [0.7, 0.7, 0.7, 1.0], pbr=layers
    )
    assert material_report["ok"], material_report
    assert "KHR_materials_clearcoat" in material_report["pbr"]["glb_observed"]["extensions_used"]
    front = artifact.document["materials"][0]
    assert front["alphaMode"] == "MASK"
    core = artifact.document["materials"][-1]
    assert core.get("alphaMode", "OPAQUE") == "OPAQUE"
    coat = (core.get("extensions") or {}).get("KHR_materials_clearcoat") if isinstance(core.get("extensions"), dict) else None
    assert not coat or float(coat.get("clearcoatFactor") or 0) == 0


def test_honest_still_vs_glb_degradation_is_machine_readable(tmp_path):
    contract = contract_module()
    module = glb_verify()
    artifact, _assets = _material_artifact(module, tmp_path)
    for index, material in enumerate(artifact.document["materials"]):
        material.setdefault("pbrMetallicRoughness", {})["roughnessFactor"] = (
            0.6 if index == 6 else 0.22
        )
    layers = layers_of(
        contract,
        material_candidate(
            "packshot-material-white-gloss-v1",
            finish="overall-gloss-varnish-v1",
            roughness=0.22,
            extra={
                "coat_weight": 1.0,
                "coat_roughness": 0.08,
                "glb_export": {
                    "roughness": True,
                    "clearcoat": False,
                    "normal": False,
                    "extensions": [],
                },
            },
        )["material"],
    )
    report = module.compare_glb_pbr_capability(artifact, layers)
    assert report["ok"] is True
    assert any(item["channel"] == "coat" for item in report["differences"])
    coat = next(item for item in report["differences"] if item["channel"] == "coat")
    assert coat["still"] is True
    assert coat["glb"] is False
    assert "KHR_materials_clearcoat" in coat["message"]


def test_pbr_capability_does_not_treat_missing_normal_as_support(tmp_path):
    contract = contract_module()
    module = glb_verify()
    artifact, _assets = _material_artifact(module, tmp_path)
    layers = layers_of(contract, material_candidate("packshot-material-white-none-v1")["material"])
    report = module.compare_glb_pbr_capability(artifact, layers)
    assert report["ok"] is False
    assert any(error["code"] == "glb_normal_not_exported" for error in report["errors"])


def _append_view(module, artifact, payload: bytes) -> tuple[object, int]:
    binary = bytearray(artifact.binary)
    offset = len(binary)
    binary.extend(payload)
    binary.extend(b"\x00" * ((4 - len(binary) % 4) % 4))
    view = len(artifact.document["bufferViews"])
    artifact.document["bufferViews"].append(
        {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
    )
    artifact.document["buffers"][0]["byteLength"] = len(binary)
    return module.GlbArtifact(artifact.document, bytes(binary)), view


def _pbr_carton_artifact(module, contract, tmp_path, *, assets=None, dimensions=None, substrate=None, extras=None):
    artifact, used_assets = _runtime_artifact(
        module,
        tmp_path,
        expected_assets=assets,
        dimensions=dimensions or {"width": 30, "depth": 20, "height": 50},
        substrate=substrate or [0.7, 0.7, 0.7, 1.0],
    )
    normal_png = contract.substrate_micro_normal_png_bytes(MICRO_NORMAL)
    artifact, view = _append_view(module, artifact, normal_png)
    core_uvs = [[0.0, 0.0]] * artifact.document["accessors"][
        artifact.document["meshes"][-1]["primitives"][0]["attributes"]["POSITION"]
    ]["count"]
    uv_payload = b"".join(__import__("struct").pack("<ff", *uv) for uv in core_uvs)
    artifact, uv_view = _append_view(module, artifact, uv_payload)
    uv_accessor = len(artifact.document["accessors"])
    artifact.document["accessors"].append(
        {"bufferView": uv_view, "componentType": 5126, "count": len(core_uvs), "type": "VEC2"}
    )
    artifact.document["meshes"][-1]["primitives"][0]["attributes"]["TEXCOORD_0"] = uv_accessor
    image_index = len(artifact.document["images"])
    artifact.document["images"].append(
        {"name": "micro_normal", "bufferView": view, "mimeType": "image/png"}
    )
    texture_index = len(artifact.document["textures"])
    artifact.document["textures"].append({"source": image_index})
    artifact.document["extensionsUsed"] = ["KHR_materials_clearcoat"]
    for index, material in enumerate(artifact.document["materials"]):
        pbr = material.setdefault("pbrMetallicRoughness", {})
        pbr["roughnessFactor"] = 0.6 if index == 6 else 0.22
        if index != 6:
            material["normalTexture"] = {"index": texture_index, "scale": 0.12, "texCoord": 0}
            material["extensions"] = {
                "KHR_materials_clearcoat": {
                    "clearcoatFactor": 1.0,
                    "clearcoatRoughnessFactor": 0.08,
                }
            }
    if extras:
        for node in artifact.document["nodes"]:
            if isinstance(node, dict) and "mesh" in node:
                node["extras"] = dict(extras)
    return module.GlbArtifact(artifact.document, artifact.binary), used_assets


def _gloss_layers(contract):
    return layers_of(
        contract,
        material_candidate(
            "packshot-material-white-gloss-v1",
            finish="overall-gloss-varnish-v1",
            roughness=0.22,
            specular=0.18,
            extra={
                "coat_weight": 1.0,
                "coat_roughness": 0.08,
                "glb_export": {
                    "roughness": True,
                    "clearcoat": True,
                    "normal": True,
                    "extensions": ["KHR_materials_clearcoat"],
                },
            },
        )["material"],
    )


def _gloss_identity(contract, *, assets, dimensions, substrate):
    plan = contract.render_plan_for_experimental_material_job(
        carton_job(dimensions=dimensions),
        "packshot-material-white-gloss-v1",
    )
    return {
        "assets": assets,
        "dimensions_mm": dimensions,
        "render_spec": plan["spec"],
        "render": plan["render"],
        **plan["identity"],
    }


def test_pbr_rejects_zero_normal_scale_even_when_pixels_match(tmp_path):
    contract = contract_module()
    module = glb_verify()
    artifact, _assets = _pbr_carton_artifact(module, contract, tmp_path)
    layers = _gloss_layers(contract)
    assert module.compare_glb_pbr_capability(artifact, layers)["ok"]
    for material in artifact.document["materials"]:
        if isinstance(material.get("normalTexture"), dict):
            material["normalTexture"]["scale"] = 0
    report = module.compare_glb_pbr_capability(artifact, layers)
    assert report["ok"] is False
    assert any(error["code"] == "glb_normal_scale_invalid" for error in report["errors"])


@pytest.mark.parametrize(
    "damage,code",
    [
        ("nan_scale", "glb_normal_scale_invalid"),
        ("bool_scale", "glb_normal_scale_invalid"),
        ("bad_texcoord", "glb_normal_texcoord_unbound"),
        ("roughness_texture", "glb_roughness_texture_override_unsupported"),
        ("clearcoat_texture", "glb_clearcoat_texture_override_unsupported"),
        ("normal_transform", "glb_normal_texture_override_unsupported"),
    ],
)
def test_pbr_rejects_scalar_and_unsupported_texture_overrides(tmp_path, damage, code):
    contract = contract_module()
    module = glb_verify()
    artifact, _assets = _pbr_carton_artifact(module, contract, tmp_path)
    face = artifact.document["materials"][0]
    if damage == "nan_scale":
        face["normalTexture"]["scale"] = float("nan")
    elif damage == "bool_scale":
        face["normalTexture"]["scale"] = True
    elif damage == "bad_texcoord":
        face["normalTexture"]["texCoord"] = 1
    elif damage == "roughness_texture":
        face["pbrMetallicRoughness"]["metallicRoughnessTexture"] = {"index": 0}
    elif damage == "clearcoat_texture":
        face["extensions"]["KHR_materials_clearcoat"]["clearcoatTexture"] = {"index": 0}
    else:
        face["normalTexture"]["extensions"] = {"KHR_texture_transform": {"scale": [2, 2]}}
    report = module.compare_glb_pbr_capability(artifact, _gloss_layers(contract))
    assert report["ok"] is False
    assert any(error["code"] == code for error in report["errors"])


def test_artifact_contract_rejects_removed_clearcoat_when_spec_declares_it(tmp_path):
    contract = contract_module()
    module = glb_verify()
    identity = _gloss_identity(
        contract,
        assets={},
        dimensions={"width": 30, "depth": 20, "height": 50},
        substrate=[0.7, 0.7, 0.7, 1.0],
    )
    geometry = identity["render_spec"]["geometry"]
    artifact, assets = _pbr_carton_artifact(
        module,
        contract,
        tmp_path,
        extras={
            "render_family": geometry["family"],
            "geometry_model": geometry["closure_detail"],
            "render_profile_id": identity["render_profile_id"],
            "render_contract_hash": identity["render_contract_hash"],
        },
    )
    identity["assets"] = assets
    good = module.compare_glb_artifact_contract(
        artifact,
        assets,
        identity["dimensions_mm"],
        0.5,
        identity["render"]["substrate_rgba"],
        render_identity=identity,
    )
    assert good["ok"], good
    for material in artifact.document["materials"]:
        material.pop("extensions", None)
    artifact.document.pop("extensionsUsed", None)
    report = module.compare_glb_artifact_contract(
        artifact,
        assets,
        identity["dimensions_mm"],
        0.5,
        identity["render"]["substrate_rgba"],
        render_identity=identity,
    )
    assert report["ok"] is False
    pbr = report.get("pbr") or report.get("material", {}).get("pbr")
    assert pbr and pbr["ok"] is False
    assert any(error["code"] == "glb_clearcoat_not_exported" for error in (pbr.get("errors") or report.get("errors") or []))


def test_artwork_png_identity_is_unchanged_when_normal_is_attached(tmp_path):
    module = glb_verify()
    artifact, assets = _material_artifact(module, tmp_path)
    before = {
        face: Path(assets[face]).read_bytes()
        for face in module.SEMANTIC_FACES
    }
    report = module.compare_glb_material_contract(artifact, assets, [1.0, 1.0, 1.0, 1.0])
    assert report["ok"]
    after = {
        face: Path(assets[face]).read_bytes()
        for face in module.SEMANTIC_FACES
    }
    assert after == before


def _png_rgba_bytes(payload: bytes) -> bytes:
    decoded = glb_verify()._decode_png_rgba(payload)
    width, height = decoded["width"], decoded["height"]
    image = Image.open(__import__("io").BytesIO(payload))
    assert image.size == (width, height)
    return image.convert("RGBA").tobytes()


def _face_png(path: Path, color: tuple[int, int, int], *, hole: bool) -> None:
    image = Image.new("RGBA", (8, 8), (*color, 255))
    if hole:
        image.putpixel((0, 0), (*color, 0))
    image.save(path)


@pytest.mark.native
def test_native_blender_exports_actual_glb_material_subset(tmp_path):
    blender = shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender"
    assert Path(blender).exists(), "explicit native check needs Blender"
    contract = contract_module()
    module = glb_verify()
    assets = {}
    original_png = {}
    for index, face in enumerate(FACES):
        path = tmp_path / "assets" / f"panel_{face}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        _face_png(path, (30 + index * 20, 40, 90), hole=True)
        assets[face] = str(path)
        original_png[face] = path.read_bytes()
    plan = contract.render_plan_for_experimental_material_job(
        carton_job(dimensions={"width": 30, "depth": 20, "height": 50}),
        "packshot-material-white-gloss-v1",
    )
    job = {
        "code": "synthetic",
        "display_name": "synthetic",
        "source_ai": "SYNTHETIC_NOT_CUSTOMER",
        "project_dir": str(tmp_path),
        "assets": assets,
        "dimensions_mm": {"width": 30, "depth": 20, "height": 50},
        "glb_tolerance_mm": 0.5,
        "render_spec": plan["spec"],
        "render": plan["render"],
        **plan["identity"],
        "outputs": {
            "glb": str(tmp_path / "actual.glb"),
            "blend": str(tmp_path / "actual.blend"),
        },
    }
    job_path = tmp_path / "job.json"
    job_path.write_text(json.dumps(job), encoding="utf-8")
    inspect_path = tmp_path / "node_colorspaces.json"
    script = tmp_path / "export_materials.py"
    script.write_text(
        "import importlib.util, json\n"
        f"spec=importlib.util.spec_from_file_location('renderer', {str(PACKAGING / 'blender' / 'render_job.py')!r})\n"
        "renderer=importlib.util.module_from_spec(spec); spec.loader.exec_module(renderer)\n"
        f"job=json.load(open({str(job_path)!r}))\n"
        "renderer.clean_scene()\n"
        "root, objects=renderer.build_model(job, job['render_spec']['geometry'])\n"
        "report=[]\n"
        "for obj in objects:\n"
        "    for material in obj.data.materials:\n"
        "        if not material or not material.use_nodes: continue\n"
        "        for node in material.node_tree.nodes:\n"
        "            if node.type=='TEX_IMAGE' and getattr(node, 'image', None):\n"
        "                report.append({'material': material.name, 'image': node.image.name, 'colorspace': node.image.colorspace_settings.name})\n"
        "            if node.type=='BSDF_PRINCIPLED':\n"
        "                coat=node.inputs['Coat Weight'].default_value if 'Coat Weight' in node.inputs else 0\n"
        "                spec=node.inputs['Specular IOR Level'].default_value if 'Specular IOR Level' in node.inputs else None\n"
        "                report.append({'material': material.name, 'kind': 'bsdf', 'specular': spec, 'roughness': node.inputs['Roughness'].default_value, 'coat': coat})\n"
        f"json.dump(report, open({str(inspect_path)!r}, 'w'))\n"
        "renderer.export_model(job, root, objects)\n",
        encoding="utf-8",
    )
    completed = subprocess.run(
        [
            blender,
            "--background",
            "--factory-startup",
            "--python-exit-code",
            "1",
            "--python",
            str(script),
        ],
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert completed.returncode == 0, (completed.stdout + completed.stderr)[-4000:]
    colorspaces = json.loads(inspect_path.read_text(encoding="utf-8"))
    ink_spaces = {
        row["colorspace"]
        for row in colorspaces
        if row.get("image", "").lower().startswith("panel_")
    }
    normal_spaces = {
        row["colorspace"]
        for row in colorspaces
        if "micro" in row.get("image", "").lower() or "normal" in row.get("image", "").lower()
    }
    assert ink_spaces == {"sRGB"}
    assert normal_spaces == {"Non-Color"}
    core_bsdf = next(row for row in colorspaces if row.get("kind") == "bsdf" and row["material"] == "MAT_PaperboardEdge")
    face_bsdf = next(row for row in colorspaces if row.get("kind") == "bsdf" and row["material"] == "MAT_front")
    assert core_bsdf["specular"] == pytest.approx(0.5, abs=1e-5)
    assert core_bsdf["coat"] == pytest.approx(0.0, abs=1e-5)
    assert face_bsdf["specular"] == pytest.approx(0.18, abs=1e-5)
    assert face_bsdf["coat"] == pytest.approx(1.0, abs=1e-5)
    artifact = module.load_glb_artifact(job["outputs"]["glb"])
    sys.path.insert(0, str(PACKAGING))
    layers = contract.material_runtime_from_job(job)
    pbr = module.compare_glb_pbr_capability(artifact, layers)
    assert pbr["ok"], pbr
    material_report = module.compare_glb_material_contract(
        artifact, assets, job["render"]["substrate_rgba"], pbr=layers
    )
    assert material_report["ok"], material_report
    assert artifact.document.get("extensionsUsed") and "KHR_materials_clearcoat" in artifact.document["extensionsUsed"]
    core_mat = next(m for m in artifact.document["materials"] if str(m.get("name", "")).lower().startswith("mat_paperboardedge"))
    coat = (core_mat.get("extensions") or {}).get("KHR_materials_clearcoat") if isinstance(core_mat.get("extensions"), dict) else None
    assert not coat or float(coat.get("clearcoatFactor") or 0) == 0
    for face in FACES:
        assert Path(assets[face]).read_bytes() == original_png[face]
    geometry = job["render_spec"]["geometry"]
    report = module.compare_glb_artifact_contract(
        artifact,
        assets,
        job["dimensions_mm"],
        0.5,
        job["render"]["substrate_rgba"],
        geometry=geometry,
        render_identity=job,
    )
    assert report["ok"], report
