"""包装版面分区：几何 ROI + 关键词锚点。不走 RAG。"""
from __future__ import annotations

from typing import Any

from app.dual_zone import PACK_ROI_TEMPLATE
from app import layout_zones

# packing ROI role → layout_zones 兼容名（compare_fields 认 claims/ingredients/usage/process）
ROLE_ZONE_NAME = {
    "claims": "claims",
    "ingredients": "ingredients",
    "usage": "usage",
    "filing": "process",
    "footnote": "footnote",
}

FIELD_REGION_ROLES: dict[str, tuple[str, ...]] = {
    "中文品名": ("claims",),
    "英文品名": ("claims",),
    "logo标识": ("claims",),
    "文案": ("claims",),
    "成分表": ("ingredients",),
    "使用方法": ("usage", "claims"),
    "生产信息": ("filing",),
    "净含量": ("claims", "usage"),
    "二维码": ("footnote",),
}


def detect_regions(
    words: list[dict],
    page_metas: list[dict],
) -> dict[str, Any]:
    """
    返回 {regions, zones, page_height}
    regions: 每页每角色一块像素框
    zones: 给 fields.compare_fields / layout_zones 的 y 带（沿用旧键名）
    """
    if not page_metas:
        h = 2400
        keyword = layout_zones.detect_zones(words, page_height=h)
        return {"regions": [], "zones": keyword, "page_height": h}

    regions: list[dict[str, Any]] = []
    zones_by_page: dict[int, dict[str, Any]] = {}
    for meta in page_metas:
        pw = max(1, int(meta.get("width") or 1))
        ph = max(1, int(meta.get("height") or 1))
        page = int(meta.get("page") or 1)
        page_words = [w for w in words if int(w.get("page") or 1) == page]
        zones_by_page[page] = layout_zones.detect_zones(page_words, page_height=ph)
        for role, frac in PACK_ROI_TEMPLATE.items():
            box = {
                "left": int(frac["left"] * pw),
                "top": int(frac["top"] * ph),
                "width": max(2, int(frac["width"] * pw)),
                "height": max(2, int(frac["height"] * ph)),
            }
            box = _refine_box(box, page_words, pw, ph)
            regions.append(
                {
                    "id": f"p{page}_{role}",
                    "role": role,
                    "page": page,
                    "left": box["left"],
                    "top": box["top"],
                    "width": box["width"],
                    "height": box["height"],
                    "text": _text_in_box(page_words, box),
                }
            )

    ph0 = max(1, int(page_metas[0].get("height") or 2400))
    # 旧 fields.py 的 zones 只有 y0/y1，没有 page 维度。多页时传它会把
    # 不同页面的同一 Y 带混在一起，因此只在单页暴露兼容视图。
    zones = dict(zones_by_page.get(int(page_metas[0].get("page") or 1), {}))
    if len(page_metas) != 1:
        zones = {}
    if zones:
        zones.setdefault(
            "footnote",
            {"y0": int(ph0 * 0.82), "y1": ph0, "label": "脚注区", "keywords_hit": 0},
        )
    return {
        "regions": regions,
        "zones": zones,
        "zones_by_page": zones_by_page,
        "page_height": ph0,
    }


def words_in_roles(
    words: list[dict],
    regions: list[dict],
    roles: tuple[str, ...],
) -> list[dict]:
    if not roles:
        return list(words)
    boxes = [r for r in regions if r.get("role") in roles]
    if not boxes:
        return list(words)
    out = []
    seen: set[int] = set()
    for i, w in enumerate(words):
        loc = w.get("location") or {}
        wb = {
            "page": int(w.get("page") or 1),
            "left": int(loc.get("left") or 0),
            "top": int(loc.get("top") or 0),
            "width": int(loc.get("width") or 0),
            "height": int(loc.get("height") or 0),
        }
        if any(_overlap(wb, r) for r in boxes):
            seen.add(i)
            out.append(w)
    return out


def principal_claims_region(regions: list[dict], page: int = 1) -> dict | None:
    claims = [
        r
        for r in regions
        if r.get("role") == "claims" and int(r.get("page") or 1) == page
    ]
    return claims[0] if claims else None


def roles_for_field(field_group: str) -> tuple[str, ...]:
    return FIELD_REGION_ROLES.get(field_group or "", ())


def _refine_box(box: dict, words: list[dict], pw: int, ph: int) -> dict:
    """区内有词则略收紧到词包络，避免整页大框。无词保持 ROI。"""
    hits = []
    for w in words:
        loc = w.get("location") or {}
        wb = {
            "left": int(loc.get("left") or 0),
            "top": int(loc.get("top") or 0),
            "width": int(loc.get("width") or 0),
            "height": int(loc.get("height") or 0),
        }
        if wb["width"] <= 0 or wb["height"] <= 0:
            continue
        if _overlap(wb, box):
            hits.append(wb)
    if len(hits) < 2:
        return box
    left = min(b["left"] for b in hits)
    top = min(b["top"] for b in hits)
    right = max(b["left"] + b["width"] for b in hits)
    bottom = max(b["top"] + b["height"] for b in hits)
    pad = 8
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(pw, right + pad)
    bottom = min(ph, bottom + pad)
    return {
        "left": left,
        "top": top,
        "width": max(2, right - left),
        "height": max(2, bottom - top),
    }


def _text_in_box(words: list[dict], box: dict) -> str:
    parts = []
    for w in words:
        loc = w.get("location") or {}
        wb = {
            "left": int(loc.get("left") or 0),
            "top": int(loc.get("top") or 0),
            "width": int(loc.get("width") or 0),
            "height": int(loc.get("height") or 0),
        }
        if _overlap(wb, box):
            t = (w.get("text") or "").strip()
            if t:
                parts.append(t)
    return "\n".join(parts)


def _overlap(a: dict, b: dict) -> bool:
    if "page" in a and "page" in b and int(a["page"]) != int(b["page"]):
        return False
    ar = a["left"] + a["width"]
    ab = a["top"] + a["height"]
    br = b["left"] + b["width"]
    bb = b["top"] + b["height"]
    return a["left"] < br and b["left"] < ar and a["top"] < bb and b["top"] < ab
