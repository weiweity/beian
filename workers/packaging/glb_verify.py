"""GLB geometry and semantic artwork verification shared by Blender and L0 tests."""

from __future__ import annotations

import json
from pathlib import Path
import struct
from typing import Any, Mapping, Sequence


AXIS_TO_DIMENSION = ("width", "depth", "height")
SEMANTIC_FACES = ("front", "right", "back", "left", "top", "bottom")
GLB_MAGIC = b"glTF"
GLB_VERSION = 2
GLB_JSON_CHUNK = 0x4E4F534A


def load_glb_json(path: Path | str) -> dict[str, Any]:
    """Read the JSON chunk from a GLB 2.0 file without trusting Blender import.

    The material contract is checked against the exported artifact itself.  A
    successful re-import is not sufficient because an importer can normalize
    or recreate material state that was absent from the GLB.
    """
    source = Path(path)
    data = source.read_bytes()
    if len(data) < 20:
        raise ValueError("GLB is too short")
    magic, version, declared_length = struct.unpack_from("<4sII", data, 0)
    if magic != GLB_MAGIC or version != GLB_VERSION or declared_length != len(data):
        raise ValueError("GLB header is invalid")
    offset = 12
    while offset + 8 <= len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk_end = offset + chunk_length
        if chunk_end > len(data):
            raise ValueError("GLB chunk exceeds declared length")
        if chunk_type == GLB_JSON_CHUNK:
            payload = data[offset:chunk_end].rstrip(b"\x00 \t\r\n")
            parsed = json.loads(payload.decode("utf-8"))
            if not isinstance(parsed, dict):
                raise ValueError("GLB JSON root must be an object")
            return parsed
        offset = chunk_end
    raise ValueError("GLB JSON chunk is missing")


def _normalized_name(value: object) -> str:
    return str(value or "").strip().lower().split(".", 1)[0]


def _indexed(items: object, index: object) -> Mapping[str, Any] | None:
    if not isinstance(items, list) or isinstance(index, bool) or not isinstance(index, int):
        return None
    if index < 0 or index >= len(items) or not isinstance(items[index], Mapping):
        return None
    return items[index]


def _base_color_image_name(document: Mapping[str, Any], material: Mapping[str, Any]) -> str:
    pbr = material.get("pbrMetallicRoughness")
    if not isinstance(pbr, Mapping):
        return ""
    texture_info = pbr.get("baseColorTexture")
    if not isinstance(texture_info, Mapping):
        return ""
    texture = _indexed(document.get("textures"), texture_info.get("index"))
    if texture is None:
        return ""
    image = _indexed(document.get("images"), texture.get("source"))
    if image is None:
        return ""
    return _asset_stem(image.get("name") or image.get("uri"))


def _base_color_factor(material: Mapping[str, Any]) -> object:
    """Return the effective glTF base colour, including the spec default.

    Exporters are allowed to omit ``baseColorFactor`` when it is white because
    glTF 2.0 defines ``[1, 1, 1, 1]`` as the default.  Contract verification
    must compare effective values instead of requiring redundant JSON fields.
    """
    pbr = material.get("pbrMetallicRoughness")
    if not isinstance(pbr, Mapping):
        return None
    return pbr.get("baseColorFactor", [1.0, 1.0, 1.0, 1.0])


