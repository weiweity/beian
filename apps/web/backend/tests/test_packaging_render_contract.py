from __future__ import annotations

from copy import deepcopy
import importlib.util
import json
import math
from pathlib import Path

import pytest


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
CONTRACT_PATH = PACKAGING / "render_contract.py"
REGISTRY_PATH = PACKAGING / "profiles" / "render-profiles.v1.json"
CURRENT_TEMPLATE = PACKAGING / "templates" / "flower_box_47_5x47_5x177_5.json"
FACES = ("front", "right", "back", "left", "top", "bottom")


def contract_module():
    spec = importlib.util.spec_from_file_location(
        "packaging_render_contract", CONTRACT_PATH
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def carton_job(*, dimensions: dict | None = None) -> dict:
    return {
        "schema": "resolved-packaging-job/3",
        "structure_schema": "packaging-structure/1",
        "structure_hash": "sha256:" + "a" * 64,
        "dimensions_mm": dimensions or {"width": 47.5, "depth": 47.5, "height": 177.5},
        "faces": {face: {} for face in FACES},
        "validation": {"status": "accepted", "errors": [], "warnings": []},
    }


def pouch_job() -> dict:
    payload = carton_job(dimensions={"width": 140.0, "depth": 3.0, "height": 200.0})
    payload["packaging_family"] = "pouch"
    return payload


def registry_payload() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def write_registry(path: Path, payload: dict, *, indent: int | None = 2) -> Path:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=indent, allow_nan=True) + "\n",
        encoding="utf-8",
    )
    return path


def refresh_profile_hash(contract, profile: dict) -> None:
    profile["declared_sha256"] = contract.profile_declared_sha256(profile)


def assert_error(contract, code: str, call) -> None:
    with pytest.raises(contract.RenderContractError) as raised:
        call()
    assert raised.value.code == code
    assert raised.value.as_dict() == {
        "code": code,
        "message": str(raised.value),
        "details": raised.value.details,
    }


def test_registry_loads_three_strict_profiles_and_capability_matrix():
    contract = contract_module()
    registry = contract.load_profile_registry()

    assert registry["schema"] == "packaging-render-profile-registry/1"
    assert registry["registry_sha256"].startswith("sha256:")
    assert list(registry["profiles"]) == [
        "compat-legacy-v0",
        "packshot-neutral-v1",
        "smoke-v1",
    ]
    assert all(
        profile["profile_sha256"] == contract.profile_declared_sha256(profile)
        for profile in registry["profiles"].values()
    )

    matrix = contract.render_capability_matrix()
    assert [entry["profile_id"] for entry in matrix["rectangular_carton_v1"]] == [
        "compat-legacy-v0",
        "packshot-neutral-v1",
        "smoke-v1",
    ]
    assert matrix["pouch_thin_card_v1"] == [
        {
            "profile_id": "compat-legacy-v0",
            "substrate_profile": "white-card-default-v1",
            "finish_profile": "none",
            "studio_profile": "legacy-fixed-three-area-v0",
            "preview_fidelity": "thin_card",
        }
    ]
    assert "flexible_pouch_v1" not in matrix


def test_resolve_carton_uses_only_accepted_structure_dimensions_and_is_canonical():
    contract = contract_module()
    first = contract.resolve_render_spec(carton_job(), "compat-legacy-v0", {})
    reordered = carton_job(dimensions={"height": 177.5, "width": 47.5, "depth": 47.5})
    second = contract.resolve_render_spec(reordered, "compat-legacy-v0", {})

    assert first == second
    assert first["schema"] == "packaging-render-spec/1"
    assert first["source"] == "profile_resolved"
    assert first["geometry"]["family"] == "rectangular_carton_v1"
    assert first["geometry"]["outer_dimensions_mm"] == {
        "width": 47.5,
        "depth": 47.5,
        "height": 177.5,
    }
    assert first["render_contract_hash"].startswith("sha256:")
    assert contract.validate_render_spec(first) == first
    assert contract.validate_render_spec(contract.validate_render_spec(first)) == first


