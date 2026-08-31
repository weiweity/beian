from __future__ import annotations

import importlib.util
from io import BytesIO
import json
from pathlib import Path
import struct

import pytest
from PIL import Image


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


def _png_payload(colour: tuple[int, int, int], *, transparent: bool) -> bytes:
    image = Image.new("RGBA", (2, 2), (*colour, 255))
    if transparent:
        image.putpixel((0, 0), (*colour, 0))
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _material_artifact(module, tmp_path: Path, *, opaque_embedded_face: str | None = None):
    document = _material_document()
    binary = bytearray()
    buffer_views = []
    assets = {}
    for index, face in enumerate(module.SEMANTIC_FACES):
        colour = (30 + index * 20, 40 + index * 10, 90 + index * 15)
        expected_payload = _png_payload(colour, transparent=True)
        expected_path = tmp_path / f"panel_{face}.png"
        expected_path.write_bytes(expected_payload)
        assets[face] = str(expected_path)
        payload = _png_payload(colour, transparent=face != opaque_embedded_face)
        offset = len(binary)
        binary.extend(payload)
        binary.extend(b"\x00" * ((4 - len(binary) % 4) % 4))
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(payload)})
        document["images"][index].update(
            {"bufferView": index, "mimeType": "image/png"}
        )
    document["bufferViews"] = buffer_views
    document["buffers"] = [{"byteLength": len(binary)}]
    return module.GlbArtifact(document, bytes(binary)), assets


def _write_artifact(module, tmp_path: Path, artifact) -> Path:
    document = json.dumps(artifact.document, separators=(",", ":")).encode("utf-8")
    document += b" " * ((4 - len(document) % 4) % 4)
    total_length = 12 + 8 + len(document) + 8 + len(artifact.binary)
    path = tmp_path / "artifact.glb"
    path.write_bytes(
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<II", len(document), module.GLB_JSON_CHUNK)
        + document
        + struct.pack("<II", len(artifact.binary), module.GLB_BIN_CHUNK)
        + artifact.binary
    )
    return path


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


def test_exported_glb_requires_masked_rgba_faces_and_opaque_substrate_core(tmp_path: Path):
    module = glb_verify()
    artifact, assets = _material_artifact(module, tmp_path)
    artifact = module.load_glb_artifact(_write_artifact(module, tmp_path, artifact))
    report = module.compare_glb_material_contract(
        artifact,
        assets,
        [1.0, 1.0, 1.0, 1.0],
    )

    assert report == {"ok": True, "errors": []}


def test_exported_glb_accepts_omitted_white_base_colour_factor(tmp_path: Path):
    module = glb_verify()
    artifact, assets = _material_artifact(module, tmp_path)
    del artifact.document["materials"][-1]["pbrMetallicRoughness"]["baseColorFactor"]

    report = module.compare_glb_material_contract(
        artifact,
        assets,
        [1.0, 1.0, 1.0, 1.0],
    )

    assert report == {"ok": True, "errors": []}


def test_exported_glb_rejects_opaque_artwork_material(tmp_path: Path):
    module = glb_verify()
    artifact, assets = _material_artifact(module, tmp_path)
    artifact.document["materials"][0]["alphaMode"] = "OPAQUE"

    report = module.compare_glb_material_contract(
        artifact,
        assets,
        [1.0, 1.0, 1.0, 1.0],
    )

    assert report["ok"] is False
    assert report["errors"][0]["code"] == "semantic_face_material_invalid"
    assert report["errors"][0]["face"] == "front"


def test_exported_glb_rejects_missing_or_wrong_substrate_core(tmp_path: Path):
    module = glb_verify()
    artifact, assets = _material_artifact(module, tmp_path)
    artifact.document["materials"][-1]["pbrMetallicRoughness"]["baseColorFactor"] = [0.8, 0.81, 0.81, 1.0]
    artifact.document["nodes"][-1]["name"] = "ordinary-cube"

    report = module.compare_glb_material_contract(
        artifact,
        assets,
        [1.0, 1.0, 1.0, 1.0],
    )

    assert report["ok"] is False
    assert {error["code"] for error in report["errors"]} == {
        "paperboard_material_invalid",
        "paperboard_core_binding_missing",
    }


def test_exported_glb_rejects_same_name_jpeg_without_rgba(tmp_path: Path):
    module = glb_verify()
    artifact, assets = _material_artifact(module, tmp_path)
    artifact.document["images"][0]["mimeType"] = "image/jpeg"

    report = module.compare_glb_material_contract(
        artifact,
        assets,
        [1.0, 1.0, 1.0, 1.0],
    )

    assert report["ok"] is False
    front = next(error for error in report["errors"] if error.get("face") == "front")
    assert front["observed"][0]["image_contract"]["code"] == "embedded_image_not_rgba_png"


def test_exported_glb_rejects_same_name_png_with_changed_alpha(tmp_path: Path):
    module = glb_verify()
    artifact, assets = _material_artifact(module, tmp_path, opaque_embedded_face="front")

    report = module.compare_glb_material_contract(
        artifact,
        assets,
        [1.0, 1.0, 1.0, 1.0],
    )

    assert report["ok"] is False
    front = next(error for error in report["errors"] if error.get("face") == "front")
    assert front["observed"][0]["image_contract"]["code"] == "embedded_image_pixels_mismatch"


def test_exported_glb_accepts_explicit_non_white_substrate(tmp_path: Path):
    module = glb_verify()
    artifact, assets = _material_artifact(module, tmp_path)
    substrate = [0.46, 0.28, 0.12, 1.0]
    artifact.document["materials"][-1]["pbrMetallicRoughness"]["baseColorFactor"] = substrate

    report = module.compare_glb_material_contract(artifact, assets, substrate)

    assert report == {"ok": True, "errors": []}