def compare_glb_material_contract(
    document: Mapping[str, Any],
    expected_assets: Mapping[str, object],
    substrate_rgba: Sequence[float],
    *,
    colour_tolerance: float = 1e-4,
) -> dict[str, Any]:
    """Verify exported MASK artwork and the opaque paperboard core.

    glTF defines material alpha from the base-colour texture's alpha channel.
    Therefore each semantic face must retain both its exact RGBA image and
    ``alphaMode=MASK``.  Transparent pixels are meaningful only when an opaque
    core with the configured substrate colour is bound behind those panels.
    """
    materials = document.get("materials")
    if not isinstance(materials, list):
        return {"ok": False, "errors": [{"code": "materials_missing"}]}
    errors: list[dict[str, Any]] = []
    for face in SEMANTIC_FACES:
        candidates = [
            material
            for material in materials
            if isinstance(material, Mapping) and _normalized_name(material.get("name")) == f"mat_{face}"
        ]
        expected_image = _asset_stem(expected_assets.get(face))
        observed = [
            {
                "alpha_mode": str(material.get("alphaMode") or "OPAQUE"),
                "image": _base_color_image_name(document, material),
            }
            for material in candidates
        ]
        if not any(
            item["alpha_mode"] == "MASK" and expected_image and item["image"] == expected_image
            for item in observed
        ):
            errors.append(
                {
                    "code": "semantic_face_material_invalid",
                    "face": face,
                    "expected_alpha_mode": "MASK",
                    "expected_image": expected_image,
                    "observed": observed,
                }
            )

    expected_substrate = [float(value) for value in substrate_rgba]
    core_material_indexes: set[int] = set()
    for index, material in enumerate(materials):
        if not isinstance(material, Mapping) or _normalized_name(material.get("name")) != "mat_paperboardedge":
            continue
        factor = _base_color_factor(material)
        if (
            str(material.get("alphaMode") or "OPAQUE") == "OPAQUE"
            and isinstance(factor, list)
            and len(factor) == 4
            and all(
                isinstance(actual, (int, float))
                and abs(float(actual) - expected_substrate[channel]) <= colour_tolerance
                for channel, actual in enumerate(factor)
            )
        ):
            core_material_indexes.add(index)
    if not core_material_indexes:
        errors.append(
            {
                "code": "paperboard_material_invalid",
                "expected_material": "MAT_PaperboardEdge",
                "expected_alpha_mode": "OPAQUE",
                "expected_substrate_rgba": expected_substrate,
            }
        )

    core_bound = False
    nodes = document.get("nodes")
    meshes = document.get("meshes")
    if isinstance(nodes, list):
        for node in nodes:
            if not isinstance(node, Mapping) or not _normalized_name(node.get("name")).endswith("_box_core"):
                continue
            mesh = _indexed(meshes, node.get("mesh"))
            primitives = mesh.get("primitives") if mesh is not None else None
            if isinstance(primitives, list) and any(
                isinstance(primitive, Mapping) and primitive.get("material") in core_material_indexes
                for primitive in primitives
            ):
                core_bound = True
                break
    if not core_bound:
        errors.append({"code": "paperboard_core_binding_missing"})
    return {"ok": not errors, "errors": errors}


def compare_glb_dimensions(
    measured_xyz_metres: Sequence[float],
    dimensions_mm: Mapping[str, float],
    tolerance_mm: float,
) -> dict:
    if len(measured_xyz_metres) != 3:
        raise ValueError("GLB measured dimensions must be X/Y/Z")
    measured = {
        name: float(measured_xyz_metres[index]) * 1000.0
        for index, name in enumerate(AXIS_TO_DIMENSION)
    }
    expected = {name: float(dimensions_mm[name]) for name in AXIS_TO_DIMENSION}
    errors = {name: abs(measured[name] - expected[name]) for name in AXIS_TO_DIMENSION}
    return {
        "ok": max(errors.values()) <= float(tolerance_mm),
        "measured_mm": measured,
        "expected_mm": expected,
        "error_mm": errors,
        "tolerance_mm": float(tolerance_mm),
    }


def _asset_stem(value: object) -> str:
    return Path(str(value or "")).stem.lower().split(".", 1)[0]


def compare_glb_texture_bindings(
    bindings: Mapping[str, Sequence[Mapping[str, Any]]],
    expected_assets: Mapping[str, object],
) -> dict:
    """Verify each semantic object kept its own material and source image.

    Merely finding one image somewhere in the GLB is insufficient: assigning
    ``front`` to every panel would produce a technically textured but visually
    wrong box. Blender supplies a small, serializable binding inventory here so
    this contract remains unit-testable without importing ``bpy``.
    """
    missing: list[str] = []
    mismatched: list[dict[str, object]] = []
    for face in SEMANTIC_FACES:
        candidates = list(bindings.get(face) or [])
        if not candidates:
            missing.append(face)
            continue
        expected_material = f"mat_{face}"
        expected_image = _asset_stem(expected_assets.get(face))
        matched = False
        observed: list[dict[str, object]] = []
        for candidate in candidates:
            material = str(candidate.get("material") or "").lower().split(".", 1)[0]
            images = [_asset_stem(image) for image in candidate.get("images") or []]
            observed.append({"material": material, "images": images})
            if material == expected_material and expected_image and expected_image in images:
                matched = True
        if not matched:
            mismatched.append(
                {
                    "face": face,
                    "expected_material": expected_material,
                    "expected_image": expected_image,
                    "observed": observed,
                }
            )
    return {
        "ok": not missing and not mismatched,
        "missing_faces": missing,
        "mismatched_faces": mismatched,
    }
