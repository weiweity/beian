"""化妆品成分表的语义解析、版面锚定与逐项 OCR 核对。

这个模块只暴露两个稳定接口：

``parse_ingredient_atoms``
    按确认单合同把成分值解析成完整原子名称。顿号、换行及非数字位逗号
    是分隔符；斜杠、连字符、数字逗号、括号及括号内拉丁名保留在原子中。

``analyze_ingredient_field``
    先用“成分：/其他微量成分：”找到真实 OCR 文本块，再只在该块内逐项
    匹配。输出的字段框是 OCR 行框的并集，并按真实页面尺寸裁剪；没有可靠
    锚点或高密度成分块时返回空框，禁止猜右半页。
"""
from __future__ import annotations

import re
import unicodedata
from statistics import median
from typing import Any

from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein

from app.ingredient_lexicon import (
    ingredient_reference_metadata,
    ingredient_reference_names,
    lookup_ingredient_reference,
)

_SECTION_LABEL_RE = re.compile(
    r"(?:其他微量成分|微量成分|化妆品成分表|全成分|成分表|成分)\s*[:：]\s*",
    re.I,
)
_ANCHOR_RE = re.compile(
    r"(?:^|[\s\n])(?:其他微量成分|微量成分|全成分|成分)\s*[:：]",
    re.I,
)
_WEAK_ANCHOR_RE = re.compile(r"(?:化妆品成分表|全成分|成分表)", re.I)

# 工程/审批表不是包装正文。命中这些词的 OCR 行既不能成为锚，也不能把两个
# 正文行桥接成一个巨框。
_ENGINEERING_RE = re.compile(
    r"刀模|刀版|展开图|版本号|更新内容|更新时间|设计部|设计师|联系人|电话|微信|"
    r"项目名称|包材名称|包装设计|职责|签字|稿件号|制图|审核人|批准人|色号|"
    r"工艺说明|颜色要求",
    re.I,
)

# 同一栏遇到下一个包装字段就停止扩块。备案版本号/执行标准版本号属于字段
# 正文，只有以这些工程字段名开头的行才由上面的工程表达式排除。
_CONTENT_STOP_RE = re.compile(
    r"^\s*(?:使用方法|用法|注意事项|贮存条件|生产企业|委托方|备案人|"
    r"产品名称|中文品名|英文品名|净含量|执行标准|条形码|二维码)\s*[:：]",
    re.I,
)
_STEP_PREFIX_RE = re.compile(
    r"^\s*(?:(?:步骤\s*0*\d+|step\s*\d+)\s*[.．、:：\-]*\s*)?"
    r"(?:(?:精华液|面膜)\s*[:：]\s*)?",
    re.I,
)
_STEP_CONTEXT_RE = re.compile(r"(?:步骤\s*0*(\d+)|step\s*0*(\d+))", re.I)
_MEDIUM_CONTEXT_RE = re.compile(
    r"^\s*(?:(?:步骤\s*0*\d+|step\s*\d+)\s*[.．、:：\-]*\s*)?"
    r"(精华液|面膜)\s*[:：]",
    re.I,
)
_LOCANT_OCR_ONE_RE = re.compile(
    r"(^|[\s(（/、,，;；:：])(?:l|i|\|)(?=\s*[,，]\s*\d)",
    re.I,
)


def _neighbor_nonspace_index(text: str, start: int, step: int) -> int | None:
    index = start
    while 0 <= index < len(text):
        if not text[index].isspace():
            return index
        index += step
    return None


def _is_numeric_comma(
    text: str, index: int, *, allow_ocr_locant_confusion: bool
) -> bool:
    left_index = _neighbor_nonspace_index(text, index - 1, -1)
    right_index = _neighbor_nonspace_index(text, index + 1, 1)
    if left_index is None or right_index is None or not text[right_index].isdigit():
        return False
    if text[left_index].isdigit():
        return True
    if not allow_ocr_locant_confusion or text[left_index].lower() not in {"l", "i", "|"}:
        return False

    # 仅把原子开头或化学片段开头的 l/I/| 当作 OCR 的数字 1。普通英文单词
    # 末尾的 l,2 仍按列表逗号切开，避免扩大误匹配面。
    before_left = _neighbor_nonspace_index(text, left_index - 1, -1)
    return before_left is None or text[before_left] in "(（/、,，;；:："


