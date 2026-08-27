"""
Text Verification（确认单 → 包装）轻量引擎

行业 TVT 思路的可落地子集：
- 文字层优先，OCR 兜底
- 字段/段落覆盖 + 字符序列 diff
- 包装多余文案（反向）
- 引擎版本号（旧任务提示重建）
"""
from __future__ import annotations

import difflib
import re
from pathlib import Path
from typing import Any

import pymupdf

from app.fields import normalize, normalize_units

# 与前端 banner 对齐：低于此版本的 excel_pdf 任务提示「请重建」
ENGINE_VERSION = "tvt-lite-2.0"
ENGINE_FEATURES = [
    "excel_brief_ssot",
    "pdf_text_layer",
    "ocr_fallback",
    "ingredient_step_split",
    "block_bbox",
    "sequence_diff",
    "reverse_extra",
    "barcode_card",
    "skincare_branch_net_content",
    "honest_soft_field_status",
    "reverse_inci_noise_filter",
    "pdf_internal_face_split",
    "pack_profile",
    "layout_zones",
    "inci_normalize",
    "multi_surface",
    "seqdiff_full_excel_ssot",
    "phrase_anchor_coverage",
    "qr_guide_not_semantic",
    "ocr_probability",
    "zone_router",
    "qrcode_api_hardpath",
    "doubt_bucket",
    "dual_track_bbox",
    "phrase_span_locate",
    "expected_zone_miss",
    "adaptive_pad",
    "pack_phrase_coverage",
    "char_lcs_diff",
    "pdf_compare_high_dpi",
    "gold_eval",
    "phrase_soft_copy",
    "evidence_point_boxes",
    "ocr_glue_filter",
    "evidence_locate_v2",
    "evidence_locate_v3_profiles",
    "dual_page_copy_compare",
    "dual_page_report_wording",
    "baidu_ocr_paragraph",
    "layout_paragraph_cluster",
    "typo_strict_char_diff",
    "net_content_face_label",
    "ocr_mutual_truncation",
    "cross_zone_glue_filter",
    "dual_zone_roi_p1",
    "dual_zone_template_p2",
    "red_box_roi_grid",
    "side_by_side_same_boxes",
    "strict_align_rlen_085",
    "no_half_to_full_false_ok",
    "no_cn_tail_as_trunc",
    "hit_dedupe",
    "vertical_panel_cut",
    "pdf_ingest_classification",
    "page_source_routing",
    "live_text_no_ocr",
    "single_ocr_engine",
    "pack_layout_regions",
    "single_pin_evidence",
    "bilingual_name_pair",
]


def extract_pdf_text_layer(
    pdf_path: str | Path, *, max_pages: int = 3
) -> tuple[str, list[dict], bool]:
    """
    从 PDF 文字层抽文本 + 近似 bbox（PDF 坐标 → 后续与渲染缩放需对齐时用 OCR 框）。
    返回 (full_text, blocks[{text,page,left,top,width,height}], has_real_text)
    """
    doc = pymupdf.open(pdf_path)
    texts: list[str] = []
    blocks: list[dict] = []
    chars = 0
    try:
        for i, page in enumerate(doc):
            if i >= max_pages:
                break
            d = page.get_text("dict")
            page_h = float(page.rect.height)
            page_w = float(page.rect.width)
            for b in d.get("blocks") or []:
                if b.get("type") != 0:
                    continue
                for line in b.get("lines") or []:
                    line_text = ""
                    x0 = y0 = x1 = y1 = None
                    for sp in line.get("spans") or []:
                        t = (sp.get("text") or "").strip()
                        if not t:
                            continue
                        line_text += t
                        bb = sp.get("bbox") or [0, 0, 0, 0]
                        x0 = bb[0] if x0 is None else min(x0, bb[0])
                        y0 = bb[1] if y0 is None else min(y0, bb[1])
                        x1 = bb[2] if x1 is None else max(x1, bb[2])
                        y1 = bb[3] if y1 is None else max(y1, bb[3])
                    line_text = line_text.strip()
                    if not line_text or x0 is None:
                        continue
                    chars += len(line_text)
                    texts.append(line_text)
                    blocks.append(
                        {
                            "text": line_text,
                            "page": i + 1,
                            "left": float(x0),
                            "top": float(y0),
                            "width": float(x1 - x0),
                            "height": float(y1 - y0),
                            "source": "pdf_text",
                            "pdf_page_width": page_w,
                            "pdf_page_height": page_h,
                        }
                    )
    finally:
        doc.close()
    full = "\n".join(texts)
    has_real = chars >= 40
    return full, blocks, has_real


