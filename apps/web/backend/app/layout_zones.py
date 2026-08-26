"""
版面分区 ROI（护肤品包装）

根据 OCR 词位置启发式划分：
- claims：卖点/品名区（偏上）
- ingredients：成分表
- usage：使用方法
- process：工艺说明/版本表（偏下，反向不扫）
"""
from __future__ import annotations

import re
from typing import Any


def _mid_y(w: dict) -> float:
    loc = w.get("location") or {}
    return float(loc.get("top") or 0) + float(loc.get("height") or 0) / 2


def _box(w: dict) -> dict | None:
    loc = w.get("location") or {}
    if not (loc.get("width") or loc.get("height")):
        return None
    return {
        "page": int(w.get("page") or 1),
        "left": int(loc.get("left") or 0),
        "top": int(loc.get("top") or 0),
        "width": int(loc.get("width") or 0),
        "height": int(loc.get("height") or 0),
    }


def detect_zones(
    ocr_words: list[dict],
    *,
    page_height: int = 2400,
) -> dict[str, Any]:
    """
    返回 zones: {name: {y0,y1, label, keywords_hit, box?}}
    """
    if not ocr_words:
        return {
            "claims": {"y0": 0, "y1": int(page_height * 0.35), "label": "卖点/品名区"},
            "ingredients": {
                "y0": int(page_height * 0.25),
                "y1": int(page_height * 0.72),
                "label": "成分区",
            },
            "usage": {
                "y0": int(page_height * 0.55),
                "y1": int(page_height * 0.82),
                "label": "用法区",
            },
            "process": {
                "y0": int(page_height * 0.78),
                "y1": page_height,
                "label": "工艺表区",
            },
        }

    # 关键词锚点
    anchors: dict[str, list[float]] = {
        "claims": [],
        "ingredients": [],
        "usage": [],
        "process": [],
    }
    for w in ocr_words:
        t = w.get("text") or ""
        y = _mid_y(w)
        if re.search(r"成分|inci|步骤\s*0*1|步骤\s*0*2|精华液|面膜：", t, re.I):
            anchors["ingredients"].append(y)
        if re.search(r"使用方法|贮存|注意|静敷", t):
            anchors["usage"].append(y)
        if re.search(r"工艺|版本号|颜色要求|垫白|设计部|包材|见稿件", t):
            anchors["process"].append(y)
        if re.search(
            r"透亮|保湿|柔嫩|BRIGHTENING|RADIANT|MOISTURIZING|品名|面膜$|精华",
            t,
            re.I,
        ):
            anchors["claims"].append(y)

    def band(ys: list[float], default: tuple[float, float], pad: float = 80) -> tuple[int, int]:
        if not ys:
            return int(default[0]), int(default[1])
        y0, y1 = min(ys) - pad, max(ys) + pad * 2.5
        return max(0, int(y0)), min(page_height, int(y1))

    h = page_height
    ing = band(anchors["ingredients"], (h * 0.28, h * 0.7))
    use = band(anchors["usage"], (h * 0.55, h * 0.8))
    proc = band(anchors["process"], (h * 0.78, h))
    clm = band(anchors["claims"], (0, h * 0.4), pad=40)

    zones = {
        "claims": {
            "y0": clm[0],
            "y1": min(clm[1], ing[0] + 40),
            "label": "卖点/品名区",
            "keywords_hit": len(anchors["claims"]),
        },
        "ingredients": {
            "y0": ing[0],
            "y1": ing[1],
            "label": "成分区",
            "keywords_hit": len(anchors["ingredients"]),
        },
        "usage": {
            "y0": use[0],
            "y1": use[1],
            "label": "用法区",
            "keywords_hit": len(anchors["usage"]),
        },
        "process": {
            "y0": proc[0],
            "y1": h,
            "label": "工艺表区",
            "keywords_hit": len(anchors["process"]),
        },
    }
    return zones


def words_in_zone(ocr_words: list[dict], zone: dict[str, Any]) -> list[dict]:
    y0, y1 = zone.get("y0", 0), zone.get("y1", 10**9)
    out = []
    for w in ocr_words:
        y = _mid_y(w)
        if y0 <= y <= y1:
            out.append(w)
    return out


def text_in_zone(ocr_words: list[dict], zone: dict[str, Any]) -> str:
    return "\n".join((w.get("text") or "") for w in words_in_zone(ocr_words, zone))


SKIP_SHEET_FIELD = re.compile(r"^(工艺说明|颜色要求|版本号|更新内容)($|[\s：:·])")


def skip_sheet_field(name: str) -> bool:
    """确认单底部工艺表不进机审。"""
    return bool(SKIP_SHEET_FIELD.search(str(name or "").strip()))


