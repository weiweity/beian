"""
版面优先 · 跨行语义单元聚类（行业做法的可落地子集）

优先级：
1. 百度 OCR paragraph=true → paragraphs_result（行序号聚段）
2. 几何规则：分栏 → 栏内按行距/缩进/锚点切断 → 段
3. 文本半句粘连（旧 merge_ocr_lines_for_align）作最后兜底

比对粒度 = 段/功能块，不是 OCR 物理行。
"""
from __future__ import annotations

import re
from typing import Any

from app.fields import normalize

# 新段起点（包装文案常见标签）
ANCHOR_START = re.compile(
    r"^(?:"
    r"产品名称|使用方法|使用说明|贮存条件|储存条件|备案人|生产企业|生产许可证|"
    r"执行标准|成分|全成分|注意事项|注意|警告|扫码|净含量|保质期|生产日期|"
    r"其他微量|功效|适用|致敏|本产品|"
    r"\*|·|【|［|\["
    r")"
)
SENTENCE_END = re.compile(r"[。！？；;…]$")


def _join_parts(parts: list[str]) -> str:
    raw = [p.strip() for p in parts if (p or "").strip()]
    if not raw:
        return ""
    if all(re.fullmatch(r"[A-Za-z0-9\s\.\-/%°]+", p or "") for p in raw):
        s = " ".join(raw)
    else:
        s = "".join(raw)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", s)
    return s


def paragraphs_from_baidu_words(words: list[dict]) -> list[dict[str, Any]]:
    """从已打 paragraph_id 的 words 重建段列表。"""
    if not words:
        return []
    by_id: dict[int, list[dict]] = {}
    for w in words:
        if w.get("paragraph_id") is None:
            continue
        if w.get("para_source") and w.get("para_source") != "baidu":
            # 仍接受 baidu 或未标
            pass
        pid = int(w["paragraph_id"])
        by_id.setdefault(pid, []).append(w)
    if not by_id:
        return []
    out: list[dict[str, Any]] = []
    for pid in sorted(by_id.keys()):
        group = sorted(
            by_id[pid],
            key=lambda w: (
                int((w.get("location") or {}).get("top") or 0),
                int((w.get("location") or {}).get("left") or 0),
            ),
        )
        text = _join_parts([w.get("text") or "" for w in group])
        if len(normalize(text)) < 2:
            continue
        locs = [w.get("location") or {} for w in group]
        lefts = [float(l.get("left") or 0) for l in locs]
        tops = [float(l.get("top") or 0) for l in locs]
        rights = [
            float(l.get("left") or 0) + float(l.get("width") or 0) for l in locs
        ]
        bots = [
            float(l.get("top") or 0) + float(l.get("height") or 0) for l in locs
        ]
        out.append(
            {
                "text": text,
                "source": "baidu",
                "paragraph_id": pid,
                "left": min(lefts) if lefts else 0,
                "top": min(tops) if tops else 0,
                "width": (max(rights) - min(lefts)) if lefts else 0,
                "height": (max(bots) - min(tops)) if tops else 0,
                "line_count": len(group),
            }
        )
    return out


def _detect_columns(line_centers: list[float]) -> list[float]:
    """
    1D 分栏：在排序后的 x 中心找最大间隙；包装双栏常见。
    最多保留 4 栏，过密则单栏。
    """
    if not line_centers:
        return []
    xs = sorted(line_centers)
    if len(xs) == 1:
        return [xs[0]]
    span = (xs[-1] - xs[0]) or 1.0
    # 找最大间隙
    gaps: list[tuple[float, int]] = []
    for i in range(1, len(xs)):
        gaps.append((xs[i] - xs[i - 1], i))
    gaps.sort(key=lambda t: -t[0])
    # 间隙需足够大才分栏（至少页宽 15% 或 90px）
    min_gap = max(90.0, span * 0.15)
    split_idxs = []
    for g, i in gaps:
        if g < min_gap:
            break
        if len(split_idxs) >= 3:  # 最多 4 栏 → 3 个切点
            break
        split_idxs.append(i)
    if not split_idxs:
        # 回退：固定阈值
        thr = max(90.0, span * 0.22)
        clusters: list[list[float]] = [[xs[0]]]
        for x in xs[1:]:
            if x - clusters[-1][-1] > thr:
                clusters.append([x])
            else:
                clusters[-1].append(x)
        return [sum(c) / len(c) for c in clusters]
    split_idxs = sorted(split_idxs)
    clusters = []
    prev = 0
    for i in split_idxs:
        chunk = xs[prev:i]
        if chunk:
            clusters.append(chunk)
        prev = i
    chunk = xs[prev:]
    if chunk:
        clusters.append(chunk)
    return [sum(c) / len(c) for c in clusters if c]