def _split_ingredient_units(
    value: str, *, allow_ocr_locant_confusion: bool = False
) -> list[str]:
    """按成分列表语法切分；数字位逗号及其两侧空白属于原子名称。"""
    text = str(value or "")
    chunks: list[str] = []
    current: list[str] = []
    for index, char in enumerate(text):
        delimiter = char in "、\r\n"
        if char in ",，":
            delimiter = not _is_numeric_comma(
                text,
                index,
                allow_ocr_locant_confusion=allow_ocr_locant_confusion,
            )
        if delimiter:
            chunks.append("".join(current))
            current = []
        else:
            current.append(char)
    chunks.append("".join(current))
    return chunks


def _normalize_numeric_locant_ocr(value: str) -> str:
    """只在数字位上下文把 OCR 的 l/I/| 归一为 1，不改普通英文化学名。"""
    return _LOCANT_OCR_ONE_RE.sub(lambda match: f"{match.group(1)}1", value)


def parse_ingredient_atoms(value: str) -> list[str]:
    """把 Excel 成分值解析成完整原子列表，保序且不拆复合名称。"""
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return []

    # 步骤/介质标题是字段上下文，不是成分。只在行首剥离，避免误删名称正文。
    text = "\n".join(_STEP_PREFIX_RE.sub("", line) for line in text.split("\n"))
    # 主成分与微量成分引导词都转成块内换行；它们本身不参与覆盖率分母。
    text = _SECTION_LABEL_RE.sub("\n", text)

    atoms: list[str] = []
    for raw in _split_ingredient_units(text):
        atom = raw.strip(" \t\u3000，,；;。|")
        if not atom:
            continue
        # 防御仍残留的“步骤01：”前缀，但不碰原子内部的数字、逗号和连字符。
        atom = re.sub(
            r"^(?:步骤\s*0*\d+|step\s*\d+)\s*[.．、:：\-]*\s*",
            "",
            atom,
            flags=re.I,
        ).strip()
        if atom:
            atoms.append(atom)
    return atoms


def _compact(value: str) -> str:
    # 判定层只做字符形态归一；不能复用 INCI 语义别名，否则“卵磷脂”会被
    # 改写成“氢化卵磷脂”，把真实的少印/多印错误判为一致。
    text = unicodedata.normalize(
        "NFKC", _normalize_numeric_locant_ocr(str(value or ""))
    )
    text = (
        text.replace("（", "(")
        .replace("）", ")")
        .replace("／", "/")
        .replace("－", "-")
        .replace("—", "-")
        .lower()
    )
    # 匹配层允许 OCR 丢标点/空格，但解析层从不据此拆原子。
    return re.sub(r"[^0-9a-z\u4e00-\u9fffα-ω]", "", text)


def _word_box(word: dict) -> dict[str, int] | None:
    loc = word.get("location") or {}
    width = int(loc.get("width") or 0)
    height = int(loc.get("height") or 0)
    if width <= 0 or height <= 0:
        return None
    return {
        "page": int(word.get("page") or 1),
        "left": int(loc.get("left") or 0),
        "top": int(loc.get("top") or 0),
        "width": width,
        "height": height,
    }