def filter_words_exclude_process(
    ocr_words: list[dict], zones: dict[str, Any]
) -> list[dict]:
    """反向扫描：去掉工艺表区词"""
    proc = zones.get("process") or {}
    y0 = proc.get("y0", 10**9)
    out = []
    for w in ocr_words:
        if _mid_y(w) >= y0 - 10:
            # 工艺区：仍保留极少量卖点？默认剔除
            t = w.get("text") or ""
            if re.search(r"工艺|版本|颜色|设计|包材|稿件|打样", t):
                continue
            if _mid_y(w) >= y0:
                continue
        out.append(w)
    return out


def claims_zone_text(ocr_words: list[dict], zones: dict[str, Any]) -> str:
    """卖点区 + 非工艺区拼接，供反向检查"""
    claims = zones.get("claims") or {}
    usage = zones.get("usage") or {}
    # 卖点 + 用法标题行，不含成分大段（成分反向噪声多）
    parts = [
        text_in_zone(ocr_words, claims),
        text_in_zone(ocr_words, usage),
    ]
    # 再补非工艺区的短行 slogan
    proc_y0 = (zones.get("process") or {}).get("y0", 10**9)
    for w in ocr_words:
        t = (w.get("text") or "").strip()
        if len(t) < 4 or len(t) > 40:
            continue
        if _mid_y(w) >= proc_y0:
            continue
        if re.search(r"^[A-Z][A-Za-z\s\-]{4,}|^[·•].+|透亮|保湿|柔嫩", t):
            parts.append(t)
    return "\n".join(parts)


# field_group → 优先匹配的 zone 名（可多选；空=全文）
FIELD_ZONE_MAP: dict[str, tuple[str, ...]] = {
    "成分表": ("ingredients",),
    "文案": ("claims",),
    "中文品名": ("claims",),
    "英文品名": ("claims",),
    "logo标识": ("claims",),
    "使用方法": ("usage", "claims"),
    "生产信息": ("ingredients", "usage"),
    "净含量": ("claims", "usage"),
    "条形码": (),  # 全文（码可能在任意角）
    "二维码": (),  # 全文 + 专用 API
}


def zone_names_for_field(field_group: str) -> tuple[str, ...]:
    return FIELD_ZONE_MAP.get(field_group or "", ())


def pack_scope_for_field(
    field_group: str,
    ocr_words: list[dict],
    zones: dict[str, Any] | None,
    full_text: str,
) -> tuple[str, list[dict], str]:
    """
    字段路由：返回 (scoped_text, scoped_words, scope_tag)。
    zone 文本过短时回退全文，避免假缺失。
    """
    names = zone_names_for_field(field_group)
    if not names or not zones or not ocr_words:
        return full_text or "", list(ocr_words or []), "full"

    parts: list[str] = []
    words: list[dict] = []
    used: list[str] = []
    for n in names:
        z = zones.get(n)
        if not z:
            continue
        tw = words_in_zone(ocr_words, z)
        tx = text_in_zone(ocr_words, z)
        if tx.strip():
            parts.append(tx)
            words.extend(tw)
            used.append(n)
    scoped = "\n".join(parts).strip()
    # 过短：回退全文（zone 检测失败时）
    if len(scoped) < 12:
        return full_text or "", list(ocr_words or []), "full_fallback"
    # 拼接全文尾部增强召回（短 token），但 match 框优先 zone 词
    hybrid = scoped + "\n" + (full_text or "")
    return hybrid, words or list(ocr_words), "zone:" + "+".join(used)


def reverse_pack_text_for_field(
    field_group: str,
    ocr_words: list[dict],
    zones: dict[str, Any] | None,
    full_text: str,
) -> str:
    """
    反向 only_in_pack 用的包装侧文本：
    - 文案/用法：仅 claims+usage，避免成分串扰
    - 成分：仅 ingredients
    - 其他：非工艺区
    """
    if not zones or not ocr_words:
        return full_text or ""
    fg = field_group or ""
    if fg in ("文案", "中文品名", "英文品名", "logo标识"):
        return claims_zone_text(ocr_words, zones) or full_text or ""
    if fg == "使用方法":
        return text_in_zone(ocr_words, zones.get("usage") or {}) or full_text or ""
    if fg == "成分表":
        return text_in_zone(ocr_words, zones.get("ingredients") or {}) or full_text or ""
    # 默认：排除工艺表
    filtered = filter_words_exclude_process(ocr_words, zones)
    return "\n".join((w.get("text") or "") for w in filtered) or full_text or ""
