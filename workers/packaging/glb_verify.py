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
# Existing renderer's fixed paper-white multiplier, shared without changing F.
# Read-face PNGs are not graded. A future profile must explicitly own this value.
PAPER_ALBEDO_LINEAR = 0.70


class GlbArtifact:
    """The JSON and binary chunks from the exact exported GLB artifact."""

    __slots__ = ("document", "binary")

    def __init__(self, document: dict[str, Any], binary: bytes):
        self.document = document
        self.binary = binary


def load_glb_artifact(path: Path | str, *, max_bytes: int = 512 * 1024 * 1024) -> GlbArtifact:
    """Read a GLB 2.0 file and retain bytes needed for artifact verification."""
    source = Path(path)
    if source.stat().st_size > max_bytes:
        raise ValueError("GLB exceeds byte budget")
    with source.open("rb") as handle:
        data = handle.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError("GLB exceeds byte budget")
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


def _runtime_row(rows: object, index: object) -> Mapping[str, Any]:
    row = _indexed(rows, index)
    if row is None:
        raise ValueError("invalid artifact index")
    return row


def _finite_vector(raw: object, length: int) -> list[float]:
    if (not isinstance(raw, list) or len(raw) != length
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in raw)):
        raise ValueError("invalid finite vector")
    return [float(v) for v in raw]


def _node_matrix(node: Mapping[str, Any]) -> list[float]:
    # glTF column-major T*R*S; same world transform used by the importer.
    if "matrix" in node:
        if any(k in node for k in ("translation", "rotation", "scale")):
            raise ValueError("matrix and TRS cannot coexist")
        matrix = _finite_vector(node["matrix"], 16)
        if [matrix[i] for i in (3, 7, 11, 15)] != [0, 0, 0, 1]:
            raise ValueError("non-affine matrix")
        return matrix
    t = _finite_vector(node.get("translation", [0, 0, 0]), 3)
    s = _finite_vector(node.get("scale", [1, 1, 1]), 3)
    x, y, z, w = _finite_vector(node.get("rotation", [0, 0, 0, 1]), 4)
    if abs(x*x+y*y+z*z+w*w-1) > 1e-5:
        raise ValueError("rotation is not a unit quaternion")
    return [
        (1-2*(y*y+z*z))*s[0], 2*(x*y+z*w)*s[0], 2*(x*z-y*w)*s[0], 0,
        2*(x*y-z*w)*s[1], (1-2*(x*x+z*z))*s[1], 2*(y*z+x*w)*s[1], 0,
        2*(x*z+y*w)*s[2], 2*(y*z-x*w)*s[2], (1-2*(x*x+y*y))*s[2], 0,
        *t, 1,
    ]


def _matrix_product(a: Sequence[float], b: Sequence[float]) -> list[float]:
    return [sum(a[k*4+r]*b[c*4+k] for k in range(4)) for c in range(4) for r in range(4)]


