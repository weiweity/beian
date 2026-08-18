"""
供应链硬规则：错字 / 漏字 / 不该少的空格 → 直接「缺失」

典型：
  确认单 Cell Grrshula  vs  包装 Cel Grshula / CellGrrshula
  确认单有空格，包装粘连无空格
"""
from __future__ import annotations

import re
from typing import Any

from rapidfuzz import fuzz


def _norm_loose(s: str) -> str:
    s = (s or "").strip()
    s = re.sub(r"\s+", "", s)
    return s.lower()


def _norm_space(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


# 品牌/商标等高敏词（可扩展）
_BRAND_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"Cell\s*Grrshula", re.I), "Cell Grrshula"),
    (re.compile(r"Grrshula", re.I), "Grrshula"),
]

# 包装侧可能的糊/缺字形态
_PACK_BRAND_RE = re.compile(
    r"C\s*e\s*l{1,2}\s*G\s*r{1,3}\s*s?h\s*u\s*l\s*a|"
    r"Cel+\s*Grr?s?hula|"
    r"Cell\s*Grr?s?hula|"
    r"CellGrrshula|"
    r"Cel\s*Grshula|"
    r"Grr?s?hula",
    re.I,
)


def detect_hard_typos(
    excel_value: str,
    ocr_text: str,
    *,
    field_group: str = "",
) -> list[dict[str, Any]]:
    """
    返回硬缺字/漏空格问题列表。
    每项: {kind, excel, pack, message}
    kind: missing_char | missing_space | wrong_char
    """
    excel = excel_value or ""
    ocr = ocr_text or ""
    if not excel or not ocr:
        return []

    issues: list[dict[str, Any]] = []
    fg = field_group or ""

    # —— 品牌 Cell Grrshula ——
    excel_has_brand = bool(re.search(r"Cell\s*Grrshula|Grrshula", excel, re.I))
    if excel_has_brand or fg in ("logo标识", "文案", "英文品名"):
        expected = "Cell Grrshula"
        pe = _norm_loose(expected)
        # 带空格的正确形态 vs 粘连形态（\s* 会把 CellGrrshula 也算进去，必须分开）
        has_spaced = bool(re.search(r"Cell\s+Grrshula", ocr, re.I))
        has_glued = bool(re.search(r"CellGrrshula", ocr, re.I))
        has_correct_chars = pe in _norm_loose(ocr)  # 字母齐全（可无空格）
        pack_hits = list(_PACK_BRAND_RE.finditer(ocr))

        # 1) 字母齐全但漏空格
        if has_glued and not has_spaced and has_correct_chars:
            issues.append(
                {
                    "kind": "missing_space",
                    "excel": expected,
                    "pack": "CellGrrshula",
                    "message": f"漏空格：确认单「{expected}」包装「CellGrrshula」",
                }
            )
        # 2) 字母不齐（Cel Grshula 等）且没有正确拼写
        elif not has_correct_chars:
            for m in pack_hits:
                pack = m.group(0)
                pp = _norm_loose(pack)
                if pe == pp:
                    continue
                ratio = float(fuzz.ratio(pe, pp))
                if ratio >= 70:
                    issues.append(
                        {
                            "kind": "missing_char",
                            "excel": expected,
                            "pack": pack,
                            "message": f"缺字/错字：确认单「{expected}」包装「{pack}」",
                        }
                    )
        # 3) 有正确带空格形态 → 不报；仅有糊字 Cel 也不报

    # —— 通用：确认单中的「英文词组含空格」在包装粘连 ——
    # 仅 logo/文案/英文品名，避免成分 INCI 误伤
    if fg in ("logo标识", "文案", "英文品名", "中文品名"):
        for m in re.finditer(r"[A-Za-z][A-Za-z]+(?:\s+[A-Za-z][A-Za-z]+){1,4}", excel):
            phrase = m.group(0).strip()
            if len(phrase) < 6:
                continue
            # 跳过已处理品牌
            if re.search(r"Grrshula|BRIGHTENING|VITALIZING|ESSENCE", phrase, re.I):
                if "Grrshula" in phrase:
                    continue
            glued = re.sub(r"\s+", "", phrase)
            n_ocr_loose = _norm_loose(ocr)
            # 包装有粘连形态、没有带空格形态
            spaced_ok = bool(
                re.search(re.escape(phrase), ocr, re.I)
                or re.search(re.escape(_norm_space(phrase)), ocr, re.I)
            )
            glued_ok = glued.lower() in n_ocr_loose
            if glued_ok and not spaced_ok and " " in phrase:
                # 再确认不是 partial 误伤
                if len(glued) >= 8:
                    issues.append(
                        {
                            "kind": "missing_space",
                            "excel": phrase,
                            "pack": glued,
                            "message": f"漏空格：确认单「{phrase}」包装似粘成「{glued}」",
                        }
                    )

    # 去重
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for it in issues:
        k = it["message"]
        if k in seen:
            continue
        seen.add(k)
        out.append(it)
    return out[:8]


def apply_hard_typo_status(
    *,
    status: str,
    evidence: str,
    excel_value: str,
    ocr_text: str,
    field_group: str,
) -> tuple[str, str, str | None, list[dict]]:
    """
    若检出硬缺字/漏空格 → status=缺失, doubt_bucket=typo
    """
    issues = detect_hard_typos(excel_value, ocr_text, field_group=field_group)
    if not issues:
        return status, evidence, None, []
    # logo/文案/品名：直接缺失；其它字段仍标缺失但允许人审
    msgs = "；".join(i["message"] for i in issues[:4])
    ev = f"【硬规则·缺字/漏空格】{msgs} · " + (evidence or "")
    return "缺失", ev, "typo", issues
