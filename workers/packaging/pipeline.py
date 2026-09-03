#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from typing import Any

from PIL import Image

try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ArrayObject, NameObject
except ImportError:
    if __name__ == "__main__":
        print(json.dumps({"ok": False, "error": "缺少 pypdf"}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
    raise


PIPELINE_VERSION = "1.4.0"
MAX_RASTER_PIXELS = 32_000_000
MAX_EXPLICIT_PROPOSAL_LAYERS = 16
MAX_PROPOSAL_LAYER_CANDIDATES = 128
MAX_PROPOSAL_PREVIEW_PATHS = 5_000
MAX_PROPOSAL_PREVIEW_POINTS = 20_000
MAX_PROPOSAL_PREVIEW_PATHS_PER_LAYER = 512
MAX_PROPOSAL_PREVIEW_POINTS_PER_PATH = 256
STRUCTURE_INPUT_CANDIDATES_SCHEMA = "packaging-structure-input-candidates/2"
STRUCTURE_INPUT_PREVIEW_SCHEMA = "illustrator-layer-preview/1"
ROOT = Path(__file__).resolve().parent
BLENDER_SCRIPT = ROOT / "blender" / "render_job.py"
PPT_SCRIPT = ROOT / "ppt" / "build_product_ppt.mjs"
ILLUSTRATOR_WORKER = ROOT / "illustrator" / "illustrator_worker.py"
ILLUSTRATOR_JSX = ROOT / "illustrator" / "export_ai.jsx"
ILLUSTRATOR_STRUCTURE_JSX = ROOT / "illustrator" / "export_structure.jsx"
ILLUSTRATOR_CURVE_HELPER = ROOT / "illustrator" / "curve_flatten.js"
ILLUSTRATOR_UNATTENDED_HOST = ROOT / "illustrator" / "unattended_host.jsx"
ILLUSTRATOR_RUNNER = ROOT / "illustrator" / "run_export.applescript"
ILLUSTRATOR_WINDOWS_RUNNER = ROOT / "illustrator" / "run_export.vbs"
ILLUSTRATOR_AGENT_CLIENT = ROOT / "illustrator" / "illustrator_agent.py"
ILLUSTRATOR_AGENT_SERVER = ROOT.parents[1] / "scripts" / "windows" / "illustrator-agent.ps1"
DIELINE_SCRIPT = ROOT / "dieline.py"
STRUCTURE_V2_FILES = tuple(sorted((ROOT / "structure_v2").glob("*.py")))

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from dieline import PT_TO_MM, layout_to_template, parse_knife_pdf, pick_knife_layer  # noqa: E402
from structure_v2 import (  # noqa: E402
    factory_input_hold,
    print_layer_failure_message,
    render_face_assets,
    resolve_structure,
)
from white_background import png_bytes_over_white  # noqa: E402

DEFAULT_NODE_MODULES = Path(os.environ.get("RUNTIME_NODE_MODULES", ""))
DEFAULT_RUNTIME_BIN = Path(os.environ.get("RUNTIME_BIN_DIR", ""))
DEFAULT_PRESENTATION_SKILL = Path(os.environ.get("PRESENTATION_SKILL_DIR", ""))
WINDOWS_NODE_CANDIDATES = (
    Path(r"C:\Program Files\nodejs\node.exe"),
    Path(r"C:\Program Files (x86)\nodejs\node.exe"),
    Path.home() / "AppData" / "Local" / "Programs" / "nodejs" / "node.exe",
)
DEFAULT_ILLUSTRATOR_APP = Path(
    "/Applications/Adobe Illustrator 2026/Adobe Illustrator.app"
)


class PipelineError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "packaging_failed",
        cause: str | None = None,
        fix: str | None = None,
    ):
        public_message = str(message).strip() or "打样中断"
        super().__init__(public_message)
        self.message = public_message
        self.code = str(code).strip() or "packaging_failed"
        self.cause = str(cause or "").strip()
        self.fix = str(fix or "").strip()

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": False,
            "code": self.code,
            "error": self.message[:80],
        }
        if self.cause:
            payload["cause"] = self.cause[:240]
        if self.fix:
            payload["fix"] = self.fix[:160]
        return payload


class PipelineHold(PipelineError):
    """A recoverable V2 product state, not a worker crash."""

    def __init__(
        self,
        *,
        status: str,
        code: str,
        message: str,
        resolution_path: Path,
        details: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.resolution_path = resolution_path
        self.details = dict(details or {})

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": False,
            "kind": "structure_resolution",
            "structure_status": self.status,
            "code": self.code,
            "message": self.message,
            "resolution_path": str(self.resolution_path),
            "details": self.details,
        }


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def explicit_proposal_layers(
    value: Any,
    selected_source_sha256: Any,
    current_source_sha256: str,
) -> list[str]:
    selected_hash = str(selected_source_sha256 or "").strip().lower()
    if (
        len(selected_hash) != 64
        or any(character not in "0123456789abcdef" for character in selected_hash)
        or selected_hash != current_source_sha256
    ):
        raise PipelineError(
            "稿件已变化，请重新选择结构层",
            code="packaging_structure_selection_stale",
            cause="proposal layer selection is not bound to the current source SHA-256",
            fix="重新识别当前稿件，再从这次返回的候选层中选择",
        )
    if (
        not isinstance(value, list)
        or not value
        or len(value) > MAX_EXPLICIT_PROPOSAL_LAYERS
        or any(not isinstance(item, str) or not item.strip() for item in value)
    ):
        raise PipelineError(
            "结构层选择无效，请重新选择",
            code="packaging_structure_selection_invalid",
            cause="proposal_layers must contain 1 to 16 non-empty layer names",
            fix="从当前稿件列出的候选层中重新选择，不要手填或沿用旧稿选择",
        )
    normalized: list[str] = []
    for item in value:
        if len(item) > 160:
            raise PipelineError(
                "结构层选择无效，请重新选择",
                code="packaging_structure_selection_invalid",
                cause="proposal layer name exceeds 160 characters",
                fix="从当前稿件列出的候选层中重新选择，不要手填或沿用旧稿选择",
            )
        # Illustrator selects layers by exact name. Whitespace is part of that
        # identity; strip is only an emptiness check at the manifest boundary.
        if item not in normalized:
            normalized.append(item)
    return normalized


def structure_input_candidates(
    illustrator_result: dict[str, Any] | None,
    source_sha256: str,
) -> dict[str, Any] | None:
    raw_candidates = (
        illustrator_result.get("proposal_layer_candidates")
        if isinstance(illustrator_result, dict)
        else None
    )
    if not isinstance(raw_candidates, list):
        return None
    validated: list[tuple[str, str, int, dict[str, Any]]] = []
    display_counts: dict[str, int] = {}
    for raw in raw_candidates[:MAX_PROPOSAL_LAYER_CANDIDATES]:
        if not isinstance(raw, dict):
            continue
        raw_name = raw.get("name")
        if not isinstance(raw_name, str):
            continue
        display_name = raw_name.strip()
        count = raw.get("stroke_only_path_count")
        if (
            not display_name
            or len(raw_name) > 160
            or raw.get("ambiguous_name", False) is not False
            or not isinstance(count, int)
            or isinstance(count, bool)
            or count < 1
        ):
            continue
        validated.append((raw_name, display_name, min(count, 1_000_000), raw))
        display_counts[display_name] = display_counts.get(display_name, 0) + 1

    proposal_layers: list[dict[str, Any]] = []
    preview_layers: list[dict[str, Any]] = []
    preview_path_count = 0
    preview_point_count = 0
    raw_page_size = illustrator_result.get("page_size_points")
    page_size_points = (
        [float(raw_page_size[0]), float(raw_page_size[1])]
        if isinstance(raw_page_size, list)
        and len(raw_page_size) == 2
        and all(
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
            and 1 <= float(value) <= 1_000_000
            for value in raw_page_size
        )
        else None
    )
    for name, display_name, count, raw in validated:
        # Two physically different layers can have identical or whitespace-
        # equivalent names. A name-only selector cannot distinguish them, so
        # omit the whole ambiguous group instead of selecting multiple layers.
        if display_counts[display_name] != 1:
            continue
        candidate_hash = hashlib.sha256(
            (source_sha256 + "\0" + name).encode("utf-8")
        ).hexdigest()[:16]
        candidate_id = f"proposal-layer-{candidate_hash}"
        proposal_layers.append(
            {"id": candidate_id, "name": name, "stroke_only_path_count": count}
        )
        consumed = _consume_preview_paths(
            raw,
            candidate_id,
            page_size_points,
            preview_layers,
            preview_path_count,
            preview_point_count,
        )
        preview_path_count, preview_point_count = consumed
    preview_plates: list[dict[str, Any]] = []
    plate_preview_path_count = 0
    plate_preview_point_count = 0
    raw_plates = illustrator_result.get("preview_plate_candidates")
    if isinstance(raw_plates, list):
        plate_names: dict[str, int] = {}
        plate_rows: list[tuple[str, str, dict[str, Any]]] = []
        for raw in raw_plates[:MAX_PROPOSAL_LAYER_CANDIDATES]:
            if not isinstance(raw, dict):
                continue
            raw_name = raw.get("name")
            if not isinstance(raw_name, str):
                continue
            display_name = raw_name.strip()
            if (
                not display_name
                or len(raw_name) > 160
                or raw.get("ambiguous_name", False) is not False
            ):
                continue
            plate_rows.append((raw_name, display_name, raw))
            plate_names[display_name] = plate_names.get(display_name, 0) + 1
        proposal_names = {layer["name"].strip() for layer in proposal_layers}
        for name, display_name, raw in plate_rows:
            if plate_names[display_name] != 1 or display_name in proposal_names:
                continue
            plate_id = "preview-plate-" + hashlib.sha256(
                (source_sha256 + "\0" + name).encode("utf-8")
            ).hexdigest()[:16]
            preview_plates.append({"id": plate_id, "name": name})
            consumed = _consume_preview_paths(
                raw,
                plate_id,
                page_size_points,
                preview_layers,
                plate_preview_path_count,
                plate_preview_point_count,
            )
            plate_preview_path_count, plate_preview_point_count = consumed
    if not proposal_layers:
        return None
    result = {
        "schema": STRUCTURE_INPUT_CANDIDATES_SCHEMA,
        "source_sha256": source_sha256,
        "proposal_layers": proposal_layers,
        "truncated": bool(
            illustrator_result.get("proposal_layer_candidates_truncated")
            or illustrator_result.get("preview_plate_candidates_truncated")
            or len(raw_candidates) > MAX_PROPOSAL_LAYER_CANDIDATES
            or (
                isinstance(raw_plates, list)
                and len(raw_plates) > MAX_PROPOSAL_LAYER_CANDIDATES
            )
        ),
    }
    if preview_plates:
        result["preview_plates"] = preview_plates
    if page_size_points is not None and preview_layers:
        result["preview"] = {
            "schema": STRUCTURE_INPUT_PREVIEW_SCHEMA,
            "page_size_points": page_size_points,
            "layers": preview_layers,
        }
    return result


