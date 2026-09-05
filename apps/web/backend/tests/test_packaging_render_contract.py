from __future__ import annotations

from copy import deepcopy
import importlib.util
import json
import math
import os
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


def test_registry_loads_strict_profiles_and_capability_matrix():
    contract = contract_module()
    registry = contract.load_profile_registry()

    assert registry["schema"] == "packaging-render-profile-registry/1"
    assert registry["registry_sha256"].startswith("sha256:")
    assert list(registry["profiles"]) == [
        "compat-legacy-v0",
        "packshot-neutral-v1",
        "smoke-v1",
        "packshot-f-v1",
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
        "packshot-f-v1",
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


def test_pinned_historical_spec_replays_without_resigning():
    contract = contract_module()
    historical = REGISTRY_PATH.parent / "history" / "pre-f.v1.json"
    spec = contract.resolve_render_spec(carton_job(), "compat-legacy-v0", registry_path=historical)
    before = deepcopy(spec)
    assert contract.validate_render_spec(spec) == before
    assert spec == before
    current = contract.resolve_render_spec(carton_job(), "compat-legacy-v0")
    assert current["registry_sha256"] != before["registry_sha256"]


def test_historical_registry_cannot_authorize_new_f_profile():
    contract = contract_module()
    spec = contract.resolve_render_spec(carton_job(), "packshot-f-v1")
    spec["registry_sha256"] = "sha256:38ee501b794e9979a8ab06f2e0e1a476271ea9c7897c41eed3460d0f0acfc77b"
    spec["render_contract_hash"] = contract.render_contract_sha256(spec)
    assert_error(contract, "render_profile_unsupported", lambda: contract.validate_render_spec(spec))


@pytest.mark.parametrize("change", ["unknown_hash", "profile_hash", "material", "flat_render"])
def test_historical_spec_tampering_still_rejected(change):
    contract = contract_module()
    spec = contract.resolve_render_spec(carton_job(), "compat-legacy-v0", registry_path=REGISTRY_PATH.parent / "history" / "pre-f.v1.json")
    if change == "unknown_hash":
        spec["registry_sha256"] = "sha256:" + "f" * 64
    elif change == "profile_hash":
        spec["renderer"]["profile_sha256"] = "sha256:" + "f" * 64
    elif change == "material":
        spec["material"]["roughness"] = 0.99
    else:
        render = contract.current_renderer_config(spec)
        render["light_energy_scale"] = 0
        assert_error(contract, "render_contract_invalid", lambda: contract._assert_job_render_matches_spec({"render": render}, spec))
        return
    spec["render_contract_hash"] = contract.render_contract_sha256(spec)
    assert_error(contract, "render_contract_invalid", lambda: contract.validate_render_spec(spec))


def test_historical_file_tamper_and_current_profile_drift_rejected(monkeypatch):
    contract = contract_module()
    current = contract.load_profile_registry()
    historical = contract.load_profile_registry(REGISTRY_PATH.parent / "history" / "pre-f.v1.json")
    pinned = historical["registry_sha256"]
    bad = deepcopy(historical)
    bad["registry_sha256"] = "sha256:" + "f" * 64
    monkeypatch.setattr(contract, "load_profile_registry", lambda *_: bad)
    assert_error(contract, "render_contract_invalid", lambda: contract._registry_for_persisted_identity(pinned, current))
    monkeypatch.setattr(contract, "load_profile_registry", lambda *_: historical)
    current["profiles"]["compat-legacy-v0"]["material"]["roughness"] = 0.99
    assert_error(contract, "render_contract_invalid", lambda: contract._registry_for_persisted_identity(pinned, current))


def test_f_profile_is_explicit_hash_bound_and_preserves_legacy():
    contract = contract_module()
    registry = contract.load_profile_registry()
    assert registry["profiles"]["compat-legacy-v0"]["profile_sha256"] == "sha256:abf8256356f1d6d7b780411cc9210a195e1253ae304e0aceb1bcba0fe672aab4"
    spec = contract.resolve_render_spec(carton_job(), "packshot-f-v1", {})
    flat = contract.current_renderer_config(spec)
    assert flat["studio_profile"] == "normalized-three-area-f-v1"
    assert flat["shadow_pool_size_mb"] == 1024
    assert flat["rig_reference_mm"] == 180
    assert flat["fill_energy_multiplier"] == 0.35
    assert flat["key_elevation_delta_deg"] == -15
    legacy = contract.current_renderer_config(contract.resolve_render_spec(carton_job(), "compat-legacy-v0", {}))
    assert "shadow_pool_size_mb" not in legacy and "studio_profile" not in legacy
    assert_error(contract, "render_profile_unsupported", lambda: contract.resolve_render_spec(pouch_job(), "packshot-f-v1", {}))


@pytest.mark.parametrize("section,key", [("renderer", "shadow_pool_size_mb"), ("shots", "rig_reference_mm"), ("shots", "fill_energy_multiplier"), ("shots", "key_elevation_delta_deg")])
@pytest.mark.parametrize("missing", [False, True])
def test_f_spec_rejects_mutated_or_missing_parameters(section, key, missing):
    contract = contract_module()
    spec = contract.resolve_render_spec(carton_job(), "packshot-f-v1", {})
    if missing:
        del spec[section][key]
    else:
        spec[section][key] = 0
    spec["render_contract_hash"] = contract.render_contract_sha256(spec)
    assert_error(contract, "render_contract_invalid", lambda: contract.validate_render_spec(spec))


def test_f_registry_requires_shadow_budget():
    contract = contract_module()
    profile = registry_payload()["profiles"][-1]
    del profile["renderer"]["shadow_pool_size_mb"]
    assert_error(contract, "render_contract_invalid", lambda: contract.profile_declared_sha256(profile))


@pytest.mark.parametrize("key", ["studio_profile", "shadow_pool_size_mb", "rig_reference_mm", "fill_energy_multiplier", "key_elevation_delta_deg"])
@pytest.mark.parametrize("missing", [False, True])
def test_f_flat_render_cannot_disagree_with_spec(key, missing):
    contract = contract_module()
    spec = contract.resolve_render_spec(carton_job(), "packshot-f-v1", {})
    render = contract.current_renderer_config(spec)
    if missing:
        del render[key]
    else:
        render[key] = "legacy" if key == "studio_profile" else 1
    assert_error(contract, "render_contract_invalid", lambda: contract._assert_job_render_matches_spec({"render": render}, spec))


def test_f_new_plan_has_different_cache_token_without_changing_default():
    contract = contract_module()
    legacy = contract.render_plan_for_new_job(carton_job(), "compat-legacy-v0")
    candidate = contract.render_plan_for_new_job(carton_job(), "packshot-f-v1")
    assert legacy["fingerprint_token"] != candidate["fingerprint_token"]
    assert json.loads(CURRENT_TEMPLATE.read_text()).get("render_profile_id", "compat-legacy-v0") == "compat-legacy-v0"


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


@pytest.mark.parametrize("mutation", ["reorder", "prepend"])
def test_registry_update_rejects_reorder_and_prepend(tmp_path: Path, mutation: str):
    contract = contract_module()
    payload = registry_payload()
    if mutation == "reorder":
        payload["profiles"][0], payload["profiles"][1] = (
            payload["profiles"][1],
            payload["profiles"][0],
        )
    else:
        inserted = deepcopy(payload["profiles"][2])
        inserted["id"] = "smoke-fast-v2"
        inserted["studio"]["master_resolution_px"] = [640, 768]
        refresh_profile_hash(contract, inserted)
        payload["profiles"].insert(0, inserted)

    candidate = write_registry(tmp_path / f"{mutation}.json", payload)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_registry_update(REGISTRY_PATH, candidate),
    )


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
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_render_spec(default_spec, registry_path=reformatted),
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

    assert template["render_profile_id"] == "compat-legacy-v0"
    assert contract.current_renderer_config(spec) == {
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


def _legacy_pipeline_job(*, assets: dict | None = None, **overrides) -> dict:
    faces = assets or {
        face: f"/tmp/panel_{face}.png" for face in FACES
    }
    payload = {
        "code": "flower-box-legacy",
        "slug": "guess-me",
        "display_name": "红色花盒",
        "template_path": "/tmp/flower_box_47_5x47_5x177_5.json",
        "structure_schema": "packaging-structure/1",
        "structure_hash": "sha256:" + "a" * 64,
        "dimensions_mm": {"width": 47.5, "depth": 47.5, "height": 177.5},
        "assets": faces,
        "render": {
            "substrate_rgba": [0.7, 0.7, 0.7, 1.0],
            "resolution_x": 3000,
            "resolution_y": 3600,
            "camera_ortho_scale_mm": 224.0,
            "front_rotation_deg": 0.0,
            "back_rotation_deg": 180.0,
        },
    }
    payload.update(overrides)
    return payload


def test_resolve_render_spec_never_emits_legacy_synthesized_source():
    contract = contract_module()
    spec = contract.resolve_render_spec(carton_job(), "compat-legacy-v0", {})
    assert spec["source"] == "profile_resolved"
    assert spec["source"] != "legacy_synthesized"
    assert contract.RENDER_SPEC_SOURCES == ("profile_resolved", "legacy_synthesized")


def test_legacy_synthesis_uses_persisted_structure_facts_and_compat_profile():
    contract = contract_module()
    resolved = contract.resolve_render_spec(carton_job(), "compat-legacy-v0", {})
    synthesized = contract.synthesize_legacy_render_spec(_legacy_pipeline_job())

    assert synthesized["source"] == "legacy_synthesized"
    assert synthesized["renderer"]["profile"] == "compat-legacy-v0"
    assert synthesized["geometry"]["family"] == "rectangular_carton_v1"
    assert synthesized["geometry"]["structure_hash"] == "sha256:" + "a" * 64
    assert synthesized["render_contract_hash"] != resolved["render_contract_hash"]
    assert contract.validate_render_spec(synthesized) == synthesized
    assert contract.current_renderer_config(synthesized) == {
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


def test_legacy_synthesis_maps_persisted_pouch_family_without_filename_guessing():
    contract = contract_module()
    synthesized = contract.synthesize_legacy_render_spec(
        _legacy_pipeline_job(
            packaging_family="pouch",
            dimensions_mm={"width": 140.0, "depth": 3.0, "height": 200.0},
        )
    )
    assert synthesized["source"] == "legacy_synthesized"
    assert synthesized["geometry"]["family"] == "pouch_thin_card_v1"
    assert synthesized["geometry"]["preview_fidelity"] == "thin_card"


def test_legacy_synthesis_fails_closed_without_provable_structure_facts():
    contract = contract_module()
    missing_hash = _legacy_pipeline_job()
    missing_hash.pop("structure_hash")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.synthesize_legacy_render_spec(missing_hash),
    )

    missing_schema = _legacy_pipeline_job(structure_schema="guess-from-filename")
    assert_error(
        contract,
        "render_family_unsupported",
        lambda: contract.synthesize_legacy_render_spec(missing_schema),
    )

    missing_faces = _legacy_pipeline_job(
        assets={"front": "/tmp/panel_front.png", "back": "/tmp/panel_back.png"}
    )
    assert_error(
        contract,
        "render_family_unsupported",
        lambda: contract.synthesize_legacy_render_spec(missing_faces),
    )

    unknown_family = _legacy_pipeline_job(packaging_family="flexible_pouch_v1")
    assert_error(
        contract,
        "render_family_unsupported",
        lambda: contract.synthesize_legacy_render_spec(unknown_family),
    )


def test_legacy_synthesized_source_is_strictly_enumerated():
    contract = contract_module()
    spec = contract.resolve_render_spec(carton_job(), "compat-legacy-v0", {})
    spec["source"] = "imported_guess"
    spec["render_contract_hash"] = contract.render_contract_sha256(spec)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_render_spec(spec),
    )


