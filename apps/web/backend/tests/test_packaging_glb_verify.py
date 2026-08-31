from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct

import pytest


MODULE = Path(__file__).resolve().parents[4] / "workers" / "packaging" / "glb_verify.py"


def glb_verify():
    spec = importlib.util.spec_from_file_location("packaging_glb_verify", MODULE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_axis_dimensions_pass_with_small_export_tolerance():
    report = glb_verify().compare_glb_dimensions(
        [0.03013, 0.02013, 0.05013],
        {"width": 30, "depth": 20, "height": 50},
        0.5,
    )
    assert report["ok"] is True
    assert report["measured_mm"]["width"] == 30.13


def test_width_depth_swap_fails_even_when_sorted_dimensions_match():
    report = glb_verify().compare_glb_dimensions(
        [0.02013, 0.03013, 0.05013],
        {"width": 30, "depth": 20, "height": 50},
        0.5,
    )
    assert report["ok"] is False
    assert report["error_mm"]["width"] > 9
    assert sorted(report["measured_mm"].values()) == sorted([20.13, 30.13, 50.13])


def _bindings():
    return {
        face: [{"material": f"MAT_{face}", "images": [f"panel_{face}"]}]
        for face in glb_verify().SEMANTIC_FACES
    }


def _assets():
    return {face: f"/tmp/panel_{face}.png" for face in glb_verify().SEMANTIC_FACES}


def _material_document() -> dict:
    module = glb_verify()
    images = [{"name": f"panel_{face}"} for face in module.SEMANTIC_FACES]
    textures = [{"source": index} for index in range(len(images))]
    materials = [
        {
            "name": f"MAT_{face}",
            "alphaMode": "MASK",
            "pbrMetallicRoughness": {"baseColorTexture": {"index": index}},
        }
        for index, face in enumerate(module.SEMANTIC_FACES)
    ]
    core_material_index = len(materials)
    materials.append({
        "name": "MAT_PaperboardEdge",
        "pbrMetallicRoughness": {"baseColorFactor": [1.0, 1.0, 1.0, 1.0]},
    })
    meshes = [
        {"name": face.title(), "primitives": [{"material": index}]}
        for index, face in enumerate(module.SEMANTIC_FACES)
    ]
    core_mesh_index = len(meshes)
    meshes.append({"name": "Cube", "primitives": [{"material": core_material_index}]})
    nodes = [
        {"name": face.title(), "mesh": index}
        for index, face in enumerate(module.SEMANTIC_FACES)
    ]
    nodes.append({"name": "sample_Box_Core", "mesh": core_mesh_index})
    return {
        "asset": {"version": "2.0"},
        "images": images,
        "textures": textures,
        "materials": materials,
        "meshes": meshes,
        "nodes": nodes,
    }


def test_all_six_semantic_faces_require_their_exact_artwork_binding():
    report = glb_verify().compare_glb_texture_bindings(_bindings(), _assets())

    assert report == {"ok": True, "missing_faces": [], "mismatched_faces": []}


@pytest.mark.parametrize("face", glb_verify().SEMANTIC_FACES)
def test_each_missing_semantic_face_fails_closed(face: str):
    bindings = _bindings()
    del bindings[face]

    report = glb_verify().compare_glb_texture_bindings(bindings, _assets())

    assert report["ok"] is False
    assert report["missing_faces"] == [face]


def test_reusing_front_artwork_on_another_face_is_rejected():
    bindings = _bindings()
    bindings["back"] = [{"material": "MAT_back", "images": ["panel_front"]}]

    report = glb_verify().compare_glb_texture_bindings(bindings, _assets())

    assert report["ok"] is False
    assert report["mismatched_faces"][0]["face"] == "back"


def test_wrong_semantic_material_is_rejected_even_with_the_right_image():
    bindings = _bindings()
    bindings["bottom"] = [{"material": "MAT_top", "images": ["panel_bottom"]}]

    report = glb_verify().compare_glb_texture_bindings(bindings, _assets())

    assert report["ok"] is False
    assert report["mismatched_faces"][0]["face"] == "bottom"


def test_exported_glb_requires_masked_rgba_faces_and_opaque_substrate_core():
    report = glb_verify().compare_glb_material_contract(
        _material_document(),
        _assets(),
        [1.0, 1.0, 1.0, 1.0],
    )

    assert report == {"ok": True, "errors": []}


def test_exported_glb_accepts_omitted_white_base_colour_factor():
    document = _material_document()
    del document["materials"][-1]["pbrMetallicRoughness"]["baseColorFactor"]

    report = glb_verify().compare_glb_material_contract(
        document,
        _assets(),
        [1.0, 1.0, 1.0, 1.0],
    )

    assert report == {"ok": True, "errors": []}


def test_exported_glb_rejects_opaque_artwork_material():
    document = _material_document()
    document["materials"][0]["alphaMode"] = "OPAQUE"

    report = glb_verify().compare_glb_material_contract(
        document,
        _assets(),
        [1.0, 1.0, 1.0, 1.0],
    )

    assert report["ok"] is False
    assert report["errors"][0]["code"] == "semantic_face_material_invalid"
    assert report["errors"][0]["face"] == "front"


def test_exported_glb_rejects_missing_or_wrong_substrate_core():
    document = _material_document()
    document["materials"][-1]["pbrMetallicRoughness"]["baseColorFactor"] = [0.8, 0.81, 0.81, 1.0]
    document["nodes"][-1]["name"] = "ordinary-cube"

    report = glb_verify().compare_glb_material_contract(
        document,
        _assets(),
        [1.0, 1.0, 1.0, 1.0],
    )

    assert report["ok"] is False
    assert {error["code"] for error in report["errors"]} == {
        "paperboard_material_invalid",
        "paperboard_core_binding_missing",
    }


def test_glb_json_reader_checks_the_binary_container(tmp_path: Path):
    document = _material_document()
    payload = json.dumps(document, separators=(",", ":")).encode("utf-8")
    payload += b" " * ((4 - len(payload) % 4) % 4)
    total_length = 12 + 8 + len(payload)
    glb = (
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<II", len(payload), 0x4E4F534A)
        + payload
    )
    path = tmp_path / "material-contract.glb"
    path.write_bytes(glb)

    assert glb_verify().load_glb_json(path) == document