def test_output_request_is_small_fail_closed_and_part_of_contract_identity():
    contract = contract_module()
    default = contract.resolve_render_spec(carton_job(), "compat-legacy-v0", {})
    reduced = contract.resolve_render_spec(
        carton_job(),
        "compat-legacy-v0",
        {"ground_pass": False, "white_set_pass": False},
    )

    assert default["outputs"]["ground_pass"] == "optional"
    assert default["outputs"]["white_set_pass"] == "optional"
    assert reduced["outputs"]["ground_pass"] == "disabled"
    assert reduced["outputs"]["white_set_pass"] == "disabled"
    assert reduced["render_contract_hash"] != default["render_contract_hash"]

    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.resolve_render_spec(
            carton_job(), "compat-legacy-v0", {"dimensions_mm": {}}
        ),
    )
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.resolve_render_spec(
            carton_job(), "compat-legacy-v0", {"ground_pass": 1}
        ),
    )


def test_family_mapping_and_profile_capability_are_explicit():
    contract = contract_module()
    pouch = contract.resolve_render_spec(pouch_job(), "compat-legacy-v0", {})
    assert pouch["geometry"]["family"] == "pouch_thin_card_v1"
    assert pouch["geometry"]["preview_fidelity"] == "thin_card"

    assert_error(
        contract,
        "render_profile_unsupported",
        lambda: contract.resolve_render_spec(pouch_job(), "packshot-neutral-v1", {}),
    )
    assert_error(
        contract,
        "render_profile_unsupported",
        lambda: contract.resolve_render_spec(carton_job(), "not-registered", {}),
    )
    unknown = carton_job()
    unknown["packaging_family"] = "flexible_pouch_v1"
    assert_error(
        contract,
        "render_family_unsupported",
        lambda: contract.resolve_render_spec(unknown, "compat-legacy-v0", {}),
    )
    malformed_family = carton_job()
    malformed_family["packaging_family"] = ["carton"]
    assert_error(
        contract,
        "render_family_unsupported",
        lambda: contract.resolve_render_spec(malformed_family, "compat-legacy-v0", {}),
    )
    unsafe = carton_job()
    unsafe.pop("faces")
    assert_error(
        contract,
        "render_family_unsupported",
        lambda: contract.resolve_render_spec(unsafe, "compat-legacy-v0", {}),
    )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda payload: payload.update({"unknown": True}),
        lambda payload: payload["profiles"][0].update({"unknown": True}),
        lambda payload: payload["profiles"][0].update(
            {"profile_sha256": "sha256:" + "0" * 64}
        ),
        lambda payload: payload["profiles"][0]["material"].update({"unknown": True}),
        lambda payload: payload.update(
            {"schema": "packaging-render-profile-registry/999"}
        ),
        lambda payload: payload["profiles"][0].update(
            {"extends": "packshot-neutral-v1"}
        ),
        lambda payload: payload["profiles"].append(deepcopy(payload["profiles"][0])),
    ],
)
def test_registry_rejects_unknown_schema_fields_inheritance_and_duplicate_ids(
    tmp_path: Path, mutate
):
    contract = contract_module()
    payload = registry_payload()
    mutate(payload)
    candidate = write_registry(tmp_path / "registry.json", payload)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.load_profile_registry(candidate),
    )


@pytest.mark.parametrize(
    "raw",
    [
        '{"schema":"packaging-render-profile-registry/1","schema":"duplicate","profiles":[]}',
        '{"schema":"packaging-render-profile-registry/1","profiles":[],"bad":NaN}',
        '{"schema":"packaging-render-profile-registry/1","profiles":[],"bad":Infinity}',
    ],
)
def test_registry_rejects_duplicate_json_keys_and_nonfinite_literals(
    tmp_path: Path, raw: str
):
    contract = contract_module()
    candidate = tmp_path / "registry.json"
    candidate.write_text(raw, encoding="utf-8")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.load_profile_registry(candidate),
    )


def test_declared_profile_hash_and_base_registry_immutability(tmp_path: Path):
    contract = contract_module()
    payload = registry_payload()
    payload["profiles"][0]["material"]["roughness"] = 0.51
    stale = write_registry(tmp_path / "stale.json", payload)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.load_profile_registry(stale),
    )

    refresh_profile_hash(contract, payload["profiles"][0])
    rewritten = write_registry(tmp_path / "rewritten.json", payload)
    assert (
        contract.load_profile_registry(rewritten)["profiles"]["compat-legacy-v0"][
            "material"
        ]["roughness"]
        == 0.51
    )
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_registry_update(REGISTRY_PATH, rewritten),
    )

    reformatted = write_registry(
        tmp_path / "reformatted.json", registry_payload(), indent=None
    )
    update = contract.validate_registry_update(REGISTRY_PATH, reformatted)
    assert (
        update["registry_sha256"] != contract.load_profile_registry()["registry_sha256"]
    )


