"""
文案软匹配（护肤品包装隐性知识）

Excel 确认单常写：
  ·光感透亮 / 1步骤 涂·精华液 / *“：”为设计图案
包装 OCR 常见：
  光感透亮 / 步骤.涂·精华液 / 跨列粘成「柔嫩细腻使用方法：①…」

本模块只做「可解释的规范化 + 定位」，不堆启发式屎山。
"""
from __future__ import annotations

import re
from typing import Any

def normalize(s: str) -> str:
    """轻量归一（避免与 fields 循环依赖）。"""
    if not s:
        return ""
    try:
        from app.inci_normalize import normalize_inci_text

        s = normalize_inci_text(str(s))
    except Exception:
        s = str(s)
    s = s.replace("\u3000", " ").replace("\xa0", " ")
    s = re.sub(r"\s+", "", s)
    return s.replace("：", ":").replace("（", "(").replace("）", ")").lower()


# 步骤写法：1步骤 / 步骤01 / 步骤. / 步骤，
_STEP_RE = re.compile(
    r"(?:(?P<n>[12一二])\s*步骤|步骤\s*0*(?P<n2>[12]))\s*[.．、，,:]?\s*",
    re.I,
)
_BULLET_RE = re.compile(r"^[\s·•\-*＊※]+")
_FOOTNOTE_STAR = re.compile(r"^[\s\*＊]+")
# OCR 跨区粘连：卖点尾 + 用法/成分头
_GLUE_NOISE = re.compile(
    r"(?:"
    r"(?:透亮|保湿|柔嫩|细腻|焕能|精华液).{0,6}(?:使用方法|成分|贮存|注意|其他微量)"
    r"|(?:面膜|精华液|精华面膜)步骤\s*0*\d"
    r"|(?:步骤\s*0*\d).{0,4}(?:MOISTURIZING|BRIGHTENING|成分)"
    r")",
    re.I,
)


def soft_key(phrase: str) -> str:
    """用于子串匹配的软键：去项目符号、统一步骤、压标点。"""
    s = (phrase or "").strip()
    s = _FOOTNOTE_STAR.sub("", s)
    s = _BULLET_RE.sub("", s)
    # 步骤统一成 步骤1 / 步骤2 + 动作核
    def _step_sub(m: re.Match) -> str:
        n = m.group("n") or m.group("n2") or ""
        n = {"一": "1", "二": "2"}.get(n, n)
        return f"步骤{n}"

    s = _STEP_RE.sub(_step_sub, s)
    s = s.replace("涂·", "涂").replace("敷·", "敷")
    s = s.replace("·", "").replace("•", "")
    # 特殊引号/冒号图案脚注：抽核心
    if "设计图案" in s or "没有任何含义" in s:
        if "设计图案" in s:
            return normalize("为设计图案没有任何含义")
        return normalize("没有任何含义")
    return normalize(s)


def soft_anchors(phrase: str) -> list[str]:
    """多锚点：软键 + 去步骤号后的动作核 + 中文核。"""
    raw = (phrase or "").strip()
    keys: list[str] = []
    sk = soft_key(raw)
    if len(sk) >= 3:
        keys.append(sk)
    # 动作核：涂精华液 / 敷面膜
    for a in re.findall(r"(?:涂|敷)[·\s]*[\u4e00-\u9fff]{2,8}", raw):
        keys.append(normalize(a.replace("·", "")))
    # 卖点 2–6 字
    core = _BULLET_RE.sub("", _FOOTNOTE_STAR.sub("", raw))
    core = re.sub(r"[*＊\"“”'：:。，,.、\s]+", "", core)
    if 2 <= len(core) <= 12:
        keys.append(normalize(core))
    # 脚注
    if "设计图案" in raw:
        keys.append(normalize("设计图案"))
    if "没有任何含义" in raw:
        keys.append(normalize("没有任何含义"))
    if "组合商标" in raw or "品牌标识" in raw or re.search(r"grrshula", raw, re.I):
        keys.append(normalize("整体组合商标仅作为品牌标识使用"))
        keys.append(normalize("组合商标"))
        keys.append(normalize("品牌标识使用无其他含义"))
        keys.append(normalize("cellgrrshula"))  # OCR 常粘连 / Cel 漏 l
        keys.append(normalize("celgrrshula"))
    if "25+" in raw or "25＋" in raw:
        keys.append(normalize("25+"))
        keys.append(normalize("年龄25+的肌肤研制"))
    if "设计元素" in raw or "产品实物" in raw:
        keys.append(normalize("设计元素"))
        keys.append(normalize("产品实物为准"))
    if "昵称" in raw:
        keys.append(normalize("精华液的昵称"))
        keys.append(normalize("昵称"))
        keys.append(normalize("光感焕能精华液"))
        keys.append(normalize("光感能精华液"))  # OCR 漏「焕」
    # 步骤+涂/敷 宽松
    if re.search(r"步骤|[12]步骤|涂|敷", raw):
        if "涂" in raw and "精华" in raw:
            keys.append(normalize("涂精华液"))
            keys.append(normalize("步骤涂精华液"))
        if "敷" in raw and "面膜" in raw:
            keys.append(normalize("敷面膜"))
            keys.append(normalize("步骤敷面膜"))
    out, seen = [], set()
    for k in keys:
        if k and len(k) >= 2 and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def phrase_soft_in_ocr(phrase: str, n_ocr: str, n_ocr_u: str | None = None) -> bool:
    if not phrase or not n_ocr:
        return False
    for a in soft_anchors(phrase):
        if len(a) < 2:
            continue
        if a in n_ocr:
            return True
        if n_ocr_u and a in n_ocr_u:
            return True
        # 步骤.涂 / 步骤，敷 粘连变体
        if "步骤" in a and ("涂" in a or "敷" in a):
            if "步骤" in n_ocr and (
                ("涂" in a and "涂" in n_ocr and "精华" in n_ocr)
                or ("敷" in a and "敷" in n_ocr and "面膜" in n_ocr)
            ):
                return True
    # 极短卖点（光感透亮）去符号后 4+ 字
    core = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", phrase or "")
    if 3 <= len(core) <= 10 and normalize(core) in n_ocr:
        return True
    return False


