"""
成分/脚注区裁块二次 OCR（工业常用：整页漏密字 → 局部放大再识）

同 API（accurate 含位置），坐标平移回全图。
证明：全页漏「香柠檬」，裁成分右栏后可稳定读出。
"""
from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any

from PIL import Image

from app.baidu_ocr import ocr_image_bytes


def _find_step_right_anchor(words: list[dict], step: str) -> dict | None:
    """成分栏步骤0X 标题（排除 涂/敷 用法与脚注昵称）。"""
    pat = re.compile(rf"步骤\s*0*{step}") if step else re.compile(r"步骤\s*0*\d")
    cands = []
    for w in words or []:
        t = w.get("text") or ""
        if not pat.search(t):
            continue
        if re.search(r"步骤\s*[\.．]?\s*(涂|敷)|涂·|敷·", t):
            continue
        if re.search(r"昵称|为本品步骤", t):
            continue
        loc = w.get("location") or {}
        if not loc.get("width"):
            continue
        cands.append(w)
    if not cands:
        return None

    def _rank(w: dict) -> tuple:
        t = w.get("text") or ""
        loc = w.get("location") or {}
        left = int(loc.get("left") or 0)
        width = int(loc.get("width") or 0)
        top = int(loc.get("top") or 0)
        has_title = 1 if re.search(r"精华液|面膜|成分", t) else 0
        not_thin = 1 if width >= 40 else 0
        # 真标题通常在版面上半/中部；脚注昵称偏下
        return (has_title, not_thin, -top // 200, left, width)

    return max(cands, key=_rank)


def _crop_boxes_for_page(
    words: list[dict],
    page_w: int,
    page_h: int,
) -> list[tuple[str, tuple[int, int, int, int]]]:
    """
    返回 [(zone_name, (left, top, right, bottom))] 全图像素。
    """
    zones: list[tuple[str, tuple[int, int, int, int]]] = []
    s1 = _find_step_right_anchor(words, "1")
    s2 = _find_step_right_anchor(words, "2")
    net = None
    for w in words or []:
        if re.search(r"净含量", w.get("text") or ""):
            loc = w.get("location") or {}
            if int(loc.get("left") or 0) > page_w * 0.4:
                net = w
                break

    def band(anchor, y1_anchor, name: str, pad_x=40, below=220):
        if not anchor:
            return
        loc = anchor.get("location") or {}
        aw = int(loc.get("width") or 0)
        # 细竖条锚：从页面中线起裁，避免只裁 32px 宽条
        if aw < 50:
            left = max(0, int(page_w * 0.48))
        else:
            left = max(0, int(loc.get("left") or 0) - pad_x)
            left = min(left, int(page_w * 0.55))
        top = max(0, int(loc.get("top") or 0) - 12)
        # 右栏拉满
        right = min(page_w, max(left + 520, int(page_w * 0.98)))
        if y1_anchor:
            y1l = y1_anchor.get("location") or {}
            y1t = int(y1l.get("top") or 0)
            if y1t > top + 60:
                bot = y1t - 4
            else:
                bot = min(page_h, top + below)
        else:
            bot = min(page_h, top + below)
        if bot - top < 100:
            bot = min(page_h, top + max(below, 180))
        zones.append((name, (left, top, right, bot)))

    # step1 底边：若 s2 在 s1 上方（锚错位），改用固定高度
    s2_for_s1 = s2
    if s1 and s2:
        t1 = int((s1.get("location") or {}).get("top") or 0)
        t2 = int((s2.get("location") or {}).get("top") or 0)
        if t2 <= t1 + 20:
            s2_for_s1 = None  # 避免 bot < top 压成细条
    band(s1, s2_for_s1, "ingredients_step01", below=240)
    # step02 到净含量或用法
    y_end = net
    if not y_end:
        for w in words or []:
            if re.search(r"使用方法", w.get("text") or ""):
                loc = w.get("location") or {}
                if int(loc.get("left") or 0) > page_w * 0.4:
                    y_end = w
                    break
    band(s2, y_end, "ingredients_step02", below=280)

    # 脚注：净含量上方（P1：拆两条横带，密字更好出）
    if net:
        loc = net.get("location") or {}
        left = max(0, int(loc.get("left") or 0) - 30)
        net_top = int(loc.get("top") or 0)
        right = min(page_w, left + max(520, int(loc.get("width") or 0) + 220))
        # 上条：商标/25+/设计说明
        zones.append(
            ("footnote_upper", (left, max(0, net_top - 160), right, max(40, net_top - 70)))
        )
        # 下条：贴净含量
        zones.append(
            (
                "footnote_above_net",
                (left, max(0, net_top - 90), right, net_top + int(loc.get("height") or 20) + 10),
            )
        )

    # 生产信息：拆 2～3 条横带（备案/地址/许可证，P1 更细裁）
    if net:
        loc = net.get("location") or {}
        left = max(0, int(loc.get("left") or 0) - 40)
        top0 = int(loc.get("top") or 0)
        right = min(page_w - 4, page_w)
        h_band = max(120, int(page_h * 0.09))
        for i, name in enumerate(
            ("production_net", "production_mid", "production_lower")
        ):
            t0 = top0 + i * (h_band - 20)
            b0 = min(page_h - 4, t0 + h_band)
            if t0 >= page_h - 40:
                break
            zones.append((name, (left, t0, right, b0)))

    # 无锚时：右半幅中部兜底
    if not zones:
        zones.append(
            (
                "right_mid_fallback",
                (int(page_w * 0.48), int(page_h * 0.22), page_w - 8, int(page_h * 0.55)),
            )
        )
    return zones


def boost_page_ocr(
    image_path: str | Path,
    words: list[dict],
    *,
    page: int = 1,
) -> tuple[str, list[dict], dict]:
    """
    对单页：裁关键区二次 OCR，返回 (extra_text, extra_words_fullpage_coords, meta)
    """
    path = Path(image_path)
    if not path.exists():
        return "", [], {"ok": False, "error": "no_image"}

    im = Image.open(path).convert("RGB")
    page_w, page_h = im.size
    zones = _crop_boxes_for_page(words, page_w, page_h)
    extra_words: list[dict] = []
    texts: list[str] = []
    zone_hits: list[dict] = []

    for name, (l, t, r, b) in zones:
        # 边界
        l, t = max(0, l), max(0, t)
        r, b = min(page_w, r), min(page_h, b)
        if r - l < 80 or b - t < 40:
            continue
        crop = im.crop((l, t, r, b))
        # 略放大 1.5x 再识，提高小字
        scale = 1.5
        cw, ch = crop.size
        crop2 = crop.resize((int(cw * scale), int(ch * scale)), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        crop2.save(buf, format="PNG", optimize=True)
        try:
            text, wds, info = ocr_image_bytes(buf.getvalue(), with_location=True)
        except Exception as e:
            zone_hits.append({"zone": name, "ok": False, "error": str(e)[:80]})
            continue
        if text:
            texts.append(f"[{name}]\n{text}")
        n_new = 0
        for w in wds:
            loc = w.get("location") or {}
            # 坐标从放大裁块 → 全图
            left = int(round(int(loc.get("left") or 0) / scale + l))
            top = int(round(int(loc.get("top") or 0) / scale + t))
            width = int(round(int(loc.get("width") or 0) / scale))
            height = int(round(int(loc.get("height") or 0) / scale))
            ww = dict(w)
            ww["location"] = {
                "left": left,
                "top": top,
                "width": max(2, width),
                "height": max(2, height),
            }
            ww["page"] = page
            ww["zone_boost"] = name
            extra_words.append(ww)
            n_new += 1
        zone_hits.append(
            {
                "zone": name,
                "ok": True,
                "words": n_new,
                "box": [l, t, r, b],
                "has_bergam": "香柠" in (text or "") or "BERGAM" in (text or "").upper(),
            }
        )

    meta = {
        "ok": bool(extra_words),
        "zones": zone_hits,
        "extra_words": len(extra_words),
        "boost": "crop_1.5x_accurate",
    }
    return "\n".join(texts), extra_words, meta


def merge_boosted(
    pack_text: str,
    words: list[dict],
    extra_text: str,
    extra_words: list[dict],
) -> tuple[str, list[dict]]:
    """全文双源；词表追加（定位用全量）。"""
    if not extra_text and not extra_words:
        return pack_text, words
    text = (pack_text or "") + "\n" + (extra_text or "")
    # 词：原词 + boost 词（不去重，允许覆盖）
    out = list(words or []) + list(extra_words or [])
    return text, out
