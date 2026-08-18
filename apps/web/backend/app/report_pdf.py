"""审核报告 PDF（PyMuPDF 绘制，免额外依赖）"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pymupdf as fitz  # PyMuPDF


def _safe(s: Any, n: int = 200) -> str:
    t = str(s or "").replace("\r", " ").replace("\n", " ")
    return t if len(t) <= n else t[: n - 1] + "…"


def build_report_pdf(task: dict[str, Any], out_path: Path) -> Path:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)  # A4
    y = 40
    margin = 40
    width = 595 - margin * 2

    def ensure_space(need: float = 60) -> None:
        nonlocal page, y
        if y + need > 800:
            page = doc.new_page(width=595, height=842)
            y = 40

    def text(txt: str, size: float = 10, bold: bool = False, color=(0, 0, 0)) -> None:
        nonlocal y
        ensure_space(size + 8)
        font = "china-s"  # built-in CJK if available; fallback below
        try:
            page.insert_text(
                (margin, y),
                txt,
                fontsize=size,
                fontname=font,
                color=color,
            )
        except Exception:
            # 无中文字体时用 helv + 转义（可能缺字，但可出页）
            try:
                page.insert_text(
                    (margin, y),
                    txt,
                    fontsize=size,
                    fontname="helv",
                    color=color,
                )
            except Exception:
                page.insert_text((margin, y), txt.encode("ascii", "replace").decode(), fontsize=size)
        y += size + 6

    def para(txt: str, size: float = 9) -> None:
        nonlocal y
        # 简单换行
        line = ""
        max_chars = 48
        for ch in str(txt or ""):
            line += ch
            if len(line) >= max_chars or ch == "\n":
                text(line.replace("\n", ""), size=size)
                line = ""
        if line:
            text(line, size=size)

    s = task.get("summary") or {}
    is_dual = (
        task.get("product") == "dual_page_copy_compare"
        or task.get("ui_mode") == "text_compare"
        or task.get("type") in ("pdf_internal", "pdf_pdf")
    )
    text(
        "双页文案对比报告" if is_dual else "备案审核报告",
        size=16,
        bold=True,
    )
    text(f"任务：{_safe(task.get('title'), 80)}", size=11)
    if is_dual:
        text(
            f"产品：双页文案对比 · {_safe(task.get('label_a'), 30)} ↔ {_safe(task.get('label_b'), 30)}",
            size=9,
        )
    text(f"ID：{task.get('id')}  ·  类型：{task.get('type')}  ·  状态：{task.get('status')}", size=9)
    text(
        f"创建：{_safe(task.get('created_at'), 40)}  ·  归属：{_safe(task.get('owner') or task.get('created_by') or task.get('actor'), 30)}",
        size=9,
    )
    text(
        f"终审：{_safe(task.get('completed_by'), 20)}  ·  {_safe(task.get('completed_at'), 40)}",
        size=9,
    )
    text(
        f"汇总：一致 {s.get('一致', 0)} · 疑点 {s.get('疑点', 0)} · 缺失 {s.get('缺失', 0)} · 跳过 {s.get('跳过', 0)}",
        size=10,
    )
    if task.get("note"):
        para(f"说明：{task.get('note')}", size=9)
    if task.get("engine"):
        text(f"引擎：{_safe(task.get('engine'), 90)}", size=8, color=(0.3, 0.3, 0.3))
    y += 8
    text("字段明细", size=12, bold=True)

    hits = task.get("hits") or []
    for i, h in enumerate(hits):
        ensure_space(70)
        st = h.get("status") or ""
        color = (0.1, 0.4, 0.2) if st == "一致" else ((0.55, 0.35, 0) if st == "疑点" else (0.6, 0.1, 0.1))
        text(f"{i + 1}. [{st}] {_safe(h.get('field'), 50)}", size=10, color=color)
        text(
            f"   人审：{_safe(h.get('decision'), 20)}  ·  {_safe(h.get('decided_by'), 20)}  ·  score={h.get('score')}",
            size=8,
            color=(0.25, 0.25, 0.25),
        )
        if h.get("no_bbox") or (not (h.get("bboxes") or h.get("bboxes_b"))):
            text("   ※ 无图坐标 · 请对照文字 / 百度比对报告", size=8, color=(0.4, 0.4, 0.5))
        para(f"   证据：{_safe(h.get('evidence'), 160)}", size=8)
        if h.get("excel_value"):
            para(f"   内容：{_safe(h.get('excel_value'), 160)}", size=8)
        y += 4

    y += 10
    text("审计轨迹（最近 30 条）", size=12, bold=True)
    for a in (task.get("audit") or [])[-30:]:
        text(
            f"· {_safe(a.get('at'), 28)}  {_safe(a.get('actor'), 12)}  {_safe(a.get('action') or a.get('decision'), 20)}  {_safe(a.get('field') or a.get('hit_id'), 30)}",
            size=8,
            color=(0.2, 0.2, 0.2),
        )

    y += 16
    ensure_space(40)
    text("——", size=9)
    foot = (
        "本报告为「双页文案对比」产物，不依赖 Excel 确认单。AI/规则仅标疑点；"
        "人终审以「人审」为准；改稿可按 #序号 定位。"
        if is_dual
        else "本报告由备案审核工作台生成。AI 仅标疑点，人终审结论以「人审」为准。"
    )
    para(foot + (" " + str(task.get("disclaimer") or "")), size=8)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out_path))
    doc.close()
    return out_path
