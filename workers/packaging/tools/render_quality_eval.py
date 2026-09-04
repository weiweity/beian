#!/usr/bin/env python3
"""RF-00 current-render measurement for packaging stills.

This tool observes the existing workers/packaging pipeline. It does not change
lights, materials, colour management, samples, resolution, compression, output
keys, or GLB contracts.

Entry-point comparison:
- A (chosen): this CLI, same shape as audit_corpus.py. Isolated output dir,
  importlib-loads pipeline.py, never touches Hono. CLI cannot read arbitrary
  manifests; tests inject fixtures through run_eval(fixtures=...).
- B (rejected): pipeline.py --render-quality. That would widen the product CLI.

Fixture comparison:
- A (chosen): Python-generated synthetic PDF + explicit structure sidecar.
- B (rejected): commit pre-rendered PNG/GLB.

Unsupported-family comparison:
- A (chosen): evaluator reads declared packaging_family. Non-rectangular_carton_v1
  is unsupported and is not sent to add_box.
- B (rejected): change render_job.py dispatch (RF-05).

Approved-baseline comparison:
- A (chosen): write only when report.ok, every supported fixture rendered, and
  required metrics are measured. Atomic replace. Identity mismatch refuses.
- B (rejected): write whenever --update-baseline is set.

Metrics never use numeric 0 as a stand-in for a missing measurement.
Contour metrics never fall back to the whole-product mean.
Type fidelity is a known face-mm ROI on read_* panels; oblique stills are
unavailable rather than a fake full-frame FIND_EDGES score.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any
import uuid

import pymupdf
from PIL import Image, ImageDraw, ImageFilter, ImageStat
import PIL


PACKAGING_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGING_ROOT.parents[1]
PIPELINE_PATH = PACKAGING_ROOT / "pipeline.py"
RENDER_CONTRACT_PATH = PACKAGING_ROOT / "render_contract.py"
RENDER_JOB_PATH = PACKAGING_ROOT / "blender" / "render_job.py"
GLB_VERIFY_PATH = PACKAGING_ROOT / "glb_verify.py"
CAMERA_FRAME_PATH = PACKAGING_ROOT / "camera_frame.py"
DIELINE_PATH = PACKAGING_ROOT / "dieline.py"
WHITE_BACKGROUND_PATH = PACKAGING_ROOT / "white_background.py"
STRUCTURE_V2_PATHS = tuple(sorted((PACKAGING_ROOT / "structure_v2").glob("*.py")))
ARTWORK_PATH = PACKAGING_ROOT / "structure_v2" / "artwork.py"
CURRENT_TEMPLATE_PATH = PACKAGING_ROOT / "templates" / "flower_box_47_5x47_5x177_5.json"
SYNTHETIC_FIXTURE_ROOT = PACKAGING_ROOT / "fixtures" / "render-quality"
DEFAULT_MANIFEST_PATH = SYNTHETIC_FIXTURE_ROOT / "manifest.json"
APPROVED_BASELINE_ROOT = SYNTHETIC_FIXTURE_ROOT / "baselines"
DEFAULT_APPROVED_BASELINE = APPROVED_BASELINE_ROOT / "rf00-current.json"
BASELINE_LOCK_ROOT = Path.home() / ".cache" / "beian" / "rf00-baseline-locks"
IDENTITY_HASH_KEYS = (
    "input_sha256",
    "evaluator_sha256",
    "render_job_sha256",
    "pipeline_sha256",
    "camera_frame_sha256",
    "template_sha256",
    "render_profile_sha256",
    "manifest_sha256",
)
DEPENDENCY_VERSION_KEYS = ("python", "pillow", "pymupdf", "blender")
MANIFEST_SCHEMA = "beian-render-quality-fixtures/1"
REPORT_SCHEMA = "beian-render-quality-report/1"
BASELINE_SCHEMA = "beian-render-quality-baseline/1"
RECTANGULAR_CARTON_FAMILY = "rectangular_carton_v1"
EXPECTED_FIXTURE_CONTRACT = {
    "rf00-white-carton": (RECTANGULAR_CARTON_FAMILY, "white_separation"),
    "rf00-dark-carton": (RECTANGULAR_CARTON_FAMILY, "dark_levels"),
    "rf00-tall-carton": (RECTANGULAR_CARTON_FAMILY, "tall_box"),
    "rf00-wide-carton": (RECTANGULAR_CARTON_FAMILY, "wide_box"),
    "rf00-type-frequency": (RECTANGULAR_CARTON_FAMILY, "type_frequency"),
    "rf00-alpha-edge": (RECTANGULAR_CARTON_FAMILY, "alpha_edge"),
    "rf00-cylinder-unsupported": ("cylinder_v1", "negative_family"),
}
SUPPORTED_PATTERNS = {"solid", "type_frequency", "alpha_edge"}
FACE_ROLES = ("back", "left", "front", "right")
ALL_FACES = ("front", "right", "back", "left", "top", "bottom")
BLENDER_REQUIRED_OUTPUT_KEYS = ("blend", "glb", "front_right", "back_left")
BLENDER_OPTIONAL_OUTPUT_KEYS = (
    "front_right_ground",
    "back_left_ground",
    "front_right_set",
    "back_left_set",
)
BLENDER_OUTPUT_KEYS = BLENDER_REQUIRED_OUTPUT_KEYS + BLENDER_OPTIONAL_OUTPUT_KEYS
OUTPUT_CARD_SOURCES = {
    "front_right_card": "front_right",
    "back_left_card": "back_left",
    "front_right_ground_card": "front_right_ground",
    "back_left_ground_card": "back_left_ground",
    "front_right_set_card": "front_right_set",
    "back_left_set_card": "back_left_set",
}
MM_TO_PT = 72.0 / 25.4
_ARTWORK_SPEC = importlib.util.spec_from_file_location("packaging_artwork_rf00_contract", ARTWORK_PATH)
if _ARTWORK_SPEC is None or _ARTWORK_SPEC.loader is None:
    raise RuntimeError(f"unable to load artwork contract: {ARTWORK_PATH}")
_ARTWORK_MODULE = importlib.util.module_from_spec(_ARTWORK_SPEC)
_ARTWORK_SPEC.loader.exec_module(_ARTWORK_MODULE)
MIN_FACE_PIXELS_PER_MM = float(_ARTWORK_MODULE.MIN_FACE_TEXTURE_PIXELS_PER_MM)
MAX_RASTER_PIXELS = int(_ARTWORK_MODULE.MAX_ARTWORK_RASTER_PIXELS)
SILVER_BG = (228, 228, 232)
WHITE_BG = (255, 255, 255)
INTERIOR_ALPHA = 250
FIXTURE_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
DATA_DIR_ENV = "WB_" + "DATA_DIR"


class EvalError(RuntimeError):
    pass


def _load_pipeline() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_pipeline_rf00", PIPELINE_PATH)
    if spec is None or spec.loader is None:
        raise EvalError(f"unable to load pipeline: {PIPELINE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_render_contract() -> Any:
    spec = importlib.util.spec_from_file_location(
        "packaging_render_contract_rf00", RENDER_CONTRACT_PATH
    )
    if spec is None or spec.loader is None:
        raise EvalError(f"unable to load render contract: {RENDER_CONTRACT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def source_bundle_sha256(paths: Sequence[Path]) -> str:
    entries = []
    for path in sorted({Path(item).resolve() for item in paths}, key=lambda item: str(item)):
        try:
            label = str(path.relative_to(PACKAGING_ROOT))
        except ValueError:
            label = path.name
        entries.append({"path": label, "sha256": sha256_file(path)})
    return sha256_text(canonical_dumps(entries))


def measured(value: Any, unit: str | None, method: str) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": "measured", "value": value, "method": method}
    if unit is not None:
        payload["unit"] = unit
    return payload


def unavailable(reason: str, *, unit: str | None = None, method: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": "unavailable", "reason": reason}
    if unit is not None:
        payload["unit"] = unit
    if method is not None:
        payload["method"] = method
    return payload


def metric_measured(payload: Any) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("status") == "measured"
        and "value" in payload
        and _nonempty_text(payload.get("method"))
    )


def metric_measured_leaf(payload: Any) -> bool:
    if not metric_measured(payload):
        return False
    value = payload["value"]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and not math.isfinite(value):
        return False
    return True


def metric_value_valid(payload: Any, kind: str) -> bool:
    if not metric_measured(payload):
        return False
    value = payload["value"]
    if kind == "pixel_size":
        return (
            isinstance(value, list)
            and len(value) == 2
            and all(isinstance(item, int) and not isinstance(item, bool) and item > 0 for item in value)
        )
    if kind == "byte_size":
        return isinstance(value, int) and not isinstance(value, bool) and value > 0
    if kind == "sha256":
        return isinstance(value, str) and bool(SHA256_RE.fullmatch(value))
    if kind == "white_separation":
        if not isinstance(value, dict):
            return False
        numeric = ("edge_mean_luma", "delta_vs_white", "delta_vs_silver")
        if not all(_finite_number(value.get(key)) and 0 <= float(value[key]) <= 255 for key in numeric):
            return False
        count = value.get("edge_pixel_count")
        return isinstance(count, int) and not isinstance(count, bool) and count > 0
    if kind == "alpha_border":
        if not isinstance(value, dict):
            return False
        counts = []
        for key in ("contour_count", "interior_edge_count", "fringe_count", "transparent_touch_count"):
            count = value.get(key)
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                return False
            counts.append(count)
        contour, interior, fringe, transparent = counts
        return contour > 0 and interior > 0 and contour == interior + fringe + transparent
    if kind == "finite_scalar":
        return metric_measured_leaf(payload)
    raise EvalError(f"unknown metric validator: {kind}")


def resolve_target(path: Path | str) -> Path:
    return Path(path).expanduser().resolve(strict=False)


def _has_marker(path: Path, marker: tuple[str, ...]) -> bool:
    parts = path.parts
    length = len(marker)
    for index in range(len(parts) - length + 1):
        if parts[index : index + length] == marker:
            return True
    return False


def _configured_data_dir() -> Path | None:
    raw = (os.environ.get(DATA_DIR_ENV) or "").strip()
    if not raw:
        return None
    return resolve_target(raw)


def _is_within(path: Path, root: Path) -> bool:
    resolved = resolve_target(path)
    base = resolve_target(root)
    if resolved == base or base in resolved.parents:
        return True
    if resolved.exists() and base.exists():
        try:
            current = resolved
            while True:
                if os.path.samefile(current, base):
                    return True
                parent = current.parent
                if parent == current:
                    break
                current = parent
        except OSError:
            pass
    resolved_parts = tuple(part.casefold() for part in resolved.parts)
    base_parts = tuple(part.casefold() for part in base.parts)
    return len(resolved_parts) >= len(base_parts) and resolved_parts[: len(base_parts)] == base_parts


def _is_within_authorized_root(path: Path, root: Path) -> bool:
    """Positive authorization check without case-folding across distinct filesystems."""
    resolved = resolve_target(path)
    base = resolve_target(root)
    if resolved == base or base in resolved.parents:
        return True
    if not base.exists():
        return False
    current = resolved if resolved.exists() else resolved.parent
    try:
        while True:
            if current.exists() and os.path.samefile(current, base):
                return True
            parent = current.parent
            if parent == current:
                break
            current = parent
    except OSError:
        return False
    return False


def _same_location(left: Path | str, right: Path | str) -> bool:
    return _is_within(Path(left), Path(right)) and _is_within(Path(right), Path(left))


def _path_lexists(path: Path | str) -> bool:
    return os.path.lexists(os.fspath(Path(path).expanduser()))


def _protected_source_paths() -> tuple[Path, ...]:
    return (
        Path(__file__).resolve(),
        PIPELINE_PATH.resolve(),
        RENDER_JOB_PATH.resolve(),
        CAMERA_FRAME_PATH.resolve(),
        CURRENT_TEMPLATE_PATH.resolve(),
        DEFAULT_MANIFEST_PATH.resolve(),
    )


def assert_isolated_target(path: Path | str, *, label: str) -> Path:
    resolved = resolve_target(path)
    if _has_marker(resolved, ("apps", "web", "backend", "data")):
        raise EvalError(f"{label} must not point at the product task data directory")
    if _has_marker(resolved, ("测试",)):
        raise EvalError(f"{label} must not point at private artwork")
    data_dir = _configured_data_dir()
    if data_dir is not None and _is_within(resolved, data_dir):
        raise EvalError(f"{label} must not point at the configured data directory")
    return resolved


def assert_output_dir(path: Path | str) -> Path:
    raw = Path(path).expanduser()
    resolved = assert_isolated_target(path, label="output_dir")
    if _is_within(resolved, REPO_ROOT):
        raise EvalError("output_dir must be outside the repository")
    broad_roots = (Path(resolved.anchor), Path.home(), Path(tempfile.gettempdir()))
    if any(_same_location(resolved, root) for root in broad_roots):
        raise EvalError("output_dir must be a dedicated new leaf directory, not a broad filesystem root")
    if _path_lexists(raw) or _path_lexists(resolved):
        raise EvalError("output_dir must be a new non-existing leaf directory")
    parent = resolved.parent
    if not parent.is_dir():
        raise EvalError("output_dir parent must already exist")
    return resolved


def create_output_dir(path: Path | str) -> Path:
    resolved = assert_output_dir(path)
    try:
        resolved.mkdir(mode=0o700, parents=False, exist_ok=False)
    except FileExistsError as error:
        raise EvalError("output_dir must be a new non-existing leaf directory") from error
    marker = resolved / ".rf00-render-quality-run.json"
    atomic_write_json(
        marker,
        {
            "schema": "beian-render-quality-run/1",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "run_id": str(uuid.uuid4()),
        },
    )
    return resolved


def assert_approved_baseline_path(
    path: Path | str,
    *,
    output_dir: Path | None = None,
    cli: bool = False,
) -> Path:
    raw = Path(path).expanduser()
    if _path_lexists(raw):
        info = raw.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise EvalError("approved baseline must be a regular file, not a symbolic link or directory")
        if info.st_nlink != 1:
            raise EvalError("approved baseline must not be a hard link")
    resolved = assert_isolated_target(path, label="approved baseline")
    for source in _protected_source_paths():
        if resolved == source:
            raise EvalError("approved baseline must not overlap evaluator source files")
    if cli and not _is_within_authorized_root(resolved, APPROVED_BASELINE_ROOT):
        raise EvalError("CLI approved baseline must stay under workers/packaging/fixtures/render-quality/baselines")
    if resolved == resolve_target(APPROVED_BASELINE_ROOT):
        raise EvalError("approved baseline must be a file under the baselines directory")
    if _is_within(resolved, REPO_ROOT) and not _is_within_authorized_root(resolved, APPROVED_BASELINE_ROOT):
        raise EvalError("approved baseline inside the repository must stay under the official baselines directory")
    if output_dir is not None:
        out = resolve_target(output_dir)
        report = out / "rf00-report.json"
        if _is_within(resolved, report) and _is_within(report, resolved):
            raise EvalError("approved baseline must not overlap rf00-report.json")
        if _is_within(resolved, out):
            raise EvalError("approved baseline must not overlap output_dir")
    return resolved


def assert_within_root(path: Path, root: Path, *, label: str) -> Path:
    resolved = resolve_target(path)
    base = resolve_target(root)
    if resolved != base and base not in resolved.parents:
        raise EvalError(f"{label} must stay under {base}")
    return resolved


def assert_regular_generated_file(path: Path | str, root: Path, *, label: str) -> Path:
    raw = Path(path)
    resolved = assert_within_root(raw, root, label=label)
    try:
        info = raw.lstat()
    except (FileNotFoundError, OSError) as error:
        raise EvalError(f"{label} is missing") from error
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise EvalError(f"{label} must be a regular file")
    if info.st_nlink != 1:
        raise EvalError(f"{label} must not be a hard link")
    return resolved


def assert_fixture_id(identity: str) -> str:
    if not isinstance(identity, str) or not FIXTURE_ID_RE.fullmatch(identity):
        raise EvalError(f"unsafe fixture id: {identity!r}")
    return identity


def load_fixture_manifest(path: Path | None = None) -> dict[str, Any]:
    manifest_path = Path(path or DEFAULT_MANIFEST_PATH)
    resolved = assert_within_root(manifest_path, SYNTHETIC_FIXTURE_ROOT, label="fixture manifest")
    if not resolved.is_file():
        raise EvalError(f"fixture manifest missing: {resolved}")
    payload = json.loads(resolved.read_text(encoding="utf-8"))
    validated = validate_manifest_payload(payload)
    validated["_path"] = str(resolved)
    return validated


def _finite_number(value: Any, *, positive: bool = False) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    number = float(value)
    return math.isfinite(number) and (number > 0 if positive else True)


def _validate_type_roi(identity: str, roi: Any, width: float, height: float) -> None:
    if not isinstance(roi, dict) or set(roi) != {"text", "barcode"}:
        raise EvalError(f"{identity} type_roi_mm must have text/barcode")
    for name in ("text", "barcode"):
        bounds = roi.get(name)
        if not isinstance(bounds, list) or len(bounds) != 4 or not all(_finite_number(value) for value in bounds):
            raise EvalError(f"{identity} type_roi_mm.{name} must be four finite numbers")
        left, top, right, bottom = (float(value) for value in bounds)
        if left < 0 or top < 0 or right <= left or bottom <= top or right > width or bottom > height:
            raise EvalError(f"{identity} type_roi_mm.{name} must stay inside the front face")


def validate_manifest_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    if payload.get("schema") != MANIFEST_SCHEMA:
        raise EvalError(f"unsupported fixture schema: {payload.get('schema')}")
    if payload.get("phase") != "RF-00":
        raise EvalError("fixture manifest phase must be RF-00")
    if payload.get("supported_baseline_family") != RECTANGULAR_CARTON_FAMILY:
        raise EvalError("fixture manifest supported_baseline_family does not match evaluator contract")
    fixtures = payload.get("fixtures")
    if not isinstance(fixtures, list) or not fixtures:
        raise EvalError("fixture manifest has no fixtures")
    ids: list[str] = []
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(fixtures):
        if not isinstance(item, dict):
            raise EvalError(f"fixture {index} is not an object")
        identity = assert_fixture_id(str(item.get("id") or ""))
        family = item.get("packaging_family")
        dimensions = item.get("dimensions_mm")
        artwork = item.get("artwork")
        if not isinstance(family, str) or not family:
            raise EvalError(f"{identity} missing packaging_family")
        if not isinstance(item.get("role"), str) or not item["role"]:
            raise EvalError(f"{identity} missing role")
        if not isinstance(dimensions, dict) or set(dimensions) != {"width", "depth", "height"}:
            raise EvalError(f"{identity} dimensions_mm must have width/depth/height")
        if not isinstance(artwork, dict) or "fill_rgb" not in artwork or "pattern" not in artwork:
            raise EvalError(f"{identity} artwork must declare fill_rgb and pattern")
        if not all(_finite_number(dimensions[key], positive=True) for key in ("width", "depth", "height")):
            raise EvalError(f"{identity} dimensions_mm values must be finite positive numbers")
        fill_rgb = artwork.get("fill_rgb")
        if (
            not isinstance(fill_rgb, list)
            or len(fill_rgb) != 3
            or any(isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 255 for value in fill_rgb)
        ):
            raise EvalError(f"{identity} artwork.fill_rgb must be three 8-bit integers")
        pattern = artwork.get("pattern")
        if pattern not in SUPPORTED_PATTERNS:
            raise EvalError(f"{identity} artwork.pattern is unsupported")
        role = item["role"]
        if (role == "type_frequency") != (pattern == "type_frequency"):
            raise EvalError(f"{identity} role and type_frequency pattern must agree")
        if (role == "alpha_edge") != (pattern == "alpha_edge"):
            raise EvalError(f"{identity} role and alpha_edge pattern must agree")
        if pattern == "type_frequency":
            _validate_type_roi(
                identity,
                artwork.get("type_roi_mm"),
                float(dimensions["width"]),
                float(dimensions["height"]),
            )
        elif "type_roi_mm" in artwork:
            raise EvalError(f"{identity} type_roi_mm is only valid for type_frequency")
        ids.append(identity)
        normalized.append(dict(item))
        normalized[-1]["id"] = identity
    if len(ids) != len(set(ids)):
        raise EvalError("fixture ids must be unique")
    return {**dict(payload), "fixtures": normalized}


def list_fixtures(manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [dict(item) for item in manifest["fixtures"]]


def fixture_by_id(manifest: Mapping[str, Any], fixture_id: str) -> dict[str, Any]:
    for item in list_fixtures(manifest):
        if item["id"] == fixture_id:
            return item
    raise EvalError(f"unknown fixture: {fixture_id}")


def fixture_input_identity(spec: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "artwork": spec["artwork"],
        "dimensions_mm": spec["dimensions_mm"],
        "id": spec["id"],
        "packaging_family": spec["packaging_family"],
        "role": spec["role"],
        "schema": MANIFEST_SCHEMA,
    }


def fixture_input_sha256(spec: Mapping[str, Any]) -> str:
    return sha256_text(canonical_dumps(fixture_input_identity(spec)))


def family_status(spec: Mapping[str, Any]) -> str:
    if spec.get("packaging_family") == RECTANGULAR_CARTON_FAMILY:
        return "measured"
    return "unsupported"


def carton_net_rectangles(width: float, depth: float, height: float) -> dict[str, tuple[float, float, float, float]]:
    rectangles: dict[str, tuple[float, float, float, float]] = {}
    cursor = 0.0
    body_top = depth
    body_widths = {"back": width, "left": depth, "front": width, "right": depth}
    for role in FACE_ROLES:
        panel_width = body_widths[role]
        rectangles[role] = (cursor, body_top, cursor + panel_width, body_top + height)
        cursor += panel_width
    cap_left, _y0, cap_right, body_bottom = rectangles["front"]
    rectangles["top"] = (cap_left, body_bottom, cap_right, body_bottom + depth)
    rectangles["bottom"] = (cap_left, 0.0, cap_right, depth)
    return rectangles


def synthetic_carton_structure(source_hash: str, width: float, depth: float, height: float) -> dict[str, Any]:
    rectangles = carton_net_rectangles(width, depth, height)
    page_width = max(rect[2] for rect in rectangles.values())
    page_height = max(rect[3] for rect in rectangles.values())
    vertex_ids: dict[tuple[float, float], str] = {}
    segment_faces: dict[tuple[tuple[float, float], tuple[float, float]], list[str]] = {}
    face_segments: dict[str, list[tuple[tuple[float, float], tuple[float, float]]]] = {}
    for role, (x0, y0, x1, y1) in rectangles.items():
        corners = ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
        face_segments[role] = []
        for point in corners:
            vertex_ids.setdefault(point, f"v-{len(vertex_ids) + 1}")
        for start, end in zip(corners, corners[1:] + corners[:1]):
            key = tuple(sorted((start, end)))
            segment_faces.setdefault(key, []).append(role)
            face_segments[role].append(key)
    edge_ids = {segment: f"e-{index}" for index, segment in enumerate(sorted(segment_faces), start=1)}
    faces = [
        {
            "id": f"face-{role}",
            "boundary": [edge_ids[segment] for segment in face_segments[role]],
            "role": role,
            "artwork_transform": [1, 0, 0, 1, -x0, -y0],
        }
        for role, (x0, y0, _x1, _y1) in rectangles.items()
    ]
    folds = [
        {
            "edge": edge_ids[segment],
            "left_face": f"face-{roles[0]}",
            "right_face": f"face-{roles[1]}",
            "angle_deg": 90,
        }
        for segment, roles in sorted(segment_faces.items())
        if len(roles) == 2
    ]
    return {
        "schema": "packaging-structure/1",
        "units": "mm",
        "source": {
            "sha256": source_hash,
            "adapter": "structural-sidecar/1",
            "adapter_version": "1.0.0",
            "coordinate_space": "artboard-top-left",
            "page_size": [page_width, page_height],
        },
        "vertices": [
            {"id": identity, "x": point[0], "y": point[1]}
            for point, identity in vertex_ids.items()
        ],
        "edges": [
            {
                "id": edge_ids[segment],
                "start": vertex_ids[segment[0]],
                "end": vertex_ids[segment[1]],
                "assignment": "crease" if len(roles) == 2 else "cut",
                "source_refs": [f"rf00:{edge_ids[segment]}"],
            }
            for segment, roles in sorted(segment_faces.items())
        ],
        "faces": faces,
        "folds": folds,
        "root_face": "face-front",
        "validation": {"status": "accepted", "errors": [], "warnings": []},
    }


def _rgb01(fill_rgb: list[int]) -> tuple[float, float, float]:
    return tuple(max(0.0, min(1.0, value / 255.0)) for value in fill_rgb)  # type: ignore[return-value]


def type_roi_mm(face_width: float, face_height: float) -> dict[str, list[float]]:
    return {
        "text": [1.2, 1.0, max(2.0, face_width - 1.2), min(face_height, 9.5)],
        "barcode": [1.2, 11.0, max(2.0, face_width - 1.6), min(face_height, 26.0)],
    }


def _draw_type_frequency(page: Any, rect: tuple[float, float, float, float], fill_rgb: list[int]) -> None:
    x0, y0, x1, y1 = rect
    color = (0.07, 0.07, 0.07)
    page.insert_text(
        pymupdf.Point((x0 + 1.2) * MM_TO_PT, (y0 + 3.2) * MM_TO_PT),
        "RF00 4PT SAMPLE LINE 1234567890",
        fontsize=4,
        fontname="helv",
        color=color,
    )
    page.insert_text(
        pymupdf.Point((x0 + 1.2) * MM_TO_PT, (y0 + 6.4) * MM_TO_PT),
        "RF00 6PT HAIRLINE",
        fontsize=6,
        fontname="helv",
        color=color,
    )
    page.draw_line(
        pymupdf.Point((x0 + 1.2) * MM_TO_PT, (y0 + 8.2) * MM_TO_PT),
        pymupdf.Point((x1 - 1.2) * MM_TO_PT, (y0 + 8.2) * MM_TO_PT),
        color=color,
        width=0.15,
    )
    bar_top = y0 + 11.0
    bar_bottom = min(y1 - 2.0, y0 + 26.0)
    cursor = x0 + 1.2
    bit = 0
    while cursor < x1 - 1.6:
        width_mm = 0.35 if bit % 3 else 0.7
        if bit % 2 == 0:
            page.draw_rect(
                pymupdf.Rect(cursor * MM_TO_PT, bar_top * MM_TO_PT, (cursor + width_mm) * MM_TO_PT, bar_bottom * MM_TO_PT),
                color=None,
                fill=color,
            )
        cursor += width_mm + 0.35
        bit += 1
    _ = fill_rgb


def write_artwork_pdf(spec: Mapping[str, Any], dest: Path) -> dict[str, Any]:
    dims = spec["dimensions_mm"]
    rectangles = carton_net_rectangles(float(dims["width"]), float(dims["depth"]), float(dims["height"]))
    page_width = max(rect[2] for rect in rectangles.values())
    page_height = max(rect[3] for rect in rectangles.values())
    fill_rgb = [int(value) for value in spec["artwork"]["fill_rgb"]]
    pattern = str(spec["artwork"]["pattern"])
    script = {
        "dimensions_mm": dims,
        "fill_rgb": fill_rgb,
        "page_mm": [page_width, page_height],
        "pattern": pattern,
        "rectangles_mm": {role: list(rect) for role, rect in rectangles.items()},
        "type_roi_mm": type_roi_mm(float(dims["width"]), float(dims["height"])) if pattern == "type_frequency" else None,
    }
    document = pymupdf.open()
    page = document.new_page(width=page_width * MM_TO_PT, height=page_height * MM_TO_PT)
    fill = _rgb01(fill_rgb)
    for role, rect in rectangles.items():
        x0, y0, x1, y1 = rect
        if pattern == "alpha_edge" and role == "front":
            inset_x = (x1 - x0) * 0.18
            inset_y = (y1 - y0) * 0.18
            page.draw_rect(
                pymupdf.Rect(
                    (x0 + inset_x) * MM_TO_PT,
                    (y0 + inset_y) * MM_TO_PT,
                    (x1 - inset_x) * MM_TO_PT,
                    (y1 - inset_y) * MM_TO_PT,
                ),
                color=None,
                fill=fill,
            )
            continue
        if pattern == "alpha_edge":
            continue
        page.draw_rect(
            pymupdf.Rect(x0 * MM_TO_PT, y0 * MM_TO_PT, x1 * MM_TO_PT, y1 * MM_TO_PT),
            color=None,
            fill=fill,
        )
        if pattern == "type_frequency" and role in {"front", "back"}:
            _draw_type_frequency(page, rect, fill_rgb)
    if not dest.parent.is_dir() or _path_lexists(dest):
        document.close()
        raise EvalError("artwork PDF target must be a new file in the fixture directory")
    handle, temp_name = tempfile.mkstemp(prefix=".artwork.", suffix=".pdf", dir=str(dest.parent))
    os.close(handle)
    os.unlink(temp_name)
    try:
        document.set_metadata({"producer": "beian-rf00", "creator": "beian-rf00", "title": spec["id"]})
        document.save(temp_name, deflate=True, garbage=4, no_new_id=True)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
    finally:
        document.close()
    try:
        os.replace(temp_name, dest)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
    script_path = dest.with_name("artwork-script.json")
    atomic_write_text(script_path, canonical_dumps(script) + "\n")
    return {
        "artwork_pdf": dest,
        "artwork_script": script_path,
        "artwork_sha256": sha256_file(dest),
        "artwork_script_sha256": sha256_file(script_path),
        "page_mm": [page_width, page_height],
    }


def raster_width_px(page_mm: list[float]) -> int:
    if not isinstance(page_mm, list) or len(page_mm) != 2:
        raise EvalError("fixture page size must contain width and height")
    try:
        width_mm, height_mm = (float(page_mm[0]), float(page_mm[1]))
    except (TypeError, ValueError) as error:
        raise EvalError("fixture page size must contain finite positive numbers") from error
    if not math.isfinite(width_mm) or not math.isfinite(height_mm) or width_mm <= 0 or height_mm <= 0:
        raise EvalError("fixture page size must contain finite positive numbers")
    pixels = width_mm * height_mm * MIN_FACE_PIXELS_PER_MM * MIN_FACE_PIXELS_PER_MM
    if pixels > MAX_RASTER_PIXELS:
        raise EvalError(
            f"fixture page {width_mm}x{height_mm} mm exceeds 32MP at {MIN_FACE_PIXELS_PER_MM} px/mm"
        )
    return max(256, min(30_000, int(round(width_mm * MIN_FACE_PIXELS_PER_MM))))


def current_template_render(
    *, registry_path: Path | str | None = None
) -> dict[str, Any]:
    template = json.loads(CURRENT_TEMPLATE_PATH.read_text(encoding="utf-8"))
    render = dict(template.get("render") or {})
    profile_id = template.get("render_profile_id")
    spec = None
    if profile_id:
        contract = _load_render_contract()
        structure = {
            "schema": "resolved-packaging-job/3",
            "structure_schema": "packaging-structure/1",
            "structure_hash": "sha256:" + "a" * 64,
            "dimensions_mm": template["dimensions_mm"],
            "faces": {
                face: {}
                for face in ("front", "right", "back", "left", "top", "bottom")
            },
            "validation": {"status": "accepted", "errors": [], "warnings": []},
        }
        resolve_kw = {} if registry_path is None else {"registry_path": registry_path}
        spec = contract.resolve_render_spec(
            structure, profile_id, template.get("output_request"), **resolve_kw
        )
        render = contract.current_renderer_config(spec, **resolve_kw)
    return {
        "template_id": template.get("template_id"),
        "raster_width_px_declared": template.get("raster_width_px"),
        "render_profile_id": profile_id,
        "render": render,
        "render_spec": spec,
        "glb_tolerance_mm": template.get("glb_tolerance_mm", 0.5),
    }


def render_profile_sha256(*, registry_path: Path | str | None = None) -> str:
    template = current_template_render(registry_path=registry_path)
    spec = template.get("render_spec")
    if not isinstance(spec, dict) or not spec:
        raise EvalError("render identity requires canonical resolved render spec")
    return sha256_text(
        canonical_dumps(
            {
                "glb_tolerance_mm": template["glb_tolerance_mm"],
                "raster_width_px_declared": template["raster_width_px_declared"],
                "render_spec": spec,
            }
        )
    )


def collect_source_identity() -> dict[str, Any]:
    return {
        "evaluator_sha256": sha256_file(Path(__file__).resolve()),
        "render_job_sha256": source_bundle_sha256((RENDER_JOB_PATH, GLB_VERIFY_PATH)),
        "pipeline_sha256": source_bundle_sha256(
            (
                PIPELINE_PATH,
                DIELINE_PATH,
                WHITE_BACKGROUND_PATH,
                RENDER_CONTRACT_PATH,
                *STRUCTURE_V2_PATHS,
            )
        ),
        "camera_frame_sha256": sha256_file(CAMERA_FRAME_PATH),
        "template_sha256": sha256_file(CURRENT_TEMPLATE_PATH),
        "render_profile_sha256": render_profile_sha256(),
        "manifest_sha256": sha256_file(DEFAULT_MANIFEST_PATH) if DEFAULT_MANIFEST_PATH.is_file() else None,
    }


def collect_dependency_versions(*, blender_version: Any = None) -> dict[str, Any]:
    pymupdf_version = getattr(pymupdf, "VersionBind", None) or str(getattr(pymupdf, "version", ""))
    return {
        "python": platform.python_version(),
        "pillow": str(getattr(PIL, "__version__", "")),
        "pymupdf": str(pymupdf_version),
        "blender": blender_version,
    }


def declared_current_render() -> dict[str, Any]:
    template = current_template_render()
    render = template["render"]
    source = RENDER_JOB_PATH.read_text(encoding="utf-8")
    compression = re.search(r"image_settings\.compression\s*=\s*(\d+)", source)
    color_depth = re.search(r'image_settings\.color_depth\s*=\s*"(\d+)"', source)
    view_transform = re.search(
        r'view_transform\s*=\s*str\(render_config\.get\("view_transform",\s*"([^"]+)"\)\)',
        source,
    )
    return {
        "resolution": measured(
            [int(render["resolution_x"]), int(render["resolution_y"])],
            "px",
            "current carton template render.resolution_*",
        ),
        "samples": unavailable(
            "current_render_job_does_not_export_sample_count",
            unit="1",
            method="blender_result.json samples field",
        ),
        "engine": measured(
            "BLENDER_EEVEE_NEXT_or_BLENDER_EEVEE",
            None,
            "render_job.apply_eevee_engine declared choice",
        ),
        "view_transform": measured(
            view_transform.group(1) if view_transform else render.get("view_transform", "Standard"),
            None,
            "render_job view_transform default",
        ),
        "png_compression": (
            measured(int(compression.group(1)), "1", "render_job image_settings.compression")
            if compression
            else unavailable("declared_constant_not_found", method="render_job.py")
        ),
        "color_depth": (
            measured(color_depth.group(1), "bit", "render_job image_settings.color_depth")
            if color_depth
            else unavailable("declared_constant_not_found", method="render_job.py")
        ),
        "product_template_raster_width_px": measured(
            int(template["raster_width_px_declared"]),
            "px",
            "current carton template raster_width_px",
        ),
        "look_shape_keys": [
            "front_right",
            "back_left",
            "front_right_ground",
            "back_left_ground",
            "front_right_set",
            "back_left_set",
            "glb",
        ],
        "read_type_keys": [f"read_{face}" for face in ALL_FACES],
    }


def fixture_directory(output_dir: Path, fixture_id: str) -> Path:
    assert_fixture_id(fixture_id)
    dest = assert_within_root(output_dir / fixture_id, output_dir, label="fixture directory")
    return dest


def materialize_fixture(spec: Mapping[str, Any], dest: Path) -> dict[str, Any]:
    dest = assert_isolated_target(dest, label="fixture directory")
    try:
        dest.mkdir(mode=0o700, parents=False, exist_ok=False)
    except FileExistsError as error:
        raise EvalError("fixture directory must be new for this run") from error
    identity = fixture_input_sha256(spec)
    spec_path = dest / "fixture-spec.json"
    atomic_write_text(spec_path, canonical_dumps(fixture_input_identity(spec)) + "\n")
    record: dict[str, Any] = {
        "fixture_id": spec["id"],
        "packaging_family": spec["packaging_family"],
        "family_status": family_status(spec),
        "role": spec["role"],
        "input_sha256": identity,
        "spec_path": str(spec_path),
        "dimensions_mm": spec["dimensions_mm"],
    }
    if family_status(spec) == "unsupported":
        record["artwork_pdf"] = None
        record["artwork_sha256"] = None
        record["artwork_script_sha256"] = None
        return record
    source = dest / "source.ai"
    atomic_write_bytes(source, b"RF00-SYNTHETIC-SOURCE\n" + spec["id"].encode("ascii"))
    source_hash = sha256_file(source)
    sidecar = dest / "source.ai.structure.json"
    atomic_write_text(
        sidecar,
        json.dumps(
            synthetic_carton_structure(
                source_hash,
                float(spec["dimensions_mm"]["width"]),
                float(spec["dimensions_mm"]["depth"]),
                float(spec["dimensions_mm"]["height"]),
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
    )
    artwork = write_artwork_pdf(spec, dest / "artwork.pdf")
    template = current_template_render()
    page_mm = artwork["page_mm"]
    profile = {
        "template_id": "rf00-observe-current-studio",
        "render_profile_id": template.get("render_profile_id") or "compat-legacy-v0",
        "glb_tolerance_mm": template["glb_tolerance_mm"],
    }
    template_path = dest / "render-profile.json"
    atomic_write_text(template_path, canonical_dumps(profile) + "\n")
    record.update(
        {
            "artwork_pdf": str(artwork["artwork_pdf"]),
            "artwork_sha256": artwork["artwork_sha256"],
            "artwork_script_sha256": artwork["artwork_script_sha256"],
            "render_profile_sha256": sha256_file(template_path),
            "source_ai": str(source),
            "structure_sidecar": str(sidecar),
            "template": str(template_path),
            "page_mm": page_mm,
            "raster_width_px": raster_width_px(page_mm),
        }
    )
    return record


def luma(rgb: tuple[int, int, int]) -> float:
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


def _interior_bbox(alpha: Image.Image, pad: int = 2) -> tuple[int, int, int, int] | None:
    interior = alpha.point(lambda value: 255 if value >= INTERIOR_ALPHA else 0)
    box = interior.getbbox()
    if box is None:
        return None
    width, height = alpha.size
    left, top, right, bottom = box
    return (
        max(0, left - pad),
        max(0, top - pad),
        min(width, right + pad),
        min(height, bottom + pad),
    )


def _is_contour_pixel(alpha_px: Any, x: int, y: int, width: int, height: int) -> tuple[bool, int]:
    alpha = int(alpha_px[x, y])
    interior = alpha >= INTERIOR_ALPHA
    neighbor_interior = False
    neighbor_non_interior = False
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        nx, ny = x + dx, y + dy
        if nx < 0 or ny < 0 or nx >= width or ny >= height:
            continue
        if int(alpha_px[nx, ny]) >= INTERIOR_ALPHA:
            neighbor_interior = True
        else:
            neighbor_non_interior = True
    on_contour = (interior and neighbor_non_interior) or ((not interior) and neighbor_interior)
    return on_contour, alpha


def collect_alpha_border(image: Image.Image) -> dict[str, Any]:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    box = _interior_bbox(alpha)
    if box is None:
        return unavailable("no_product_contour", unit="1", method="product alpha contour and fringe")
    width, height = alpha.size
    pixels = alpha.load()
    left, top, right, bottom = box
    contour = 0
    interior_edge = 0
    fringe = 0
    transparent_touch = 0
    for y in range(top, bottom):
        for x in range(left, right):
            on_contour, value = _is_contour_pixel(pixels, x, y, width, height)
            if not on_contour:
                continue
            contour += 1
            if value >= INTERIOR_ALPHA:
                interior_edge += 1
            elif value == 0:
                transparent_touch += 1
            else:
                fringe += 1
    if contour == 0:
        return unavailable("no_product_contour", unit="1", method="product alpha contour and fringe")
    return measured(
        {
            "contour_count": contour,
            "interior_edge_count": interior_edge,
            "fringe_count": fringe,
            "transparent_touch_count": transparent_touch,
        },
        "1",
        "product alpha contour and fringe; not the canvas outer frame",
    )


def collect_white_separation(image: Image.Image) -> dict[str, Any]:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    box = _interior_bbox(alpha)
    if box is None:
        return unavailable(
            "no_product_contour",
            unit="8bit_luma",
            method="interior pixels adjacent to non-interior alpha",
        )
    width, height = rgba.size
    color_px = rgba.load()
    alpha_px = alpha.load()
    left, top, right, bottom = box
    edge_luma: list[float] = []
    for y in range(top, bottom):
        for x in range(left, right):
            value = int(alpha_px[x, y])
            if value < INTERIOR_ALPHA:
                continue
            neighbor_non_interior = False
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                nx, ny = x + dx, y + dy
                if nx < 0 or ny < 0 or nx >= width or ny >= height:
                    continue
                if int(alpha_px[nx, ny]) < INTERIOR_ALPHA:
                    neighbor_non_interior = True
                    break
            if not neighbor_non_interior:
                continue
            red, green, blue, _alpha = color_px[x, y]
            edge_luma.append(luma((red, green, blue)))
    if not edge_luma:
        return unavailable(
            "no_product_contour",
            unit="8bit_luma",
            method="interior pixels adjacent to non-interior alpha",
        )
    mean_edge = sum(edge_luma) / len(edge_luma)
    return measured(
        {
            "edge_mean_luma": round(mean_edge, 4),
            "delta_vs_white": round(abs(mean_edge - luma(WHITE_BG)), 4),
            "delta_vs_silver": round(abs(mean_edge - luma(SILVER_BG)), 4),
            "edge_pixel_count": len(edge_luma),
        },
        "8bit_luma",
        "product contour interior luma vs compositor white/silver; no fill-mean fallback",
    )


def collect_image_metrics(path: Path, *, contour_metrics: bool = True) -> dict[str, Any]:
    target = Path(path)
    missing = {
        "pixel_size": unavailable("file_missing", unit="px", method="PIL Image.size"),
        "byte_size": unavailable("file_missing", unit="byte", method="Path.stat().st_size"),
        "sha256": unavailable("file_missing", method="SHA-256 of file bytes including PNG ancillary chunks"),
        "pixel_sha256": unavailable("file_missing", method="SHA-256 of PIL raw pixels"),
        "alpha_border": unavailable("file_missing", unit="1", method="product alpha contour and fringe"),
        "white_separation": unavailable(
            "file_missing",
            unit="8bit_luma",
            method="interior pixels adjacent to non-interior alpha",
        ),
    }
    if not target.is_file():
        return missing
    try:
        with Image.open(target) as opened:
            opened.load()
            size = [int(opened.size[0]), int(opened.size[1])]
            mode = opened.mode
            raw = opened.tobytes()
            digest = hashlib.sha256()
            digest.update(f"{mode}:{size[0]}x{size[1]}:".encode("ascii"))
            digest.update(raw)
            pixel_digest = digest.hexdigest()
            if contour_metrics:
                alpha = collect_alpha_border(opened)
                separation = collect_white_separation(opened)
            else:
                alpha = unavailable("not_applicable_read_panel", unit="1", method="read panel skips contour scan")
                separation = unavailable(
                    "not_applicable_read_panel",
                    unit="8bit_luma",
                    method="read panel skips contour scan",
                )
    except OSError as error:
        reason = f"unreadable_image:{error}"
        return {
            "pixel_size": unavailable(reason, unit="px", method="PIL Image.size"),
            "byte_size": unavailable(reason, unit="byte", method="Path.stat().st_size"),
            "sha256": unavailable(reason, method="SHA-256 of file bytes"),
            "pixel_sha256": unavailable(reason, method="SHA-256 of PIL raw pixels"),
            "alpha_border": unavailable(reason, unit="1", method="product alpha contour and fringe"),
            "white_separation": unavailable(reason, unit="8bit_luma", method="interior pixels adjacent to non-interior alpha"),
        }
    return {
        "pixel_size": measured(size, "px", "PIL Image.size"),
        "byte_size": measured(target.stat().st_size, "byte", "Path.stat().st_size"),
        "sha256": measured(sha256_file(target), None, "SHA-256 of file bytes including PNG ancillary chunks"),
        "pixel_sha256": measured(pixel_digest, None, "SHA-256 of PIL mode+size+raw pixels; ignores PNG tEXt/eXIf"),
        "alpha_border": alpha,
        "white_separation": separation,
    }


def _crop_mm(image: Image.Image, roi_mm: Sequence[float], size_mm: tuple[float, float]) -> Image.Image:
    width, height = image.size
    left, top, right, bottom = (float(value) for value in roi_mm)
    face_w, face_h = size_mm
    x0 = int(round(left / face_w * width))
    y0 = int(round(top / face_h * height))
    x1 = int(round(right / face_w * width))
    y1 = int(round(bottom / face_h * height))
    x0 = max(0, min(x0, width - 1))
    y0 = max(0, min(y0, height - 1))
    x1 = max(x0 + 1, min(x1, width))
    y1 = max(y0 + 1, min(y1, height))
    return image.crop((x0, y0, x1, y1))


def collect_type_fidelity(spec: Mapping[str, Any], assets: Mapping[str, Any]) -> dict[str, Any]:
    oblique = unavailable(
        "type_roi_not_projected_through_oblique_still",
        unit="1",
        method="RF-00 does not invert ORTHO stills back to face millimetres",
    )
    if spec.get("artwork", {}).get("pattern") != "type_frequency":
        none = unavailable("no_type_roi", unit="1", method="type ROI exists only on type_frequency fixtures")
        return {"read_front": none, "read_back": none, "full": none, "card": none}
    dims = spec["dimensions_mm"]
    face_w = float(dims["width"])
    face_h = float(dims["height"])
    rois = spec.get("artwork", {}).get("type_roi_mm") or type_roi_mm(face_w, face_h)
    panel = assets.get("front")
    if not panel or not Path(panel).is_file():
        read_front = unavailable("file_missing", unit="1", method="known face-mm ROI on read_front")
    else:
        with Image.open(panel) as opened:
            gray = opened.convert("L")
            values: dict[str, Any] = {}
            for name, roi in rois.items():
                crop = _crop_mm(gray, roi, (face_w, face_h))
                try:
                    if min(crop.size) < 8:
                        values[name] = unavailable("roi_too_small", unit="1", method="FIND_EDGES variance in face-mm ROI")
                    else:
                        variance = float(ImageStat.Stat(crop.filter(ImageFilter.FIND_EDGES)).var[0])
                        values[name] = measured(
                            round(variance, 4),
                            "1",
                            f"FIND_EDGES variance in {name} ROI on read_front at native face px/mm",
                        )
                finally:
                    crop.close()
        read_front = measured(values, None, "known face-mm ROI on panel PNG; not a 3/4 still")
    return {
        "read_front": read_front,
        "read_back": unavailable(
            "read_back_roi_not_required",
            unit="1",
            method="front ROI is the RF-00 type probe",
        ),
        "full": oblique,
        "card": oblique,
    }


def _is_executable_file(candidate: Path) -> bool:
    if not candidate.is_file():
        return False
    if os.name == "nt":
        return candidate.suffix.casefold() in {".exe", ".com", ".bat", ".cmd"}
    return os.access(candidate, os.X_OK)


def resolve_blender_executable(explicit: Path | None) -> Path | None:
    if explicit is not None:
        candidate = Path(explicit).expanduser()
        return candidate.resolve() if _is_executable_file(candidate) else None
    found = shutil.which("blender") or shutil.which("blender.exe")
    if not found:
        return None
    hit = Path(found)
    return hit.resolve() if _is_executable_file(hit) else None


def blender_unavailable_reason(explicit: Path | None) -> str:
    if explicit is None:
        return "blender_executable_missing"
    candidate = Path(explicit).expanduser()
    if candidate.is_file():
        return "blender_executable_unusable"
    return "blender_executable_missing"


def blender_version_text(executable: Path) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            [str(executable), "--version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return unavailable(f"blender_version_probe_failed:{error}", method="blender --version")
    line = (proc.stdout or proc.stderr or "").splitlines()
    if proc.returncode != 0 or not line:
        return unavailable("blender_version_probe_failed", method="blender --version")
    return measured(line[0].strip(), None, "blender --version first line")


def probe_blender_runtime(executable: Path) -> dict[str, Any]:
    script = "\n".join(
        [
            "import bpy, json",
            "scene = bpy.context.scene",
            "engine_prop = bpy.types.RenderSettings.bl_rna.properties.get('engine')",
            "identifiers = [item.identifier for item in engine_prop.enum_items] if engine_prop else []",
            "chosen = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in identifiers else 'BLENDER_EEVEE'",
            "eevee = getattr(scene, 'eevee', None)",
            "samples = None",
            "sample_field = None",
            "for name in ('taa_render_samples', 'taa_samples', 'samples'):",
            "    if eevee is not None and hasattr(eevee, name):",
            "        samples = getattr(eevee, name)",
            "        sample_field = name",
            "        break",
            "print('RF00_PROBE ' + json.dumps({'engine_identifiers': identifiers, 'engine_chosen': chosen, 'samples': samples, 'sample_field': sample_field}))",
        ]
    )
    try:
        proc = subprocess.run(
            [str(executable), "--background", "--factory-startup", "--python-expr", script],
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "engine": unavailable(f"blender_probe_failed:{error}", method="blender --python-expr"),
            "samples": unavailable(f"blender_probe_failed:{error}", unit="1", method="eevee taa samples"),
        }
    payload = None
    for line in (proc.stdout or "").splitlines():
        if line.startswith("RF00_PROBE "):
            try:
                payload = json.loads(line[len("RF00_PROBE ") :])
            except json.JSONDecodeError:
                payload = None
            break
    if proc.returncode != 0 or not isinstance(payload, dict):
        return {
            "engine": unavailable("blender_probe_unparsed", method="blender --python-expr"),
            "samples": unavailable("blender_probe_unparsed", unit="1", method="eevee taa samples"),
        }
    samples = payload.get("samples")
    return {
        "engine": measured(payload.get("engine_chosen"), None, "factory-startup apply_eevee_engine equivalent"),
        "samples": (
            measured(samples, "1", f"scene.eevee.{payload.get('sample_field')}")
            if isinstance(samples, (int, float)) and not isinstance(samples, bool)
            else unavailable("eevee_sample_field_missing", unit="1", method="scene.eevee taa_*")
        ),
    }


def write_contact_sheet(paths: list[tuple[str, Path]], dest: Path) -> dict[str, Any]:
    images: list[tuple[str, Image.Image]] = []
    try:
        for label, path in paths:
            if not path.is_file():
                continue
            images.append((label, Image.open(path).convert("RGBA")))
        if not images:
            return unavailable("no_full_stills", method="PIL contact sheet of front_right")
        thumb_w = 360
        tiles = []
        for label, image in images:
            scale = thumb_w / float(image.width)
            thumb = image.resize((thumb_w, max(1, round(image.height * scale))), Image.Resampling.LANCZOS)
            canvas = Image.new("RGBA", (thumb_w, thumb.height + 28), (255, 255, 255, 255))
            canvas.paste(thumb, (0, 28), thumb)
            draw = ImageDraw.Draw(canvas)
            draw.text((8, 6), label, fill=(20, 20, 20, 255))
            tiles.append(canvas)
        cols = min(3, len(tiles))
        rows = (len(tiles) + cols - 1) // cols
        cell_w = max(tile.width for tile in tiles)
        cell_h = max(tile.height for tile in tiles)
        sheet = Image.new("RGBA", (cell_w * cols, cell_h * rows), (255, 255, 255, 255))
        for index, tile in enumerate(tiles):
            row, col = divmod(index, cols)
            sheet.paste(tile, (col * cell_w, row * cell_h), tile)
        if _path_lexists(dest):
            raise EvalError("contact sheet target must be new")
        handle, temp_name = tempfile.mkstemp(prefix=".contact-sheet.", suffix=".png", dir=str(dest.parent))
        os.close(handle)
        try:
            sheet.save(temp_name, format="PNG", compress_level=6)
            os.replace(temp_name, dest)
        except Exception:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            raise
        return measured(str(dest), None, "PIL grid of front_right stills")
    finally:
        for _label, image in images:
            image.close()


def validate_preflight_paths(job: Mapping[str, Any], fixture_dir: Path) -> tuple[dict[str, Path], dict[str, Path]]:
    project_raw = job.get("project_dir")
    project_path = Path(project_raw) if isinstance(project_raw, str) and project_raw else None
    try:
        project_matches = bool(
            project_path
            and not project_path.is_symlink()
            and stat.S_ISDIR(project_path.lstat().st_mode)
            and os.path.samefile(project_path, fixture_dir)
        )
    except OSError:
        project_matches = False
    if not project_matches:
        raise EvalError("pipeline project_dir escaped the fixture directory")
    resolved_job = job.get("resolved_job_path")
    if not resolved_job:
        raise EvalError("pipeline resolved_job_path is missing")
    resolved_job_path = assert_regular_generated_file(resolved_job, fixture_dir, label="resolved job")
    try:
        persisted_job = json.loads(resolved_job_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvalError("pipeline resolved job is unreadable") from error
    if not isinstance(persisted_job, dict) or persisted_job != dict(job):
        raise EvalError("pipeline resolved job does not match the returned preflight contract")

    outputs = job.get("outputs")
    assets = job.get("assets")
    if not isinstance(outputs, dict) or not isinstance(assets, dict):
        raise EvalError("pipeline output contract is incomplete")
    if set(outputs) != set(BLENDER_OUTPUT_KEYS):
        raise EvalError("pipeline output keys do not match the Blender contract")
    if set(assets) != set(ALL_FACES):
        raise EvalError("pipeline asset keys do not match the six-face contract")
    expected_outputs: dict[str, Path] = {}
    for key in BLENDER_OUTPUT_KEYS:
        raw = outputs.get(key)
        if not isinstance(raw, str) or not raw:
            raise EvalError(f"pipeline output path is missing:{key}")
        target = assert_within_root(Path(raw), fixture_dir, label=f"pipeline output {key}")
        if _path_lexists(target):
            raise EvalError(f"pipeline output must be new:{key}")
        expected_outputs[key] = target

    expected_assets: dict[str, Path] = {}
    assets_root = fixture_dir / "assets"
    for face in ALL_FACES:
        raw = assets.get(face)
        if not isinstance(raw, str) or not raw:
            raise EvalError(f"pipeline asset path is missing:{face}")
        target = assert_regular_generated_file(raw, assets_root, label=f"pipeline asset {face}")
        if target.name != f"panel_{face}.png":
            raise EvalError(f"pipeline asset filename is invalid:{face}")
        expected_assets[face] = target

    reserved: list[tuple[str, Path]] = [("resolved_job", resolved_job_path)]
    reserved.extend((f"output:{key}", path) for key, path in expected_outputs.items())
    reserved.extend((f"asset:{key}", path) for key, path in expected_assets.items())
    for card_key, source_key in OUTPUT_CARD_SOURCES.items():
        source = expected_outputs[source_key]
        card = source.with_name(f"{source.stem}_card.png")
        if _path_lexists(card):
            raise EvalError(f"pipeline review-card output must be new:{card_key}")
        reserved.append((f"output:{card_key}", card))
    for index, (left_label, left_path) in enumerate(reserved):
        for right_label, right_path in reserved[index + 1 :]:
            if _same_location(left_path, right_path):
                raise EvalError(f"pipeline paths must be unique:{left_label}:{right_label}")
    return expected_outputs, expected_assets


def validate_rendered_paths(
    job: Mapping[str, Any],
    fixture_dir: Path,
    expected_outputs: Mapping[str, Path],
    expected_assets: Mapping[str, Path],
) -> tuple[dict[str, Path], dict[str, Path]]:
    outputs = job.get("outputs")
    assets = job.get("assets")
    if not isinstance(outputs, dict) or not isinstance(assets, dict):
        raise EvalError("rendered output contract is incomplete")
    allowed_output_keys = set(expected_outputs)
    allowed_output_keys.update(
        card_key for card_key, source_key in OUTPUT_CARD_SOURCES.items() if source_key in expected_outputs
    )
    if not set(outputs).issubset(allowed_output_keys):
        raise EvalError("rendered output contract has unknown keys")
    validated_outputs: dict[str, Path] = {}
    for key, expected in expected_outputs.items():
        raw = outputs.get(key)
        if not isinstance(raw, str) or not _same_location(Path(raw), expected):
            raise EvalError(f"rendered output path changed:{key}")
        if key in BLENDER_REQUIRED_OUTPUT_KEYS or _path_lexists(raw):
            validated_outputs[key] = assert_regular_generated_file(raw, fixture_dir, label=f"rendered output {key}")
    for source_key, card_key in (("front_right", "front_right_card"), ("back_left", "back_left_card")):
        raw = outputs.get(card_key)
        expected_card = expected_outputs[source_key].with_name(f"{expected_outputs[source_key].stem}_card.png")
        if not isinstance(raw, str) or not _same_location(Path(raw), expected_card):
            raise EvalError(f"rendered output path changed:{card_key}")
        validated_outputs[card_key] = assert_regular_generated_file(
            raw,
            fixture_dir,
            label=f"rendered output {card_key}",
        )
    for card_key, source_key in OUTPUT_CARD_SOURCES.items():
        if card_key in {"front_right_card", "back_left_card"} or source_key not in expected_outputs:
            continue
        raw = outputs.get(card_key)
        if raw is None:
            continue
        expected_card = expected_outputs[source_key].with_name(f"{expected_outputs[source_key].stem}_card.png")
        if not isinstance(raw, str) or not _same_location(Path(raw), expected_card):
            raise EvalError(f"rendered output path changed:{card_key}")
        validated_outputs[card_key] = assert_regular_generated_file(
            raw,
            fixture_dir,
            label=f"rendered output {card_key}",
        )
    validated_assets: dict[str, Path] = {}
    for face, expected in expected_assets.items():
        raw = assets.get(face)
        if not isinstance(raw, str) or not _same_location(Path(raw), expected):
            raise EvalError(f"rendered asset path changed:{face}")
        validated_assets[face] = assert_regular_generated_file(
            raw,
            fixture_dir / "assets",
            label=f"rendered asset {face}",
        )
    return validated_outputs, validated_assets


def collect_output_metrics(
    job: Mapping[str, Any],
    spec: Mapping[str, Any],
    *,
    fixture_dir: Path,
    expected_outputs: Mapping[str, Path],
    expected_assets: Mapping[str, Path],
) -> dict[str, Any]:
    output_paths, asset_paths = validate_rendered_paths(
        job,
        fixture_dir,
        expected_outputs,
        expected_assets,
    )
    collected: dict[str, Any] = {}
    for key in ("front_right", "back_left", "front_right_card", "back_left_card"):
        collected[key] = collect_image_metrics(output_paths[key])
    glb = output_paths["glb"]
    collected["glb"] = {
        "byte_size": measured(glb.stat().st_size, "byte", "Path.stat().st_size"),
        "sha256": measured(sha256_file(glb), None, "SHA-256 of file bytes"),
    }
    for face in ALL_FACES:
        collected[f"read_{face}"] = collect_image_metrics(asset_paths[face], contour_metrics=False)
    collected["type_fidelity"] = collect_type_fidelity(spec, {key: str(value) for key, value in asset_paths.items()})
    return collected


def required_metrics_complete(item: Mapping[str, Any]) -> tuple[bool, str]:
    if item.get("family_status") == "unsupported":
        return True, "unsupported"
    outputs = item.get("outputs") or {}
    required: list[tuple[str, str, str]] = []
    for group in ("front_right", "back_left"):
        required.extend(
            (group, key, validator)
            for key, validator in (
                ("pixel_size", "pixel_size"),
                ("byte_size", "byte_size"),
                ("sha256", "sha256"),
                ("pixel_sha256", "sha256"),
                ("white_separation", "white_separation"),
                ("alpha_border", "alpha_border"),
            )
        )
    for group in ("front_right_card", "back_left_card", *(f"read_{face}" for face in ALL_FACES)):
        required.extend(
            (group, key, validator)
            for key, validator in (
                ("pixel_size", "pixel_size"),
                ("byte_size", "byte_size"),
                ("sha256", "sha256"),
                ("pixel_sha256", "sha256"),
            )
        )
    required.extend((("glb", "byte_size", "byte_size"), ("glb", "sha256", "sha256")))
    for group, key, validator in required:
        node = outputs.get(group) or {}
        metric = node.get(key)
        if not metric_measured(metric):
            return False, f"unavailable:{group}.{key}"
        if not metric_value_valid(metric, validator):
            return False, f"invalid:{group}.{key}"
    if item.get("role") == "type_frequency":
        fidelity = outputs.get("type_fidelity") or item.get("type_fidelity") or {}
        read_front = fidelity.get("read_front")
        if not metric_measured(read_front):
            return False, "unavailable:type_fidelity.read_front"
        leaves = read_front.get("value")
        if not isinstance(leaves, dict):
            return False, "unavailable:type_fidelity.read_front"
        for leaf in ("text", "barcode"):
            if not metric_measured_leaf(leaves.get(leaf)) or float(leaves[leaf]["value"]) < 0:
                return False, f"unavailable:type_fidelity.read_front.{leaf}"
    return True, "ok"


def fixture_matrix_complete(fixtures: Any) -> tuple[bool, str]:
    if not isinstance(fixtures, list) or not fixtures:
        return False, "report_incomplete"
    by_id: dict[str, Mapping[str, Any]] = {}
    for item in fixtures:
        if not isinstance(item, dict):
            return False, "fixture_contract_mismatch"
        fixture_id = item.get("fixture_id")
        if not isinstance(fixture_id, str) or fixture_id in by_id:
            return False, "fixture_contract_mismatch"
        by_id[fixture_id] = item
    if set(by_id) != set(EXPECTED_FIXTURE_CONTRACT):
        return False, "fixture_contract_mismatch"
    for fixture_id, (family, role) in EXPECTED_FIXTURE_CONTRACT.items():
        item = by_id[fixture_id]
        expected_status = "measured" if family == RECTANGULAR_CARTON_FAMILY else "unsupported"
        if (
            item.get("packaging_family") != family
            or item.get("role") != role
            or item.get("family_status") != expected_status
        ):
            return False, f"fixture_contract_mismatch:{fixture_id}"
        digest = item.get("input_sha256")
        if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
            return False, f"fixture_contract_mismatch:{fixture_id}"
        if family == RECTANGULAR_CARTON_FAMILY:
            for key in ("artwork_sha256", "artwork_script_sha256", "render_profile_sha256"):
                value = item.get(key)
                if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
                    return False, f"fixture_contract_mismatch:{fixture_id}:{key}"
        elif item.get("rendered") is not False:
            return False, f"fixture_contract_mismatch:{fixture_id}:rendered"
    return True, "ok"


def fixture_matrix_input_sha256(fixtures: Sequence[Mapping[str, Any]]) -> str:
    by_id = {str(item.get("fixture_id")): item for item in fixtures}
    return sha256_text(
        canonical_dumps(
            [
                {"id": fixture_id, "sha256": by_id[fixture_id]["input_sha256"]}
                for fixture_id in EXPECTED_FIXTURE_CONTRACT
            ]
        )
    )


def canonical_fixture_input_sha256s() -> dict[str, str]:
    manifest = load_fixture_manifest()
    specs = {item["id"]: item for item in list_fixtures(manifest)}
    if set(specs) != set(EXPECTED_FIXTURE_CONTRACT):
        raise EvalError("fixture manifest does not match the approved RF-00 contract")
    digests: dict[str, str] = {}
    for fixture_id, (family, role) in EXPECTED_FIXTURE_CONTRACT.items():
        spec = specs[fixture_id]
        if spec.get("packaging_family") != family or spec.get("role") != role:
            raise EvalError(f"fixture manifest contract mismatch:{fixture_id}")
        digests[fixture_id] = fixture_input_sha256(spec)
    return digests


def report_allows_baseline(report: Mapping[str, Any]) -> tuple[bool, str]:
    if report.get("ok") is not True:
        return False, "report_not_ok"
    if report.get("schema") != REPORT_SCHEMA:
        return False, "report_schema_mismatch"
    if report.get("phase") != "RF-00":
        return False, "report_phase_mismatch"
    if report.get("exit_code") != 0:
        return False, "report_exit_code_mismatch"
    if report.get("identity_verified_after_run") is not True:
        return False, "identity_not_verified_after_run"
    if report.get("product_behavior_changed") is not False:
        return False, "product_behavior_change_not_allowed"
    blender = report.get("blender")
    if not isinstance(blender, dict) or blender.get("available") is not True or blender.get("status") != "measured":
        return False, "blender_unavailable"
    blender_version = blender.get("version")
    if not metric_measured(blender_version) or not _nonempty_text(blender_version.get("value")):
        return False, "blender_version_unavailable"
    complete, reason = identity_complete(report)
    if not complete:
        return False, reason
    reported_identity = _identity_map(report)
    try:
        current_identity = collect_source_identity()
    except (OSError, EvalError):
        return False, "source_identity_unavailable"
    for key in IDENTITY_HASH_KEYS:
        if key == "input_sha256":
            continue
        if reported_identity.get(key) != current_identity.get(key):
            return False, f"identity_mismatch:{key}"
    dependencies = report["dependency_versions"]
    python_version = report.get("python_version")
    if (
        not metric_measured(python_version)
        or python_version.get("value") != dependencies["python"]
        or blender_version.get("value") != dependencies["blender"]
    ):
        return False, "dependency_version_mismatch"
    fixtures = report.get("fixtures")
    matrix_ok, matrix_reason = fixture_matrix_complete(fixtures)
    if not matrix_ok:
        return False, matrix_reason
    try:
        canonical_fixture_hashes = canonical_fixture_input_sha256s()
    except (OSError, EvalError, json.JSONDecodeError):
        return False, "fixture_manifest_unavailable"
    for item in fixtures:
        fixture_id = item["fixture_id"]
        if item["input_sha256"] != canonical_fixture_hashes.get(fixture_id):
            return False, f"fixture_provenance_mismatch:{fixture_id}"
    canonical_input, input_reason = _canonical_input_sha256(report)
    if canonical_input is None:
        return False, input_reason
    if canonical_input != fixture_matrix_input_sha256(fixtures):
        return False, "identity_mismatch:input_sha256"
    for item in fixtures:
        if item.get("family_status") == "unsupported":
            continue
        if item.get("rendered") is not True:
            return False, f"not_rendered:{item.get('fixture_id')}"
        complete, reason = required_metrics_complete(item)
        if not complete:
            return False, reason
    return True, "ok"


def _nonempty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _identity_map(payload: Mapping[str, Any]) -> dict[str, Any]:
    ident = payload.get("identity")
    return dict(ident) if isinstance(ident, dict) else {}


def _canonical_input_sha256(payload: Mapping[str, Any]) -> tuple[str | None, str]:
    top = payload.get("input_sha256")
    nested = _identity_map(payload).get("input_sha256")
    if (
        not isinstance(top, str)
        or not isinstance(nested, str)
        or not SHA256_RE.fullmatch(top)
        or not SHA256_RE.fullmatch(nested)
        or top != nested
    ):
        return None, "identity_mismatch:input_sha256"
    return str(top), "ok"


def identity_complete(payload: Mapping[str, Any]) -> tuple[bool, str]:
    canonical, reason = _canonical_input_sha256(payload)
    if canonical is None:
        return False, reason
    ident = _identity_map(payload)
    for key in IDENTITY_HASH_KEYS:
        if key == "input_sha256":
            continue
        value = ident.get(key)
        if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
            return False, f"identity_mismatch:{key}"
    deps = payload.get("dependency_versions")
    if not isinstance(deps, dict):
        return False, "identity_mismatch:dependency_versions"
    for key in DEPENDENCY_VERSION_KEYS:
        if not _nonempty_text(deps.get(key)):
            return False, f"identity_mismatch:{key}"
    return True, "ok"


def identity_compatible(existing: Mapping[str, Any], incoming: Mapping[str, Any]) -> tuple[bool, str]:
    complete, reason = identity_complete(existing)
    if not complete:
        return False, reason
    complete, reason = identity_complete(incoming)
    if not complete:
        return False, reason
    old_input, _ok = _canonical_input_sha256(existing)
    new_input, _ok = _canonical_input_sha256(incoming)
    if old_input != new_input:
        return False, "identity_mismatch:input_sha256"
    old_id = _identity_map(existing)
    new_id = _identity_map(incoming)
    for key in IDENTITY_HASH_KEYS:
        if key == "input_sha256":
            continue
        if old_id.get(key) != new_id.get(key):
            return False, f"identity_mismatch:{key}"
    old_deps = existing.get("dependency_versions") or {}
    new_deps = incoming.get("dependency_versions") or {}
    for key in DEPENDENCY_VERSION_KEYS:
        if old_deps.get(key) != new_deps.get(key):
            return False, f"identity_mismatch:{key}"
    return True, "ok"


def baseline_payload(report: Mapping[str, Any], *, evidence_report_sha256: str) -> dict[str, Any]:
    canonical, reason = _canonical_input_sha256(report)
    if canonical is None:
        raise EvalError(reason)
    identity = _identity_map(report)
    identity["input_sha256"] = canonical
    return {
        "schema": BASELINE_SCHEMA,
        "phase": "RF-00",
        "artifacts_in_git": False,
        "evidence_report_sha256": evidence_report_sha256,
        "input_sha256": canonical,
        "identity": identity,
        "dependency_versions": report.get("dependency_versions"),
        "python_version": report["python_version"],
        "blender": report["blender"],
        "current_render": report["current_render"],
        "fixtures": [
            {
                "fixture_id": item["fixture_id"],
                "packaging_family": item["packaging_family"],
                "family_status": item["family_status"],
                "role": item["role"],
                "input_sha256": item["input_sha256"],
                "artwork_sha256": item.get("artwork_sha256"),
                "artwork_script_sha256": item.get("artwork_script_sha256"),
                "render_profile_sha256": item.get("render_profile_sha256"),
                "rendered": item.get("rendered"),
                "outputs": item.get("outputs"),
            }
            for item in report["fixtures"]
        ],
    }


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def atomic_write_text(path: Path, payload: str) -> None:
    atomic_write_bytes(path, payload.encode("utf-8"))


def atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    atomic_write_text(path, serialized)


def atomic_write_json_cas(
    path: Path,
    payload: Mapping[str, Any],
    *,
    expected_sha256: str | None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    handle, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        current_sha256 = sha256_file(path) if path.is_file() else None
        if current_sha256 != expected_sha256:
            raise EvalError("approved baseline changed during update")
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


@contextmanager
def approved_baseline_lock(path: Path):
    lock_root = BASELINE_LOCK_ROOT
    lock_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root_info = lock_root.lstat()
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        raise EvalError("approved baseline lock root must be a real directory")
    lock_path = lock_root / f"{sha256_text(str(path))}.lock"
    flags = os.O_RDWR | os.O_CREAT
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_BINARY", 0)
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as error:
        raise EvalError("approved baseline lock file is unsafe") from error
    descriptor_info = os.fstat(descriptor)
    try:
        path_info = lock_path.lstat()
    except OSError as error:
        os.close(descriptor)
        raise EvalError("approved baseline lock file is unavailable") from error
    if (
        not stat.S_ISREG(descriptor_info.st_mode)
        or descriptor_info.st_nlink != 1
        or stat.S_ISLNK(path_info.st_mode)
        or path_info.st_dev != descriptor_info.st_dev
        or path_info.st_ino != descriptor_info.st_ino
    ):
        os.close(descriptor)
        raise EvalError("approved baseline lock file must be a unique regular file")
    with os.fdopen(descriptor, "r+b") as stream:
        stream.seek(0)
        if stream.read(1) == b"":
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def maybe_write_approved_baseline(
    report: Mapping[str, Any],
    path: Path,
    *,
    update_baseline: bool,
    output_dir: Path | None = None,
    evidence_report_path: Path | None = None,
    cli: bool = False,
) -> dict[str, Any]:
    isolated = assert_approved_baseline_path(path, output_dir=output_dir, cli=cli)
    result: dict[str, Any] = {
        "path": str(isolated),
        "updated": False,
        "status": "unchanged" if isolated.is_file() else "absent",
        "reason": "update_not_requested",
    }
    if not update_baseline:
        return result
    allowed, reason = report_allows_baseline(report)
    if not allowed:
        result["status"] = "refused"
        result["reason"] = reason
        return result
    if output_dir is None or evidence_report_path is None:
        result["status"] = "refused"
        result["reason"] = "approval_evidence_missing"
        return result
    evidence_path = Path(evidence_report_path)
    expected_evidence = resolve_target(output_dir) / "rf00-approval-evidence.json"
    if not _same_location(evidence_path, expected_evidence):
        result["status"] = "refused"
        result["reason"] = "approval_evidence_path_mismatch"
        return result
    try:
        evidence_path = assert_regular_generated_file(
            evidence_path,
            resolve_target(output_dir),
            label="approval evidence report",
        )
        evidence_bytes = evidence_path.read_bytes()
        evidence_payload = json.loads(evidence_bytes.decode("utf-8"))
        run_report_path = assert_regular_generated_file(
            resolve_target(output_dir) / "rf00-report.json",
            resolve_target(output_dir),
            label="run report",
        )
        run_report_bytes = run_report_path.read_bytes()
        run_report_payload = json.loads(run_report_bytes.decode("utf-8"))
    except (EvalError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        result["status"] = "refused"
        result["reason"] = "approval_evidence_invalid"
        return result
    if evidence_payload != dict(report) or run_report_payload != evidence_payload:
        result["status"] = "refused"
        result["reason"] = "approval_evidence_mismatch"
        return result
    evidence_sha256 = sha256_bytes(evidence_bytes)
    run_report_sha256 = sha256_bytes(run_report_bytes)
    if isolated.exists() and not isolated.is_file():
        result["status"] = "refused"
        result["reason"] = "approved_baseline_not_regular_file"
        return result
    with approved_baseline_lock(isolated):
        try:
            current_evidence = assert_regular_generated_file(
                evidence_path,
                resolve_target(output_dir),
                label="approval evidence report",
            )
            current_report = assert_regular_generated_file(
                run_report_path,
                resolve_target(output_dir),
                label="run report",
            )
            evidence_unchanged = sha256_file(current_evidence) == evidence_sha256
            report_unchanged = sha256_file(current_report) == run_report_sha256
        except (EvalError, OSError):
            evidence_unchanged = False
            report_unchanged = False
        if not evidence_unchanged or not report_unchanged:
            result["status"] = "refused"
            result["reason"] = "approval_evidence_changed_during_update"
            return result
        expected_sha256 = sha256_file(isolated) if isolated.is_file() else None
        if isolated.is_file():
            try:
                existing = json.loads(isolated.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                result["status"] = "refused"
                result["reason"] = "approved_baseline_invalid"
                return result
            compatible, mismatch = identity_compatible(existing, report)
            if not compatible:
                result["status"] = "refused"
                result["reason"] = mismatch
                return result
        try:
            atomic_write_json_cas(
                isolated,
                baseline_payload(report, evidence_report_sha256=evidence_sha256),
                expected_sha256=expected_sha256,
            )
        except EvalError:
            result["status"] = "refused"
            result["reason"] = "approved_baseline_changed_during_update"
            return result
    result["status"] = "written"
    result["updated"] = True
    result["reason"] = "ok"
    return result


def write_json(path: Path, payload: Mapping[str, Any]) -> None:
    atomic_write_json(path, payload)


def run_eval(
    *,
    output_dir: Path,
    fixtures: list[dict[str, Any]] | None = None,
    approved_baseline_path: Path | None = None,
    update_baseline: bool = False,
    render_blender: bool = True,
    blender_executable: Path | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    output_dir = assert_output_dir(output_dir)
    approved_path = assert_approved_baseline_path(
        Path(approved_baseline_path or DEFAULT_APPROVED_BASELINE),
        output_dir=output_dir,
        cli=False,
    )
    output_dir = create_output_dir(output_dir)
    run_marker = json.loads((output_dir / ".rf00-render-quality-run.json").read_text(encoding="utf-8"))
    run_id = str(run_marker["run_id"])
    if fixtures is None:
        manifest = load_fixture_manifest()
        specs = list_fixtures(manifest)
    else:
        specs = validate_manifest_payload(
            {
                "schema": MANIFEST_SCHEMA,
                "phase": "RF-00",
                "supported_baseline_family": RECTANGULAR_CARTON_FAMILY,
                "fixtures": fixtures,
            }
        )["fixtures"]
    input_sha256 = sha256_text(
        canonical_dumps([{"id": item["id"], "sha256": fixture_input_sha256(item)} for item in specs])
    )
    identity = collect_source_identity()
    identity["input_sha256"] = input_sha256
    blender_path = resolve_blender_executable(blender_executable)
    current_render = declared_current_render()
    blender_info: dict[str, Any]
    blender_failure_reason: str | None = None
    blender_ready = False
    if not render_blender:
        blender_info = {
            "available": blender_path is not None,
            "status": "unavailable",
            "reason": "blender_not_requested",
            "method": "run_eval(render_blender=False)",
        }
    elif blender_path is None:
        blender_failure_reason = blender_unavailable_reason(blender_executable)
        blender_info = {
            "available": False,
            "status": "unavailable",
            "reason": blender_failure_reason,
            "method": "resolve_blender_executable",
        }
    else:
        version = blender_version_text(blender_path)
        if not metric_measured(version):
            blender_failure_reason = "blender_version_probe_failed"
            blender_info = {
                "available": False,
                "status": "unavailable",
                "reason": blender_failure_reason,
                "path": str(blender_path),
                "version": version,
            }
        else:
            probe = probe_blender_runtime(blender_path)
            current_render["engine"] = probe["engine"]
            current_render["samples"] = probe["samples"]
            if not metric_measured(probe["engine"]):
                blender_failure_reason = "blender_runtime_probe_failed"
                blender_info = {
                    "available": False,
                    "status": "unavailable",
                    "reason": blender_failure_reason,
                    "path": str(blender_path),
                    "version": version,
                }
            else:
                blender_ready = True
                blender_info = {
                    "available": True,
                    "status": "measured",
                    "path": str(blender_path),
                    "version": version,
                }

    pipeline = None
    render_aborted = False
    render_failure_reason: str | None = None
    records: list[dict[str, Any]] = []
    contact_paths: list[tuple[str, Path]] = []
    for spec in specs:
        dest = fixture_directory(output_dir, spec["id"])
        prepared = materialize_fixture(spec, dest)
        record = {**prepared, "rendered": False, "blender_invoked": False}
        if family_status(spec) == "unsupported":
            record["family_status"] = "unsupported"
            records.append(record)
            continue
        if render_blender and blender_ready and not render_aborted:
            try:
                if pipeline is None:
                    pipeline = _load_pipeline()
                product = {
                    "code": spec["id"],
                    "slug": spec["id"],
                    "display_name": spec.get("label") or spec["id"],
                    "source_ai": "source.ai",
                    "template": "render-profile.json",
                    "structure_engine": "v2",
                    "structure_sidecar": "source.ai.structure.json",
                    "artwork_pdf": "artwork.pdf",
                }
                pass_started = time.perf_counter()
                job = pipeline.preflight_product(
                    product,
                    dest,
                    output_dir,
                    True,
                    {"enabled": False},
                    False,
                )
                expected_outputs, expected_assets = validate_preflight_paths(job, dest)
                record["blender_invoked"] = True
                job = pipeline.run_blender_job(job, blender_path)
                pass_elapsed = round(time.perf_counter() - pass_started, 4)
                outputs = collect_output_metrics(
                    job,
                    spec,
                    fixture_dir=dest,
                    expected_outputs=expected_outputs,
                    expected_assets=expected_assets,
                )
                record["outputs"] = outputs
                record["type_fidelity"] = outputs.get("type_fidelity")
                record["preflight_elapsed_s"] = measured(
                    job.get("preflight_elapsed_s"),
                    "s",
                    "pipeline.preflight_product preflight_elapsed_s",
                )
                record["blender_elapsed_s"] = measured(
                    job.get("blender_elapsed_s") or job.get("blender_process_elapsed_s"),
                    "s",
                    "run_blender_job blender_process_elapsed_s / blender_result.blender_elapsed_s",
                )
                record["pass_elapsed_s"] = measured(pass_elapsed, "s", "perf_counter around preflight+blender")
                record["render_resolution"] = measured(
                    job.get("render_resolution")
                    or [job.get("render", {}).get("resolution_x"), job.get("render", {}).get("resolution_y")],
                    "px",
                    "blender_result.render_resolution",
                )
                complete, reason = required_metrics_complete(record)
                record["rendered"] = complete
                if complete:
                    front = Path((job.get("outputs") or {})["front_right"])
                    contact_paths.append((spec["id"], front))
                else:
                    record["skip_reason"] = reason
                    render_aborted = True
                    render_failure_reason = reason
            except Exception as error:
                record["rendered"] = False
                record["skip_reason"] = "render_contract_invalid" if isinstance(error, EvalError) else "blender_render_failed"
                record["render_error_type"] = type(error).__name__
                render_aborted = True
                render_failure_reason = record["skip_reason"]
        elif render_blender:
            record["skip_reason"] = (
                "render_aborted_after_failure" if render_aborted else (blender_failure_reason or "blender_executable_missing")
            )
        records.append(record)

    contact = (
        write_contact_sheet(contact_paths, output_dir / "contact-sheet.png")
        if contact_paths
        else unavailable("blender_stills_absent", method="PIL contact sheet")
    )
    supported_records = [item for item in records if item.get("family_status") != "unsupported"]
    measured_ok = bool(supported_records)
    metric_failure = None
    if not supported_records:
        metric_failure = "no_supported_fixtures"
    for item in supported_records:
        if item.get("rendered") is not True:
            measured_ok = False
            metric_failure = f"not_rendered:{item.get('fixture_id')}"
            break
        complete, reason = required_metrics_complete(item)
        if not complete:
            measured_ok = False
            metric_failure = reason
            break
    identity_after = collect_source_identity()
    identity_after["input_sha256"] = input_sha256
    identity_unchanged = identity_after == identity
    if not render_blender:
        ok = identity_unchanged
        exit_code = 0 if ok else 1
        failure_reason = None if ok else "identity_changed_during_run"
    elif not blender_ready:
        ok = False
        exit_code = 2
        failure_reason = blender_failure_reason or "blender_executable_missing"
    else:
        ok = measured_ok and identity_unchanged
        exit_code = 0 if ok else 1
        failure_reason = None if ok else (
            "identity_changed_during_run"
            if not identity_unchanged
            else (render_failure_reason or metric_failure or "blender_render_failed")
        )

    blender_version_value = None
    if isinstance(blender_info.get("version"), dict):
        blender_version_value = blender_info["version"].get("value")
    report: dict[str, Any] = {
        "schema": REPORT_SCHEMA,
        "phase": "RF-00",
        "run_id": run_id,
        "ok": ok,
        "exit_code": exit_code,
        "failure_reason": failure_reason,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "input_sha256": input_sha256,
        "identity": identity,
        "identity_verified_after_run": identity_unchanged,
        "dependency_versions": collect_dependency_versions(blender_version=blender_version_value),
        "python_version": measured(platform.python_version(), None, "platform.python_version"),
        "blender": blender_info,
        "current_render": current_render,
        "fixtures": records,
        "contact_sheet": contact,
        "output_dir": str(output_dir),
        "elapsed_s": measured(round(time.perf_counter() - started, 4), "s", "perf_counter run_eval"),
        "product_behavior_changed": False,
    }
    if not identity_unchanged:
        report["identity_after"] = identity_after
    report_path = output_dir / "rf00-report.json"
    if update_baseline:
        report["baseline"] = {
            "path": str(approved_path),
            "updated": False,
            "status": "pending",
            "reason": "approval_not_committed",
        }
        evidence_path = output_dir / "rf00-approval-evidence.json"
        write_json(evidence_path, report)
        write_json(report_path, report)
        report["baseline"] = maybe_write_approved_baseline(
            report,
            approved_path,
            update_baseline=True,
            output_dir=output_dir,
            evidence_report_path=evidence_path,
            cli=False,
        )
        write_json(report_path, report)
    else:
        report["baseline"] = maybe_write_approved_baseline(
            report,
            approved_path,
            update_baseline=False,
            output_dir=output_dir,
            cli=False,
        )
        write_json(report_path, report)
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Observe current packaging 3D render quality. Does not change product output."
    )
    parser.add_argument("--output-dir", type=Path, required=True, help="Git-external directory for PNG/GLB/report")
    parser.add_argument(
        "--approved-baseline",
        type=Path,
        default=DEFAULT_APPROVED_BASELINE,
        help="Only files under workers/packaging/fixtures/render-quality/baselines/",
    )
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="Write the approved JSON baseline only if the report is complete and successful.",
    )
    parser.add_argument("--blender", type=Path, help="Blender executable. Missing path fails closed.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        output_dir = assert_output_dir(args.output_dir)
        approved = assert_approved_baseline_path(
            args.approved_baseline,
            output_dir=output_dir,
            cli=True,
        )
        report = run_eval(
            output_dir=output_dir,
            approved_baseline_path=approved,
            update_baseline=args.update_baseline,
            render_blender=True,
            blender_executable=args.blender,
        )
    except Exception as error:
        public_error = str(error) if isinstance(error, EvalError) else "render_quality_evaluation_failed"
        print(
            json.dumps(
                {"ok": False, "error": public_error, "error_type": type(error).__name__},
                ensure_ascii=False,
            )
        )
        return 1
    print(
        json.dumps(
            {
                "ok": report["ok"],
                "exit_code": report["exit_code"],
                "report": str(Path(args.output_dir) / "rf00-report.json"),
                "failure_reason": report.get("failure_reason"),
                "baseline": report.get("baseline"),
            },
            ensure_ascii=False,
        )
    )
    if report.get("failure_reason"):
        print(str(report["failure_reason"]), file=sys.stderr)
    return int(report["exit_code"])


if __name__ == "__main__":
    raise SystemExit(main())
