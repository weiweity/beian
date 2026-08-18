"""
双页文案对比 · 红框 ROI（并排几何对齐）+ 区内 OCR

行业路径（用户突破口）：
  两面并排 → 同一套红框网格 → 框内 OCR → 框内多/少/错字 1:1

1. 几何红框模板（相对页宽高 %，两面共用同一格子）
2. 关键词锚点 refinement（框可微移，不改网格身份）
3. 区内裁块二次 OCR
4. 跨框不互比

功能区：
  claims / ingredients / usage / filing / footnote
"""
from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any

from PIL import Image

from app.baidu_ocr import ocr_image_bytes
from app.fields import normalize

ZONE_ORDER = (
    "claims",
    "ingredients",
    "usage",
    "filing",
    "footnote",
)

ZONE_LABELS = {
    "claims": "卖点/品名",
    "ingredients": "成分区",
    "usage": "用法/注意/贮存",
    "filing": "备案/生产/地址",
    "footnote": "脚注/扫码",
}

# 红框颜色（前端 CSS 同步）
ZONE_COLORS = {
    "claims": "#ef4444",
    "ingredients": "#f97316",
    "usage": "#eab308",
    "filing": "#22c55e",
    "footnote": "#3b82f6",
}

# 刀版通用几何红框：left,top,width,height 相对 0–1（全宽带 + 纵向分格）
# 两面同一套 → 并排放即可肉眼/机器一一对应
PACK_ROI_TEMPLATE: dict[str, dict[str, float]] = {
    "claims": {"left": 0.02, "top": 0.02, "width": 0.96, "height": 0.22},
    "ingredients": {"left": 0.02, "top": 0.20, "width": 0.96, "height": 0.34},
    "usage": {"left": 0.02, "top": 0.50, "width": 0.96, "height": 0.18},
    "filing": {"left": 0.02, "top": 0.64, "width": 0.96, "height": 0.22},
    "footnote": {"left": 0.02, "top": 0.82, "width": 0.96, "height": 0.16},
}

_ZONE_ANCHORS: dict[str, re.Pattern[str]] = {
    "claims": re.compile(
        r"产品名称|精研配方|馥郁香气|水润轻盈|Dr\.?\s*DH|达肤妍|雪绒花|注册商标|音译",
        re.I,
    ),
    "ingredients": re.compile(
        r"成分[：:]|其他微量|全成分|inci|甘油|提取物|LEONTOPOD|MICHELIA|CALENDULA|烟酰胺",
        re.I,
    ),
    "usage": re.compile(
        r"使用方法|贮存条件|储存条件|注意[：:]|若不慎|洗手后|轻柔按摩",
        re.I,
    ),
    "filing": re.compile(
        r"备案人|生产企业|许可证|执行标准|地址[：:]|化妆品生产|妆网备|批号|限期使用|产地",
        re.I,
    ),
    "footnote": re.compile(
        r"扫码关注|微信公众号|\*一朵|\*精油|\*产品销售|\*雪绒花|FSC|大豆油墨|亲环境|Packaging",
        re.I,
    ),
}


def _mid_y(w: dict) -> float:
    loc = w.get("location") or {}
    return float(loc.get("top") or 0) + float(loc.get("height") or 0) / 2


def _mid_x(w: dict) -> float:
    loc = w.get("location") or {}
    return float(loc.get("left") or 0) + float(loc.get("width") or 0) / 2


_PANEL_COLORS = (
    "#ef4444",
    "#f97316",
    "#eab308",
    "#22c55e",
    "#3b82f6",
    "#a855f7",
    "#ec4899",
    "#14b8a6",
)


