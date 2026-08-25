#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
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


PIPELINE_VERSION = "1.3.1"
MAX_RASTER_PIXELS = 32_000_000
ROOT = Path(__file__).resolve().parent
BLENDER_SCRIPT = ROOT / "blender" / "render_job.py"
PPT_SCRIPT = ROOT / "ppt" / "build_product_ppt.mjs"
ILLUSTRATOR_WORKER = ROOT / "illustrator" / "illustrator_worker.py"
ILLUSTRATOR_JSX = ROOT / "illustrator" / "export_ai.jsx"
ILLUSTRATOR_RUNNER = ROOT / "illustrator" / "run_export.applescript"
DIELINE_SCRIPT = ROOT / "dieline.py"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from dieline import PT_TO_MM, layout_to_template, parse_knife_pdf, pick_knife_layer  # noqa: E402

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
    pass


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


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
        ILLUSTRATOR_RUNNER,
        DIELINE_SCRIPT,
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
    if not app_path.is_dir():
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
    }
    save_json(config_path, worker_config)
    timeout_seconds = int(illustrator_config.get("timeout_seconds", 180))
    command = [
        sys.executable,
        str(ILLUSTRATOR_WORKER),
        str(config_path),
        "--timeout",
        str(timeout_seconds),
    ]
    process = subprocess.run(command, capture_output=True, text=True)
    log_path.write_text(process.stdout + "\n" + process.stderr, encoding="utf-8")
    if process.returncode != 0 or not result_path.is_file():
        raise PipelineError(f"Illustrator标准化失败，日志={log_path}")
    result = load_json(result_path)
    if not result.get("success"):
        raise PipelineError(f"Illustrator标准化失败：{result.get('error')}，日志={log_path}")
    return result


def preflight_product(
    product: dict[str, Any],
    manifest_dir: Path,
    output_root: Path,
    force: bool,
    illustrator_config: dict[str, Any],
    force_illustrator: bool,
) -> dict[str, Any]:
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


def _fit_white_rgb(path: Path, box_w: int, box_h: int):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        alpha = im.getchannel("A") if "A" in im.getbands() else None
        bg.paste(im.convert("RGBA"), mask=alpha)
        im = bg
    else:
        im = im.convert("RGB")
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
            page.insert_image(pymupdf.Rect(36, 68, 626, 688), stream=Path(front).read_bytes(), keep_proportion=True)
            if back and Path(back).is_file():
                page.insert_image(pymupdf.Rect(654, 68, 1244, 688), stream=Path(back).read_bytes(), keep_proportion=True)
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".pdf.part")
            doc.save(str(tmp))
            tmp.replace(dest)
        finally:
            doc.close()
    except Exception:
        _write_sheet_pdf_pillow(dest, str(front), str(back) if back else None)
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
    front_bytes = front.read_bytes()
    back_bytes = back.read_bytes()
    if front_bytes[:8] != b"\x89PNG\r\n\x1a\n" or back_bytes[:8] != b"\x89PNG\r\n\x1a\n":
        raise PipelineError("白底不是 PNG，PPT 写不出")
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
    blender_executable = resolve_from(
        manifest_dir,
        manifest.get("blender_executable", "blender"),
    )
    if not blender_executable.is_file():
        raise PipelineError(f"找不到Blender：{blender_executable}")
    generate_ppt = bool(manifest.get("generate_ppt", True)) and not args.no_ppt
    illustrator_config = manifest.get("illustrator", {"enabled": True})

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
    text = str(msg).strip()[:80] or "打样中断"
    print(json.dumps({"ok": False, "error": text}, ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PipelineError as error:
        _err_json(error)
        raise SystemExit(2)
    except Exception as error:
        _err_json(error)
        raise SystemExit(2)
