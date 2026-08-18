"""
跨规格 / PDF 内双页 / 双 PDF 文案对齐

行业设计（包装核对隐性知识）：
- 本质：同一产品不同面/规格，查「非预期文案是否被改动」
- 预期可不同：净含量、条码、片数/装型、纯工艺表、印刷标记
- 应对齐：品名、卖点、用法、成分主文、备案主体、脚注含义
- 不做「逐行必须 1:1」——刀版两页阅读序/分栏不同，逐行对齐会刷屏假缺失
- 做「关键短语双向覆盖 + 去规格归一 + LCS 细 diff」

输出 hits 兼容前端双图：bboxes / bboxes_b · dual_track role hit|check
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

from rapidfuzz import fuzz

from app.fields import normalize

# 白名单：规格/装型类
WHITELIST_KW = (
    "净含量",
    "含量",
    "条形码",
    "条码",
    "规格",
    "片×",
    "片x",
    "eann",
    "isbn",
)

RE_VOLUME = re.compile(
    r"\d+(?:\.\d+)?\s*(?:ml|mL|ML|g|G|克|毫升|kg|KG)",
    re.I,
)
RE_BARCODE = re.compile(r"(?<!\d)\d{12,14}(?!\d)")
RE_PIECE = re.compile(r"×\s*\d+\s*片|\d+\s*片|[15]\s*片装?", re.I)

# OCR/工艺噪声：不参与「应对齐」
NOISE_RE = re.compile(
    r"(?:"
    r"PRINTED\s*WITH|SOY\s*INK|FSC|T\d{4,}|"
    r"工艺说明|刀版|出血|专色|CMYK|PANTONE|"
    r"^[\d\W]{1,4}$|"
    r"^[A-Za-z]$|"
    r"ONV\s|SNIZ|ISIOW"  # OCR 乱码常见
    r")",
    re.I,
)

# 高价值锚点：这些漏了才算真问题
ANCHOR_KW = (
    "产品名称",
    "使用方法",
    "贮存条件",
    "备案人",
    "生产企业",
    "许可证",
    "执行标准",
    "成分",
    "其他微量",
    "注意",
    "扫码",
    "公众号",
)


def ocr_lines(words: list[dict], page: int | None = None) -> list[dict]:
    """OCR 词 → 行（同页 y 邻近合并）。"""
    lines: list[dict] = []
    buf: list[dict] = []
    last_top = None
    ordered = sorted(
        words or [],
        key=lambda w: (
            int(w.get("page") or 1),
            int((w.get("location") or {}).get("top") or 0),
            int((w.get("location") or {}).get("left") or 0),
        ),
    )
    for w in ordered:
        if page is not None and int(w.get("page") or 1) != page:
            continue
        text = (w.get("text") or "").strip()
        if not text:
            continue
        loc = w.get("location") or {}
        top = int(loc.get("top") or 0)
        if last_top is not None and abs(top - last_top) > 22 and buf:
            lines.append(_flush_line(buf))
            buf = []
        buf.append(w)
        last_top = top
    if buf:
        lines.append(_flush_line(buf))
    return [ln for ln in lines if len(normalize(ln["text"])) >= 2]


def _flush_line(buf: list[dict]) -> dict:
    text = "".join((w.get("text") or "") for w in buf)
    boxes = []
    page = 1
    for w in buf:
        loc = w.get("location") or {}
        page = int(w.get("page") or 1)
        if loc.get("width") or loc.get("height"):
            boxes.append(
                {
                    "page": page,
                    "left": int(loc.get("left") or 0),
                    "top": int(loc.get("top") or 0),
                    "width": int(loc.get("width") or 0),
                    "height": int(loc.get("height") or 0),
                    "role": "hit",
                    "status": "ok",
                }
            )
    return {"text": text.strip(), "bboxes": boxes, "page": page, "words": buf}


def _strip_spec_tokens(s: str) -> str:
    t = s or ""
    t = RE_VOLUME.sub("§V§", t)
    t = RE_BARCODE.sub("§B§", t)
    t = RE_PIECE.sub("§P§", t)
    t = re.sub(r"\d+(?:\.\d+)?", "§N§", t)
    return normalize(t)


def is_whitelist_line(text: str) -> bool:
    n = normalize(text)
    if any(normalize(k) in n for k in WHITELIST_KW):
        return True
    stripped = RE_VOLUME.sub("", text or "")
    stripped = RE_BARCODE.sub("", stripped)
    stripped = RE_PIECE.sub("", stripped)
    if len(normalize(stripped)) <= 2 and (
        RE_VOLUME.search(text or "") or RE_BARCODE.search(text or "")
    ):
        return True
    return False


def is_noise_line(text: str) -> bool:
    t = (text or "").strip()
    if len(normalize(t)) < 3:
        return True
    if NOISE_RE.search(t):
        return True
    # Paddle/zone 元标记不当比对句
    if re.search(
        r"\[paddle|\[footnote|\[ingredients|\[production|zone_boost|right_col|"
        r"production_net|production_mid|footnote_above",
        t,
        re.I,
    ):
        return True
    if re.fullmatch(r"\[[\w_\-]+\]", t):
        return True
    # HTML / 刀版导出残片 / VL 杂讯
    if re.search(r"</?(?:td|tr|table|div|span|br|img)\b|</?table|&nbsp;|https?://|bcebos|xmind", t, re.I):
        return True
    if re.search(r"[<>]{2,}|^\s*[|\\/]+\s*$", t):
        return True
    # 过碎成分碎片（无中文且短）
    if len(t) < 8 and not re.search(r"[\u4e00-\u9fff]", t):
        return True
    # 纯拉丁乱码
    if re.fullmatch(r"[A-Za-z0-9\s\-\./]{3,20}", t) and not re.search(
        r"(Dr\.|DH|MASK|ESSENCE|MOIST|BRIGHT)", t, re.I
    ):
        if not re.search(r"[aeiouAEIOU]{2,}", t):
            return True
    return False


def _core_cn_covered(phrase: str, text: str, *, min_hit: float = 0.6) -> bool:
    """短语核心中文块是否在对侧全文出现（抗 OCR 断行）。"""
    cores = re.findall(r"[\u4e00-\u9fff]{3,10}", phrase or "")
    if len(cores) < 2:
        return False
    nt = normalize(text or "")
    hit = sum(1 for c in cores if normalize(c) in nt)
    return hit >= max(2, int(len(cores) * min_hit))


def only_spec_differs(a: str, b: str) -> bool:
    sa, sb = _strip_spec_tokens(a), _strip_spec_tokens(b)
    if not sa and not sb:
        return True
    if sa == sb:
        return True
    return fuzz.ratio(sa, sb) >= 92


def extract_key_phrases(text: str, *, max_n: int = 48) -> list[str]:
    """
    从整页 OCR 抽「应对齐」关键短语（非逐行）。
    优先：锚点句、中文 ≥6 字、卖点/备案。
    """
    raw = text or ""
    # 去掉 HTML/刀版残片与 paddle 标记行
    raw = re.sub(r"</?(?:td|tr|table|div|span|br|p)[^>]*>", " ", raw, flags=re.I)
    raw = re.sub(r"\[paddle_vl[^\]]*\]", " ", raw, flags=re.I)
    raw = re.sub(r"\[(?:footnote|ingredients|zone)[^\]]*\]", " ", raw, flags=re.I)
    raw = re.sub(r"[ \t]{2,}", " ", raw)
    phrases: list[str] = []
    # 锚点整句
    for m in re.finditer(
        r"(?:产品名称|使用方法|贮存条件|备案人|生产企业|执行标准|许可证)[：:][^\n]{4,80}",
        raw,
    ):
        phrases.append(m.group(0).strip())
    for ln in re.split(r"[\n\r]+", raw):
        ln = ln.strip()
        if not ln or is_noise_line(ln) or is_whitelist_line(ln):
            continue
        n = normalize(ln)
        if len(n) < 6:
            continue
        # 过长切开
        if len(ln) > 60:
            for p in re.split(r"[，,。；;、]", ln):
                p = p.strip()
                if len(normalize(p)) >= 6 and not is_noise_line(p):
                    phrases.append(p)
        else:
            phrases.append(ln)
    # 中文卖点 4–16 字
    for m in re.findall(r"[\u4e00-\u9fff]{4,16}", raw):
        if m in ("使用方法", "贮存条件", "产品名称", "其他微量成分"):
            continue
        phrases.append(m)

    # 去重保序，优先长
    seen: set[str] = set()
    out: list[str] = []
    for p in sorted(phrases, key=lambda x: (-len(normalize(x)), x)):
        k = normalize(p)
        if len(k) < 4 or k in seen:
            continue
        if is_noise_line(p):
            continue
        # 子串被更长覆盖则跳过短的
        if any(k != normalize(o) and k in normalize(o) for o in out[:20]):
            continue
        seen.add(k)
        out.append(p)
        if len(out) >= max_n:
            break
    return out


def phrase_in_text(phrase: str, text: str) -> bool:
    n = normalize(phrase)
    nt = normalize(text)
    if len(n) < 3:
        return False
    if n in nt:
        return True
    ns = _strip_spec_tokens(phrase)
    if len(ns) >= 4 and ns in _strip_spec_tokens(text):
        return True
    if len(n) >= 8:
        return float(fuzz.partial_ratio(n[:48], nt[:12000])) >= 90
    # 锚点拆核
    cores = re.findall(r"[\u4e00-\u9fff]{3,8}", phrase)
    if len(cores) >= 2:
        hit = sum(1 for c in cores if normalize(c) in nt)
        if hit >= max(2, int(len(cores) * 0.6)):
            return True
    return False


def locate_phrase_boxes(phrase: str, words: list[dict]) -> list[dict]:
    """词级定位（复用 evidence_locate span）。"""
    try:
        from app.evidence_locate import locate_phrase_span

        b = locate_phrase_span(
            phrase,
            words,
            min_score=84.0,
            role="hit",
            status="ok",
            label=(phrase or "")[:20],
            max_window=12,
        )
        return [b] if b else []
    except Exception:
        pass
    # 兜底：行级
    n = normalize(phrase)
    for ln in ocr_lines(words):
        if n and n in normalize(ln["text"]):
            return ln.get("bboxes") or []
    return []


def char_lcs_diff_spans(a: str, b: str) -> dict[str, Any]:
    """
    字符级 diff（SequenceMatcher ≈ LCS 分块）。
    返回 only_a / only_b / equal 片段，用于「只标差那几个字」。
    """
    sa, sb = a or "", b or ""
    sm = SequenceMatcher(None, sa, sb, autojunk=False)
    only_a: list[str] = []
    only_b: list[str] = []
    equal: list[str] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            if i2 - i1 >= 2:
                equal.append(sa[i1:i2])
        elif tag == "delete":
            only_a.append(sa[i1:i2])
        elif tag == "insert":
            only_b.append(sb[j1:j2])
        elif tag == "replace":
            only_a.append(sa[i1:i2])
            only_b.append(sb[j1:j2])
    ratio = sm.ratio()
    return {
        "ratio": ratio,
        "only_a": [x for x in only_a if normalize(x)],
        "only_b": [x for x in only_b if normalize(x)],
        "equal_sample": equal[:3],
    }


def boxes_for_char_fragments(
    fragments: list[str], words: list[dict], *, role: str = "check"
) -> list[dict]:
    """把 diff 出的短片段框到词上。"""
    out: list[dict] = []
    for fr in fragments[:6]:
        fr = (fr or "").strip()
        if len(normalize(fr)) < 1:
            continue
        # 太长取核
        q = fr if len(fr) <= 16 else fr[:16]
        try:
            from app.evidence_locate import locate_phrase_span

            b = locate_phrase_span(
                q,
                words,
                min_score=78.0,
                role=role,
                status="warn" if role == "check" else "ok",
                label=f"差:{q[:12]}",
                max_window=8,
            )
            if b:
                out.append(b)
                continue
        except Exception:
            pass
        # 单字扫
        nq = normalize(q)
        for w in words or []:
            if nq and nq in normalize(w.get("text") or ""):
                loc = w.get("location") or {}
                if loc.get("width"):
                    out.append(
                        {
                            "page": int(w.get("page") or 1),
                            "left": int(loc.get("left") or 0),
                            "top": int(loc.get("top") or 0),
                            "width": int(loc.get("width") or 0),
                            "height": int(loc.get("height") or 0),
                            "role": role,
                            "status": "warn" if role == "check" else "ok",
                            "label": f"差:{q[:10]}",
                            "locate": "char_frag",
                        }
                    )
                    break
    return out


def _hit(
    hid: str,
    field: str,
    excel_value: str,
    status: str,
    evidence: str,
    score: float,
    *,
    category: str,
    bboxes: list | None = None,
    bboxes_b: list | None = None,
    side: str = "both",
    text_b: str = "",
    sequence_diff: dict | None = None,
    doubt_bucket: str | None = None,
) -> dict[str, Any]:
    boxes = list(bboxes or [])
    boxes_b = list(bboxes_b or [])
    return {
        "id": hid,
        "field": field,
        "excel_value": (excel_value or "")[:600],
        "status": status,
        "evidence": evidence,
        "score": score,
        "decision": "pending",
        "bboxes": boxes,
        "bboxes_b": boxes_b,
        "page": (boxes[0].get("page") if boxes else 1) or 1,
        "side": side,
        "category": category,
        "text_b": (text_b or "")[:400],
        "sequence_diff": sequence_diff,
        "doubt_bucket": doubt_bucket,
        "bbox_mode": (
            "dual_track"
            if any(b.get("role") == "check" for b in boxes + boxes_b)
            else ("multi" if len(boxes) + len(boxes_b) > 1 else "point")
        ),
        "no_bbox": not (boxes or boxes_b),
        "long_field": len(excel_value or "") > 80,
        "coverage": None,
    }


def _clean_pack_text(text: str) -> str:
    raw = text or ""
    raw = re.sub(r"</?(?:td|tr|table|div|span|br|p)[^>]*>", " ", raw, flags=re.I)
    raw = re.sub(r"\[paddle_vl[^\]]*\]", " ", raw, flags=re.I)
    raw = re.sub(r"\[(?:footnote|ingredients|zone)[^\]]*\]", " ", raw, flags=re.I)
    raw = re.sub(r"[ \t]{2,}", " ", raw)
    return raw


def extract_align_units(text: str, *, max_n: int = 56) -> list[str]:
    """
    严格 1:1 用的比对单元：锚点句 + 足够长的行/分句。
    **保持 PDF/OCR 阅读序**（先上后下、同行从左到右 = 文本出现序），不按长度重排。
    """
    raw = _clean_pack_text(text)
    # (start_pos, text) 用于按文档顺序
    candidates: list[tuple[int, str]] = []
    # 锚点字段
    for m in re.finditer(
        r"(?:产品名称|使用方法|贮存条件|备案人|生产企业|执行标准|许可证编号|化妆品生产许可证|"
        r"其他微量成分|注意|扫码|成分)[：:][^\n]{6,120}",
        raw,
    ):
        candidates.append((m.start(), m.group(0).strip()))
    # 按行：OCR 输出本身即阅读序
    offset = 0
    for ln in re.split(r"(\n)", raw):
        if ln == "\n":
            offset += 1
            continue
        start = offset
        offset += len(ln)
        s = ln.strip()
        if not s or is_noise_line(s) or is_whitelist_line(s):
            continue
        n = normalize(s)
        if len(n) < 10:
            continue
        # 长行切开，禁止 >80 字进单元（防整页糊块 #2 类问题）
        pieces: list[tuple[int, str]] = []
        if len(s) > 56:
            sub_off = start
            for p in re.split(r"([。；;，,])", s):
                if p in ("。", "；", ";", "，", ","):
                    sub_off += len(p)
                    continue
                p2 = p.strip()
                if len(normalize(p2)) < 10 or is_noise_line(p2):
                    sub_off += len(p)
                    continue
                if len(p2) > 80:
                    for i in range(0, len(p2), 60):
                        chunk = p2[i : i + 60].strip()
                        if len(normalize(chunk)) >= 10:
                            pieces.append((sub_off + i, chunk))
                else:
                    pieces.append((sub_off, p2))
                sub_off += len(p)
        else:
            pieces.append((start, s))
        candidates.extend(pieces)

    # 按出现位置排序；同位置保留较长
    candidates.sort(key=lambda x: (x[0], -len(x[1])))
    seen: set[str] = set()
    out: list[str] = []
    for _pos, p in candidates:
        # 再硬截一次
        if len(p) > 90:
            p = p[:90]
        k = normalize(p)
        if len(k) < 10 or k in seen:
            continue
        if is_noise_line(p):
            continue
        # 整页级超长糊块直接丢
        if len(k) > 100:
            continue
        # 已被已收录更长句包含 → 跳过短碎片
        if any(k != normalize(o) and k in normalize(o) for o in out[-12:]):
            continue
        # 新句包含已收录短句 → 替换短句
        out = [o for o in out if not (normalize(o) != k and normalize(o) in k)]
        if not re.search(r"[\u4e00-\u9fff]{4,}", p) and len(k) < 16:
            continue
        seen.add(k)
        out.append(p)
        if len(out) >= max_n:
            break
    return out


def _read_order_key(
    phrase: str,
    text: str,
    words: list[dict] | None = None,
    *,
    side: str = "a",
) -> tuple:
    """
    阅读序键：(page, top, left, text_index)
    有 OCR 词坐标时用版面位置；否则用全文首次出现位置。
    """
    n = normalize(phrase or "")
    # 词级：找包含该句最多字的词/行
    if words and n and len(n) >= 4:
        best = None
        best_sc = 0
        for w in words:
            wt = normalize(w.get("text") or "")
            if not wt:
                continue
            if n in wt or wt in n or (len(wt) >= 4 and wt[:8] in n):
                sc = len(wt) if wt in n or n in wt else 1
                loc = w.get("location") or {}
                key = (
                    int(w.get("page") or 1),
                    int(loc.get("top") or 0),
                    int(loc.get("left") or 0),
                )
                if sc > best_sc:
                    best_sc = sc
                    best = key
        if best:
            return (*best, 0 if side == "a" else 1)

    raw = text or ""
    # 原文位置
    idx = -1
    for cand in (phrase[:24], phrase[:16], phrase[:10]):
        if cand and cand in raw:
            idx = raw.find(cand)
            break
    if idx < 0:
        nn = normalize(raw)
        for L in (24, 16, 12, 8):
            chunk = n[:L]
            if len(chunk) >= 6 and chunk in nn:
                idx = nn.find(chunk)
                break
    if idx < 0:
        idx = 10**9
    # 无坐标时：用文本偏移模拟 top（行）/ left（列）
    line = raw[: max(0, idx)].count("\n")
    col = idx - (raw.rfind("\n", 0, max(0, idx)) + 1) if idx < 10**9 else 0
    return (1, line * 40, max(0, col), 0 if side == "a" else 1)


def _strict_pair_score(pa: str, pb: str) -> float:
    """
    严格配对分：以 ratio 为主，长度差过大直接压分。
    禁止用 partial 把「整段备案」贴到「半个许可证号」。
    """
    na, nb = normalize(pa), normalize(pb)
    if not na or not nb:
        return 0.0
    la, lb = len(na), len(nb)
    rlen = min(la, lb) / max(la, lb, 1)
    # 长度差过大：几乎不配（短串 ⊂ 长串 且短串够长才勉强）
    if rlen < 0.62:
        shorter, longer = (na, nb) if la <= lb else (nb, na)
        if len(shorter) >= 20 and shorter in longer:
            return 82.0
        return min(70.0, float(fuzz.ratio(na, nb)) * rlen)
    base = float(fuzz.ratio(na, nb))
    base_u = float(fuzz.ratio(_strip_spec_tokens(pa), _strip_spec_tokens(pb)))
    return max(base, base_u)


def _fulltext_really_covers(phrase: str, text: str) -> bool:
    """短语是否真在对侧全文中出现。只认「整段包含」，不做滑窗假覆盖。"""
    n = normalize(phrase or "")
    nt = normalize(text or "")
    if len(n) < 14 or not nt:
        return False
    if n in nt:
        return True
    # 去空白/标点后再包含（断行粘连）
    def _hard(s: str) -> str:
        return re.sub(r"[，,。；;：:、·•\-\s\"'“”|]", "", normalize(s or ""))

    hn, hnt = _hard(phrase), _hard(text)
    if len(hn) >= 14 and hn in hnt:
        return True
    ns, nts = _strip_spec_tokens(phrase), _strip_spec_tokens(text)
    if len(ns) >= 16 and ns in nts:
        return True
    return False


def _ws_content_equal(a: str, b: str) -> bool:
    def _c(s: str) -> str:
        t = normalize(s or "")
        t = re.sub(r"[，,。；;：:、·•\-\s\"'“”|\\n\\r]", "", t)
        return t

    ca, cb = _c(a), _c(b)
    return bool(ca) and ca == cb


def merge_ocr_lines_for_align(text: str) -> str:
    """
    邻行合并：只粘「明显半句」，禁止糊成整页一块。
    硬限制：合并后单段 ≤ MAX_MERGE_LEN。
    """
    MAX_MERGE_LEN = 72
    raw = _clean_pack_text(text)
    lines = [ln.strip() for ln in re.split(r"[\n\r]+", raw) if ln.strip()]
    if not lines:
        return raw
    out: list[str] = []
    buf = lines[0]
    anchor_start = re.compile(
        r"^(?:产品名称|使用方法|贮存条件|备案人|生产企业|执行标准|成分|注意|扫码|"
        r"净含量|许可证|\*|·|Dr\.|精研|水润|馥郁)"
    )
    for ln in lines[1:]:
        # 新锚点 / 已达上限 → 切断
        if (
            anchor_start.match(ln)
            or len(buf) >= MAX_MERGE_LEN
            or len(buf) + len(ln) > MAX_MERGE_LEN
        ):
            out.append(buf)
            buf = ln
            continue
        # 仅「很短且未结束」才粘下一行
        if len(buf) <= 22 and not re.search(r"[。！？；;]$", buf):
            if len(ln) <= 28 and not anchor_start.match(ln):
                buf = buf + ln
                continue
        out.append(buf)
        buf = ln
    out.append(buf)
    return "\n".join(out)


def _hard_chars(s: str) -> str:
    """去空白标点，便于截断/INCI 比较。"""
    t = normalize(s or "")
    return re.sub(
        r"[\s\.\-·•，,。；;：:、\"'“”‘’（）()【】\[\]|/\\]",
        "",
        t,
    )


def _looks_ocr_truncated_tail(s: str) -> bool:
    """
    行/段是否像 OCR 切在半截：
    - 拉丁名半截结尾 OLEAEUROP / O- / ALPIN-
    - 未闭合括号
    - 以顿号逗号结尾
    """
    t = (s or "").strip()
    if not t:
        return False
    if re.search(r"[（(][^）)]*$", t):
        return True
    if re.search(r"[、，,;；]\s*$", t):
        return True
    if re.search(r"[A-Za-z]{2,}-?\s*$", t) and re.search(r"[\u4e00-\u9fff]", t):
        # 中英混排句以拉丁半截收尾
        return True
    if re.search(r"(?:OLEA|LEONT|MICHEL|LIMN|CALEND|EURO|ALPIN|OFFIC)\w{0,6}$", t, re.I):
        return True
    return False


def _is_truncation_same(a: str, b: str) -> bool:
    """
    截断同源：一侧几乎是另一侧的前缀截断（OCR 切句）。
    注意：中间错一字（如 Dr.DHJ vs Dr.DHL）不算截断，必须进字差。
    """
    na, nb = normalize(a or ""), normalize(b or "")
    if not na or not nb:
        return False
    if na == nb:
        return True
    short, long_ = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(short) < 10:
        return False
    rlen = len(short) / max(len(long_), 1)
    # 过短相对过长 → 可能是软覆盖片段，不是「同一句截断」
    if rlen < 0.88:
        return False
    if long_.startswith(short):
        return True
    head = long_[: len(short)]
    # 必须几乎逐字相同（≥98），差 1 个中间字会掉到 <98 → 字差
    if float(fuzz.ratio(short, head)) >= 98:
        return True
    # 仅允许去尾 1～2 字（OCR 行末截断），且主体 ≥98
    for k in (1, 2):
        if len(short) - k < 10:
            continue
        if long_.startswith(short[:-k]) and float(fuzz.ratio(short[:-k], long_[: len(short) - k])) >= 98:
            return True
    return False


def _is_mutual_ocr_cut_same(a: str, b: str) -> bool:
    """
    双向 OCR 截断同源（行业常见）：
    A: …花/叶提取物、油橄榄(OLEAEUROP
    B: 高山…花/叶提取物、油橄榄(O-
    两侧都在半截切断，共享主体高度重合 → 不报字差。

    与「中间错一字」区分：共享核 ratio≥96，且至少一侧像截断尾。
    """
    ha, hb = _hard_chars(a), _hard_chars(b)
    if not ha or not hb or len(ha) < 16 or len(hb) < 16:
        return False
    # 至少一侧像行末截断，或两侧都较短于典型完整句
    if not (
        _looks_ocr_truncated_tail(a)
        or _looks_ocr_truncated_tail(b)
        or (len(ha) < 80 and len(hb) < 80 and (ha[-1:].isalpha() or hb[-1:].isalpha()))
    ):
        return False

    # 去掉未完成的拉丁尾巴再比
    def _strip_latin_tail(s: str) -> str:
        s2 = re.sub(r"[A-Za-z]{2,20}-?$", "", s)
        s2 = re.sub(r"[（(][A-Za-z0-9\s\-]{0,24}$", "", s2)
        return s2

    ha2, hb2 = _strip_latin_tail(ha), _strip_latin_tail(hb)
    if len(ha2) < 14 or len(hb2) < 14:
        ha2, hb2 = ha, hb

    # 短 ⊃ 长的主体：A 缺前缀「高山」但后半一致
    short, long_ = (ha2, hb2) if len(ha2) <= len(hb2) else (hb2, ha2)
    if short in long_ and len(short) / len(long_) >= 0.72:
        # 前缀差仅中文 1～4 字（如 高山）且其余相同 → OCR 切行/漏识前缀，不报真字差
        pref = long_[: long_.find(short)] if short in long_ else ""
        if len(pref) <= 4 and (not pref or re.fullmatch(r"[\u4e00-\u9fff]{0,4}", pref)):
            return True

    # 从最长公共子串比例：对 INCI 长串用 partial
    pr = float(fuzz.partial_ratio(ha2[:120], hb2[:120]))
    rr = float(fuzz.ratio(ha2[:100], hb2[:100]))
    rlen = min(len(ha2), len(hb2)) / max(len(ha2), len(hb2), 1)
    if pr >= 94 and rlen >= 0.65 and rr >= 82:
        return True
    if rr >= 92 and rlen >= 0.75:
        return True
    return False


def _is_strict_content_same(a: str, b: str) -> bool:
    """
    多/少/错字产品口径：只有真正同文（或仅标点/全半角/规格白名单）才算「一致」。
    禁止用模糊 score≥92 放行。OCR 双向截断单独放行。
    """
    if _ws_content_equal(a, b):
        return True
    na, nb = normalize(a or ""), normalize(b or "")
    if not na or not nb:
        return False

    if _hard_chars(a) == _hard_chars(b):
        return True
    # 仅净含量/条码等规格 token 不同，且去规格后完全一致
    sa, sb = _strip_spec_tokens(a), _strip_spec_tokens(b)
    if sa and sa == sb and only_spec_differs(a, b):
        return True
    # 截断同源
    if _is_truncation_same(a, b):
        return True
    # 双向行末截断（成分拉丁名最常见）
    if _is_mutual_ocr_cut_same(a, b):
        return True
    return False


def _length_ratio(a: str, b: str) -> float:
    na, nb = normalize(a or ""), normalize(b or "")
    if not na or not nb:
        return 0.0
    return min(len(na), len(nb)) / max(len(na), len(nb), 1)


def _tail_is_ocr_noise_only(short: str, long_: str) -> bool:
    """
    长串去掉短串前缀后的尾巴，是否仅为 OCR 噪声：
    - 纯拉丁半截 / 标点 / ≤1 个中文
    若尾巴含 ≥2 个中文（如「绒花精」）→ 真字差，不能当截断一致。
    """
    if not short or not long_ or not long_.startswith(short):
        return False
    tail = long_[len(short) :]
    if not tail:
        return True
    # 纯拉丁/数字/括号
    if re.fullmatch(r"[A-Za-z0-9\s\-\(\)/\.\,:：]{1,24}", tail):
        return True
    cn = len(re.findall(r"[\u4e00-\u9fff]", tail))
    if cn >= 2:
        return False  # 「绒花精」等必须报字差
    # 1 个中文 + 短尾巴可视为噪声
    return len(tail) <= 3


def _is_prefix_truncation(a: str, b: str) -> bool:
    """
    半句 vs 整句：短串是长串真前缀，且缺失尾巴仅为 OCR 噪声（拉丁半截/标点）。
    禁止：雪绒花精 vs 雪（缺「绒花精」）标一致。
    """
    na, nb = normalize(a or ""), normalize(b or "")
    if not na or not nb:
        return False
    short, long_ = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(short) < 12:
        return False
    rlen = len(short) / max(len(long_), 1)
    if rlen < 0.50:  # 过短不算「同一句截断」
        return False
    if long_.startswith(short) and _tail_is_ocr_noise_only(short, long_):
        return True
    hs, hl = _hard_chars(a), _hard_chars(b)
    if not hs or not hl:
        return False
    s2, l2 = (hs, hl) if len(hs) <= len(hl) else (hl, hs)
    if len(s2) < 12:
        return False
    if l2.startswith(s2) and _tail_is_ocr_noise_only(s2, l2):
        return True
    return False


def can_mark_aligned(a: str, b: str) -> tuple[bool, str]:
    """
    唯一「可标一致」入口。
    - 真正同文 / 仅标点
    - OCR 拉丁行末截断（双向）
    - 前缀截断且尾巴无实质中文
    - 有 ≥2 中文差 → 一律不一致
    """
    if not (a or "").strip() or not (b or "").strip():
        return False, "empty"
    # 硬同文（含仅标点）
    if _ws_content_equal(a, b) or _hard_chars(a) == _hard_chars(b):
        return True, "strict"
    sa, sb = _strip_spec_tokens(a), _strip_spec_tokens(b)
    if sa and sa == sb and only_spec_differs(a, b):
        return True, "strict"
    # 先看 LCS：有实质中文差直接否
    diff = char_lcs_diff_spans(a, b)
    ma = [
        x
        for x in (diff.get("only_a") or [])
        if (x or "").strip()
        and re.search(r"[\u4e00-\u9fff0-9A-Za-z]", x or "")
        and not re.fullmatch(
            r"[\s\.\-·•，,。；;：:、\"'“”‘’（）()【】\[\]|/\\]+", (x or "").strip()
        )
    ]
    mb = [
        x
        for x in (diff.get("only_b") or [])
        if (x or "").strip()
        and re.search(r"[\u4e00-\u9fff0-9A-Za-z]", x or "")
        and not re.fullmatch(
            r"[\s\.\-·•，,。；;：:、\"'“”‘’（）()【】\[\]|/\\]+", (x or "").strip()
        )
    ]
    cn_diff = sum(len(re.findall(r"[\u4e00-\u9fff]", x)) for x in ma + mb)
    if cn_diff >= 2:
        # 例外：仅双向拉丁截断且中文核相同
        if _is_mutual_ocr_cut_same(a, b) and cn_diff <= 4:
            # 再确认中文核
            ha, hb = _hard_chars(a), _hard_chars(b)
            ha_cn = "".join(re.findall(r"[\u4e00-\u9fff]+", ha))
            hb_cn = "".join(re.findall(r"[\u4e00-\u9fff]+", hb))
            if ha_cn and hb_cn and (
                ha_cn in hb_cn or hb_cn in ha_cn or float(fuzz.ratio(ha_cn, hb_cn)) >= 94
            ):
                return True, "mutual_cut"
        return False, "has_lcs"
    if not ma and not mb:
        rlen = _length_ratio(a, b)
        if rlen >= 0.85:
            return True, "no_lcs"
        if _is_prefix_truncation(a, b):
            return True, "prefix_trunc"
        if _is_mutual_ocr_cut_same(a, b):
            return True, "mutual_cut"
        return False, "len_imbalance"
    # 仅拉丁/数字尾巴差
    if _is_mutual_ocr_cut_same(a, b):
        return True, "mutual_cut"
    if _is_prefix_truncation(a, b):
        return True, "prefix_trunc"
    if _is_strict_content_same(a, b):
        return True, "strict"
    return False, "has_lcs"


def dedupe_compare_hits(hits: list[dict]) -> list[dict]:
    """
    去重：同区/跨区重复的同一对文案只留一条（优先保留字差 > 未对上 > 一致）。
    """
    head = [h for h in hits if h.get("category") in ("overview", "stats")]
    content = [h for h in hits if h.get("category") not in ("overview", "stats")]
    rank = {"issue": 0, "unmatched": 1, "aligned": 2}

    def _pair_key(h: dict) -> str:
        raw = h.get("excel_value") or ""
        b = (h.get("text_b") or "").strip()
        a = ""
        if "\nB:" in raw or raw.startswith("A:"):
            parts = raw.split("\nB:", 1)
            a = re.sub(r"^A:\s*", "", parts[0]).strip()
            if not b and len(parts) > 1:
                b = parts[1].strip()
        else:
            a = raw.strip() if h.get("side") != "b" else ""
            if h.get("side") == "b":
                b = raw.strip()
        # 用中文核 + 归一化，避免 * 空格差异重复
        def core(s: str) -> str:
            t = _hard_chars(s)
            cn = "".join(re.findall(r"[\u4e00-\u9fff]{2,}", t))
            return cn[:40] or t[:40]

        return f"{core(a)}||{core(b)}||{core(a or b)}"

    best: dict[str, dict] = {}
    order: list[str] = []
    for h in content:
        k = _pair_key(h)
        if not k or k == "||||":
            k = h.get("id") or str(id(h))
        if k not in best:
            best[k] = h
            order.append(k)
            continue
        old = best[k]
        ro, rn = rank.get(old.get("category") or "", 9), rank.get(
            h.get("category") or "", 9
        )
        if rn < ro:
            best[k] = h
        elif rn == ro and (h.get("score") or 0) >= (old.get("score") or 0):
            # 同级保留更完整文本
            if len(h.get("excel_value") or "") > len(old.get("excel_value") or ""):
                best[k] = h
    content2 = [best[k] for k in order if k in best]
    for seq, h in enumerate(content2, 1):
        h["seq"] = seq
        fl = re.sub(r"^#\d+\s*·\s*", "", h.get("field") or "")
        h["field"] = f"#{seq} · {fl}"
    return head + content2


# 跨区粘连：地址/生产 + 成分拉丁碎片 / 脚注混进同一单元
_CROSS_ZONE_GLUE = re.compile(
    r"(?:"
    r"(?:地址|浙江省|杭州市|钱塘|河庄|街道|工业园区).{0,40}(?:INALIS|OFFICINALIS|LEONTOPOD|MICHELIA|ALPINUM|EUROPAEA|花油|提取物)"
    r"|(?:INALIS|OFFICINALIS|ALPINUM|花油|提取物).{0,40}(?:地址|浙江省|杭州市|河庄|街道|办公楼)"
    r"|(?:生产企业|备案人).{0,30}(?:路\d+|办公楼|室).{0,20}(?:生产企业|备案人)"
    r"|(?:花卉图|销售包装).{0,20}(?:路\d+|办公楼|室)"
    r"|(?:扫码关注|微信公众号).{0,12}(?:注意|贮存|使用方法|成分|产品名称|存，并|触及)"
    r"|(?:使用方法|注意|贮存).{0,15}(?:扫码|微信)"
    r"|(?:雪绒花|精粹).{0,20}(?:停止使用|若不慎|贮存条件|眼睛)"
    r"|(?:注册商标).{0,15}(?:地址|译为地址)"
    r"|(?:备案人|生产企业).{0,40}(?:金盏花|CALENDULA|提取物|花油)"
    r"|(?:金盏花|CALENDULA).{0,30}(?:地址|备案人)"
    r"|(?:含义资源|大豆油墨).{0,20}(?:地址|限公司)"
    r"|(?:叶提取物).{0,15}(?:办公楼|工业园区|路\d+)"
    r"|(?:办公楼|工业园区).{0,15}(?:叶提取物|ALPINUM)"
    r")",
    re.I,
)


def is_cross_zone_glue_unit(text: str) -> bool:
    """跨功能区 OCR 粘连块：不应作为比对单元 / 未对上。"""
    t = (text or "").strip()
    if len(t) < 12:
        return False
    if _CROSS_ZONE_GLUE.search(t):
        return True
    # 同时含「强地址」+「INCI 拉丁」
    has_addr = bool(re.search(r"地址|浙江省|上海市|路\d{2,}|工业园区|办公楼", t))
    has_inci_lat = bool(
        re.search(
            r"[A-Z]{4,}(?:IUM|IS|EA|UM|OL|IN)|LEONTOPOD|MICHELIA|CALENDULA|OLEA\s*EUR",
            t,
            re.I,
        )
    )
    if has_addr and has_inci_lat:
        return True
    # 拉丁半截碎片单独成块（无完整中文句）
    cn = len(re.findall(r"[\u4e00-\u9fff]", t))
    if cn <= 4 and re.search(r"(?:INALIS|ALPIN|EUROPA|OFFIC)\w*", t, re.I):
        return True
    return False


def split_cross_zone_glue(text: str) -> list[str]:
    """
    尽量把粘连块拆回功能句；拆不动则丢弃噪声。
    """
    t = (text or "").strip()
    if not t:
        return []
    if not is_cross_zone_glue_unit(t):
        return [t]
    # 按锚点切断
    parts = re.split(
        r"(?=(?:产品名称|使用方法|贮存条件|注意[：:]|备案人|生产企业|地址[：:]|"
        r"其他微量成分|成分[：:]|扫码关注|\*产品|\*精油|\*一朵))",
        t,
    )
    out = []
    for p in parts:
        p = p.strip()
        if len(normalize(p)) < 10:
            continue
        if is_cross_zone_glue_unit(p):
            # 仍粘：抽可识别的纯段
            for m in re.finditer(
                r"(?:备案人|生产企业|地址)[：:][^\n*。]{6,80}",
                p,
            ):
                out.append(m.group(0).strip())
            for m in re.finditer(
                r"(?:其他微量成分|成分)[：:][^\n]{10,120}",
                p,
            ):
                out.append(m.group(0).strip())
            continue
        out.append(p)
    return out


def sanitize_compare_units(units: list[str]) -> list[str]:
    """比对前：拆跨区粘连、丢掉纯 OCR 噪声碎片。"""
    out: list[str] = []
    seen: set[str] = set()
    for u in units:
        chunks = split_cross_zone_glue(u) if is_cross_zone_glue_unit(u) else [u]
        for c in chunks:
            c = (c or "").strip()
            if not c or is_noise_line(c):
                continue
            if is_cross_zone_glue_unit(c):
                continue  # 拆不干净的扔掉，避免假未对上
            # 纯拉丁半截
            if len(re.findall(r"[\u4e00-\u9fff]", c)) < 3 and re.search(
                r"^[A-Za-z0-9\s\-\(\)/]{4,40}$", c
            ):
                continue
            k = normalize(c)
            if len(k) < 8 or k in seen:
                continue
            seen.add(k)
            out.append(c)
    return out


def _typo_labels(ma: list[str], mb: list[str], *, label_a: str, label_b: str) -> str:
    """人话：多字/少字/错字（相对两侧）。"""
    bits = []
    if ma and mb:
        bits.append(f"错字/改写 · {label_a}「{'、'.join(ma[:4])}」↔ {label_b}「{'、'.join(mb[:4])}」")
    elif ma and not mb:
        bits.append(f"少字（{label_b}缺）/ {label_a}多出「{'、'.join(ma[:5])}」")
    elif mb and not ma:
        bits.append(f"多字（{label_b}多）/ {label_a}缺「{'、'.join(mb[:5])}」")
    return " · ".join(bits) if bits else "字符差异"


def filter_false_aligned_hits(hits: list[dict], *, label_a: str = "面1", label_b: str = "面2") -> list[dict]:
    """
    任务级终检：把假「一致」打回字差/丢弃（ensemble 之后也可再跑）。
    """
    out: list[dict] = []
    for h in hits:
        if h.get("category") != "aligned":
            out.append(h)
            continue
        raw = h.get("excel_value") or ""
        pb = (h.get("text_b") or "").strip()
        pa = ""
        if "\nB:" in raw or raw.startswith("A:"):
            parts = raw.split("\nB:", 1)
            pa = re.sub(r"^A:\s*", "", parts[0]).strip()
            if not pb and len(parts) > 1:
                pb = parts[1].strip()
        else:
            pa = raw.strip()
        if not pa or not pb:
            continue
        ok_aln, _why = can_mark_aligned(pa, pb)
        if ok_aln:
            out.append(h)
            continue
        diff = char_lcs_diff_spans(pa, pb)

        def _mf(frags: list) -> list[str]:
            r = []
            for x in frags or []:
                x = (x or "").strip()
                if not x:
                    continue
                if re.fullmatch(r"[\s\.\-·•，,。；;：:、\"'“”‘’（）()【】\[\]|/\\]+", x):
                    continue
                if re.search(r"[\u4e00-\u9fff0-9A-Za-z]", x):
                    r.append(x)
            return r

        ma, mb = _mf(diff.get("only_a") or []), _mf(diff.get("only_b") or [])
        if ma or mb:
            h2 = dict(h)
            typo = _typo_labels(ma, mb, label_a=label_a, label_b=label_b)
            h2["category"] = "issue"
            h2["status"] = "疑点"
            fl = re.sub(r"^#\d+\s*·\s*", "", h2.get("field") or "")
            if "[成分" in fl or "区]" in fl:
                h2["field"] = fl  # 保留区前缀
            h2["field"] = re.sub(
                r"(已对齐|一致).*", "多/少/错字 · 需审核", h2.get("field") or "多/少/错字 · 需审核"
            )
            if "多/少/错字" not in (h2.get("field") or ""):
                h2["field"] = (h2.get("field") or "") + " · 多/少/错字 · 需审核"
            h2["evidence"] = f"【需审核·字差·终检】{typo}"
            h2["sequence_diff"] = {
                "only_in_excel": ma[:8],
                "only_in_pack": mb[:8],
                "typo_hint": typo,
            }
            h2["doubt_bucket"] = "typo"
            out.append(h2)
        # 否则丢弃假一致
    # 重编号 content
    content = [h for h in out if h.get("category") in ("aligned", "issue", "unmatched")]
    head = [h for h in out if h.get("category") not in ("aligned", "issue", "unmatched")]
    for seq, h in enumerate(content, 1):
        h["seq"] = seq
        fl = re.sub(r"^#\d+\s*·\s*", "", h.get("field") or "")
        h["field"] = f"#{seq} · {fl}"
    n_ok = sum(1 for h in content if h.get("category") == "aligned")
    n_diff = sum(1 for h in content if h.get("category") == "issue")
    n_miss = sum(1 for h in content if h.get("category") == "unmatched")
    for h in head:
        if h.get("category") == "overview":
            h["evidence"] = (
                (h.get("evidence") or "")
                + f" · 终检后 一致{n_ok}/字差{n_diff}/未对上{n_miss}"
            )
            h["status"] = "疑点" if (n_diff or n_miss) else "一致"
            h["score"] = 100.0 - min(n_diff * 6 + n_miss * 8, 55)
        if h.get("category") == "stats":
            h["excel_value"] = (
                f"一致={n_ok} · 字差={n_diff} · 未对上={n_miss} · 终检门"
            )
            h["status"] = "疑点" if (n_diff or n_miss) else "一致"
    return head + content


def detect_net_content_label(text: str) -> str | None:
    """从 OCR 全文抽净含量，用于列名区分两面（如 75g / 25g）。"""
    if not text:
        return None
    m = re.search(
        r"净含量\s*[：:]\s*([0-9]+(?:\.[0-9]+)?\s*(?:ml|mL|ML|g|G|克|毫升))",
        text,
        re.I,
    )
    if m:
        return re.sub(r"\s+", "", m.group(1))
    # 兜底：正文里单独出现的规格（取众数）
    cands = re.findall(r"(?<![A-Za-z0-9])([0-9]+(?:\.[0-9]+)?\s*(?:ml|mL|g|G|克))(?![A-Za-z0-9])", text[:3000], re.I)
    if not cands:
        return None
    normed = [re.sub(r"\s+", "", c) for c in cands]
    # 众数
    from collections import Counter

    best, n = Counter(normed).most_common(1)[0]
    if n >= 1 and re.search(r"\d", best):
        return best
    return None


def _best_snippet_in_text(phrase: str, other_text: str) -> tuple[str, float]:
    """
    在对侧全文中找与 phrase 最像的片段，用于软覆盖展示（禁止空占位）。
    返回 (snippet, score)。
    """
    phrase = (phrase or "").strip()
    other = other_text or ""
    if not phrase or not other:
        return "", 0.0
    n = normalize(phrase)
    # 1) 整段包含
    if phrase in other:
        return phrase, 100.0
    # 2) 对侧按行/句扫
    candidates: list[str] = []
    for ln in re.split(r"[\n\r]+", other):
        ln = ln.strip()
        if len(normalize(ln)) >= 6:
            candidates.append(ln)
        if len(ln) > 40:
            for p in re.split(r"[。；;，,]", ln):
                p = p.strip()
                if len(normalize(p)) >= 6:
                    candidates.append(p)
    # 3) 滑窗（按中文块）
    cn_chunks = re.findall(r"[\u4e00-\u9fffA-Za-z0-9（）()/%\.\-]{8,80}", other)
    candidates.extend(cn_chunks[:80])

    best_s, best_sc = "", 0.0
    for c in candidates:
        nc = normalize(c)
        if not nc:
            continue
        if _is_truncation_same(phrase, c):
            sc = 96.0
        else:
            # 以 ratio 为主，partial 降权，避免「花卉」贴到含花卉的地址串
            sc = float(fuzz.ratio(n, nc))
            pr = float(fuzz.partial_ratio(n[:48], nc[:64]))
            if pr > sc + 15 and min(len(n), len(nc)) / max(len(n), len(nc), 1) >= 0.55:
                sc = max(sc, pr * 0.88)
        rlen = min(len(n), len(nc)) / max(len(n), len(nc), 1)
        if rlen < 0.4:
            sc *= 0.55
        # 核心中文重叠不够 → 降权
        cores_p = set(re.findall(r"[\u4e00-\u9fff]{2,6}", phrase))
        cores_c = set(re.findall(r"[\u4e00-\u9fff]{2,6}", c))
        if cores_p and len(cores_p & cores_c) < max(1, len(cores_p) // 3):
            sc *= 0.6
        if sc > best_sc:
            best_sc, best_s = sc, c
    if len(best_s) > 160:
        best_s = best_s[:160] + "…"
    return best_s, best_sc


def _is_high_value_unit(p: str) -> bool:
    """高价值：品名/用法/生产/脚注等；INCI 碎片降权。"""
    if is_noise_line(p) or is_whitelist_line(p):
        return False
    if any(k in p for k in ANCHOR_KW):
        return True
    if re.search(
        r"产品名称|备案人|生产企业|许可证|执行标准|使用方法|贮存|注意|扫码|公众号|"
        r"雪绒花|金盏|精研配方|馥郁|清雅|Dr\.?\s*DH|净含量",
        p,
        re.I,
    ):
        return True
    # 纯成分长串也算高价值
    if re.search(r"成分[：:]", p) and len(normalize(p)) >= 16:
        return True
    return False


def _is_inci_fragment(p: str) -> bool:
    """成分断行碎片：拉丁/化学断词，不当强未对上。"""
    n = normalize(p)
    if len(n) < 8:
        return True
    cn = len(re.findall(r"[\u4e00-\u9fff]", p))
    lat = len(re.findall(r"[A-Za-z]", p))
    if lat >= 8 and cn <= 4:
        return True
    if re.search(
        r"LIM|NANTH|ALPIN|OFFIC|EAEUROP|EDTA|甘油三酯|聚醚|羟基苯|己二醇",
        p,
        re.I,
    ) and cn < 10:
        return True
    return False


def _soft_cover_score(phrase: str, other_text: str) -> float:
    """
    软覆盖分：必须能找到长度相近的对侧片段，禁止「整页糊块 partial 满分」。
    """
    phrase = (phrase or "").strip()
    if len(normalize(phrase)) > 100:
        return 0.0  # 超长糊块不软过
    snip, sc = _best_snippet_in_text(phrase, other_text)
    if not snip:
        return 0.0
    # 截断同源直接高分
    if _is_truncation_same(phrase, snip):
        return 96.0
    if _fulltext_really_covers(phrase, other_text) and len(normalize(phrase)) <= 80:
        return max(sc, 92.0)
    n, ns = normalize(phrase), normalize(snip)
    rlen = min(len(n), len(ns)) / max(len(n), len(ns), 1)
    if rlen < 0.4:
        return sc * 0.45  # 对侧片段太短/太长，不可信
    if _core_cn_covered(phrase, other_text, min_hit=0.65):
        sc = max(sc, 84.0)
    return sc


def build_layout_blocks(
    text: str,
    words: list[dict] | None = None,
    *,
    side: str = "a",
    max_n: int = 56,
) -> list[dict[str, Any]]:
    """
    行业路径：版面成段后再抽比对块。
    优先百度 paragraph / 几何聚段；否则文本半句粘连。
    块字段：{text,left,top,width,height,column,order,source}
    阅读序：栏从左→右，栏内上→下。
    """
    from app.layout_cluster import build_semantic_units

    units, cluster_meta = build_semantic_units(
        words, text or "", max_n=max_n, side=side
    )
    blocks: list[dict[str, Any]] = []
    for u in units:
        t = (u.get("text") or "").strip()
        if not t:
            continue
        # 无坐标时用全文位置兜底
        if not u.get("left") and not u.get("top") and words is not None:
            key = _read_order_key(t, text, words, side=side)
            left, top = float(key[2]), float(key[1])
        else:
            left = float(u.get("left") or 0)
            top = float(u.get("top") or 0)
        blocks.append(
            {
                "text": t,
                "side": side,
                "left": left,
                "top": top,
                "width": float(u.get("width") or 0),
                "height": float(u.get("height") or 0),
                "column": int(u.get("column") or 0),
                "source": u.get("source") or cluster_meta.get("source"),
                "high_value": _is_high_value_unit(t),
                "inci_frag": _is_inci_fragment(t),
                "line_count": u.get("line_count"),
            }
        )
    blocks.sort(key=lambda b: (int(b["column"]), float(b["top"]), float(b["left"])))
    for i, b in enumerate(blocks):
        b["order"] = i
    # 挂 meta 供 overview 使用（调用方可读 blocks[0] 外的返回）
    if blocks:
        blocks[0]["_cluster_meta"] = cluster_meta
    elif cluster_meta:
        # 空块也带 meta 用占位
        pass
    return blocks


def blocks_to_markdown(blocks_a: list[dict], blocks_b: list[dict], *, label_a: str, label_b: str) -> str:
    """P2：给人看的 MD（比对仍用 blocks）。"""
    lines = [
        f"# 文字对照 · {label_a} ↔ {label_b}",
        "",
        f"## {label_a}",
        "",
    ]
    cur_col = None
    for b in blocks_a:
        if b.get("column") != cur_col:
            cur_col = b.get("column")
            lines.append(f"### 栏 {int(cur_col) + 1}")
            lines.append("")
        lines.append(f"- {b.get('text') or ''}")
    lines += ["", f"## {label_b}", ""]
    cur_col = None
    for b in blocks_b:
        if b.get("column") != cur_col:
            cur_col = b.get("column")
            lines.append(f"### 栏 {int(cur_col) + 1}")
            lines.append("")
        lines.append(f"- {b.get('text') or ''}")
    return "\n".join(lines)


def compare_pdf_internal_1to1(
    text_a: str,
    text_b: str,
    *,
    words_a: list[dict] | None = None,
    words_b: list[dict] | None = None,
    label_a: str = "页1",
    label_b: str = "页2",
) -> list[dict]:
    """
    PDF 内双页 · 严格一一对应（P0–P2 升级）。

    - 邻行合并后再抽单元
    - 一致 / 字差(疑点) / 未对上(疑点，软覆盖后)
    - 阅读序：栏左→右，栏内上→下
    - INCI 碎片降权；高价值锚点强检
    """
    # 行业：版面成段（百度 paragraph / 几何）→ 比对单元；文本粘连兜底
    blocks_a = build_layout_blocks(text_a, words_a, side="a", max_n=48)
    blocks_b = build_layout_blocks(text_b, words_b, side="b", max_n=48)
    cluster_meta_a: dict = {}
    cluster_meta_b: dict = {}
    if blocks_a and isinstance(blocks_a[0], dict) and "_cluster_meta" in blocks_a[0]:
        cluster_meta_a = blocks_a[0].pop("_cluster_meta", {}) or {}
    if blocks_b and isinstance(blocks_b[0], dict) and "_cluster_meta" in blocks_b[0]:
        cluster_meta_b = blocks_b[0].pop("_cluster_meta", {}) or {}
    raw_a = [b["text"] for b in blocks_a if (b.get("text") or "").strip()]
    raw_b = [b["text"] for b in blocks_b if (b.get("text") or "").strip()]
    # 行业：比对前去跨区粘连（地址×成分拉丁、生产×路牌糊一块）
    units_a = sanitize_compare_units(raw_a)
    units_b = sanitize_compare_units(raw_b)
    dropped_glue = (len(raw_a) + len(raw_b)) - (len(units_a) + len(units_b))
    # 软覆盖用「段拼接全文」——跨行已在段内消掉；全文仍保留便于邻段命中
    from app.layout_cluster import units_to_compare_text

    text_a_m = units_to_compare_text(blocks_a) or merge_ocr_lines_for_align(text_a)
    text_b_m = units_to_compare_text(blocks_b) or merge_ocr_lines_for_align(text_b)
    # 全文也清掉明显跨区粘连句，减少假未对上检索噪声
    text_a = "\n".join(
        sanitize_compare_units([ln for ln in re.split(r"[\n\r]+", text_a_m) if ln.strip()])
    ) or text_a_m
    text_b = "\n".join(
        sanitize_compare_units([ln for ln in re.split(r"[\n\r]+", text_b_m) if ln.strip()])
    ) or text_b_m
    sim_raw = float(fuzz.token_set_ratio(normalize(text_a), normalize(text_b)))
    sim_norm = float(
        fuzz.token_set_ratio(_strip_spec_tokens(text_a), _strip_spec_tokens(text_b))
    )

    # 候选边 (score, ia, ib) — 门槛提高，宁缺毋滥
    edges: list[tuple[float, int, int]] = []
    for ia, pa in enumerate(units_a):
        for ib, pb in enumerate(units_b):
            sc = _strict_pair_score(pa, pb)
            if sc >= 82.0:
                edges.append((sc, ia, ib))
    edges.sort(key=lambda x: -x[0])

    used_a: set[int] = set()
    used_b: set[int] = set()
    # (ia, pa, pb, score) — 保留页1 单元下标，便于按阅读序输出
    pairs: list[tuple[int, str, str, float]] = []
    for sc, ia, ib in edges:
        if ia in used_a or ib in used_b:
            continue
        used_a.add(ia)
        used_b.add(ib)
        pairs.append((ia, units_a[ia], units_b[ib], sc))
    # 输出按页1 阅读序（units_a 已是文档序）
    pairs.sort(key=lambda x: x[0])

    only_a = [units_a[i] for i in range(len(units_a)) if i not in used_a]
    only_b = [units_b[i] for i in range(len(units_b)) if i not in used_b]

    content_hits: list[dict] = []
    n_ok = 0
    n_diff = 0
    n_miss = 0

    def _meaningful_frags(frags: list[str]) -> list[str]:
        """
        多/少/错字可见差：中文一律保留；英文保留（含单字母，如 J/L 商标差）。
        仅过滤纯标点/空白。
        """
        out = []
        for x in frags or []:
            x = (x or "").strip()
            if not x:
                continue
            # 纯标点
            if re.fullmatch(r"[\s\.\-·•，,。；;：:、\"'“”‘’（）()【】\[\]|/\\]+", x):
                continue
            if re.search(r"[\u4e00-\u9fff0-9A-Za-z]", x):
                # INCI 超长碎片噪声仍可降权，但单字英文/数字必须保留（错字核心）
                out.append(x)
        return out

    def _block_meta(phrase: str, *, side: str = "a") -> dict:
        bl = blocks_a if side == "a" else blocks_b
        n = normalize(phrase)
        for b in bl:
            if normalize(b.get("text") or "") == n:
                return b
        # 子串兜底
        for b in bl:
            bn = normalize(b.get("text") or "")
            if n and bn and (n in bn or bn in n):
                return b
        return {}

    def _stamp(h: dict, phrase: str, *, side: str = "a") -> dict:
        """写入阅读序：栏左→右，栏内上→下。"""
        bm = _block_meta(phrase, side=side)
        if bm:
            col = int(bm.get("column") or 0)
            top = float(bm.get("top") or 0)
            left = float(bm.get("left") or 0)
            h["read_order"] = {
                "page": 1,
                "column": col,
                "top": top,
                "left": left,
                "side": side,
            }
            # 排序键：column 优先（左栏先），再 top，再 left
            h["read_order_key"] = [
                col,
                top,
                left,
                0 if side == "a" else 1,
            ]
        else:
            key = _read_order_key(
                phrase,
                text_a if side == "a" else text_b,
                words_a if side == "a" else words_b,
                side=side,
            )
            h["read_order"] = {
                "page": key[0],
                "column": 0,
                "top": key[1],
                "left": key[2],
                "side": side,
            }
            h["read_order_key"] = [0, key[1], key[2], 0 if side == "a" else 1]
        return h

    for i, (ia, pa, pb, sc) in enumerate(pairs):
        # —— 多/少/错字：唯一入口 can_mark_aligned；禁止半句对整段假一致 ——
        real_r = float(fuzz.ratio(normalize(pa), normalize(pb)))
        na, nb = normalize(pa), normalize(pb)
        rlen = min(len(na), len(nb)) / max(len(na), len(nb), 1)
        # 配对过松 → 退回未对上池
        if real_r < 80 or (rlen < 0.55 and real_r < 92):
            only_a.append(pa)
            only_b.append(pb)
            continue

        ok_aln, why = can_mark_aligned(pa, pb)
        if ok_aln:
            n_ok += 1
            reason_map = {
                "strict": "严格同文",
                "no_lcs": "无实质字差",
                "prefix_trunc": "OCR前缀/行末截断",
                "mutual_cut": "OCR双向截断同源",
            }
            content_hits.append(
                _stamp(
                    _hit(
                        f"ok_{i}",
                        "已对齐",
                        f"A: {pa[:160]}\nB: {pb[:160]}",
                        "一致",
                        f"{reason_map.get(why, why)} · score={sc:.0f}·ratio={real_r:.0f}·rlen={rlen:.2f}",
                        sc,
                        category="aligned",
                        text_b=pb,
                    ),
                    pa,
                    side="a",
                )
            )
            continue

        # 长度严重失衡且非前缀 → 不硬配，回未对上池让全文再找
        if why == "len_imbalance":
            only_a.append(pa)
            only_b.append(pb)
            continue

        diff = char_lcs_diff_spans(pa, pb)
        ma = _meaningful_frags(diff.get("only_a") or [])
        mb = _meaningful_frags(diff.get("only_b") or [])
        if not ma and not mb:
            n_ok += 1
            content_hits.append(
                _stamp(
                    _hit(
                        f"ok_soft_{i}",
                        "已对齐",
                        f"A: {pa[:160]}\nB: {pb[:160]}",
                        "一致",
                        f"无实质字差 · score={sc:.0f}",
                        sc,
                        category="aligned",
                        text_b=pb,
                    ),
                    pa,
                    side="a",
                )
            )
            continue

        # 有实质差 → 字差
        n_diff += 1
        typo = _typo_labels(ma, mb, label_a=label_a, label_b=label_b)
        ba = boxes_for_char_fragments(ma or [pa[:12]], words_a or []) if words_a else []
        bb = boxes_for_char_fragments(mb or [pb[:12]], words_b or []) if words_b else []
        content_hits.append(
            _stamp(
                _hit(
                    f"lcs_{i}",
                    "多/少/错字 · 需审核",
                    f"A: {pa[:160]}\nB: {pb[:160]}",
                    "疑点",
                    f"【需审核·字差】{typo} · 相似度 {real_r:.0f}%",
                    real_r,
                    category="issue",
                    bboxes=ba,
                    bboxes_b=bb,
                    text_b=pb,
                    sequence_diff={
                        "only_in_excel": ma[:8],
                        "only_in_pack": mb[:8],
                        "ratio": diff.get("ratio"),
                        "typo_hint": typo,
                    },
                    doubt_bucket="typo",
                ),
                pa,
                side="a",
            )
        )

    # 未对上：软覆盖 → 一致；INCI 碎片降级；高价值才强报疑点
    def _is_review_unit(p: str) -> bool:
        if is_noise_line(p) or is_whitelist_line(p):
            return False
        if len(normalize(p)) < 12:
            return False
        if _is_inci_fragment(p) and not _is_high_value_unit(p):
            return False  # 碎片不进未对上列表
        if _is_high_value_unit(p):
            return True
        if re.search(r"[\u4e00-\u9fff]{8,}", p):
            return True
        return len(normalize(p)) >= 20

    pending_miss: list[dict] = []  # 先收集再语义去重

    def _resolve_orphan(phrase: str, other_text: str, other_units: list[str], *, side: str, j: int):
        """
        未配对单元：在对侧全文/单元找对应。
        - 真包含或严格同文 → 一致
        - 能配上但有 LCS 字差 → 字差（解决「下一行其实对上了」）
        - 否则 → 未对上
        返回 hit dict 或 None（跳过噪声）。
        """
        snip, soft = _best_snippet_in_text(phrase, other_text)
        hard = float(fuzz.ratio(normalize(phrase), normalize(snip))) if snip else 0.0
        # 全文真包含（跨行粘连后）
        contained = _fulltext_really_covers(phrase, other_text) or (
            len(normalize(phrase)) >= 12 and normalize(phrase) in normalize(other_text)
        )
        best_u, best_s = "", -1.0
        for u in other_units:
            s = _strict_pair_score(phrase, u)
            if s > best_s:
                best_s, best_u = s, u
        partner = ""
        if contained and snip:
            partner = snip
        elif best_s >= 88.0 and best_u:
            partner = best_u
        elif hard >= 90.0 and snip and min(len(normalize(phrase)), len(normalize(snip))) / max(
            len(normalize(phrase)), len(normalize(snip)), 1
        ) >= 0.8:
            partner = snip
        elif _is_strict_content_same(phrase, snip or "") or _is_strict_content_same(
            phrase, best_u or ""
        ):
            partner = snip if _is_strict_content_same(phrase, snip or "") else best_u

        if partner:
            # 半句对整段：仅前缀截断可一致，否则字差或继续找
            ok_aln, why = can_mark_aligned(phrase, partner)
            if ok_aln:
                return "ok", partner, soft or best_s, [], []
            diff = char_lcs_diff_spans(phrase, partner)
            ma = _meaningful_frags(diff.get("only_a") or [])
            mb = _meaningful_frags(diff.get("only_b") or [])
            if not ma and not mb and _length_ratio(phrase, partner) >= 0.85:
                return "ok", partner, hard or best_s, [], []
            # 有 partner 但非一一对应 → 字差（禁止假一致）
            if ma or mb or why in ("has_lcs", "len_imbalance"):
                if not ma and not mb and why == "len_imbalance":
                    # 长度失衡且非前缀：不报一致，也不用糊字差，当 miss 让粘连过滤
                    if is_cross_zone_glue_unit(phrase) or is_cross_zone_glue_unit(partner):
                        return "miss", "", 0.0, [], []
                    # 短串在长串中 → 截断一致
                    if _is_prefix_truncation(phrase, partner):
                        return "ok", partner, hard or best_s, [], []
                    return "miss", "", 0.0, [], []
                return "diff", partner, hard or best_s, ma, mb
            return "miss", "", 0.0, [], []
        return "miss", "", 0.0, [], []

    for j, pa in enumerate(only_a):
        if not _is_review_unit(pa):
            continue
        if len(normalize(pa)) > 100:
            continue
        # 跨区粘连 / 拉丁半截：不报未对上（OCR 噪声）
        if is_cross_zone_glue_unit(pa) or (
            _looks_ocr_truncated_tail(pa)
            and len(re.findall(r"[\u4e00-\u9fff]", pa)) < 6
        ):
            continue
        kind, partner, sc0, ma, mb = _resolve_orphan(
            pa, text_b, units_b, side="a", j=j
        )
        # 对上了但是双向截断 → 一致
        if kind == "diff" and partner and _is_mutual_ocr_cut_same(pa, partner):
            kind = "ok"
            ma, mb = [], []
        if kind == "ok":
            n_ok += 1
            content_hits.append(
                _stamp(
                    _hit(
                        f"ok_soft_a_{j}",
                        "已对齐",
                        f"A: {pa[:160]}\nB: {(partner or '')[:160]}",
                        "一致",
                        f"对侧全文/邻段覆盖 · score={sc0:.0f}（跨行已对齐）",
                        float(sc0 or 0),
                        category="aligned",
                        text_b=partner,
                    ),
                    pa,
                    side="a",
                )
            )
            continue
        if kind == "diff":
            n_diff += 1
            typo = _typo_labels(ma, mb, label_a=label_a, label_b=label_b)
            content_hits.append(
                _stamp(
                    _hit(
                        f"lcs_orphan_a_{j}",
                        "多/少/错字 · 需审核",
                        f"A: {pa[:160]}\nB: {(partner or '')[:160]}",
                        "疑点",
                        f"【需审核·字差】{typo}（原未配对，对侧邻段已找到）",
                        float(sc0 or 0),
                        category="issue",
                        text_b=partner,
                        sequence_diff={
                            "only_in_excel": ma[:8],
                            "only_in_pack": mb[:8],
                            "typo_hint": typo,
                        },
                        doubt_bucket="typo",
                    ),
                    pa,
                    side="a",
                )
            )
            continue
        ba = locate_phrase_boxes(pa, words_a or []) if words_a else []
        for b in ba:
            b["role"] = "check"
            b["status"] = "warn"
        pending_miss.append(
            _stamp(
                _hit(
                    f"miss_a_{j}",
                    f"未对上 · 仅{label_a}有 · 需审核",
                    pa,
                    "疑点",
                    f"【需审核·未对上】{label_b} 无可靠对应，请核漏印/改写/OCR",
                    0.0,
                    category="unmatched",
                    bboxes=ba,
                    side="a",
                    doubt_bucket="coverage",
                ),
                pa,
                side="a",
            )
        )

    for j, pb in enumerate(only_b):
        if not _is_review_unit(pb):
            continue
        if len(normalize(pb)) > 100:
            continue
        if is_cross_zone_glue_unit(pb) or (
            _looks_ocr_truncated_tail(pb)
            and len(re.findall(r"[\u4e00-\u9fff]", pb)) < 6
        ):
            continue
        kind, partner, sc0, ma, mb = _resolve_orphan(
            pb, text_a, units_a, side="b", j=j
        )
        if kind == "diff" and partner and _is_mutual_ocr_cut_same(pb, partner):
            kind = "ok"
            ma, mb = [], []
        # orphan 时 ma=phrase侧差，mb=partner侧差；B 为 phrase 时要对调展示
        if kind == "ok":
            n_ok += 1
            content_hits.append(
                _stamp(
                    _hit(
                        f"ok_soft_b_{j}",
                        "已对齐",
                        f"A: {(partner or '')[:160]}\nB: {pb[:160]}",
                        "一致",
                        f"对侧全文/邻段覆盖 · score={sc0:.0f}（跨行已对齐）",
                        float(sc0 or 0),
                        category="aligned",
                        text_b=pb,
                    ),
                    pb,
                    side="b",
                )
            )
            continue
        if kind == "diff":
            n_diff += 1
            # phrase=B, partner=A → only_a 实际是 B 的差，only_b 是 A 的差，对调
            typo = _typo_labels(mb, ma, label_a=label_a, label_b=label_b)
            content_hits.append(
                _stamp(
                    _hit(
                        f"lcs_orphan_b_{j}",
                        "多/少/错字 · 需审核",
                        f"A: {(partner or '')[:160]}\nB: {pb[:160]}",
                        "疑点",
                        f"【需审核·字差】{typo}（原未配对，对侧邻段已找到）",
                        float(sc0 or 0),
                        category="issue",
                        text_b=pb,
                        sequence_diff={
                            "only_in_excel": mb[:8],
                            "only_in_pack": ma[:8],
                            "typo_hint": typo,
                        },
                        doubt_bucket="typo",
                    ),
                    pb,
                    side="b",
                )
            )
            continue
        bb = locate_phrase_boxes(pb, words_b or []) if words_b else []
        for b in bb:
            b["role"] = "check"
            b["status"] = "warn"
        pending_miss.append(
            _stamp(
                _hit(
                    f"miss_b_{j}",
                    f"未对上 · 仅{label_b}有 · 需审核",
                    pb,
                    "疑点",
                    f"【需审核·未对上】{label_a} 无可靠对应，请核漏印/改写/OCR",
                    0.0,
                    category="unmatched",
                    bboxes_b=bb,
                    side="b",
                    doubt_bucket="coverage",
                ),
                pb,
                side="b",
            )
        )

    # P0：未对上语义去重（A/B 各报一条同主题 → 留高价值一条）
    def _miss_core(h: dict) -> str:
        t = normalize(h.get("excel_value") or "")
        cores = re.findall(r"[\u4e00-\u9fff]{3,8}", h.get("excel_value") or "")
        return "".join(cores[:6]) or t[:24]

    kept_miss: list[dict] = []
    seen_cores: list[str] = []
    for h in pending_miss:
        core = _miss_core(h)
        dup = False
        for sc0 in seen_cores:
            if not core or not sc0:
                continue
            if core in sc0 or sc0 in core or float(fuzz.ratio(core, sc0)) >= 78:
                dup = True
                break
        if dup:
            continue
        seen_cores.append(core)
        kept_miss.append(h)
    n_miss = len(kept_miss)
    content_hits.extend(kept_miss)

    # 终检门：禁止「假一致」漏网（半句对整段 / 错配 / 有实质字差）
    gated: list[dict] = []
    n_ok = n_diff = n_miss = 0
    for h in content_hits:
        cat = h.get("category")
        if cat != "aligned":
            if cat == "issue":
                n_diff += 1
            elif cat == "unmatched":
                n_miss += 1
            gated.append(h)
            continue
        raw = h.get("excel_value") or ""
        pb = (h.get("text_b") or "").strip()
        pa = ""
        if "\nB:" in raw or raw.startswith("A:"):
            parts = raw.split("\nB:", 1)
            pa = re.sub(r"^A:\s*", "", parts[0]).strip()
            if not pb and len(parts) > 1:
                pb = parts[1].strip()
        else:
            pa = raw.strip()
        if not pa or not pb:
            # 单侧「一致」不合法 → 降为未对上或丢弃
            if is_cross_zone_glue_unit(pa or pb):
                continue
            h = dict(h)
            h["category"] = "unmatched"
            h["status"] = "疑点"
            h["field"] = re.sub(r"^#\d+\s*·\s*", "", h.get("field") or "")
            h["field"] = "未对上 · 需审核"
            h["evidence"] = "终检：一致项缺一侧文本，降为未对上"
            n_miss += 1
            gated.append(h)
            continue
        ok_aln, why = can_mark_aligned(pa, pb)
        if ok_aln:
            n_ok += 1
            gated.append(h)
            continue
        # 有实质差 → 字差；长度失衡噪声 → 丢弃或未对上
        diff = char_lcs_diff_spans(pa, pb)
        ma = _meaningful_frags(diff.get("only_a") or [])
        mb = _meaningful_frags(diff.get("only_b") or [])
        if ma or mb:
            h = dict(h)
            typo = _typo_labels(ma, mb, label_a=label_a, label_b=label_b)
            h["category"] = "issue"
            h["status"] = "疑点"
            h["field"] = "多/少/错字 · 需审核"
            h["evidence"] = f"【需审核·字差·终检】{typo}"
            h["sequence_diff"] = {
                "only_in_excel": ma[:8],
                "only_in_pack": mb[:8],
                "typo_hint": typo,
            }
            h["doubt_bucket"] = "typo"
            n_diff += 1
            gated.append(h)
        elif is_cross_zone_glue_unit(pa) or is_cross_zone_glue_unit(pb):
            continue  # 粘连噪声丢弃
        else:
            # 长度失衡且无清晰字差：不报假一致，也不刷未对上
            continue
    content_hits = gated

    # 阅读序：栏左→右，栏内上→下
    def _sort_key(h: dict) -> tuple:
        ro = h.get("read_order") or {}
        key = h.get("read_order_key")
        if isinstance(key, list) and key:
            return tuple(key) + (h.get("id") or "",)
        return (
            int(ro.get("column") or 0),
            float(ro.get("top") or 0),
            float(ro.get("left") or 0),
            0 if (ro.get("side") or "a") == "a" else 1,
            h.get("id") or "",
        )

    content_hits.sort(key=_sort_key)
    for seq, h in enumerate(content_hits, 1):
        h["seq"] = seq
        # 去掉旧 # 前缀再编号
        fl = re.sub(r"^#\d+\s*·\s*", "", h.get("field") or "")
        h["field"] = f"#{seq} · " + fl

    pair_n = len(pairs)
    if n_diff == 0 and n_miss == 0:
        overview_status = "一致"
    else:
        overview_status = "疑点"
    overview_score = 100.0 - min(n_diff * 6 + n_miss * 8, 55)
    if n_ok and not n_diff and not n_miss:
        overview_score = max(overview_score, 92.0)

    md = blocks_to_markdown(blocks_a, blocks_b, label_a=label_a, label_b=label_b)

    hits: list[dict] = [
        {
            "id": "overview",
            "field": "双页总览 · 一一对应",
            "excel_value": f"{label_a} ↔ {label_b}",
            "status": overview_status,
            "evidence": (
                f"版面成段 · 栏左→右 · 对齐 {n_ok} · 字差需审 {n_diff} · "
                f"未对上需审 {n_miss} · 配对 {pair_n} · 段单元 {len(units_a)}/{len(units_b)} · "
                f"聚段A={cluster_meta_a.get('source') or '—'} B={cluster_meta_b.get('source') or '—'} · "
                f"去粘连{dropped_glue} · 去规格相似 {sim_norm:.0f}"
            ),
            "score": overview_score,
            "decision": "pending",
            "bboxes": [],
            "bboxes_b": [],
            "page": 1,
            "category": "overview",
            "doubt_bucket": None if overview_status == "一致" else "coverage",
            "layout_blocks": {"a": blocks_a, "b": blocks_b},
            "compare_md": md,
            "cluster_meta": {"a": cluster_meta_a, "b": cluster_meta_b},
        },
        {
            "id": "stats",
            "field": "对齐统计",
            "excel_value": (
                f"一致={n_ok} · 字差={n_diff} · 未对上={n_miss} · "
                f"段A={len(units_a)} B={len(units_b)} · "
                f"聚段={cluster_meta_a.get('source') or '?'}/{cluster_meta_b.get('source') or '?'} · 栏序L→R"
            ),
            "status": "疑点" if (n_diff or n_miss) else "一致",
            "evidence": (
                f"{label_a}/{label_b} · 行业路径：百度paragraph/几何聚段→段级1:1；"
                f"跨行在段内合并；软覆盖控假未对上；真字差/真未对上须人审"
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
    # 挂到 hits 根也可被 task 层取
    hits[0]["_layout_meta"] = {
        "blocks_a": blocks_a,
        "blocks_b": blocks_b,
        "markdown": md,
    }
    return hits


def compare_cross_spec(
    words_a: list[dict],
    words_b: list[dict],
    text_a: str,
    text_b: str,
    *,
    label_a: str = "规格A",
    label_b: str = "规格B",
    mode: str = "cross_spec",
) -> list[dict]:
    """
    mode:
      - cross_spec: 不同净含量/装型，规格白名单更宽
      - pdf_internal: 同 PDF 双页 · 严格一一对应（字差/未对上需审）
      - pdf_pdf: 正错/任意双稿
    """
    # 双页：走严格 1:1，不再用 partial 乱配
    if mode == "pdf_internal":
        return compare_pdf_internal_1to1(
            text_a,
            text_b,
            words_a=words_a,
            words_b=words_b,
            label_a=label_a or "页1",
            label_b=label_b or "页2",
        )

    lines_a = ocr_lines(words_a)
    lines_b = ocr_lines(words_b)
    sim_raw = float(fuzz.token_set_ratio(normalize(text_a), normalize(text_b)))
    sim_norm = float(
        fuzz.token_set_ratio(_strip_spec_tokens(text_a), _strip_spec_tokens(text_b))
    )

    hits: list[dict] = []
    overview_status = (
        "一致" if sim_norm >= 88 else ("疑点" if sim_norm >= 70 else "缺失")
    )
    # 双页刀版：原文相似度常偏低，用去噪短语覆盖率重判
    phrases_a = extract_key_phrases(text_a, max_n=40)
    phrases_b = extract_key_phrases(text_b, max_n=40)

    only_a: list[str] = []
    only_b: list[str] = []
    shared: list[tuple[str, str, float]] = []  # (pa, best_pb, score)

    def _pair_score(pa: str, pb: str) -> float:
        na, nb = normalize(pa), normalize(pb)
        if not na or not nb:
            return 0.0
        # 长度差过大禁止 partial（防「金盏花」贴到「备案人…整句」）
        len_pen = abs(len(na) - len(nb)) / max(len(na), len(nb), 1)
        base = max(
            float(fuzz.ratio(na, nb)),
            float(fuzz.ratio(_strip_spec_tokens(pa), _strip_spec_tokens(pb))),
        )
        if len_pen <= 0.45:
            base = max(base, float(fuzz.partial_ratio(na[:48], nb[:48])) * 0.94)
        return base

    for pa in phrases_a:
        if is_whitelist_line(pa) and mode in ("cross_spec", "pdf_internal"):
            continue
        if is_noise_line(pa):
            continue
        best, sc = "", -1.0
        for pb in phrases_b:
            if is_noise_line(pb):
                continue
            s = _pair_score(pa, pb)
            if s > sc:
                best, sc = pb, s
        # 必须足够像才算「共享句」；否则进 only_a
        # 双页：全文命中/核心中文覆盖也算共享（抗断行假缺失）
        min_pair = 78 if mode == "pdf_internal" else 78
        if best and sc >= min_pair:
            shared.append((pa, best, sc))
        elif phrase_in_text(pa, text_b) or (
            mode == "pdf_internal" and _core_cn_covered(pa, text_b)
        ):
            shared.append((pa, best or pa, max(sc, 88.0)))
        else:
            only_a.append(pa)

    shared_a_norm = {normalize(pa) for pa, _, _ in shared}
    for pb in phrases_b:
        if is_whitelist_line(pb) and mode in ("cross_spec", "pdf_internal"):
            continue
        if is_noise_line(pb):
            continue
        if normalize(pb) in shared_a_norm:
            continue
        # B 是否已被某条 shared 覆盖
        if any(_pair_score(pa, pb) >= 80 for pa, _, _ in shared):
            continue
        if phrase_in_text(pb, text_a) or (
            mode == "pdf_internal" and _core_cn_covered(pb, text_a)
        ):
            continue
        only_b.append(pb)

    # 覆盖率（参考指标；双页不单靠它判疑点）
    total_a = max(1, len([p for p in phrases_a if not is_whitelist_line(p)]))
    hit_a = total_a - len(only_a)
    cov_ab = hit_a / total_a
    total_b = max(1, len([p for p in phrases_b if not is_whitelist_line(p)]))
    hit_b = total_b - len(only_b)
    cov_ba = hit_b / total_b
    cov = (cov_ab + cov_ba) / 2

    real_issues = 0  # 真文字差（LCS）
    expected_diff = 0
    aligned = 0
    face_notes = 0  # 分面提示（仅单侧，不计入疑点）
    char_diff_n = 0

    def _meaningful_frags(frags: list[str]) -> list[str]:
        """丢掉 OCR 拉丁碎片/单符号，只留有信息的差异。"""
        out = []
        for x in frags or []:
            x = (x or "").strip()
            if not x:
                continue
            # 有中文 ≥1 或 有意义英文词
            if re.search(r"[\u4e00-\u9fff]", x):
                if len(normalize(x)) >= 1:
                    out.append(x)
            elif re.search(r"[A-Za-z]{3,}", x) and not re.search(
                r"LIM|NANTH|ALPIN|OFFIC|EAEUROP|EDTA", x, re.I
            ):
                out.append(x)
        return out

    def _ws_equal(a: str, b: str) -> bool:
        """仅空白/标点差异 → 内容等价。"""
        def _c(s: str) -> str:
            t = normalize(s or "")
            t = re.sub(r"[，,。；;：:、·•\-\s\"'“”]", "", t)
            return t
        return bool(_c(a)) and _c(a) == _c(b)

    # —— 共享但字符有差：LCS 细标（双页主结论）——
    lcs_reported = 0
    for i, (pa, pb, sc) in enumerate(shared[:30]):
        if sc >= 94 or only_spec_differs(pa, pb) or _ws_equal(pa, pb):
            aligned += 1
            # 双页文字台要一一对应：多保留对齐行（不再只留 8 条）
            align_cap = 40 if mode == "pdf_internal" else 8
            if len(normalize(pa)) >= 8 and aligned <= align_cap:
                ba = (
                    locate_phrase_boxes(pa, words_a)
                    if mode != "pdf_internal"
                    else []
                )
                bb = (
                    locate_phrase_boxes(pb or pa, words_b)
                    if mode != "pdf_internal"
                    else []
                )
                hits.append(
                    _hit(
                        f"ok_{i}",
                        "已对齐",
                        f"A: {pa[:220]}\nB: {(pb or pa)[:220]}",
                        "一致",
                        f"短语对齐 score={sc:.0f}",
                        sc,
                        category="aligned",
                        bboxes=ba,
                        bboxes_b=bb,
                    )
                )
            continue
        if sc < 88:
            # 配对不够像：不当字符差，也不硬凑 1:1（避免乱配）
            continue
        # 成分/拉丁糊句不做 LCS（OCR 列阅读噪声）→ 仍写入一一对应
        if re.search(
            r"提取物|籽油|花油|共聚|聚醚|甘油三酯|LIM|NANTH|ALPIN|OFFIC|EAEUROP",
            pa + pb,
            re.I,
        ) and sc < 96:
            aligned += 1
            if mode == "pdf_internal":
                hits.append(
                    _hit(
                        f"ok_inci_{i}",
                        "已对齐",
                        f"A: {pa[:220]}\nB: {(pb or pa)[:220]}",
                        "一致",
                        f"成分/INCI 近似对齐 score={sc:.0f}",
                        sc,
                        category="aligned",
                    )
                )
            continue
        diff = char_lcs_diff_spans(pa, pb)
        if only_spec_differs(pa, pb) or (
            not diff["only_a"] and not diff["only_b"]
        ):
            expected_diff += 1
            if mode == "pdf_internal":
                aligned += 1
                hits.append(
                    _hit(
                        f"ok_eq_{i}",
                        "已对齐",
                        f"A: {pa[:220]}\nB: {(pb or pa)[:220]}",
                        "一致",
                        "内容等价（规格/空白归一后一致）",
                        sc,
                        category="aligned",
                    )
                )
            continue
        # LCS 比过低 = 假配对
        if diff["ratio"] < 0.80 and sc < 93:
            if mode == "pdf_internal" and sc >= 80:
                aligned += 1
                hits.append(
                    _hit(
                        f"ok_pair_{i}",
                        "已对齐",
                        f"A: {pa[:220]}\nB: {(pb or pa)[:220]}",
                        "一致",
                        f"配对对照 score={sc:.0f}",
                        sc,
                        category="aligned",
                    )
                )
            continue
        ma = _meaningful_frags(diff["only_a"])
        mb = _meaningful_frags(diff["only_b"])
        if not ma and not mb:
            aligned += 1
            if mode == "pdf_internal":
                hits.append(
                    _hit(
                        f"ok_nomark_{i}",
                        "已对齐",
                        f"A: {pa[:220]}\nB: {(pb or pa)[:220]}",
                        "一致",
                        f"短语对齐 score={sc:.0f}",
                        sc,
                        category="aligned",
                    )
                )
            continue
        # 双页：限制条数，避免 OCR 噪声刷屏
        if mode == "pdf_internal" and lcs_reported >= 8:
            continue
        real_issues += 1
        char_diff_n += 1
        lcs_reported += 1
        ba = boxes_for_char_fragments(ma or [pa[:12]], words_a)
        if not ba:
            ba = locate_phrase_boxes(pa, words_a)
            for b in ba:
                b["role"] = "check"
                b["status"] = "warn"
        bb = boxes_for_char_fragments(mb or [pb[:12]], words_b)
        if not bb:
            bb = locate_phrase_boxes(pb, words_b)
            for b in bb:
                b["role"] = "check"
                b["status"] = "warn"
        da = "、".join(ma[:4]) or "—"
        db = "、".join(mb[:4]) or "—"
        hits.append(
            _hit(
                f"lcs_{i}",
                "文案字符差异",
                f"A: {pa[:120]}\nB: {pb[:120]}",
                "疑点",
                f"【差在这些字】A侧「{da}」· B侧「{db}」· 相似度 {sc:.0f}% · LCS {diff['ratio']*100:.0f}%",
                sc,
                category="issue",
                bboxes=ba,
                bboxes_b=bb,
                text_b=pb,
                sequence_diff={
                    "only_in_excel": ma[:8],
                    "only_in_pack": mb[:8],
                    "ratio": diff["ratio"],
                },
                doubt_bucket="typo"
                if max((len(normalize(x)) for x in ma + mb), default=9) <= 4
                else "coverage",
            )
        )

    # —— 仅 A / 仅 B ——
    # pdf_internal：双页=不同刀版面 → 默认「分面提示」不算疑点
    # 其它模式：高价值才报疑点
    def _is_high_value(p: str) -> bool:
        if is_noise_line(p):
            return False
        # INCI 碎片不当「整页缺失」
        if re.search(r"提取物|籽油|花油|共聚物|聚醚|甘油", p) and len(normalize(p)) < 18:
            return False
        if any(k in p for k in ANCHOR_KW):
            return True
        # 完整卖点句
        if len(normalize(p)) >= 12 and re.search(r"[\u4e00-\u9fff]{8,}", p):
            if not re.search(r"[A-Z]{5,}", p):  # 少拉丁糊字
                return True
        return False

    side_cap = 4 if mode == "pdf_internal" else 12
    side_n = 0
    for i, pa in enumerate(only_a[:30]):
        if side_n >= side_cap:
            break
        if not _is_high_value(pa):
            continue
        if is_whitelist_line(pa):
            expected_diff += 1
            continue
        side_n += 1
        ba = locate_phrase_boxes(pa, words_a)
        if mode == "pdf_internal":
            # 分面正常：一致 + face_split，不抬高疑点计数
            face_notes += 1
            for b in ba:
                b["role"] = "context"
                b["status"] = "ok"
                b["label"] = f"仅{label_a}"
            hits.append(
                _hit(
                    f"a_only_{i}",
                    f"分面·仅{label_a}",
                    pa,
                    "一致",
                    f"双页不同面：{label_b}未见此句属常见分面，不按漏印计 · 仅当公共文案两边字不同才报疑点",
                    100.0,
                    category="face_split",
                    bboxes=ba,
                    side="a",
                    doubt_bucket=None,
                )
            )
        else:
            real_issues += 1
            for b in ba:
                b["role"] = "check"
                b["status"] = "warn"
                b["label"] = f"仅{label_a}"
            hits.append(
                _hit(
                    f"a_only_{i}",
                    f"仅{label_a}有 · {label_b}未见",
                    pa,
                    "疑点",
                    f"{label_b} 未覆盖该关键句 · 请核是否改稿/漏印/分面不同",
                    0.0,
                    category="issue",
                    bboxes=ba,
                    side="a",
                    doubt_bucket="coverage",
                )
            )

    side_n = 0
    for j, pb in enumerate(only_b[:30]):
        if side_n >= side_cap:
            break
        if not _is_high_value(pb):
            continue
        if is_whitelist_line(pb):
            expected_diff += 1
            continue
        side_n += 1
        bb = locate_phrase_boxes(pb, words_b)
        if mode == "pdf_internal":
            face_notes += 1
            for b in bb:
                b["role"] = "context"
                b["status"] = "ok"
                b["label"] = f"仅{label_b}"
            hits.append(
                _hit(
                    f"b_only_{j}",
                    f"分面·仅{label_b}",
                    pb,
                    "一致",
                    f"双页不同面：{label_a}未见此句属常见分面，不按漏印计",
                    100.0,
                    category="face_split",
                    bboxes_b=bb,
                    side="b",
                    doubt_bucket=None,
                )
            )
        else:
            real_issues += 1
            for b in bb:
                b["role"] = "check"
                b["status"] = "warn"
                b["label"] = f"仅{label_b}"
            hits.append(
                _hit(
                    f"b_only_{j}",
                    f"仅{label_b}有 · {label_a}未见",
                    pb,
                    "疑点",
                    f"{label_a} 未覆盖 · 请核是否改稿/漏印",
                    0.0,
                    category="issue",
                    bboxes_b=bb,
                    side="b",
                    doubt_bucket="coverage",
                )
            )

    # —— 总览 / 统计（放在后面，用真实计数）——
    if mode == "pdf_internal":
        # 双页主指标：真字差条数；覆盖率只作参考
        if char_diff_n == 0:
            overview_status = "一致"
        elif char_diff_n <= 3:
            overview_status = "疑点"
        else:
            overview_status = "疑点"
        overview_ev = (
            f"双页模式·以公共文案字符差为准 · 真字差 {char_diff_n} 条 · "
            f"已对齐≈{aligned} · 分面提示 {face_notes}（不计疑点）· "
            f"去规格相似 {sim_norm:.0f} · 短语覆盖参考 A→B {cov_ab*100:.0f}% / B→A {cov_ba*100:.0f}%"
        )
        overview_score = 100.0 - min(char_diff_n * 8, 40) if char_diff_n else max(
            88.0, sim_norm, cov * 100
        )
    else:
        if cov >= 0.85 and sim_norm >= 75:
            overview_status = "一致"
        elif cov >= 0.65:
            overview_status = "疑点"
        overview_ev = (
            f"去规格相似度 {sim_norm:.0f} · 原文 {sim_raw:.0f} · "
            f"关键短语覆盖 A→B {cov_ab*100:.0f}% ({hit_a}/{total_a}) · "
            f"B→A {cov_ba*100:.0f}% ({hit_b}/{total_b}) · "
            f"行 {len(lines_a)}/{len(lines_b)}（已滤工艺噪声）"
        )
        overview_score = max(sim_norm, cov * 100)

    hits.insert(
        0,
        {
            "id": "overview",
            "field": f"{'双页' if mode == 'pdf_internal' else '跨规格'}总览",
            "excel_value": f"{label_a} ↔ {label_b}",
            "status": overview_status,
            "evidence": overview_ev,
            "score": overview_score,
            "decision": "pending",
            "bboxes": [],
            "bboxes_b": [],
            "page": 1,
            "category": "overview",
            "doubt_bucket": None if overview_status == "一致" else "coverage",
        },
    )
    hits.insert(
        1,
        {
            "id": "stats",
            "field": "对齐统计",
            "excel_value": (
                f"对齐≈{aligned} · 真字差={char_diff_n} · "
                f"分面提示={face_notes} · 预期可不同≈{expected_diff}"
                if mode == "pdf_internal"
                else (
                    f"对齐≈{aligned} · 字符差={char_diff_n} · "
                    f"仅单侧高价值={real_issues} · 预期可不同≈{expected_diff}"
                )
            ),
            "status": "疑点" if real_issues else "一致",
            "evidence": (
                (
                    f"{label_a}/{label_b} · PDF内双页=不同刀版面 · "
                    f"只审公共文案字差 · 仅单侧默认分面不报疑点 · "
                    f"工艺噪声/净含量条码已滤"
                )
                if mode == "pdf_internal"
                else (
                    f"{label_a}/{label_b} · 已用关键短语覆盖（非逐行硬对齐）· "
                    f"工艺/印刷噪声已过滤 · 净含量条码白名单"
                )
            ),
            "score": 100.0 - min(real_issues * 4, 35),
            "decision": "pending",
            "bboxes": [],
            "bboxes_b": [],
            "page": 1,
            "category": "stats",
        },
    )
    return hits
