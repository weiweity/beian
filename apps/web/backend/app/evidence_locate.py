"""
证据框定位（与打分解耦 · 工业双轨）

算法分层（行业文档/包装核对常见设计）：
  1. 词级 span 匹配 — OCR 词窗滑动，框真实命中字
  2. 策略路由 pin | multi | block — 按字段类型自适应
  3. 双轨框：
       hit  (绿/蓝) = 确认单短语在包装上找到的字
       check(黄)    = 疑点/漏印对应处：弱命中 或 版面期望区
  4. 自适应 pad ≈ 0.35 × 字高
  5. 漏印找不到词 → 不瞎框，落到 expected zone

禁止：
  - 用 BRIGHTENING 当 logo
  - 把许可证号当条码
  - match 旧框覆盖 refine 结果
  - 用覆盖率数字伪造坐标
"""
from __future__ import annotations

import re
from typing import Any

from rapidfuzz import fuzz


def _norm(s: str) -> str:
    try:
        from app.inci_normalize import normalize_inci_text

        s = normalize_inci_text(str(s or ""))
    except Exception:
        s = str(s or "")
    s = re.sub(r"\s+", "", s)
    return s.replace("：", ":").replace("（", "(").replace("）", ")").lower()


def _box(
    w: dict, *, role: str = "hit", label: str = "", status: str = "ok"
) -> dict | None:
    loc = w.get("location") or {}
    if not (loc.get("width") or loc.get("height")):
        return None
    return {
        "page": int(w.get("page") or 1),
        "left": int(loc.get("left") or 0),
        "top": int(loc.get("top") or 0),
        "width": max(2, int(loc.get("width") or 0)),
        "height": max(2, int(loc.get("height") or 0)),
        "role": role,
        "label": (label or (w.get("text") or ""))[:28],
        "status": status,
    }


def _union(boxes: list[dict], *, pad: int = 6, role: str = "hit") -> list[dict]:
    if not boxes:
        return []
    by_page: dict[int, list[dict]] = {}
    for b in boxes:
        by_page.setdefault(int(b.get("page") or 1), []).append(b)
    out = []
    for page, bl in sorted(by_page.items()):
        l = min(int(x["left"]) for x in bl) - pad
        t = min(int(x["top"]) for x in bl) - pad
        r = max(int(x["left"]) + int(x["width"]) for x in bl) + pad
        btm = max(int(x["top"]) + int(x["height"]) for x in bl) + pad
        out.append(
            {
                "page": page,
                "left": max(0, l),
                "top": max(0, t),
                "width": max(2, r - l),
                "height": max(2, btm - t),
                "role": role,
                "status": "ok" if role == "hit" else "warn",
                "label": bl[0].get("label") or "",
            }
        )
    return out


def _cluster_by_y(boxes: list[dict], *, gap: float = 36.0) -> list[list[dict]]:
    if not boxes:
        return []
    ordered = sorted(boxes, key=lambda b: (b.get("page", 1), b.get("top", 0)))
    clusters: list[list[dict]] = [[ordered[0]]]
    for b in ordered[1:]:
        prev = clusters[-1][-1]
        if int(b.get("page") or 1) != int(prev.get("page") or 1):
            clusters.append([b])
            continue
        if abs(int(b["top"]) - int(prev["top"])) <= gap:
            clusters[-1].append(b)
        else:
            clusters.append([b])
    return clusters


def _is_all_caps_slogan(text: str) -> bool:
    t = (text or "").strip()
    letters = re.sub(r"[^A-Za-z]", "", t)
    if len(letters) < 8:
        return False
    return letters.isupper() and bool(
        re.search(r"BRIGHTENING|VITALIZING|ESSENCE|MOISTURIZING|RADIANT|MASK", t, re.I)
    )