def map_pdf_blocks_to_pixels(
    blocks: list[dict], page_metas: list[dict]
) -> list[dict]:
    """PDF 点坐标 → 渲染 PNG 像素（整页渲染）。"""
    by_page = {int(m["page"]): m for m in page_metas}
    out = []
    for b in blocks:
        meta = by_page.get(int(b.get("page") or 1))
        if not meta:
            continue
        ph = float(b.get("pdf_page_height") or 0) or 1.0
        pw = float(b.get("pdf_page_width") or 0) or ph
        sx = float(meta["width"]) / pw if pw else 1.0
        sy = float(meta["height"]) / ph if ph else 1.0
        out.append(
            {
                "text": b.get("text") or "",
                "page": int(b.get("page") or 1),
                "left": int(float(b.get("left") or 0) * sx),
                "top": int(float(b.get("top") or 0) * sy),
                "width": max(2, int(float(b.get("width") or 0) * sx)),
                "height": max(2, int(float(b.get("height") or 0) * sy)),
                "source": "pdf_text_mapped",
            }
        )
    return out

def words_from_text_blocks(blocks: list[dict]) -> list[dict]:
    """把文字块变成 fields 匹配用的 ocr_words 结构"""
    words = []
    for b in blocks:
        words.append(
            {
                "text": b.get("text") or "",
                "page": int(b.get("page") or 1),
                "location": {
                    "left": int(b.get("left") or 0),
                    "top": int(b.get("top") or 0),
                    "width": int(b.get("width") or 0),
                    "height": int(b.get("height") or 0),
                },
            }
        )
    return words