@pytest.mark.parametrize("value", [False, 0, "", [], True])
def test_falsy_non_object_output_request_is_rejected(value):
    contract = contract_module()
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.resolve_render_spec(
            carton_job(), "compat-legacy-v0", value
        ),
    )
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_new_job(
            carton_job(), "compat-legacy-v0", value
        ),
    )


def test_new_job_render_plan_exposes_four_identity_fields_without_copying_registry():
    contract = contract_module()
    plan = contract.render_plan_for_new_job(carton_job(), "compat-legacy-v0", None)
    assert plan["schema"] == "packaging-render-plan/1"
    assert plan["spec"]["source"] == "profile_resolved"
    assert list(plan["identity"]) == [
        "render_contract_hash",
        "render_profile_id",
        "render_profile_sha256",
        "render_registry_sha256",
    ]
    assert plan["identity"]["render_profile_id"] == "compat-legacy-v0"
    assert plan["identity"]["render_contract_hash"] == plan["spec"]["render_contract_hash"]
    assert (
        plan["identity"]["render_profile_sha256"]
        == plan["spec"]["renderer"]["profile_sha256"]
    )
    assert (
        plan["identity"]["render_registry_sha256"] == plan["spec"]["registry_sha256"]
    )
    assert plan["sampling"]["legacy_raster_width_px"] == 10000
    assert plan["render"]["resolution_x"] == 3000
    assert plan["fingerprint_token"].startswith("sha256:")


