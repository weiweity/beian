"""PDF 入稿分类：活字 / 转曲 / 位图。抽字复用 text_verify，不另写一套。"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

import pymupdf

from app.text_verify import extract_pdf_text_layer, map_pdf_blocks_to_pixels

PageMode = Literal["live_text", "outlined", "image"]
DocMode = Literal["live_text", "outlined", "image", "mixed"]

# 分类启发式（夹具可微调）：
# live_text: 去掉刀版尺寸数字与 U+FFFD 后 live_chars ≥ 80（40–79 且非转曲也算活字）
# outlined: live_chars < 40 且 drawings ≥ 400（转曲：几乎无 text object、路径 2000–7000）
# image: 几乎无活字且 drawings 不像转曲（大图铺满 / 矢量很少）
# 文档级：多页取更「无字」的一档；outlined/image 优先于 live_text；outlined+image 为 mixed
LIVE_TEXT_MIN_CHARS = 80
OUTLINED_MAX_LIVE_CHARS = 40
OUTLINED_MIN_DRAWINGS = 400
FFFD_MAX_RATIO = 0.5

WARNING_OUTLINED = "稿是转曲，没有活字，按扫描识别，钉框会比活字稿粗"
WARNING_IMAGE = "稿页主要是图，没有可选中文字"
WARNING_MIXED = "稿页混有转曲或图，按扫描识别，钉框会比活字稿粗"

_DIELINE_TOKEN = re.compile(
    r"^\d{1,4}(?:\.\d{1,3})?(?:\s*(?:mm|cm))?$",
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
    "drawings",
    "warning",
)
_PUBLIC_KEYS = ("mode", "pages", "live_chars", "drawings", "images", "warning")


def classify_page(live_chars: int, drawings: int) -> PageMode:
    if live_chars >= LIVE_TEXT_MIN_CHARS:
        return "live_text"
    if live_chars < OUTLINED_MAX_LIVE_CHARS and drawings >= OUTLINED_MIN_DRAWINGS:
        return "outlined"
    if live_chars < OUTLINED_MAX_LIVE_CHARS:
        return "image"
    return "live_text"


def classify_document(page_modes: list[str]) -> DocMode:
    if not page_modes:
        return "image"
    uniq = set(page_modes)
    if len(uniq) == 1:
        return page_modes[0]  # type: ignore[return-value]
    textless = uniq - {"live_text"}
    if textless == {"outlined"}:
        return "outlined"
    if textless == {"image"}:
        return "image"
    return "mixed"


def live_char_count(text: str) -> int:
    """可抽取、非乱码、非刀版尺寸数字的字数。"""
    if not text:
        return 0
    n_fffd = text.count("\ufffd")
    compact = re.sub(r"\s+", "", text)
    if compact and n_fffd / max(len(compact), 1) >= FFFD_MAX_RATIO:
        return 0
    kept: list[str] = []
    for tok in re.findall(r"\S+", text.replace("\ufffd", " ")):
        if _DIELINE_TOKEN.fullmatch(tok):
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
            mode = classify_page(live, gfx["drawings"])
            pages_out.append(
                {
                    "page": pno,
                    "mode": mode,
                    "live_chars": live,
                    "words": gfx["words"],
                    "text_blocks": gfx["text_blocks"],
                    "image_blocks": gfx["image_blocks"],
                    "drawings": gfx["drawings"],
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
    d = page.get_text("dict") or {}
    image_blocks = 0
    text_blocks = 0
    for block in d.get("blocks") or []:
        if block.get("type") == 1:
            image_blocks += 1
        elif block.get("type") == 0:
            text_blocks += 1
    words = page.get_text("words") or []
    return {
        "drawings": len(drawings),
        "image_blocks": image_blocks,
        "words": len(words),
        "text_blocks": text_blocks,
    }


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