def sequence_diff(
    excel_text: str,
    pack_text: str,
    *,
    excel_full: str | None = None,
    field_group: str = "",
    max_ops: int = 40,
) -> dict[str, Any]:
    """
    字符/词级序列 diff（归一化后）。
    only_in_excel / token_miss: 本字段 Excel 在包装未见（正向漏印）
    only_in_pack / token_extra: 包装有、确认单**全文**未见（反向）；默认用 excel_full 作 SSOT
    """
    a = normalize(excel_text or "")
    b = normalize(pack_text or "")
    full_src = excel_full if excel_full is not None else excel_text
    n_full = normalize(full_src or "")
    if not a and not b:
        return {
            "ratio": 1.0,
            "only_in_excel": [],
            "only_in_pack": [],
            "ops_sample": [],
            "token_miss": [],
            "token_extra": [],
        }
    sm = difflib.SequenceMatcher(a=a, b=b)
    only_e: list[str] = []
    only_p: list[str] = []
    ops = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        ea, pb = a[i1:i2], b[j1:j2]
        if tag in ("delete", "replace") and ea:
            only_e.append(ea[:80])
        if tag in ("insert", "replace") and pb:
            only_p.append(pb[:80])
        if len(ops) < max_ops:
            ops.append({"op": tag, "excel": ea[:60], "pack": pb[:60]})

    def toks(s: str) -> list[str]:
        return [t for t in re.split(r"[\s,，、;；:：。.!！?/|]+", s) if len(t) >= 2]

    def _in_norm_hay(needle: str, hay: str) -> bool:
        """子串或高 partial 命中（抗 OCR 断行/插字）"""
        if not needle or len(needle) < 3:
            return True
        if needle in hay:
            return True
        if len(needle) >= 8:
            # 关键锚点：≥4 字中文/数字块多数出现
            anchors = re.findall(r"[\u4e00-\u9fff0-9\-]{4,12}", needle)
            if anchors:
                hit = sum(1 for a0 in anchors if a0 in hay)
                if hit >= max(1, int(len(anchors) * 0.65)):
                    return True
            # 对半切
            mid = len(needle) // 2
            if needle[:mid] in hay and needle[mid:] in hay:
                return True
        return False

    ta, tb = set(toks(excel_text or "")), set(toks(pack_text or ""))
    na = {normalize(t): t for t in ta}
    nb = {normalize(t): t for t in tb}
    # 正向漏：字段 token 不在包装归一文中
    miss_tok = [
        na[k]
        for k in na
        if len(k) >= 3 and k not in nb and not _in_norm_hay(k, b)
    ][:20]

    # 反向多出：包装 token 不在**确认单全文**中（不是「不在本字段」）
    extra_raw = [
        nb[k]
        for k in nb
        if len(k) >= 3 and k not in na and not _in_norm_hay(k, n_full)
    ][:24]
    extra_tok: list[str] = []
    # 非成分字段：滤掉 INCI/警示/工艺噪声，避免串扰到文案/用法
    filter_inci = field_group not in ("成分表",)
    try:
        from app.phrase_soft import is_ocr_column_glue
    except Exception:
        def is_ocr_column_glue(_t: str) -> bool:  # type: ignore
            return False

    for t in extra_raw:
        if is_ocr_column_glue(t):
            continue  # 「柔嫩细腻使用方法:①…」跨列粘连，非真多出
        if _PACK_NOISE.search(t):
            continue
        if filter_inci and (_INCI_FRAG.search(t) or _looks_like_ocr_garbage(t)):
            continue
        # 警示/用法通用句：若全文 Excel 有「注意/贮存」相关则不算多出
        if re.search(
            r"清水冲净|专业医师|停止使用|阳光直射|耳后|入眼|肌肤损伤", t
        ):
            if any(
                k in n_full
                for k in ("冲净", "医师", "停止使用", "阳光", "耳后", "入眼", "损伤")
            ):
                continue
        extra_tok.append(t)
        if len(extra_tok) >= 12:
            break

    # 字符级 only_p 同样过滤
    only_p_f = []
    for p in only_p:
        if filter_inci and (_INCI_FRAG.search(p) or _looks_like_ocr_garbage(p)):
            continue
        if _PACK_NOISE.search(p):
            continue
        np = normalize(p)
        if np and _in_norm_hay(np[:40], n_full):
            continue
        only_p_f.append(p)

    only_e_f = []
    for e in only_e:
        ne = normalize(e)
        if ne and _in_norm_hay(ne[:48], b):
            continue
        only_e_f.append(e)

    return {
        "ratio": round(sm.ratio(), 4),
        "only_in_excel": (only_e_f[:8] + miss_tok)[:16],
        "only_in_pack": (only_p_f[:6] + extra_tok)[:16],
        "ops_sample": ops[:12],
        "token_miss": miss_tok[:12],
        "token_extra": extra_tok[:12],
    }


# 包装上常见「可忽略」噪声（反向检查白名单）
_PACK_NOISE = re.compile(
    r"(?:www\.|http|合格|请|扫码|关注|微信|电话|tel|fax|made\s*in|origin|"
    r"工艺|颜色|版本|垫白|逆向|亮银|材质|设计部|联系人|尺寸|包材|职责|品牌|"
    r"见稿件|打样|标样|更新内容|项目名称|ceo|ptc|设计师|三校|经理|"
    r"标准编号|批号|限期使用|执行标准|花盒-\d|26[A-Z]\d)",
    re.I,
)
# 护肤品成分碎片 / OCR 糊字：不应当「多余卖点」
_INCI_FRAG = re.compile(
    r"(?:提取物|甘油|丁二醇|烟酰胺|苯乙酮|苯乙|聚醚|肽|胶原|果油|果皮油|叶油|"
    r"共聚物|丙烯酸|氢化|卵磷脂|黄原胶|透明质酸|熊果苷|泛醇|角鲨烷|"
    r"玉米淀粉|水解玉米|琥珀酸|对羟基|羟基苯|"
    r"citrus|aurantium|bergamia|reticulata|leontopodium|gardenia|"
    r"peg|ppg|inci|centella|limon|graveolens|水、|、水)",
    re.I,
)


