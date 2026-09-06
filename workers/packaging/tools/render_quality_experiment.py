#!/usr/bin/env python3
"""RF-E02 lighting experiment driver.

Observes current packaging stills under control vs normalized-rig-v1. Does not
change product renderer, pipeline, RF-00, RF-E01, UI, or defaults. Importing
this module must not create directories, call Blender, change the environment,
or write results.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

WRAPPER_NAME = "render_quality_experiment_blender.py"
PACKAGING_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGING_ROOT.parents[1]
WRAPPER_PATH = Path(__file__).resolve().parent / WRAPPER_NAME
PIPELINE_PATH = PACKAGING_ROOT / "pipeline.py"
RENDER_JOB_PATH = PACKAGING_ROOT / "blender" / "render_job.py"
CAMERA_FRAME_PATH = PACKAGING_ROOT / "camera_frame.py"
RENDER_CONTRACT_PATH = PACKAGING_ROOT / "render_contract.py"
EVAL_PATH = Path(__file__).resolve().parent / "render_quality_eval.py"
DECLARATION_PATH = (
    PACKAGING_ROOT / "fixtures" / "render-quality" / "experiments" / "rfe02-lighting.json"
)
VERSION_PATH = REPO_ROOT / "VERSION"
RF00_BASELINE = PACKAGING_ROOT / "fixtures" / "render-quality" / "baselines" / "rf00-current.json"
BACKEND_DATA = REPO_ROOT / "apps" / "web" / "backend" / "data"
HANGZHOU_DATA = Path(r"C:\supply\data")
DATA_DIR_ENV = "WB_" + "DATA_DIR"
ENV_JOB = "BEIAN_RFE02_JOB"
TEMP_PREFIX = "beian-rfe02-"
JOB_TIMEOUT_S = 180
ROUND_TIMEOUT_S = 1800
PLAN_SCHEMA = "beian-rfe02-plan/1"
REPORT_SCHEMA = "beian-rfe02-report/1"
DECLARATION_SCHEMA = "beian-rfe02-experiment/1"
CONTACT_CELL = (480, 576)
WHITE_OBSERVE = (255, 255, 255, 255)
SHEET_BG = (228, 228, 232, 255)
REQUIRED_STILLS = (
    "front_right",
    "back_left",
    "front_right_ground",
    "back_left_ground",
    "front_right_set",
    "back_left_set",
)
FIXED_ROOT_FILES = (
    "declaration.json",
    "declaration.sha256",
    "plan.json",
    "report.json",
    "contact-sheet.png",
    "contact-sheet-white-observation.png",
    "type-frequency-chain.json",
)


def _load_wrapper() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_rfe02_wrapper", WRAPPER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load wrapper: {WRAPPER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_WRAPPER = None


def wrapper_module() -> Any:
    global _WRAPPER
    if _WRAPPER is None:
        _WRAPPER = _load_wrapper()
    return _WRAPPER


def _eval_module() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_render_quality_eval_rfe02", EVAL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load RF-00 evaluator: {EVAL_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_pipeline() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_pipeline_rfe02", PIPELINE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load pipeline: {PIPELINE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_declaration(path: Path | None = None) -> dict[str, Any]:
    wrap = wrapper_module()
    target = Path(path or DECLARATION_PATH).resolve()
    payload = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schema") != DECLARATION_SCHEMA:
        raise wrap.ExperimentError("invalid RF-E02 experiment declaration")
    if payload.get("candidate") != wrap.VARIANT_NORMALIZED:
        raise wrap.ExperimentError("only normalized-rig-v1 is accepted")
    variants = payload.get("variants")
    if list(variants) != [wrap.VARIANT_CONTROL, wrap.VARIANT_NORMALIZED]:
        raise wrap.ExperimentError("declaration variants must be control then normalized-rig-v1")
    suites = payload.get("suites")
    if not isinstance(suites, dict) or "smoke" not in suites or "matrix" not in suites:
        raise wrap.ExperimentError("declaration must define smoke and matrix suites")
    return payload


def suite_jobs(declaration: Mapping[str, Any], suite: str) -> list[dict[str, str]]:
    wrap = wrapper_module()
    if suite not in {"smoke", "matrix"}:
        raise wrap.ExperimentError("suite must be smoke or matrix")
    fixture_ids = list(declaration["suites"][suite])
    jobs = []
    for fixture_id in fixture_ids:
        for variant in (wrap.VARIANT_CONTROL, wrap.VARIANT_NORMALIZED):
            jobs.append({"fixture_id": fixture_id, "variant": variant})
    return jobs


def collect_experiment_identity() -> dict[str, Any]:
    wrap = wrapper_module()
    return {
        "driver_sha256": sha256_file(Path(__file__).resolve()),
        "wrapper_sha256": sha256_file(WRAPPER_PATH),
        "declaration_sha256": sha256_file(DECLARATION_PATH),
        "render_job_sha256": sha256_file(RENDER_JOB_PATH),
        "pipeline_sha256": sha256_file(PIPELINE_PATH),
        "camera_frame_sha256": sha256_file(CAMERA_FRAME_PATH),
        "render_contract_sha256": sha256_file(RENDER_CONTRACT_PATH),
        "glb_verify_sha256": sha256_file(PACKAGING_ROOT / "glb_verify.py"),
        "version": VERSION_PATH.read_text(encoding="utf-8").strip() if VERSION_PATH.is_file() else None,
        "version_sha256": sha256_file(VERSION_PATH) if VERSION_PATH.is_file() else None,
        "product_default_semantics": wrap.VARIANT_CONTROL,
    }


def _resolve(path: Path | str) -> Path:
    return Path(path).expanduser().resolve(strict=False)


def _is_within(path: Path, root: Path) -> bool:
    resolved = _resolve(path)
    base = _resolve(root)
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
    return _resolve(raw)


def conventional_data_roots() -> tuple[Path, ...]:
    roots = [BACKEND_DATA, HANGZHOU_DATA]
    configured = _configured_data_dir()
    if configured is not None:
        roots.append(configured)
    return tuple(roots)


def assert_experiment_root_allowed(path: Path | str) -> Path:
    wrap = wrapper_module()
    resolved = _resolve(path)
    try:
        result = subprocess.run(
            ['git', '-C', str(REPO_ROOT), 'worktree', 'list', '--porcelain', '-z'],
            capture_output=True, check=True, timeout=5,
        )
        roots = [Path(os.fsdecode(item[9:])) for item in result.stdout.split(b'\0')
                 if item.startswith(b'worktree ')]
        if not roots:
            raise ValueError('empty worktree inventory')
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise wrap.ExperimentError('worktree_inventory_unavailable') from error
    if any(_is_within(resolved, root) for root in [REPO_ROOT, *roots]):
        raise wrap.ExperimentError("experiment root must not be inside a repository worktree")
    if any((parent / '.git').exists() for parent in (resolved, *resolved.parents)):
        raise wrap.ExperimentError("experiment root must not be inside a repository worktree")
    if _has_marker(resolved, ("apps", "web", "backend", "data")):
        raise wrap.ExperimentError("experiment root must not point at the product task data directory")
    for root in conventional_data_roots():
        if _is_within(resolved, root):
            raise wrap.ExperimentError("experiment root must not point at a product data root")
    return resolved


def create_experiment_root() -> Path:
    wrap = wrapper_module()
    assert_experiment_root_allowed(Path(tempfile.gettempdir()))
    raw = tempfile.mkdtemp(prefix=TEMP_PREFIX)
    root = Path(raw)
    try:
        return assert_experiment_root_allowed(root)
    except wrap.ExperimentError:
        try:
            if root.is_dir() and next(root.iterdir(), None) is None:
                root.rmdir()
        except OSError:
            pass
        raise


def write_declaration_copy(root: Path, declaration: Mapping[str, Any]) -> tuple[Path, str]:
    dest = root / "declaration.json"
    dest.write_text(canonical_dumps(declaration) + "\n", encoding="utf-8")
    digest = sha256_file(dest)
    (root / "declaration.sha256").write_text(digest + "\n", encoding="utf-8")
    return dest, digest


def build_plan(suite: str, *, render: bool) -> dict[str, Any]:
    wrap = wrapper_module()
    declaration = load_declaration()
    jobs = suite_jobs(declaration, suite)
    return {
        "schema": PLAN_SCHEMA,
        "ok": True,
        "suite": suite,
        "render": render,
        "jobs": jobs,
        "job_count": len(jobs),
        "experimental_scene_override": {
            wrap.VARIANT_CONTROL: False,
            wrap.VARIANT_NORMALIZED: True,
        },
        "product_default_semantics": wrap.VARIANT_CONTROL,
        "candidate_is_product_profile": False,
        "quality_improvement": wrap.NOT_ASSESSED,
        "note": "dry-run emits plan JSON only; --render uses a new private temp root",
    }


@contextmanager
def experiment_runtime(pipeline: Any, envelope_path: Path, round_deadline: float) -> Any:
    wrap = wrapper_module()
    original_script = pipeline.BLENDER_SCRIPT
    original_run = pipeline.subprocess.run
    previous_env = os.environ.get(ENV_JOB)

    def patched_run(*args: Any, **kwargs: Any) -> Any:
        if "timeout" not in kwargs:
            remaining = round_deadline - time.monotonic()
            if remaining <= 0:
                raise wrap.ExperimentError("experiment_round_timeout")
            kwargs["timeout"] = min(float(JOB_TIMEOUT_S), remaining)
        try:
            return original_run(*args, **kwargs)
        except subprocess.TimeoutExpired as error:
            raise wrap.ExperimentError("blender_job_timeout") from error

    pipeline.BLENDER_SCRIPT = WRAPPER_PATH
    pipeline.subprocess.run = patched_run
    os.environ[ENV_JOB] = str(envelope_path)
    try:
        yield
    finally:
        pipeline.BLENDER_SCRIPT = original_script
        pipeline.subprocess.run = original_run
        if previous_env is None:
            os.environ.pop(ENV_JOB, None)
        else:
            os.environ[ENV_JOB] = previous_env


def resolve_blender(explicit: Path | None, eval_mod: Any) -> tuple[Path | None, str | None]:
    path = eval_mod.resolve_blender_executable(explicit)
    if path is None:
        return None, eval_mod.blender_unavailable_reason(explicit)
    return path, None


def pixel_sha256(path: Path) -> str | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(path) as opened:
            decoded = opened.convert("RGBA")
            digest = hashlib.sha256()
            digest.update(f"RGBA:{decoded.size[0]}x{decoded.size[1]}:".encode("ascii"))
            digest.update(decoded.tobytes())
            return digest.hexdigest()
    except OSError:
        return None


def image_size(path: Path) -> list[int] | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(path) as opened:
            return [int(opened.size[0]), int(opened.size[1])]
    except OSError:
        return None


def contain_size(src: tuple[int, int], cell: tuple[int, int]) -> tuple[int, int, float]:
    width, height = src
    cell_w, cell_h = cell
    if width <= 0 or height <= 0:
        return 1, 1, 1.0
    scale = min(cell_w / float(width), cell_h / float(height), 1.0)
    return max(1, int(round(width * scale))), max(1, int(round(height * scale))), scale


def write_contact_sheet(
    rows: Sequence[tuple[str, Path | None, Path | None, tuple[int, int] | None, tuple[int, int] | None]],
    dest: Path,
    *,
    white_observe: bool = False,
) -> dict[str, Any]:
    wrap = wrapper_module()
    from PIL import Image, ImageDraw

    if dest.exists():
        raise wrap.ExperimentError("contact sheet target must be new")
    cell_w, cell_h = CONTACT_CELL
    label_h = 28
    tile_w, tile_h = cell_w, cell_h + label_h
    if not rows:
        return wrap.unavailable("no_stills_for_contact_sheet", method="PIL contain contact sheet")
    sheet = Image.new("RGBA", (tile_w * 2, tile_h * len(rows)), SHEET_BG)
    draw = ImageDraw.Draw(sheet)
    used = False
    for row_index, (fixture_id, control_path, candidate_path, control_size, candidate_size) in enumerate(rows):
        for col, path, size, variant in (
            (0, control_path, control_size, "control"),
            (1, candidate_path, candidate_size, "normalized-rig-v1"),
        ):
            origin_x = col * tile_w
            origin_y = row_index * tile_h
            draw.rectangle((origin_x, origin_y, origin_x + tile_w, origin_y + tile_h), fill=SHEET_BG)
            src_w, src_h = size if size else (0, 0)
            label = f"{fixture_id} {variant} {src_w}x{src_h}"
            draw.text((origin_x + 8, origin_y + 6), label, fill=(20, 20, 20, 255))
            if path is None or not path.is_file() or not size:
                continue
            with Image.open(path) as opened:
                image = opened.convert("RGBA")
                if white_observe:
                    canvas = Image.new("RGBA", image.size, WHITE_OBSERVE)
                    canvas.alpha_composite(image)
                    image = canvas
                fitted_w, fitted_h, scale = contain_size(image.size, CONTACT_CELL)
                if scale < 1.0:
                    image = image.resize((fitted_w, fitted_h), Image.Resampling.LANCZOS)
                else:
                    fitted_w, fitted_h = image.size
                paste_x = origin_x + (cell_w - fitted_w) // 2
                paste_y = origin_y + label_h + (cell_h - fitted_h) // 2
                sheet.alpha_composite(image, (paste_x, paste_y))
                used = True
    if not used:
        return wrap.unavailable("no_readable_stills", method="PIL contain contact sheet")
    handle, temp_name = tempfile.mkstemp(prefix=".rfe02-contact.", suffix=".png", dir=str(dest.parent))
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
    return wrap.measured(str(dest), None, "equal-cell contain A/B contact sheet; no upscale")


def copy_originals(job_dir: Path, dest: Path, outputs: Mapping[str, Any]) -> dict[str, str]:
    dest.mkdir(parents=True, exist_ok=True)
    copied: dict[str, str] = {}
    for key in REQUIRED_STILLS:
        raw = outputs.get(key)
        if not raw:
            continue
        source = Path(str(raw))
        if not source.is_file():
            continue
        target = dest / f"{key}.png"
        shutil.copyfile(source, target)
        copied[key] = str(target)
    return copied


def mm_to_px_roi(
    roi_mm: Sequence[float],
    size_mm: tuple[float, float],
    size_px: tuple[int, int],
) -> dict[str, Any]:
    left, top, right, bottom = (float(value) for value in roi_mm)
    face_w, face_h = size_mm
    width, height = size_px
    x0 = int(round(left / face_w * width))
    y0 = int(round(top / face_h * height))
    x1 = int(round(right / face_w * width))
    y1 = int(round(bottom / face_h * height))
    x0 = max(0, min(x0, width - 1))
    y0 = max(0, min(y0, height - 1))
    x1 = max(x0 + 1, min(x1, width))
    y1 = max(y0 + 1, min(y1, height))
    return {
        "crop_px": [x0, y0, x1, y1],
        "crop_size_px": [x1 - x0, y1 - y0],
        "px_per_mm": [width / face_w if face_w else None, height / face_h if face_h else None],
    }


def type_frequency_chain(
    spec: Mapping[str, Any],
    *,
    artwork_pdf: Path | None,
    panel: Path | None,
    full: Path | None,
    card: Path | None,
    eval_mod: Any,
) -> dict[str, Any]:
    wrap = wrapper_module()
    if spec.get("artwork", {}).get("pattern") != "type_frequency":
        return {
            "status": "not_applicable",
            "readability": wrap.NOT_ASSESSED,
            "barcode_scannability": wrap.NOT_ASSESSED,
        }
    dims = spec["dimensions_mm"]
    face_w = float(dims["width"])
    face_h = float(dims["height"])
    rois = spec.get("artwork", {}).get("type_roi_mm") or eval_mod.type_roi_mm(face_w, face_h)
    chain: dict[str, Any] = {
        "roi_mm": rois,
        "readability": wrap.NOT_ASSESSED,
        "barcode_scannability": wrap.NOT_ASSESSED,
        "find_edges_not_used_as_acceptance": True,
        "browser": {"status": "not_measured", "reason": "deferred_to_e02_c"},
        "font_mapping": {"status": "not_measured", "reason": "unknown_browser_font_mapping"},
    }
    if artwork_pdf is not None and artwork_pdf.is_file():
        import pymupdf

        document = pymupdf.open(artwork_pdf)
        try:
            page = document[0]
            page_w_mm = float(page.rect.width) / eval_mod.MM_TO_PT
            page_h_mm = float(page.rect.height) / eval_mod.MM_TO_PT
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
            # RF-00 synthetic ROIs are face-local; the PDF contains the whole net.
            front = eval_mod.carton_net_rectangles(face_w, float(dims["depth"]), face_h)["front"]
            page_rois = {
                name: [roi[0] + front[0], roi[1] + front[1], roi[2] + front[0], roi[3] + front[1]]
                for name, roi in rois.items()
            }
            chain["pdf"] = {
                "raster_purpose": "diagnostic_only_not_pipeline_input",
                "front_origin_mm": [front[0], front[1]],
                "page_roi_mm": page_rois,
                "page_mm": [page_w_mm, page_h_mm],
                "raster_px": [int(pixmap.width), int(pixmap.height)],
                "px_per_mm": [
                    pixmap.width / page_w_mm if page_w_mm else None,
                    pixmap.height / page_h_mm if page_h_mm else None,
                ],
                "text": mm_to_px_roi(page_rois["text"], (page_w_mm, page_h_mm), (pixmap.width, pixmap.height)),
                "barcode": mm_to_px_roi(page_rois["barcode"], (page_w_mm, page_h_mm), (pixmap.width, pixmap.height)),
            }
        finally:
            document.close()
    if panel is not None and panel.is_file():
        size = image_size(panel)
        if size:
            chain["panel_front"] = {
                "size_px": size,
                "text": mm_to_px_roi(rois["text"], (face_w, face_h), (size[0], size[1])),
                "barcode": mm_to_px_roi(rois["barcode"], (face_w, face_h), (size[0], size[1])),
            }
    unregistered = {
        "status": "unregistered",
        "reason": "pdf_roi_not_projected_to_oblique_still",
        "readability": wrap.NOT_ASSESSED,
    }
    if full is not None and full.is_file():
        size = image_size(full)
        chain["full"] = {**unregistered, "whole_frame_px": size, "sha256": sha256_file(full)}
    else:
        chain["full"] = unregistered
    if card is not None and card.is_file():
        size = image_size(card)
        chain["card"] = {**unregistered, "whole_frame_px": size, "sha256": sha256_file(card)}
    else:
        chain["card"] = unregistered
    return chain


def non_light_settings(receipt: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "world": receipt.get("world"),
        "camera": receipt.get("camera"),
        "object": _object_without_paths(receipt.get("object")),
        "engine": receipt.get("engine"),
        "render": receipt.get("render"),
    }


def _object_without_paths(payload: Any) -> Any:
    if not isinstance(payload, Mapping):
        return payload
    copied = dict(payload)
    textures = []
    for item in copied.get("textures") or []:
        if not isinstance(item, Mapping):
            textures.append(item)
            continue
        textures.append({key: value for key, value in item.items() if key != "path_name" and key != "filepath"})
    copied["textures"] = textures
    return copied


def pairwise_check(
    control: Mapping[str, Any],
    candidate: Mapping[str, Any],
    *,
    fixture_id: str,
) -> dict[str, Any]:
    wrap = wrapper_module()
    failures: list[str] = []
    for label, record, variant in (('control', control, wrap.VARIANT_CONTROL),
                                    ('candidate', candidate, wrap.VARIANT_NORMALIZED)):
        if record.get('variant') != variant or record.get('complete') is not True:
            failures.append(f'{label}:variant_or_completion')
        for field in ('input_sha256', 'artwork_sha256', 'texture_sha256'):
            if not wrap.valid_sha256(record.get(field)):
                failures.append(f'{label}:{field}_missing_or_invalid')
        passes = record.get('passes')
        if (not isinstance(passes, list) or len(passes) != len(REQUIRED_STILLS)
                or any(not isinstance(p, Mapping) for p in passes)):
            failures.append(f'{label}:invalid_pass_set')
            continue
        if sorted(p.get('output_key', '') for p in passes) != sorted(REQUIRED_STILLS):
            failures.append(f'{label}:invalid_pass_set')
        for p in passes:
            if wrap.pass_evidence_incomplete(p) or p.get('pass_complete') is not True:
                failures.append(f'{label}:pass_evidence_incomplete')
            if p.get('variant') != variant:
                failures.append(f'{label}:pass_variant')
        for field in ('execution_nonce', 'declaration_sha256', 'snapshot_sha256', 'source_identity'):
            if any(p.get(field) != passes[0].get(field) for p in passes):
                failures.append(f'{label}:pass_identity:{field}')
    if failures:
        return {'fixture_id': fixture_id, 'ok': False, 'failures': failures,
                'lights_identity': False, 'expected_identity': fixture_id == 'rf00-tall-carton',
                'quality_improvement': wrap.NOT_ASSESSED}
    if control.get("input_sha256") != candidate.get("input_sha256"):
        failures.append("input_sha256")
    if control.get("artwork_sha256") != candidate.get("artwork_sha256"):
        failures.append("artwork_sha256")
    if control.get("texture_sha256") != candidate.get("texture_sha256"):
        failures.append("texture_sha256")
    control_passes = {item.get("output_key"): item for item in control.get("passes") or [] if item.get("output_key")}
    candidate_passes = {item.get("output_key"): item for item in candidate.get("passes") or [] if item.get("output_key")}
    for field in ('declaration_sha256', 'source_identity'):
        if control_passes['front_right'].get(field) != candidate_passes['front_right'].get(field):
            failures.append(f'pair_identity:{field}')
    if control_passes['front_right']['execution_nonce'] == candidate_passes['front_right']['execution_nonce']:
        failures.append('pair_identity:reused_execution_nonce')
    for key in REQUIRED_STILLS:
        left = control_passes.get(key)
        right = candidate_passes.get(key)
        if not isinstance(left, Mapping) or not isinstance(right, Mapping):
            failures.append(f"pass_missing:{key}")
            continue
        if non_light_settings(left) != non_light_settings(right):
            failures.append(f"non_light:{key}")
    control_lights = None
    candidate_lights = None
    for key in ("front_right",):
        if key in control_passes and key in candidate_passes:
            control_lights = [
                _measured_light_values(item) for item in control_passes[key].get("lights") or []
            ]
            candidate_lights = [
                _measured_light_values(item) for item in candidate_passes[key].get("lights") or []
            ]
    lights_identity = False
    if control_lights and candidate_lights:
        lights_identity = wrap.lights_are_identity(control_lights, candidate_lights)
    expected_identity = fixture_id == "rf00-tall-carton"
    if expected_identity and not lights_identity:
        failures.append("tall_expected_identity")
    if fixture_id == "rf00-wide-carton" and lights_identity:
        failures.append("wide_expected_light_change")
    return {
        "fixture_id": fixture_id,
        "ok": not failures,
        "failures": failures,
        "lights_identity": lights_identity,
        "expected_identity": expected_identity,
        "quality_improvement": wrap.NOT_ASSESSED,
    }


def _measured_light_values(payload: Mapping[str, Any]) -> dict[str, Any]:
    def value_of(field: str) -> Any:
        item = payload.get(field)
        if isinstance(item, Mapping) and item.get("status") == "measured":
            return item.get("value")
        return None

    size_y = payload.get("size_y")
    size_y_value = None
    if isinstance(size_y, Mapping) and size_y.get("status") == "measured":
        size_y_value = size_y.get("value")
    return {
        "name": payload.get("name"),
        "location": value_of("location"),
        "size": value_of("size"),
        "size_y": size_y_value,
        "energy": value_of("energy"),
    }


def _hash_assets(assets: Mapping[str, Any] | None) -> str | None:
    if not isinstance(assets, Mapping):
        return None
    entries = []
    for face in ("front", "right", "back", "left", "top", "bottom"):
        raw = assets.get(face)
        path = Path(str(raw)) if raw else None
        if path is None or not path.is_file():
            entries.append({"face": face, "sha256": None})
        else:
            entries.append({"face": face, "sha256": sha256_file(path)})
    return sha256_text(canonical_dumps(entries))


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def input_identity(dest: Path, product: Mapping[str, Any], assets: Any) -> dict[str, Any]:
    def digest(raw: Any) -> str | None:
        try:
            return sha256_file(Path(raw)) if raw else None
        except (OSError, TypeError, ValueError):
            return None

    identity = {
        role: digest(dest / product[role])
        for role in ("source_ai", "structure_sidecar", "template", "artwork_pdf")
    }
    identity["assets"] = {
        face: digest(assets.get(face)) if isinstance(assets, Mapping) else None
        for face in ("front", "right", "back", "left", "top", "bottom")
    }
    return identity


def input_identity_complete(identity: Mapping[str, Any]) -> bool:
    return all(isinstance(value, str) and len(value) == 64 for value in (
        *[identity.get(role) for role in ("source_ai", "structure_sidecar", "template", "artwork_pdf")],
        *identity["assets"].values(),
    ))


def output_evidence(outputs: Any, passes: Any) -> dict[str, Any]:
    wrap = wrapper_module()
    evidence = {}
    receipts = {item.get("output_key"): item for item in passes if isinstance(item, Mapping)}
    try:
        for key in REQUIRED_STILLS:
            path = Path(outputs[key])
            digest = sha256_file(path)
            pixels = pixel_sha256(path)
            size = image_size(path)
            if (not pixels or not size or receipts.get(key, {}).get("output_sha256") != digest
                    or sha256_file(path) != digest):
                raise wrap.ExperimentError("output_evidence_invalid")
            evidence[key] = {"sha256": digest, "pixel_sha256": pixels, "size_px": size}
    except (OSError, TypeError, ValueError, KeyError) as error:
        raise wrap.ExperimentError("output_evidence_invalid") from error
    return evidence


def run_experiment(
    *,
    suite: str,
    render: bool = False,
    blender_executable: Path | None = None,
    pipeline: Any | None = None,
    eval_mod: Any | None = None,
) -> dict[str, Any]:
    wrap = wrapper_module()
    identity_before = collect_experiment_identity()
    plan = build_plan(suite, render=render)
    if not render:
        return {
            **plan,
            "identity": identity_before,
            "blender_subprocess_invoked": False,
            "wrote_files": False,
            "quality_improvement": wrap.NOT_ASSESSED,
            "human_review": wrap.NOT_ASSESSED,
            "windows": wrap.NOT_ASSESSED,
            "l2": wrap.NOT_ASSESSED,
        }
    eval_mod = eval_mod or _eval_module()

    blender_path, blender_reason = resolve_blender(blender_executable, eval_mod)
    if blender_path is None:
        return {
            "schema": REPORT_SCHEMA,
            "ok": False,
            "complete": False,
            "render": True,
            "suite": suite,
            "failure_reason": blender_reason or "blender_executable_missing",
            "blender_subprocess_invoked": False,
            "samples_written": False,
            "quality_improvement": wrap.NOT_ASSESSED,
            "human_review": wrap.NOT_ASSESSED,
            "windows": wrap.NOT_ASSESSED,
            "l2": wrap.NOT_ASSESSED,
            "identity": identity_before,
        }

    declaration = load_declaration()
    root = create_experiment_root()
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    declaration_path, declaration_sha = write_declaration_copy(root, declaration)
    (root / "plan.json").write_text(canonical_dumps(plan) + "\n", encoding="utf-8")
    pipeline_mod = pipeline or _load_pipeline()
    round_deadline = time.monotonic() + ROUND_TIMEOUT_S
    jobs_out: list[dict[str, Any]] = []
    aborted = False
    failure_reason = None
    blender_invoked = False
    manifest = eval_mod.load_fixture_manifest()
    type_chain = None
    try:
        for item in plan["jobs"]:
            if aborted:
                break
            fixture_id = item["fixture_id"]
            variant = item["variant"]
            spec = deepcopy(eval_mod.fixture_by_id(manifest, fixture_id))
            output_root = root / "jobs" / fixture_id / variant
            output_root.mkdir(parents=True, exist_ok=False)
            dest = output_root / fixture_id
            prepared = eval_mod.materialize_fixture(spec, dest)
            product = {
                "code": fixture_id,
                "slug": fixture_id,
                "display_name": spec.get("label") or fixture_id,
                "source_ai": "source.ai",
                "template": "render-profile.json",
                "structure_engine": "v2",
                "structure_sidecar": "source.ai.structure.json",
                "artwork_pdf": "artwork.pdf",
            }
            job = pipeline_mod.preflight_product(
                product,
                dest,
                output_root,
                True,
                {"enabled": False},
                False,
            )
            envelope = {
                "schema": wrap.ENVELOPE_SCHEMA,
                "variant": variant,
                "fixture_id": fixture_id,
                "declaration_path": str(declaration_path),
                "declaration_sha256": declaration_sha,
                "experimental_scene_override": variant == wrap.VARIANT_NORMALIZED,
                "candidate_is_product_profile": False,
            }
            envelope_path = dest / "rfe02-job-envelope.json"
            envelope_path.write_text(canonical_dumps(envelope) + "\n", encoding="utf-8")
            record: dict[str, Any] = {
                "fixture_id": fixture_id,
                "variant": variant,
                "experimental_scene_override": variant == wrap.VARIANT_NORMALIZED,
                "input_sha256": prepared.get("input_sha256"),
                "artwork_sha256": prepared.get("artwork_sha256"),
                "project_dir": str(dest),
            }
            try:
                record["input_identity_before"] = input_identity(dest, product, job.get("assets"))
                if not input_identity_complete(record["input_identity_before"]):
                    raise wrap.ExperimentError("input_evidence_missing")
                with experiment_runtime(pipeline_mod, envelope_path, round_deadline):
                    blender_invoked = True
                    job = pipeline_mod.run_blender_job(job, blender_path)
                receipt = _read_json(dest / wrap.JOB_RECEIPT_NAME) or {}
                record["texture_sha256"] = _hash_assets(job.get("assets"))
                record["passes"] = receipt.get("passes") or []
                record["output_evidence"] = output_evidence(job.get("outputs"), record["passes"])
                record["complete"] = receipt.get("complete") is True
                record["evidence_insufficient"] = receipt.get("evidence_insufficient") is True
                record["job_receipt"] = str(dest / wrap.JOB_RECEIPT_NAME)
                record["outputs"] = job.get("outputs")
                record["assets"] = job.get("assets")
                originals = copy_originals(dest, root / "originals" / fixture_id / variant, job.get("outputs") or {})
                record["originals"] = originals
                if spec.get("artwork", {}).get("pattern") == "type_frequency" and type_chain is None:
                    type_chain = type_frequency_chain(
                        spec,
                        artwork_pdf=Path(prepared["artwork_pdf"]) if prepared.get("artwork_pdf") else None,
                        panel=Path((job.get("assets") or {}).get("front") or ""),
                        full=Path((job.get("outputs") or {}).get("front_right") or ""),
                        card=Path((job.get("outputs") or {}).get("front_right_card") or ""),
                        eval_mod=eval_mod,
                    )
                if receipt.get("complete") is not True:
                    aborted = True
                    failure_reason = "job_incomplete" if not receipt.get("evidence_insufficient") else "evidence_insufficient"
            except Exception as error:
                record["complete"] = False
                record["error_type"] = type(error).__name__
                record["error"] = str(error)[:240]
                aborted = True
                failure_reason = record["error"] if isinstance(error, wrap.ExperimentError) else "blender_render_failed"
            finally:
                record["input_identity_after"] = input_identity(dest, product, job.get("assets"))
                if not input_identity_complete(record["input_identity_after"]):
                    record["complete"] = False
                    aborted = True
                    failure_reason = "input_evidence_missing"
                elif record["input_identity_after"] != record.get("input_identity_before"):
                    record["complete"] = False
                    aborted = True
                    failure_reason = "input_changed_during_job"
            jobs_out.append(record)
    finally:
        identity_after = collect_experiment_identity()

    grouped: dict[str, dict[str, dict[str, Any]]] = {}
    for record in jobs_out:
        grouped.setdefault(record["fixture_id"], {})[record["variant"]] = record
    pairwise = []
    for fixture_id, variants in grouped.items():
        if wrap.VARIANT_CONTROL in variants and wrap.VARIANT_NORMALIZED in variants:
            pairwise.append(
                pairwise_check(
                    variants[wrap.VARIANT_CONTROL],
                    variants[wrap.VARIANT_NORMALIZED],
                    fixture_id=fixture_id,
                )
            )
    identity_unchanged = identity_after == identity_before
    if not identity_unchanged:
        aborted = True
        failure_reason = "identity_changed_during_run"
        for pair in pairwise:
            pair["ok"] = False
            pair.setdefault("failures", []).append("identity_changed_during_run")

    contact_rows = []
    for fixture_id in declaration["suites"][suite]:
        variants = grouped.get(fixture_id, {})
        control = variants.get(wrap.VARIANT_CONTROL, {})
        candidate = variants.get(wrap.VARIANT_NORMALIZED, {})
        control_path = Path((control.get("outputs") or {}).get("front_right") or "")
        candidate_path = Path((candidate.get("outputs") or {}).get("front_right") or "")
        control_size = image_size(control_path) if control_path.is_file() else None
        candidate_size = image_size(candidate_path) if candidate_path.is_file() else None
        control_file = control_path if control_size else None
        candidate_file = candidate_path if candidate_size else None
        contact_rows.append(
            (
                fixture_id,
                control_file,
                candidate_file,
                tuple(control_size) if control_size else None,
                tuple(candidate_size) if candidate_size else None,
            )
        )
    contact = write_contact_sheet(contact_rows, root / "contact-sheet.png")
    white_contact = write_contact_sheet(
        contact_rows,
        root / "contact-sheet-white-observation.png",
        white_observe=True,
    )
    if type_chain is not None:
        (root / "type-frequency-chain.json").write_text(canonical_dumps(type_chain) + "\n", encoding="utf-8")

    complete = (not aborted) and all(item.get("complete") is True for item in jobs_out) and all(
        pair.get("ok") is True for pair in pairwise
    )
    report = {
        "schema": REPORT_SCHEMA,
        "phase": "RF-E02",
        "ok": complete and identity_unchanged,
        "complete": complete,
        "suite": suite,
        "render": True,
        "root": str(root),
        "started_at": started,
        "ended_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "declaration_sha256": declaration_sha,
        "identity": identity_before,
        "identity_verified_after_run": identity_unchanged,
        "blender_subprocess_invoked": blender_invoked,
        "blender_path": str(blender_path),
        "jobs": jobs_out,
        "pairwise": pairwise,
        "contact_sheet": contact,
        "white_observation_sheet": white_contact,
        "white_observation_is_product_compositor": False,
        "type_frequency_chain": type_chain,
        "failure_reason": None if complete and identity_unchanged else failure_reason,
        "quality_improvement": wrap.NOT_ASSESSED,
        "human_review": wrap.NOT_ASSESSED,
        "windows": wrap.NOT_ASSESSED,
        "l2": wrap.NOT_ASSESSED,
        "browser": {"status": "not_measured", "reason": "deferred_to_e02_c"},
        "font_mapping": {"status": "not_measured", "reason": "unknown_browser_font_mapping"},
        "candidate_is_product_profile": False,
        "product_behavior_changed": False,
        "wrote_rf00_baseline": False,
        "improvement_passed": False,
    }
    if not identity_unchanged:
        report["identity_after"] = identity_after
    (root / "report.json").write_text(canonical_dumps(report) + "\n", encoding="utf-8")
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="RF-E02 isolated lighting experiment. Does not change product output."
    )
    parser.add_argument("--suite", choices=("smoke", "matrix"), required=True)
    parser.add_argument("--render", action="store_true", help="Create a private temp root and run Blender jobs.")
    parser.add_argument("--blender", type=Path, help="Blender executable. Missing path fails closed.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    wrap = wrapper_module()
    args = parse_args(argv)
    try:
        report = run_experiment(
            suite=args.suite,
            render=args.render,
            blender_executable=args.blender,
        )
    except Exception as error:
        public = str(error) if isinstance(error, wrap.ExperimentError) else "rfe02_experiment_failed"
        print(
            json.dumps(
                {"ok": False, "error": public, "error_type": type(error).__name__},
                ensure_ascii=False,
            )
        )
        return 1
    print(json.dumps(report, ensure_ascii=False))
    if report.get("ok") is True:
        return 0
    return 2 if report.get("failure_reason") in {"blender_executable_missing", "blender_executable_unusable"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
