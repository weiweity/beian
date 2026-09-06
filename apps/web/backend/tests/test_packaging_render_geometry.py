"""RF-05 synthetic geometry only: never launches Blender or opens artwork."""
import importlib.util
from copy import deepcopy
from pathlib import Path

import pytest


def geometry_module():
    path = Path(__file__).resolve().parents[4] / "workers/packaging/render_geometry.py"
    spec = importlib.util.spec_from_file_location("render_geometry", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("sizes", [(47.5, 47.5, 177.5), (200, 80, 30), (1, 2, 3)])
def test_shell_preserves_outer_dimensions_and_real_thickness(sizes):
    geometry = geometry_module()
    dims = dict(zip(("width", "depth", "height"), sizes))
    model = geometry.carton_meshes(dims)
    points = [point for face in model["surfaces"].values() for point in face["vertices"]]
    for axis, size in enumerate(sizes):
        assert max(p[axis] for p in points) - min(p[axis] for p in points) == pytest.approx(size)
    core = model["core"]
    count = len(core["vertices"]) // 2
    assert count > 8
    for outer, inner in zip(core["vertices"][:count], core["vertices"][count:]):
        assert sum((a - b) ** 2 for a, b in zip(outer, inner)) ** 0.5 == pytest.approx(model["parameters"]["thickness_mm"])
    for surface in model["surfaces"].values():
        assert len(surface["triangles"]) > 2
        for axis in (0, 1):
            assert min(uv[axis] for uv in surface["uvs"]) == 0
            assert max(uv[axis] for uv in surface["uvs"]) == 1


def test_core_has_two_closed_oppositely_wound_boundaries():
    model = geometry_module().carton_meshes({"width": 50, "depth": 40, "height": 100})
    core = model["core"]
    edges = {}
    for triangle in core["triangles"]:
        for a, b in zip(triangle, triangle[1:] + triangle[:1]):
            key = tuple(sorted((a, b)))
            edges.setdefault(key, []).append((a, b))
    assert all(len(pair) == 2 and pair[0] == pair[1][::-1] for pair in edges.values())
    def volume(triangles):
        total = 0
        for triangle in triangles:
            a,b,c = [core["vertices"][i] for i in triangle]
            cross = [b[1]*c[2]-b[2]*c[1], b[2]*c[0]-b[0]*c[2], b[0]*c[1]-b[1]*c[0]]
            total += sum(x*y for x,y in zip(a,cross))/6
        return total
    half = len(core["triangles"])//2
    outside, cavity = volume(core["triangles"][:half]), volume(core["triangles"][half:])
    assert outside > 0 > cavity
    assert 0 < outside+cavity < outside*0.1


@pytest.mark.parametrize("face, expected", [
    ("front", [-12.5,-20,75]), ("right", [25,-10,75]),
    ("back", [12.5,20,75]), ("left", [-25,10,75]),
    ("top", [-12.5,10,100]), ("bottom", [-12.5,-10,0]),
])
def test_uv_landmarks_independently_preserve_legacy_face_direction(face, expected):
    point, _ = geometry_module().surface_point(face, [0.25,0.75], [50,40,100], 0.6)
    assert point == pytest.approx(expected)


@pytest.mark.parametrize("bad", [0, -1, float("nan"), float("inf"), True])
def test_invalid_dimensions_fail_closed(bad):
    with pytest.raises(ValueError):
        geometry_module().carton_meshes({"width": bad, "depth": 40, "height": 100})


def shell_evidence(module):
    dims = {"width": 50, "depth": 40, "height": 100}
    model = module.carton_meshes(dims)
    surfaces = {face: [{"position": [p/1000 for p in chart["vertices"][i]], "uv": chart["uvs"][i]}
                       for triangle in chart["triangles"] for i in triangle] for face,chart in model["surfaces"].items()}
    core = [{"materials": ["MAT_PaperboardEdge"], "triangles": [
        [[p/1000 for p in model["core"]["vertices"][i]] for i in tri] for tri in model["core"]["triangles"]]}]
    return dims, surfaces, core


def test_shell_evidence_accepts_complete_oriented_model():
    module = geometry_module()
    dims, surfaces, core = shell_evidence(module)
    assert module.compare_shell_surfaces(surfaces, dims, {})["ok"]
    assert module.compare_shell_core(core, dims, {})["ok"]


@pytest.mark.parametrize("face", ["front", "right", "back", "left", "top", "bottom"])
@pytest.mark.parametrize("change", ["mirror", "missing", "duplicate", "winding", "detached"])
def test_curved_artwork_rejects_wrong_uv_or_topology(face, change):
    module = geometry_module()
    dims, surfaces, _ = deepcopy(shell_evidence(module))
    chart = surfaces[face]
    if change == "mirror":
        for sample in chart:
            sample["uv"] = [1-sample["uv"][0], sample["uv"][1]]
    elif change == "missing":
        del chart[:3]
    elif change == "duplicate":
        chart[:3] = deepcopy(chart[3:6])
    elif change == "winding":
        chart[:3] = list(reversed(chart[:3]))
    else:
        chart[0]["position"][0] += 0.001
    assert not module.compare_shell_surfaces(surfaces, dims, {})["ok"]


@pytest.mark.parametrize("change", ["missing_inner", "reverse_inner", "duplicate", "solid", "scale", "material"])
def test_core_rejects_incomplete_or_counterfeit_paperboard(change):
    module = geometry_module()
    dims, _, core = deepcopy(shell_evidence(module))
    triangles = core[0]["triangles"]
    half = len(triangles)//2
    if change == "missing_inner":
        del triangles[half:]
    elif change == "reverse_inner":
        triangles[half] = list(reversed(triangles[half]))
    elif change == "duplicate":
        triangles[0] = deepcopy(triangles[1])
    elif change == "solid":
        triangles[half:] = deepcopy(triangles[:half])
    elif change == "scale":
        triangles[0][0][0] += 0.001
    else:
        core[0]["materials"] = ["MAT_front"]
    assert not module.compare_shell_core(core, dims, {})["ok"]


def shell_artifact(tmp_path, monkeypatch):
    """Use real GLB bytes and existing image fixtures, without a bpy dependency."""
    import struct
    import test_packaging_glb_verify as fixture

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[4] / "workers/packaging"))
    verifier = fixture.glb_verify()
    artifact, assets = fixture._material_artifact(verifier, tmp_path)
    doc, binary = artifact.document, bytearray(artifact.binary)
    doc["accessors"] = []
    dimensions = {"width": 30, "depth": 20, "height": 50}
    geometry = {"family": "rectangular_carton_v1", "closure_detail": "closed-carton-shell-v1",
                "preview_fidelity": "carton_physical_v1", "thickness_mm": 0.4,
                "core_bevel_mm": 0.6, "surface_gap_mm": 0.002, "bevel_segments": 4}
    identity = {"render_profile_id": "synthetic-carton", "render_contract_hash": "sha256:" + "a" * 64}
    model = geometry_module().carton_meshes(dimensions, geometry)

    def accessor(rows, kind, component=5126):
        fmt = {5126: "f", 5123: "H"}[component]
        payload = b"".join(struct.pack("<" + fmt * len(row), *row) for row in rows)
        view = len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(payload)})
        binary.extend(payload)
        binary.extend(b"\0" * (-len(binary) % 4))
        index = len(doc["accessors"])
        doc["accessors"].append({"bufferView": view, "componentType": component, "count": len(rows), "type": kind})
        return index

    for index, face in enumerate([*verifier.SEMANTIC_FACES, "core"]):
        mesh = model["core"] if face == "core" else model["surfaces"][face]
        primitive = doc["meshes"][index]["primitives"][0]
        primitive["attributes"] = {"POSITION": accessor([[x/1000, z/1000, -y/1000] for x,y,z in mesh["vertices"]], "VEC3")}
        primitive["indices"] = accessor([[i] for triangle in mesh["triangles"] for i in triangle], "SCALAR", 5123)
        if face != "core":
            primitive["attributes"]["TEXCOORD_0"] = accessor([[u, 1-v] for u,v in mesh["uvs"]], "VEC2")
            doc["materials"][index]["pbrMetallicRoughness"]["baseColorFactor"] = [verifier.PAPER_ALBEDO_LINEAR]*3 + [1.0]
        doc["nodes"][index]["extras"] = {**identity, "render_family": geometry["family"], "geometry_model": geometry["closure_detail"]}
    doc["scene"] = 0
    doc["scenes"] = [{"nodes": list(range(7))}]
    doc["buffers"][0]["byteLength"] = len(binary)
    artifact = verifier.GlbArtifact(doc, bytes(binary))
    return fixture, verifier, artifact, assets, dimensions, geometry, identity


