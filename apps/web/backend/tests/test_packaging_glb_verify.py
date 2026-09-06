from __future__ import annotations

import importlib.util
from io import BytesIO
import json
import os
from pathlib import Path
import struct
import hashlib
import random
import shutil
import subprocess
import sys
import zlib

import pytest
from PIL import Image


MODULE = Path(__file__).resolve().parents[4] / "workers" / "packaging" / "glb_verify.py"


def glb_verify():
    spec = importlib.util.spec_from_file_location("packaging_glb_verify", MODULE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _filtered_png(rows, filters):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    previous = bytes(len(rows[0]))
    raw = bytearray()
    for row, f in zip(rows, filters, strict=True):
        raw.append(f)
        for x, value in enumerate(row):
            left, up = (row[x-4] if x >= 4 else 0), previous[x]
            corner = previous[x-4] if x >= 4 else 0
            estimate = left + up - corner
            distances = [abs(estimate-p) for p in (left, up, corner)]
            paeth = (left, up, corner)[distances.index(min(distances))]
            predictor = (0, left, up, (left+up)//2, paeth)[f]
            raw.append((value-predictor) & 255)
        previous = row
    header = struct.pack('>IIBBBBB', len(rows[0])//4, len(rows), 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


@pytest.mark.parametrize('filter_type', range(5))
def test_png_filters_match_exact_pixels_and_pillow(filter_type):
    rng = random.Random(17)
    rows = [rng.randbytes(37*4) for _ in range(6)]
    rows += [rows[-1], rows[-1], bytes(37*4)]
    payload = _filtered_png(rows, [filter_type]*len(rows))
    pixels = b''.join(rows)
    assert Image.open(BytesIO(payload)).tobytes() == pixels
    report = glb_verify()._decode_png_rgba(payload)
    assert report == dict(width=37, height=9,
        pixel_sha256=hashlib.sha256(pixels).hexdigest(),
        alpha_sha256=hashlib.sha256(pixels[3::4]).hexdigest(),
        transparent_pixels=sum(v < 255 for v in pixels[3::4]))
    damaged = bytearray(payload)
    damaged[-1] ^= 1
    with pytest.raises(ValueError, match='checksum'):
        glb_verify()._decode_png_rgba(bytes(damaged))


@pytest.mark.parametrize('filters', [[2], [2, 0, 2, 1, 2, 3, 0, 4, 2]])
def test_png_fast_paths_preserve_state_across_first_and_mixed_rows(filters):
    rng = random.Random(81)
    rows = []
    for filter_type in filters:
        if filter_type == 2:
            rows.append(rows[-1] if rows else bytes(4))
        else:
            rows.append(rng.randbytes(4))
    payload = _filtered_png(rows, filters)
    pixels = b''.join(rows)
    assert Image.open(BytesIO(payload)).tobytes() == pixels
    assert glb_verify()._decode_png_rgba(payload) == dict(
        width=1, height=len(rows), pixel_sha256=hashlib.sha256(pixels).hexdigest(),
        alpha_sha256=hashlib.sha256(pixels[3::4]).hexdigest(),
        transparent_pixels=sum(value < 255 for value in pixels[3::4]),
    )


def test_repeated_up_rows_avoid_per_byte_python_loop():
    module = glb_verify()
    rows = [bytes([3, 128, 254, 255])*64]*24
    payload = _filtered_png(rows, [0]+[2]*23)
    events = 0
    def trace(frame, event, arg):
        nonlocal events
        if event == 'line' and frame.f_code.co_filename == str(MODULE):
            events += 1
        return trace
    previous_trace = sys.gettrace()
    try:
        sys.settrace(trace)
        result = module._decode_png_rgba(payload)
    finally:
        sys.settrace(previous_trace)
    assert result['pixel_sha256'] == hashlib.sha256(b''.join(rows)).hexdigest()
    assert events < 3000, f'repeated rows used {events} Python line events'


def test_axis_dimensions_pass_with_small_export_tolerance():
    report = glb_verify().compare_glb_dimensions(
        [0.03013, 0.02013, 0.05013],
        {"width": 30, "depth": 20, "height": 50},
        0.5,
    )
    assert report["ok"] is True
    assert report["measured_mm"]["width"] == 30.13


def test_png_pixel_budget_checked_before_decompression(monkeypatch):
    module = glb_verify()
    payload = _filtered_png([bytes(4) * 3], [0])
    def forbidden(*args, **kwargs):
        pytest.fail("over-budget image reached decompression")
    monkeypatch.setattr(module.zlib, "decompressobj", forbidden)
    with pytest.raises(ValueError, match="pixel budget"):
        module._decode_png_rgba(payload, max_pixels=2)


def test_glb_read_budget_precedes_container_parse(tmp_path):
    path = tmp_path / "large.glb"
    path.write_bytes(b"x" * 65)
    with pytest.raises(ValueError, match="byte budget"):
        glb_verify().load_glb_artifact(path, max_bytes=64)


def test_png_inflate_is_bounded_by_declared_scanlines(monkeypatch):
    module = glb_verify()
    payload = _filtered_png([bytes(4)], [0])
    real_factory = zlib.decompressobj
    limits = []
    class ObservedInflater:
        def __init__(self):
            self.inner = real_factory()
        def decompress(self, data, max_length=0):
            limits.append(max_length)
            return self.inner.decompress(data, max_length)
        def __getattr__(self, key):
            return getattr(self.inner, key)
    monkeypatch.setattr(module.zlib, "decompressobj", ObservedInflater)
    assert module._decode_png_rgba(payload)["width"] == 1
    assert limits == [6]  # RGBA + filter byte + one overflow sentinel


@pytest.mark.parametrize("tail", [b"extra", zlib.compress(b"second stream")])
def test_png_rejects_trailing_compressed_data(tail):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    payload = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(5)) + tail) + chunk(b"IEND", b"")
    with pytest.raises(ValueError, match="scanlines"):
        glb_verify()._decode_png_rgba(payload)


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


def _material_artifact(module, tmp_path: Path, *, opaque_embedded_face: str | None = None, expected_assets=None):
    document = _material_document()
    binary = bytearray()
    buffer_views = []
    assets = {}
    for index, face in enumerate(module.SEMANTIC_FACES):
        colour = (30 + index * 20, 40 + index * 10, 90 + index * 15)
        expected_path = Path(expected_assets[face]) if expected_assets else tmp_path / f"panel_{face}.png"
        expected_payload = expected_path.read_bytes() if expected_assets else _png_payload(colour, transparent=True)
        if not expected_assets:
            expected_path.write_bytes(expected_payload)
        assets[face] = str(expected_path)
        payload = expected_payload if expected_assets else _png_payload(colour, transparent=face != opaque_embedded_face)
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


def _runtime_artifact(module, tmp_path, *, expected_assets=None, dimensions=None, substrate=None):
    artifact, assets = _material_artifact(module, tmp_path, expected_assets=expected_assets)
    doc = artifact.document
    binary = bytearray(artifact.binary)
    doc["accessors"] = []
    for material in doc["materials"][:6]:
        material["pbrMetallicRoughness"]["baseColorFactor"] = [module.PAPER_ALBEDO_LINEAR]*3 + [1.0]
    if substrate:
        doc["materials"][-1]["pbrMetallicRoughness"]["baseColorFactor"] = substrate
    def accessor(rows, kind, component=5126):
        fmt = {5126: "f", 5123: "H"}[component]
        payload = b"".join(struct.pack("<" + fmt * len(row), *row) for row in rows)
        offset = len(binary)
        binary.extend(payload)
        binary.extend(b"\0" * (-len(binary) % 4))
        view = len(doc["bufferViews"])
        doc["bufferViews"].append(dict(buffer=0, byteOffset=offset, byteLength=len(payload)))
        index = len(doc["accessors"])
        doc["accessors"].append(dict(bufferView=view, componentType=component, count=len(rows), type=kind))
        return index
    def gltf(point):
        x, y, z = point
        if dimensions:
            x, y, z = x*dimensions["width"]/30, y*dimensions["depth"]/20, z*dimensions["height"]/50
        return [x, z, -y]
    for i, samples in enumerate(_surface_samples().values()):
        primitive = doc["meshes"][i]["primitives"][0]
        primitive["attributes"] = {
            "POSITION": accessor([gltf(s["position"]) for s in samples], "VEC3"),
            "TEXCOORD_0": accessor([[s["uv"][0], 1-s["uv"][1]] for s in samples], "VEC2"),
        }
        primitive["indices"] = accessor([[n] for n in [0, 1, 2, 0, 2, 3]], "SCALAR", 5123)
    core = _core_objects()[0]
    primitive = doc["meshes"][-1]["primitives"][0]
    primitive["attributes"] = {"POSITION": accessor([gltf(p) for triangle in core["triangles"] for p in triangle], "VEC3")}
    doc["scene"] = 0
    doc["scenes"] = [{"nodes": list(range(7))}]
    doc["buffers"][0]["byteLength"] = len(binary)
    return module.GlbArtifact(doc, bytes(binary)), assets


def _runtime_report(module, artifact, assets):
    return module.compare_glb_artifact_contract(artifact, assets,
        {"width": 30, "depth": 20, "height": 50}, 0.5, [1, 1, 1, 1])


def test_runtime_reads_actual_glb_binary_not_self_reported_measurements(tmp_path):
    module = glb_verify()
    artifact, assets = _runtime_artifact(module, tmp_path)
    artifact = module.load_glb_artifact(_write_artifact(module, tmp_path, artifact))
    report = _runtime_report(module, artifact, assets)
    assert report["ok"], report
    assert report["dimensions"]["measured_mm"]["height"] == pytest.approx(50)


@pytest.mark.parametrize("damage", ["empty_scene", "missing_face", "wrong_material", "duplicate_face", "sparse", "huge_accessor", "bad_index", "nan", "mirrored_uv", "moved_face", "open_core", "cycle", "external_buffer", "texture_transform", "duplicate_material", "tinted_face", "short_buffer", "textured_core"])
def test_runtime_rejects_actual_binary_and_scene_tampering(tmp_path, damage):
    module = glb_verify()
    artifact, assets = _runtime_artifact(module, tmp_path)
    doc = artifact.document
    primitive = doc["meshes"][0]["primitives"][0]
    position = doc["accessors"][primitive["attributes"]["POSITION"]]
    binary = bytearray(artifact.binary)
    def overwrite(index, fmt, values):
        row = doc["accessors"][index]
        offset = doc["bufferViews"][row["bufferView"]].get("byteOffset", 0)
        struct.pack_into(fmt, binary, offset, *values)
    if damage == "empty_scene": doc["scenes"][0]["nodes"] = []
    elif damage == "missing_face": doc["scenes"][0]["nodes"].remove(0)
    elif damage == "wrong_material": primitive["material"] = 1
    elif damage == "duplicate_face": doc["nodes"][1]["name"] = "front.001"
    elif damage == "sparse": position["sparse"] = {"count": 1}
    elif damage == "huge_accessor": position["count"] = 10**9
    elif damage == "bad_index": overwrite(primitive["indices"], "<H", [65535])
    elif damage == "nan": overwrite(primitive["attributes"]["POSITION"], "<f", [float("nan")])
    elif damage == "mirrored_uv": overwrite(primitive["attributes"]["TEXCOORD_0"], "<f", [1])
    elif damage == "moved_face": doc["nodes"][0]["translation"] = [0, 0, 0.02]
    elif damage == "open_core": doc["accessors"][doc["meshes"][-1]["primitives"][0]["attributes"]["POSITION"]]["count"] = 33
    elif damage == "cycle": doc["nodes"][0]["children"] = [0]
    elif damage == "external_buffer": doc["buffers"][0]["uri"] = "private.bin"
    elif damage == "texture_transform": doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["extensions"] = {"KHR_texture_transform": {"offset": [0.5, 0]}}
    elif damage == "duplicate_material":
        from copy import deepcopy
        doc["materials"].append(deepcopy(doc["materials"][0]))
        doc["materials"][-1]["alphaMode"] = "OPAQUE"
        primitive["material"] = 7
    elif damage == "tinted_face": doc["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"] = [0.5,1,1,1]
    elif damage == "short_buffer": doc["buffers"][0]["byteLength"] = 4
    elif damage == "textured_core": doc["materials"][-1]["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
    artifact = module.GlbArtifact(doc, bytes(binary))
    report = _runtime_report(module, artifact, assets)
    assert not report["ok"], (damage, report)


def test_runtime_applies_parent_matrix_and_child_trs(tmp_path):
    module = glb_verify()
    artifact, assets = _runtime_artifact(module, tmp_path)
    doc = artifact.document
    # Two cancelling transforms must preserve actual world dimensions/UV.
    doc["nodes"].append({"matrix": [2,0,0,0,0,2,0,0,0,0,2,0,1,2,3,1], "children": list(range(7))})
    doc["scenes"][0]["nodes"] = [7]
    for node in doc["nodes"][:7]:
        node.update(scale=[0.5]*3, translation=[-0.5,-1,-1.5], rotation=[0,0,0,1])
    report = _runtime_report(module, artifact, assets)
    assert report["ok"], report


@pytest.mark.skipif(os.environ.get("BEIAN_TEST_BLENDER_EXPORT") != "1", reason="explicit local synthetic Blender export check")
def test_runtime_reads_actual_blender_export_without_rendering(tmp_path):
    blender = shutil.which("blender")
    assert blender, "explicit export check needs Blender"
    module = glb_verify()
    _artifact, assets = _material_artifact(module, tmp_path)
    job = {"code": "synthetic", "display_name": "synthetic", "source_ai": "SYNTHETIC_NOT_CUSTOMER",
        "assets": assets, "dimensions_mm": {"width": 30, "depth": 20, "height": 50},
        "glb_tolerance_mm": 0.5, "render": {"substrate_rgba": [1,1,1,1]},
        "outputs": {"glb": str(tmp_path / "actual.glb"), "blend": str(tmp_path / "actual.blend")}}
    job_path = tmp_path / "job.json"
    job_path.write_text(json.dumps(job))
    script = tmp_path / "export_synthetic.py"
    script.write_text(
        "import importlib.util,json,sys\n"
        f"spec=importlib.util.spec_from_file_location('renderer',{str(MODULE.parent / 'blender' / 'render_job.py')!r})\n"
        "renderer=importlib.util.module_from_spec(spec);spec.loader.exec_module(renderer)\n"
        f"job=json.load(open({str(job_path)!r}))\n"
        "renderer.clean_scene()\n"
        "root,objects=renderer.add_box(job)\n"
        "renderer.export_model(job,root,objects)\n"
    )
    completed = subprocess.run([blender, "--background", "--factory-startup", "--python-exit-code", "1", "--python", str(script)],
        capture_output=True, text=True, timeout=60)
    assert completed.returncode == 0, (completed.stdout + completed.stderr)[-4000:]
    artifact = module.load_glb_artifact(job["outputs"]["glb"])
    sys.path.insert(0, str(MODULE.parent))
    report = module.compare_glb_artifact_contract(artifact, assets, job["dimensions_mm"], 0.5, [1,1,1,1])
    assert report["ok"], report


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
