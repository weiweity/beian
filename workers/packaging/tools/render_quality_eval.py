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
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

import pymupdf
from PIL import Image, ImageDraw, ImageFilter, ImageStat
import PIL


PACKAGING_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGING_ROOT.parents[1]
PIPELINE_PATH = PACKAGING_ROOT / "pipeline.py"
RENDER_JOB_PATH = PACKAGING_ROOT / "blender" / "render_job.py"
CAMERA_FRAME_PATH = PACKAGING_ROOT / "camera_frame.py"
CURRENT_TEMPLATE_PATH = PACKAGING_ROOT / "templates" / "flower_box_47_5x47_5x177_5.json"
SYNTHETIC_FIXTURE_ROOT = PACKAGING_ROOT / "fixtures" / "render-quality"
DEFAULT_MANIFEST_PATH = SYNTHETIC_FIXTURE_ROOT / "manifest.json"
APPROVED_BASELINE_ROOT = SYNTHETIC_FIXTURE_ROOT / "baselines"
DEFAULT_APPROVED_BASELINE = APPROVED_BASELINE_ROOT / "rf00-current.json"
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
FACE_ROLES = ("back", "left", "front", "right")
ALL_FACES = ("front", "right", "back", "left", "top", "bottom")
MM_TO_PT = 72.0 / 25.4
MIN_FACE_PIXELS_PER_MM = 20.0
MAX_RASTER_PIXELS = 32_000_000
SILVER_BG = (228, 228, 232)
WHITE_BG = (255, 255, 255)
INTERIOR_ALPHA = 250
FIXTURE_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
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
    return isinstance(payload, dict) and payload.get("status") == "measured" and "value" in payload


def metric_measured_leaf(payload: Any) -> bool:
    if not metric_measured(payload):
        return False
    value = payload["value"]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and not math.isfinite(value):
        return False
    return True


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
    resolved = assert_isolated_target(path, label="output_dir")
    if _is_within(resolved, REPO_ROOT):
        raise EvalError("output_dir must be outside the repository")
    return resolved


def assert_approved_baseline_path(
    path: Path | str,
    *,
    output_dir: Path | None = None,
    cli: bool = False,
) -> Path:
    resolved = assert_isolated_target(path, label="approved baseline")
    for source in _protected_source_paths():
        if resolved == source:
            raise EvalError("approved baseline must not overlap evaluator source files")
    if cli and not _is_within(resolved, APPROVED_BASELINE_ROOT):
        raise EvalError("CLI approved baseline must stay under workers/packaging/fixtures/render-quality/baselines")
    if resolved == resolve_target(APPROVED_BASELINE_ROOT):
        raise EvalError("approved baseline must be a file under the baselines directory")
    if _is_within(resolved, REPO_ROOT) and not _is_within(resolved, APPROVED_BASELINE_ROOT):
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


def validate_manifest_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    if payload.get("schema") != MANIFEST_SCHEMA:
        raise EvalError(f"unsupported fixture schema: {payload.get('schema')}")
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
    dest.parent.mkdir(parents=True, exist_ok=True)
    document.set_metadata({"producer": "beian-rf00", "creator": "beian-rf00", "title": spec["id"]})
    document.save(dest, deflate=True, garbage=4, no_new_id=True)
    document.close()
    script_path = dest.with_name("artwork-script.json")
    script_path.write_text(canonical_dumps(script) + "\n", encoding="utf-8")
    return {
        "artwork_pdf": dest,
        "artwork_script": script_path,
        "artwork_sha256": sha256_file(dest),
        "artwork_script_sha256": sha256_file(script_path),
        "page_mm": [page_width, page_height],
    }


def raster_width_px(page_mm: list[float]) -> int:
    width_mm, height_mm = (float(page_mm[0]), float(page_mm[1]))
    pixels = width_mm * height_mm * MIN_FACE_PIXELS_PER_MM * MIN_FACE_PIXELS_PER_MM
    if pixels > MAX_RASTER_PIXELS:
        raise EvalError(
            f"fixture page {width_mm}x{height_mm} mm exceeds 32MP at {MIN_FACE_PIXELS_PER_MM} px/mm"
        )
    return max(256, min(30_000, int(round(width_mm * MIN_FACE_PIXELS_PER_MM))))


def current_template_render() -> dict[str, Any]:
    template = json.loads(CURRENT_TEMPLATE_PATH.read_text(encoding="utf-8"))
    render = dict(template.get("render") or {})
    return {
        "template_id": template.get("template_id"),
        "raster_width_px_declared": template.get("raster_width_px"),
        "render": render,
        "glb_tolerance_mm": template.get("glb_tolerance_mm", 0.5),
    }


def render_profile_sha256() -> str:
    template = current_template_render()
    return sha256_text(
        canonical_dumps(
            {
                "glb_tolerance_mm": template["glb_tolerance_mm"],
                "raster_width_px_declared": template["raster_width_px_declared"],
                "render": template["render"],
            }
        )
    )


