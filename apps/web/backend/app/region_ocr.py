"""区内单引擎认字：活字不再 OCR；转曲/图只跑一次百度，禁止多引擎拼框。"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

OcrFn = Callable[[bytes], tuple[str, list[dict], dict]]


def recognize_pages(
    page_metas: list[dict],
    ingested: dict[str, Any] | None = None,
    *,
    ocr_fn: OcrFn | None = None,
) -> tuple[str, list[dict], str, dict]:
    ingested = ingested or {}
    page_modes = {
        int(p.get("page") or 0): p.get("mode") for p in (ingested.get("pages") or [])
    }
    doc_mode = ingested.get("mode")
    live_only = doc_mode == "live_text" or (
        page_modes and all(m == "live_text" for m in page_modes.values())
    )
    if live_only:
        return (
            "",
            [],
            "pdf_layer",
            {
                "skipped": True,
                "reason": "live_text",
                "union": False,
                "engines": ["pdf_layer"],
                "api": None,
            },
        )

    fn = ocr_fn or _baidu_accurate
    texts: list[str] = []
    all_words: list[dict] = []
    api_used = "accurate"
    prob_means: list[float] = []
    pages_ran = 0
    for meta in page_metas:
        page_n = int(meta.get("page") or 1)
        if page_modes.get(page_n) == "live_text":
            continue
        data = Path(meta["path"]).read_bytes()
        text, words, info = fn(data)
        pages_ran += 1
        api_used = info.get("api", api_used)
        if info.get("prob_mean") is not None:
            try:
                prob_means.append(float(info["prob_mean"]))
            except (TypeError, ValueError):
                pass
        pid_offset = (page_n - 1) * 1000
        for w in words:
            w = dict(w)
            w["page"] = page_n
            if w.get("paragraph_id") is not None:
                try:
                    w["paragraph_id"] = int(w["paragraph_id"]) + pid_offset
                except (TypeError, ValueError):
                    pass
            all_words.append(w)
        if text:
            texts.append(text)

    meta = {
        "skipped": False,
        "union": False,
        "engines": ["baidu:accurate"],
        "api": api_used,
        "pages_ran": pages_ran,
        "probability": bool(prob_means),
        "prob_mean": round(sum(prob_means) / len(prob_means), 4) if prob_means else None,
        "words": len(all_words),
        "zone_boost": {"pages": 0, "detail": []},
        "paddle_vl": {"enabled": False, "ok": False},
    }
    tag = f"baidu:{api_used}"
    return "\n\n".join(texts), all_words, tag, meta


def _baidu_accurate(data: bytes) -> tuple[str, list[dict], dict]:
    from app.baidu_ocr import ocr_image_bytes

    return ocr_image_bytes(data, with_location=True, paragraph=True)