def _looks_like_ocr_garbage(s: str) -> bool:
    """OCR 断裂、乱码、过碎成分串"""
    t = (s or "").strip()
    if len(t) < 6:
        return True
    # 括号不成对 / 大量无空格英文糊成一团
    if t.count("(") != t.count(")"):
        return True
    if re.search(r"[A-Za-z]{20,}", t) and " " not in t[:30]:
        return True
    # 中英混杂且含典型 INCI 碎片
    if _INCI_FRAG.search(t) and len(t) < 80:
        return True
    # 连续标点或替换字符
    if re.search(r"[·•]{2,}|[^\w\u4e00-\u9fff\s,，、;；:：()（）/\-+%]{3,}", t):
        return True
    # 生产地址 OCR 糊句、半截英文口号粘连
    if re.search(r"上重|调机|环城|光泰|奉贤|钱塘|江东", t) and len(t) < 24:
        return True
    if re.search(r"25\s*\+?\s*bright", t, re.I):
        return True
    if re.search(r"cell\s*gr+|grrshula|softan", t, re.I):
        return True
    if re.match(r"^\*+[“\"']?", t) and len(t) < 12:
        return True
    return False


def reverse_extra_phrases(
    pack_text: str,
    excel_joined: str,
    *,
    min_len: int = 8,
    limit: int = 12,
) -> list[dict[str, Any]]:
    """
    包装有、确认单全文没有的短语（SKU 错印/多余卖点）。
    护肤品调优：过滤成分碎片、工艺表、OCR 噪声、净含量/条码/商标糊字，降低误报。
    """
    from rapidfuzz import fuzz

    n_excel = normalize(excel_joined or "")
    n_excel_u = normalize_units(excel_joined or "")
    # 确认单已有的条码 / 净含量数字，反向一律忽略
    excel_codes = set(re.findall(r"\d{8,14}", excel_joined or ""))
    extras: list[dict[str, Any]] = []
    seen: set[str] = set()
    raw = pack_text or ""
    parts: list[str] = []
    for ln in re.split(r"[\n\r]+", raw):
        ln = ln.strip()
        if not ln:
            continue
        if 8 <= len(ln) <= 48 and not _INCI_FRAG.search(ln):
            parts.append(ln)
        for p in re.split(r"[，,、；;|/]", ln):
            p = p.strip()
            if min_len <= len(p) <= 36:
                parts.append(p)
    for p in parts:
        n = normalize(p)
        if len(n) < min_len or n in seen:
            continue
        if _PACK_NOISE.search(p) or _looks_like_ocr_garbage(p):
            continue
        # —— 反向白名单：本属其它字段，不算「多出卖点」——
        if re.search(
            r"净含量|片\s*[×xX]|/片|精华液\s*\d|\d+\s*ml|面膜\s*\d|"
            r"单片装|5\s*片装|片装",
            p,
            re.I,
        ):
            continue
        if re.search(r"cell\s*gr+|grr?shula|cel\s*gr", p, re.I):
            continue  # 商标糊字 / 缺字，正向 logo 处理
        if re.search(r"\d{6,}", p):
            # 条码碎片或含条码
            digits = re.sub(r"\D", "", p)
            if any(c in digits or digits in c for c in excel_codes):
                continue
            if len(digits) >= 8:
                continue
        # OCR 公式/转义碎屑
        if re.search(r"[\\]{1,}|\"\d|ml\s*\\\)|\\\(|^\d+[\"']", p):
            continue
        if re.fullmatch(r"[\d\s\"'×xX/.ml片装:：()（）+\-]+", p, re.I):
            continue
        if n in n_excel or normalize(p) in n_excel_u:
            continue
        # 与 Excel 高相似（OCR 错 1–2 字）不算多余
        if float(fuzz.partial_ratio(n[:40], n_excel[:12000])) >= 82:
            continue
        if float(fuzz.partial_ratio(n[:40], n_excel_u[:12000])) >= 82:
            continue
        # 生产/批号
        if re.search(r"批号|执行标准|许可证|标准编号|见包装|检验合格|备案|生产企业", p):
            if float(fuzz.partial_ratio(n[:30], n_excel[:8000])) >= 65:
                continue
            continue  # 生产信息不当反向卖点
        is_claim = bool(
            re.search(
                r"^[·•\-*]|透亮|保湿|柔嫩|焕|抗|修护|敏感|无添加|天然|"
                r"涂·|敷·|光感|沁润|焕能",
                p,
            )
            or re.match(r"^[A-Z][A-Za-z\s\-]{6,40}$", p)
        )
        # 默认：没有卖点特征的短句不报
        if not is_claim:
            continue
        if re.search(r"25\s*\+|年龄", p) and "25" in n_excel:
            continue
        seen.add(n)
        extras.append(
            {
                "text": p[:120],
                "reason": "pack_claim_not_in_excel",
            }
        )
        if len(extras) >= limit:
            break
    return extras