def test_bound_spec_rejects_foreign_job_and_structure_mutations():
    contract = contract_module()
    spec_b = contract.resolve_render_spec(
        carton_job(dimensions={"width": 80.0, "depth": 40.0, "height": 120.0}),
        "compat-legacy-v0",
        {},
    )
    job_a = _legacy_pipeline_job()
    job_a["render_spec"] = spec_b
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(job_a),
    )
    bound = contract.render_plan_for_new_job(carton_job(), "compat-legacy-v0", None)
    job = _legacy_pipeline_job()
    job["render_spec"] = bound["spec"]
    job["render"] = deepcopy(bound["render"])
    job.update(bound["identity"])
    job["pipeline_version"] = "1.5.1"
    job["structure_engine"] = "v2"
    contract.render_plan_for_resolved_job(job)

    family = deepcopy(job)
    family["packaging_family"] = "pouch"
    family["dimensions_mm"] = {"width": 140.0, "depth": 3.0, "height": 200.0}
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(family),
    )
    hashed = deepcopy(job)
    hashed["structure_hash"] = "sha256:" + "b" * 64
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(hashed),
    )
    for axis in ("width", "depth", "height"):
        mutated = deepcopy(job)
        mutated["dimensions_mm"] = dict(job["dimensions_mm"])
        mutated["dimensions_mm"][axis] = mutated["dimensions_mm"][axis] + 1.0
        assert_error(
            contract,
            "render_contract_invalid",
            lambda payload=mutated: contract.render_plan_for_resolved_job(payload),
        )