def detect_vertical_panels(
    words: list[dict],
    *,
    page_w: int,
    page_h: int,
    max_panels: int = 6,
) -> dict[str, dict[str, Any]]:
    """
    竖栏切分（刀版多格同文、字号不同时更贴肉眼）：
    按词 x 中心 1D 聚类成竖条，每条一红框。
    """
    page_w = max(100, int(page_w or 2000))
    page_h = max(100, int(page_h or 2800))
    xs: list[float] = []
    for w in words or []:
        loc = w.get("location") or {}
        if not (loc.get("width") or loc.get("height")):
            continue
        t = (w.get("text") or "").strip()
        if len(t) < 1:
            continue
        xs.append(float(loc.get("left") or 0) + float(loc.get("width") or 0) / 2)
    if len(xs) < 8:
        return {}
    xs.sort()
    # 大间隙 = 栏缝
    gaps: list[tuple[float, int]] = []
    for i in range(1, len(xs)):
        gaps.append((xs[i] - xs[i - 1], i))
    gaps.sort(key=lambda t: -t[0])
    span = (xs[-1] - xs[0]) or 1.0
    min_gap = max(page_w * 0.04, span * 0.06)
    split_at = []
    for g, i in gaps:
        if g < min_gap:
            break
        if len(split_at) >= max_panels - 1:
            break
        split_at.append(i)
    if not split_at:
        return {}
    split_at = sorted(split_at)
    # 切点 x 边界
    bounds = [0.0]
    for i in split_at:
        bounds.append((xs[i - 1] + xs[i]) / 2)
    bounds.append(float(page_w))
    zones: dict[str, dict[str, Any]] = {}
    for pi in range(len(bounds) - 1):
        left = max(0, int(bounds[pi] - page_w * 0.005))
        right = min(page_w, int(bounds[pi + 1] + page_w * 0.005))
        if right - left < page_w * 0.08:
            continue
        zid = f"panel_{pi + 1}"
        zones[zid] = {
            "name": zid,
            "label": f"竖栏{pi + 1}",
            "color": _PANEL_COLORS[pi % len(_PANEL_COLORS)],
            "left": left,
            "top": int(page_h * 0.02),
            "width": max(1, right - left),
            "height": int(page_h * 0.96),
            "y0": int(page_h * 0.02),
            "y1": int(page_h * 0.98),
            "keywords_hit": 0,
            "source": "vertical_panel",
            "ratio": {
                "left": left / page_w,
                "top": 0.02,
                "width": (right - left) / page_w,
                "height": 0.96,
            },
        }
    return zones if len(zones) >= 2 else {}


def apply_roi_template(
    page_w: int,
    page_h: int,
    template: dict[str, dict[str, float]] | None = None,
) -> dict[str, dict[str, Any]]:
    """
    几何红框：两面共用同一比例网格。
    """
    page_w = max(100, int(page_w or 2000))
    page_h = max(100, int(page_h or 2800))
    tpl = template or PACK_ROI_TEMPLATE
    zones: dict[str, dict[str, Any]] = {}
    for z in ZONE_ORDER:
        r = tpl.get(z) or PACK_ROI_TEMPLATE[z]
        left = int(page_w * float(r["left"]))
        top = int(page_h * float(r["top"]))
        width = max(1, int(page_w * float(r["width"])))
        height = max(1, int(page_h * float(r["height"])))
        # 裁进页内
        if left + width > page_w:
            width = page_w - left
        if top + height > page_h:
            height = page_h - top
        zones[z] = {
            "name": z,
            "label": ZONE_LABELS.get(z, z),
            "color": ZONE_COLORS.get(z, "#ef4444"),
            "left": left,
            "top": top,
            "width": width,
            "height": height,
            "y0": top,
            "y1": top + height,
            "keywords_hit": 0,
            "source": "red_box_template",
            "ratio": dict(r),
        }
    return zones


