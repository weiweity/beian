"""RF07-on-landed-RF06 compatibility: UV accessor gate stays strict."""

from __future__ import annotations

from copy import deepcopy
import struct

import pytest

from test_packaging_glb_verify import glb_verify
from test_packaging_render_contract import carton_job, contract_module
from test_packaging_render_materials import _append_view, _pbr_carton_artifact


def _studio_identity(contract, *, dimensions):
    plan = contract.render_plan_for_experimental_studio_job(
        carton_job(dimensions=dimensions),
        "packshot-studio-explicit-v1",
    )
    assert plan["render"]["studio_profile"] == "normalized-three-area-explicit-v1"
    assert plan["spec"]["material"]["glb_export"]["normal"] is True
    assert plan["spec"]["material"]["glb_export"]["clearcoat"] is False
    return {
        "assets": {},
        "dimensions_mm": dimensions,
        "render_spec": plan["spec"],
        "render": plan["render"],
        **plan["identity"],
    }


def _white_none_studio_artifact(module, contract, tmp_path, identity):
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
    for index, material in enumerate(artifact.document["materials"]):
        pbr = material.setdefault("pbrMetallicRoughness", {})
        pbr["roughnessFactor"] = 0.6 if index == 6 else 0.52
        material.pop("extensions", None)
    artifact.document.pop("extensionsRequired", None)
    artifact.document.pop("extensionsUsed", None)
    identity["assets"] = assets
    return module.GlbArtifact(artifact.document, artifact.binary), assets


def _compare(module, contract, artifact, identity):
    layers = contract.resolved_material_layers(identity["render_spec"]["material"])
    return module.compare_glb_artifact_contract(
        artifact,
        identity["assets"],
        identity["dimensions_mm"],
        0.5,
        identity["render"]["substrate_rgba"],
        render_identity=identity,
        material_layers=layers,
    )


def test_rf07_studio_plan_accepts_valid_second_normal_uv_channel(tmp_path):
    module = glb_verify()
    contract = contract_module()
    identity = _studio_identity(contract, dimensions={"width": 30, "depth": 20, "height": 50})
    artifact, _assets = _white_none_studio_artifact(module, contract, tmp_path, identity)
    assert _compare(module, contract, artifact, identity)["ok"]
    attributes = artifact.document["meshes"][0]["primitives"][0]["attributes"]
    attributes["TEXCOORD_1"] = attributes["TEXCOORD_0"]
    artifact.document["materials"][0]["normalTexture"]["texCoord"] = 1
    report = _compare(module, contract, artifact, identity)
    assert report["ok"], report


@pytest.mark.parametrize("extension", ["KHR_materials_clearcoat", "UNKNOWN_material_override"])
def test_rf07_studio_plan_does_not_relax_required_extension_gate(tmp_path, extension):
    module = glb_verify()
    contract = contract_module()
    identity = _studio_identity(contract, dimensions={"width": 30, "depth": 20, "height": 50})
    artifact, _assets = _white_none_studio_artifact(module, contract, tmp_path, identity)
    artifact.document["extensionsRequired"] = [extension]
    report = _compare(module, contract, artifact, identity)
    assert report["ok"] is False, report


@pytest.mark.parametrize("damage", ["out_of_range", "wrong_type", "wrong_count", "nonfinite"])
def test_rf07_studio_plan_still_rejects_invalid_normal_uv_accessor(tmp_path, damage):
    module = glb_verify()
    contract = contract_module()
    identity = _studio_identity(contract, dimensions={"width": 30, "depth": 20, "height": 50})
    artifact, _assets = _white_none_studio_artifact(module, contract, tmp_path, identity)
    assert _compare(module, contract, artifact, identity)["ok"]
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
            payload = struct.pack("<ff", float("nan"), 0.0) * accessor["count"]
            artifact, view = _append_view(module, artifact, payload)
            accessor["bufferView"] = view
            accessor["byteOffset"] = 0
        attributes["TEXCOORD_1"] = len(artifact.document["accessors"])
        artifact.document["accessors"].append(accessor)
    report = _compare(module, contract, artifact, identity)
    assert not report["ok"], f"invalid normal UV accessor accepted under RF07 studio plan: {damage}"
    codes = {error["code"] for error in report.get("errors") or []}
    pbr = report.get("pbr") or (report.get("material") or {}).get("pbr") or {}
    codes.update(error["code"] for error in pbr.get("errors") or [])
    assert "glb_normal_texcoord_unbound" in codes