def test_registry_update_allows_only_append_for_existing_visual_identities(
    tmp_path: Path,
):
    contract = contract_module()
    payload = registry_payload()
    appended = deepcopy(payload["profiles"][2])
    appended["id"] = "smoke-fast-v2"
    appended["studio"]["master_resolution_px"] = [640, 768]
    refresh_profile_hash(contract, appended)
    payload["profiles"].append(appended)

    candidate = write_registry(tmp_path / "appended.json", payload)
    update = contract.validate_registry_update(REGISTRY_PATH, candidate)

    assert list(update["profiles"])[-1] == "smoke-fast-v2"
    assert update["profiles"]["smoke-fast-v2"]["studio"]["master_resolution_px"] == [
        640,
        768,
    ]


def test_explicit_request_cannot_enable_a_profile_disabled_output(tmp_path: Path):
    contract = contract_module()
    payload = registry_payload()
    smoke = payload["profiles"][2]
    smoke["outputs"]["ground_pass"] = "disabled"
    refresh_profile_hash(contract, smoke)
    candidate = write_registry(tmp_path / "no-ground.json", payload)

    assert_error(
        contract,
        "render_profile_unsupported",
        lambda: contract.resolve_render_spec(
            carton_job(),
            "smoke-v1",
            {"ground_pass": True},
            registry_path=candidate,
        ),
    )


@pytest.mark.parametrize("value", [True, 0, -1, float("nan"), float("inf"), 10_001])
def test_structure_dimensions_reject_boolean_nonfinite_and_out_of_range(value):
    contract = contract_module()
    dimensions = {"width": value, "depth": 47.5, "height": 177.5}
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.resolve_render_spec(
            carton_job(dimensions=dimensions), "compat-legacy-v0", {}
        ),
    )


def test_spec_rejects_unknown_missing_tampered_and_spot_finish_fields():
    contract = contract_module()
    original = contract.resolve_render_spec(carton_job(), "compat-legacy-v0", {})

    unknown = deepcopy(original)
    unknown["shots"]["magic_light"] = 1
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_render_spec(unknown),
    )

    non_text_key = deepcopy(original)
    non_text_key[1] = "not-a-field-name"
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_render_spec(non_text_key),
    )

    missing = deepcopy(original)
    missing.pop("sampling")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_render_spec(missing),
    )

    tampered = deepcopy(original)
    tampered["material"]["roughness"] = 0.2
    tampered["render_contract_hash"] = contract.render_contract_sha256(tampered)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_render_spec(tampered),
    )

    boolean_number = deepcopy(original)
    boolean_number["material"]["roughness"] = True
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_render_spec(boolean_number),
    )

    bad_samples = deepcopy(original)
    bad_samples["renderer"]["samples"] = True
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_render_spec(bad_samples),
    )

    color = deepcopy(original)
    color["color"]["exposure"] = 1.0
    color["render_contract_hash"] = contract.render_contract_sha256(color)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_render_spec(color),
    )

    finish = deepcopy(original)
    finish["material"]["spot_finish_mask"] = {"asset": "not-authorized.png"}
    assert_error(
        contract,
        "render_finish_mask_unsupported",
        lambda: contract.validate_render_spec(finish),
    )


def test_contract_hash_is_stable_for_equivalent_numbers_and_changes_with_semantics():
    contract = contract_module()
    integer = contract.resolve_render_spec(
        carton_job(dimensions={"width": 40, "depth": 30, "height": 80}),
        "compat-legacy-v0",
        {},
    )
    floating = contract.resolve_render_spec(
        carton_job(dimensions={"height": 80.0, "depth": 30.0, "width": 40.0}),
        "compat-legacy-v0",
        {},
    )
    different_size = contract.resolve_render_spec(
        carton_job(dimensions={"width": 41, "depth": 30, "height": 80}),
        "compat-legacy-v0",
        {},
    )
    different_profile = contract.resolve_render_spec(
        carton_job(), "packshot-neutral-v1", {}
    )

    assert integer == floating
    assert integer["render_contract_hash"] != different_size["render_contract_hash"]
    assert integer["render_contract_hash"] != different_profile["render_contract_hash"]

    changed_color = deepcopy(integer)
    changed_color["color"]["exposure"] = 0.25
    assert contract.render_contract_sha256(integer) != contract.render_contract_sha256(
        changed_color
    )