def refine_zones_with_anchors(
    zones: dict[str, dict[str, Any]],
    words: list[dict],
    *,
    page_w: int,
    page_h: int,
    max_shift_ratio: float = 0.08,
) -> dict[str, dict[str, Any]]:
    """
    在红框网格内用关键词微调 top/height（最多移动页高 8%），
    保持「同一套格子」身份，避免跨区乱漂。
    """
    page_w = max(100, int(page_w))
    page_h = max(100, int(page_h))
    max_shift = int(page_h * max_shift_ratio)
    hits: dict[str, list[dict]] = {z: [] for z in ZONE_ORDER}
    for w in words or []:
        t = w.get("text") or ""
        loc = w.get("location") or {}
        if not (loc.get("width") or loc.get("height")):
            continue
        for z, pat in _ZONE_ANCHORS.items():
            if pat.search(t):
                hits[z].append(w)

    out = {k: dict(v) for k, v in zones.items()}
    for z in ZONE_ORDER:
        ws = hits[z]
        if not ws:
            continue
        z0 = out[z]
        tops = [float((w.get("location") or {}).get("top") or 0) for w in ws]
        bots = [
            float((w.get("location") or {}).get("top") or 0)
            + float((w.get("location") or {}).get("height") or 0)
            for w in ws
        ]
        pad_y0 = max(20, int(page_h * 0.012))
        pad_y1 = max(40, int(page_h * 0.04))
        if z == "ingredients":
            pad_y1 = max(pad_y1, int(page_h * 0.08))
        new_top = max(0, int(min(tops) - pad_y0))
        new_bot = min(page_h, int(max(bots) + pad_y1))
        # 限制相对模板的漂移
        old_top = int(z0["top"])
        old_bot = old_top + int(z0["height"])
        if abs(new_top - old_top) > max_shift:
            new_top = old_top + max_shift if new_top > old_top else old_top - max_shift
            new_top = max(0, new_top)
        if abs(new_bot - old_bot) > max_shift * 1.5:
            new_bot = old_bot + int(max_shift * 1.5) if new_bot > old_bot else old_bot - int(
                max_shift * 1.5
            )
            new_bot = min(page_h, max(new_top + 40, new_bot))
        z0["top"] = new_top
        z0["height"] = max(40, new_bot - new_top)
        z0["y0"] = new_top
        z0["y1"] = new_top + z0["height"]
        z0["keywords_hit"] = len(ws)
        z0["source"] = "red_box+anchor"
        # 全宽保持
        z0["left"] = min(int(z0["left"]), int(page_w * 0.02))
        z0["width"] = max(int(z0["width"]), int(page_w * 0.96))
        if z0["left"] + z0["width"] > page_w:
            z0["width"] = page_w - z0["left"]
    return out


def detect_dual_zones(
    words: list[dict],
    *,
    page_w: int = 2000,
    page_h: int = 2800,
    template: dict[str, dict[str, float]] | None = None,
    prefer_vertical: bool = True,
) -> dict[str, dict[str, Any]]:
    """
    红框：
    1) 优先竖栏（多格同文、字号不同 — 用户观察）
    2) 否则横带功能区模板 + 锚点微调
    """
    if prefer_vertical:
        panels = detect_vertical_panels(words, page_w=page_w, page_h=page_h)
        if len(panels) >= 2:
            return panels
    zones = apply_roi_template(page_w, page_h, template=template)
    return refine_zones_with_anchors(zones, words, page_w=page_w, page_h=page_h)


def zones_for_frontend(
    zones: dict[str, dict[str, Any]],
    *,
    page_w: int,
    page_h: int,
    side: str = "a",
) -> list[dict[str, Any]]:
    """前端叠红框用（含归一化坐标便于不同分辨率）。"""
    page_w = max(1, int(page_w or 1))
    page_h = max(1, int(page_h or 1))
    boxes = []
    # 竖栏 panel_* 或 功能区 ZONE_ORDER
    keys = list(zones.keys())
    if any(str(k).startswith("panel_") for k in keys):
        keys = sorted(keys, key=lambda k: int(re.search(r"\d+", k).group()) if re.search(r"\d+", k) else 0)
    else:
        keys = [z for z in ZONE_ORDER if z in zones] or keys
    for z in keys:
        b = zones.get(z) or {}
        if not b:
            continue
        left = float(b.get("left") or 0)
        top = float(b.get("top") or 0)
        width = float(b.get("width") or 0)
        height = float(b.get("height") or 0)
        boxes.append(
            {
                "id": z,
                "zone": z,
                "label": b.get("label") or ZONE_LABELS.get(z, z),
                "color": b.get("color") or ZONE_COLORS.get(z, "#ef4444"),
                "side": side,
                "left": left,
                "top": top,
                "width": width,
                "height": height,
                "nx": left / page_w,
                "ny": top / page_h,
                "nw": width / page_w,
                "nh": height / page_h,
                "source": b.get("source"),
                "keywords_hit": b.get("keywords_hit") or 0,
            }
        )
    return boxes


def words_in_box(words: list[dict], box: dict[str, Any], *, pad: float = 8) -> list[dict]:
    l = float(box.get("left") or 0) - pad
    t = float(box.get("top") or 0) - pad
    r = l + float(box.get("width") or 0) + 2 * pad
    b = t + float(box.get("height") or 0) + 2 * pad
    out = []
    for w in words or []:
        cx, cy = _mid_x(w), _mid_y(w)
        if l <= cx <= r and t <= cy <= b:
            out.append(w)
    return out


def text_from_words(words: list[dict]) -> str:
    ordered = sorted(
        words or [],
        key=lambda w: (
            int((w.get("location") or {}).get("top") or 0),
            int((w.get("location") or {}).get("left") or 0),
        ),
    )
    return "\n".join((w.get("text") or "").strip() for w in ordered if (w.get("text") or "").strip())