def _consume_preview_paths(
    raw: dict[str, Any],
    candidate_id: str,
    page_size_points: list[float] | None,
    preview_layers: list[dict[str, Any]],
    preview_path_count: int,
    preview_point_count: int,
) -> tuple[int, int]:
    raw_paths = raw.get("preview_paths")
    if page_size_points is None or not isinstance(raw_paths, list):
        return preview_path_count, preview_point_count
    preview_paths: list[dict[str, Any]] = []
    preview_truncated = raw.get("preview_truncated") is True
    if len(raw_paths) > MAX_PROPOSAL_PREVIEW_PATHS_PER_LAYER:
        preview_truncated = True
        raw_paths = raw_paths[:MAX_PROPOSAL_PREVIEW_PATHS_PER_LAYER]
    for raw_path in raw_paths:
        if (
            preview_path_count >= MAX_PROPOSAL_PREVIEW_PATHS
            or preview_point_count >= MAX_PROPOSAL_PREVIEW_POINTS
        ):
            preview_truncated = True
            break
        if not isinstance(raw_path, dict) or not isinstance(raw_path.get("closed"), bool):
            preview_truncated = True
            continue
        raw_points = raw_path.get("points")
        if (
            not isinstance(raw_points, list)
            or len(raw_points) < 2
            or len(raw_points) > MAX_PROPOSAL_PREVIEW_POINTS_PER_PATH
            or preview_point_count + len(raw_points) > MAX_PROPOSAL_PREVIEW_POINTS
        ):
            preview_truncated = True
            continue
        points: list[list[float]] = []
        valid_path = True
        for raw_point in raw_points:
            if (
                not isinstance(raw_point, list)
                or len(raw_point) != 6
                or any(
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(float(value))
                    or abs(float(value)) > 10_000_000
                    for value in raw_point
                )
            ):
                valid_path = False
                break
            points.append([float(value) for value in raw_point])
        if not valid_path:
            preview_truncated = True
            continue
        preview_paths.append({"closed": raw_path["closed"], "points": points})
        preview_path_count += 1
        preview_point_count += len(points)
    if preview_paths:
        preview_layers.append(
            {
                "candidate_id": candidate_id,
                "paths": preview_paths,
                "truncated": preview_truncated,
            }
        )
    return preview_path_count, preview_point_count


def is_smoke_template(path: Path) -> bool:
    return "smoke" in path.stem.lower()


def production_template_paths(templates_dir: Path) -> list[Path]:
    if not templates_dir.is_dir():
        return []
    return sorted(p for p in templates_dir.glob("*.json") if p.is_file() and not is_smoke_template(p))


def page_size_matches(template: dict[str, Any], page_size: list[float]) -> bool:
    expected = template.get("expected_page_points") or []
    if len(expected) != 2 or len(page_size) != 2:
        return False
    try:
        tolerance = float(template.get("page_size_tolerance_ratio", 0.02))
    except (TypeError, ValueError):
        tolerance = 0.02
    for actual, wanted in zip(page_size, expected):
        try:
            actual_f = float(actual)
            wanted_f = float(wanted)
        except (TypeError, ValueError):
            return False
        if wanted_f <= 0 or abs(actual_f - wanted_f) / wanted_f > tolerance:
            return False
    return True


def template_label(template: dict[str, Any]) -> str:
    dims = template.get("dimensions_mm") or {}
    parts: list[str] = []
    width, depth, height = dims.get("width"), dims.get("depth"), dims.get("height")
    if width is not None and depth is not None and height is not None:
        parts.append(f"{width}×{depth}×{height}mm")
    desc = str(template.get("description") or template.get("template_id") or "").strip()
    if desc:
        parts.append(desc)
    return " ".join(parts) or "刀模"


def pick_template(assigned: Path, page_size: list[float], source: Path) -> tuple[Path, dict[str, Any]]:
    assigned_data = load_json(assigned)
    if page_size_matches(assigned_data, page_size):
        return assigned, assigned_data
    for cand in production_template_paths(assigned.parent):
        if cand.resolve() == assigned.resolve():
            continue
        data = load_json(cand)
        if page_size_matches(data, page_size):
            return cand, data
    labels = [template_label(load_json(path)) for path in production_template_paths(assigned.parent)]
    listed = "、".join(labels) if labels else "无"
    raise PipelineError(f"AI画板尺寸与模板不符：实际={page_size}，已登记=[{listed}]，文件={source}")


