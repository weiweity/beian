"""字段×区域×次数核对。不改 fields.py；在其结果上收钉、中英成对。"""
from __future__ import annotations

from typing import Any

from app.fields import compare_fields, field_group
from app.pack_layout import principal_claims_region

_NAME_GROUPS = frozenset({"中文品名", "英文品名"})


def verify_fields(
    fields: list[dict],
    words: list[dict],
    pack_text: str,
    *,
    pack_profile: dict | None = None,
    zones: dict | None = None,
    regions: list[dict] | None = None,
    excel_joined: str | None = None,
) -> list[dict]:
    hits = compare_fields(
        fields,
        words,
        pack_text,
        attach_sequence_diff=True,
        pack_profile=pack_profile,
        excel_joined=excel_joined,
        zones=zones,
    )
    regions = regions or []
    out = [clip_hit_bboxes(h, regions) for h in hits]
    return pair_bilingual_names(out, regions)


def clip_hit_bboxes(hit: dict, regions: list[dict] | None = None) -> dict:
    """每个字段最多 1 个 hit 框 + 可选 1 个 check/miss_anchor。"""
    h = dict(hit)
    boxes = list(h.get("bboxes") or [])
    if not boxes:
        h["bboxes"] = []
        return h
    fg = h.get("field_group") or field_group(h.get("field") or "")
    hits = [b for b in boxes if (b.get("role") in (None, "hit", "context"))]
    checks = [b for b in boxes if b.get("role") in ("check", "miss_anchor")]
    kept: list[dict] = []
    extra = 0
    if hits:
        chosen, extra = _pick_principal(hits, fg, regions or [])
        chosen = dict(chosen)
        chosen["role"] = "hit"
        kept.append(_union([chosen], role="hit"))
    if checks:
        role = str(checks[0].get("role") or "check")
        kept.append(_union(checks, role=role))
    h["bboxes"] = kept
    if extra > 0 and fg in _NAME_GROUPS:
        h["name_extra_count"] = extra
        ev = h.get("evidence") or ""
        note = f"另有 {extra} 处未钉"
        if note not in ev:
            h["evidence"] = (ev + " · " + note).strip(" ·")
        cov = dict(h.get("coverage") or {})
        cov["extra_occurrences"] = extra
        h["coverage"] = cov
    if kept:
        h["page"] = kept[0].get("page") or h.get("page") or 1
        h["no_bbox"] = False
    return h


def pair_bilingual_names(hits: list[dict], regions: list[dict]) -> list[dict]:
    cn = next((h for h in hits if (h.get("field_group") == "中文品名")), None)
    en = next((h for h in hits if (h.get("field_group") == "英文品名")), None)
    if not cn or not en:
        return hits
    cb = _first_hit_box(cn)
    eb = _first_hit_box(en)
    if not cb or not eb:
        return hits
    if int(cb.get("page") or 1) != int(eb.get("page") or 1):
        return hits
    if not _vertically_paired(cb, eb):
        return hits
    paired = _union([cb, eb], role="hit")
    paired["label"] = "中英品名"
    cn = dict(cn)
    en = dict(en)
    cn["bboxes"] = [paired] + [
        b for b in (cn.get("bboxes") or []) if b.get("role") not in (None, "hit", "context")
    ]
    en["bboxes"] = [dict(paired)] + [
        b for b in (en.get("bboxes") or []) if b.get("role") not in (None, "hit", "context")
    ]
    cn["bilingual_pair"] = True
    en["bilingual_pair"] = True
    cn["page"] = paired["page"]
    en["page"] = paired["page"]
    out = []
    for h in hits:
        fg = h.get("field_group")
        if fg == "中文品名":
            out.append(cn)
        elif fg == "英文品名":
            out.append(en)
        else:
            out.append(h)
    return out


def _pick_principal(
    boxes: list[dict], fg: str, regions: list[dict]
) -> tuple[dict, int]:
    if len(boxes) == 1:
        return boxes[0], 0
    claims = principal_claims_region(regions, page=int(boxes[0].get("page") or 1))
    if fg in _NAME_GROUPS and claims:
        inside = [b for b in boxes if _box_in_region(b, claims)]
        pool = inside or boxes
        pool = sorted(pool, key=lambda b: (int(b.get("page") or 1), int(b.get("top") or 0)))
        return pool[0], max(0, len(boxes) - 1)
    # 长字段：取面积最大的一块
    best = max(
        boxes,
        key=lambda b: int(b.get("width") or 0) * int(b.get("height") or 0),
    )
    return best, max(0, len(boxes) - 1)


def _first_hit_box(hit: dict) -> dict | None:
    for b in hit.get("bboxes") or []:
        if b.get("role") in (None, "hit", "context"):
            return b
    return None


def _vertically_paired(cn: dict, en: dict) -> bool:
    """英文在中文下方、水平有重叠。"""
    gap = int(en.get("top") or 0) - (int(cn.get("top") or 0) + int(cn.get("height") or 0))
    if gap < -8 or gap > max(12, int(cn.get("height") or 20) * 2):
        return False
    cl, cr = int(cn.get("left") or 0), int(cn.get("left") or 0) + int(cn.get("width") or 0)
    el, er = int(en.get("left") or 0), int(en.get("left") or 0) + int(en.get("width") or 0)
    return cl < er and el < cr


def _box_in_region(box: dict, region: dict) -> bool:
    if int(box.get("page") or 1) != int(region.get("page") or 1):
        return False
    cx = int(box.get("left") or 0) + int(box.get("width") or 0) // 2
    cy = int(box.get("top") or 0) + int(box.get("height") or 0) // 2
    l, t = int(region.get("left") or 0), int(region.get("top") or 0)
    r = l + int(region.get("width") or 0)
    b = t + int(region.get("height") or 0)
    return l <= cx <= r and t <= cy <= b


def _union(boxes: list[dict], *, role: str) -> dict:
    page = int(boxes[0].get("page") or 1)
    same = [b for b in boxes if int(b.get("page") or 1) == page]
    left = min(int(b.get("left") or 0) for b in same)
    top = min(int(b.get("top") or 0) for b in same)
    right = max(int(b.get("left") or 0) + int(b.get("width") or 0) for b in same)
    bottom = max(int(b.get("top") or 0) + int(b.get("height") or 0) for b in same)
    return {
        "page": page,
        "left": left,
        "top": top,
        "width": max(2, right - left),
        "height": max(2, bottom - top),
        "role": role,
        "status": "ok" if role == "hit" else "warn",
        "label": same[0].get("label") or "",
    }