def _lines_from_words(
    words: list[dict],
    *,
    y_tol: float = 16.0,
    max_x_gap: float = 80.0,
) -> list[dict]:
    """
    词 → 物理行（同行 y 近）。
    关键：同 y 但 x 间距过大（跨栏）→ 拆成多行，避免左右栏糊成一行。
    """
    enriched = []
    for w in words:
        loc = w.get("location") or {}
        t = (w.get("text") or "").strip()
        if not t:
            continue
        y = float(loc.get("top") or 0) + float(loc.get("height") or 0) / 2
        x = float(loc.get("left") or 0)
        h = max(8.0, float(loc.get("height") or 14))
        wth = float(loc.get("width") or 0)
        enriched.append((y, x, h, wth, t, w))
    if not enriched:
        return []
    enriched.sort(key=lambda t: (t[0], t[1]))
    # 先按 y 聚类，再按 x 大间隙拆栏
    y_groups: list[list] = []
    for item in enriched:
        if not y_groups:
            y_groups.append([item])
            continue
        ly = sum(x[0] for x in y_groups[-1]) / len(y_groups[-1])
        if abs(item[0] - ly) <= y_tol:
            y_groups[-1].append(item)
        else:
            y_groups.append([item])

    # 估计全局栏间隙阈值
    all_x = sorted(e[1] for e in enriched)
    span = (all_x[-1] - all_x[0]) if len(all_x) > 1 else 1.0
    x_gap_thr = max(max_x_gap, span * 0.12)

    lines: list[dict] = []
    for yg in y_groups:
        yg.sort(key=lambda t: t[1])
        # 按 x 大间隙切成同栏碎片
        segs: list[list] = [[yg[0]]]
        for item in yg[1:]:
            prev = segs[-1][-1]
            prev_right = prev[1] + prev[3]
            gap = item[1] - prev_right
            if gap > x_gap_thr:
                segs.append([item])
            else:
                segs[-1].append(item)
        for lb in segs:
            text = _join_parts([x[4] for x in lb])
            left = min(x[1] for x in lb)
            top = min(x[0] - x[2] / 2 for x in lb)
            right = max(x[1] + x[3] for x in lb)
            bot = max(x[0] + x[2] / 2 for x in lb)
            h = max(8.0, bot - top)
            lines.append(
                {
                    "text": text,
                    "left": left,
                    "top": top,
                    "width": max(1.0, right - left),
                    "height": h,
                    "cx": (left + right) / 2,
                    "cy": (top + bot) / 2,
                }
            )
    return lines