def test_nested_and_top_level_registry_identity_must_match_real_provenance():
    contract = contract_module()
    plan = contract.render_plan_for_new_job(carton_job(), "compat-legacy-v0", None)
    job = _legacy_pipeline_job()
    job["render_spec"] = deepcopy(plan["spec"])
    job["render"] = deepcopy(plan["render"])
    job.update(plan["identity"])
    job["pipeline_version"] = "1.5.1"
    job["structure_engine"] = "v2"
    contract.render_plan_for_resolved_job(job)

    top = deepcopy(job)
    top["render_registry_sha256"] = "sha256:" + "c" * 64
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(top),
    )
    nested = deepcopy(job)
    nested["render_spec"] = deepcopy(plan["spec"])
    nested["render_spec"]["registry_sha256"] = "sha256:" + "c" * 64
    nested["render_spec"]["render_contract_hash"] = contract.render_contract_sha256(
        nested["render_spec"]
    )
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(nested),
    )
    forged = deepcopy(job)
    forged["render_registry_sha256"] = "sha256:" + "c" * 64
    forged["render_spec"] = deepcopy(plan["spec"])
    forged["render_spec"]["registry_sha256"] = "sha256:" + "c" * 64
    forged["render_spec"]["render_contract_hash"] = contract.render_contract_sha256(
        forged["render_spec"]
    )
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(forged),
    )


@pytest.mark.parametrize(
    "version",
    ["1.5.1", "9.9.9", "unknown", None],
)
def test_only_known_pre_rf02_v2_jobs_can_synthesize_legacy(version):
    contract = contract_module()
    job = _legacy_pipeline_job()
    if version is None:
        job.pop("pipeline_version", None)
    else:
        job["pipeline_version"] = version
    job["structure_engine"] = "v2"
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(job),
    )


def test_pre_rf02_v2_job_synthesizes_compat_when_persisted_render_matches():
    contract = contract_module()
    job = _legacy_pipeline_job()
    job["pipeline_version"] = "1.4.0"
    job["structure_engine"] = "v2"
    job["render"] = contract.current_renderer_config(
        contract.resolve_render_spec(carton_job(), "compat-legacy-v0", {})
    )
    plan = contract.render_plan_for_resolved_job(job)
    assert plan["spec"]["source"] == "legacy_synthesized"
    assert plan["identity"]["render_profile_id"] == "compat-legacy-v0"