def barcode_card(excel_value: str, pack_text: str, words: list[dict] | None = None) -> dict[str, Any]:
    """条码专用结果卡"""
    codes = re.findall(r"\d{8,14}", excel_value or "")
    n_pack = normalize(pack_text or "")
    items = []
    for c in codes:
        found = c in n_pack or c in (pack_text or "")
        boxes = []
        if words and found:
            for w in words:
                if c in (w.get("text") or ""):
                    loc = w.get("location") or {}
                    if loc.get("width"):
                        boxes.append(
                            {
                                "page": int(w.get("page") or 1),
                                "left": loc["left"],
                                "top": loc["top"],
                                "width": loc["width"],
                                "height": loc["height"],
                            }
                        )
        items.append(
            {
                "code": c,
                "found": found,
                "status": "一致" if found else "缺失",
                "bboxes": boxes[:3],
            }
        )
    all_ok = all(i["found"] for i in items) if items else False
    return {
        "codes": items,
        "total": len(items),
        "found": sum(1 for i in items if i["found"]),
        "status": "一致" if all_ok and items else ("缺失" if items else "跳过"),
        "summary": f"{sum(1 for i in items if i['found'])}/{len(items)} 个条码在包装上找到"
        if items
        else "无条码数字",
    }


def merge_text_sources(
    layer_text: str,
    ocr_text: str,
    layer_words: list[dict],
    ocr_words: list[dict],
    *,
    prefer_layer: bool,
) -> tuple[str, list[dict], str]:
    """合并文字层与 OCR；同页 OCR 优先，不同页保留各自权威词框。"""
    if prefer_layer and layer_text and len(normalize(layer_text)) >= 40:
        # OCR 只跑非活字页时，不能因为有 OCR 词就丢掉其他页的 PDF 文字框。
        # 同一页仍沿用 OCR 框优先，避免双源重复钉框。
        ocr_pages = {int(w.get("page") or 1) for w in ocr_words}
        layer_fallback = [
            w for w in layer_words if int(w.get("page") or 1) not in ocr_pages
        ]
        words = list(ocr_words) + layer_fallback if ocr_words else list(layer_words)
        text = layer_text
        layer_pages = {int(w.get("page") or 1) for w in layer_words}
        has_ocr_only_page = bool(ocr_pages - layer_pages)
        if ocr_text and (
            has_ocr_only_page
            or not ocr_words
            or len(ocr_text) > len(layer_text) * 0.5
        ):
            # 跨页双源必须拼接；同页仅在 OCR 信息量足够时增强召回。
            text = layer_text + "\n" + ocr_text
        return text, words, "pdf_text+ocr" if ocr_words else "pdf_text"
    return ocr_text or layer_text, ocr_words or layer_words, "ocr"
