"""
OCR 后处理：行合并 / 阅读顺序，减少「中间插 logo」导致的整句 miss。
"""
from __future__ import annotations

import re
from typing import Any


def merge_ocr_lines(
    words: list[dict],
    *,
    y_tol: float = 14.0,
    max_gap_x: float = 80.0,
) -> tuple[str, list[dict]]:
    """
    按页、按 y 聚类成行，行内按 x 排序后拼接。
    返回 (merged_text, merged_words)。
    merged_words 保留原词（带 page/location/prob），并在同 y 行上标记 line_id。
    """
    if not words:
        return "", []

    by_page: dict[int, list[dict]] = {}
    for w in words:
        p = int(w.get("page") or 1)
        by_page.setdefault(p, []).append(w)

    out_words: list[dict] = []
    text_pages: list[str] = []

    for page in sorted(by_page.keys()):
        items = by_page[page]
        # 带 y 中心
        enriched = []
        for w in items:
            loc = w.get("location") or {}
            y = float(loc.get("top") or 0) + float(loc.get("height") or 0) / 2
            x = float(loc.get("left") or 0)
            enriched.append((y, x, w))
        enriched.sort(key=lambda t: (t[0], t[1]))

        lines: list[list[tuple[float, float, dict]]] = []
        for y, x, w in enriched:
            if not lines:
                lines.append([(y, x, w)])
                continue
            last = lines[-1]
            ly = sum(t[0] for t in last) / len(last)
            if abs(y - ly) <= y_tol:
                lines[-1].append((y, x, w))
            else:
                lines.append([(y, x, w)])

        page_lines: list[str] = []
        for li, line in enumerate(lines):
            line.sort(key=lambda t: t[1])
            # 合并过近碎片；大间距用空格
            parts: list[str] = []
            prev_right = None
            for y, x, w in line:
                loc = w.get("location") or {}
                t = (w.get("text") or "").strip()
                if not t:
                    continue
                left = float(loc.get("left") or 0)
                width = float(loc.get("width") or 0)
                if prev_right is not None and left - prev_right > max_gap_x:
                    parts.append(" ")
                parts.append(t)
                prev_right = left + width
                ww = dict(w)
                ww["line_id"] = f"p{page}_l{li}"
                out_words.append(ww)
            if parts:
                # 去掉合并空格后的多余空白
                joined = re.sub(r"\s+", " ", "".join(parts)).strip()
                # 中文场景：去掉中文之间的空格
                joined = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", joined)
                joined = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[①②③④⑤⑥⑦⑧⑨⑩\d])", "", joined)
                joined = re.sub(r"(?<=[①②③④⑤⑥⑦⑧⑨⑩\d])\s+(?=[\u4e00-\u9fff])", "", joined)
                page_lines.append(joined)
        text_pages.append("\n".join(page_lines))

    return "\n\n".join(text_pages), out_words


def avg_prob_in_boxes(
    words: list[dict],
    boxes: list[dict] | None,
    *,
    default: float | None = None,
) -> float | None:
    """估计 bbox 区域内 OCR 词的平均置信度。"""
    if not words:
        return default
    probs: list[float] = []
    if not boxes:
        for w in words:
            p = w.get("prob_avg")
            if p is not None:
                try:
                    probs.append(float(p))
                except Exception:
                    pass
        return (sum(probs) / len(probs)) if probs else default

    for b in boxes:
        page = int(b.get("page") or 1)
        l, t = float(b.get("left") or 0), float(b.get("top") or 0)
        r = l + float(b.get("width") or 0)
        bot = t + float(b.get("height") or 0)
        for w in words:
            if int(w.get("page") or 1) != page:
                continue
            loc = w.get("location") or {}
            cx = float(loc.get("left") or 0) + float(loc.get("width") or 0) / 2
            cy = float(loc.get("top") or 0) + float(loc.get("height") or 0) / 2
            if l - 8 <= cx <= r + 8 and t - 8 <= cy <= bot + 8:
                p = w.get("prob_avg")
                if p is not None:
                    try:
                        probs.append(float(p))
                    except Exception:
                        pass
    if not probs:
        return default
    return sum(probs) / len(probs)
