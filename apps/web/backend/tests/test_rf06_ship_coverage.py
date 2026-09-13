"""RF06 independent ship audit: exported-artifact behavioral regressions."""

from copy import deepcopy

import pytest

from test_packaging_glb_verify import glb_verify
from test_packaging_render_contract import contract_module
from test_packaging_render_materials import (
    MICRO_NORMAL,
    _append_view,
    _apply_clearcoat,
    _clearcoat_error_codes,
    _gloss_layers,
    _none_layers,
    _pbr_carton_artifact,
    _strip_clearcoat,
)


def test_full_artifact_gate_accepts_valid_second_normal_uv_channel(tmp_path):
    module = glb_verify()
    contract = contract_module()
    artifact, assets = _pbr_carton_artifact(module, contract, tmp_path)
    attributes = artifact.document["meshes"][0]["primitives"][0]["attributes"]
    attributes["TEXCOORD_1"] = attributes["TEXCOORD_0"]
    artifact.document["materials"][0]["normalTexture"]["texCoord"] = 1
    report = module.compare_glb_artifact_contract(
        artifact, assets, {"width": 30, "depth": 20, "height": 50},
        0.5, [0.7, 0.7, 0.7, 1.0], material_layers=_gloss_layers(contract),
    )
    assert report["ok"], report


@pytest.mark.parametrize("extension,accepted", [("KHR_materials_clearcoat", True), ("UNKNOWN_material_override", False)])
def test_full_artifact_gate_limits_required_extensions_to_declared_contract(tmp_path, extension, accepted):
    module = glb_verify()
    contract = contract_module()
    artifact, assets = _pbr_carton_artifact(module, contract, tmp_path)
    artifact.document["extensionsRequired"] = [extension]
    report = module.compare_glb_artifact_contract(
        artifact, assets, {"width": 30, "depth": 20, "height": 50},
        0.5, [0.7, 0.7, 0.7, 1.0], material_layers=_gloss_layers(contract),
    )
    assert report["ok"] is accepted, report


@pytest.mark.parametrize("damage", ["out_of_range", "wrong_type", "wrong_count", "nonfinite"])
def test_full_artifact_gate_rejects_invalid_normal_uv_accessor(tmp_path, damage):
    module = glb_verify()
    contract = contract_module()
    artifact, assets = _pbr_carton_artifact(module, contract, tmp_path)
    layers = _gloss_layers(contract)
    args = (assets, {"width": 30, "depth": 20, "height": 50}, 0.5, [0.7, 0.7, 0.7, 1.0])
    assert module.compare_glb_artifact_contract(artifact, *args, material_layers=layers)["ok"]
    attributes = artifact.document["meshes"][0]["primitives"][0]["attributes"]
    artifact.document["materials"][0]["normalTexture"]["texCoord"] = 1
    if damage == "out_of_range":
        attributes["TEXCOORD_1"] = 999999
    elif damage == "wrong_type":
        attributes["TEXCOORD_1"] = attributes["POSITION"]
    else:
        accessor = deepcopy(artifact.document["accessors"][attributes["TEXCOORD_0"]])
        if damage == "wrong_count":
            accessor["count"] = 1
        else:
            import struct

            payload = struct.pack("<ff", float("nan"), 0.0) * accessor["count"]
            artifact, view = _append_view(module, artifact, payload)
            accessor["bufferView"] = view
            accessor["byteOffset"] = 0
        attributes["TEXCOORD_1"] = len(artifact.document["accessors"])
        artifact.document["accessors"].append(accessor)
    report = module.compare_glb_artifact_contract(artifact, *args, material_layers=layers)
    assert not report["ok"], f"invalid normal UV accessor accepted: {damage}"


@pytest.mark.parametrize(
    "damage,expected_code",
    [
        ("core_coat", "glb_core_clearcoat_not_allowed"),
        ("face_roughness", "glb_roughness_not_exported"),
        ("core_roughness", "glb_roughness_not_exported"),
        ("coat_weight", "glb_clearcoat_not_exported"),
        ("normal_pixels", "glb_normal_pixels_mismatch"),
        ("normal_mime", "glb_normal_not_exported"),
    ],
)
def test_pbr_gate_rejects_exported_channel_damage(tmp_path, damage, expected_code):
    module = glb_verify()
    contract = contract_module()
    artifact, _assets = _pbr_carton_artifact(module, contract, tmp_path)
    layers = _gloss_layers(contract)
    assert module.compare_glb_pbr_capability(artifact, layers)["ok"]
    face = artifact.document["materials"][0]
    core = artifact.document["materials"][-1]
    if damage == "core_coat":
        core["extensions"] = deepcopy(face["extensions"])
    elif damage in {"face_roughness", "core_roughness"}:
        material = face if damage == "face_roughness" else core
        material["pbrMetallicRoughness"]["roughnessFactor"] = 0.95
    elif damage == "coat_weight":
        face["extensions"]["KHR_materials_clearcoat"]["clearcoatFactor"] = 0.3
    else:
        texture = artifact.document["textures"][face["normalTexture"]["index"]]
        image = artifact.document["images"][texture["source"]]
        if damage == "normal_mime":
            image["mimeType"] = "image/jpeg"
        else:
            payload = contract.substrate_micro_normal_png_bytes({**MICRO_NORMAL, "seed": 8})
            artifact, view = _append_view(module, artifact, payload)
            image["bufferView"] = view
    report = module.compare_glb_pbr_capability(artifact, layers)
    assert not report["ok"]
    assert expected_code in {error["code"] for error in report["errors"]}


@pytest.mark.parametrize(
    "damage,expected_code",
    [
        ("face_coat", "glb_clearcoat_not_allowed"),
        ("core_coat", "glb_core_clearcoat_not_allowed"),
    ],
)
def test_full_artifact_gate_rejects_undeclared_effective_clearcoat(tmp_path, damage, expected_code):
    module = glb_verify()
    contract = contract_module()
    artifact, assets = _pbr_carton_artifact(module, contract, tmp_path)
    layers = _none_layers(contract)
    args = (assets, {"width": 30, "depth": 20, "height": 50}, 0.5, [0.7, 0.7, 0.7, 1.0])
    _strip_clearcoat(artifact)
    assert module.compare_glb_artifact_contract(artifact, *args, material_layers=layers)["ok"]
    if damage == "face_coat":
        _apply_clearcoat(artifact, faces=True, factor=1.0)
    else:
        _apply_clearcoat(artifact, core=True, factor=1.0)
    report = module.compare_glb_artifact_contract(artifact, *args, material_layers=layers)
    assert report["ok"] is False, report
    assert expected_code in _clearcoat_error_codes(report)
