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


PIPELINE_VERSION = "1.2.1"
ROOT = Path(__file__).resolve().parent
BLENDER_SCRIPT = ROOT / "blender" / "render_job.py"
PPT_SCRIPT = ROOT / "ppt" / "build_product_ppt.mjs"
ILLUSTRATOR_WORKER = ROOT / "illustrator" / "illustrator_worker.py"
ILLUSTRATOR_JSX = ROOT / "illustrator" / "export_ai.jsx"
ILLUSTRATOR_RUNNER = ROOT / "illustrator" / "run_export.applescript"

DEFAULT_NODE = Path(os.environ.get("RUNTIME_NODE", "node"))
DEFAULT_NODE_MODULES = Path(os.environ.get("RUNTIME_NODE_MODULES", ""))
DEFAULT_RUNTIME_BIN = Path(os.environ.get("RUNTIME_BIN_DIR", ""))
DEFAULT_PRESENTATION_SKILL = Path(os.environ.get("PRESENTATION_SKILL_DIR", ""))
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
        *extra_paths,
    ):
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


def crop_faces(print_png: Path, full_png: Path, assets_dir: Path, template: dict[str, Any]) -> dict[str, list[int]]:
    reference_width = float(template["reference_width_px"])
    panel_x = template["panel_x"]
    body_top = template["body_top"]
    body_bottom = template["body_bottom"]
    face_sources = template.get("face_sources", {})
    inset = int(template.get("composite_inset_reference_px", 0))
    face_ranges = {
        "back": (panel_x[0], panel_x[1]),
        "left": (panel_x[1], panel_x[2]),
        "front": (panel_x[2], panel_x[3]),
        "right": (panel_x[3], panel_x[4]),
    }
    assets_dir.mkdir(parents=True, exist_ok=True)
    sizes: dict[str, list[int]] = {}
    with Image.open(print_png).convert("RGB") as print_image, Image.open(full_png).convert("RGB") as full_image:
        if print_image.size != full_image.size:
            raise PipelineError(
                f"印刷层与合成图尺寸不一致：{print_image.size} vs {full_image.size}"
            )
        scale = print_image.width / reference_width
        for face, (x0, x1) in face_ranges.items():
            source_image = full_image if face_sources.get(face) == "composite" else print_image
            face_inset = inset if face_sources.get(face) == "composite" else 0
            box = (
                x0 + face_inset,
                body_top + face_inset,
                x1 - face_inset,
                body_bottom - face_inset,
            )
            crop = source_image.crop(scaled_box(box, scale))
            output = assets_dir / f"panel_{face}.png"
            crop.save(output, compress_level=3)
            sizes[face] = list(crop.size)

        top = print_image.crop(scaled_box(template["top_lid"], scale))
        top_output = assets_dir / "panel_top.png"
        top.save(top_output, compress_level=3)
        sizes["top"] = list(top.size)

        bottom_size = max(top.width, top.height)
        bottom = Image.new("RGB", (bottom_size, bottom_size), (248, 248, 247))
        bottom_output = assets_dir / "panel_bottom.png"
        bottom.save(bottom_output, compress_level=3)
        sizes["bottom"] = list(bottom.size)
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
    fingerprint = job_fingerprint(
        source,
        template_path,
        product,
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
    expected = template["expected_page_points"]
    tolerance = float(template.get("page_size_tolerance_ratio", 0.02))
    for actual, wanted in zip(page_size, expected):
        if abs(actual - wanted) / wanted > tolerance:
            raise PipelineError(
                f"AI画板尺寸与模板不符：实际={page_size}，模板={expected}，文件={source}"
            )
    layers = (
        list(illustrator_result.get("layers", []))
        if illustrator_result
        else optional_content_layers(reader)
    )
    missing_layers = [name for name in template.get("required_layers", []) if name not in layers]
    if missing_layers:
        raise PipelineError(f"AI缺少必要图层{missing_layers}：{source}")

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


def presentation_runtime() -> dict[str, str]:
    node = Path(os.environ.get("RUNTIME_NODE", str(DEFAULT_NODE))).resolve()
    modules = Path(os.environ.get("RUNTIME_NODE_MODULES", str(DEFAULT_NODE_MODULES))).resolve()
    bin_dir = Path(os.environ.get("RUNTIME_BIN_DIR", str(DEFAULT_RUNTIME_BIN))).resolve()
    for label, path in (("Node", node), ("Node modules", modules), ("Runtime bin", bin_dir)):
        if not path.exists():
            raise PipelineError(f"{label}不存在：{path}")
    node_modules_link = ROOT / "ppt" / "node_modules"
    if not node_modules_link.exists():
        node_modules_link.symlink_to(modules, target_is_directory=True)
    return {
        "RUNTIME_NODE": str(node),
        "RUNTIME_NODE_MODULES": str(modules),
        "RUNTIME_BIN_DIR": str(bin_dir),
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


def all_output_files_exist(job: dict[str, Any], generate_ppt: bool) -> bool:
    outputs = job.get("outputs", {})
    keys = ["blend", "glb", "front_right", "back_left"]
    if generate_ppt:
        keys.append("pptx")
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

    if generate_ppt:
        runtime = presentation_runtime()
        ppt_jobs = [
            job
            for job in jobs
            if not job.get("outputs", {}).get("pptx")
            or not Path(job["outputs"]["pptx"]).is_file()
            or args.force
            or args.force_illustrator
        ]
        if ppt_jobs:
            emit_stage("export")
            mark_presentation_operation(len(ppt_jobs), runtime)
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                futures = {
                    pool.submit(run_ppt_job, job, runtime): job["code"]
                    for job in ppt_jobs
                }
                completed_ppt = []
                for future in concurrent.futures.as_completed(futures):
                    completed_ppt.append(future.result())
            completed_by_code = {job["code"]: job for job in completed_ppt}
            jobs = [completed_by_code.get(job["code"], job) for job in jobs]

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
