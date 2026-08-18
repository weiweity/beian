"""
PDF 文字对比工作台：规则摘要 + 可选 AI 归纳

主路径是字差，不依赖图。
"""
from __future__ import annotations

from typing import Any


def build_rule_brief(task: dict[str, Any]) -> dict[str, Any]:
    """无模型：从 hits 归纳给人看的结构。"""
    hits = task.get("hits") or []
    label_a = task.get("label_a") or "页1"
    label_b = task.get("label_b") or "页2"
    overview = next((h for h in hits if h.get("category") == "overview"), None)
    stats = next((h for h in hits if h.get("category") == "stats"), None)
    char_diffs = [
        h
        for h in hits
        if h.get("category") == "issue"
        and (
            str(h.get("id") or "").startswith("lcs_")
            or "字符差异" in (h.get("field") or "")
            or "未完全对上" in (h.get("evidence") or "")
        )
    ]
    unmatched = [
        h
        for h in hits
        if h.get("category") == "unmatched"
        or "未对上" in (h.get("field") or "")
    ]
    face = [h for h in hits if h.get("category") == "face_split"]
    aligned = [h for h in hits if h.get("category") == "aligned"]
    issues = [h for h in hits if h.get("status") in ("疑点", "缺失")]

    bullets: list[str] = []
    if char_diffs:
        bullets.append(f"【需审核】{len(char_diffs)} 处配对后字面不一致（字差）。")
        for h in char_diffs[:4]:
            ev = (h.get("evidence") or "")[:120]
            if ev:
                bullets.append(ev)
    if unmatched:
        bullets.append(f"【需审核】{len(unmatched)} 处找不到对侧对应（未对上）。")
        for h in unmatched[:4]:
            tx = (h.get("excel_value") or h.get("field") or "")[:80]
            if tx:
                bullets.append(f"未对上：{tx}")
    if not char_diffs and not unmatched:
        bullets.append("严格 1:1 下未发现字差/未对上（或仅标点断行差异）。")
    if aligned:
        bullets.append(f"已严格对齐 {len(aligned)} 条。")
    if face:
        bullets.append(f"（旧）分面提示 {len(face)} 条。")

    verdict = "通过" if not issues else ("需人审" if issues else "通过")
    if issues and all(
        h.get("category") == "face_split" or h.get("status") == "一致" for h in hits
    ):
        verdict = "通过"

    return {
        "source": "rule",
        "verdict": "通过" if not [h for h in hits if h.get("status") in ("疑点", "缺失")] else "需人审",
        "headline": (overview or {}).get("evidence")
        or f"双页文案对比 · {label_a} ↔ {label_b}",
        "bullets": bullets,
        "char_diff_count": len(char_diffs),
        "face_split_count": len(face),
        "aligned_count": len(aligned),
        "issue_count": len([h for h in hits if h.get("status") in ("疑点", "缺失")]),
        "label_a": label_a,
        "label_b": label_b,
        "stats_line": (stats or {}).get("excel_value") or "",
        "char_diffs": [
            {
                "id": h.get("id"),
                "field": h.get("field"),
                "evidence": h.get("evidence"),
                "a": (h.get("excel_value") or "").split("\nB:")[0].replace("A:", "").strip()[:200],
                "b": (h.get("text_b") or "").strip()[:200]
                or (
                    (h.get("excel_value") or "").split("\nB:")[-1].strip()[:200]
                    if "\nB:" in (h.get("excel_value") or "")
                    else ""
                ),
                "diff_a": ((h.get("sequence_diff") or {}).get("only_in_excel") or [])[:6],
                "diff_b": ((h.get("sequence_diff") or {}).get("only_in_pack") or [])[:6],
            }
            for h in char_diffs[:12]
        ],
        "face_samples": [
            {
                "id": h.get("id"),
                "field": h.get("field"),
                "text": (h.get("excel_value") or "")[:160],
                "side": h.get("side"),
            }
            for h in face[:8]
        ],
    }


def summarize_with_ai(task: dict[str, Any]) -> dict[str, Any]:
    """
    MiniMax 归纳：给审核员一段可读结论，不改 hit 判定。
    失败时回退规则摘要。
    """
    from app import minimax

    brief = build_rule_brief(task)
    label_a = brief["label_a"]
    label_b = brief["label_b"]
    payload = {
        "title": task.get("title"),
        "type": task.get("type"),
        "label_a": label_a,
        "label_b": label_b,
        "rule_brief": brief,
        "ocr_a_snip": (task.get("ocr_text") or "")[:2500],
        "ocr_b_snip": (task.get("ocr_text_b") or "")[:2500],
        "hits_compact": [
            {
                "id": h.get("id"),
                "field": h.get("field"),
                "status": h.get("status"),
                "category": h.get("category"),
                "evidence": (h.get("evidence") or "")[:160],
                "excel_value": (h.get("excel_value") or "")[:200],
            }
            for h in (task.get("hits") or [])
            if h.get("category") in ("overview", "issue", "face_split", "aligned", "stats")
        ][:40],
    }
    system = (
        "你是化妆品包装「双页文案对比」助手（独立产品，不是确认单核对）。"
        "任务是 PDF 双页/双稿的文字一一对应：栏左→右阅读序。"
        "真字差/真未对上须标出；OCR 假未对上/软覆盖可忽略。"
        "人审可确认或标问题，改稿按 #序号。"
        "只根据给定 JSON 归纳，不要编造未出现的差异。"
        "输出严格 JSON："
        '{"verdict":"通过|需人审","summary":"80字内总述","bullets":["要点1","要点2"],'
        '"must_check":["必须人看的字差，无则空数组"],'
        '"ignore_ok":["可忽略的OCR噪声/假未对上说明"]}'
    )
    user = (
        "请归纳以下「双页文案对比」结果，给审核员一眼能懂的结论：\n"
        + __import__("json").dumps(payload, ensure_ascii=False)[:12000]
    )
    try:
        text, meta = minimax.chat(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.15,
            max_tokens=2048,
        )
        parsed = minimax._extract_json(text)  # noqa: SLF001
        if not isinstance(parsed, dict):
            raise RuntimeError("AI 未返回 JSON 对象")
        out = {
            **brief,
            "source": "ai",
            "verdict": parsed.get("verdict") or brief["verdict"],
            "headline": (parsed.get("summary") or brief["headline"])[:400],
            "bullets": list(parsed.get("bullets") or brief["bullets"])[:12],
            "must_check": list(parsed.get("must_check") or [])[:10],
            "ignore_ok": list(parsed.get("ignore_ok") or [])[:10],
            "model": (meta or {}).get("model"),
            "ai_raw_ok": True,
        }
        return out
    except Exception as e:
        return {
            **brief,
            "source": "rule_fallback",
            "ai_error": str(e)[:200],
        }