def is_ocr_column_glue(token: str) -> bool:
    """跨列/跨区 OCR 粘连噪声（不应进 only_in_pack）。"""
    t = (token or "").strip()
    if len(t) < 8:
        return False
    if _GLUE_NOISE.search(t):
        return True
    # 中文卖点字 + 立刻接使用方法编号
    if re.search(r"[\u4e00-\u9fff]{2,6}使用方法\s*[:：]?[①1]", t):
        return True
    if re.search(r"[\u4e00-\u9fff]{2,6}其他微量成分", t):
        return True
    return False


def locate_phrase_boxes(
    phrase: str,
    ocr_words: list[dict],
    *,
    min_score: float = 80.0,
) -> list[dict]:
    """
    在 OCR 词上定位软匹配框（供疑点证据高亮）。
    返回 0..n 个 location 框。
    """
    from rapidfuzz import fuzz

    anchors = soft_anchors(phrase)
    if not anchors or not ocr_words:
        return []
    best_score = 0.0
    best_boxes: list[dict] = []

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
            "role": "miss_anchor",
            "label": (phrase or "")[:24],
        }

    for i, w in enumerate(ocr_words):
        raw = w.get("text") or ""
        n_w = normalize(raw)
        if len(n_w) < 2:
            continue
        for a in anchors:
            if a in n_w or n_w in a:
                b = _box(w)
                if b:
                    return [b]
            sc = float(fuzz.partial_ratio(a[:24], n_w[:48]))
            if sc > best_score:
                best_score = sc
                b = _box(w)
                best_boxes = [b] if b else []
        # 滑窗拼 2–4 词
        acc = ""
        boxes = []
        for j in range(i, min(i + 6, len(ocr_words))):
            if int(ocr_words[j].get("page") or 1) != int(w.get("page") or 1):
                break
            acc += ocr_words[j].get("text") or ""
            b = _box(ocr_words[j])
            if b:
                boxes.append(b)
            n_acc = normalize(acc)
            for a in anchors:
                if len(a) >= 3 and a in n_acc:
                    return boxes
                sc = float(fuzz.partial_ratio(a[:24], n_acc[:64]))
                if sc >= min_score and sc > best_score:
                    best_score = sc
                    best_boxes = list(boxes)

    if best_score >= min_score:
        return best_boxes
    return []


def zone_fallback_box(zones: dict[str, Any] | None, zone_name: str = "claims") -> dict | None:
    """zone 无词框时，用 y 带造一个「建议核对区」（宽度由调用方补）。"""
    if not zones:
        return None
    z = zones.get(zone_name) or {}
    y0, y1 = z.get("y0"), z.get("y1")
    if y0 is None or y1 is None:
        return None
    return {
        "page": 1,
        "left": 0,
        "top": int(y0),
        "width": 0,  # 调用方按页宽填
        "height": max(40, int(y1) - int(y0)),
        "role": "zone_hint",
        "label": z.get("label") or zone_name,
    }