def test_legacy_render_mismatch_is_rejected_instead_of_silently_retargeted():
    contract = contract_module()
    job = _legacy_pipeline_job()
    job["pipeline_version"] = "1.4.0"
    job["structure_engine"] = "v2"
    job["render"] = {"resolution_x": 800, "resolution_y": 900, "camera_ortho_scale_mm": 80}
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(job),
    )


@pytest.mark.parametrize("payload", [None, {}, {"resolution_x": 3000}])
def test_legacy_synthesis_rejects_missing_historical_render_keys(payload):
    contract = contract_module()
    job = _legacy_pipeline_job()
    job["pipeline_version"] = "1.4.0"
    job["structure_engine"] = "v2"
    if payload is None:
        job["render"] = None
    else:
        job["render"] = payload
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(job),
    )


@pytest.mark.parametrize("key", ["resolution_x", "camera_ortho_scale_mm", "substrate_rgba", "front_rotation_deg"])
def test_legacy_synthesis_rejects_deleted_historical_render_key(key):
    contract = contract_module()
    job = _legacy_pipeline_job()
    job["pipeline_version"] = "1.4.0"
    job["structure_engine"] = "v2"
    job["render"] = dict(job["render"])
    job["render"].pop(key)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(job),
    )


def test_v1_diagnostic_render_uses_historical_template_values_not_registry():
    contract = contract_module()
    production = json.loads(CURRENT_TEMPLATE.read_text(encoding="utf-8"))
    smoke = json.loads(
        (PACKAGING / "templates" / "flower_box_illustrator_smoke.json").read_text(
            encoding="utf-8"
        )
    )
    assert "render" not in production
    assert "render" not in smoke
    assert contract.v1_diagnostic_render(production) == {
        "substrate_rgba": [1.0, 1.0, 1.0, 1.0],
        "resolution_x": 3000,
        "resolution_y": 3600,
        "camera_ortho_scale_mm": 224.0,
        "front_rotation_deg": 0.0,
        "back_rotation_deg": 180.0,
    }
    assert contract.v1_diagnostic_render(smoke)["resolution_x"] == 1200
    assert contract.v1_diagnostic_render(smoke)["resolution_y"] == 1440


def test_spec_bearing_job_requires_identity_and_flat_render():
    contract = contract_module()
    plan = contract.render_plan_for_new_job(carton_job(), "compat-legacy-v0", None)
    job = _legacy_pipeline_job()
    job["render_spec"] = deepcopy(plan["spec"])
    job["pipeline_version"] = "1.5.1"
    job["structure_engine"] = "v2"
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(job),
    )
    job.update(plan["identity"])
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(job),
    )
    job["render"] = deepcopy(plan["render"])
    contract.render_plan_for_resolved_job(job)
    job["render"] = dict(plan["render"])
    job["render"]["resolution_x"] = 1
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.render_plan_for_resolved_job(job),
    )


def test_blender_execution_plan_rejects_disk_memory_divergence(tmp_path: Path):
    contract = contract_module()
    plan = contract.render_plan_for_new_job(carton_job(), "compat-legacy-v0", None)
    project = tmp_path / "BOX"
    project.mkdir()
    assets_dir = project / "assets"
    assets_dir.mkdir()
    png_header = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
    front = project / "BOX_box_front_right_white.png"
    back = project / "BOX_box_back_left_white.png"
    blend = project / "BOX_box_white_studio.blend"
    glb = project / "BOX_box.glb"
    for path in (front, back, blend, glb):
        path.write_bytes(b"x")
    for face in FACES:
        (assets_dir / f"panel_{face}.png").write_bytes(png_header)
    resolved_path = project / "resolved_job.json"
    job = {
        "code": "BOX",
        "slug": "box",
        "display_name": "盒",
        "source_ai": str(tmp_path / "source.ai"),
        "template_path": str(tmp_path / "template.json"),
        "project_dir": str(project),
        "resolved_job_path": str(resolved_path),
        "pipeline_version": "1.5.1",
        "structure_engine": "v2",
        "structure_schema": "packaging-structure/1",
        "structure_hash": "sha256:" + "a" * 64,
        "dimensions_mm": {"width": 47.5, "depth": 47.5, "height": 177.5},
        "glb_tolerance_mm": 0.5,
        "assets": {face: str(assets_dir / f"panel_{face}.png") for face in FACES},
        "outputs": {
            "blend": str(blend),
            "glb": str(glb),
            "front_right": str(front),
            "back_left": str(back),
        },
        "render_spec": deepcopy(plan["spec"]),
        "render": deepcopy(plan["render"]),
    }
    job.update(plan["identity"])
    resolved_path.write_text(json.dumps(job), encoding="utf-8")
    contract.blender_execution_plan(job, job, resolved_job_path=resolved_path)

    missing = deepcopy(job)
    missing.pop("render_profile_id")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.blender_execution_plan(
            missing, job, resolved_job_path=resolved_path
        ),
    )
    tampered_render = deepcopy(job)
    tampered_render["render"] = dict(job["render"])
    tampered_render["render"]["resolution_x"] = 1
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.blender_execution_plan(
            tampered_render, job, resolved_job_path=resolved_path
        ),
    )
    escaped = deepcopy(job)
    escaped["outputs"] = dict(job["outputs"])
    escaped["outputs"]["front_right"] = str(tmp_path / "outside.png")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.blender_execution_plan(
            escaped, job, resolved_job_path=resolved_path
        ),
    )


