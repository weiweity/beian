"""
装型画像（护肤品）

从标题 / 文件名 / OCR 净含量推断「当前只审哪一装」，
用于条码/净含量分支：花盒 5 片只要求 5 片码，单片码可忽略。
"""
from __future__ import annotations

import re
from typing import Any


def infer_pack_profile(
    *,
    title: str = "",
    filename: str = "",
    ocr_text: str = "",
    excel_net_content: str = "",
    excel_barcode: str = "",
) -> dict[str, Any]:
    blob = f"{title}\n{filename}\n{ocr_text[:2500]}\n{excel_net_content}"
    ocr = ocr_text or ""

    # 面/载体
    surface = "unknown"
    if re.search(r"花盒|彩盒|outer|carton|box", blob, re.I):
        surface = "carton"  # 花盒
    elif re.search(r"膜袋|袋装|sachet|pouch|铝箔", blob, re.I):
        surface = "pouch"  # 膜袋
    elif re.search(r"瓶贴|标签|label", blob, re.I):
        surface = "label"

    ml_m = re.findall(r"(\d+(?:\.\d+)?)\s*ml", blob, flags=re.I)
    piece_m = re.findall(r"(\d+)\s*片", blob)

    # —— 优先：包装上实际扫到的「片数条码」决定装型（比文案 ×5 更准）——
    by_p = parse_barcode_by_piece(excel_barcode or "")
    if not by_p:
        # 有时条码写在净含量旁，从 blob 再试
        by_p = parse_barcode_by_piece(excel_net_content + "\n" + blob)
    codes_on_pack: list[str] = []
    for m in re.finditer(r"\d{8,14}", ocr):
        codes_on_pack.append(m.group(0))
    piece_from_code: list[str] = []
    for piece, codes in by_p.items():
        if piece == "*":
            continue
        for c in codes:
            if c in ocr or any(c in x or x in c for x in codes_on_pack):
                piece_from_code.append(piece)
                break

    pack_pieces: list[str] = []
    if piece_from_code:
        # 包装上有哪边条码就以哪边为准（唯一真源，优先于文案 ×5）
        pack_pieces = list(dict.fromkeys(piece_from_code))
        # 膜袋上只扫到单片码 → 强制单片（即使文案带 ×5 规格说明）
        if surface == "pouch" and "1" in pack_pieces and "5" not in piece_from_code:
            pack_pieces = ["1"]
    else:
        # 文案提示：膜袋上的「/片×5」常是花盒规格文案，不能单独定装
        has_x5 = bool(re.search(r"[×xX]\s*5|5\s*片装|/片\s*[×xX]\s*5", ocr))
        has_single = bool(re.search(r"单片装|单片(?!装型)|1\s*片装", ocr))
        if has_single and not has_x5:
            pack_pieces.append("1")
        elif has_x5 and surface == "carton":
            pack_pieces.append("5")
        elif has_x5 and surface == "pouch" and not has_single:
            # 膜袋印了 ×5 字样但无 5 片码 → 仍倾向单片（字样是规格说明）
            pack_pieces.append("1")
        if re.search(r"5\s*片", title + filename) and "5" not in pack_pieces and surface != "pouch":
            pack_pieces.append("5")
        if re.search(r"单片|1\s*片|膜袋", title + filename) and "1" not in pack_pieces:
            pack_pieces.insert(0, "1")

    # 默认：花盒多 5 片；膜袋多单片
    if not pack_pieces:
        if surface == "carton":
            pack_pieces = ["5"]
        elif surface == "pouch":
            pack_pieces = ["1"]
        elif piece_m:
            from collections import Counter

            c = Counter(piece_m)
            pack_pieces = [c.most_common(1)[0][0]]

    # 膜袋强约束：除非包装上明确扫到 5 片条码，否则 active=1
    if surface == "pouch" and "5" in pack_pieces and "1" not in piece_from_code:
        if "5" not in piece_from_code:
            pack_pieces = ["1"] + [p for p in pack_pieces if p != "1"]

    active = pack_pieces[0] if pack_pieces else None
    profile = {
        "surface": surface,
        "surface_label": {
            "carton": "花盒",
            "pouch": "膜袋",
            "label": "瓶贴/标签",
            "unknown": "未识别",
        }.get(surface, "未识别"),
        "active_pieces": pack_pieces[:3],
        "active_piece": active,
        "ml_hints": ml_m[:6],
        "ignore_piece_codes": [],
        "codes_on_pack": list(dict.fromkeys(codes_on_pack))[:20],
        "piece_from_barcode": piece_from_code,
        "rules": [],
        "excel_net": excel_net_content or "",
        "excel_barcode": excel_barcode or "",
    }
    if active == "5":
        profile["ignore_piece_codes"] = ["1"]
        profile["rules"].append("画像：当前装型≈5片（条码/文案），单片码可不要求")
    elif active == "1":
        profile["ignore_piece_codes"] = ["5"]
        profile["rules"].append("画像：当前装型≈单片/1片（条码优先），5片码可不要求")
    if piece_from_code:
        profile["rules"].append(
            f"装型由包装条码推断：{','.join(piece_from_code)}片"
        )
    if surface == "carton":
        profile["rules"].append("载体：花盒 — 反向检查忽略工艺表底部")
    if surface == "pouch":
        profile["rules"].append("载体：膜袋 — 默认单片；版面紧，成分区优先")
    sku_ml = re.findall(r"(\d+(?:\.\d+)?)\s*ml\s*装", ocr, flags=re.I)
    sku_uniq = list(dict.fromkeys(sku_ml))
    if len(sku_uniq) == 1:
        profile["active_spec"] = f"{sku_uniq[0]}ml装"
        profile["rules"].append(f"规格键：包装上的 {profile['active_spec']}")
    elif active:
        profile["active_spec"] = str(active)
    else:
        profile["active_spec"] = None
    return profile