def shell_artifact_report(parts, tmp_path):
    fixture, verifier, artifact, assets, dimensions, geometry, identity = parts
    loaded = verifier.load_glb_artifact(fixture._write_artifact(verifier, tmp_path, artifact))
    return verifier.compare_glb_artifact_contract(loaded, assets, dimensions, 0.5, [1,1,1,1],
                                                 geometry=geometry, render_identity=identity)


def test_shell_binary_roundtrip_enforces_geometry_and_material_contract(tmp_path, monkeypatch):
    parts = shell_artifact(tmp_path, monkeypatch)
    report = shell_artifact_report(parts, tmp_path)
    assert report["ok"], report
    assert all(report[key]["ok"] for key in ("dimensions", "surface", "core", "material"))
    # A shell cannot opt into the legacy planar verifier by omitting its contract.
    parts[-2].clear()
    assert not shell_artifact_report(parts, tmp_path)["ok"]


@pytest.mark.parametrize("key", ["render_family", "geometry_model", "render_profile_id", "render_contract_hash"])
@pytest.mark.parametrize("damage", ["missing", "counterfeit"])
def test_shell_binary_rejects_unbound_mesh_metadata(tmp_path, monkeypatch, key, damage):
    parts = shell_artifact(tmp_path, monkeypatch)
    metadata = parts[2].document["nodes"][0]["extras"]
    if damage == "missing":
        del metadata[key]
    else:
        metadata[key] = "counterfeit"
    report = shell_artifact_report(parts, tmp_path)
    assert not report["ok"]
    assert "metadata" in report["errors"][0]["detail"]