def _page_size(
    words: list[dict], page: int, page_w: int | None, page_h: int | None
) -> tuple[int, int]:
    page_words = [w for w in words if int(w.get("page") or 1) == page]
    explicit_w = [
        int(w.get("_page_width") or w.get("page_width") or 0) for w in page_words
    ]
    explicit_h = [
        int(w.get("_page_height") or w.get("page_height") or 0) for w in page_words
    ]
    boxes = [box for word in page_words if (box := _word_box(word))]
    inferred_w = max((box["left"] + box["width"] for box in boxes), default=1)
    inferred_h = max((box["top"] + box["height"] for box in boxes), default=1)
    # 渲染器附带的逐页尺寸是 SSOT；显式参数只给旧调用方/独立测试兜底。
    width = int(max(explicit_w or [0]) or page_w or inferred_w)
    height = int(max(explicit_h or [0]) or page_h or inferred_h)
    return max(1, width), max(1, height)


def _clean_words(words: list[dict]) -> list[dict]:
    out = []
    for word in words or []:
        if str(word.get("source") or "").startswith("paddle_vl") or word.get("vl_tag"):
            continue
        if not str(word.get("text") or "").strip() or not _word_box(word):
            continue
        out.append(word)
    return out


def _union_bbox(
    words: list[dict], *, page_w: int, page_h: int, pad: int = 6
) -> dict[str, Any] | None:
    boxes = [box for word in words if (box := _word_box(word))]
    if not boxes:
        return None
    page = int(boxes[0]["page"])
    boxes = [box for box in boxes if int(box["page"]) == page]
    left = max(0, min(box["left"] for box in boxes) - pad)
    top = max(0, min(box["top"] for box in boxes) - pad)
    right = min(page_w, max(box["left"] + box["width"] for box in boxes) + pad)
    bottom = min(page_h, max(box["top"] + box["height"] for box in boxes) + pad)
    if right <= left or bottom <= top:
        return None
    return {
        "page": page,
        "left": int(left),
        "top": int(top),
        "width": int(right - left),
        "height": int(bottom - top),
        "role": "hit",
        "status": "ok",
        "label": "成分整段",
        "locate": "ingredient_anchor_block",
    }


def _line_text(words: list[dict]) -> str:
    return " ".join(str(word.get("text") or "").strip() for word in words).strip()


def _visual_lines(words: list[dict], *, page_w: int, page_h: int) -> list[dict]:
    """按 y 邻近且 x 连续聚成 OCR 行，避免把同高的左右栏合成一行。"""
    boxes = [box for word in words if (box := _word_box(word))]
    heights = [box["height"] for box in boxes if 4 <= box["height"] <= page_h]
    med_h = float(median(heights)) if heights else max(12.0, page_h * 0.01)
    y_tol = max(6.0, med_h * 0.62)
    x_gap = max(24.0, med_h * 5.0, page_w * 0.025)

    lines: list[dict] = []
    ordered = sorted(
        words,
        key=lambda word: (
            int(word.get("page") or 1),
            int((word.get("location") or {}).get("top") or 0),
            int((word.get("location") or {}).get("left") or 0),
        ),
    )
    for word in ordered:
        box = _word_box(word)
        if not box:
            continue
        center_y = box["top"] + box["height"] / 2
        chosen = None
        for line in reversed(lines[-12:]):
            if line["page"] != box["page"]:
                continue
            if abs(center_y - line["center_y"]) > y_tol:
                continue
            if (
                box["left"] > line["right"] + x_gap
                or box["left"] + box["width"] < line["left"] - x_gap
            ):
                continue
            chosen = line
            break
        if chosen is None:
            lines.append(
                {
                    "page": box["page"],
                    "left": box["left"],
                    "top": box["top"],
                    "right": box["left"] + box["width"],
                    "bottom": box["top"] + box["height"],
                    "center_y": center_y,
                    "words": [word],
                }
            )
        else:
            chosen["words"].append(word)
            chosen["left"] = min(chosen["left"], box["left"])
            chosen["top"] = min(chosen["top"], box["top"])
            chosen["right"] = max(chosen["right"], box["left"] + box["width"])
            chosen["bottom"] = max(chosen["bottom"], box["top"] + box["height"])
            chosen["center_y"] = (chosen["top"] + chosen["bottom"]) / 2

    for line in lines:
        line["words"].sort(key=lambda word: int((word.get("location") or {}).get("left") or 0))
        line["text"] = _line_text(line["words"])
        line["width"] = line["right"] - line["left"]
        line["height"] = line["bottom"] - line["top"]
    return sorted(lines, key=lambda line: (line["page"], line["top"], line["left"]))