def _median_word_height(ocr_words: list[dict]) -> float:
    hs: list[int] = []
    for w in ocr_words or []:
        h = int((w.get("location") or {}).get("height") or 0)
        if 4 <= h <= 96:
            hs.append(h)
    if not hs:
        return 18.0
    hs.sort()
    return float(hs[len(hs) // 2])


def adaptive_pad(
    ocr_words: list[dict] | None = None, *, scale: float = 0.35, lo: int = 3, hi: int = 14
) -> int:
    """行业常用：框外扩 ≈ 字高比例，避免写死 10px。"""
    h = _median_word_height(ocr_words or [])
    return max(lo, min(hi, int(round(h * scale))))


def _reading_order(ocr_words: list[dict]) -> list[dict]:
    return sorted(
        ocr_words or [],
        key=lambda w: (
            int(w.get("page") or 1),
            int((w.get("location") or {}).get("top") or 0) // 10,
            int((w.get("location") or {}).get("left") or 0),
        ),
    )


def _soft_query(phrase: str) -> str:
    try:
        from app.phrase_soft import soft_key

        return soft_key(phrase) or _norm(phrase)
    except Exception:
        return _norm(phrase)


def _filter_words(
    ocr_words: list[dict],
    *,
    y_band: tuple[float, float] | None = None,
    x_min: float | None = None,
    x_max: float | None = None,
    exclude_re: str | None = None,
) -> list[dict]:
    excl = re.compile(exclude_re, re.I) if exclude_re else None
    out = []
    for w in ocr_words or []:
        raw = w.get("text") or ""
        if excl and excl.search(raw):
            continue
        loc = w.get("location") or {}
        top = float(loc.get("top") or 0)
        left = float(loc.get("left") or 0)
        mid_y = top + float(loc.get("height") or 0) / 2
        if y_band is not None and not (y_band[0] <= mid_y <= y_band[1]):
            continue
        if x_min is not None and left < x_min:
            continue
        if x_max is not None and left > x_max:
            continue
        out.append(w)
    return out


def locate_phrase_span(
    phrase: str,
    ocr_words: list[dict],
    *,
    min_score: float = 86.0,
    y_band: tuple[float, float] | None = None,
    x_min: float | None = None,
    x_max: float | None = None,
    prefer_re: str | None = None,
    exclude_re: str | None = None,
    role: str = "hit",
    status: str = "ok",
    label: str = "",
    max_window: int = 14,
) -> dict | None:
    """
    词级 span 定位（核心）：在阅读序 OCR 词上滑窗，框真实命中字。
    比单字 fuzzy 更贴「这句话印在哪」。
    """
    raw_q = (phrase or "").strip()
    if len(raw_q) < 2 or not ocr_words:
        return None
    q = _soft_query(raw_q)
    if len(q) < 2:
        q = _norm(raw_q)
    if len(q) < 2:
        return None

    words = _reading_order(
        _filter_words(
            ocr_words, y_band=y_band, x_min=x_min, x_max=x_max, exclude_re=exclude_re
        )
    )
    if not words:
        return None

    pref = re.compile(prefer_re, re.I) if prefer_re else None
    pad = adaptive_pad(words)
    best: tuple[float, list[dict], str] | None = None
    # 窗口上限随 query 长度
    win = min(max_window, max(4, len(q) // 2 + 3))

    for i, w0 in enumerate(words):
        page = int(w0.get("page") or 1)
        parts: list[str] = []
        boxes: list[dict] = []
        prev_top = None
        for j in range(i, min(i + win, len(words))):
            w = words[j]
            if int(w.get("page") or 1) != page:
                break
            loc = w.get("location") or {}
            top = float(loc.get("top") or 0)
            # 跨行太多则停（允许 2 行内折行）
            if prev_top is not None and top - prev_top > 48:
                break
            prev_top = top if prev_top is None else prev_top
            parts.append(w.get("text") or "")
            b = _box(w, role=role, label=label or raw_q[:20], status=status)
            if b:
                boxes.append(b)
            if not boxes:
                continue
            joined = _norm("".join(parts))
            if not joined:
                continue
            sc = 0.0
            if q == joined:
                sc = 100.0
            elif q in joined:
                # 越短越好（少吞无关字）；短锚（备案人/净含量）嵌在长 OCR 行仍应高分
                sc = 97.0 - min(12.0, (len(joined) - len(q)) * 0.4)
                if len(q) <= 8 and len(joined) >= len(q) * 2:
                    sc = max(sc, 95.0)
                # 尽量收缩到含 query 的最短子窗
                if len(parts) > 1 and len(q) <= 12:
                    for a in range(len(parts)):
                        for b in range(len(parts), a, -1):
                            sub = _norm("".join(parts[a:b]))
                            if q in sub and len(sub) < len(joined):
                                joined = sub
                                # 同步 boxes 收缩在后面 union 时用 parts 切片更准；此处只提分
                                sc = max(sc, 96.0)
                                break
            elif (
                len(joined) >= 4
                and joined in q
                and len(joined) >= max(4, int(len(q) * 0.45))
            ):
                sc = 90.0
            else:
                # 禁止「长查询 vs 单字/短数字」partial 虚高（如条码/净含量命中左侧「2」）
                if len(joined) < 3 or (
                    len(q) >= 6 and len(joined) < max(3, min(6, len(q) // 4))
                ):
                    sc = 0.0
                elif re.fullmatch(r"\d{1,3}", joined) and len(q) > 4:
                    sc = 0.0
                else:
                    sc = float(fuzz.partial_ratio(q[:56], joined[:72]))
                    # 窗远短于查询时压分
                    if len(joined) < len(q) * 0.35:
                        sc *= 0.55
            if pref and any(pref.search(p or "") for p in parts):
                sc += 8
            if sc >= min_score and (best is None or sc > best[0]):
                # 子串命中时尽量收缩左右
                use_boxes = boxes
                use_parts = parts
                if q in joined and len(parts) > 1:
                    while len(use_parts) > 1 and q in _norm("".join(use_parts[1:])):
                        use_parts, use_boxes = use_parts[1:], use_boxes[1:]
                    while len(use_parts) > 1 and q in _norm("".join(use_parts[:-1])):
                        use_parts, use_boxes = use_parts[:-1], use_boxes[:-1]
                best = (sc, use_boxes, "".join(use_parts))
            # 已完美包含可提前结束本起点
            if q in joined and sc >= 96:
                break

    if not best:
        return None
    sc, boxes, matched = best
    u = _union(boxes, pad=pad, role=role)
    if not u:
        return None
    out = u[0]
    # 短句拒绝超宽框（防「涂精华液」吞整行/跨栏）
    max_w = 520 if len(q) >= 12 else (360 if len(q) >= 6 else 280)
    if int(out.get("width") or 0) > max_w and len(boxes) > 1:
        # 回退为最高分单字框
        single = max(boxes, key=lambda b: int(b.get("width") or 0) * 0 + 1)
        # 取中间词更稳
        mid = boxes[len(boxes) // 2]
        out = dict(mid)
        out["role"] = role
        out["status"] = status
        pad2 = pad
        out["left"] = max(0, int(out["left"]) - pad2)
        out["top"] = max(0, int(out["top"]) - pad2)
        out["width"] = int(out["width"]) + pad2 * 2
        out["height"] = int(out["height"]) + pad2 * 2
    out["role"] = role
    out["status"] = status
    out["label"] = (label or raw_q)[:28]
    out["match_score"] = round(sc, 1)
    out["matched_text"] = matched[:48]
    out["locate"] = "phrase_span"
    return out


def find_best_word(
    query: str,
    ocr_words: list[dict],
    *,
    min_score: float = 88.0,
    prefer_re: str | None = None,
    exclude_re: str | None = None,
    require_re: str | None = None,
) -> dict | None:
    """兼容入口：优先词级 span，失败再单字。"""
    span = locate_phrase_span(
        query,
        ocr_words,
        min_score=min_score,
        prefer_re=prefer_re,
        exclude_re=exclude_re,
        role="hit",
        status="ok",
        label=(query or "")[:20],
    )
    if span and (not require_re or re.search(require_re, span.get("matched_text") or span.get("label") or "", re.I)):
        return span
    # 单字兜底（旧逻辑精简）
    q = _norm(query)
    if len(q) < 2 or not ocr_words:
        return None
    pref = re.compile(prefer_re, re.I) if prefer_re else None
    excl = re.compile(exclude_re, re.I) if exclude_re else None
    req = re.compile(require_re, re.I) if require_re else None
    best: tuple[float, dict] | None = None
    for w in ocr_words:
        raw = w.get("text") or ""
        if excl and excl.search(raw):
            continue
        if req and not req.search(raw):
            continue
        if _is_all_caps_slogan(raw) and not (pref and pref.search(raw)):
            if prefer_re and not re.search(
                r"BRIGHTENING|ESSENCE|MASK", prefer_re or "", re.I
            ):
                continue
        nw = _norm(raw)
        if not nw:
            continue
        sc = (
            100.0
            if q == nw
            else 98.0
            if q in nw
            else 93.0
            if len(nw) >= 4 and nw in q
            else float(fuzz.partial_ratio(q[:48], nw[:56]))
        )
        if pref and pref.search(raw):
            sc += 12
        if sc >= min_score:
            b = _box(w, label=query[:20])
            if b and (best is None or sc > best[0]):
                best = (sc, b)
    return best[1] if best else None


def expected_zone(
    field_group: str,
    field: str,
    ocr_words: list[dict],
    *,
    page_w: int = 2200,
    page_h: int = 2400,
) -> dict | None:
    """
    漏印期望区：OCR 找不到 miss 词时，框「应出现的版面位置」。
    通用 profile，不绑死品牌。
    """
    fg = field_group or ""
    fl = field or ""
    words = ocr_words or []

    def _zone_from_anchor(
        anchor: dict,
        *,
        above: int = 0,
        below: int = 0,
        left_slack: int = 20,
        width_boost: int = 80,
        label: str = "期望区",
    ) -> dict:
        return {
            "page": int(anchor.get("page") or 1),
            "left": max(0, int(anchor["left"]) - left_slack),
            "top": max(0, int(anchor["top"]) - above),
            "width": max(120, int(anchor["width"]) + width_boost),
            "height": max(28, above + int(anchor["height"]) + below),
            "role": "check",
            "status": "warn",
            "label": label,
            "locate": "expected_zone",
        }

    if fg == "文案":
        net = find_best_word("净含量", words, min_score=88.0, prefer_re=r"净含量")
        if net:
            z = _zone_from_anchor(
                net, above=110, below=0, left_slack=24, width_boost=100, label="期望·脚注(净含量上)"
            )
            z["height"] = 100
            return z
        # 无净含量时：页中右栏
        return {
            "page": 1,
            "left": int(page_w * 0.55),
            "top": int(page_h * 0.42),
            "width": int(page_w * 0.38),
            "height": int(page_h * 0.12),
            "role": "check",
            "status": "warn",
            "label": "期望·文案脚注区",
            "locate": "expected_zone",
        }

    if fg == "成分表":
        step = (
            "1"
            if re.search(r"步骤\s*0*1|精华液", fl)
            else ("2" if re.search(r"步骤\s*0*2|面膜", fl) else "")
        )
        bands = step_y_bands(words)
        if step and step in bands:
            y0, y1 = bands[step]
            tb = find_best_word(
                "步骤01" if step == "1" else "步骤02",
                words,
                min_score=85.0,
                prefer_re=r"步骤",
            )
            left = int(tb["left"]) - 40 if tb else int(page_w * 0.52)
            return {
                "page": int(tb["page"]) if tb else 1,
                "left": max(0, left),
                "top": int(y0),
                "width": max(300, int(page_w * 0.42)),
                "height": max(60, int(y1 - y0)),
                "role": "context",
                "status": "ok",
                "label": f"期望·步骤0{step}整段",
                "locate": "expected_zone",
            }

    if fg == "二维码":
        for q in ("公众号", "扫码关注", "扫码"):
            b = find_best_word(q, words, min_score=86.0)
            if b:
                return _zone_from_anchor(
                    b, above=40, below=80, left_slack=40, width_boost=60, label="期望·码区"
                )
        return {
            "page": 1,
            "left": int(page_w * 0.7),
            "top": int(page_h * 0.48),
            "width": int(page_w * 0.22),
            "height": int(page_h * 0.12),
            "role": "check",
            "status": "warn",
            "label": "期望·二维码区",
            "locate": "expected_zone",
        }

    if fg == "生产信息":
        b = find_best_word("备案人", words, min_score=86.0) or find_best_word(
            "生产企业", words, min_score=86.0
        )
        if b:
            return _zone_from_anchor(
                b, above=10, below=160, left_slack=20, width_boost=200, label="期望·生产信息"
            )

    if fg == "使用方法":
        b = find_best_word("使用方法", words, min_score=86.0)
        if b:
            return _zone_from_anchor(
                b, above=8, below=140, left_slack=16, width_boost=180, label="期望·用法"
            )
    return None


def _dedupe_boxes(boxes: list[dict], *, grid: int = 14) -> list[dict]:
    uniq, seen = [], set()
    for b in boxes:
        k = (
            int(b.get("page") or 1),
            int(b.get("left") or 0) // grid,
            int(b.get("top") or 0) // grid,
            (b.get("role") or "")[:6],
        )
        if k in seen:
            continue
        seen.add(k)
        uniq.append(b)
    return uniq


def locate_dual_evidence(
    *,
    field_group: str,
    field: str,
    excel_value: str,
    primary_query: str,
    ocr_words: list[dict],
    miss_phrases: list[str] | None = None,
    hit_phrases: list[str] | None = None,
    page_w: int = 2200,
    page_h: int = 2400,
) -> list[dict]:
    """
    双轨总入口：
      check 框在前（疑点优先聚焦），hit 框在后。
    """
    fg = field_group or ""
    fl = field or ""
    words = ocr_words or []
    misses = [m for m in (miss_phrases or []) if (m or "").strip()]
    hits_in = [h for h in (hit_phrases or []) if (h or "").strip()]
    if not hits_in and excel_value:
        # 从 excel 抽短锚
        for ln in re.split(r"[\n\r]+", excel_value):
            ln = ln.strip()
            if 3 <= len(ln) <= 40:
                hits_in.append(ln)
            if len(hits_in) >= 8:
                break

    checks: list[dict] = []
    hits: list[dict] = []
    context: list[dict] = []
    zone = expected_zone(fg, fl, words, page_w=page_w, page_h=page_h)

    # ── 策略：pin 短字段 ──
    if fg in ("logo标识", "中文品名", "英文品名", "净含量", "条形码", "二维码"):
        # 排除 VL 歪坐标；净含量/条码优先右栏
        pin_words = [
            w
            for w in words
            if not str(w.get("source") or "").startswith("paddle_vl")
            and not w.get("vl_tag")
        ] or words
        q = (primary_query or excel_value or "").strip().split("\n")[0]
        prefer = {
            "logo标识": r"Cell|Grrshula|Grrsh",
            "中文品名": r"精华面膜|光感焕能|面膜",
            "英文品名": r"BRIGHTENING|VITALIZING|ESSENCE",
            "净含量": r"净含量",
            "条形码": r"\d{8,14}",
            "二维码": r"公众号|扫码",
        }.get(fg)
        exclude = {
            "logo标识": r"BRIGHTENING|VITALIZING|ESSENCE\s*MASK|净含量|步骤0",
            "中文品名": r"公众号|命名依据|步骤0|成分",
            "英文品名": r"Cell\s*Grr|公众号|净含量",
            "净含量": r"成分|步骤\s*0|步骤\s*[\.．]|涂·|敷·|光感透亮|沁润|柔嫩",
            "条形码": r"许可证|备案|步骤|透亮|光感",
            "二维码": r"BRIGHTENING|成分",
        }.get(fg)

        def _pin_ok(b: dict | None, *, min_w: int = 40) -> bool:
            if not b:
                return False
            # 拒掉异常小框（单字「2」）
            if int(b.get("width") or 0) < min_w and int(b.get("height") or 0) < 20:
                return False
            mt = str(b.get("matched_text") or "")
            if re.fullmatch(r"\d{1,3}", mt) and len(q) > 5:
                return False
            return True

        if fg == "条形码":
            for code in re.findall(r"\d{8,14}", excel_value or "")[:4]:
                b = locate_phrase_span(
                    code,
                    pin_words,
                    min_score=94.0,
                    prefer_re=prefer,
                    exclude_re=exclude,
                    label=code,
                    max_window=8,
                )
                # 必须 matched 含完整目标码（禁止 1929 框到 1912）
                mt = str(b.get("matched_text") or "") if b else ""
                if b and code in re.sub(r"\D", "", mt + str(b.get("label") or "")):
                    if _pin_ok(b, min_w=60):
                        b["label"] = code
                        hits.append(b)
            # 硬扫词表：整段数字，要求码完全一致
            if not hits:
                for w in pin_words:
                    t = re.sub(r"\D", "", w.get("text") or "")
                    for code in re.findall(r"\d{8,14}", excel_value or "")[:4]:
                        if t == code or (len(t) >= 12 and code in t):
                            bb = _box(w, label=code)
                            if bb and _pin_ok(bb, min_w=50):
                                hits.append(bb)
                                break
        elif fg == "净含量":
            # 先锚「净含量」字面，再扩同栏 ml/片
            b = locate_phrase_span(
                "净含量",
                pin_words,
                min_score=88.0,
                prefer_re=r"净含量",
                exclude_re=exclude,
                label="净含量",
                max_window=6,
            )
            if not _pin_ok(b, min_w=50):
                b = None
            if not b:
                # 再试「ml」+「片」组合，要求右栏
                x_min = page_w * 0.45 if page_w else None
                b = locate_phrase_span(
                    "ml",
                    pin_words,
                    min_score=90.0,
                    prefer_re=r"\d+\s*ml|片",
                    exclude_re=exclude,
                    x_min=x_min,
                    label="净含量",
                    max_window=10,
                )
                if b and not re.search(r"ml|片|净含量", str(b.get("matched_text") or ""), re.I):
                    b = None
            if b and _pin_ok(b, min_w=40):
                # 同 y 邻域扩一层含 ml 的词
                y0 = int(b["top"]) - 30
                y1 = int(b["top"]) + int(b["height"]) + 80
                x0 = max(0, int(b["left"]) - 40)
                neigh = []
                for w in pin_words:
                    loc = w.get("location") or {}
                    top = int(loc.get("top") or 0)
                    left = int(loc.get("left") or 0)
                    tw = w.get("text") or ""
                    if y0 <= top <= y1 and left >= x0 - 20:
                        if re.search(r"净含量|ml|片|精华液|面膜", tw, re.I):
                            bb = _box(w, label="净含量")
                            if bb:
                                neigh.append(bb)
                if neigh:
                    u = _union(neigh + [b], pad=adaptive_pad(pin_words), role="hit")
                    for x in u:
                        x["label"] = "净含量"
                    hits.extend(u)
                else:
                    hits.append(b)
        else:
            # logo：先扫纯商标词，避免「使用方法：Cell…」/竖条数字
            if fg == "logo标识":
                best_logo = None
                best_score = -1.0
                for w in pin_words:
                    raw = (w.get("text") or "").strip()
                    if not re.search(r"Cell\s*Grr|Grrshula|Grrshu", raw, re.I):
                        continue
                    if re.search(r"使用方法|成分|步骤\s*0|净含量|整体组合商标", raw):
                        continue
                    if re.fullmatch(r"\d{1,4}", raw):
                        continue
                    bb = _box(w, label=raw[:20])
                    if not bb:
                        continue
                    # 略宽略像商标：优先含完整 Cell + 合理宽高，拒 30px 竖条
                    sc = float(len(raw))
                    if re.search(r"Cell\s*Grrsh", raw, re.I):
                        sc += 20
                    if int(bb.get("width") or 0) >= 60:
                        sc += 15
                    if int(bb.get("width") or 0) < 28 and int(bb.get("height") or 0) > 40:
                        sc -= 30  # 竖细条降权
                    if sc > best_score:
                        best_score = sc
                        best_logo = bb
                if best_logo and _pin_ok(best_logo, min_w=28):
                    # 同 y 并邻域扩宽（防只框首字母）
                    y0 = int(best_logo["top"]) - 12
                    y1 = int(best_logo["top"]) + int(best_logo["height"]) + 12
                    x0 = max(0, int(best_logo["left"]) - 20)
                    x1 = int(best_logo["left"]) + int(best_logo["width"]) + 220
                    neigh = [best_logo]
                    for w in pin_words:
                        loc = w.get("location") or {}
                        top = int(loc.get("top") or 0)
                        left = int(loc.get("left") or 0)
                        tw = w.get("text") or ""
                        if not (y0 <= top <= y1 and x0 - 10 <= left <= x1):
                            continue
                        if re.search(r"Cell|Grr|译龄|logo", tw, re.I) or (
                            2 <= len(tw) <= 16 and re.search(r"[A-Za-z\u4e00-\u9fff]", tw)
                        ):
                            if re.search(r"使用方法|步骤0|成分：", tw):
                                continue
                            bb = _box(w, label=tw[:16])
                            if bb:
                                neigh.append(bb)
                    u = _union(neigh, pad=adaptive_pad(pin_words), role="hit")
                    for x in u:
                        x["label"] = "logo"
                        # 仍过窄则人工拉宽
                        if int(x.get("width") or 0) < 80:
                            x["width"] = max(120, int(x.get("width") or 0) + 100)
                    hits.extend(u)
                else:
                    b = locate_phrase_span(
                        "Cell Grrshula",
                        pin_words,
                        min_score=80.0,
                        prefer_re=prefer,
                        exclude_re=r"使用方法|整体组合商标|步骤0|净含量|BRIGHTENING",
                        label="logo",
                        max_window=6,
                    )
                    if b and not re.search(r"使用方法", str(b.get("matched_text") or "")):
                        if _pin_ok(b, min_w=28):
                            if int(b.get("width") or 0) < 80:
                                b["width"] = max(120, int(b.get("width") or 0) + 100)
                            hits.append(b)
            else:
                b = locate_phrase_span(
                    q,
                    pin_words,
                    min_score=86.0,
                    prefer_re=prefer,
                    exclude_re=exclude,
                    label=fg[:8],
                )
                if b and _pin_ok(b, min_w=40):
                    hits.append(b)
        # 二维码疑点：码区期望
        if fg == "二维码" and zone:
            z = dict(zone)
            z["role"] = "check"
            z["status"] = "warn"
            z["label"] = "请扫码核对"
            checks.append(z)

    # ── 成分 block ──
    elif fg == "成分表" or "成分" in fl:
        step = (
            "1"
            if re.search(r"步骤\s*0*1|精华液", fl)
            else ("2" if re.search(r"步骤\s*0*2|面膜", fl) else "")
        )
        # 定位只用 accurate/裁块词，排除 Paddle-VL 块坐标（比例易偏，会把整段框拉飞）
        locate_words = [
            w
            for w in words
            if not str(w.get("source") or "").startswith("paddle_vl")
            and not w.get("vl_tag")
        ] or words
        bands = step_y_bands(locate_words)
        band_words = locate_words
        y_band = None
        if step and step in bands:
            y_band = bands[step]
            band_words = words_in_y_band(locate_words, y_band[0], y_band[1]) or locate_words
        tq = "步骤01" if step == "1" else ("步骤02" if step == "2" else "步骤")
        # 刀版常左图右字：步骤0X 标题取「最靠右」的真锚，禁止命中左侧「步骤.涂/敷」
        step_pat = (
            re.compile(r"步骤\s*0*1")
            if step == "1"
            else re.compile(r"步骤\s*0*2")
            if step == "2"
            else re.compile(r"步骤\s*0*\d")
        )
        step_cands: list[dict] = []
        for w in locate_words:
            raw = w.get("text") or ""
            if not step_pat.search(raw):
                continue
            # 排除用法区「步骤.涂·精华液」与脚注「昵称」
            if re.search(r"涂|敷|·", raw) and not re.search(r"步骤\s*0*[12]", raw):
                continue
            if re.search(r"步骤\s*[\.．、]?\s*(涂|敷)", raw):
                continue
            if re.search(r"昵称|为本品步骤", raw):
                continue
            bb = _box(w, role="hit", label=tq)
            if bb:
                # 附原文便于排序
                bb["_raw"] = raw
                step_cands.append(bb)
        tb = None
        if step_cands:
            # 真成分标题优先：含「精华液/面膜/成分」+ 合理宽度 + 偏右
            def _step_rank(b: dict) -> tuple:
                raw = b.get("_raw") or ""
                w = int(b.get("width") or 0)
                left = int(b.get("left") or 0)
                has_title = 1 if re.search(r"精华液|面膜|成分", raw) else 0
                not_thin = 1 if w >= 40 else 0
                return (has_title, not_thin, left, w)

            tb = max(step_cands, key=_step_rank)
            tb = {k: v for k, v in tb.items() if k != "_raw"}
        if not tb:
            tb = locate_phrase_span(
                tq,
                words,
                min_score=88.0,
                prefer_re=r"步骤\s*0*[12].{0,6}(精华|面膜)?",
                exclude_re=r"步骤\s*[\.．]?\s*(涂|敷)|涂·|敷·|昵称",
                x_min=float(page_w) * 0.42 if page_w else None,
                label=tq,
            )
        # 右栏默认：以步骤标题为锚，向左至少覆盖半栏，向右拉满
        if tb:
            col_left = max(0, min(int(tb["left"]) - 40, int(page_w * 0.48)))
            # 标题若是细竖条，强制从页面中线起算
            if int(tb.get("width") or 0) < 50:
                col_left = max(0, int(page_w * 0.48))
            col_right = int(page_w * 0.99) if page_w else int(tb["left"]) + 900
        else:
            col_left = int(page_w * 0.48)
            col_right = int(page_w * 0.98)
        # y 带：有 band 用 band；否则以标题上下扩
        if y_band is None and tb:
            y_band = (
                max(0, int(tb["top"]) - 20),
                int(tb["top"]) + max(int(tb.get("height") or 20) + 220, 260),
            )
            band_words = (
                words_in_y_band(locate_words, y_band[0], y_band[1]) or locate_words
            )
        col_words = _filter_words(
            band_words, x_min=col_left, x_max=col_right
        ) or _filter_words(words, x_min=col_left)
        # 优先并入成分语义词，避免只并到竖条数字
        ing_like = []
        other_boxes = []
        for w in col_words:
            raw = w.get("text") or ""
            bb = _box(w, role="hit", label=tq)
            if not bb:
                continue
            if re.fullmatch(r"[\d\s./\-]+", raw) and len(raw) <= 4:
                continue  # 跳过孤立数字
            if re.search(
                r"成分|步骤\s*0|提取|甘油|水|酸|醇|肽|油|微量|精华|面膜|丁二醇|烟酰胺",
                raw,
            ) or len(raw) >= 4:
                ing_like.append(bb)
            else:
                other_boxes.append(bb)
        band_boxes = ing_like or other_boxes
        if band_boxes:
            full = _union(band_boxes, pad=adaptive_pad(col_words), role="hit")
            for b in full:
                b["label"] = f"{tq}·整段" if step else "成分整段"
                b["locate"] = "block_band"
                # 拒「细竖条」：宽过窄说明栏锚偏了，向左扩到右栏内容
                if int(b.get("width") or 0) < 180:
                    left_new = max(0, min(int(b["left"]) - 500, int(page_w * 0.48)))
                    right_edge = max(
                        int(b["left"]) + int(b["width"]),
                        left_new + 520,
                        int(page_w * 0.92) if page_w else left_new + 700,
                    )
                    b["left"] = left_new
                    b["width"] = max(200, right_edge - left_new)
                    y0b, y1b = int(b["top"]) - 10, int(b["top"]) + max(
                        int(b["height"]), 160
                    )
                    extra = []
                    for w in locate_words:
                        loc = w.get("location") or {}
                        top = int(loc.get("top") or 0)
                        left = int(loc.get("left") or 0)
                        if y0b - 30 <= top <= y1b + 40 and left >= left_new - 20:
                            raw = w.get("text") or ""
                            if re.fullmatch(r"[\d\s./\-]+", raw) and len(raw) <= 4:
                                continue
                            if re.search(
                                r"成分|微量|提取|甘油|步骤\s*0|油|肽|酸|醇|水|精华|面膜|"
                                r"丁二醇|烟酰胺|卵磷脂|维生素|酵母",
                                raw,
                            ) or len(raw) >= 6:
                                bb = _box(w, role="hit", label=tq)
                                if bb:
                                    extra.append(bb)
                    if extra:
                        u2 = _union(extra + [b], pad=10, role="hit")
                        for x in u2:
                            x["label"] = f"{tq}·整段" if step else "成分整段"
                            x["locate"] = "block_band_expanded"
                            if int(x.get("width") or 0) < 180:
                                x["left"] = left_new
                                x["width"] = max(400, int(page_w * 0.45) if page_w else 500)
                        hits.extend(u2)
                        continue
                hits.append(b)
        # miss：带内 span，否则带底黄条
        for mp in misses[:5]:
            cn = re.sub(r"[（(][^）)]+[）)]", "", mp).strip()[:20]
            mb = locate_phrase_span(
                cn,
                col_words,
                min_score=82.0,
                role="check",
                status="warn",
                label=f"未见?{mp[:14]}",
            )
            if mb:
                checks.append(mb)
            elif hits:
                base = hits[-1]
                checks.append(
                    {
                        "page": int(base.get("page") or 1),
                        "left": int(base["left"]),
                        "top": max(
                            int(base["top"]),
                            int(base["top"]) + int(base["height"]) - 30,
                        ),
                        "width": int(base["width"]),
                        "height": 28,
                        "role": "check",
                        "status": "warn",
                        "label": f"未见:{mp[:14]}",
                        "locate": "expect_strip",
                    }
                )

    # ── 文案 multi ──
    elif fg == "文案":
        words = [
            w
            for w in words
            if not str(w.get("source") or "").startswith("paddle_vl")
            and not w.get("vl_tag")
        ] or words
        regions = [
            ("英文主标题", "BRIGHTENING VITALIZING ESSENCE MASK", r"BRIGHTENING|ESSENCE"),
            ("中文品名", "译龄光感焕能精华面膜", r"精华面膜|光感焕能"),
            ("卖点透亮", "光感透亮", r"光感透亮|透亮"),
            ("卖点保湿", "沁润保湿", r"沁润|保湿"),
            ("卖点柔嫩", "柔嫩细腻", r"柔嫩|细腻"),
            ("步骤涂", "涂·精华液", r"涂·|涂精华|1步骤|步骤1"),
            ("步骤敷", "敷·面膜", r"敷·|敷面膜|2步骤|步骤2"),
        ]
        for name, q, pref in regions:
            b = locate_phrase_span(
                q,
                words,
                min_score=88.0,
                prefer_re=pref,
                exclude_re=r"成分|其他微量|净含量|备案|BRIGHTENING",
                label=name,
                max_window=6,
            )
            if b and int(b.get("width") or 0) < 400:
                hits.append(b)
        # 脚注：净含量上
        net = locate_phrase_span("净含量", words, min_score=88.0, prefer_re=r"净含量")
        foot_qs = [
            ("商标脚注", "整体组合商标", r"组合商标|品牌标识|Grrshula"),
            ("25+脚注", "25+", r"25\+|肌肤研制"),
            ("设计元素", "设计元素", r"设计元素|产品实物"),
            ("昵称脚注", "昵称", r"昵称|步骤01"),
        ]
        foot_pins = []
        if net:
            y_band = (max(0, int(net["top"]) - 180), int(net["top"]) + 8)
            x_min = max(0, int(net["left"]) - 40)
            for name, q, pref in foot_qs:
                b = locate_phrase_span(
                    q,
                    words,
                    min_score=82.0,
                    y_band=y_band,
                    x_min=x_min,
                    prefer_re=pref,
                    label=name,
                )
                if b:
                    foot_pins.append(b)
            # 扫关键词行
            for w in _filter_words(words, y_band=y_band, x_min=x_min):
                t = w.get("text") or ""
                if re.search(
                    r"组合商标|品牌标识|设计元素|25\+|昵称|Grrshula|产品实物|无其他含义",
                    t,
                    re.I,
                ):
                    bb = _box(w, role="hit", label="脚注")
                    if bb:
                        foot_pins.append(bb)
        if foot_pins:
            u = _union(foot_pins, pad=adaptive_pad(words), role="hit")
            for b in u:
                b["label"] = "脚注条款·净含量上"
                b["locate"] = "footnote_band"
                hits.append(b)
        elif zone:
            context.append(dict(zone, role="context", status="ok", label="脚注区上下文"))

        for mp in misses[:5]:
            q = re.sub(r"[*＊\"“”：:]", "", mp).strip()[:24]
            y_band = None
            x_min = None
            if net:
                y_band = (max(0, int(net["top"]) - 160), int(net["top"]) + 12)
                x_min = max(0, int(net["left"]) - 40)
            mb = locate_phrase_span(
                q,
                words,
                min_score=78.0,
                y_band=y_band,
                x_min=x_min,
                role="check",
                status="warn",
                label=f"漏印?{mp[:12]}",
            )
            if mb:
                checks.append(mb)
            elif zone:
                z = dict(zone)
                z["role"] = "check"
                z["status"] = "warn"
                z["label"] = f"漏印区:{mp[:12]}"
                z["locate"] = "expected_zone"
                checks.append(z)

    # ── 生产 / 用法 block ──
    elif fg in ("生产信息", "使用方法"):
        loc_w = [
            w
            for w in words
            if not str(w.get("source") or "").startswith("paddle_vl")
            and not w.get("vl_tag")
        ] or words
        keys = (
            ["备案人", "生产企业", "许可证", "执行标准", "产地", "检验合格", "产品名称", "沪妆"]
            if fg == "生产信息"
            else ["使用方法", "贮存条件", "注意", "静敷", "第一步", "第二步"]
        )
        pins = []
        for k in keys:
            b = locate_phrase_span(
                k,
                loc_w,
                min_score=84.0,
                label=k,
                # 生产信息多在右下，避免吸到左卖点
                x_min=(page_w * 0.42) if (fg == "生产信息" and page_w) else None,
            )
            if b and int(b.get("width") or 0) >= 30:
                pins.append(b)
        if pins:
            # 生产：合并为 1～2 大块（整段备案/生产企业），不要只剩「检验合格」小条
            for cl in _cluster_by_y(pins, gap=160)[:2]:
                u = _union(cl, pad=max(12, adaptive_pad(loc_w) + 4), role="hit")
                for x in u:
                    x["label"] = "生产信息" if fg == "生产信息" else "使用方法"
                    # 生产块过窄时，向右扩到栏宽
                    if fg == "生产信息" and int(x.get("width") or 0) < 280:
                        x["width"] = min(
                            int(page_w - x["left"] - 20) if page_w else 400,
                            max(320, int(x["width"])),
                        )
                hits.extend(u)
        for mp in misses[:3]:
            mb = locate_phrase_span(
                re.sub(r"[（(][^）)]+[）)]", "", mp)[:16],
                loc_w,
                min_score=82.0,
                role="check",
                status="warn",
                label=f"未见?{mp[:12]}",
                x_min=(page_w * 0.42) if (fg == "生产信息" and page_w) else None,
            )
            if mb:
                checks.append(mb)
            elif zone:
                checks.append(dict(zone, label=f"未见区:{mp[:12]}"))

    else:
        # 通用：hit 短语 span + miss 期望
        for hp in (hits_in or [primary_query or ""])[:10]:
            b = locate_phrase_span(hp, words, min_score=86.0, label=hp[:16])
            if b:
                hits.append(b)
        for mp in misses[:4]:
            mb = locate_phrase_span(
                mp[:20],
                words,
                min_score=80.0,
                role="check",
                status="warn",
                label=f"未见?{mp[:12]}",
            )
            if mb:
                checks.append(mb)
            elif zone:
                checks.append(dict(zone, label=f"未见区:{mp[:12]}"))

    # 组装：黄框优先（疑点视线）→ 绿命中 → 上下文
    out = _dedupe_boxes(checks + hits + context)
    # 限量：check 最多 5，hit 最多 8
    c = [b for b in out if b.get("role") in ("check", "miss_anchor")][:5]
    h = [b for b in out if b.get("role") in (None, "hit")][:8]
    ctx = [b for b in out if b.get("role") == "context"][:1]
    return c + h + ctx


def step_y_bands(ocr_words: list[dict]) -> dict[str, tuple[float, float]]:
    anchors: list[tuple[str, float]] = []
    for w in ocr_words:
        t = w.get("text") or ""
        loc = w.get("location") or {}
        y = float(loc.get("top") or 0) + float(loc.get("height") or 0) / 2
        if re.search(r"步骤\s*0*1|步骤01", t):
            anchors.append(("1", y))
        if re.search(r"步骤\s*0*2|步骤02", t):
            anchors.append(("2", y))
    if not anchors:
        return {}
    ys = [
        float((w.get("location") or {}).get("top") or 0)
        + float((w.get("location") or {}).get("height") or 0)
        for w in ocr_words
    ]
    page_h = max(ys) if ys else 2400
    y1s = [y for k, y in anchors if k == "1"]
    y2s = [y for k, y in anchors if k == "2"]
    bands: dict[str, tuple[float, float]] = {}
    if y1s:
        top = min(y1s) - 12
        bot = (min(y2s) - 8) if y2s else min(y1s) + page_h * 0.22
        bands["1"] = (max(0.0, top), max(top + 50, bot))
    if y2s:
        top = min(y2s) - 12
        bot = page_h * 0.72
        for w in ocr_words:
            t = w.get("text") or ""
            if re.search(r"使用方法|贮存条件|备案人|生产企业|净含量[：:]", t):
                yy = float((w.get("location") or {}).get("top") or 0)
                if yy > top + 40:
                    bot = min(bot, yy - 6)
        bands["2"] = (max(0.0, top), max(top + 50, bot))
    return bands


def words_in_y_band(
    ocr_words: list[dict], y0: float, y1: float, *, page: int | None = None
) -> list[dict]:
    out = []
    for w in ocr_words:
        if page is not None and int(w.get("page") or 1) != page:
            continue
        loc = w.get("location") or {}
        y = float(loc.get("top") or 0) + float(loc.get("height") or 0) / 2
        if y0 <= y <= y1:
            out.append(w)
    return out


def extract_excel_barcodes(excel_value: str) -> list[str]:
    return re.findall(r"\d{8,14}", excel_value or "")


def refine_field_boxes(
    *,
    field_group: str,
    field: str,
    excel_value: str,
    primary_query: str,
    ocr_words: list[dict],
    existing_boxes: list[dict] | None,
    miss_phrases: list[str] | None,
    page_w: int = 2200,
    page_h: int = 2400,
    hit_phrases: list[str] | None = None,
) -> list[dict]:
    """
    最终展示框：工业双轨（词级 span 命中 + 疑点期望区）。
    不回退到错误的 existing 大框。
    """
    dual = locate_dual_evidence(
        field_group=field_group or "",
        field=field or "",
        excel_value=excel_value or "",
        primary_query=primary_query or "",
        ocr_words=ocr_words or [],
        miss_phrases=list(miss_phrases or []),
        hit_phrases=list(hit_phrases or []),
        page_w=page_w,
        page_h=page_h,
    )
    if dual:
        return dual[:12]
    # 宁可不框，不框错
    if (field_group or "") in (
        "logo标识",
        "中文品名",
        "英文品名",
        "净含量",
        "条形码",
        "二维码",
    ):
        return []
    return list(existing_boxes or [])[:1]