def parse_spec_keys(*, excel_net: str = "", excel_barcode: str = "") -> dict[str, list[str]]:
    """SKU 标签 → 码。5片/单片/30ml装 是键；(2ml+28ml) 配方数字不是键。"""
    blob = f"{excel_barcode or ''}\n{excel_net or ''}"
    out: dict[str, list[str]] = {}

    def _add(key: str, code: str) -> None:
        out.setdefault(key, [])
        if code not in out[key]:
            out[key].append(code)

    for m in re.finditer(r"(\d+(?:\.\d+)?)\s*ml\s*装\s*[:：]?\s*(\d{8,14})", blob, flags=re.I):
        _add(f"{m.group(1)}ml装", m.group(2))
    for m in re.finditer(r"(\d+)\s*片(?:装)?\s*[:：]?\s*(\d{8,14})", blob):
        _add(m.group(1), m.group(2))
    for m in re.finditer(r"单片(?:装)?\s*[:：]?\s*(\d{8,14})", blob):
        _add("1", m.group(1))
    if not out:
        bare = re.findall(r"\d{8,14}", excel_barcode or "")
        if bare:
            out["*"] = bare
    return out


def parse_barcode_by_piece(excel_barcode: str) -> dict[str, list[str]]:
    """5片：xxx / 1片：yyy / 单片：zzz → {5:[..], 1:[..]}"""
    out: dict[str, list[str]] = {}
    text = excel_barcode or ""
    for m in re.finditer(r"(\d+)\s*片(?:装)?\s*[:：]?\s*(\d{8,14})", text):
        out.setdefault(m.group(1), []).append(m.group(2))
    for m in re.finditer(r"单片(?:装)?\s*[:：]?\s*(\d{8,14})", text):
        out.setdefault("1", []).append(m.group(1))
    # 无前缀的裸码
    bare = re.findall(r"\d{8,14}", text)
    if bare and not out:
        out["*"] = bare
    return out


def required_barcodes(
    excel_barcode: str,
    profile: dict[str, Any],
    excel_net: str = "",
) -> tuple[list[str], list[str]]:
    """
    返回 (必须命中的码, 可忽略的码)。
    当前规格的码里命中一条即可；其它规格忽略。
    """
    net = excel_net or str((profile or {}).get("excel_net") or "")
    by_p = parse_spec_keys(excel_net=net, excel_barcode=excel_barcode)
    if not by_p:
        by_p = parse_barcode_by_piece(excel_barcode)
    if not by_p:
        return re.findall(r"\d{8,14}", excel_barcode or ""), []
    on_pack = [str(x) for x in (profile.get("codes_on_pack") or [])]
    if "*" in by_p:
        codes = by_p["*"]
        hit = [c for c in codes if c in on_pack]
        if hit:
            return hit, [c for c in codes if c not in hit]
        return codes, []
    active_spec = str(profile.get("active_spec") or "") or None
    active_pieces = {str(x) for x in (profile.get("active_pieces") or []) if x is not None}
    ignore_keys = {str(x) for x in (profile.get("ignore_piece_codes") or [])}

    def _pick(spec: str | None) -> tuple[list[str], list[str]]:
        must: list[str] = []
        ign: list[str] = []
        for key, codes in by_p.items():
            if spec:
                if key == spec:
                    must.extend(codes)
                else:
                    ign.extend(codes)
            elif active_pieces and key in active_pieces:
                must.extend(codes)
            elif key in ignore_keys or (active_pieces and key not in active_pieces):
                ign.extend(codes)
            else:
                must.extend(codes)
        return must, ign

    must, ign = _pick(active_spec)
    if not must and active_spec and (active_spec.endswith("ml装")):
        must, ign = _pick(None)
    if not must and by_p:
        # 规格对不上：不要用稿上已印的码自证当前装。
        all_codes: list[str] = []
        for codes in by_p.values():
            all_codes.extend(codes)
        return [], all_codes
    return must, ign