def test_output_contract_rejects_unknown_duplicate_and_reserved_targets(tmp_path: Path):
    contract = contract_module()
    project = tmp_path / "BOX"
    project.mkdir()
    front = project / "a.png"
    back = project / "b.png"
    blend = project / "c.blend"
    glb = project / "d.glb"
    resolved = project / "resolved_job.json"
    for path in (front, back, blend, glb, resolved):
        path.write_bytes(b"data")
    job = {
        "project_dir": str(project),
        "resolved_job_path": str(resolved),
        "source_ai": str(project / "source.ai"),
        "template_path": str(project / "template.json"),
        "assets": {face: str(project / f"panel_{face}.png") for face in FACES},
        "outputs": {
            "blend": str(blend),
            "glb": str(glb),
            "front_right": str(front),
            "back_left": str(back),
        },
    }
    contract.validate_job_output_contract(job)
    unknown = deepcopy(job)
    unknown["outputs"] = dict(job["outputs"])
    unknown["outputs"]["evil"] = str(project / "evil.bin")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_job_output_contract(unknown),
    )
    overlap = deepcopy(job)
    overlap["outputs"] = dict(job["outputs"])
    overlap["outputs"]["front_right"] = str(resolved)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_job_output_contract(overlap),
    )


def test_output_contract_rejects_reserved_symlink_target_and_hardlink(
    tmp_path: Path,
):
    contract = contract_module()
    project = tmp_path / "BOX"
    assets_dir = project / "assets"
    assets_dir.mkdir(parents=True)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
    real_source = project / "source.ai"
    real_source.write_bytes(b"ai")
    alias = project / "source-alias.ai"
    alias.symlink_to(real_source)
    front = project / "a.png"
    back = project / "b.png"
    blend = project / "c.blend"
    glb = project / "d.glb"
    for path in (front, back, blend, glb):
        path.write_bytes(png if path.suffix == ".png" else b"data")
    for face in FACES:
        (assets_dir / f"panel_{face}.png").write_bytes(png)
    job = {
        "project_dir": str(project),
        "resolved_job_path": str(project / "resolved_job.json"),
        "source_ai": str(alias),
        "template_path": str(project / "template.json"),
        "assets": {face: str(assets_dir / f"panel_{face}.png") for face in FACES},
        "outputs": {
            "blend": str(blend),
            "glb": str(glb),
            "front_right": str(front),
            "back_left": str(back),
        },
    }
    (project / "resolved_job.json").write_bytes(b"{}")
    (project / "template.json").write_text("{}", encoding="utf-8")
    contract.validate_job_output_contract(job)

    hard = deepcopy(job)
    hard["outputs"] = dict(job["outputs"])
    overlap = project / "stolen-source.png"
    if overlap.exists():
        overlap.unlink()
    os.link(real_source, overlap)
    hard["outputs"]["front_right"] = str(overlap)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_job_output_contract(hard),
    )

    stolen_asset = deepcopy(job)
    stolen_asset["outputs"] = dict(job["outputs"])
    asset_front = Path(job["assets"]["front"])
    alias_out = project / "alias-asset.png"
    if alias_out.exists():
        alias_out.unlink()
    os.link(asset_front, alias_out)
    stolen_asset["outputs"]["back_left"] = str(alias_out)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_job_output_contract(stolen_asset),
    )


