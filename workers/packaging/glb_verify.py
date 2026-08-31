"""GLB geometry and semantic artwork verification shared by Blender and L0 tests."""

from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import struct
from typing import Any, Mapping, Sequence
import zlib


AXIS_TO_DIMENSION = ("width", "depth", "height")
SEMANTIC_FACES = ("front", "right", "back", "left", "top", "bottom")
GLB_MAGIC = b"glTF"
GLB_VERSION = 2
GLB_JSON_CHUNK = 0x4E4F534A
GLB_BIN_CHUNK = 0x004E4942
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class GlbArtifact:
    """The JSON and binary chunks from the exact exported GLB artifact."""

    __slots__ = ("document", "binary")

    def __init__(self, document: dict[str, Any], binary: bytes):
        self.document = document
        self.binary = binary


def load_glb_artifact(path: Path | str) -> GlbArtifact:
    """Read a GLB 2.0 file and retain bytes needed for artifact verification."""
    source = Path(path)
    data = source.read_bytes()
    if len(data) < 20:
        raise ValueError("GLB is too short")
    magic, version, declared_length = struct.unpack_from("<4sII", data, 0)
    if magic != GLB_MAGIC or version != GLB_VERSION or declared_length != len(data):
        raise ValueError("GLB header is invalid")
    offset = 12
    document: dict[str, Any] | None = None
    binary: bytes | None = None
    while offset + 8 <= len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk_end = offset + chunk_length
        if chunk_length % 4 != 0 or chunk_end > len(data):
            raise ValueError("GLB chunk exceeds declared length or is not aligned")
        payload = data[offset:chunk_end]
        if chunk_type == GLB_JSON_CHUNK:
            if document is not None:
                raise ValueError("GLB has multiple JSON chunks")
            parsed = json.loads(payload.rstrip(b"\x00 \t\r\n").decode("utf-8"))
            if not isinstance(parsed, dict):
                raise ValueError("GLB JSON root must be an object")
            document = parsed
        elif chunk_type == GLB_BIN_CHUNK:
            if binary is not None:
                raise ValueError("GLB has multiple BIN chunks")
            binary = payload
        offset = chunk_end
    if offset != len(data):
        raise ValueError("GLB ends with a partial chunk header")
    if document is None:
        raise ValueError("GLB JSON chunk is missing")
    if binary is None:
        raise ValueError("GLB BIN chunk is missing")
    return GlbArtifact(document=document, binary=binary)


def load_glb_json(path: Path | str) -> dict[str, Any]:
    """Compatibility reader for callers that only need the JSON document."""
    return load_glb_artifact(path).document


def _normalized_name(value: object) -> str:
    return str(value or "").strip().lower().split(".", 1)[0]


def _indexed(items: object, index: object) -> Mapping[str, Any] | None:
    if not isinstance(items, list) or isinstance(index, bool) or not isinstance(index, int):
        return None
    if index < 0 or index >= len(items) or not isinstance(items[index], Mapping):
        return None
    return items[index]