def paragraphs_from_geometry(
    words: list[dict],
    *,
    max_para_len: int = 120,
) -> list[dict[str, Any]]:
    """
    几何聚段：分栏 → 栏内按行距合并 → 锚点/句末切断。
    """
    lines = _lines_from_words(words)
    if not lines:
        return []
    cols = _detect_columns([ln["cx"] for ln in lines])
    for ln in lines:
        if cols:
            ln["column"] = min(
                range(len(cols)), key=lambda i: abs(cols[i] - ln["cx"])
            )
        else:
            ln["column"] = 0

    # 中位行高 → 行距阈值
    heights = sorted(ln["height"] for ln in lines)
    med_h = heights[len(heights) // 2] if heights else 16.0
    gap_thr = med_h * 1.65

    paragraphs: list[dict[str, Any]] = []
    for col in sorted({int(ln["column"]) for ln in lines}):
        col_lines = [ln for ln in lines if int(ln["column"]) == col]
        col_lines.sort(key=lambda ln: (ln["top"], ln["left"]))
        buf: list[dict] = []

        def flush(col_id: int = col) -> None:
            nonlocal buf
            if not buf:
                return
            text = _join_parts([b["text"] for b in buf])
            if len(normalize(text)) < 2:
                buf = []
                return
            left = min(b["left"] for b in buf)
            top = min(b["top"] for b in buf)
            right = max(b["left"] + b["width"] for b in buf)
            bot = max(b["top"] + b["height"] for b in buf)
            paragraphs.append(
                {
                    "text": text,
                    "source": "geometry",
                    "column": col_id,
                    "left": left,
                    "top": top,
                    "width": right - left,
                    "height": bot - top,
                    "line_count": len(buf),
                }
            )
            buf = []

        for ln in col_lines:
            if not buf:
                buf = [ln]
                continue
            prev = buf[-1]
            gap = ln["top"] - (prev["top"] + prev["height"])
            # 同行多块（左右碎词）gap 可能为负
            if gap < -med_h * 0.3:
                # 几乎同行：按 left 已排序，粘上
                buf.append(ln)
                continue
            indent_jump = abs(ln["left"] - prev["left"]) > max(
                48.0, prev["width"] * 0.4
            )
            buf_text = _join_parts([b["text"] for b in buf])
            new_anchor = bool(ANCHOR_START.match((ln["text"] or "").strip()))
            prev_ended = bool(SENTENCE_END.search((prev["text"] or "").strip()))
            too_long = len(buf_text) + len(ln["text"] or "") > max_para_len
            # 行距过大 / 新锚点 / 上句已结束且有明显空隙
            should_break = (
                gap > gap_thr
                or new_anchor
                or (prev_ended and gap > med_h * 0.55)
                or too_long
                or (indent_jump and gap > med_h * 0.8)
            )
            if should_break:
                flush(col)
                buf = [ln]
            else:
                buf.append(ln)
        flush(col)

    # 阅读序：栏左→右，栏内上→下
    paragraphs.sort(
        key=lambda p: (
            int(p.get("column") or 0),
            float(p.get("top") or 0),
            float(p.get("left") or 0),
        )
    )
    for i, p in enumerate(paragraphs):
        p["order"] = i
        p["paragraph_id"] = i
    return paragraphs


def build_semantic_units(
    words: list[dict] | None,
    text: str = "",
    *,
    max_n: int = 48,
    side: str = "a",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """
    行业路径：百度段 → 几何段 → 文本粘连单元。
    返回 (units, meta)。
    unit: {text,left,top,width,height,column,source,order}
    """
    words = words or []
    meta: dict[str, Any] = {"source": None, "n": 0}

    paras = paragraphs_from_baidu_words(words)
    if len(paras) >= 2 or (len(paras) == 1 and len(normalize(paras[0]["text"])) >= 20):
        # 百度段可能无 column：补分栏
        centers = [
            float(p["left"]) + float(p.get("width") or 0) / 2 for p in paras
        ]
        cols = _detect_columns(centers)
        for p in paras:
            cx = float(p["left"]) + float(p.get("width") or 0) / 2
            p["column"] = (
                min(range(len(cols)), key=lambda i: abs(cols[i] - cx))
                if cols
                else 0
            )
            p["side"] = side
        paras.sort(
            key=lambda p: (
                int(p.get("column") or 0),
                float(p.get("top") or 0),
                float(p.get("left") or 0),
            )
        )
        for i, p in enumerate(paras):
            p["order"] = i
        units = paras[:max_n]
        meta = {
            "source": "baidu_paragraph",
            "n": len(units),
            "baidu_n": len(paras),
        }
        return units, meta

    geo = paragraphs_from_geometry(words)
    if geo:
        for p in geo:
            p["side"] = side
        units = geo[:max_n]
        meta = {"source": "geometry", "n": len(units)}
        return units, meta

    # 兜底：文本半句粘连
    from app.cross_spec import extract_align_units, merge_ocr_lines_for_align

    merged = merge_ocr_lines_for_align(text or "")
    texts = extract_align_units(merged, max_n=max_n)
    units = []
    for i, t in enumerate(texts):
        units.append(
            {
                "text": t,
                "source": "text_merge",
                "side": side,
                "left": 0,
                "top": i * 20,
                "width": 0,
                "height": 0,
                "column": 0,
                "order": i,
            }
        )
    meta = {"source": "text_merge", "n": len(units)}
    return units, meta


def units_to_compare_text(units: list[dict]) -> str:
    """段列表 → 换行文本（段已内粘，不再跨行碎）。"""
    return "\n".join((u.get("text") or "").strip() for u in units if (u.get("text") or "").strip())