def _anchor_strength(text: str) -> int:
    if _ENGINEERING_RE.search(text or ""):
        return 0
    compact_space = re.sub(r"\s+", "", text or "")
    if re.search(r"(?:^|[^\u4e00-\u9fff])其他微量成分[:：]", compact_space):
        return 5
    if re.search(r"(?:^|[^\u4e00-\u9fff])(?:全成分|成分)[:：]", compact_space):
        return 6
    if _ANCHOR_RE.search(text or ""):
        return 5
    if _WEAK_ANCHOR_RE.search(text or ""):
        return 2
    return 0


def _same_column(first: dict, second: dict, page_w: int) -> bool:
    overlap = min(first["right"], second["right"]) - max(first["left"], second["left"])
    min_width = max(1.0, min(first["width"], second["width"]))
    if overlap > 0 and overlap / min_width >= 0.08:
        return True
    return abs(first["left"] - second["left"]) <= max(
        48.0, page_w * 0.065
    )


def _section_context(text: str) -> str | None:
    """提取步骤/介质上下文，供拆分后的成分字段隔离 OCR 证据。"""
    step = _STEP_CONTEXT_RE.search(text or "")
    if step:
        return f"step:{int(step.group(1) or step.group(2))}"
    medium = _MEDIUM_CONTEXT_RE.search(text or "")
    if medium:
        return f"medium:{medium.group(1)}"
    return None


def _annotate_section_contexts(lines: list[dict], *, page_w: int) -> None:
    """让同栏的成分行继承最近步骤标题，不把另一栏标题串进来。"""
    markers: list[dict] = []
    for line in lines:
        explicit = _section_context(line.get("text") or "")
        line["_explicit_context"] = explicit
        if explicit:
            line["_section_context"] = explicit
            markers.append(line)
            continue
        line["_section_context"] = None
        for marker in reversed(markers):
            if marker["page"] != line["page"]:
                continue
            if marker["top"] > line["top"]:
                continue
            if _same_column(marker, line, page_w):
                line["_section_context"] = marker["_section_context"]
                break


def _expand_from_anchor(
    anchor: dict,
    lines: list[dict],
    *,
    page_w: int,
    page_h: int,
    target_context: str | None = None,
) -> list[dict]:
    page_lines = [line for line in lines if line["page"] == anchor["page"]]
    med_h = float(median([line["height"] for line in page_lines])) if page_lines else 20.0
    max_gap = max(med_h * 3.4, page_h * 0.035)
    max_bottom = min(page_h, anchor["top"] + max(page_h * 0.36, med_h * 24))
    accepted = [anchor]
    last_bottom = anchor["bottom"]

    for line in page_lines:
        if line is anchor or line["top"] < anchor["top"] - med_h:
            continue
        if line["top"] > max_bottom:
            break
        if line["top"] - last_bottom > max_gap:
            break
        if not any(_same_column(existing, line, page_w) for existing in accepted[-3:]):
            continue
        text = line.get("text") or ""
        explicit_context = line.get("_explicit_context")
        anchor_context = anchor.get("_section_context")
        if line is not anchor and explicit_context:
            if target_context and explicit_context != target_context:
                break
            if not target_context and explicit_context != anchor_context:
                break
        if target_context and line.get("_section_context") not in (
            None,
            target_context,
        ):
            break
        if _ENGINEERING_RE.search(text) or _CONTENT_STOP_RE.search(text):
            break
        accepted.append(line)
        last_bottom = max(last_bottom, line["bottom"])
    return accepted