def _surface_samples():
    width, depth, height = 0.03, 0.02, 0.05
    x0, x1 = -width / 2, width / 2
    y0, y1 = -depth / 2, depth / 2
    z0, z1 = 0.0, height

    def samples(points):
        uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
        return [{"position": list(point), "uv": list(uv)} for point, uv in zip(points, uvs)]

    return {
        "front": samples([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)]),
        "right": samples([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)]),
        "back": samples([(x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)]),
        "left": samples([(x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)]),
        "top": samples([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]),
        "bottom": samples([(x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0)]),
    }


def _core_objects():
    x0, x1 = -0.015, 0.015
    y0, y1 = -0.01, 0.01
    z0, z1 = 0.0, 0.05
    points = [
        (x0, y0, z0),
        (x1, y0, z0),
        (x1, y1, z0),
        (x0, y1, z0),
        (x0, y0, z1),
        (x1, y0, z1),
        (x1, y1, z1),
        (x0, y1, z1),
    ]
    indexes = [
        (0, 2, 1), (0, 3, 2),
        (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4),
        (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6),
        (3, 0, 4), (3, 4, 7),
    ]
    return [{
        "materials": ["MAT_PaperboardEdge"],
        "points": [list(point) for point in points],
        "triangles": [[list(points[index]) for index in triangle] for triangle in indexes],
    }]


def test_round_tripped_surfaces_preserve_all_six_uv_orientations():
    report = glb_verify().compare_glb_surface_contract(
        _surface_samples(),
        {"width": 30, "depth": 20, "height": 50},
        0.5,
    )

    assert report == {"ok": True, "errors": []}


@pytest.mark.parametrize(
    "transform",
    [
        lambda u, v: (1.0 - u, v),
        lambda u, v: (v, 1.0 - u),
    ],
    ids=["mirrored", "quarter-turned"],
)
def test_round_tripped_surface_rejects_mirrored_or_rotated_uv(transform):
    surfaces = _surface_samples()
    for sample in surfaces["front"]:
        sample["uv"] = list(transform(*sample["uv"]))

    report = glb_verify().compare_glb_surface_contract(
        surfaces,
        {"width": 30, "depth": 20, "height": 50},
        0.5,
    )

    assert report["ok"] is False
    assert report["errors"][0]["code"] == "semantic_face_uv_invalid"
    assert report["errors"][0]["face"] == "front"


def test_round_tripped_core_covers_all_six_box_boundaries():
    report = glb_verify().compare_glb_core_contract(
        _core_objects(),
        {"width": 30, "depth": 20, "height": 50},
        0.5,
    )

    assert report == {"ok": True, "errors": []}


def test_round_tripped_core_rejects_a_tiny_degenerate_primitive():
    objects = _core_objects()
    objects[0]["triangles"] = [objects[0]["triangles"][0]] * 12

    report = glb_verify().compare_glb_core_contract(
        objects,
        {"width": 30, "depth": 20, "height": 50},
        0.5,
    )

    assert report["ok"] is False
    assert report["errors"][0]["code"] == "paperboard_core_geometry_invalid"


def test_round_tripped_core_rejects_six_disconnected_boundary_patches():
    objects = _core_objects()
    patches = [
        [(-0.015, -0.001, 0.024), (-0.015, 0.001, 0.024), (-0.015, 0.0, 0.026)],
        [(0.015, -0.001, 0.024), (0.015, 0.0, 0.026), (0.015, 0.001, 0.024)],
        [(-0.001, -0.01, 0.024), (0.001, -0.01, 0.024), (0.0, -0.01, 0.026)],
        [(-0.001, 0.01, 0.024), (0.0, 0.01, 0.026), (0.001, 0.01, 0.024)],
        [(-0.001, -0.001, 0.0), (0.001, -0.001, 0.0), (0.0, 0.001, 0.0)],
        [(-0.001, -0.001, 0.05), (0.0, 0.001, 0.05), (0.001, -0.001, 0.05)],
    ]
    objects[0]["triangles"] = [
        [list(point) for point in triangle]
        for patch in patches
        for triangle in (patch, tuple(reversed(patch)))
    ]

    report = glb_verify().compare_glb_core_contract(
        objects,
        {"width": 30, "depth": 20, "height": 50},
        0.5,
    )

    assert report["ok"] is False
    assert "closed connected manifold" in report["errors"][0]["detail"]


def test_glb_json_reader_checks_the_binary_container(tmp_path: Path):
    document = _material_document()
    payload = json.dumps(document, separators=(",", ":")).encode("utf-8")
    payload += b" " * ((4 - len(payload) % 4) % 4)
    binary = b"\x00\x00\x00\x00"
    total_length = 12 + 8 + len(payload) + 8 + len(binary)
    glb = (
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<II", len(payload), 0x4E4F534A)
        + payload
        + struct.pack("<II", len(binary), 0x004E4942)
        + binary
    )
    path = tmp_path / "material-contract.glb"
    path.write_bytes(glb)

    assert glb_verify().load_glb_json(path) == document


@pytest.mark.parametrize(
    "payload",
    [
        b"not-a-glb",
        struct.pack("<4sII", b"glTF", 1, 12),
        struct.pack("<4sII", b"glTF", 2, 20) + struct.pack("<II", 4, 0x4E4F534A),
    ],
)
def test_glb_reader_rejects_malformed_containers(tmp_path: Path, payload: bytes):
    path = tmp_path / "broken.glb"
    path.write_bytes(payload)

    with pytest.raises((ValueError, json.JSONDecodeError)):
        glb_verify().load_glb_artifact(path)