@pytest.mark.parametrize("damage", ["missing_identity", "wrong_family", "wrong_thickness", "missing_inner", "mirrored_uv", "wrong_texture"])
def test_shell_binary_cannot_pass_on_metadata_alone(tmp_path, monkeypatch, damage):
    import struct

    parts = shell_artifact(tmp_path, monkeypatch)
    _, verifier, artifact, _, _, geometry, identity = parts
    doc = artifact.document
    if damage == "missing_identity":
        identity.clear()
    elif damage == "wrong_family":
        geometry["family"] = "pouch_thin_card_v1"
    elif damage == "wrong_thickness":
        geometry["thickness_mm"] = 0.8
    elif damage == "missing_inner":
        indexes = doc["meshes"][-1]["primitives"][0]["indices"]
        doc["accessors"][indexes]["count"] //= 2
    elif damage == "mirrored_uv":
        indexes = doc["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"]
        row = doc["accessors"][indexes]
        offset = doc["bufferViews"][row["bufferView"]]["byteOffset"]
        binary = bytearray(artifact.binary)
        struct.pack_into("<f", binary, offset, 1.0)
        parts = (*parts[:2], verifier.GlbArtifact(doc, bytes(binary)), *parts[3:])
    else:
        doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"] = 1
    assert not shell_artifact_report(parts, tmp_path)["ok"]