def _artifact_accessor(artifact: GlbArtifact, index: object, kind: str) -> list[tuple]:
    row = _runtime_row(artifact.document.get("accessors"), index)
    if row.get("type") != kind or row.get("sparse") is not None or row.get("normalized", False) is not False:
        raise ValueError("unsupported accessor representation")
    component = row.get("componentType")
    formats = {5121: "B", 5123: "H", 5125: "I"} if kind == "SCALAR" else {5126: "f"}
    if component not in formats:
        raise ValueError("unsupported accessor component")
    count = _integer(row.get("count"), "accessor.count", minimum=1)
    if count > 8192:
        raise ValueError("accessor budget exceeded")
    size = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[kind]
    fmt = "<" + formats[component] * size
    packed = struct.calcsize(fmt)
    view = _runtime_row(artifact.document.get("bufferViews"), row.get("bufferView"))
    offset = _integer(row.get("byteOffset", 0), "accessor.byteOffset")
    stride = _integer(view.get("byteStride", packed), "bufferView.byteStride", minimum=1)
    if stride < packed or stride > 252 or stride % (packed // size) or offset % (packed // size):
        raise ValueError("invalid accessor alignment")
    data = _buffer_view_bytes(artifact, row.get("bufferView"))
    if offset + (count-1)*stride + packed > len(data):
        raise ValueError("accessor exceeds bufferView")
    values = [struct.unpack_from(fmt, data, offset+i*stride) for i in range(count)]
    if any(not math.isfinite(v) for value in values for v in value):
        raise ValueError("nonfinite accessor")
    return values


def _artifact_mesh(artifact: GlbArtifact, node: Mapping[str, Any], world: Sequence[float], *, shell: bool = False) -> dict[str, Any]:
    doc = artifact.document
    mesh = _runtime_row(doc.get("meshes"), node.get("mesh"))
    primitives = mesh.get("primitives")
    # Current six flat artwork panels + one core; RF-05 families must explicitly
    # extend this contract instead of silently accepting unfamiliar geometry.
    if not isinstance(primitives, list) or len(primitives) != 1 or mesh.get("weights"):
        raise ValueError("unsupported mesh primitives")
    primitive = primitives[0]
    if not isinstance(primitive, dict) or primitive.get("mode", 4) != 4 or primitive.get("targets") or primitive.get("extensions"):
        raise ValueError("unsupported primitive")
    attributes = primitive.get("attributes")
    if not isinstance(attributes, dict):
        raise ValueError("missing attributes")
    positions = _artifact_accessor(artifact, attributes.get("POSITION"), "VEC3")
    points = []
    for position in positions:
        p = [sum(world[c*4+r]*position[c] for c in range(3))+world[12+r] for r in range(3)]
        # glTF Y-up metres -> existing verifier's Blender Z-up metres.
        points.append([p[0], -p[2], p[1]])
    if any(not math.isfinite(v) for point in points for v in point):
        raise ValueError("nonfinite world coordinate")
    indexes = ([v[0] for v in _artifact_accessor(artifact, primitive["indices"], "SCALAR")]
               if "indices" in primitive else list(range(len(points))))
    if len(indexes) % 3 or any(i >= len(points) for i in indexes):
        raise ValueError("invalid triangle indexes")
    material = _runtime_row(doc.get("materials"), primitive.get("material"))
    name = _normalized_name(node.get("name")).removesuffix("_mesh")
    result = {"name": name, "materials": [material.get("name")], "points": points,
              "triangles": [[points[i] for i in indexes[n:n+3]] for n in range(0, len(indexes), 3)]}
    if name in SEMANTIC_FACES:
        if _normalized_name(material.get("name")) != f"mat_{name}":
            raise ValueError("wrong semantic material binding")
        texture = material.get("pbrMetallicRoughness", {}).get("baseColorTexture", {})
        factor = _finite_vector(_base_color_factor(material), 4)
        expected_factor = [PAPER_ALBEDO_LINEAR]*3 + [1.0]
        if any(abs(a-b) > 1e-4 for a,b in zip(factor, expected_factor)):
            raise ValueError("artwork base colour factor changes pixels")
        if texture.get("texCoord", 0) != 0 or texture.get("extensions"):
            raise ValueError("unsupported texture coordinates or transform")
        uvs = _artifact_accessor(artifact, attributes.get("TEXCOORD_0"), "VEC2")
        if len(uvs) != len(points):
            raise ValueError("UV and position counts differ")
        result["samples"] = [{"position": points[i], "uv": [uvs[i][0], 1-uvs[i][1]]} for i in indexes]
        # Flat panel must actually cover its rectangle, not just contain four
        # convenient UV corners among degenerate/unreferenced vertices.
        uv_triangles = [[uvs[i] for i in indexes[n:n+3]] for n in range(0, len(indexes), 3)]
        signed = [((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2 for a,b,c in uv_triangles]
        if not shell and (len(signed) != 2 or abs(abs(sum(signed))-1) > 1e-4 or any(abs(v) < 0.49 for v in signed)):
            raise ValueError("incomplete artwork triangles")
        edges = Counter(tuple(sorted((tuple(a), tuple(b)))) for tri in uv_triangles for a,b in zip(tri, tri[1:]+tri[:1]))
        shared = [edge for edge, count in edges.items() if count == 2]
        if not shell and (len(shared) != 1 or any(abs(shared[0][0][i]-shared[0][1][i]) < 0.99 for i in (0,1))):
            raise ValueError("artwork triangles do not share a diagonal")
    elif not name.endswith("_box_core"):
        raise ValueError("unexpected visible mesh")
    elif "baseColorTexture" in material.get("pbrMetallicRoughness", {}):
        raise ValueError("core substrate must not carry an artwork texture")
    return result


def compare_glb_artifact_contract(
    artifact: GlbArtifact, expected_assets: Mapping[str, object],
    dimensions_mm: Mapping[str, float], tolerance_mm: float, substrate_rgba: Sequence[float],
    *, geometry: Mapping[str, Any] | None = None,
    render_identity: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Verify the static exported box directly, without bpy or worker measurements.

    Intentionally supports the current uncompressed, non-skinned Blender output
    subset. Unsupported geometry fails closed, never passes as an empty scene.
    """
    try:
        shell = bool(geometry and geometry.get("closure_detail") == "closed-carton-shell-v1")
        if geometry and (geometry.get("family") not in {"rectangular_carton_v1", "pouch_thin_card_v1"}
                         or (shell and geometry.get("family") != "rectangular_carton_v1")):
            raise ValueError("unsupported artifact geometry family")
        if shell and (not render_identity or not render_identity.get("render_profile_id") or not render_identity.get("render_contract_hash")):
            raise ValueError("shell verification requires trusted render identity")
        dims = _finite_vector([dimensions_mm[k] for k in AXIS_TO_DIMENSION], 3)
        if min(dims) <= 0 or not math.isfinite(tolerance_mm) or not 0 < tolerance_mm < min(dims):
            raise ValueError("invalid dimension tolerance")
        doc = artifact.document
        if doc.get("asset", {}).get("version") != "2.0" or doc.get("animations") or doc.get("skins") or doc.get("extensionsRequired"):
            raise ValueError("unsupported dynamic or required-extension artifact")
        buffers = doc.get("buffers")
        if (not isinstance(buffers, list) or len(buffers) != 1 or "uri" in buffers[0]
                or _integer(buffers[0].get("byteLength"), "buffer.byteLength") > len(artifact.binary)):
            raise ValueError("expected embedded buffer")
        views = doc.get("bufferViews")
        if not isinstance(views, list) or len(views) > 256:
            raise ValueError("bufferView budget exceeded")
        for view in views:
            if (view.get("buffer", 0) != 0 or "extensions" in view
                    or _integer(view.get("byteOffset", 0), "bufferView.byteOffset")
                    + _integer(view.get("byteLength"), "bufferView.byteLength", minimum=1) > buffers[0]["byteLength"]):
                raise ValueError("bufferView exceeds declared embedded buffer")
        materials = doc.get("materials")
        expected_names = {f"mat_{face}" for face in SEMANTIC_FACES} | {"mat_paperboardedge"}
        if (not isinstance(materials, list) or len(materials) != 7
                or {_normalized_name(m.get("name")) for m in materials} != expected_names):
            raise ValueError("exactly one material per semantic face and core required")
        nodes = doc.get("nodes")
        if not isinstance(nodes, list) or not 1 <= len(nodes) <= 64:
            raise ValueError("scene node budget")
        scene = _runtime_row(doc.get("scenes"), doc.get("scene", 0))
        roots = scene.get("nodes")
        if not isinstance(roots, list) or not roots:
            raise ValueError("empty scene")
        identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
        pending = [(i, identity) for i in roots]
        seen = set()
        meshes = []
        while pending:
            index, parent = pending.pop()
            node = _runtime_row(nodes, index)
            if index in seen or any(k in node for k in ("skin", "weights", "extensions")):
                raise ValueError("shared/cyclic or unsupported node")
            seen.add(index)
            world = _matrix_product(parent, _node_matrix(node))
            if "mesh" in node:
                if shell:
                    expected_metadata = {"render_family": geometry["family"], "geometry_model": geometry["closure_detail"],
                                         "render_profile_id": render_identity["render_profile_id"], "render_contract_hash": render_identity["render_contract_hash"]}
                    extras = node.get("extras", {})
                    if any(extras.get(key) != value for key,value in expected_metadata.items()):
                        raise ValueError("shell metadata does not match trusted render identity")
                meshes.append(_artifact_mesh(artifact, node, world, shell=shell))
                if len(meshes) > 7:
                    raise ValueError("mesh budget exceeded")
            children = node.get("children", [])
            if not isinstance(children, list) or len(children) > 64:
                raise ValueError("children budget exceeded")
            pending.extend((i, world) for i in children)
        surfaces = {}
        cores = []
        for mesh in meshes:
            name = mesh["name"]
            if name in SEMANTIC_FACES:
                if name in surfaces:
                    raise ValueError("duplicate semantic face")
                surfaces[name] = mesh["samples"]
            else:
                cores.append(mesh)
        if set(surfaces) != set(SEMANTIC_FACES) or len(cores) != 1:
            raise ValueError("six semantic panels and one core required")
        bounds = _point_bounds(cores[0]["points"])
        planes = {"front": (1,0), "back": (1,1), "right": (0,1), "left": (0,0), "top": (2,1), "bottom": (2,0)}
        for face, samples in surfaces.items():
            axis, side = planes[face]
            if not shell and any(abs(s["position"][axis]-bounds[axis][side])*1000 > tolerance_mm for s in samples):
                raise ValueError("artwork detached from core boundary")
        points = [p for mesh in meshes for p in mesh["points"]]
        spans = [max(p[i] for p in points)-min(p[i] for p in points) for i in range(3)]
        reports = {
            "dimensions": compare_glb_dimensions(spans, dimensions_mm, tolerance_mm),
            "surface": compare_glb_surface_contract(surfaces, dimensions_mm, tolerance_mm, geometry=geometry),
            "core": compare_glb_core_contract(cores, dimensions_mm, tolerance_mm, geometry=geometry),
            "material": compare_glb_material_contract(artifact, expected_assets, substrate_rgba),
        }
        return {"ok": all(r["ok"] for r in reports.values()), **reports}
    except (ValueError, TypeError, KeyError, AttributeError, IndexError, OverflowError, struct.error) as error:
        return {"ok": False, "errors": [{"code": "glb_artifact_contract_invalid", "detail": str(error)[:160]}]}


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


def _decode_png_rgba(payload: bytes, *, max_pixels: int = 32_000_000) -> dict[str, Any]:
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
            if width * height > max_pixels:
                raise ValueError("PNG exceeds pixel budget")
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
    expected_bytes = (stride + 1) * height
    inflater = zlib.decompressobj()
    # One sentinel detects overflow without materializing the rest of a bomb.
    # flush(length) is NOT a limit, so never use it to finish this bounded read.
    decompressed = inflater.decompress(bytes(idat), expected_bytes + 1)
    if (len(decompressed) != expected_bytes or not inflater.eof
            or inflater.unconsumed_tail or inflater.unused_data):
        raise ValueError("PNG scanlines do not match its dimensions")
    rows: list[bytes] = []
    zero_row = bytes(stride)
    previous = zero_row
    cursor = 0
    for _row in range(height):
        filter_type = decompressed[cursor]
        cursor += 1
        encoded = decompressed[cursor : cursor + stride]
        cursor += stride
        # Exact PNG filter identities, independent of artwork colour or family.
        # bytes comparison/copy runs in C instead of revisiting every channel in Python.
        if filter_type == 0:
            previous = encoded
            rows.append(previous)
            continue
        if filter_type == 2 and encoded == zero_row:
            rows.append(previous)
            continue
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
        "transparent_pixels": len(alpha) - alpha.count(255),
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
    geometry: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Verify UV direction and mirror state after importing the exported GLB."""
    if geometry and geometry.get("closure_detail") == "closed-carton-shell-v1":
        from render_geometry import compare_shell_surfaces
        return compare_shell_surfaces(surfaces, dimensions_mm, geometry)
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
    *, geometry: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Verify one opaque core spans and physically backs every box boundary."""
    if geometry and geometry.get("closure_detail") == "closed-carton-shell-v1":
        from render_geometry import compare_shell_core
        return compare_shell_core(core_objects, dimensions_mm, geometry)
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
