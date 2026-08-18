"""
INCI / 成分名 OCR 变体归一（护肤品）

把 OCR 常见错字映射到标准片段，提高覆盖率与反向过滤质量。
"""
from __future__ import annotations

import re
from typing import Iterable

# (pattern, canonical) — 用于归一化后再匹配
INCI_ALIASES: list[tuple[str, str]] = [
    # 柑橘类
    (r"citrusa?urantium\s*dulcis|citrus\s*aurantium\s*dulcis", "CITRUS AURANTIUM DULCIS"),
    (r"citrusa?urantii?folia|citrus\s*aurantifolia", "CITRUS AURANTIIFOLIA"),
    (r"citrus\s*limon|citruslimon", "CITRUS LIMON"),
    (r"citrusa?ubantil?mbergam|citrus\s*aurantium\s*bergamia|bergamia", "CITRUS AURANTIUM BERGAMIA"),
    (r"citrus\s*reticulata|citrusreticulata", "CITRUS RETICULATA"),
    # 植物
    (r"centella\s*asiatica|centellaasiatica", "CENTELLA ASIATICA"),
    (r"pelargonium\s*graveolens|pelargoniumgraveolens|nium\s*graveolens", "PELARGONIUM GRAVEOLENS"),
    (r"leontopodium\s*alpinum|leontopodiumalpinum|topodiumalpinum", "LEONTOPODIUM ALPINUM"),
    (r"gardenia\s*florida|gardeniaflorida", "GARDENIA FLORIDA"),
    (r"ficus\s*carica|ficuscarica", "FICUS CARICA"),
    # 中文常见 OCR
    (r"香柠檬", "香柠檬"),
    (r"酸橙", "酸橙"),
    (r"来檬|莱檬", "来檬"),
    (r"生育酚|维生素\s*e", "生育酚"),
    (r"椰油基葡糖苷|椰油基葡糖育", "椰油基葡糖苷"),
    (r"α-?熊果苷|a-?熊果苷", "α-熊果苷"),
    (r"宜侬|宜依", "宜侬"),
    (r"科思嘉|科思", "科思嘉"),
    (r"伸燚|伸焱", "伸燚"),
    (r"光感能精华", "光感焕能精华"),  # 漏字归一到标准（匹配时用）
    (r"洽询|治询", "洽询"),
    (r"详龄", "译龄"),  # OCR 形近：详/译
    (r"椰油基葡糖育|椰油基葡物|葡糖育|葡物", "椰油基葡糖苷"),  # OCR 断行糊字
    (r"生育酚\(维生素e\)|维生素e|生育酚", "生育酚"),
    # 刀版 OCR 糊字（高精度仍常见）
    (r"酸丙酸酸交联|酸丙酸交联|丙烯酸.?米.?/?", "丙烯酸酯交联"),
    (r"红没药酸", "红没药醇"),
    (r"果皮凉", "果皮油"),
    (r"氯化蓖麻油|氢化蓖麻", "氢化蓖麻油"),
    (r"月桂酰谷(?!氨酸)", "月桂酰谷氨酸"),
    (r"聚丁二醇-?8/?5/?3", "聚丁二醇-8/5/3"),
    (r"c10-30酸", "C10-30烷醇丙烯"),
    (r"伸懿|伸燚|伸焱", "伸燚"),
    (r"宜依|宜侬", "宜侬"),
    (r"上生区桥|桥还", "奉贤"),
    # 氢/氯 形近：刀版 OCR 高频把「氢化卵磷脂」读成「氯化卵磷脂」
    (r"氯化卵磷脂", "氢化卵磷脂"),
    (r"氢化卵磷脂|卵磷脂", "氢化卵磷脂"),
    (r"聚二中基硅氧烷|聚二甲基硅氧烷", "聚二甲基硅氧烷"),
    (r"内烯酸钠|丙烯酸钠", "丙烯酸钠"),
    (r"内烯酰|丙烯酰", "丙烯酰"),
    (r"生育酚\(维生素e\)|生育酚\(维生素E\)|维生素\s*e|生育酚", "生育酚"),
    (r"维生索e|维生索E", "维生素E"),  # 索/素 形近
]

# 快速替换表（规范化字符串）
_SUBS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(p, re.I), c) for p, c in INCI_ALIASES
]


def normalize_inci_text(s: str) -> str:
    if not s:
        return ""
    t = s
    # 去多余空白
    t = re.sub(r"\s+", " ", t)
    for pat, canon in _SUBS:
        t = pat.sub(canon, t)
    # 括号拉丁名统一大写空格
    def _up(m: re.Match[str]) -> str:
        inner = m.group(1)
        inner = re.sub(r"\s+", " ", inner.strip()).upper()
        return f"({inner})"

    t = re.sub(r"\(([A-Za-z][A-Za-z0-9\s\-/]{2,})\)", _up, t)
    return t


def expand_query_variants(phrase: str) -> list[str]:
    """为匹配生成 OCR 可能写法"""
    base = [phrase]
    n = normalize_inci_text(phrase)
    if n != phrase:
        base.append(n)
    # 去括号拉丁名只留中文
    cn = re.sub(r"\([^)]*\)", "", phrase).strip()
    if cn and cn != phrase:
        base.append(cn)
    # 仅拉丁名
    m = re.search(r"\(([^)]+)\)", phrase)
    if m:
        base.append(m.group(1).strip())
        base.append(m.group(1).replace(" ", ""))
    # 常见粘连
    base.append(re.sub(r"\s+", "", phrase))
    out, seen = [], set()
    for b in base:
        b = b.strip()
        if len(b) < 2:
            continue
        k = b.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(b)
    return out


def pack_text_for_match(ocr_text: str) -> str:
    """OCR 全文归一后再参与子串匹配"""
    return normalize_inci_text(ocr_text or "")
