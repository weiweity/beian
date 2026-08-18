"""
多 OCR 交叉检查：提高双页文案对比置信度

策略（成本可控）：
1. 主路径：accurate（含位置）+ zone_boost + 可选 Paddle-VL（已有）
2. 辅路径：general 再跑一遍（不同模型/阈值，常能补漏/纠正）
3. 交叉：
   - 全文 token 覆盖率 → ocr_agreement
   - 未对上单元若在辅 OCR 全文中可软覆盖 → 降为「OCR 假未对上·可忽略」
   - 字差命中若辅 OCR 与主 OCR 对侧一致 → 标 low_ocr_conf，提示人审优先看图

不替代主比对，只加置信度层。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from rapidfuzz import fuzz

from app.fields import normalize


def run_secondary_ocr(
    page_metas: list[dict],
    *,
    api: str = "general",
) -> tuple[str, list[dict], dict]:
    """
    对已渲染页跑第二套 OCR（默认 general 含位置）。
    失败不抛：返回空文 + ok=False。
    """
    from app.baidu_ocr import ocr_image_bytes

    texts: list[str] = []
    words: list[dict] = []
    pages_meta: list[dict] = []
    try:
        for meta in page_metas:
            data = Path(meta["path"]).read_bytes()
            text, wds, info = ocr_image_bytes(
                data, api=api, with_location=True
            )
            page_n = int(meta.get("page") or 1)
            for w in wds:
                ww = dict(w)
                ww["page"] = page_n
                ww["ocr_source"] = f"secondary:{api}"
                words.append(ww)
            texts.append(text or "")
            pages_meta.append(
                {
                    "page": page_n,
                    "ok": True,
                    "api": info.get("api") or api,
                    "words": len(wds),
                    "text_len": len(text or ""),
                    "prob_mean": info.get("prob_mean"),
                }
            )
        full = "\n\n".join(texts)
        return full, words, {
            "ok": bool(full.strip()),
            "api": api,
            "pages": pages_meta,
            "text_len": len(full),
            "words": len(words),
        }
    except Exception as e:
        return "", [], {
            "ok": False,
            "api": api,
            "error": str(e)[:200],
            "pages": pages_meta,
        }


def agreement_score(text_primary: str, text_secondary: str) -> dict[str, Any]:
    """两套 OCR 全文一致性（0–100）。"""
    a = normalize(text_primary or "")
    b = normalize(text_secondary or "")
    if not a and not b:
        return {"score": 100.0, "token_set": 100.0, "ratio": 100.0, "note": "both_empty"}
    if not a or not b:
        return {
            "score": 0.0,
            "token_set": 0.0,
            "ratio": 0.0,
            "note": "one_empty",
            "len_a": len(a),
            "len_b": len(b),
        }
    ts = float(fuzz.token_set_ratio(a, b))
    pr = float(fuzz.partial_ratio(a, b))
    # 综合：token 为主，partial 防顺序/断行
    score = round(0.65 * ts + 0.35 * pr, 1)
    return {
        "score": score,
        "token_set": round(ts, 1),
        "partial": round(pr, 1),
        "len_a": len(a),
        "len_b": len(b),
        "note": "ok" if score >= 85 else ("mid" if score >= 70 else "low"),
    }


def phrase_in_secondary(
    phrase: str,
    secondary_text: str,
    *,
    min_soft: float = 82.0,
    min_hard: float = 72.0,
) -> dict[str, Any]:
    """
    主路径「未对上」单元是否在辅 OCR 全文中出现。
    出现 → 大概率 OCR 假未对上（切句/漏识），可降权。
    """
    p = (phrase or "").strip()
    sec = secondary_text or ""
    if not p or not sec:
        return {"found": False, "score": 0.0, "snippet": ""}
    from app.cross_spec import _best_snippet_in_text, _soft_cover_score, _is_truncation_same

    snip, soft = _best_snippet_in_text(p, sec)
    soft = max(soft, _soft_cover_score(p, sec))
    hard = float(fuzz.ratio(normalize(p), normalize(snip))) if snip else 0.0
    trunc = bool(snip and _is_truncation_same(p, snip))
    n_p, n_sec = normalize(p), normalize(sec)
    exact_sub = bool(n_p and n_p in n_sec)
    if exact_sub:
        soft = max(soft, 96.0)
        hard = max(hard, 96.0)
        if not snip:
            # 截取对侧出现位置作展示
            i = n_sec.find(n_p)
            snip = (sec or "")[max(0, i) : max(0, i) + len(p) + 8] or p
    found = bool(
        (snip or exact_sub)
        and len(n_p) >= 4
        and (
            (soft >= min_soft and hard >= min_hard)
            or trunc
            or exact_sub
        )
    )
    return {
        "found": found,
        "score": round(max(soft, hard), 1),
        "hard": round(hard, 1),
        "snippet": (snip or "")[:160],
        "truncation": trunc,
        "exact_sub": exact_sub,
    }


def apply_ensemble_to_hits(
    hits: list[dict],
    *,
    secondary_a: str,
    secondary_b: str,
    agreement_a: dict | None = None,
    agreement_b: dict | None = None,
) -> list[dict]:
    """
    对双页 hits 做交叉降噪：
    - unmatched：辅 OCR 对侧能找到 → 改为一致（OCR假未对上）或标 ocr_false_miss
    - issue 字差：辅 OCR 片段一致 → ocr_confidence=low，提示优先核 OCR
    """
    out: list[dict] = []
    rescued = 0
    low_conf = 0
    for h in hits:
        h = dict(h)
        cat = h.get("category")
        side = h.get("side") or "a"
        # 未对上：看对侧辅 OCR
        if cat == "unmatched" or (
            "未对上" in (h.get("field") or "") and h.get("status") == "疑点"
        ):
            phrase = h.get("excel_value") or ""
            # 仅 A 有 → 在 B 辅 OCR 找；仅 B 有 → 在 A 辅 OCR 找
            if side == "b":
                chk = phrase_in_secondary(phrase, secondary_a)
            else:
                chk = phrase_in_secondary(phrase, secondary_b)
            h["ocr_cross"] = chk
            if chk.get("found"):
                snip = chk.get("snippet") or ""
                # 必须严格可对齐才降为一致；缺「绒花精」等中文差 → 改字差
                from app.cross_spec import can_mark_aligned, _typo_labels, char_lcs_diff_spans

                if side == "b":
                    pa_txt, pb_txt = snip, phrase
                else:
                    pa_txt, pb_txt = phrase, snip
                ok_aln, why = can_mark_aligned(pa_txt, pb_txt)
                h["excel_value"] = f"A: {pa_txt[:160]}\nB: {pb_txt[:160]}"
                h["text_b"] = pb_txt
                h["decision"] = h.get("decision") or "pending"
                h["score"] = float(chk.get("score") or 85)
                h["ocr_cross"] = chk
                if ok_aln:
                    rescued += 1
                    h["status"] = "一致"
                    h["category"] = "aligned"
                    h["doubt_bucket"] = None
                    h["ocr_false_miss"] = True
                    h["ocr_confidence"] = "high"
                    fl = (h.get("field") or "已对齐").replace("未对上", "已对齐·OCR交叉")
                    fl = fl.replace(" · 需审核", "").replace("需审核", "")
                    h["field"] = fl
                    h["evidence"] = (
                        f"【多OCR交叉】对侧可见且严格同文({why}) · score={chk.get('score')}"
                    )
                else:
                    # 对侧有碎片但不等价 → 字差，禁止假一致
                    diff = char_lcs_diff_spans(pa_txt, pb_txt)
                    ma = list(diff.get("only_a") or [])[:8]
                    mb = list(diff.get("only_b") or [])[:8]
                    typo = _typo_labels(
                        [x for x in ma if x],
                        [x for x in mb if x],
                        label_a="面1",
                        label_b="面2",
                    )
                    h["status"] = "疑点"
                    h["category"] = "issue"
                    h["ocr_false_miss"] = False
                    h["ocr_confidence"] = "mid"
                    h["doubt_bucket"] = "typo"
                    fl = (h.get("field") or "").replace("未对上", "多/少/错字")
                    h["field"] = fl if "多/少/错字" in fl else "多/少/错字 · 需审核"
                    h["evidence"] = (
                        f"【需审核·字差·OCR交叉】{typo} · 辅识别见碎片但非严格同文"
                    )
                    h["sequence_diff"] = {
                        "only_in_excel": ma[:8],
                        "only_in_pack": mb[:8],
                        "typo_hint": typo,
                    }
            else:
                h["ocr_confidence"] = "mid"
                h.setdefault(
                    "evidence",
                    h.get("evidence") or "",
                )
                h["evidence"] = (
                    (h.get("evidence") or "")
                    + " · 辅OCR对侧仍未见（更可能真缺/改写）"
                )
        elif cat == "issue" or (
            "字符差异" in (h.get("field") or "") and h.get("status") == "疑点"
        ):
            # 字差：用辅 OCR 看 B 侧是否更接近 A（或反过来）
            raw = h.get("excel_value") or ""
            a_txt, b_txt = "", (h.get("text_b") or "")
            if "\nB:" in raw:
                parts = raw.split("\nB:", 1)
                a_txt = parts[0].replace("A:", "").strip()
                if not b_txt:
                    b_txt = parts[1].strip()
            # 若辅 B 更像主 A → 可能主 B OCR 错
            chk_b = phrase_in_secondary(a_txt, secondary_b) if a_txt else {"found": False}
            chk_a = phrase_in_secondary(b_txt, secondary_a) if b_txt else {"found": False}
            h["ocr_cross"] = {"a_in_sec_b": chk_b, "b_in_sec_a": chk_a}
            if chk_b.get("found") and float(chk_b.get("score") or 0) >= 88:
                low_conf += 1
                h["ocr_confidence"] = "low"
                h["evidence"] = (
                    (h.get("evidence") or "")
                    + f" · 【多OCR】辅B更像A(score={chk_b.get('score')})，优先核主B识字误差"
                )
            elif chk_a.get("found") and float(chk_a.get("score") or 0) >= 88:
                low_conf += 1
                h["ocr_confidence"] = "low"
                h["evidence"] = (
                    (h.get("evidence") or "")
                    + f" · 【多OCR】辅A更像B(score={chk_a.get('score')})，优先核主A识字误差"
                )
            else:
                h["ocr_confidence"] = "high"  # 两边引擎都支持字差
                h["evidence"] = (
                    (h.get("evidence") or "")
                    + " · 辅OCR亦见差（更可能真字差）"
                )
        elif cat == "aligned":
            h.setdefault("ocr_confidence", "high")
        out.append(h)

    # 刷新 overview / stats
    n_diff = sum(
        1
        for h in out
        if h.get("status") in ("疑点", "缺失")
        and (
            h.get("category") == "issue"
            or "字差" in (h.get("field") or "")
            or "字符差异" in (h.get("field") or "")
        )
    )
    n_miss = sum(
        1
        for h in out
        if h.get("status") in ("疑点", "缺失")
        and (
            h.get("category") == "unmatched"
            or "未对上" in (h.get("field") or "")
        )
    )
    n_ok = sum(1 for h in out if h.get("category") == "aligned")
    for h in out:
        if h.get("category") == "overview":
            st = "一致" if not n_diff and not n_miss else "疑点"
            h["status"] = st
            h["evidence"] = (
                (h.get("evidence") or "")
                + f" · 多OCR交叉：假未对上回收 {rescued} · 低置信字差 {low_conf}"
            )
            h["score"] = 100.0 - min(n_diff * 6 + n_miss * 8, 55)
            if agreement_a or agreement_b:
                aa = (agreement_a or {}).get("score")
                ab = (agreement_b or {}).get("score")
                bits = []
                if aa is not None:
                    bits.append(f"面1主辅一致{aa:.0f}")
                if ab is not None:
                    bits.append(f"面2主辅一致{ab:.0f}")
                if bits:
                    h["evidence"] += " · " + " · ".join(bits)
        if h.get("category") == "stats":
            h["excel_value"] = (
                f"一致={n_ok} · 字差={n_diff} · 未对上={n_miss} · "
                f"OCR交叉回收假未对上={rescued} · 低置信字差={low_conf}"
            )
            h["status"] = "疑点" if (n_diff or n_miss) else "一致"
            h["evidence"] = (
                (h.get("evidence") or "")
                + " · 辅OCR交叉：假未对上可控，真差/真未对上保留人审"
            )
    # 重新编号 #seq（阅读序键保留）
    content = [
        h
        for h in out
        if h.get("category")
        not in ("overview", "stats", "baidu_diff", "expected_diff")
    ]
    head = [h for h in out if h not in content]
    content.sort(
        key=lambda x: tuple(x.get("read_order_key") or [0, 0, 0, 0])
        + (x.get("id") or "",)
    )
    import re

    for seq, h in enumerate(content, 1):
        h["seq"] = seq
        fl = re.sub(r"^#\d+\s*·\s*", "", h.get("field") or "")
        h["field"] = f"#{seq} · " + fl
    return head + content
