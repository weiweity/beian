"""PDF 入稿分类：活字 / 转曲 / 位图。抽字复用 text_verify，不另写一套。"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

import pymupdf

from app.text_verify import extract_pdf_text_layer, map_pdf_blocks_to_pixels

PageMode = Literal["live_text", "outlined", "image", "mixed"]
DocMode = Literal["live_text", "outlined", "image", "mixed"]

# 分类启发式（夹具可微调）：
# live_text: 去掉刀版尺寸数字与 U+FFFD 后，有足够活字且没有大面积图/密集路径
# outlined: 几乎无活字且路径组或组内绘图指令足够密集
# image: 几乎无活字且大图铺满 / 矢量很少
# mixed: 大面积图或密集路径与活字同页；必须 OCR，不能因页脚/尺寸活字漏掉主体
# 文档级：各页模式不一致即 mixed；具体 OCR 路由仍按页模式决定
LIVE_TEXT_MIN_CHARS = 40
OUTLINED_MIN_DRAWINGS = 400
OUTLINED_MIN_DRAWING_ITEMS = 800
FFFD_MAX_RATIO = 0.5
FULL_PAGE_IMAGE_MIN_COVERAGE = 0.5

WARNING_OUTLINED = "稿是转曲，没有活字，按扫描识别，钉框会比活字稿粗"
WARNING_IMAGE = "稿页主要是图，没有可选中文字"
WARNING_MIXED = "稿页混有转曲或图，按扫描识别，钉框会比活字稿粗"

_DIELINE_TOKEN = re.compile(
    r"^\d{1,4}(?:\.\d{1,3})?(?:\s*(?:mm|cm))?$",
    re.I,
)
_DIELINE_COMPOUND = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(?:[WHDL]\s*)?\d{1,4}(?:\.\d{1,3})?"
    r"(?:\s*(?:[x×*]|[/\-])\s*(?:[WHDL]\s*)?\d{1,4}(?:\.\d{1,3})?){1,3}"
    r"\s*(?:mm|cm)?"
    r"(?![A-Za-z0-9])",
    re.I,
)
_DIELINE_AXIS_TOKEN = re.compile(
    r"^[WHDL]\s*\d{1,4}(?:\.\d{1,3})?(?:\s*(?:mm|cm))?$",
    re.I,
)
_LIVE_CHAR = re.compile(r"[\u4e00-\u9fffA-Za-z0-9]")

_PUBLIC_PAGE_KEYS = (
    "page",
    "mode",
    "live_chars",
    "words",
    "text_blocks",
    "image_blocks",
    "image_coverage",
    "drawings",
    "drawing_items",
    "warning",
)
_PUBLIC_KEYS = (
    "mode",
    "pages",
    "live_chars",
    "drawings",
    "drawing_items",
    "images",
    "warning",
)


def classify_page(
    live_chars: int,
    drawings: int,
    *,
    drawing_items: int = 0,
    image_coverage: float = 0.0,
) -> PageMode:
    if image_coverage >= FULL_PAGE_IMAGE_MIN_COVERAGE:
        return "mixed" if live_chars >= LIVE_TEXT_MIN_CHARS else "image"
    if drawings >= OUTLINED_MIN_DRAWINGS or drawing_items >= OUTLINED_MIN_DRAWING_ITEMS:
        return "mixed" if live_chars >= LIVE_TEXT_MIN_CHARS else "outlined"
    if live_chars < LIVE_TEXT_MIN_CHARS:
        return "image"
    return "live_text"


def classify_document(page_modes: list[str]) -> DocMode:
    if not page_modes:
        return "image"
    uniq = set(page_modes)
    if len(uniq) == 1:
        return page_modes[0]  # type: ignore[return-value]
    return "mixed"


def live_char_count(text: str) -> int:
    """可抽取、非乱码、非刀版尺寸数字的字数。"""
    if not text:
        return 0
    n_fffd = text.count("\ufffd")
    compact = re.sub(r"\s+", "", text)
    if compact and n_fffd / max(len(compact), 1) >= FFFD_MAX_RATIO:
        return 0
    cleaned = text.replace("\ufffd", " ")

    def drop_compound(match: re.Match[str]) -> str:
        value = match.group(0)
        # 纯整数斜杠/短横线更像日期或批号；带小数、单位、轴名或乘号才视为刀版尺寸。
        if (
            re.search(r"[.×x*]", value, re.I)
            or re.search(r"(?:mm|cm)\s*$", value, re.I)
            or re.search(r"\b[WHDL]\s*\d", value, re.I)
        ):
            return " "
        return value

    cleaned = _DIELINE_COMPOUND.sub(drop_compound, cleaned)
    tokens = re.findall(r"\S+", cleaned)
    axis_count = sum(1 for tok in tokens if _DIELINE_AXIS_TOKEN.fullmatch(tok))
    kept: list[str] = []
    for tok in tokens:
        if _DIELINE_TOKEN.fullmatch(tok):
            continue
        if axis_count >= 2 and _DIELINE_AXIS_TOKEN.fullmatch(tok):
            continue
        kept.append(tok)
    return len(_LIVE_CHAR.findall("".join(kept)))


def public_ingest(full: dict[str, Any]) -> dict[str, Any]:
    """任务 JSON / CLI 只留诊断，不含 spans 与抽字全文。"""
    pages = [{k: p.get(k) for k in _PUBLIC_PAGE_KEYS} for p in (full.get("pages") or [])]
    out = {k: full.get(k) for k in _PUBLIC_KEYS}
    out["pages"] = pages
    return out


def ingest_pdf(
    pdf_path: str | Path,
    page_metas: list[dict] | None = None,
    *,
    max_pages: int = 3,
) -> dict[str, Any]:
    pdf_path = Path(pdf_path)
    page_metas = list(page_metas or [])
    layer_text, layer_blocks, has_layer = extract_pdf_text_layer(
        pdf_path, max_pages=max_pages
    )
    blocks_by_page: dict[int, list[dict]] = {}
    for block in layer_blocks:
        blocks_by_page.setdefault(int(block.get("page") or 1), []).append(block)

    pages_out: list[dict[str, Any]] = []
    doc = pymupdf.open(pdf_path)
    try:
        n = min(int(doc.page_count), max_pages)
        for i in range(n):
            page = doc[i]
            pno = i + 1
            gfx = _page_graphics(page)
            raw = "\n".join(b.get("text") or "" for b in blocks_by_page.get(pno, []))
            live = live_char_count(raw)
            mode = classify_page(
                live,
                gfx["drawings"],
                drawing_items=gfx["drawing_items"],
                image_coverage=gfx["image_coverage"],
            )
            pages_out.append(
                {
                    "page": pno,
                    "mode": mode,
                    "live_chars": live,
                    "words": gfx["words"],
                    "text_blocks": gfx["text_blocks"],
                    "image_blocks": gfx["image_blocks"],
                    "image_coverage": gfx["image_coverage"],
                    "drawings": gfx["drawings"],
                    "drawing_items": gfx["drawing_items"],
                    "warning": _warning_for(mode),
                }
            )
    finally:
        doc.close()

    doc_mode = classify_document([p["mode"] for p in pages_out])
    return {
        "mode": doc_mode,
        "pages": pages_out,
        "live_chars": sum(p["live_chars"] for p in pages_out),
        "drawings": sum(p["drawings"] for p in pages_out),
        "drawing_items": sum(p["drawing_items"] for p in pages_out),
        "images": sum(p["image_blocks"] for p in pages_out),
        "warning": _warning_for(doc_mode),
        "spans": _map_live_spans(layer_blocks, page_metas),
        "layer_text": layer_text,
        "layer_blocks": layer_blocks,
        "has_layer": has_layer,
    }


def _warning_for(mode: str) -> str | None:
    if mode == "outlined":
        return WARNING_OUTLINED
    if mode == "image":
        return WARNING_IMAGE
    if mode == "mixed":
        return WARNING_MIXED
    return None


def _page_graphics(page: Any) -> dict[str, Any]:
    drawings = page.get_drawings() or []
    drawing_items = sum(
        len(path.get("items") or [])
        for path in drawings
        if isinstance(path, dict)
    )
    d = page.get_text("dict") or {}
    image_blocks = 0
    image_rects: list[pymupdf.Rect] = []
    text_blocks = 0
    for block in d.get("blocks") or []:
        if block.get("type") == 1:
            image_blocks += 1
            bbox = pymupdf.Rect(block.get("bbox") or (0, 0, 0, 0))
            if not bbox.is_empty:
                image_rects.append(bbox)
        elif block.get("type") == 0:
            text_blocks += 1
    words = page.get_text("words") or []
    page_box = pymupdf.Rect(0, 0, float(page.cropbox.width), float(page.cropbox.height))
    image_coverage = _rect_union_coverage(image_rects, page_box)
    return {
        "drawings": len(drawings),
        "drawing_items": drawing_items,
        "image_blocks": image_blocks,
        "image_coverage": round(min(1.0, image_coverage), 4),
        "words": len(words),
        "text_blocks": text_blocks,
    }


def _rect_union_coverage(rects: list[pymupdf.Rect], bounds: pymupdf.Rect) -> float:
    """计算页内图片矩形的联合覆盖率，避免多图平铺漏判或重叠重复计数。"""
    clipped: list[pymupdf.Rect] = []
    for rect in rects:
        item = rect & bounds
        if not item.is_empty and item.width > 0 and item.height > 0:
            clipped.append(item)
    if not clipped:
        return 0.0

    xs = sorted({float(r.x0) for r in clipped} | {float(r.x1) for r in clipped})
    area = 0.0
    for x0, x1 in zip(xs, xs[1:]):
        if x1 <= x0:
            continue
        intervals = sorted(
            (float(r.y0), float(r.y1))
            for r in clipped
            if r.x0 < x1 and r.x1 > x0
        )
        covered_y = 0.0
        start = end = None
        for y0, y1 in intervals:
            if start is None:
                start, end = y0, y1
            elif y0 <= end:
                end = max(end, y1)
            else:
                covered_y += end - start
                start, end = y0, y1
        if start is not None and end is not None:
            covered_y += end - start
        area += (x1 - x0) * covered_y

    page_area = max(1.0, float(bounds.width) * float(bounds.height))
    return min(1.0, max(0.0, area / page_area))


def _map_live_spans(
    layer_blocks: list[dict], page_metas: list[dict]
) -> list[dict[str, Any]]:
    live_blocks = [
        b for b in layer_blocks if live_char_count(str(b.get("text") or "")) > 0
    ]
    if not live_blocks or not page_metas:
        return []
    mapped = map_pdf_blocks_to_pixels(live_blocks, page_metas)
    by_page = {int(m["page"]): m for m in page_metas}
    out: list[dict[str, Any]] = []
    for span in mapped:
        meta = by_page.get(int(span.get("page") or 1))
        if not meta:
            continue
        w = int(meta.get("width") or 0)
        h = int(meta.get("height") or 0)
        if w <= 0 or h <= 0:
            continue
        left = max(0, min(int(span.get("left") or 0), w - 1))
        top = max(0, min(int(span.get("top") or 0), h - 1))
        right = max(left + 1, min(left + max(1, int(span.get("width") or 1)), w))
        bottom = max(top + 1, min(top + max(1, int(span.get("height") or 1)), h))
        out.append(
            {
                "page": int(span.get("page") or 1),
                "left": left,
                "top": top,
                "width": max(1, right - left),
                "height": max(1, bottom - top),
                "text": span.get("text") or "",
                "source": "pdf_layer",
            }
        )
    return out