def _segments(lines: list[dict], atoms: list[str]) -> list[dict]:
    out: list[dict] = []
    for line_index, line in enumerate(lines):
        for unit_index, raw in enumerate(
            _split_ingredient_units(
                line.get("text") or "", allow_ocr_locant_confusion=True
            )
        ):
            text = _SECTION_LABEL_RE.sub("", raw).strip(" \t，,；;。|")
            text = _STEP_PREFIX_RE.sub("", text).strip()
            if not text or _ENGINEERING_RE.search(text):
                continue
            out.append(
                {
                    "text": text,
                    "line_index": line_index,
                    "page": line["page"],
                    "words": line["words"],
                    # 同一物理 OCR 片段只能证明一个原子；跨行拼接候选会继承
                    # 两侧来源，不能再让原片段重复证明另一个成分。
                    "source_keys": frozenset({(line_index, unit_index)}),
                }
            )
    # OCR 视觉换行不一定是成分分隔符。保留原段的同时，只为“跨行拼接后
    # 确实能命中某个 Excel 原子”的边界增加候选，避免把普通相邻成分合并。
    joined: list[dict] = []
    for left, right in zip(out, out[1:]):
        if right["line_index"] != left["line_index"] + 1:
            continue
        left_line = str(lines[left["line_index"]].get("text") or "")
        right_line = str(lines[right["line_index"]].get("text") or "")
        if re.search(r"[、,，;；]\s*$", left_line) or re.match(
            r"\s*[、,，;；]", right_line
        ):
            continue
        combined = left["text"] + right["text"]
        if not any(_match_score(atom, combined)[0] > 0 for atom in atoms):
            continue
        joined.append(
            {
                **left,
                "text": combined,
                "words": left["words"] + right["words"],
                "source_keys": left["source_keys"] | right["source_keys"],
            }
        )
    return out + joined


def _atom_variants(atom: str) -> list[str]:
    compact = _compact(atom)
    return [compact] if compact else []


def _match_score(atom: str, segment: str) -> tuple[float, str]:
    atom_variants = _atom_variants(atom)
    target = _compact(segment)
    if not atom_variants or not target:
        return 0.0, "none"
    primary_len = len(atom_variants[0])

    best = 0.0
    mode = "none"
    for variant in atom_variants:
        if variant == target:
            score = 100.0 if variant == atom_variants[0] else 94.0
            if score > best:
                best, mode = score, "exact" if score == 100.0 else "semantic_variant"
            continue
        # 短/中等名称必须完整一致；“透明质酸”与“透明质酸钠”、带额外
        # 修饰前缀的原料都不是 OCR 小误差。长名称只容忍等长字符替换，
        # 标点、空白和括号本来已由 _compact 消除。
        if primary_len < 8 or len(variant) != len(target):
            continue
        distance = int(Levenshtein.distance(variant, target))
        max_edits = 2 if len(variant) >= 20 else 1
        if distance <= max_edits:
            ratio = 100.0 * (1.0 - distance / max(1, len(variant)))
            if ratio > best:
                best, mode = ratio, "edit_distance"
    return best, mode


def _reference_summary(atom: str) -> dict[str, Any] | None:
    """返回审计所需的最小监管引用；加载失败不影响直接 OCR 比对。"""
    try:
        record = lookup_ingredient_reference(atom)
    except (OSError, ValueError):
        return None
    if not record:
        return None
    source = record.get("source") or {}
    return {
        "id": record.get("id"),
        "canonical_zh": record.get("canonical_zh"),
        "inci": record.get("inci"),
        "cas": list(record.get("cas") or []),
        "regulatory_status": record.get("regulatory_status"),
        "source_record": record.get("source_record"),
        "source": {
            key: source.get(key)
            for key in ("id", "title", "url", "as_of")
            if source.get(key)
        },
        "note": record.get("note") or "",
    }


def _reference_metadata() -> dict[str, Any]:
    try:
        return ingredient_reference_metadata()
    except (OSError, ValueError):
        return {"available": False, "verdict_policy": "direct_ocr_evidence_only"}


