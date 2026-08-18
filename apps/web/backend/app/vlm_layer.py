"""
VLM / 大模型第三层：漏字/错字确认。

1) crop + 二次 accurate OCR（真·图块确认）
2) MiniMax 文本复核（fallback）
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from app import minimax
from app.fields import normalize


def _crop_png(page_path: Path, box: dict, *, pad: int = 12) -> bytes | None:
    try:
        from PIL import Image
        import io

        im = Image.open(page_path)
        w, h = im.size
        l = max(0, int(box.get("left") or 0) - pad)
        t = max(0, int(box.get("top") or 0) - pad)
        r = min(w, int(box.get("left") or 0) + int(box.get("width") or 0) + pad)
        b = min(h, int(box.get("top") or 0) + int(box.get("height") or 0) + pad)
        if r - l < 8 or b - t < 8:
            return None
        crop = im.crop((l, t, r, b))
        buf = io.BytesIO()
        crop.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return None


def _page_path_for(task: dict, page: int) -> Path | None:
    """从 task.pages 或 uploads 推断页图路径。"""
    tid = task.get("id")
    if not tid:
        return None
    base = Path(__file__).resolve().parent.parent / "data" / "uploads" / tid
    # pages/page_01.png or pages/a/page_01.png
    for sub in ("pages", "pages/a", "pages/b"):
        p = base / sub / f"page_{int(page):02d}.png"
        if p.exists():
            return p
        # also page_1.png style
        p2 = base / sub / f"page_{int(page)}.png"
        if p2.exists():
            return p2
    # list dir fallback
    for sub in ("pages", "pages/a"):
        d = base / sub
        if d.is_dir():
            files = sorted(d.glob("*.png"))
            if files:
                idx = max(0, int(page) - 1)
                if idx < len(files):
                    return files[idx]
    return None


def crop_reocr_hits(
    hits: list[dict[str, Any]],
    *,
    task: dict[str, Any],
    max_items: int = 4,
) -> dict[str, Any]:
    """
    对有 bbox 且疑点/缺失的字段，裁块二次 OCR，看 miss 短语是否出现。
    返回 {reviews: [...], meta}
    """
    from app.baidu_ocr import ocr_image_bytes

    candidates = []
    for h in hits:
        if h.get("status") not in ("疑点", "缺失"):
            continue
        if h.get("field_group") == "二维码" or "二维码" in (h.get("field") or ""):
            continue
        boxes = h.get("bboxes") or []
        boxes_b = h.get("bboxes_b") or []
        # 仅黄框（疑点期望/字符差）做裁块，避免对整段大框浪费 OCR
        check_boxes = [
            b
            for b in (boxes + boxes_b)
            if b.get("role") in ("check", "miss_anchor")
        ]
        if not check_boxes and not boxes:
            continue
        miss = ((h.get("coverage") or {}).get("miss") or []) + (
            (h.get("sequence_diff") or {}).get("only_in_excel") or []
        ) + (
            (h.get("sequence_diff") or {}).get("only_in_pack") or []
        )
        # 字符差 LCS 也进候选
        if not miss and h.get("category") == "issue":
            miss = [h.get("excel_value") or h.get("field") or "差异"]
        if not miss and h.get("status") != "缺失" and not check_boxes:
            continue
        h = dict(h)
        if check_boxes:
            h["_crop_boxes"] = check_boxes
        candidates.append(h)
    candidates = candidates[:max_items]
    if not candidates:
        return {
            "reviews": [],
            "meta": {"skipped": True, "reason": "no_crop_candidates"},
            "layer": "crop_reocr",
        }

    reviews = []
    errors = []
    for h in candidates:
        page = int(h.get("page") or (h.get("bboxes") or [{}])[0].get("page") or 1)
        path = _page_path_for(task, page)
        if not path:
            errors.append(f"{h.get('id')}:no_page_image")
            continue
        # 优先黄框裁块
        box = (h.get("_crop_boxes") or h.get("bboxes") or h.get("bboxes_b") or [{}])[0]
        big = {
            "left": max(0, int(box.get("left") or 0) - 24),
            "top": max(0, int(box.get("top") or 0) - 24),
            "width": int(box.get("width") or 200) + 48,
            "height": int(box.get("height") or 80) + 48,
        }
        raw = _crop_png(path, big, pad=8)
        if not raw:
            errors.append(f"{h.get('id')}:crop_fail")
            continue
        try:
            text2, _words2, meta2 = ocr_image_bytes(raw, with_location=True)
        except Exception as e:
            errors.append(f"{h.get('id')}:{e}")
            continue
        n2 = normalize(text2 or "")
        miss = (h.get("coverage") or {}).get("miss") or []
        if not miss:
            miss = (h.get("sequence_diff") or {}).get("only_in_excel") or []
        found = []
        still = []
        for m in miss[:8]:
            nm = normalize(m)
            if len(nm) >= 3 and nm in n2:
                found.append(m)
            elif len(nm) >= 6 and any(
                nm[i : i + 6] in n2 for i in range(0, max(1, len(nm) - 5), 4)
            ):
                found.append(m)
            else:
                still.append(m)
        if found and len(found) >= max(1, len(miss[:8]) // 2):
            reviews.append(
                {
                    "id": h.get("id"),
                    "verdict": "一致",
                    "confidence": 0.75,
                    "reason": f"裁块二次OCR命中：{'、'.join(found[:3])[:80]}",
                    "suggested_decision": "confirm",
                    "crop_reocr": True,
                    "reocr_snippet": (text2 or "")[:200],
                    "api": (meta2 or {}).get("api"),
                }
            )
        elif still and not found:
            reviews.append(
                {
                    "id": h.get("id"),
                    "verdict": "疑点",
                    "confidence": 0.55,
                    "reason": f"裁块二次OCR仍未见：{'、'.join(still[:2])[:60]}",
                    "suggested_decision": "pending",
                    "crop_reocr": True,
                    "reocr_snippet": (text2 or "")[:200],
                }
            )
        else:
            reviews.append(
                {
                    "id": h.get("id"),
                    "verdict": "疑点",
                    "confidence": 0.6,
                    "reason": f"裁块部分命中{len(found)}/{len(found)+len(still)}，请人看图",
                    "suggested_decision": "pending",
                    "crop_reocr": True,
                    "reocr_snippet": (text2 or "")[:200],
                }
            )

    return {
        "reviews": reviews,
        "meta": {
            "candidates": len(candidates),
            "reviews": len(reviews),
            "errors": errors[:6],
        },
        "layer": "crop_reocr",
    }


def typo_confirm_hits(
    hits: list[dict[str, Any]],
    *,
    ocr_text: str,
    task_title: str = "",
    max_items: int = 6,
    task: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    对文案/品名/用法等「可能漏字」字段做第三层确认。
    优先 crop 二次 OCR，再 MiniMax 文本。
    """
    crop_part: dict[str, Any] = {"reviews": [], "meta": {}}
    if task:
        try:
            crop_part = crop_reocr_hits(hits, task=task, max_items=min(4, max_items))
        except Exception as e:
            crop_part = {"reviews": [], "meta": {"crop_error": str(e)}, "layer": "crop_reocr"}

    by_crop = {str(r.get("id")): r for r in crop_part.get("reviews") or []}
    # 二次 OCR 已 confirm 的不再进 LLM
    prefer = []
    for h in hits:
        fg = h.get("field_group") or ""
        st = h.get("status")
        field = h.get("field") or ""
        if fg == "二维码" or "二维码" in field:
            continue
        if st not in ("疑点", "缺失", "一致"):
            continue
        cid = str(h.get("id"))
        if by_crop.get(cid, {}).get("suggested_decision") == "confirm":
            continue
        if fg in ("文案", "中文品名", "使用方法") or "文案" in field:
            prefer.append(h)
        elif h.get("sequence_diff") and (h.get("sequence_diff") or {}).get("only_in_excel"):
            prefer.append(h)
    prefer = prefer[:max_items]

    llm_part: dict[str, Any] = {"reviews": [], "meta": {"skipped": True}}
    if prefer:
        slim = []
        for h in prefer:
            slim.append(
                {
                    **h,
                    "excel_value": (h.get("excel_value") or "")[:400],
                    "status": h.get("status") if h.get("status") != "一致" else "疑点",
                }
            )
        try:
            llm_part = minimax.review_hits(
                slim,
                ocr_text=(ocr_text or "")[:5000],
                task_title=task_title + " [第三层-漏字确认]",
                task_note=(
                    "只判断是否漏字/错字/缺词。"
                    "规格分支、OCR 形近（洽/治）用 pending。"
                    "确认漏字用 issue。"
                    "reason≤30字。每批只出 reviews JSON。"
                ),
                only_uncertain=True,
                batch_size=2,
                max_tokens=4096,
            )
        except Exception as e:
            llm_part = {"reviews": [], "meta": {"error": str(e)}}

    # 合并：crop 优先
    merged: dict[str, dict] = {}
    for r in llm_part.get("reviews") or []:
        merged[str(r.get("id"))] = r
    for r in crop_part.get("reviews") or []:
        rid = str(r.get("id"))
        if r.get("suggested_decision") == "confirm" or rid not in merged:
            merged[rid] = r
        elif rid in merged and r.get("crop_reocr"):
            # 附上 reocr 片段
            merged[rid] = {
                **merged[rid],
                "crop_reocr": True,
                "reocr_snippet": r.get("reocr_snippet"),
                "reason": (merged[rid].get("reason") or "")
                + " · "
                + (r.get("reason") or ""),
            }

    return {
        "reviews": list(merged.values()),
        "meta": {
            "crop": crop_part.get("meta"),
            "llm": llm_part.get("meta"),
            "merged": len(merged),
        },
        "layer": "vlm_typo+crop_reocr",
        "candidates": list(merged.keys()),
    }