def test_minimum_readability_fails_before_silent_texture_downsampling():
    contract = contract_module()
    oversized = carton_job(dimensions={"width": 500.0, "depth": 500.0, "height": 500.0})

    with pytest.raises(contract.RenderContractError) as raised:
        contract.resolve_render_spec(oversized, "compat-legacy-v0", {})

    assert raised.value.code == "render_texture_budget_exceeded"
    assert raised.value.details == {
        "face": "front",
        "required_pixels": 100_000_000,
        "allowed_pixels": 32_000_000,
        "required_size_px": [10_000, 10_000],
        "target_pixels_per_mm": 20.0,
    }


def test_registry_byte_identity_is_distinct_from_semantic_contract_hash(tmp_path: Path):
    contract = contract_module()
    reformatted = write_registry(
        tmp_path / "registry.json", registry_payload(), indent=None
    )
    default_spec = contract.resolve_render_spec(carton_job(), "compat-legacy-v0", {})
    reformatted_spec = contract.resolve_render_spec(
        carton_job(),
        "compat-legacy-v0",
        {},
        registry_path=reformatted,
    )

    assert default_spec["registry_sha256"] != reformatted_spec["registry_sha256"]
    assert (
        default_spec["renderer"]["profile_sha256"]
        == reformatted_spec["renderer"]["profile_sha256"]
    )
    assert (
        default_spec["render_contract_hash"] == reformatted_spec["render_contract_hash"]
    )
    assert (
        contract.validate_render_spec(default_spec, registry_path=reformatted)
        == default_spec
    )


def test_compat_profile_matches_current_effective_renderer_parameters():
    contract = contract_module()
    template = json.loads(CURRENT_TEMPLATE.read_text(encoding="utf-8"))
    profile_hash = contract.load_profile_registry()["profiles"]["compat-legacy-v0"][
        "profile_sha256"
    ]
    spec = contract.resolve_render_spec(
        carton_job(dimensions=template["dimensions_mm"]),
        "compat-legacy-v0",
        {},
    )

    assert contract.current_renderer_config(spec) == {
        "substrate_rgba": [0.7, 0.7, 0.7, 1.0],
        "resolution_x": template["render"]["resolution_x"],
        "resolution_y": template["render"]["resolution_y"],
        "camera_ortho_scale_mm": template["render"]["camera_ortho_scale_mm"],
        "front_rotation_deg": template["render"]["front_rotation_deg"],
        "back_rotation_deg": template["render"]["back_rotation_deg"],
        "material_roughness": 0.52,
        "material_specular_ior": 0.08,
        "exact_white_background": True,
        "view_transform": "Standard",
        "look": "None",
        "exposure": 0.0,
        "world_strength": 0.62,
        "light_energy_scale": 4.0,
    }
    assert spec["renderer"] == {
        "engine": "BLENDER_EEVEE",
        "minimum_blender_version": "project-supported",
        "samples": 64,
        "profile": "compat-legacy-v0",
        "profile_sha256": profile_hash,
    }
    assert spec["color"] == {
        "view_transform": "Standard",
        "look": "None",
        "exposure": 0.0,
        "png_compression": 35,
        "color_depth_bits": 8,
    }
    assert spec["sampling"]["legacy_raster_width_px"] == template["raster_width_px"]
    assert spec["outputs"] == {
        "product_rgba": True,
        "ground_pass": "optional",
        "white_set_pass": "optional",
        "review_card_max_edge_px": 1440,
        "preserve_legacy_keys": True,
    }


def test_smoke_profile_is_bounded_and_cannot_claim_pouch_support():
    contract = contract_module()
    smoke = contract.resolve_render_spec(carton_job(), "smoke-v1", {})
    assert smoke["shots"]["master_resolution_px"] == [1200, 1440]
    assert math.prod(smoke["shots"]["master_resolution_px"]) < 2_000_000
    assert smoke["outputs"]["review_card_max_edge_px"] == 1440
    assert_error(
        contract,
        "render_profile_unsupported",
        lambda: contract.resolve_render_spec(pouch_job(), "smoke-v1", {}),
    )