def test_asset_contract_requires_six_unique_in_tree_pngs(tmp_path: Path):
    contract = contract_module()
    project = tmp_path / "BOX"
    assets_dir = project / "assets"
    assets_dir.mkdir(parents=True)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
    assets = {}
    for face in FACES:
        dest = assets_dir / f"panel_{face}.png"
        dest.write_bytes(png)
        assets[face] = str(dest)
    job = {
        "project_dir": str(project),
        "assets": assets,
    }
    contract.validate_job_asset_contract(job, project_dir=project)

    missing = deepcopy(job)
    Path(missing["assets"]["top"]).unlink()
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_job_asset_contract(missing, project_dir=project),
    )
    outside = deepcopy(job)
    stolen = tmp_path / "panel_front.png"
    stolen.write_bytes(png)
    outside["assets"] = dict(job["assets"])
    outside["assets"]["front"] = str(stolen)
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.validate_job_asset_contract(outside, project_dir=project),
    )


def _png_header() -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * 8


def _write_face_pngs(assets_dir: Path) -> dict[str, str]:
    assets_dir.mkdir(parents=True, exist_ok=True)
    assets = {}
    png = _png_header()
    for face in FACES:
        dest = assets_dir / f"panel_{face}.png"
        dest.write_bytes(png)
        assets[face] = str(dest)
    return assets


def _spec_bearing_execution_job(
    tmp_path: Path,
    contract,
    *,
    project: Path,
    assets: dict[str, str],
    outputs: dict[str, str],
) -> dict:
    plan = contract.render_plan_for_new_job(carton_job(), "compat-legacy-v0", None)
    resolved_path = project / "resolved_job.json"
    job = {
        "code": "BOX",
        "slug": "box",
        "display_name": "盒",
        "source_ai": str(tmp_path / "source.ai"),
        "template_path": str(tmp_path / "template.json"),
        "project_dir": str(project),
        "resolved_job_path": str(resolved_path),
        "pipeline_version": "1.5.1",
        "structure_engine": "v2",
        "structure_schema": "packaging-structure/1",
        "structure_hash": "sha256:" + "a" * 64,
        "dimensions_mm": {"width": 47.5, "depth": 47.5, "height": 177.5},
        "glb_tolerance_mm": 0.5,
        "assets": assets,
        "outputs": outputs,
        "render_spec": deepcopy(plan["spec"]),
        "render": deepcopy(plan["render"]),
    }
    job.update(plan["identity"])
    resolved_path.write_text(json.dumps(job), encoding="utf-8")
    return job


def test_apply_blender_result_requires_nonce_and_returns_measurements_only():
    contract = contract_module()
    snapshot = {
        "code": "BOX",
        "outputs": {
            "blend": "/tmp/box.blend",
            "glb": "/tmp/box.glb",
            "front_right": "/tmp/front.png",
            "back_left": "/tmp/back.png",
        },
        "execution_nonce": "round-nonce",
        "render": {"resolution_x": 3000},
        "render_spec": {"schema": "packaging-render-spec/1"},
        "project_dir": "/tmp/box",
    }
    measurements = contract.apply_blender_result(
        {
            "code": "BOX",
            "outputs": snapshot["outputs"],
            "execution_nonce": "round-nonce",
            "glb_dimensions_mm": {"x": 1.0, "y": 2.0, "z": 3.0},
            "blender_elapsed_s": 0.2,
        },
        snapshot_job=snapshot,
    )
    assert measurements == {
        "glb_dimensions_mm": {"x": 1.0, "y": 2.0, "z": 3.0},
        "blender_elapsed_s": 0.2,
    }
    assert "execution_nonce" not in measurements
    assert "code" not in measurements
    assert "outputs" not in measurements

    stale = {
        "code": "BOX",
        "outputs": snapshot["outputs"],
        "execution_nonce": "old-nonce",
        "glb_dimensions_mm": {"x": 9.0, "y": 9.0, "z": 9.0},
    }
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.apply_blender_result(stale, snapshot_job=snapshot),
    )
    missing_nonce = dict(stale)
    missing_nonce.pop("execution_nonce")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.apply_blender_result(missing_nonce, snapshot_job=snapshot),
    )
    snapshot_without_nonce = dict(snapshot)
    snapshot_without_nonce.pop("execution_nonce")
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.apply_blender_result(
            {
                "code": "BOX",
                "outputs": snapshot["outputs"],
                "glb_dimensions_mm": {"x": 1.0, "y": 2.0, "z": 3.0},
            },
            snapshot_job=snapshot_without_nonce,
        ),
    )
    injected = {
        "code": "BOX",
        "outputs": snapshot["outputs"],
        "execution_nonce": "round-nonce",
        "glb_dimensions_mm": {"x": 1.0, "y": 2.0, "z": 3.0},
        "project_dir": "/evil",
        "render": {"resolution_x": 1},
        "render_spec": {"schema": "nope"},
        "render_profile_id": "compat-legacy-v0",
    }
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.apply_blender_result(injected, snapshot_job=snapshot),
    )