def _integer(value: object, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def _buffer_view_bytes(artifact: GlbArtifact, index: object) -> bytes:
    view = _indexed(artifact.document.get("bufferViews"), index)
    if view is None or view.get("buffer", 0) != 0:
        raise ValueError("bufferView must reference the embedded GLB buffer")
    start = _integer(view.get("byteOffset", 0), "bufferView.byteOffset")
    length = _integer(view.get("byteLength"), "bufferView.byteLength", minimum=1)
    end = start + length
    if end > len(artifact.binary):
        raise ValueError("bufferView exceeds the embedded GLB buffer")
    return artifact.binary[start:end]


def _base_color_image_index(document: Mapping[str, Any], material: Mapping[str, Any]) -> int | None:
    pbr = material.get("pbrMetallicRoughness")
    if not isinstance(pbr, Mapping):
        return None
    texture_info = pbr.get("baseColorTexture")
    if not isinstance(texture_info, Mapping):
        return None
    texture = _indexed(document.get("textures"), texture_info.get("index"))
    if texture is None:
        return None
    source = texture.get("source")
    if isinstance(source, bool) or not isinstance(source, int):
        return None
    return source


def _base_color_image_name(document: Mapping[str, Any], material: Mapping[str, Any]) -> str:
    image = _indexed(document.get("images"), _base_color_image_index(document, material))
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


def _paeth(left: int, up: int, upper_left: int) -> int:
    estimate = left + up - upper_left
    distances = (abs(estimate - left), abs(estimate - up), abs(estimate - upper_left))
    if distances[0] <= distances[1] and distances[0] <= distances[2]:
        return left
    if distances[1] <= distances[2]:
        return up
    return upper_left


def _decode_png_rgba(payload: bytes) -> dict[str, Any]:
    """Decode generated PNG pixels without relying on Pillow inside Blender."""
    if not payload.startswith(PNG_SIGNATURE):
        raise ValueError("image is not a PNG")
    offset = len(PNG_SIGNATURE)
    width = height = 0
    idat = bytearray()
    saw_ihdr = False
    saw_iend = False
    while offset + 12 <= len(payload):
        length = struct.unpack_from(">I", payload, offset)[0]
        chunk_type = payload[offset + 4 : offset + 8]
        chunk_start = offset + 8
        chunk_end = chunk_start + length
        crc_end = chunk_end + 4
        if crc_end > len(payload):
            raise ValueError("PNG chunk exceeds image bytes")
        chunk = payload[chunk_start:chunk_end]
        expected_crc = struct.unpack_from(">I", payload, chunk_end)[0]
        if zlib.crc32(chunk_type + chunk) & 0xFFFFFFFF != expected_crc:
            raise ValueError("PNG chunk checksum is invalid")
        if chunk_type == b"IHDR":
            if saw_ihdr or length != 13:
                raise ValueError("PNG IHDR is invalid")
            width, height, bit_depth, colour_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            if (
                width <= 0
                or height <= 0
                or bit_depth != 8
                or colour_type != 6
                or compression != 0
                or filtering != 0
                or interlace != 0
            ):
                raise ValueError("PNG must be a non-interlaced 8-bit RGBA image")
            saw_ihdr = True
        elif chunk_type == b"IDAT":
            if not saw_ihdr:
                raise ValueError("PNG IDAT appears before IHDR")
            idat.extend(chunk)
        elif chunk_type == b"IEND":
            saw_iend = True
            offset = crc_end
            break
        offset = crc_end
    if not saw_ihdr or not saw_iend or offset != len(payload) or not idat:
        raise ValueError("PNG is missing required chunks")
    stride = width * 4
    decompressed = zlib.decompress(bytes(idat))
    if len(decompressed) != (stride + 1) * height:
        raise ValueError("PNG scanlines do not match its dimensions")
    rows: list[bytes] = []
    previous = bytes(stride)
    cursor = 0
    for _row in range(height):
        filter_type = decompressed[cursor]
        cursor += 1
        encoded = decompressed[cursor : cursor + stride]
        cursor += stride
        decoded = bytearray(stride)
        for column, value in enumerate(encoded):
            left = decoded[column - 4] if column >= 4 else 0
            up = previous[column]
            upper_left = previous[column - 4] if column >= 4 else 0
            if filter_type == 0:
                predictor = 0
            elif filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = up
            elif filter_type == 3:
                predictor = (left + up) // 2
            elif filter_type == 4:
                predictor = _paeth(left, up, upper_left)
            else:
                raise ValueError("PNG uses an unsupported row filter")
            decoded[column] = (value + predictor) & 0xFF
        previous = bytes(decoded)
        rows.append(previous)
    pixels = b"".join(rows)
    alpha = pixels[3::4]
    return {
        "width": width,
        "height": height,
        "pixel_sha256": hashlib.sha256(pixels).hexdigest(),
        "alpha_sha256": hashlib.sha256(alpha).hexdigest(),
        "transparent_pixels": sum(value < 255 for value in alpha),
    }


def _embedded_png_contract(
    artifact: GlbArtifact,
    image_index: int | None,
    expected_path: object,
) -> dict[str, Any]:
    image = _indexed(artifact.document.get("images"), image_index)
    if image is None:
        return {"ok": False, "code": "embedded_image_missing"}
    if image.get("mimeType") != "image/png" or "bufferView" not in image:
        return {
            "ok": False,
            "code": "embedded_image_not_rgba_png",
            "mime_type": image.get("mimeType"),
        }
    try:
        embedded = _decode_png_rgba(_buffer_view_bytes(artifact, image.get("bufferView")))
        expected = _decode_png_rgba(Path(str(expected_path or "")).read_bytes())
    except (OSError, ValueError, zlib.error) as error:
        return {"ok": False, "code": "embedded_image_unreadable", "detail": str(error)}
    keys = ("width", "height", "pixel_sha256", "alpha_sha256")
    if any(embedded[key] != expected[key] for key in keys):
        return {
            "ok": False,
            "code": "embedded_image_pixels_mismatch",
            "expected_size": [expected["width"], expected["height"]],
            "observed_size": [embedded["width"], embedded["height"]],
            "expected_transparent_pixels": expected["transparent_pixels"],
            "observed_transparent_pixels": embedded["transparent_pixels"],
        }
    return {
        "ok": True,
        "size": [embedded["width"], embedded["height"]],
        "transparent_pixels": embedded["transparent_pixels"],
    }


def compare_glb_material_contract(
    artifact: GlbArtifact,
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
    if not isinstance(artifact, GlbArtifact):
        return {"ok": False, "errors": [{"code": "glb_binary_contract_missing"}]}
    document = artifact.document
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
        observed = []
        for material in candidates:
            observed.append(
                {
                    "alpha_mode": str(material.get("alphaMode") or "OPAQUE"),
                    "image": _base_color_image_name(document, material),
                    "image_contract": _embedded_png_contract(
                        artifact,
                        _base_color_image_index(document, material),
                        expected_assets.get(face),
                    ),
                }
            )
        if not any(
            item["alpha_mode"] == "MASK"
            and expected_image
            and item["image"] == expected_image
            and item["image_contract"]["ok"]
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


def _point_bounds(points: Sequence[Sequence[float]]) -> tuple[tuple[float, float], ...]:
    if not points:
        raise ValueError("geometry has no points")
    return tuple(
        (min(float(point[axis]) for point in points), max(float(point[axis]) for point in points))
        for axis in range(3)
    )


def _unit(value: float, bounds: tuple[float, float]) -> float:
    span = bounds[1] - bounds[0]
    if span <= 1e-9:
        raise ValueError("artwork axis is collapsed")
    return (value - bounds[0]) / span


def _expected_surface_uv(
    face: str,
    point: Sequence[float],
    bounds: tuple[tuple[float, float], ...],
) -> tuple[float, float]:
    x = _unit(float(point[0]), bounds[0]) if face in {"front", "back", "top", "bottom"} else 0.0
    y = _unit(float(point[1]), bounds[1]) if face in {"right", "left", "top", "bottom"} else 0.0
    z = _unit(float(point[2]), bounds[2]) if face in {"front", "right", "back", "left"} else 0.0
    if face == "front":
        return (x, z)
    if face == "back":
        return (1.0 - x, z)
    if face == "right":
        return (y, z)
    if face == "left":
        return (1.0 - y, z)
    if face == "top":
        return (x, y)
    if face == "bottom":
        return (x, 1.0 - y)
    raise ValueError(f"unknown semantic face: {face}")


def compare_glb_surface_contract(
    surfaces: Mapping[str, Sequence[Mapping[str, Sequence[float]]]],
    dimensions_mm: Mapping[str, float],
    tolerance_mm: float,
    *,
    uv_tolerance: float = 1e-4,
) -> dict[str, Any]:
    """Verify UV direction and mirror state after importing the exported GLB."""
    expected = {
        "front": (float(dimensions_mm["width"]), float(dimensions_mm["height"])),
        "back": (float(dimensions_mm["width"]), float(dimensions_mm["height"])),
        "right": (float(dimensions_mm["depth"]), float(dimensions_mm["height"])),
        "left": (float(dimensions_mm["depth"]), float(dimensions_mm["height"])),
        "top": (float(dimensions_mm["width"]), float(dimensions_mm["depth"])),
        "bottom": (float(dimensions_mm["width"]), float(dimensions_mm["depth"])),
    }
    variable_axes = {
        "front": (0, 2),
        "back": (0, 2),
        "right": (1, 2),
        "left": (1, 2),
        "top": (0, 1),
        "bottom": (0, 1),
    }
    constant_axis = {"front": 1, "back": 1, "right": 0, "left": 0, "top": 2, "bottom": 2}
    errors: list[dict[str, Any]] = []
    for face in SEMANTIC_FACES:
        try:
            samples = list(surfaces.get(face) or [])
            if len(samples) < 4:
                raise ValueError("semantic face has too few UV samples")
            points: list[tuple[float, float, float]] = []
            uvs: list[tuple[float, float]] = []
            for sample in samples:
                position = sample.get("position")
                uv = sample.get("uv")
                if (
                    not isinstance(position, Sequence)
                    or isinstance(position, (str, bytes))
                    or len(position) != 3
                    or not isinstance(uv, Sequence)
                    or isinstance(uv, (str, bytes))
                    or len(uv) != 2
                    or any(not isinstance(value, (int, float)) for value in [*position, *uv])
                ):
                    raise ValueError("semantic face contains an invalid UV sample")
                points.append(tuple(float(value) for value in position))
                uvs.append(tuple(float(value) for value in uv))
            bounds = _point_bounds(points)
            axis_a, axis_b = variable_axes[face]
            observed_mm = (
                (bounds[axis_a][1] - bounds[axis_a][0]) * 1000.0,
                (bounds[axis_b][1] - bounds[axis_b][0]) * 1000.0,
            )
            if any(abs(actual - wanted) > float(tolerance_mm) for actual, wanted in zip(observed_mm, expected[face])):
                raise ValueError("semantic face does not span the expected panel dimensions")
            if (bounds[constant_axis[face]][1] - bounds[constant_axis[face]][0]) * 1000.0 > float(tolerance_mm):
                raise ValueError("semantic face is not planar")
            corners: set[tuple[int, int]] = set()
            for point, uv in zip(points, uvs):
                expected_uv = _expected_surface_uv(face, point, bounds)
                if abs(uv[0] - expected_uv[0]) > uv_tolerance or abs(uv[1] - expected_uv[1]) > uv_tolerance:
                    raise ValueError("semantic face UV is rotated or mirrored")
                corners.add((round(uv[0]), round(uv[1])))
            if corners != {(0, 0), (1, 0), (1, 1), (0, 1)}:
                raise ValueError("semantic face UV does not cover all artwork corners")
        except ValueError as error:
            errors.append({"code": "semantic_face_uv_invalid", "face": face, "detail": str(error)})
    return {"ok": not errors, "errors": errors}


def _triangle_area(triangle: Sequence[Sequence[float]]) -> float:
    if len(triangle) != 3:
        return 0.0
    a, b, c = triangle
    ab = [float(b[axis]) - float(a[axis]) for axis in range(3)]
    ac = [float(c[axis]) - float(a[axis]) for axis in range(3)]
    cross = (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )
    return math.sqrt(sum(value * value for value in cross)) / 2.0


def _triangle_signed_volume(triangle: Sequence[Sequence[float]]) -> float:
    a, b, c = triangle
    cross = (
        float(b[1]) * float(c[2]) - float(b[2]) * float(c[1]),
        float(b[2]) * float(c[0]) - float(b[0]) * float(c[2]),
        float(b[0]) * float(c[1]) - float(b[1]) * float(c[0]),
    )
    return sum(float(a[axis]) * cross[axis] for axis in range(3)) / 6.0


def _closed_connected_mesh(
    triangles: Sequence[Sequence[Sequence[float]]],
    merge_tolerance: float,
) -> bool:
    def vertex_key(point: Sequence[float]) -> tuple[int, int, int]:
        return tuple(round(float(value) / merge_tolerance) for value in point)  # type: ignore[return-value]

    edge_counts: Counter[tuple[tuple[int, int, int], tuple[int, int, int]]] = Counter()
    edge_triangles: defaultdict[
        tuple[tuple[int, int, int], tuple[int, int, int]],
        list[int],
    ] = defaultdict(list)
    for triangle_index, triangle in enumerate(triangles):
        keys = [vertex_key(point) for point in triangle]
        if len(set(keys)) != 3:
            return False
        for start, end in ((keys[0], keys[1]), (keys[1], keys[2]), (keys[2], keys[0])):
            edge = tuple(sorted((start, end)))
            edge_counts[edge] += 1
            edge_triangles[edge].append(triangle_index)
    if not edge_counts or any(count != 2 for count in edge_counts.values()):
        return False
    neighbours: defaultdict[int, set[int]] = defaultdict(set)
    for owners in edge_triangles.values():
        left, right = owners
        neighbours[left].add(right)
        neighbours[right].add(left)
    visited = {0}
    pending = [0]
    while pending:
        current = pending.pop()
        for neighbour in neighbours[current]:
            if neighbour not in visited:
                visited.add(neighbour)
                pending.append(neighbour)
    return len(visited) == len(triangles)


def compare_glb_core_contract(
    core_objects: Sequence[Mapping[str, Any]],
    dimensions_mm: Mapping[str, float],
    tolerance_mm: float,
) -> dict[str, Any]:
    """Verify one opaque core spans and physically backs every box boundary."""
    errors: list[dict[str, Any]] = []
    if len(core_objects) != 1:
        return {
            "ok": False,
            "errors": [{"code": "paperboard_core_geometry_invalid", "detail": "exactly one core is required"}],
        }
    core = core_objects[0]
    materials = [_normalized_name(value) for value in core.get("materials") or []]
    if not materials or any(value != "mat_paperboardedge" for value in materials):
        errors.append({"code": "paperboard_core_material_binding_invalid"})
    try:
        points = [tuple(float(value) for value in point) for point in core.get("points") or []]
        triangles = [
            [tuple(float(value) for value in point) for point in triangle]
            for triangle in core.get("triangles") or []
        ]
        if any(len(point) != 3 for point in points) or any(len(triangle) != 3 for triangle in triangles):
            raise ValueError("core geometry is malformed")
        if len(points) < 8 or len(triangles) < 12:
            raise ValueError("core geometry is incomplete")
        bounds = _point_bounds(points)
        observed_mm = tuple((axis[1] - axis[0]) * 1000.0 for axis in bounds)
        expected_mm = (
            float(dimensions_mm["width"]),
            float(dimensions_mm["depth"]),
            float(dimensions_mm["height"]),
        )
        if any(abs(actual - wanted) > float(tolerance_mm) for actual, wanted in zip(observed_mm, expected_mm)):
            raise ValueError("core does not span the expected box dimensions")
        merge_tolerance = max(float(tolerance_mm) / 10000.0, 1e-8)
        if not _closed_connected_mesh(triangles, merge_tolerance):
            raise ValueError("core is not one closed connected manifold")
        expected_width, expected_depth, expected_height = (value / 1000.0 for value in expected_mm)
        expected_surface_area = 2.0 * (
            expected_width * expected_depth
            + expected_width * expected_height
            + expected_depth * expected_height
        )
        observed_surface_area = sum(_triangle_area(triangle) for triangle in triangles)
        observed_volume = abs(sum(_triangle_signed_volume(triangle) for triangle in triangles))
        expected_volume = expected_width * expected_depth * expected_height
        if not 0.85 <= observed_surface_area / expected_surface_area <= 1.10:
            raise ValueError("core surface area does not cover the complete box")
        if not 0.85 <= observed_volume / expected_volume <= 1.01:
            raise ValueError("core volume does not fill the complete box")
        plane_tolerance = max(float(tolerance_mm) / 1000.0, 1e-7)
        area_floor = max(min(value / 1000.0 for value in expected_mm) ** 2 * 1e-8, 1e-14)
        for axis in range(3):
            for extreme in bounds[axis]:
                if not any(
                    all(abs(float(point[axis]) - extreme) <= plane_tolerance for point in triangle)
                    and _triangle_area(triangle) > area_floor
                    for triangle in triangles
                ):
                    raise ValueError("core does not cover all six boundary planes")
    except (TypeError, ValueError) as error:
        errors.append({"code": "paperboard_core_geometry_invalid", "detail": str(error)})
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