def _reference_candidate(
    atom: str, segments: list[dict], used_sources: set[tuple[int, int]]
) -> dict | None:
    """找同一受控记录的强候选，但绝不把它计入 ``hit_atoms``。"""
    try:
        names = ingredient_reference_names(atom)
    except (OSError, ValueError):
        return None
    expected = _compact(atom)
    best: tuple[float, int, dict[str, str]] | None = None
    for name in names:
        reference = _compact(name["text"])
        if not reference or reference == expected:
            continue
        for segment_index, segment in enumerate(segments):
            if used_sources.intersection(segment["source_keys"]):
                continue
            target = _compact(segment["text"])
            if not target:
                continue
            if target == reference:
                score = 100.0
            elif len(reference) >= 8:
                score = float(fuzz.ratio(reference, target))
                if score < 92.0:
                    continue
            else:
                continue
            candidate = (score, segment_index, name)
            if best is None or candidate[0] > best[0]:
                best = candidate
    if best is None:
        return None

    score, segment_index, name = best
    segment = segments[segment_index]
    page_w, page_h = _page_size(segment["words"], int(segment["page"]), None, None)
    source_bbox = _union_bbox(segment["words"], page_w=page_w, page_h=page_h, pad=2)
    if source_bbox:
        source_bbox = {
            key: source_bbox[key]
            for key in ("page", "left", "top", "width", "height")
        }
    return {
        "matched_text": segment["text"][:160],
        "reference_name": name["text"],
        "reference_kind": name["kind"],
        "score": round(score, 1),
        "source_bbox": source_bbox,
        "verdict_effect": "none",
    }


def _match_atoms(atoms: list[str], lines: list[dict]) -> list[dict]:
    segments = _segments(lines, atoms)
    candidates: list[tuple[float, int, int, str]] = []
    for atom_index, atom in enumerate(atoms):
        for segment_index, segment in enumerate(segments):
            score, mode = _match_score(atom, segment["text"])
            if score > 0:
                candidates.append((score, atom_index, segment_index, mode))

    # 一份物理 OCR 证据只证明一个原子。优先完整长原子，避免跨行的
    # “柠檬酸钠”被其子串“柠檬酸”抢占来源片段。
    assigned_atoms: dict[int, tuple[float, int, str]] = {}
    used_sources: set[tuple[int, int]] = set()
    ordered_candidates = sorted(
        candidates,
        key=lambda item: (
            item[0],
            len(_compact(atoms[item[1]])),
            len(segments[item[2]]["source_keys"]),
        ),
        reverse=True,
    )
    for score, atom_index, segment_index, mode in ordered_candidates:
        source_keys = segments[segment_index]["source_keys"]
        if atom_index in assigned_atoms or used_sources.intersection(source_keys):
            continue
        assigned_atoms[atom_index] = (score, segment_index, mode)
        used_sources.update(source_keys)

    matches: list[dict] = []
    for atom_index, atom in enumerate(atoms):
        assigned = assigned_atoms.get(atom_index)
        reference = _reference_summary(atom)
        if not assigned:
            matches.append(
                {
                    "atom": atom,
                    "matched": False,
                    "score": 0.0,
                    "mode": "none",
                    "matched_text": "",
                    "source_bbox": None,
                    "reference": reference,
                    "reference_candidate": _reference_candidate(
                        atom, segments, used_sources
                    ),
                }
            )
            continue
        score, segment_index, mode = assigned
        segment = segments[segment_index]
        page_w, page_h = _page_size(segment["words"], int(segment["page"]), None, None)
        source_bbox = _union_bbox(
            segment["words"], page_w=page_w, page_h=page_h, pad=2
        )
        if source_bbox:
            source_bbox = {
                key: source_bbox[key]
                for key in ("page", "left", "top", "width", "height")
            }
        matches.append(
            {
                "atom": atom,
                "matched": True,
                "score": round(score, 1),
                "mode": mode,
                "matched_text": segment["text"][:160],
                # 百度 accurate 的坐标粒度是 OCR 行；不伪造行内字符框。
                "source_bbox": source_bbox,
                "reference": reference,
                "reference_candidate": None,
            }
        )
    return matches