def resolve_from(base: Path, value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def job_fingerprint(
    source: Path,
    template_path: Path,
    product: dict[str, Any],
    extra_paths: tuple[Path, ...] = (),
) -> str:
    digest = hashlib.sha256()
    digest.update(PIPELINE_VERSION.encode("utf-8"))
    for pipeline_file in (
        Path(__file__).resolve(),
        BLENDER_SCRIPT,
        PPT_SCRIPT,
        ILLUSTRATOR_WORKER,
        ILLUSTRATOR_JSX,
        ILLUSTRATOR_STRUCTURE_JSX,
        ILLUSTRATOR_CURVE_HELPER,
        ILLUSTRATOR_UNATTENDED_HOST,
        ILLUSTRATOR_RUNNER,
        ILLUSTRATOR_WINDOWS_RUNNER,
        ILLUSTRATOR_AGENT_CLIENT,
        ILLUSTRATOR_AGENT_SERVER,
        DIELINE_SCRIPT,
        *STRUCTURE_V2_FILES,
        *extra_paths,
    ):
        if pipeline_file.is_file():
            digest.update(file_sha256(pipeline_file).encode("ascii"))
    digest.update(file_sha256(source).encode("ascii"))
    digest.update(file_sha256(template_path).encode("ascii"))
    digest.update(json.dumps(product, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    return digest.hexdigest()


def optional_content_layers(reader: PdfReader) -> list[str]:
    root = reader.trailer["/Root"]
    ocprops = root.get("/OCProperties")
    if not ocprops:
        return []
    ocprops = ocprops.get_object()
    return [str(ref.get_object().get("/Name")) for ref in ocprops.get("/OCGs", [])]


def make_layer_pdf(source: Path, output: Path, enabled_names: set[str]) -> None:
    reader = PdfReader(str(source))
    root = reader.trailer["/Root"]
    ocprops = root.get("/OCProperties")
    if not ocprops:
        raise PipelineError(f"AI文件没有可切换的PDF图层：{source}")
    ocprops = ocprops.get_object()
    groups = list(ocprops.get("/OCGs", []))
    enabled = []
    disabled = []
    for ref in groups:
        layer_name = str(ref.get_object().get("/Name"))
        (enabled if layer_name in enabled_names else disabled).append(ref)
    default = ocprops["/D"].get_object()
    default[NameObject("/BaseState")] = NameObject("/OFF")
    default[NameObject("/ON")] = ArrayObject(enabled)
    default[NameObject("/OFF")] = ArrayObject(disabled)
    writer = PdfWriter(clone_from=reader)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as stream:
        writer.write(stream)


def emit_stage(name: str) -> None:
    print(f"STAGE {name}", file=sys.stderr, flush=True)


def render_pdf_thumbnail(source: Path, output_dir: Path, width_px: int) -> Path:
    """pymupdf 先（杭州 Windows）；macOS 上 qlmanage 兜底。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    pymupdf_error: Exception | None = None
    try:
        import pymupdf

        doc = pymupdf.open(str(source))
        try:
            if doc.page_count < 1:
                raise PipelineError("平面没有页")
            page = doc[0]
            page.set_cropbox(page.mediabox)
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)
            if width <= 1 or height <= 1:
                raise PipelineError("平面页宽异常")
            zoom = float(width_px) / width
            area = width * height * zoom * zoom
            if area > MAX_RASTER_PIXELS:
                zoom = (MAX_RASTER_PIXELS / (width * height)) ** 0.5
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            out = output_dir / f"{source.stem}.png"
            pix.save(str(out))
            return out
        finally:
            doc.close()
    except PipelineError:
        raise
    except Exception as err:
        pymupdf_error = err

    ql = Path("/usr/bin/qlmanage")
    if ql.is_file():
        command = [
            str(ql),
            "-t",
            "-s",
            str(width_px),
            "-o",
            str(output_dir),
            str(source),
        ]
        process = subprocess.run(command, capture_output=True, text=True)
        if process.returncode == 0:
            named = output_dir / f"{source.stem}.png"
            if named.is_file():
                return named
            candidates = sorted(output_dir.glob(f"{source.stem}*.png"), key=lambda item: item.stat().st_mtime)
            if candidates:
                return candidates[-1]
        raise PipelineError("Quick Look渲染失败")
    if pymupdf_error is not None:
        raise PipelineError("渲染平面失败")
    raise PipelineError("渲染平面失败")


def scaled_box(box: list[int] | tuple[int, ...], scale: float) -> tuple[int, ...]:
    return tuple(round(value * scale) for value in box)


def _paper_face(size: tuple[int, int]) -> Image.Image:
    w, h = max(8, int(size[0])), max(8, int(size[1]))
    return Image.new("RGB", (w, h), (248, 248, 247))


def crop_faces(print_png: Path, full_png: Path, assets_dir: Path, template: dict[str, Any]) -> dict[str, list[int]]:
    reference_width = float(template["reference_width_px"])
    face_sources = template.get("face_sources", {})
    inset = int(template.get("composite_inset_reference_px", 0))
    assets_dir.mkdir(parents=True, exist_ok=True)
    sizes: dict[str, list[int]] = {}
    with Image.open(print_png).convert("RGB") as print_image, Image.open(full_png).convert("RGB") as full_image:
        if print_image.size != full_image.size:
            raise PipelineError(
                f"印刷层与合成图尺寸不一致：{print_image.size} vs {full_image.size}"
            )
        scale = print_image.width / reference_width
        boxes: dict[str, tuple[float, float, float, float]] = {}
        explicit = template.get("face_boxes") or {}
        if explicit:
            for face, raw in explicit.items():
                if not raw or len(raw) < 4:
                    continue
                boxes[face] = (float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3]))
        else:
            panel_x = template["panel_x"]
            body_top = template["body_top"]
            body_bottom = template["body_bottom"]
            boxes = {
                "back": (panel_x[0], body_top, panel_x[1], body_bottom),
                "left": (panel_x[1], body_top, panel_x[2], body_bottom),
                "front": (panel_x[2], body_top, panel_x[3], body_bottom),
                "right": (panel_x[3], body_top, panel_x[4], body_bottom),
            }
            lid = template.get("top_lid")
            if lid and len(lid) >= 4:
                boxes["top"] = (float(lid[0]), float(lid[1]), float(lid[2]), float(lid[3]))
        for face, box in boxes.items():
            source_image = full_image if face_sources.get(face) == "composite" else print_image
            face_inset = inset if face_sources.get(face) == "composite" else 0
            x0, y0, x1, y1 = (float(box[0]), float(box[1]), float(box[2]), float(box[3]))
            if x1 < x0:
                x0, x1 = x1, x0
            if y1 < y0:
                y0, y1 = y1, y0
            crop_box = (
                x0 + face_inset,
                y0 + face_inset,
                x1 - face_inset,
                y1 - face_inset,
            )
            crop = source_image.crop(scaled_box(crop_box, scale))
            if crop.size[0] < 2 or crop.size[1] < 2:
                continue
            output = assets_dir / f"panel_{face}.png"
            crop.save(output, compress_level=3)
            sizes[face] = list(crop.size)
        dims = template.get("dimensions_mm") or {}
        px_per_mm = scale / PT_TO_MM
        fallback = {
            "front": (dims.get("width", 40), dims.get("height", 80)),
            "back": (dims.get("width", 40), dims.get("height", 80)),
            "left": (dims.get("depth", 40), dims.get("height", 80)),
            "right": (dims.get("depth", 40), dims.get("height", 80)),
            "top": (dims.get("width", 40), dims.get("depth", 40)),
            "bottom": (dims.get("width", 40), dims.get("depth", 40)),
        }
        family = str(template.get("family") or "")
        required_print = ("front", "back") if family == "pouch" else ("front", "back", "left", "right")
        missing_print = [face for face in required_print if face not in sizes]
        if missing_print:
            raise PipelineError(f"刀线切面不完整，缺{missing_print}")
        for face, mm in fallback.items():
            if face in sizes:
                continue
            img = _paper_face((max(8, round(float(mm[0]) * px_per_mm)), max(8, round(float(mm[1]) * px_per_mm))))
            img.save(assets_dir / f"panel_{face}.png", compress_level=3)
            sizes[face] = list(img.size)
    return sizes


def run_illustrator_fallback(
    source: Path,
    project_dir: Path,
    template: dict[str, Any],
    illustrator_config: dict[str, Any],
) -> dict[str, Any]:
    app_path = Path(
        illustrator_config.get("application", str(DEFAULT_ILLUSTRATOR_APP))
    ).expanduser().resolve()
    if not app_path.exists():
        raise PipelineError(f"需要Illustrator兜底，但未找到应用：{app_path}")

    normalized_dir = project_dir / "illustrator_normalized"
    normalized_dir.mkdir(parents=True, exist_ok=True)
    config_path = normalized_dir / "illustrator_input.json"
    result_path = normalized_dir / "illustrator_result.json"
    log_path = normalized_dir / "illustrator.log"
    worker_config = {
        "application": str(app_path),
        "source_ai": str(source),
        "full_pdf": str(normalized_dir / "full.pdf"),
        "print_pdf": str(normalized_dir / "print_only.pdf"),
        "result_json": str(result_path),
        "debug_log": str(normalized_dir / "jsx_debug.log"),
        "print_layers": template["print_layers"],
        "attempt_id": uuid.uuid4().hex,
    }
    save_json(config_path, worker_config)
    timeout_seconds = int(illustrator_config.get("timeout_seconds", 1260))
    command = [
        sys.executable,
        str(ILLUSTRATOR_WORKER),
        str(config_path),
        "--timeout",
        str(timeout_seconds),
    ]
    process = subprocess.run(command, capture_output=True, text=True)
    log_path.write_text(process.stdout + "\n" + process.stderr, encoding="utf-8")
    result: dict[str, Any] | None = None
    if result_path.is_file():
        try:
            result = load_json(result_path)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            result = None
    if process.returncode != 0 or result is None:
        raise illustrator_export_failure(
            operation="normalize",
            returncode=process.returncode,
            stdout=process.stdout,
            stderr=process.stderr,
            result=result,
        )
    if not result.get("success"):
        raise illustrator_export_failure(
            operation="normalize",
            returncode=process.returncode,
            stdout=process.stdout,
            stderr=process.stderr,
            result=result,
        )
    return result


def _last_worker_diagnostic(*values: object) -> str:
    for value in values:
        lines = [line.strip() for line in str(value or "").splitlines() if line.strip()]
        for line in reversed(lines):
            if not line.startswith("STAGE "):
                return line[:240]
    return "Illustrator worker returned no diagnostic"


def _agent_error_payload(stderr: str) -> dict[str, Any]:
    """Read the worker's last-line JSON without rebuilding an error state machine from prose."""
    lines = [item.strip() for item in str(stderr or "").splitlines() if item.strip()]
    for line in reversed(lines):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("kind") == "illustrator_agent_error":
            return value
    return {}


def illustrator_export_failure(
    *,
    operation: str,
    returncode: int,
    stdout: str = "",
    stderr: str = "",
    result: dict[str, Any] | None = None,
) -> PipelineError:
    if operation not in {"normalize", "structure"}:
        raise ValueError(f"unsupported Illustrator export operation: {operation}")
    result = dict(result or {})
    agent_error = _agent_error_payload(stderr)
    agent_code = str(agent_error.get("code") or "")
    result_error = result.get("error") or result.get("semantic_errors") or result.get("missing_outputs")
    cause = _last_worker_diagnostic(
        result_error,
        agent_error.get("message"),
        stderr,
        stdout,
        f"worker exit {returncode}",
    )
    lowered = cause.lower()
    details = agent_error.get("details") if isinstance(agent_error.get("details"), dict) else {}
    diagnostic_text = " ".join(
        str(item)
        for item in (
            cause,
            details.get("diagnostic"),
            details,
            stderr,
            stdout,
        )
        if item
    ).lower()

    if (
        agent_code == "illustrator_documents_open"
        or "illustrator_documents_open" in lowered
        or "no other open documents" in lowered
        or "requires no other open documents" in lowered
    ):
        return PipelineError(
            "Illustrator 还有其他稿件打开，请关闭后重新打样",
            code="illustrator_documents_open",
            cause=cause,
            fix="关闭 Illustrator 中其他文档，仅保留本次自动任务",
        )
    if agent_code == "illustrator_configuration_mismatch" or "illustrator_configuration_mismatch" in lowered:
        return PipelineError(
            "Illustrator 配置已变化，请让管理员在开工板重新扫描后再打样",
            code="illustrator_configuration_mismatch",
            cause=cause,
            fix="在杭州设置页重新扫描并采用 Illustrator 路径",
        )
    if agent_code == "illustrator_process_identity_mismatch":
        return PipelineError(
            "Illustrator 进程与开工板路径不一致，请让管理员处理后重试",
            code="illustrator_process_identity_mismatch",
            cause=cause,
            fix="关闭异常 Illustrator 进程，在杭州设置页重新扫描后重试",
        )
    if agent_code in {"illustrator_agent_faulted", "illustrator_recovery_failed"}:
        return PipelineError(
            "Illustrator 自动清理失败，请让管理员确认桌面稿件后重启代理",
            code=agent_code,
            cause=cause,
            fix="确认并关闭残留稿件，再重新登录杭州电脑或重启桌面代理",
        )
    if agent_code in {
        "illustrator_agent_offline",
        "illustrator_agent_wrong_session",
        "illustrator_agent_wrong_platform",
        "illustrator_no_window",
    } or any(
        code in lowered
        for code in (
            "illustrator_agent_offline",
            "illustrator_agent_wrong_session",
            "illustrator_agent_wrong_platform",
            "illustrator_no_window",
        )
    ):
        return PipelineError(
            "Illustrator 桌面代理未在线，请让管理员登录杭州电脑后重新打样",
            code="illustrator_agent_offline",
            cause=cause,
            fix="保持管理员登录在交互桌面；不要从 Session 0 服务直接启动 Illustrator",
        )
    if agent_code == "illustrator_agent_protocol_error":
        return PipelineError(
            "Illustrator 桌面代理通信异常，请让管理员重启代理后重试",
            code="illustrator_agent_protocol_error",
            cause=cause,
            fix="重新登录杭州电脑以重启桌面代理；仍失败由管理员查看代理日志",
        )
    if agent_code == "illustrator_not_found":
        return PipelineError(
            "没有找到 Illustrator，请让管理员在开工板重新扫描",
            code="illustrator_not_found",
            cause=cause,
            fix="在杭州电脑设置页重新扫描 Illustrator 后再打样",
        )
    if agent_code == "illustrator_timeout" or returncode == 3 or "timed out" in lowered or "timeout" in lowered:
        return PipelineError(
            "这一单处理超时，请稍后重试",
            code="illustrator_timeout",
            cause=cause,
            fix="重稿保存 PDF 可能超过数分钟；不要清围栏，等桌面空闲后再试",
        )
    if "javascript code was missing" in diagnostic_text:
        return PipelineError(
            "桌面 Illustrator 没能加载导出脚本（JavaScript code was missing），请关掉 Illustrator 后重试",
            code="illustrator_bridge_failed",
            cause=cause,
            fix="关掉 Illustrator 后重试；仍失败由管理员查看桌面代理日志",
        )
    if agent_code in {
        "illustrator_bridge_missing",
        "illustrator_bridge_failed",
        "illustrator_agent_internal_error",
        "illustrator_agent_invalid_request",
        "illustrator_agent_path_denied",
        "illustrator_agent_file_missing",
        "illustrator_agent_invalid_json",
    } or any(
        code in lowered
        for code in (
            "illustrator_bridge_missing",
            "illustrator_bridge_failed",
            "illustrator_agent_internal_error",
        )
    ):
        return PipelineError(
            "Illustrator 桌面桥执行失败，请重新打样",
            code="illustrator_bridge_failed",
            cause=cause,
            fix="确认交互桌面无许可或恢复弹窗；仍失败由管理员查看任务日志",
        )
    if (
        agent_code == "illustrator_unavailable"
        or returncode == 6
        or "com unavailable" in lowered
        or "warm-up failed" in lowered
        or "launch failed" in lowered
        or "probe" in lowered
    ):
        return PipelineError(
            "Illustrator 没有启动成功，请让管理员登录杭州电脑后重试",
            code="illustrator_unavailable",
            cause=cause,
            fix="确认桌面代理在线，且 Illustrator 没有许可、恢复或模态弹窗",
        )
    if operation == "structure" and any(
        marker in lowered
        for marker in (
            "print_layers must",
            "configured artwork layer not found",
            "cannot set artwork layer visibility",
            "cannot fully restore artwork layers",
        )
    ):
        return PipelineError(
            print_layer_failure_message(result.get("layers") if isinstance(result, dict) else None),
            code="illustrator_artwork_layers_invalid",
            cause=cause,
            fix="确认印刷层名称；没有「印刷」时只能有一层非刀版/工艺顶层。拼合「图层 1」请换未拼合源稿",
        )
    if returncode == 5 or result.get("missing_outputs"):
        return PipelineError(
            "Illustrator 导出结果不完整，请重新打样",
            code="illustrator_output_incomplete",
            cause=cause,
            fix="重试一次；仍失败由管理员查看该任务的 Illustrator 日志",
        )
    if operation == "structure" and result and (
        not result.get("success") or result.get("semantic_errors")
    ):
        return PipelineError(
            "Illustrator 没有读到完整结构语义，请检查结构标记后重试",
            code="illustrator_structure_invalid",
            cause=cause,
            fix="检查 packaging:cut/crease 与六面标记，修正后重新打样",
        )
    if operation == "structure":
        return PipelineError(
            "Illustrator 结构语义导出失败，请重新打样",
            code="illustrator_structure_export_failed",
            cause=cause,
            fix="确认结构标记与交互桌面状态；仍失败由管理员查看任务日志",
        )
    return PipelineError(
        "Illustrator 标准化失败，请重新打样",
        code="illustrator_normalize_failed",
        cause=cause,
        fix="确认交互桌面状态；仍失败由管理员查看任务日志",
    )


def run_illustrator_structure_export(
    source: Path,
    project_dir: Path,
    illustrator_config: dict[str, Any],
    semantic_assignments: dict[str, Any] | None = None,
    proposal_layers: list[str] | None = None,
    print_layers: list[str] | None = None,
    source_sha256: str | None = None,
) -> dict[str, Any]:
    """V2 exporter is explicit and object-level; legacy fallback stays unchanged."""
    app_path = Path(
        illustrator_config.get("application", str(DEFAULT_ILLUSTRATOR_APP))
    ).expanduser().resolve()
    if not app_path.exists():
        raise PipelineError(
            "没有找到 Illustrator，请让管理员在开工板重新扫描",
            code="illustrator_not_found",
            cause=f"configured Illustrator path does not exist: {app_path}",
            fix="在杭州电脑设置页重新扫描 Illustrator 后再打样",
        )
    if not isinstance(print_layers, list):
        raise PipelineError(
            "渲染配置没有声明印刷图层，无法安全生成贴图",
            code="packaging_print_layers_missing",
            cause="print_layers must be a non-empty list",
            fix="在对应包装模板中声明稿件现有的顶层印刷图层，再重新打样",
        )
    normalized_print_layers = [
        str(value) for value in print_layers if str(value).strip()
    ]
    if not normalized_print_layers:
        raise PipelineError(
            "渲染配置没有声明印刷图层，无法安全生成贴图",
            code="packaging_print_layers_missing",
            cause="print_layers must be a non-empty list",
            fix="在对应包装模板中声明稿件现有的顶层印刷图层，再重新打样",
        )
    normalized_dir = project_dir / "illustrator_semantic"
    normalized_dir.mkdir(parents=True, exist_ok=True)
    config_path = normalized_dir / "illustrator_input.json"
    result_path = normalized_dir / "illustrator_result.json"
    log_path = normalized_dir / "illustrator.log"
    current_source_sha256 = file_sha256(source)
    expected_source_sha256 = str(source_sha256 or current_source_sha256).strip().lower()
    if (
        len(expected_source_sha256) != 64
        or any(character not in "0123456789abcdef" for character in expected_source_sha256)
        or expected_source_sha256 != current_source_sha256
    ):
        raise PipelineError(
            "稿件已变化，请重新识别结构",
            code="packaging_structure_selection_stale",
            cause="Illustrator export source no longer matches the preflight SHA-256",
            fix="重新识别当前稿件，不要沿用旧稿的结构选择",
        )
    worker_config = {
        "application": str(app_path),
        "source_ai": str(source),
        "source_sha256": expected_source_sha256,
        "full_pdf": str(normalized_dir / "full.pdf"),
        "print_pdf": str(normalized_dir / "artwork.pdf"),
        "structure_json": str(normalized_dir / "structure.json"),
        "result_json": str(result_path),
        "debug_log": str(normalized_dir / "jsx_debug.log"),
        "attempt_id": uuid.uuid4().hex,
        "semantic_assignments": semantic_assignments or {},
        "proposal_layers": [str(value) for value in (proposal_layers or []) if str(value).strip()],
        "print_layers": normalized_print_layers,
    }
    save_json(config_path, worker_config)
    timeout_seconds = int(illustrator_config.get("timeout_seconds", 1260))
    process = subprocess.run(
        [
            sys.executable,
            str(ILLUSTRATOR_WORKER),
            str(config_path),
            "--timeout",
            str(timeout_seconds),
        ],
        capture_output=True,
        text=True,
    )
    log_path.write_text(process.stdout + "\n" + process.stderr, encoding="utf-8")
    result: dict[str, Any] | None = None
    if result_path.is_file():
        try:
            result = load_json(result_path)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            result = None
    if process.returncode != 0 or result is None:
        raise illustrator_export_failure(
            operation="structure",
            returncode=process.returncode,
            stdout=process.stdout,
            stderr=process.stderr,
            result=result,
        )
    required = ("full_pdf", "print_pdf", "structure_json")
    missing = [
        key
        for key in required
        if not str(result.get(key) or "").strip()
        or not Path(str(result.get(key))).is_file()
    ]
    if not result.get("success") or missing:
        detail = dict(result)
        if missing:
            detail["missing_outputs"] = missing
        raise illustrator_export_failure(
            operation="structure",
            returncode=process.returncode,
            stdout=process.stdout,
            stderr=process.stderr,
            result=detail,
        )
    return result


def preflight_product_v2(
    product: dict[str, Any],
    manifest_dir: Path,
    output_root: Path,
    force: bool,
    illustrator_config: dict[str, Any],
) -> dict[str, Any]:
    started = time.perf_counter()
    source = resolve_from(manifest_dir, product["source_ai"])
    template_path = resolve_from(manifest_dir, product["template"])
    if not source.is_file():
        raise PipelineError(f"找不到AI文件：{source}")
    if not template_path.is_file():
        raise PipelineError(f"找不到渲染配置：{template_path}")
    template = load_json(template_path)
    code = str(product["code"])
    slug = str(product["slug"])
    project_dir = (output_root / code).resolve()
    assets_dir = project_dir / "assets"
    project_dir.mkdir(parents=True, exist_ok=True)
    source_sha256 = file_sha256(source)

    sidecar_value = product.get("structure_sidecar")
    structure_sidecar = resolve_from(manifest_dir, sidecar_value) if sidecar_value else None
    artwork_value = product.get("artwork_pdf")
    artwork_pdf = resolve_from(manifest_dir, artwork_value) if artwork_value else None
    illustrator_result: dict[str, Any] | None = None
    if artwork_pdf is None:
        if not bool(illustrator_config.get("enabled", True)):
            raise PipelineError("V2 需要对象级清理后的 artwork PDF，但 Illustrator 已禁用")
        if "proposal_layers" in product:
            # A legacy layer may only enter proposal mode after an explicit,
            # source-bound human selection.  Do not replace it with OCG or
            # filename heuristics.
            proposal_layers = explicit_proposal_layers(
                product["proposal_layers"],
                product.get("proposal_source_sha256"),
                source_sha256,
            )
        else:
            proposal_layers = []
        illustrator_result = run_illustrator_structure_export(
            source,
            project_dir,
            illustrator_config,
            semantic_assignments=product.get("semantic_assignments"),
            proposal_layers=proposal_layers,
            print_layers=template.get("print_layers"),
            source_sha256=source_sha256,
        )
        artwork_pdf = Path(illustrator_result["print_pdf"])
        if structure_sidecar is None:
            structure_sidecar = Path(illustrator_result["structure_json"])
            factory_hold = factory_input_hold(
                source,
                illustrator_result.get("layers"),
                product,
            )
            if factory_hold is not None:
                hold_code, hold_message = factory_hold
                resolution_path = project_dir / "structure_resolution.json"
                save_json(
                    resolution_path,
                    {
                        "status": "unsupported",
                        "code": hold_code,
                        "message": hold_message,
                        "source_sha256": source_sha256,
                    },
                )
                artwork_preview = render_pdf_thumbnail(
                    artwork_pdf,
                    project_dir / "structure_preview",
                    width_px=5_600,
                )
                raise PipelineHold(
                    status="unsupported",
                    code=hold_code,
                    message=hold_message,
                    resolution_path=resolution_path,
                    details={
                        "artwork_pdf": str(artwork_pdf),
                        "artwork_preview": str(artwork_preview),
                        "structure_sidecar": str(structure_sidecar),
                        "source_sha256": source_sha256,
                    },
                )
    if not artwork_pdf.is_file():
        raise PipelineError(f"对象清理后的 artwork PDF 不存在：{artwork_pdf}")

    resolution = resolve_structure(
        source,
        sidecar=structure_sidecar,
        cache_dir=project_dir / "structure_cache",
    )
    resolution_path = project_dir / "structure_resolution.json"
    resolution_payload = resolution.as_dict()
    input_candidates = structure_input_candidates(illustrator_result, source_sha256)
    if input_candidates is not None:
        resolution_payload["input_candidates"] = input_candidates
    save_json(resolution_path, resolution_payload)
    if resolution.status != "ready" or resolution.resolved is None:
        artwork_preview = render_pdf_thumbnail(
            artwork_pdf,
            project_dir / "structure_preview",
            width_px=5_600,
        )
        raise PipelineHold(
            status=resolution.status,
            code=resolution.code or "structure_review_required",
            message=resolution.message or "包装结构需要人工确认。",
            resolution_path=resolution_path,
            details={
                "artwork_pdf": str(artwork_pdf),
                "artwork_preview": str(artwork_preview),
                "structure_sidecar": str(structure_sidecar) if structure_sidecar else None,
                "source_sha256": source_sha256,
            },
        )
    structure_job = resolution.resolved
    fingerprint_paths = [template_path, artwork_pdf]
    if structure_sidecar is not None:
        fingerprint_paths.append(structure_sidecar)
    fingerprint = job_fingerprint(
        source,
        template_path,
        {**product, "structure_hash": structure_job["structure_hash"]},
        extra_paths=tuple(fingerprint_paths),
    )
    result_path = project_dir / "pipeline_result.json"
    if not force and result_path.is_file():
        previous = load_json(result_path)
        outputs = previous.get("outputs", {})
        required = [outputs.get(key) for key in ("blend", "glb", "front_right", "back_left")]
        if previous.get("fingerprint") == fingerprint and all(
            value and Path(value).is_file() for value in required
        ):
            previous["cache_hit"] = True
            previous["preflight_elapsed_s"] = round(time.perf_counter() - started, 4)
            return previous

    face_sizes = render_face_assets(
        artwork_pdf,
        structure_job,
        assets_dir,
        raster_width_px=int(template.get("raster_width_px", 10_000)),
    )
    reader = PdfReader(str(artwork_pdf))
    media = reader.pages[0].mediabox
    page_size = [float(media.width), float(media.height)]
    resolved = {
        "pipeline_version": PIPELINE_VERSION,
        "fingerprint": fingerprint,
        "cache_hit": False,
        "code": code,
        "slug": slug,
        "display_name": product["display_name"],
        "source_ai": str(source),
        "template_path": str(template_path),
        "template_id": template.get("template_id", "v2-render-profile"),
        "project_dir": str(project_dir),
        "assets_dir": str(assets_dir),
        "dimensions_mm": structure_job["dimensions_mm"],
        "render": template["render"],
        "glb_tolerance_mm": template.get("glb_tolerance_mm", 0.5),
        "page_size_points": page_size,
        "layers": illustrator_result.get("layers", []) if illustrator_result else [],
        "face_texture_sizes": face_sizes,
        "preflight_elapsed_s": round(time.perf_counter() - started, 4),
        "input_mode": "illustrator_semantic" if illustrator_result else "semantic_sidecar",
        "structure_engine": "v2",
        "structure_schema": structure_job["structure_schema"],
        "structure_hash": structure_job["structure_hash"],
        "structure_cache_hit": resolution.cache_hit,
        "structure_resolution_path": str(resolution_path),
        "illustrator_invoked": bool(illustrator_result),
        "illustrator_version": illustrator_result.get("illustrator_version") if illustrator_result else None,
        "illustrator_elapsed_s": illustrator_result.get("worker_elapsed_s", 0) if illustrator_result else 0,
        "normalized_full_pdf": illustrator_result.get("full_pdf") if illustrator_result else None,
        "normalized_print_pdf": str(artwork_pdf),
        "normalized_structure_sidecar": str(structure_sidecar) if structure_sidecar else None,
        "assets": {
            face: str(assets_dir / f"panel_{face}.png")
            for face in ("front", "right", "back", "left", "top", "bottom")
        },
        "outputs": {
            "blend": str(project_dir / f"{code}_{slug}_white_studio.blend"),
            "glb": str(project_dir / f"{code}_{slug}.glb"),
            "front_right": str(project_dir / f"{code}_{slug}_front_right_white.png"),
            "back_left": str(project_dir / f"{code}_{slug}_back_left_white.png"),
            "front_right_ground": str(project_dir / f"{code}_{slug}_front_right_ground.png"),
            "back_left_ground": str(project_dir / f"{code}_{slug}_back_left_ground.png"),
        },
    }
    resolved_path = project_dir / "resolved_job.json"
    resolved["resolved_job_path"] = str(resolved_path)
    save_json(resolved_path, resolved)
    return resolved


def preflight_product(
    product: dict[str, Any],
    manifest_dir: Path,
    output_root: Path,
    force: bool,
    illustrator_config: dict[str, Any],
    force_illustrator: bool,
) -> dict[str, Any]:
    if product.get("structure_engine") == "v2":
        return preflight_product_v2(
            product,
            manifest_dir,
            output_root,
            force,
            illustrator_config,
        )
    started = time.perf_counter()
    source = resolve_from(manifest_dir, product["source_ai"])
    template_path = resolve_from(manifest_dir, product["template"])
    if not source.is_file():
        raise PipelineError(f"找不到AI文件：{source}")
    if not template_path.is_file():
        raise PipelineError(f"找不到结构模板：{template_path}")
    with source.open("rb") as source_file:
        signature = source_file.read(4)
    pdf_compatible = signature == b"%PDF"
    use_illustrator = force_illustrator or not pdf_compatible

    template = load_json(template_path)
    code = str(product["code"])
    slug = str(product["slug"])
    project_dir = (output_root / code).resolve()
    assets_dir = project_dir / "assets"
    work_root = output_root / ".work"
    project_dir.mkdir(parents=True, exist_ok=True)
    work_root.mkdir(parents=True, exist_ok=True)

    fingerprint_extra: tuple[Path, ...] = ()
    if use_illustrator:
        if not bool(illustrator_config.get("enabled", True)):
            raise PipelineError(f"AI不是PDF兼容格式且Illustrator兜底已禁用：{source}")
        app_path = Path(
            illustrator_config.get("application", str(DEFAULT_ILLUSTRATOR_APP))
        ).expanduser().resolve()
        if sys.platform == "win32":
            if not app_path.is_file():
                raise PipelineError(f"需要Illustrator兜底，但应用不完整：{app_path}")
            # Do not hash the large Illustrator executable.  The Windows COM
            # bridge and shared JSX are already part of job_fingerprint.
        else:
            info_plist = app_path / "Contents" / "Info.plist"
            if not info_plist.is_file():
                raise PipelineError(f"需要Illustrator兜底，但应用不完整：{app_path}")
            fingerprint_extra = (info_plist,)

    illustrator_result: dict[str, Any] | None = None
    input_mode = "pdf_fast"
    full_pdf_source = source
    print_pdf_source: Path | None = None
    if use_illustrator:
        input_mode = "illustrator_fallback"
        illustrator_result = run_illustrator_fallback(
            source,
            project_dir,
            template,
            illustrator_config,
        )
        full_pdf_source = Path(illustrator_result["full_pdf"])
        print_pdf_source = Path(illustrator_result["print_pdf"])

    reader = PdfReader(str(full_pdf_source))
    if len(reader.pages) != 1:
        raise PipelineError(f"结构模板只接受单页AI，实际页数={len(reader.pages)}：{source}")
    page = reader.pages[0]
    page_size = [float(page.mediabox.width), float(page.mediabox.height)]
    layers = (
        list(illustrator_result.get("layers", []))
        if illustrator_result
        else optional_content_layers(reader)
    )
    knife = pick_knife_layer(layers)
    if knife:
        knife_pdf = project_dir / "knife.pdf"
        try:
            make_layer_pdf(full_pdf_source, knife_pdf, {knife})
            layout = parse_knife_pdf(knife_pdf, knife)
            template = layout_to_template(layout)
            template_path = knife_pdf
            save_json(project_dir / "dieline_layout.json", layout)
        except Exception as err:
            raise PipelineError(f"刀线读不出结构：{err}，文件={source}") from err
    else:
        try:
            template_path, template = pick_template(template_path, page_size, source)
        except PipelineError as err:
            raise PipelineError(
                f"稿里没有刀线或刀版层，也无法匹配已登记刀模。实际画板={page_size}，文件={source}"
            ) from err
    if "印刷" not in layers and "印刷" in template.get("required_layers", []):
        raise PipelineError(f"AI缺少必要图层['印刷']：{source}")
    missing_layers = [name for name in template.get("required_layers", []) if name not in layers]
    if missing_layers and template.get("source") != "dieline":
        raise PipelineError(f"AI缺少必要图层{missing_layers}：{source}")

    fingerprint = job_fingerprint(
        source,
        template_path,
        {
            **product,
            "die_source": template.get("source") or "registry",
            "template_id": template.get("template_id"),
            "family": template.get("family"),
            "dimensions_mm": template.get("dimensions_mm"),
        },
        extra_paths=fingerprint_extra,
    )
    result_path = project_dir / "pipeline_result.json"
    if not force and not force_illustrator and result_path.is_file():
        previous = load_json(result_path)
        outputs = previous.get("outputs", {})
        required = [outputs.get(key) for key in ("blend", "glb", "front_right", "back_left")]
        if previous.get("fingerprint") == fingerprint and all(
            value and Path(value).is_file() for value in required
        ):
            previous["cache_hit"] = True
            previous["preflight_elapsed_s"] = round(time.perf_counter() - started, 4)
            return previous

    with tempfile.TemporaryDirectory(prefix=f"{code}-", dir=work_root) as temp_name:
        temp_dir = Path(temp_name)
        if print_pdf_source is None:
            print_pdf = temp_dir / f"{code}_print_only.pdf"
            make_layer_pdf(source, print_pdf, set(template["print_layers"]))
        else:
            print_pdf = print_pdf_source
        print_png = render_pdf_thumbnail(
            print_pdf,
            temp_dir / "print",
            int(template["raster_width_px"]),
        )
        full_png = render_pdf_thumbnail(
            full_pdf_source,
            temp_dir / "full",
            int(template["raster_width_px"]),
        )
        face_sizes = crop_faces(print_png, full_png, assets_dir, template)

    resolved = {
        "pipeline_version": PIPELINE_VERSION,
        "fingerprint": fingerprint,
        "cache_hit": False,
        "code": code,
        "slug": slug,
        "display_name": product["display_name"],
        "source_ai": str(source),
        "template_path": str(template_path),
        "template_id": template["template_id"],
        "project_dir": str(project_dir),
        "assets_dir": str(assets_dir),
        "dimensions_mm": template["dimensions_mm"],
        "render": template["render"],
        "glb_tolerance_mm": template.get("glb_tolerance_mm", 0.5),
        "page_size_points": page_size,
        "layers": layers,
        "face_texture_sizes": face_sizes,
        "preflight_elapsed_s": round(time.perf_counter() - started, 4),
        "input_mode": input_mode,
        "illustrator_invoked": bool(illustrator_result),
        "illustrator_version": (
            illustrator_result.get("illustrator_version")
            if illustrator_result
            else None
        ),
        "illustrator_elapsed_s": (
            illustrator_result.get("worker_elapsed_s", 0)
            if illustrator_result
            else 0
        ),
        "normalized_full_pdf": (
            illustrator_result.get("full_pdf")
            if illustrator_result
            else None
        ),
        "normalized_print_pdf": (
            illustrator_result.get("print_pdf")
            if illustrator_result
            else None
        ),
        "assets": {
            face: str(assets_dir / f"panel_{face}.png")
            for face in ("front", "right", "back", "left", "top", "bottom")
        },
        "outputs": {
            "blend": str(project_dir / f"{code}_{slug}_white_studio.blend"),
            "glb": str(project_dir / f"{code}_{slug}.glb"),
            "front_right": str(project_dir / f"{code}_{slug}_front_right_white.png"),
            "back_left": str(project_dir / f"{code}_{slug}_back_left_white.png"),
            "front_right_ground": str(project_dir / f"{code}_{slug}_front_right_ground.png"),
            "back_left_ground": str(project_dir / f"{code}_{slug}_back_left_ground.png"),
        },
    }
    resolved_path = project_dir / "resolved_job.json"
    resolved["resolved_job_path"] = str(resolved_path)
    save_json(resolved_path, resolved)
    return resolved


def run_blender_job(job: dict[str, Any], blender_executable: Path) -> dict[str, Any]:
    if job.get("cache_hit"):
        return job
    started = time.perf_counter()
    project_dir = Path(job["project_dir"])
    log_path = project_dir / "blender.log"
    command = [
        str(blender_executable),
        "--background",
        "--factory-startup",
        "--python",
        str(BLENDER_SCRIPT),
        "--",
        job["resolved_job_path"],
    ]
    process = subprocess.run(command, capture_output=True, text=True)
    log_path.write_text(process.stdout + "\n" + process.stderr, encoding="utf-8")
    if process.returncode != 0:
        raise PipelineError(f"Blender任务失败：{job['code']}，日志={log_path}")
    # 静帧保持 RGBA 产品层。白底由打样单合成；PPT/PDF 导出时再铺白。
    if bool(job.get("render", {}).get("exact_white_background", True)):
        for key in ("front_right", "back_left"):
            output = Path(job["outputs"][key])
            if not output.is_file():
                raise PipelineError(f"Blender未生成白底图：{output}")
    blender_result_path = project_dir / "blender_result.json"
    if not blender_result_path.is_file():
        raise PipelineError(f"Blender未生成结果清单：{blender_result_path}")
    blender_result = load_json(blender_result_path)
    job.update(blender_result)
    job["blender_process_elapsed_s"] = round(time.perf_counter() - started, 4)
    return job


def resolve_node_bin() -> Path | None:
    raw = (os.environ.get("RUNTIME_NODE") or "").strip()
    if raw:
        hinted = Path(raw).expanduser()
        if hinted.is_file():
            return hinted.resolve()
    found = shutil.which("node") or shutil.which("node.exe")
    if found:
        hit = Path(found)
        if hit.is_file():
            return hit.resolve()
    for extra in WINDOWS_NODE_CANDIDATES:
        if extra.is_file():
            return extra.resolve()
    return None


def _env_dir(env_key: str, default: Path) -> Path | None:
    raw = (os.environ.get(env_key) or "").strip() or str(default).strip()
    if not raw or raw in (".",):
        return None
    path = Path(raw).expanduser()
    return path if path.exists() else None


def _usable_node_modules(path: Path) -> bool:
    if not path.is_dir():
        return False
    try:
        next(path.iterdir())
    except StopIteration:
        return False
    return True


def presentation_runtime() -> dict[str, str] | None:
    node = resolve_node_bin()
    if node is None:
        return None
    modules = _env_dir("RUNTIME_NODE_MODULES", DEFAULT_NODE_MODULES)
    bin_dir = _env_dir("RUNTIME_BIN_DIR", DEFAULT_RUNTIME_BIN)
    ppt_modules = ROOT / "ppt" / "node_modules"
    if modules is None and not _usable_node_modules(ppt_modules):
        return None
    if modules is not None and not ppt_modules.exists():
        ppt_modules.symlink_to(modules.resolve(), target_is_directory=True)
    return {
        "RUNTIME_NODE": str(node),
        "RUNTIME_NODE_MODULES": str(modules.resolve()) if modules is not None else "",
        "RUNTIME_BIN_DIR": str(bin_dir.resolve()) if bin_dir is not None else "",
    }


def mark_presentation_operation(count: int, runtime: dict[str, str]) -> None:
    marker = DEFAULT_PRESENTATION_SKILL / "container_tools" / "mark_artifact_operation_started.mjs"
    env = os.environ.copy()
    env.update(runtime)
    env.update(
        {
            "SKILL_DIR": str(DEFAULT_PRESENTATION_SKILL),
            "TMP_DIR": str(ROOT / ".runtime"),
            "FINAL_PPTX": "multiple",
        }
    )
    command = [
        runtime["RUNTIME_NODE"],
        str(marker),
        "--operation-kind",
        "create",
        "--expected-output-count",
        str(count),
        "--output-format",
        "pptx",
    ]
    process = subprocess.run(command, capture_output=True, text=True, env=env)
    if process.returncode != 0:
        raise PipelineError(f"PPT生成标记失败：{process.stdout}\n{process.stderr}")


def run_ppt_job(job: dict[str, Any], runtime: dict[str, str]) -> dict[str, Any]:
    started = time.perf_counter()
    project_dir = Path(job["project_dir"])
    pptx_path = project_dir / f"{job['code']}_{job['slug']}_3D包装展示.pptx"
    ppt_input = dict(job)
    ppt_input["pptx_path"] = str(pptx_path)
    ppt_input["qa_dir"] = str(project_dir / "ppt_qa")
    ppt_input_path = project_dir / "ppt_input.json"
    save_json(ppt_input_path, ppt_input)
    env = os.environ.copy()
    env.update(runtime)
    command = [runtime["RUNTIME_NODE"], str(PPT_SCRIPT), str(ppt_input_path)]
    process = subprocess.run(command, capture_output=True, text=True, env=env)
    (project_dir / "ppt.log").write_text(
        process.stdout + "\n" + process.stderr,
        encoding="utf-8",
    )
    if process.returncode != 0 or not pptx_path.is_file():
        raise PipelineError(f"PPT任务失败：{job['code']}，日志={project_dir / 'ppt.log'}")
    job.setdefault("outputs", {})["pptx"] = str(pptx_path)
    job["ppt_elapsed_s"] = round(time.perf_counter() - started, 4)
    return job


def _sheet_text(page: Any, origin: tuple[float, float], txt: str, size: float, color: tuple[float, float, float]) -> None:
    try:
        page.insert_text(origin, txt, fontsize=size, fontname="china-s", color=color)
    except Exception:
        try:
            page.insert_text(origin, txt, fontsize=size, fontname="helv", color=color)
        except Exception:
            page.insert_text(origin, txt.encode("ascii", "replace").decode(), fontsize=size, color=color)


def _contain_rect(
    slot: tuple[float, float, float, float], img_w: int, img_h: int
) -> tuple[float, float, float, float]:
    sl, st, sr, sb = slot
    sw, sh = sr - sl, sb - st
    if img_w <= 0 or img_h <= 0 or sw <= 0 or sh <= 0:
        return slot
    scale = min(sw / float(img_w), sh / float(img_h))
    dw, dh = img_w * scale, img_h * scale
    x = sl + (sw - dw) / 2.0
    y = st + (sh - dh) / 2.0
    return (x, y, x + dw, y + dh)


def _fit_white_rgb(path: Path, box_w: int, box_h: int):
    with Image.open(path) as src:
        if src.mode in ("RGBA", "LA"):
            im = src.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.getchannel("A"))
            im = bg
        else:
            im = src.convert("RGB")
        im.thumbnail((box_w, box_h), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (box_w, box_h), (255, 255, 255))
        canvas.paste(im, ((box_w - im.width) // 2, (box_h - im.height) // 2))
        return canvas


def _write_sheet_pdf_pillow(dest: Path, front: str, back: str | None) -> None:
    page = Image.new("RGB", (1280, 720), (255, 255, 255))
    page.paste(_fit_white_rgb(Path(front), 590, 620), (36, 68))
    if back and Path(back).is_file():
        page.paste(_fit_white_rgb(Path(back), 590, 620), (654, 68))
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".pdf.part")
    page.save(tmp, "PDF", resolution=150.0)
    tmp.replace(dest)


def write_sheet_pdf(job: dict[str, Any]) -> None:
    """两张白底合成一页 PDF。pymupdf 先（对照同一 .venv），写不出再用 Pillow。不新装包。"""
    outputs = job.setdefault("outputs", {})
    front = outputs.get("front_right")
    back = outputs.get("back_left")
    if not front or not Path(front).is_file():
        return
    dest = Path(job["project_dir"]) / f"{job.get('code') or 'pack'}_white_sheet.pdf"
    try:
        import pymupdf

        doc = pymupdf.open()
        try:
            page = doc.new_page(width=1280, height=720)
            page.draw_rect(page.rect, color=None, fill=(1, 1, 1))
            title = str(job.get("display_name") or job.get("code") or "打样单")
            _sheet_text(page, (36, 32), title[:80], 16, (0.11, 0.10, 0.12))
            _sheet_text(page, (36, 52), "正面 + 侧面", 11, (0.35, 0.35, 0.4))
            _sheet_text(page, (654, 52), "反面 + 侧面", 11, (0.35, 0.35, 0.4))
            try:
                with Image.open(front) as im:
                    fw, fh = im.size
                front_rect = pymupdf.Rect(*_contain_rect((36, 68, 626, 688), fw, fh))
            except Exception:
                front_rect = pymupdf.Rect(36, 68, 626, 688)
            page.insert_image(front_rect, stream=png_bytes_over_white(front), keep_proportion=True)
            if back and Path(back).is_file():
                try:
                    with Image.open(back) as im:
                        bw, bh = im.size
                    back_rect = pymupdf.Rect(*_contain_rect((654, 68, 1244, 688), bw, bh))
                except Exception:
                    back_rect = pymupdf.Rect(654, 68, 1244, 688)
                page.insert_image(back_rect, stream=png_bytes_over_white(back), keep_proportion=True)
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".pdf.part")
            doc.save(str(tmp))
            tmp.replace(dest)
        finally:
            doc.close()
    except Exception as err:
        if dest.is_file() and dest.stat().st_size > 0:
            print(f"打样单 PDF pymupdf 告警已落盘：{err}", file=sys.stderr)
        else:
            print(f"打样单 PDF pymupdf 失败，改用 Pillow：{err}", file=sys.stderr)
            _write_sheet_pdf_pillow(dest, str(front), str(back) if back else None)
    if dest.is_file() and dest.stat().st_size > 0:
        outputs["sheet_pdf"] = str(dest)


def _xml_text(value: str) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def write_white_pptx(front: Path, back: Path, dest: Path, title: str = "") -> Path:
    """Two white PNGs → one OOXML pptx. No Node, no env, no ppt/node_modules."""
    front = Path(front)
    back = Path(back)
    if not front.is_file() or not back.is_file():
        raise PipelineError("缺白底图，PPT 写不出")
    def png_magic(path: Path) -> bool:
        with path.open("rb") as handle:
            return handle.read(8) == b"\x89PNG\r\n\x1a\n"

    if not png_magic(front) or not png_magic(back):
        raise PipelineError("白底不是 PNG，PPT 写不出")
    front_bytes = png_bytes_over_white(front)
    back_bytes = png_bytes_over_white(back)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    heading = _xml_text((title or dest.stem)[:80])
    emu = 9525
    slide_w, slide_h = 1280 * emu, 720 * emu
    # 16:9 一页两张：正面+侧面、反面+侧面
    parts: dict[str, bytes] = {
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>
""".encode("utf-8"),
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>
""".encode("utf-8"),
        "ppt/presentation.xml": f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
<p:sldSz cx="{slide_w}" cy="{slide_h}"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>
""".encode("utf-8"),
        "ppt/_rels/presentation.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>
""".encode("utf-8"),
        "ppt/slides/_rels/slide1.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/>
</Relationships>
""".encode("utf-8"),
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>
""".encode("utf-8"),
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>
""".encode("utf-8"),
        "ppt/theme/theme1.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
<a:themeElements>
<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1C1A1F"/></a:dk2><a:lt2><a:srgbClr val="F8F5FA"/></a:lt2><a:accent1><a:srgbClr val="805898"/></a:accent1><a:accent2><a:srgbClr val="C9A3D6"/></a:accent2><a:accent3><a:srgbClr val="389E0D"/></a:accent3><a:accent4><a:srgbClr val="D48806"/></a:accent4><a:accent5><a:srgbClr val="F5222D"/></a:accent5><a:accent6><a:srgbClr val="3370FF"/></a:accent6><a:hlink><a:srgbClr val="805898"/></a:hlink><a:folHlink><a:srgbClr val="805898"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Office"><a:majorFont><a:latin typeface="PingFang SC"/><a:ea typeface="PingFang SC"/><a:cs typeface="PingFang SC"/></a:majorFont><a:minorFont><a:latin typeface="PingFang SC"/><a:ea typeface="PingFang SC"/><a:cs typeface="PingFang SC"/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements>
</a:theme>
""".encode("utf-8"),
        "ppt/slideMasters/slideMaster1.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>
""".encode("utf-8"),
        "ppt/slideLayouts/slideLayout1.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>
""".encode("utf-8"),
    }

    def pic(rid: str, name: str, pid: int, x: int, y: int, w: int, h: int) -> str:
        return f"""<p:pic>
<p:nvPicPr><p:cNvPr id="{pid}" name="{name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="{x * emu}" y="{y * emu}"/><a:ext cx="{w * emu}" cy="{h * emu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>"""

    def box(pid: int, name: str, text: str, x: int, y: int, w: int, h: int, size: int) -> str:
        return f"""<p:sp>
<p:nvSpPr><p:cNvPr id="{pid}" name="{name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="{x * emu}" y="{y * emu}"/><a:ext cx="{w * emu}" cy="{h * emu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="zh-CN" sz="{size * 100}"/><a:t>{text}</a:t></a:r></a:p></p:txBody>
</p:sp>"""

    parts["ppt/slides/slide1.xml"] = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
{box(2, "title", heading, 36, 20, 1208, 36, 18)}
{box(3, "front-caption", "正面 + 侧面", 36, 56, 590, 24, 12)}
{box(4, "back-caption", "反面 + 侧面", 654, 56, 590, 24, 12)}
{pic("rId2", "front-right-render", 5, 36, 88, 590, 580)}
{pic("rId3", "back-left-render", 6, 654, 88, 590, 580)}
</p:spTree></p:cSld>
</p:sld>
""".encode("utf-8")

    tmp = dest.with_suffix(".pptx.part")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in parts.items():
            zf.writestr(name, data)
        zf.writestr("ppt/media/image1.png", front_bytes)
        zf.writestr("ppt/media/image2.png", back_bytes)
    tmp.replace(dest)
    return dest


def write_white_pptx_for_job(job: dict[str, Any]) -> None:
    outputs = job.setdefault("outputs", {})
    front = outputs.get("front_right")
    back = outputs.get("back_left")
    if not front or not back:
        raise PipelineError("缺白底图，PPT 写不出")
    dest = Path(job["project_dir"]) / f"{job.get('code') or 'pack'}_{job.get('slug') or 'pack'}_3D包装展示.pptx"
    write_white_pptx(
        Path(front),
        Path(back),
        dest,
        title=str(job.get("display_name") or job.get("code") or "打样单"),
    )
    outputs["pptx"] = str(dest)


def all_output_files_exist(job: dict[str, Any], generate_ppt: bool) -> bool:
    outputs = job.get("outputs", {})
    keys = ["blend", "glb", "front_right", "back_left"]
    _ = generate_ppt  # PPT 尽力写；缺 pptx 不把整单打红。
    return all(outputs.get(key) and Path(outputs[key]).is_file() for key in keys)


def main() -> int:
    parser = argparse.ArgumentParser(description="AI包装稿并行3D/PPT生产流水线")
    parser.add_argument("manifest", type=Path, help="任务清单JSON")
    parser.add_argument("--workers", type=int, default=None, help="Blender并行Worker数量")
    parser.add_argument("--force", action="store_true", help="忽略缓存重新生成")
    parser.add_argument(
        "--force-illustrator",
        action="store_true",
        help="诊断用：即使AI包含PDF数据也强制走Illustrator标准化",
    )
    parser.add_argument("--no-ppt", action="store_true", help="跳过PPT生成")
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help="只做结构、贴图和作业预检，不启动 Blender/PPT",
    )
    args = parser.parse_args()

    pipeline_started = time.perf_counter()
    manifest_path = args.manifest.expanduser().resolve()
    manifest = load_json(manifest_path)
    manifest_dir = manifest_path.parent
    output_root = resolve_from(manifest_dir, manifest["output_root"])
    output_root.mkdir(parents=True, exist_ok=True)
    products = manifest.get("products", [])
    if not products:
        raise PipelineError("任务清单没有products")
    codes = [str(product["code"]) for product in products]
    if len(codes) != len(set(codes)):
        raise PipelineError("任务清单中的产品code不能重复")

    workers = max(1, int(args.workers or manifest.get("workers", 2)))
    workers = min(workers, len(products))
    blender_executable = resolve_from(manifest_dir, manifest.get("blender_executable", "blender"))
    if not args.preflight_only and not blender_executable.is_file():
        raise PipelineError(f"找不到Blender：{blender_executable}")
    generate_ppt = bool(manifest.get("generate_ppt", True)) and not args.no_ppt
    illustrator_config = manifest.get("illustrator", {"enabled": True})

    if args.preflight_only:
        emit_stage("structure")
    else:
        emit_stage("render_pdf")
    jobs = [
        preflight_product(
            product,
            manifest_dir,
            output_root,
            args.force,
            illustrator_config,
            args.force_illustrator,
        )
        for product in products
    ]

    if args.preflight_only:
        elapsed = round(time.perf_counter() - pipeline_started, 4)
        prepared_manifest = deepcopy(manifest)
        prepared_products: list[dict[str, Any]] = []
        for product, job in zip(products, jobs):
            prepared = dict(product)
            if job.get("structure_engine") == "v2":
                prepared["structure_sidecar"] = job["normalized_structure_sidecar"]
                prepared["artwork_pdf"] = job["normalized_print_pdf"]
            prepared_products.append(prepared)
        prepared_manifest["products"] = prepared_products
        prepared_path = output_root / "prepared_manifest.json"
        save_json(prepared_path, prepared_manifest)
        report = {
            "pipeline_version": PIPELINE_VERSION,
            "mode": "preflight",
            "manifest": str(manifest_path),
            "products": jobs,
            "prepared_manifest": str(prepared_path),
            "elapsed_s": elapsed,
            "success": True,
        }
        save_json(output_root / "preflight_report.json", report)
        print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
        return 0

    blender_jobs = [job for job in jobs if not job.get("cache_hit")]
    if blender_jobs:
        emit_stage("blender")
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(run_blender_job, job, blender_executable): job["code"]
                for job in blender_jobs
            }
            completed = []
            for future in concurrent.futures.as_completed(futures):
                completed.append(future.result())
        completed_by_code = {job["code"]: job for job in completed}
        jobs = [completed_by_code.get(job["code"], job) for job in jobs]

    for job in jobs:
        try:
            write_sheet_pdf(job)
        except Exception as err:
            print(f"打样单 PDF 跳过：{err}", file=sys.stderr)
            job["sheet_skip"] = str(err)

    if generate_ppt:
        emit_stage("export")
        for job in jobs:
            try:
                write_white_pptx_for_job(job)
            except Exception as err:
                print(f"PPT 跳过：{err}", file=sys.stderr)
                job["ppt_skip"] = str(err)
        ppt_jobs = [job for job in jobs if not (job.get("outputs") or {}).get("pptx")]
        runtime = presentation_runtime() if ppt_jobs else None
        if runtime is not None:
            try:
                mark_presentation_operation(len(ppt_jobs), runtime)
                with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                    futures = {pool.submit(run_ppt_job, job, runtime): job["code"] for job in ppt_jobs}
                    completed_ppt = [future.result() for future in concurrent.futures.as_completed(futures)]
                completed_by_code = {job["code"]: job for job in completed_ppt}
                jobs = [completed_by_code.get(job["code"], job) for job in jobs]
            except Exception as err:
                print(f"PPT 跳过：{err}", file=sys.stderr)

    pipeline_elapsed = round(time.perf_counter() - pipeline_started, 4)
    for job in jobs:
        job["cache_hit"] = bool(job.get("cache_hit", False))
        save_json(Path(job["project_dir"]) / "pipeline_result.json", job)

    success = all(all_output_files_exist(job, generate_ppt) for job in jobs)
    report = {
        "pipeline_version": PIPELINE_VERSION,
        "manifest": str(manifest_path),
        "workers": workers,
        "generate_ppt": generate_ppt,
        "illustrator_enabled": bool(illustrator_config.get("enabled", True)),
        "force_illustrator": args.force_illustrator,
        "products": jobs,
        "elapsed_s": pipeline_elapsed,
        "sla_seconds": 600,
        "sla_pass": pipeline_elapsed <= 600 and success,
        "success": success,
    }
    report_path = output_root / "pipeline_report.json"
    save_json(report_path, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if success else 1


def _err_json(msg: object) -> None:
    if isinstance(msg, PipelineError):
        payload = msg.as_dict()
    else:
        text = str(msg).strip()[:80] or "打样中断"
        payload = {"ok": False, "error": text}
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), file=sys.stderr)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PipelineHold as hold:
        print(json.dumps(hold.as_dict(), ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
        raise SystemExit(3)
    except PipelineError as error:
        _err_json(error)
        raise SystemExit(2)
    except Exception as error:
        _err_json(error)
        raise SystemExit(2)
