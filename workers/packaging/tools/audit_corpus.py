#!/usr/bin/env python3
"""Read-only inventory for real packaging AI samples.

The command never writes beside source artwork. It records PDF/vector evidence,
the current parser's baseline result, and separately supplied human truth.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics
import tempfile
import time
from typing import Any


PACKAGING_ROOT = Path(__file__).resolve().parents[1]
PIPELINE_PATH = PACKAGING_ROOT / "pipeline.py"
DIELINE_PATH = PACKAGING_ROOT / "dieline.py"
KNIFE_NAMES = ("刀线", "刀版", "模切", "刀模")
TRUTH_STATUSES = {"approved", "unsupported", "pending_manual"}
FACE_NAMES = ("front", "right", "back", "left", "top", "bottom")
THRESHOLD_RULES = {
    "endpoint_snap_pt": ("number", 0.0, 5.0),
    "paired_panel_relative_tolerance": ("number", 0.0, 0.1),
    "outline_gap_pt": ("number", 0.0, 10.0),
    "curve_linearization_error_pt": ("number", 0.0, 5.0),
    "max_paths": ("integer", 1, 1_000_000),
    "max_path_points": ("integer", 1, 10_000_000),
    "max_structure_candidates": ("integer", 1, 100),
}
THRESHOLD_KEYS = set(THRESHOLD_RULES)


class AuditError(RuntimeError):
    pass


def _load_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AuditError(f"无法加载模块：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _rounded(value: Any, digits: int = 4) -> float:
    return round(float(value), digits)


def _point_xy(value: Any) -> tuple[float, float]:
    if hasattr(value, "x"):
        return float(value.x), float(value.y)
    return float(value[0]), float(value[1])


def _rect_xyxy(value: Any) -> tuple[float, float, float, float]:
    if hasattr(value, "x0"):
        return float(value.x0), float(value.y0), float(value.x1), float(value.y1)
    return tuple(float(part) for part in value[:4])  # type: ignore[return-value]


def _quantiles(values: list[float]) -> dict[str, float] | None:
    if not values:
        return None
    ordered = sorted(values)

    def percentile(ratio: float) -> float:
        index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * ratio) - 1))
        return _rounded(ordered[index])

    return {
        "min": _rounded(ordered[0]),
        "p50": _rounded(statistics.median(ordered)),
        "p95": percentile(0.95),
        "max": _rounded(ordered[-1]),
    }


def _knife_layer(name: str | None) -> bool:
    text = str(name or "")
    if any(bad in text for bad in ("无", "非", "不是")):
        return False
    return any(text == token or text.endswith(token) for token in KNIFE_NAMES)


def _rgb_key(value: Any) -> str:
    if value is None:
        return "none"
    try:
        return ",".join(f"{float(part):.4f}" for part in value)
    except TypeError:
        return str(value)


def drawing_metrics(page: Any) -> dict[str, Any]:
    drawings = page.get_cdrawings()
    by_layer: Counter[str] = Counter()
    stroke_by_layer: Counter[str] = Counter()
    stroke_widths: Counter[str] = Counter()
    stroke_colors: Counter[str] = Counter()
    item_types: Counter[str] = Counter()
    line_lengths: list[float] = []
    path_points = 0
    horizontal = 0
    vertical = 0
    off_axis = 0
    structure_candidate_paths = 0

    def record_line(p0: Any, p1: Any) -> None:
        nonlocal horizontal, vertical, off_axis, path_points
        x0, y0 = _point_xy(p0)
        x1, y1 = _point_xy(p1)
        dx, dy = x1 - x0, y1 - y0
        line_lengths.append(math.hypot(dx, dy))
        path_points += 2
        if abs(dy) <= 0.02:
            horizontal += 1
        elif abs(dx) <= 0.02:
            vertical += 1
        else:
            off_axis += 1

    for drawing in drawings:
        layer = str(drawing.get("layer") or "<none>")
        by_layer[layer] += 1
        is_stroke_only = drawing.get("color") is not None and drawing.get("fill") is None
        if is_stroke_only:
            stroke_by_layer[layer] += 1
            stroke_widths[f"{float(drawing.get('width') or 0):.4f}"] += 1
            stroke_colors[_rgb_key(drawing.get("color"))] += 1
            if _knife_layer(layer):
                structure_candidate_paths += 1
        for item in drawing.get("items") or []:
            if not item:
                continue
            kind = str(item[0])
            item_types[kind] += 1
            if kind == "l" and len(item) >= 3:
                record_line(item[1], item[2])
            elif kind == "re" and len(item) >= 2:
                x0, y0, x1, y1 = _rect_xyxy(item[1])
                record_line((x0, y0), (x1, y0))
                record_line((x1, y0), (x1, y1))
                record_line((x1, y1), (x0, y1))
                record_line((x0, y1), (x0, y0))
            elif kind == "qu" and len(item) >= 2:
                quad = item[1]
                points = list(quad) if not hasattr(quad, "ul") else [quad.ul, quad.ur, quad.lr, quad.ll]
                for index in range(len(points)):
                    record_line(points[index], points[(index + 1) % len(points)])
            elif kind == "c":
                path_points += max(0, len(item) - 1)
                off_axis += 1

    return {
        "drawing_count": len(drawings),
        "drawing_count_by_layer": dict(sorted(by_layer.items())),
        "stroke_only_count": sum(stroke_by_layer.values()),
        "stroke_only_count_by_layer": dict(sorted(stroke_by_layer.items())),
        "structure_candidate_paths": structure_candidate_paths,
        "drawing_item_count": sum(item_types.values()),
        "drawing_item_types": dict(sorted(item_types.items())),
        "estimated_path_points": path_points,
        "axis_segments": {
            "horizontal": horizontal,
            "vertical": vertical,
            "off_axis_or_curve": off_axis,
        },
        "line_length_points": _quantiles(line_lengths),
        "stroke_widths_top": stroke_widths.most_common(12),
        "stroke_colors_top": stroke_colors.most_common(12),
    }


def _spot_name(value: Any) -> str:
    return str(value).lstrip("/")


def pdf_spot_names(source: Path) -> list[str]:
    """Collect Separation / DeviceN names without decoding stream bodies."""
    from pypdf import PdfReader
    from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject

    reader = PdfReader(str(source))
    found: set[str] = set()
    seen: set[tuple[int, int]] = set()
    budget = 100_000

    def walk(value: Any) -> None:
        nonlocal budget
        if budget <= 0 or value is None:
            return
        budget -= 1
        if isinstance(value, IndirectObject):
            key = (int(value.idnum), int(value.generation))
            if key in seen:
                return
            seen.add(key)
            try:
                value = value.get_object()
            except Exception:
                return
        if isinstance(value, ArrayObject):
            if value:
                first = str(value[0])
                if first == "/Separation" and len(value) >= 2:
                    found.add(_spot_name(value[1]))
                elif first == "/DeviceN" and len(value) >= 2:
                    names = value[1]
                    if isinstance(names, ArrayObject):
                        found.update(_spot_name(name) for name in names)
            for item in value:
                walk(item)
            return
        if isinstance(value, DictionaryObject):
            for item in value.values():
                walk(item)

    for page in reader.pages:
        walk(page.get("/Resources"))
    return sorted(name for name in found if name)


def baseline_parser(source: Path, layers: list[str]) -> dict[str, Any]:
    knife = next((name for name in layers if _knife_layer(name)), None)
    if knife is None:
        return {"status": "not_run", "reason": "no_knife_layer"}
    pipeline = _load_module("packaging_pipeline_audit", PIPELINE_PATH)
    dieline = _load_module("packaging_dieline_audit", DIELINE_PATH)
    started = time.perf_counter()
    try:
        with tempfile.TemporaryDirectory(prefix="packaging-corpus-audit-") as temp_name:
            knife_pdf = Path(temp_name) / "knife.pdf"
            pipeline.make_layer_pdf(source, knife_pdf, {knife})
            layout = dieline.parse_knife_pdf(knife_pdf, knife)
    except Exception as error:
        return {
            "status": "failed",
            "knife_layer": knife,
            "elapsed_s": round(time.perf_counter() - started, 4),
            "error_type": type(error).__name__,
            "error": str(error)[:500],
        }
    dimensions = layout.get("dimensions_mm") or {}
    return {
        "status": "parsed",
        "knife_layer": knife,
        "elapsed_s": round(time.perf_counter() - started, 4),
        "family": layout.get("family"),
        "die_source": layout.get("die_source"),
        "dimensions_mm": {
            key: _rounded(dimensions[key], 2)
            for key in ("width", "depth", "height")
            if key in dimensions
        },
        "panel_roles": [str(panel.get("role")) for panel in layout.get("panels") or []],
    }


def inspect_source(source: Path, include_baseline: bool = True) -> dict[str, Any]:
    import pymupdf

    started = time.perf_counter()
    source_hash = sha256_file(source)
    with source.open("rb") as stream:
        header = stream.read(8)
    result: dict[str, Any] = {
        "filename": source.name,
        "sha256": source_hash,
        "bytes": source.stat().st_size,
        "pdf_compatible": header.startswith(b"%PDF-"),
    }
    if not result["pdf_compatible"]:
        result["inspection_status"] = "needs_illustrator"
        result["baseline_parser"] = {"status": "not_run", "reason": "non_pdf_compatible"}
        result["inspect_elapsed_s"] = round(time.perf_counter() - started, 4)
        return result
    try:
        document = pymupdf.open(str(source))
        try:
            result["page_count"] = document.page_count
            result["ocg_layers"] = sorted(
                str(item.get("name") or "")
                for item in document.get_ocgs().values()
                if str(item.get("name") or "")
            )
            if document.page_count:
                page = document[0]
                result["page_points"] = [_rounded(page.rect.width, 2), _rounded(page.rect.height, 2)]
                result["text_character_count"] = len(page.get_text() or "")
                result["vector"] = drawing_metrics(page)
        finally:
            document.close()
        result["spot_names"] = pdf_spot_names(source)
        result["inspection_status"] = "inspected"
        result["baseline_parser"] = (
            baseline_parser(source, result.get("ocg_layers") or [])
            if include_baseline
            else {"status": "not_run", "reason": "disabled"}
        )
    except Exception as error:
        result["inspection_status"] = "failed"
        result["inspection_error_type"] = type(error).__name__
        result["inspection_error"] = str(error)[:500]
        result.setdefault("baseline_parser", {"status": "not_run", "reason": "inspection_failed"})
    result["inspect_elapsed_s"] = round(time.perf_counter() - started, 4)
    return result


def _validate_thresholds(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AuditError("真值 thresholds 必须是对象")
    unknown = sorted(set(value) - THRESHOLD_KEYS)
    if unknown:
        raise AuditError(f"真值 thresholds 含未知字段：{','.join(unknown)}")
    for key, raw in value.items():
        kind, lower, upper = THRESHOLD_RULES[key]
        if kind == "integer":
            valid_type = isinstance(raw, int) and not isinstance(raw, bool)
        else:
            valid_type = isinstance(raw, (int, float)) and not isinstance(raw, bool)
        if not valid_type or not math.isfinite(float(raw)) or not lower < float(raw) <= upper:
            interval = f"({lower}, {upper}]"
            raise AuditError(f"真值 threshold {key} 必须是 {kind} 且位于 {interval}")
    return value


def _validate_dimensions(dimensions: Any, identity: str) -> None:
    if not isinstance(dimensions, dict) or any(
        key not in dimensions for key in ("width", "depth", "height")
    ):
        raise AuditError(f"已批准真值缺完整 dimensions_mm：{identity}")
    for key in ("width", "depth", "height"):
        raw = dimensions[key]
        if (
            isinstance(raw, bool)
            or not isinstance(raw, (int, float))
            or not math.isfinite(float(raw))
            or float(raw) <= 0
        ):
            raise AuditError(f"已批准真值 dimensions_mm.{key} 必须是正数：{identity}")


def _validate_approved_faces(geometry: dict[str, Any], identity: str) -> None:
    if geometry.get("face_mapping_status") != "approved":
        raise AuditError(f"已批准真值六面状态必须是 approved：{identity}")
    faces = geometry.get("faces")
    if not isinstance(faces, dict) or set(FACE_NAMES) - set(faces):
        raise AuditError(f"已批准真值缺完整六面映射：{identity}")
    for face in FACE_NAMES:
        mapping = faces.get(face)
        if not isinstance(mapping, dict) or not str(mapping.get("source_panel") or "").strip():
            raise AuditError(f"已批准真值 {face} 缺 source_panel：{identity}")
        rotation = mapping.get("rotation_deg")
        if isinstance(rotation, bool) or not isinstance(rotation, int) or rotation not in {0, 90, 180, 270}:
            raise AuditError(f"已批准真值 {face}.rotation_deg 只允许 0/90/180/270：{identity}")


def load_truth(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"schema_version": 1, "thresholds": {}, "samples": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise AuditError(f"真值文件读取失败：{error}") from error
    if not isinstance(payload, dict):
        raise AuditError("真值根节点必须是对象")
    if payload.get("schema_version") != 1:
        raise AuditError("真值 schema_version 必须是 1")
    _validate_thresholds(payload.get("thresholds", {}))
    samples = payload.get("samples")
    if not isinstance(samples, list):
        raise AuditError("真值 samples 必须是数组")
    seen_hashes: set[str] = set()
    seen_names: set[str] = set()
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict):
            raise AuditError(f"真值 samples[{index}] 必须是对象")
        status = sample.get("truth_status")
        if status not in TRUTH_STATUSES:
            raise AuditError(f"真值 samples[{index}] truth_status 无效：{status}")
        source_hash = str(sample.get("sha256") or "")
        filename = str(sample.get("filename") or "")
        if not source_hash and not filename:
            raise AuditError(f"真值 samples[{index}] 至少要有 sha256 或 filename")
        if source_hash:
            if source_hash in seen_hashes:
                raise AuditError(f"真值 sha256 重复：{source_hash}")
            seen_hashes.add(source_hash)
        if filename:
            if filename in seen_names:
                raise AuditError(f"真值 filename 重复：{filename}")
            seen_names.add(filename)
        if status == "approved":
            identity = filename or source_hash
            if not str(sample.get("approved_by") or "").strip():
                raise AuditError(f"已批准真值缺 approved_by：{identity}")
            geometry = sample.get("expected_geometry")
            if not isinstance(geometry, dict):
                raise AuditError(f"已批准真值缺 expected_geometry：{identity}")
            if not str(geometry.get("family") or "").strip():
                raise AuditError(f"已批准真值缺 geometry family：{identity}")
            if not str(geometry.get("family_id") or "").strip():
                raise AuditError(f"已批准真值缺 geometry family_id：{identity}")
            _validate_dimensions(geometry.get("dimensions_mm"), identity)
            _validate_approved_faces(geometry, identity)
            if not isinstance(sample.get("golden_sample"), bool):
                raise AuditError(f"已批准真值 golden_sample 必须是布尔值：{identity}")
        if status == "unsupported":
            identity = filename or source_hash
            if not sample.get("unsupported_reason"):
                raise AuditError(f"unsupported 真值缺 unsupported_reason：{identity}")
            if not str(sample.get("approved_by") or "").strip():
                raise AuditError(f"unsupported 真值缺 approved_by：{identity}")
    return payload


def attach_truth(records: list[dict[str, Any]], truth: dict[str, Any]) -> None:
    by_hash = {
        str(sample.get("sha256")): sample
        for sample in truth.get("samples") or []
        if sample.get("sha256")
    }
    by_name = {
        str(sample.get("filename")): sample
        for sample in truth.get("samples") or []
        if sample.get("filename")
    }
    for record in records:
        sample = by_hash.get(record["sha256"]) or by_name.get(record["filename"])
        if sample is None:
            record["truth"] = {"truth_status": "missing"}
            continue
        copied = json.loads(json.dumps(sample, ensure_ascii=False))
        if copied.get("sha256") and copied["sha256"] != record["sha256"]:
            copied["truth_status"] = "hash_mismatch"
            copied["actual_sha256"] = record["sha256"]
        record["truth"] = copied


def validate_phase0_exit(records: list[dict[str, Any]], truth: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    thresholds = truth.get("thresholds") or {}
    missing_thresholds = sorted(THRESHOLD_KEYS - set(thresholds))
    if missing_thresholds:
        errors.append(f"阈值未冻结：{','.join(missing_thresholds)}")
    approved_families: set[str] = set()
    golden_families: set[str] = set()
    for record in records:
        sample = record.get("truth") or {}
        status = sample.get("truth_status")
        if status not in {"approved", "unsupported"}:
            errors.append(f"{record['filename']} 真值未批准：{status}")
            continue
        if status == "approved":
            geometry = sample.get("expected_geometry") or {}
            if geometry.get("face_mapping_status") != "approved":
                errors.append(f"{record['filename']} 六面真值未批准")
            family_id = str(geometry.get("family_id") or "")
            if family_id:
                approved_families.add(family_id)
                if sample.get("golden_sample") is True:
                    golden_families.add(family_id)
    for family_id in sorted(approved_families - golden_families):
        errors.append(f"结构族缺黄金样本：{family_id}")
    return errors


def corpus_summary(records: list[dict[str, Any]], truth: dict[str, Any]) -> dict[str, Any]:
    truth_counts = Counter((record.get("truth") or {}).get("truth_status", "missing") for record in records)
    drawing_counts = [
        int((record.get("vector") or {}).get("drawing_count") or 0)
        for record in records
    ]
    point_counts = [
        int((record.get("vector") or {}).get("estimated_path_points") or 0)
        for record in records
    ]
    candidate_counts = [
        int((record.get("vector") or {}).get("structure_candidate_paths") or 0)
        for record in records
    ]
    family_clusters: dict[str, list[str]] = {}
    rectangular_candidates = 0
    golden_samples = 0
    for record in records:
        sample = record.get("truth") or {}
        geometry = sample.get("expected_geometry") or {}
        if geometry.get("family") == "rectangular_carton":
            rectangular_candidates += 1
        family_id = str(geometry.get("family_id") or "")
        if family_id:
            family_clusters.setdefault(family_id, []).append(record["filename"])
        if sample.get("golden_sample") is True:
            golden_samples += 1
    return {
        "sample_count": len(records),
        "pdf_compatible_count": sum(bool(record.get("pdf_compatible")) for record in records),
        "total_bytes": sum(int(record.get("bytes") or 0) for record in records),
        "max_bytes": max((int(record.get("bytes") or 0) for record in records), default=0),
        "max_drawing_count": max(drawing_counts, default=0),
        "max_estimated_path_points": max(point_counts, default=0),
        "max_structure_candidate_paths": max(candidate_counts, default=0),
        "rectangular_carton_candidate_count": rectangular_candidates,
        "truth_family_cluster_count": len(family_clusters),
        "truth_family_clusters": dict(sorted(family_clusters.items())),
        "golden_sample_count": golden_samples,
        "truth_counts": dict(sorted(truth_counts.items())),
        "thresholds": truth.get("thresholds") or {},
    }


def _md(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def markdown_report(manifest: dict[str, Any], phase0_errors: list[str]) -> str:
    lines = [
        "# Packaging AI Corpus Audit",
        "",
        f"Generated at: {manifest['generated_at']}",
        f"Scanner version: {manifest['scanner_version']}",
        f"Samples: {manifest['summary']['sample_count']}",
        "",
        "## Summary",
        "",
        f"- PDF-compatible: {manifest['summary']['pdf_compatible_count']}/{manifest['summary']['sample_count']}",
        f"- Total bytes: {manifest['summary']['total_bytes']}",
        f"- Largest file bytes: {manifest['summary']['max_bytes']}",
        f"- Maximum drawings: {manifest['summary']['max_drawing_count']}",
        f"- Maximum estimated path points: {manifest['summary']['max_estimated_path_points']}",
        f"- Maximum knife-layer stroke candidates: {manifest['summary']['max_structure_candidate_paths']}",
        f"- Rectangular-carton candidates from truth/proposals: {manifest['summary']['rectangular_carton_candidate_count']}",
        f"- Truth/proposed structure families: {manifest['summary']['truth_family_cluster_count']}",
        f"- Golden sample flags: {manifest['summary']['golden_sample_count']}",
        f"- Truth coverage: {json.dumps(manifest['summary']['truth_counts'], ensure_ascii=False, sort_keys=True)}",
        "",
        "## Samples",
        "",
        "| File | MB | Page pt | Layers | Drawings | Knife candidates | Baseline | Truth |",
        "|---|---:|---|---|---:|---:|---|---|",
    ]
    for record in manifest["samples"]:
        vector = record.get("vector") or {}
        baseline = record.get("baseline_parser") or {}
        baseline_text = baseline.get("status")
        if baseline.get("dimensions_mm"):
            dims = baseline["dimensions_mm"]
            baseline_text = (
                f"{baseline_text} {dims.get('width')}×{dims.get('depth')}×{dims.get('height')}"
            )
        elif baseline.get("error"):
            baseline_text = f"{baseline_text}: {baseline.get('error')}"
        lines.append(
            "| "
            + " | ".join(
                [
                    _md(record["filename"]),
                    f"{float(record.get('bytes') or 0) / 1024 / 1024:.2f}",
                    _md(record.get("page_points") or "—"),
                    _md(",".join(record.get("ocg_layers") or []) or "—"),
                    str(vector.get("drawing_count") or 0),
                    str(vector.get("structure_candidate_paths") or 0),
                    _md(baseline_text),
                    _md((record.get("truth") or {}).get("truth_status", "missing")),
                ]
            )
            + " |"
        )
    lines.extend(["", "## Phase 0 Exit Gate", ""])
    if phase0_errors:
        lines.append("BLOCKED")
        lines.extend(f"- {error}" for error in phase0_errors)
    else:
        lines.append("PASS")
        lines.append("- Every sample is approved or explicitly unsupported.")
        lines.append("- Six-face truth is approved for every supported sample.")
        lines.append("- Geometry safety thresholds are frozen.")
    lines.extend(
        [
            "",
            "## Safety",
            "",
            "- Source artwork was read only and was not copied into this output.",
            "- The manifest contains metadata, hashes, vector counts, parser baselines, and supplied truth only.",
            "- No production route, template selection, or Blender behavior was changed by this audit.",
            "",
        ]
    )
    return "\n".join(lines)


def audit_corpus(
    corpus_dir: Path,
    truth_path: Path | None,
    output_dir: Path,
    include_baseline: bool = True,
) -> tuple[dict[str, Any], list[str]]:
    source_dir = corpus_dir.expanduser().resolve()
    dest = output_dir.expanduser().resolve()
    if not source_dir.is_dir():
        raise AuditError(f"语料目录不存在：{source_dir}")
    sources = sorted(
        path for path in source_dir.iterdir()
        if path.is_file() and path.suffix.lower() == ".ai"
    )
    if not sources:
        raise AuditError(f"语料目录没有 AI 文件：{source_dir}")
    if dest == source_dir or source_dir in dest.parents:
        raise AuditError("输出目录不能位于真实稿语料目录内")
    truth = load_truth(truth_path.expanduser().resolve() if truth_path else None)
    records = [inspect_source(source, include_baseline=include_baseline) for source in sources]
    attach_truth(records, truth)
    phase0_errors = validate_phase0_exit(records, truth)
    manifest = {
        "schema_version": 1,
        "scanner_version": "1.1.0",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "corpus_directory_name": source_dir.name,
        "summary": corpus_summary(records, truth),
        "samples": records,
        "phase0_exit": {
            "status": "pass" if not phase0_errors else "blocked",
            "errors": phase0_errors,
        },
    }
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "corpus_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (dest / "corpus_report.md").write_text(
        markdown_report(manifest, phase0_errors),
        encoding="utf-8",
    )
    return manifest, phase0_errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="只读扫描包装 AI 语料，输出矢量证据、旧解析基线和人工真值覆盖率。"
    )
    parser.add_argument("--corpus-dir", type=Path, required=True, help="真实 AI 文件目录")
    parser.add_argument("--truth", type=Path, help="人工真值 JSON；真实稿和真值都不进 Git")
    parser.add_argument("--output-dir", type=Path, required=True, help="输出目录，不得位于语料目录内")
    parser.add_argument("--skip-baseline-parser", action="store_true", help="不运行当前 parse_knife_pdf 基线")
    parser.add_argument(
        "--require-phase0-exit",
        action="store_true",
        help="真值、六面和阈值未全部批准时返回退出码 2",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest, errors = audit_corpus(
            args.corpus_dir,
            args.truth,
            args.output_dir,
            include_baseline=not args.skip_baseline_parser,
        )
    except AuditError as error:
        print(str(error))
        return 1
    print(
        json.dumps(
            {
                "ok": not errors,
                "sample_count": manifest["summary"]["sample_count"],
                "phase0_exit": manifest["phase0_exit"],
                "manifest": str(args.output_dir.expanduser().resolve() / "corpus_manifest.json"),
                "report": str(args.output_dir.expanduser().resolve() / "corpus_report.md"),
            },
            ensure_ascii=False,
        )
    )
    if args.require_phase0_exit and errors:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