def _candidate(
    candidate_lines: list[dict],
    atoms: list[str],
    *,
    page_w: int,
    page_h: int,
    strength: int,
) -> dict | None:
    if not candidate_lines:
        return None
    if any(_ENGINEERING_RE.search(line.get("text") or "") for line in candidate_lines):
        return None
    matches = _match_atoms(atoms, candidate_lines)
    matched = sum(1 for item in matches if item["matched"])
    if matched == 0:
        return None
    ratio = matched / max(1, len(atoms))
    # “成分表”这类无冒号弱标题可能出现在工程区。附近偶然出现一个“水”
    # 不能让它压制正文高密度回退；弱锚必须自己满足同一高密度门槛。
    if 0 < strength <= 2 and (matched < 3 or ratio < 0.2):
        return None
    words = [word for line in candidate_lines for word in line["words"]]
    bbox = _union_bbox(
        words,
        page_w=page_w,
        page_h=page_h,
        pad=max(4, round(median([line["height"] for line in candidate_lines]) * 0.22)),
    )
    if not bbox:
        return None
    block_text = "\n".join(line.get("text") or "" for line in candidate_lines)
    return {
        "lines": candidate_lines,
        "words": words,
        "matches": matches,
        "matched": matched,
        "ratio": ratio,
        "strength": strength,
        "bbox": bbox,
        "block_text": block_text,
    }


def _anchorless_candidates(
    lines: list[dict], atoms: list[str], *, page_w: int, page_h: int
) -> list[dict]:
    """锚点 OCR 丢失时只接受高密度原子块，不按页面方位猜测。"""
    out: list[dict] = []
    seed_lines: list[dict] = []
    for line in lines:
        if _ENGINEERING_RE.search(line.get("text") or ""):
            continue
        # 先对每行做一次轻量筛选，再只扩展有限数量的真实成分种子。
        # 这把最坏情况从“每行扩整块并全量匹配”降为有界窗口。
        line_segments = _segments([line], atoms)
        if not any(
            _match_score(atom, segment["text"])[0] > 0
            for atom in atoms
            for segment in line_segments
        ):
            continue
        seed_lines.append(line)
        if len(seed_lines) >= 16:
            break

    seen_windows: set[tuple] = set()
    for line in seed_lines:
        expanded = _expand_from_anchor(line, lines, page_w=page_w, page_h=page_h)
        window_key = tuple(
            (item["page"], item["left"], item["top"], item["right"], item["bottom"])
            for item in expanded
        )
        if window_key in seen_windows:
            continue
        seen_windows.add(window_key)
        candidate = _candidate(expanded, atoms, page_w=page_w, page_h=page_h, strength=0)
        if not candidate:
            continue
        # 至少三个完整原子，且覆盖率不低于 20%；否则宁可不框。
        if candidate["matched"] >= 3 and candidate["ratio"] >= 0.2:
            out.append(candidate)
    return out