@pytest.mark.parametrize("mutation", ["code", "output_keys", "output_path"])
def test_apply_blender_result_rejects_isolated_identity_mismatch(mutation: str):
    contract = contract_module()
    snapshot = {
        "code": "BOX",
        "execution_nonce": "current-round",
        "outputs": {"front_right": "/tmp/box/front.png", "back_left": "/tmp/box/back.png"},
    }
    result = deepcopy(snapshot)
    if mutation == "code":
        result["code"] = "OTHER"
        message = "code 与执行快照不一致"
    elif mutation == "output_keys":
        result["outputs"].pop("back_left")
        message = "outputs key 与执行快照不一致"
    else:
        result["outputs"]["front_right"] = "/tmp/other/front.png"
        message = "输出路径与执行快照不一致"
    original = deepcopy(snapshot)
    with pytest.raises(contract.RenderContractError, match=message):
        contract.apply_blender_result(result, snapshot_job=snapshot)
    assert snapshot == original


def test_blender_execution_plan_rejects_external_assets_with_correct_layout(
    tmp_path: Path,
):
    contract = contract_module()
    project = tmp_path / "BOX"
    project.mkdir()
    assets = _write_face_pngs(project / "assets")
    outside_root = tmp_path / "stolen-box"
    outside_assets = _write_face_pngs(outside_root / "assets")
    front = project / "BOX_box_front_right_white.png"
    back = project / "BOX_box_back_left_white.png"
    blend = project / "BOX_box_white_studio.blend"
    glb = project / "BOX_box.glb"
    for path in (front, back, blend, glb):
        path.write_bytes(b"x")
    job = _spec_bearing_execution_job(
        tmp_path,
        contract,
        project=project,
        assets=assets,
        outputs={
            "blend": str(blend),
            "glb": str(glb),
            "front_right": str(front),
            "back_left": str(back),
        },
    )
    contract.blender_execution_plan(
        job, job, resolved_job_path=job["resolved_job_path"]
    )

    escaped = deepcopy(job)
    escaped["assets"] = outside_assets
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.blender_execution_plan(
            escaped, escaped, resolved_job_path=job["resolved_job_path"]
        ),
    )


def test_blender_execution_plan_accepts_explicit_original_asset_root(
    tmp_path: Path,
):
    contract = contract_module()
    original = tmp_path / "BOX"
    original.mkdir()
    assets = _write_face_pngs(original / "assets")
    staging = tmp_path / "relight-temp"
    staging.mkdir()
    front = staging / "BOX_box_front_right_white.png"
    back = staging / "BOX_box_back_left_white.png"
    blend = staging / "BOX_box_white_studio.blend"
    glb = staging / "BOX_box.glb"
    for path in (front, back, blend, glb):
        path.write_bytes(b"x")
    remapped = _spec_bearing_execution_job(
        tmp_path,
        contract,
        project=staging,
        assets=assets,
        outputs={
            "blend": str(blend),
            "glb": str(glb),
            "front_right": str(front),
            "back_left": str(back),
        },
    )
    assert_error(
        contract,
        "render_contract_invalid",
        lambda: contract.blender_execution_plan(
            remapped, remapped, resolved_job_path=remapped["resolved_job_path"]
        ),
    )
    contract.blender_execution_plan(
        remapped,
        remapped,
        resolved_job_path=remapped["resolved_job_path"],
        asset_project_dir=original,
    )