def crop_zone_ocr(
    image_path: str | Path,
    box: dict[str, Any],
    *,
    page: int = 1,
    zone: str = "",
    scale: float = 1.5,
) -> tuple[str, list[dict], dict]:
    """
    P1：裁 ROI → 放大 → accurate OCR → 坐标平移回全图。
    """
    path = Path(image_path)
    meta: dict[str, Any] = {"zone": zone, "ok": False}
    if not path.exists():
        return "", [], {**meta, "error": "no_image"}
    try:
        im = Image.open(path).convert("RGB")
        pw, ph = im.size
        left = max(0, int(box.get("left") or 0))
        top = max(0, int(box.get("top") or 0))
        right = min(pw, left + int(box.get("width") or 0))
        bot = min(ph, top + int(box.get("height") or 0))
        if right - left < 40 or bot - top < 40:
            return "", [], {**meta, "error": "box_too_small"}
        crop = im.crop((left, top, right, bot))
        if scale and scale != 1.0:
            nw = max(1, int(crop.width * scale))
            nh = max(1, int(crop.height * scale))
            crop = crop.resize((nw, nh), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        crop.save(buf, format="PNG")
        text, words, info = ocr_image_bytes(
            buf.getvalue(), with_location=True, paragraph=True
        )
        # 坐标回全图
        sx = (right - left) / max(1, crop.width)
        sy = (bot - top) / max(1, crop.height)
        out_w: list[dict] = []
        for w in words:
            loc = w.get("location") or {}
            ww = dict(w)
            ww["page"] = page
            ww["zone"] = zone
            ww["para_source"] = w.get("para_source") or "zone_crop"
            if w.get("paragraph_id") is not None:
                # 区前缀避免串段
                try:
                    off = abs(hash(zone)) % 500
                    ww["paragraph_id"] = int(w["paragraph_id"]) + off * 10
                except Exception:
                    pass
            ww["location"] = {
                "left": int(left + float(loc.get("left") or 0) * sx),
                "top": int(top + float(loc.get("top") or 0) * sy),
                "width": max(1, int(float(loc.get("width") or 0) * sx)),
                "height": max(1, int(float(loc.get("height") or 0) * sy)),
            }
            out_w.append(ww)
        meta.update(
            {
                "ok": True,
                "api": info.get("api"),
                "words": len(out_w),
                "text_len": len(text or ""),
                "paragraphs": info.get("paragraphs_result_num")
                or len(info.get("paragraphs") or []),
                "box": {
                    "left": left,
                    "top": top,
                    "width": right - left,
                    "height": bot - top,
                },
                "scale": scale,
            }
        )
        return text or "", out_w, meta
    except Exception as e:
        return "", [], {**meta, "error": str(e)[:160]}


def build_zone_corpus(
    image_path: str | Path | None,
    words_full: list[dict],
    text_full: str,
    zones: dict[str, dict[str, Any]],
    *,
    page: int = 1,
    do_crop_ocr: bool = True,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """
    每区：全页词落入框 + 可选裁块二次 OCR 合并。
    返回 (zone_data, meta)
    zone_data[z] = {text, words, box, label, crop_meta?}
    """
    out: dict[str, dict[str, Any]] = {}
    crop_metas: list[dict] = []
    zone_keys = list(zones.keys()) if zones else list(ZONE_ORDER)
    if any(str(k).startswith("panel_") for k in zone_keys):
        zone_keys = sorted(
            zone_keys,
            key=lambda k: int(re.search(r"\d+", str(k)).group())
            if re.search(r"\d+", str(k))
            else 0,
        )
    else:
        zone_keys = [z for z in ZONE_ORDER if z in zones] or zone_keys
    for z in zone_keys:
        box = zones.get(z) or {}
        if not box:
            continue
        base_w = words_in_box(words_full, box)
        base_t = text_from_words(base_w)
        crop_t, crop_w, cmeta = "", [], {"ok": False, "zone": z, "skipped": True}
        if do_crop_ocr and image_path and box.get("width"):
            crop_t, crop_w, cmeta = crop_zone_ocr(
                image_path, box, page=page, zone=z, scale=1.5
            )
            crop_metas.append(cmeta)
        # 合并：裁块优先（密字），全页词补漏
        merged_words = list(crop_w) if crop_w else []
        seen = {
            (
                normalize(w.get("text") or ""),
                int((w.get("location") or {}).get("top") or 0) // 8,
                int((w.get("location") or {}).get("left") or 0) // 8,
            )
            for w in merged_words
        }
        for w in base_w:
            key = (
                normalize(w.get("text") or ""),
                int((w.get("location") or {}).get("top") or 0) // 8,
                int((w.get("location") or {}).get("left") or 0) // 8,
            )
            if key in seen:
                continue
            ww = dict(w)
            ww["zone"] = z
            merged_words.append(ww)
            seen.add(key)
        # 文本：裁块段 + 框内全文
        parts = []
        if crop_t and len(crop_t.strip()) >= 8:
            parts.append(crop_t.strip())
        if base_t and len(base_t.strip()) >= 8:
            parts.append(base_t.strip())
        # 仍空：从全文用锚点抽（弱兜底）
        if not parts and text_full:
            parts.append(_snippet_by_zone_keywords(text_full, z))
        ztext = "\n".join(parts)
        out[z] = {
            "name": z,
            "label": box.get("label") or ZONE_LABELS.get(z, z),
            "text": ztext,
            "words": merged_words,
            "box": {
                "left": box.get("left"),
                "top": box.get("top"),
                "width": box.get("width"),
                "height": box.get("height"),
            },
            "keywords_hit": box.get("keywords_hit"),
            "source": box.get("source"),
            "crop": cmeta,
        }
    meta = {
        "crop_ok": sum(1 for m in crop_metas if m.get("ok")),
        "crop_total": len(crop_metas),
        "crops": crop_metas,
        "zone_keys": zone_keys,
    }
    return out, meta


def _snippet_by_zone_keywords(text: str, zone: str) -> str:
    pat = _ZONE_ANCHORS.get(zone)
    if not pat or not text:
        return ""
    lines = []
    for ln in re.split(r"[\n\r]+", text):
        if pat.search(ln):
            lines.append(ln.strip())
    return "\n".join(lines[:40])


def compare_dual_page_by_zones(
    *,
    image_a: str | Path | None,
    image_b: str | Path | None,
    words_a: list[dict],
    words_b: list[dict],
    text_a: str,
    text_b: str,
    label_a: str = "面1",
    label_b: str = "面2",
    page_w_a: int = 2000,
    page_h_a: int = 2800,
    page_w_b: int = 2000,
    page_h_b: int = 2800,
    do_crop_ocr: bool = True,
) -> tuple[list[dict], dict[str, Any]]:
    """
    分区比对主路径。
    返回 (hits, pipeline_meta)
    """
    from app.cross_spec import compare_pdf_internal_1to1

    # 优先竖栏；A 侧定格后按比例套到 B（两面同一套格子）
    zones_a = detect_dual_zones(words_a, page_w=page_w_a, page_h=page_h_a)
    if any(str(k).startswith("panel_") for k in zones_a.keys()):
        # B 用 A 的相对比例，保证一一对应
        zones_b = {}
        for z, box in zones_a.items():
            r = box.get("ratio") or {}
            zones_b[z] = {
                **box,
                "left": int(page_w_b * float(r.get("left") or 0)),
                "top": int(page_h_b * float(r.get("top") or 0.02)),
                "width": max(1, int(page_w_b * float(r.get("width") or 0.2))),
                "height": max(1, int(page_h_b * float(r.get("height") or 0.96))),
                "y0": int(page_h_b * float(r.get("top") or 0.02)),
                "y1": int(
                    page_h_b
                    * (
                        float(r.get("top") or 0.02)
                        + float(r.get("height") or 0.96)
                    )
                ),
            }
    else:
        zones_b = detect_dual_zones(words_b, page_w=page_w_b, page_h=page_h_b)

    corpus_a, meta_a = build_zone_corpus(
        image_a, words_a, text_a, zones_a, page=1, do_crop_ocr=do_crop_ocr
    )
    corpus_b, meta_b = build_zone_corpus(
        image_b, words_b, text_b, zones_b, page=1, do_crop_ocr=do_crop_ocr
    )
    red_boxes_a = zones_for_frontend(zones_a, page_w=page_w_a, page_h=page_h_a, side="a")
    red_boxes_b = zones_for_frontend(zones_b, page_w=page_w_b, page_h=page_h_b, side="b")

    all_hits: list[dict] = []
    zone_stats: list[dict] = []
    n_ok = n_diff = n_miss = 0
    content_hits: list[dict] = []

    zone_keys = meta_a.get("zone_keys") or list(zones_a.keys())
    for z in zone_keys:
        ca = corpus_a.get(z) or {}
        cb = corpus_b.get(z) or {}
        ta = (ca.get("text") or "").strip()
        tb = (cb.get("text") or "").strip()
        z_label = ca.get("label") or cb.get("label") or ZONE_LABELS.get(z, z)
        # 两侧都几乎空 → 跳过
        if len(normalize(ta)) < 8 and len(normalize(tb)) < 8:
            zone_stats.append(
                {
                    "zone": z,
                    "label": z_label,
                    "skipped": True,
                    "reason": "both_empty",
                }
            )
            continue
        la = f"{label_a}·{z_label}"
        lb = f"{label_b}·{z_label}"
        zh = compare_pdf_internal_1to1(
            ta or "（本区无字）",
            tb or "（本区无字）",
            words_a=ca.get("words") or [],
            words_b=cb.get("words") or [],
            label_a=la,
            label_b=lb,
        )
        # 剥掉子 overview/stats，内容 hits 打 zone 标记
        z_ok = z_diff = z_miss = 0
        for h in zh:
            cat = h.get("category")
            if cat in ("overview", "stats"):
                if cat == "stats":
                    ev = h.get("excel_value") or ""
                    # 粗提
                    m = re.search(r"一致=(\d+).*字差=(\d+).*未对上=(\d+)", ev)
                    if m:
                        z_ok, z_diff, z_miss = int(m.group(1)), int(m.group(2)), int(m.group(3))
                continue
            h = dict(h)
            h["zone"] = z
            h["zone_label"] = z_label
            # field 加区前缀（序号稍后全局重排）
            fl = h.get("field") or ""
            fl = re.sub(r"^#\d+\s*·\s*", "", fl)
            h["field"] = f"[{z_label}] {fl}"
            h["id"] = f"{z}_{h.get('id')}"
            content_hits.append(h)
            if cat == "aligned":
                z_ok += 1
            elif cat == "issue":
                z_diff += 1
            elif cat == "unmatched":
                z_miss += 1
        n_ok += z_ok
        n_diff += z_diff
        n_miss += z_miss
        zone_stats.append(
            {
                "zone": z,
                "label": z_label,
                "skipped": False,
                "aligned": z_ok,
                "diff": z_diff,
                "unmatched": z_miss,
                "text_len_a": len(ta),
                "text_len_b": len(tb),
                "crop_a": (ca.get("crop") or {}).get("ok"),
                "crop_b": (cb.get("crop") or {}).get("ok"),
                "box_a": ca.get("box"),
                "box_b": cb.get("box"),
            }
        )

    # 全局阅读序：按区顺序 + 原 read_order
    z_rank = {z: i for i, z in enumerate(zone_keys)}

    def _sk(h: dict) -> tuple:
        zr = z_rank.get(h.get("zone") or "", 99)
        key = h.get("read_order_key")
        if isinstance(key, list) and key:
            return (zr,) + tuple(key)
        return (zr, 0, 0, 0, h.get("id") or "")

    content_hits.sort(key=_sk)
    for seq, h in enumerate(content_hits, 1):
        h["seq"] = seq
        fl = re.sub(r"^#\d+\s*·\s*", "", h.get("field") or "")
        # 保留 [区] 前缀
        h["field"] = f"#{seq} · {fl}"

    overview_status = "一致" if not n_diff and not n_miss else "疑点"
    overview_score = 100.0 - min(n_diff * 6 + n_miss * 8, 55)
    zones_done = [s for s in zone_stats if not s.get("skipped")]
    crop_ok = (meta_a.get("crop_ok") or 0) + (meta_b.get("crop_ok") or 0)

    md_lines = [
        f"# 红框对照 · {label_a} ↔ {label_b}",
        "",
        f"路径：并排红框网格 · 框内裁块 OCR · 框数 {len(zones_done)} · 裁块成功 {crop_ok}",
        "",
    ]
    for s in zone_stats:
        if s.get("skipped"):
            md_lines.append(f"- **{s['label']}**：跳过（两侧空）")
        else:
            md_lines.append(
                f"- **{s['label']}**：一致 {s.get('aligned', 0)} · "
                f"字差 {s.get('diff', 0)} · 未对上 {s.get('unmatched', 0)} · "
                f"字数 {s.get('text_len_a')}/{s.get('text_len_b')}"
            )
    md = "\n".join(md_lines)

    hits: list[dict] = [
        {
            "id": "overview",
            "field": "双页总览 · 分区比对",
            "excel_value": f"{label_a} ↔ {label_b}",
            "status": overview_status,
            "evidence": (
                f"红框ROI并排路径 · 对齐 {n_ok} · 字差需审 {n_diff} · 未对上需审 {n_miss} · "
                f"红框 {len(zones_done)}/{len(zone_keys)} · 框内裁块OCR {crop_ok} · "
                f"{'竖栏' if any(str(k).startswith('panel_') for k in zone_keys) else '功能区'}同格·跨框不比"
            ),
            "score": overview_score,
            "decision": "pending",
            "bboxes": [],
            "bboxes_b": [],
            "page": 1,
            "category": "overview",
            "doubt_bucket": None if overview_status == "一致" else "coverage",
            "layout_blocks": {
                "a": _zone_blocks(corpus_a),
                "b": _zone_blocks(corpus_b),
            },
            "compare_md": md,
            "zone_stats": zone_stats,
        },
        {
            "id": "stats",
            "field": "分区对齐统计",
            "excel_value": (
                f"一致={n_ok} · 字差={n_diff} · 未对上={n_miss} · "
                f"区={','.join(s['label'] for s in zones_done)} · 裁块={crop_ok}"
            ),
            "status": overview_status,
            "evidence": (
                f"{label_a}/{label_b} · 两面同一套红框网格并排对齐；"
                f"框内 OCR+多/少/错字；跨框不互比；须人审真差"
            ),
            "score": overview_score,
            "decision": "pending",
            "bboxes": [],
            "bboxes_b": [],
            "page": 1,
            "category": "stats",
        },
    ]
    hits.extend(content_hits)

    pipeline = {
        "mode": "red_box_roi",
        "template": "pack_roi_v1",
        "zones_a": {
            k: {kk: vv for kk, vv in v.items() if kk != "words"}
            for k, v in zones_a.items()
        },
        "zones_b": {
            k: {kk: vv for kk, vv in v.items() if kk != "words"}
            for k, v in zones_b.items()
        },
        "red_boxes_a": red_boxes_a,
        "red_boxes_b": red_boxes_b,
        "zone_stats": zone_stats,
        "crop_a": meta_a,
        "crop_b": meta_b,
        "page_size": {
            "a": {"w": page_w_a, "h": page_h_a},
            "b": {"w": page_w_b, "h": page_h_b},
        },
        "corpus_lens": {
            "a": {z: len((corpus_a.get(z) or {}).get("text") or "") for z in zone_keys},
            "b": {z: len((corpus_b.get(z) or {}).get("text") or "") for z in zone_keys},
        },
        "cut_mode": "vertical_panel"
        if any(str(k).startswith("panel_") for k in zone_keys)
        else "horizontal_zone",
    }
    # 挂 layout meta
    hits[0]["_layout_meta"] = {
        "blocks_a": _zone_blocks(corpus_a),
        "blocks_b": _zone_blocks(corpus_b),
        "markdown": md,
        "zone_pipeline": pipeline,
    }
    return hits, pipeline


def _zone_blocks(corpus: dict[str, dict]) -> list[dict]:
    blocks = []
    keys = list(corpus.keys())
    if any(str(k).startswith("panel_") for k in keys):
        keys = sorted(
            keys,
            key=lambda k: int(re.search(r"\d+", str(k)).group())
            if re.search(r"\d+", str(k))
            else 0,
        )
    for i, z in enumerate(keys):
        c = corpus.get(z) or {}
        t = (c.get("text") or "").strip()
        if not t:
            continue
        box = c.get("box") or {}
        for j, ln in enumerate(re.split(r"[\n\r]+", t)[:12]):
            ln = ln.strip()
            if len(normalize(ln)) < 6:
                continue
            blocks.append(
                {
                    "text": ln[:200],
                    "side": "a",
                    "zone": z,
                    "column": i,
                    "left": float(box.get("left") or 0),
                    "top": float(box.get("top") or 0) + j * 12,
                    "width": float(box.get("width") or 0),
                    "height": 12,
                    "order": len(blocks),
                    "source": "zone_roi",
                }
            )
    return blocks