def analyze_ingredient_field(
    excel_value: str,
    ocr_words: list[dict],
    *,
    page_w: int | None = None,
    page_h: int | None = None,
    target_context: str | None = None,
) -> dict[str, Any]:
    """返回成分原子、锚定文本块、逐项匹配与画布绝对坐标。"""
    atoms = parse_ingredient_atoms(excel_value)
    expected_context = target_context or _section_context(excel_value)
    words = _clean_words(ocr_words or [])
    empty = {
        "atoms": atoms,
        "reference_dataset": _reference_metadata(),
        "block_words": [],
        "block_text": "",
        "block_bbox": None,
        "anchor_point": None,
        "label_anchor": None,
        "matches": [
            {
                "atom": atom,
                "matched": False,
                "score": 0.0,
                "mode": "none",
                "matched_text": "",
                "source_bbox": None,
                "reference": _reference_summary(atom),
                "reference_candidate": None,
            }
            for atom in atoms
        ],
        "hit_atoms": [],
        "miss_atoms": list(atoms),
        "coverage": 0.0,
        "locate_mode": "none",
    }
    if not atoms or not words:
        return empty

    candidates: list[dict] = []
    pages = sorted({int(word.get("page") or 1) for word in words})
    for page in pages:
        current_words = [word for word in words if int(word.get("page") or 1) == page]
        width, height = _page_size(current_words, page, page_w, page_h)
        lines = _visual_lines(current_words, page_w=width, page_h=height)
        _annotate_section_contexts(lines, page_w=width)
        anchors = [
            line
            for line in lines
            if _anchor_strength(line.get("text") or "") > 0
            and (
                expected_context is None
                or line.get("_section_context") == expected_context
            )
        ]
        if expected_context:
            # 有些稿只印“步骤01：水、甘油”而省略“成分：”。明确的目标
            # 步骤仍可作为锚，但不能回退到别的步骤或无步骤区块。
            for line in lines:
                if line in anchors:
                    continue
                if line.get("_explicit_context") != expected_context:
                    continue
                if any(
                    item["matched"]
                    for item in _match_atoms(atoms, [line])
                ):
                    anchors.append(line)
        page_candidate_count = len(candidates)
        for anchor in anchors:
            strength = max(
                4 if expected_context else 0,
                _anchor_strength(anchor.get("text") or ""),
            )
            expanded = _expand_from_anchor(
                anchor,
                lines,
                page_w=width,
                page_h=height,
                target_context=expected_context,
            )
            candidate = _candidate(
                expanded, atoms, page_w=width, page_h=height, strength=strength
            )
            if candidate:
                candidate["page_w"] = width
                candidate["page_h"] = height
                candidate["anchor"] = anchor
                candidates.append(candidate)
        if expected_context is None and len(candidates) == page_candidate_count:
            for candidate in _anchorless_candidates(
                lines, atoms, page_w=width, page_h=height
            ):
                candidate["page_w"] = width
                candidate["page_h"] = height
                candidate["anchor"] = None
                candidates.append(candidate)

    if not candidates:
        return empty

    # 先看完整原子覆盖，再看明确锚点；最后偏好更小的真实块，避免巨框。
    best = max(
        candidates,
        key=lambda item: (
            item["matched"],
            item["ratio"],
            item["strength"],
            -(int(item["bbox"]["width"]) * int(item["bbox"]["height"])),
        ),
    )
    bbox = best["bbox"]
    center = {
        "page": int(bbox["page"]),
        "x": int(bbox["left"] + bbox["width"] / 2),
        "y": int(bbox["top"] + bbox["height"] / 2),
    }
    anchor = best.get("anchor")
    label_anchor = None
    if anchor:
        label_box = _union_bbox(
            anchor["words"],
            page_w=int(best["page_w"]),
            page_h=int(best["page_h"]),
            pad=2,
        )
        if label_box:
            label_anchor = {
                key: label_box[key]
                for key in ("page", "left", "top", "width", "height")
            }

    matches = best["matches"]
    hit_atoms = [item["atom"] for item in matches if item["matched"]]
    miss_atoms = [item["atom"] for item in matches if not item["matched"]]
    return {
        "atoms": atoms,
        "reference_dataset": _reference_metadata(),
        "block_words": best["words"],
        "block_text": best["block_text"],
        "block_bbox": bbox,
        "anchor_point": center,
        "label_anchor": label_anchor,
        "matches": matches,
        "hit_atoms": hit_atoms,
        "miss_atoms": miss_atoms,
        "coverage": len(hit_atoms) / max(1, len(atoms)),
        "locate_mode": "label_anchor" if anchor else "atom_dense_fallback",
    }