def collect_source_identity() -> dict[str, Any]:
    return {
        "evaluator_sha256": sha256_file(Path(__file__).resolve()),
        "render_job_sha256": sha256_file(RENDER_JOB_PATH),
        "pipeline_sha256": sha256_file(PIPELINE_PATH),
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
    dest.mkdir(parents=True, exist_ok=True)
    identity = fixture_input_sha256(spec)
    spec_path = dest / "fixture-spec.json"
    spec_path.write_text(canonical_dumps(fixture_input_identity(spec)) + "\n", encoding="utf-8")
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
    source.write_bytes(b"RF00-SYNTHETIC-SOURCE\n" + spec["id"].encode("ascii"))
    source_hash = sha256_file(source)
    sidecar = dest / "source.ai.structure.json"
    sidecar.write_text(
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
        encoding="utf-8",
    )
    artwork = write_artwork_pdf(spec, dest / "artwork.pdf")
    template = current_template_render()
    page_mm = artwork["page_mm"]
    profile = {
        "template_id": "rf00-observe-current-studio",
        "raster_width_px": raster_width_px(page_mm),
        "render": template["render"],
        "glb_tolerance_mm": template["glb_tolerance_mm"],
    }
    template_path = dest / "render-profile.json"
    template_path.write_text(canonical_dumps(profile) + "\n", encoding="utf-8")
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


def collect_image_metrics(path: Path) -> dict[str, Any]:
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
            size = [int(opened.size[0]), int(opened.size[1])]
            mode = opened.mode
            raw = opened.tobytes()
            pixel_digest = sha256_bytes(f"{mode}:{size[0]}x{size[1]}:".encode("ascii") + raw)
            alpha = collect_alpha_border(opened)
            separation = collect_white_separation(opened)
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


def resolve_blender_executable(explicit: Path | None) -> Path | None:
    if explicit is not None:
        candidate = Path(explicit).expanduser()
        return candidate.resolve() if candidate.is_file() else None
    found = shutil.which("blender") or shutil.which("blender.exe")
    if not found:
        return None
    hit = Path(found)
    return hit.resolve() if hit.is_file() else None


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
            payload = json.loads(line[len("RF00_PROBE ") :])
            break
    if not payload:
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
        dest.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(dest, format="PNG", compress_level=6)
        return measured(str(dest), None, "PIL grid of front_right stills")
    finally:
        for _label, image in images:
            image.close()


def collect_output_metrics(job: Mapping[str, Any], spec: Mapping[str, Any]) -> dict[str, Any]:
    outputs = job.get("outputs") or {}
    assets = job.get("assets") or {}
    collected: dict[str, Any] = {}
    for key in ("front_right", "back_left", "front_right_card", "back_left_card"):
        raw = outputs.get(key)
        collected[key] = collect_image_metrics(Path(raw)) if raw else collect_image_metrics(Path(""))
    glb = outputs.get("glb")
    if glb and Path(glb).is_file():
        collected["glb"] = {
            "byte_size": measured(Path(glb).stat().st_size, "byte", "Path.stat().st_size"),
            "sha256": measured(sha256_file(Path(glb)), None, "SHA-256 of file bytes"),
        }
    else:
        collected["glb"] = {
            "byte_size": unavailable("file_missing", unit="byte", method="Path.stat().st_size"),
            "sha256": unavailable("file_missing", method="SHA-256 of file bytes"),
        }
    for face in ALL_FACES:
        raw = assets.get(face)
        collected[f"read_{face}"] = collect_image_metrics(Path(raw)) if raw else collect_image_metrics(Path(""))
    collected["type_fidelity"] = collect_type_fidelity(spec, assets)
    return collected


def required_metrics_complete(item: Mapping[str, Any]) -> tuple[bool, str]:
    if item.get("family_status") == "unsupported":
        return True, "unsupported"
    outputs = item.get("outputs") or {}
    required = (
        ("front_right", "pixel_size"),
        ("front_right", "pixel_sha256"),
        ("front_right", "white_separation"),
        ("front_right", "alpha_border"),
        ("front_right_card", "pixel_size"),
        ("front_right_card", "pixel_sha256"),
        ("read_front", "pixel_size"),
        ("read_front", "pixel_sha256"),
    )
    for group, key in required:
        node = outputs.get(group) or {}
        if not metric_measured(node.get(key)):
            return False, f"unavailable:{group}.{key}"
    if item.get("role") == "type_frequency":
        fidelity = outputs.get("type_fidelity") or item.get("type_fidelity") or {}
        read_front = fidelity.get("read_front")
        if not metric_measured(read_front):
            return False, "unavailable:type_fidelity.read_front"
        leaves = read_front.get("value")
        if not isinstance(leaves, dict):
            return False, "unavailable:type_fidelity.read_front"
        for leaf in ("text", "barcode"):
            if not metric_measured_leaf(leaves.get(leaf)):
                return False, f"unavailable:type_fidelity.read_front.{leaf}"
    return True, "ok"


def report_allows_baseline(report: Mapping[str, Any]) -> tuple[bool, str]:
    if report.get("ok") is not True:
        return False, "report_not_ok"
    if report.get("blender", {}).get("available") is not True:
        return False, "blender_unavailable"
    complete, reason = identity_complete(report)
    if not complete:
        return False, reason
    fixtures = report.get("fixtures")
    if not isinstance(fixtures, list) or not fixtures:
        return False, "report_incomplete"
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
    if not _nonempty_text(top) or not _nonempty_text(nested) or top != nested:
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
        if not _nonempty_text(ident.get(key)):
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


def baseline_payload(report: Mapping[str, Any]) -> dict[str, Any]:
    canonical, reason = _canonical_input_sha256(report)
    if canonical is None:
        raise EvalError(reason)
    identity = _identity_map(report)
    identity["input_sha256"] = canonical
    return {
        "schema": BASELINE_SCHEMA,
        "phase": "RF-00",
        "artifacts_in_git": False,
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


def atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def maybe_write_approved_baseline(
    report: Mapping[str, Any],
    path: Path,
    *,
    update_baseline: bool,
    output_dir: Path | None = None,
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
    if isolated.is_file():
        existing = json.loads(isolated.read_text(encoding="utf-8"))
        compatible, mismatch = identity_compatible(existing, report)
        if not compatible:
            result["status"] = "refused"
            result["reason"] = mismatch
            return result
    atomic_write_json(isolated, baseline_payload(report))
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
    output_dir.mkdir(parents=True, exist_ok=True)
    if fixtures is None:
        manifest = load_fixture_manifest()
        specs = list_fixtures(manifest)
    else:
        specs = validate_manifest_payload({"schema": MANIFEST_SCHEMA, "fixtures": fixtures})["fixtures"]
    input_sha256 = sha256_text(
        canonical_dumps([{"id": item["id"], "sha256": fixture_input_sha256(item)} for item in specs])
    )
    identity = collect_source_identity()
    identity["input_sha256"] = input_sha256
    blender_path = resolve_blender_executable(blender_executable)
    current_render = declared_current_render()
    blender_info: dict[str, Any]
    if not render_blender:
        blender_info = {
            "available": blender_path is not None,
            "status": "unavailable",
            "reason": "blender_not_requested",
            "method": "run_eval(render_blender=False)",
        }
    elif blender_path is None:
        blender_info = {
            "available": False,
            "status": "unavailable",
            "reason": "blender_executable_missing",
            "method": "resolve_blender_executable",
        }
    else:
        version = blender_version_text(blender_path)
        blender_info = {
            "available": True,
            "status": "measured",
            "path": str(blender_path),
            "version": version,
        }
        probe = probe_blender_runtime(blender_path)
        current_render["engine"] = probe["engine"]
        current_render["samples"] = probe["samples"]

    pipeline = None
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
        if render_blender and blender_path is not None:
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
            job = pipeline.run_blender_job(job, blender_path)
            pass_elapsed = round(time.perf_counter() - pass_started, 4)
            record["blender_invoked"] = True
            record["rendered"] = True
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
            outputs = collect_output_metrics(job, spec)
            record["outputs"] = outputs
            record["type_fidelity"] = outputs.get("type_fidelity")
            record["render_resolution"] = measured(
                job.get("render_resolution")
                or [job.get("render", {}).get("resolution_x"), job.get("render", {}).get("resolution_y")],
                "px",
                "blender_result.render_resolution",
            )
            front = Path((job.get("outputs") or {}).get("front_right") or "")
            if front.is_file():
                contact_paths.append((spec["id"], front))
        elif render_blender:
            record["skip_reason"] = "blender_executable_missing"
        records.append(record)

    contact = (
        write_contact_sheet(contact_paths, output_dir / "contact-sheet.png")
        if contact_paths
        else unavailable("blender_stills_absent", method="PIL contact sheet")
    )
    measured_ok = True
    metric_failure = None
    for item in records:
        if item.get("family_status") == "unsupported":
            continue
        if item.get("rendered") is not True:
            measured_ok = False
            metric_failure = f"not_rendered:{item.get('fixture_id')}"
            break
        complete, reason = required_metrics_complete(item)
        if not complete:
            measured_ok = False
            metric_failure = reason
            break
    if not render_blender:
        ok = True
        exit_code = 0
        failure_reason = None
    elif blender_path is None:
        ok = False
        exit_code = 2
        failure_reason = "blender_executable_missing"
    else:
        ok = measured_ok
        exit_code = 0 if ok else 1
        failure_reason = None if ok else (metric_failure or "blender_render_failed")

    blender_version_value = None
    if isinstance(blender_info.get("version"), dict):
        blender_version_value = blender_info["version"].get("value")
    report: dict[str, Any] = {
        "schema": REPORT_SCHEMA,
        "phase": "RF-00",
        "ok": ok,
        "exit_code": exit_code,
        "failure_reason": failure_reason,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "input_sha256": input_sha256,
        "identity": identity,
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
    report["baseline"] = maybe_write_approved_baseline(
        report,
        approved_path,
        update_baseline=update_baseline,
        output_dir=output_dir,
        cli=False,
    )
    write_json(output_dir / "rf00-report.json", report)
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
    except EvalError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
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
    if report.get("failure_reason") == "blender_executable_missing":
        print("blender_executable_missing", file=sys.stderr)
    return int(report["exit_code"])


if __name__ == "__main__":
    raise SystemExit(main())
