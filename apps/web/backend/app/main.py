# 冻结：这不是产品 HTTP。38 条路由不要增加。
# 对外入口：apps/web/server :8787（Hono）。
# Worker：python -m app.cli。不要 uvicorn。
"""
备案审核工作台 · API M2.1
- 预置样本 + 任意上传
- 百度 accurate 含位置 → 图上高亮
- Session-only 身份（禁止 X-Actor 提权）
- 飞书个人推送（lark-cli，不是登录）
- 人终审
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import audit_log, auth, backup, baidu_docdiff, compare_core, config, feishu_oauth, feishu_push, minimax
from app import text_verify, vlm_layer
from app.baidu_ocr import ping_baidu
from app.cross_spec import compare_cross_spec
from app.fields import locate_text_in_ocr
from app.pdf_render import render_pdf_pages
from app.report_pdf import build_report_pdf
from app.report_summary import run_report_summary_job
from app.compare_core import (
    _apply_qrcode_to_hits,
    _ocr_pages,
    _page_urls,
    _qrcode_pages,
    _summary,
    _surface_job,
    clamp_max_pages,
    emit_stage,
    now_iso,
    run_excel_pdf_job,
)

APP_VERSION = "0.8.0"
ROOT = Path(__file__).resolve().parents[1]
TID_RE = compare_core.TID_RE
PAGE_NAME_RE = re.compile(r"^page_\d{2}\.png$")
DATA: Path
TASKS: Path
UPLOADS: Path
SAMPLES: Path
UI_DIST: Path
MAX_UPLOAD_MB: int


def init_paths(data_dir: Path | None = None) -> Path:
    """初始化遗留 HTTP 壳，并复用 worker 的数据目录规则。"""
    global DATA, TASKS, UPLOADS, SAMPLES, UI_DIST, MAX_UPLOAD_MB
    DATA = compare_core.init_paths(data_dir)
    TASKS = compare_core.TASKS
    UPLOADS = compare_core.UPLOADS
    samples = os.environ.get("WB_SAMPLES_DIR") or config.get("WB_SAMPLES_DIR")
    SAMPLES = Path(samples).expanduser() if samples else Path()
    UI_DIST = ROOT.parent / "ui" / "dist"
    try:
        MAX_UPLOAD_MB = int(os.environ.get("WB_MAX_UPLOAD_MB") or config.get("WB_MAX_UPLOAD_MB") or "200")
    except ValueError:
        MAX_UPLOAD_MB = 200
    auth.load_sessions(DATA)
    auth.ensure_users_file(DATA)
    return DATA


init_paths()

PRESETS = {
    "cleanse-excel-pdf": {
        "title": "洁面慕斯 · Excel↔正稿",
        "type": "excel_pdf",
        "excel": SAMPLES
        / "04-正错对照-评测用/洁面慕斯-正稿错稿/达肤妍臻研洁面慕斯 500g&30g 文案-更新.xlsx",
        "pdf": SAMPLES
        / "04-正错对照-评测用/洁面慕斯-正稿错稿/【正稿】转曲 D-达肤妍臻研洁面慕斯500ml内包标贴-26E26A.pdf",
    },
    "cleanse-pdf-pdf": {
        "title": "洁面慕斯 · 正稿 vs 错稿",
        "type": "pdf_pdf",
        "pdf_a": SAMPLES
        / "04-正错对照-评测用/洁面慕斯-正稿错稿/【正稿】转曲 D-达肤妍臻研洁面慕斯500ml内包标贴-26E26A.pdf",
        "pdf_b": SAMPLES
        / "04-正错对照-评测用/洁面慕斯-正稿错稿/【错稿】转曲 D-达肤妍臻研洁面慕斯500ml内包标贴-26D17A.pdf",
    },
    "hand-dual": {
        "title": "金盏漫落 · PDF 内双页",
        "type": "pdf_internal",
        "pdf": SAMPLES
        / "01-PDF内双图自检-净含量条码除外/达肤妍雪绒花润护护手霜（金盏漫落）-平面图.pdf",
    },
    "yiling-excel-box": {
        "title": "译龄 · Excel↔花盒",
        "type": "excel_pdf",
        "excel": SAMPLES / "03-Excel与包装图核对-未测/【备案文案】译龄光感焕能精华面膜(1).xlsx",
        "pdf": SAMPLES / "03-Excel与包装图核对-未测/转曲-C-译龄25+VC两部曲面膜-花盒-26G31A.pdf",
        "note": "装型画像默认 5 片花盒",
    },
    "yiling-excel-box-pouch": {
        "title": "译龄 · Excel↔花盒+膜袋（双面）",
        "type": "excel_pdf",
        "excel": SAMPLES / "03-Excel与包装图核对-未测/【备案文案】译龄光感焕能精华面膜(1).xlsx",
        "pdf": SAMPLES / "03-Excel与包装图核对-未测/转曲-C-译龄25+VC两部曲面膜-花盒-26G31A.pdf",
        "pdf_pouch": SAMPLES
        / "03-Excel与包装图核对-未测/转曲-C-译龄25+VC两部曲面膜-膜袋-26G30A.pdf",
        "note": "双面：花盒(5片) + 膜袋(单片) 分面审",
        "surface_a": "花盒",
        "surface_b": "膜袋",
    },
    "bubble-cross-spec": {
        "title": "泡泡面膜 · 30ml vs 95ml 跨规格",
        "type": "cross_spec",
        "pdf_a": SAMPLES
        / "02-跨规格文案对齐-不同净含量/转曲D-达肤妍(海绵宝宝联名）泡泡精华面膜-30ml-花盒-26G31A(第一批）.pdf",
        "pdf_b": SAMPLES
        / "02-跨规格文案对齐-不同净含量/转曲D-达肤妍（海绵宝宝联名）泡泡精华面膜95ml-花盒-26G31A(第一批）.pdf",
        "label_a": "30ml",
        "label_b": "95ml",
        "note": "净含量/条码预期可不同；其余文案应对齐",
    },
    "haiputao-report": {
        "title": "海葡萄精华水 · 检测报告功效摘要",
        "type": "report_summary",
        "pdf": SAMPLES
        / "05-检测报告生成摘要/28D+滋养 达肤妍海葡萄盈润保湿精华水（盖章版）.pdf",
        "note": "有文字层 · 结论约 44–49 页 · 生成 Word 摘要",
    },
}

app = FastAPI(title="备案审核工作台", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


class _SessionCookieMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if not request.headers.get("authorization"):
            tok = request.cookies.get("wb_session")
            if tok:
                request.scope["headers"] = list(request.scope.get("headers") or [])
                request.scope["headers"].append(
                    (b"authorization", f"Bearer {tok}".encode("ascii"))
                )
        return await call_next(request)


app.add_middleware(_SessionCookieMiddleware)

COOKIE_NAME = "wb_session"


def _set_session_cookie(resp: Response, token: str) -> None:
    resp.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        secure=feishu_oauth.cookie_secure(),
        max_age=auth.SESSION_TTL_SEC,
        path="/",
    )


def _clear_session_cookie(resp: Response) -> None:
    resp.delete_cookie(COOKIE_NAME, path="/")


def assert_tid(tid: str) -> str:
    if not TID_RE.fullmatch(tid or ""):
        raise HTTPException(400, "无效任务 id")
    return tid


def task_path(tid: str) -> Path:
    return TASKS / f"{assert_tid(tid)}.json"


def load_task(tid: str) -> dict[str, Any]:
    try:
        return compare_core.load_task(tid)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc


def save_task(task: dict[str, Any]) -> None:
    tid = assert_tid(str(task["id"]))
    p = task_path(tid)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{tid}.", suffix=".json", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(task, ensure_ascii=False, indent=2))
        os.replace(tmp, p)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def safe_upload_file(tid: str, *parts: str) -> Path:
    """uploads/{tid}/... 必须仍在该任务目录内。"""
    root = (UPLOADS / assert_tid(tid)).resolve()
    candidate = root.joinpath(*parts).resolve()
    if candidate != root and root not in candidate.parents:
        raise HTTPException(400, "非法路径")
    return candidate


def page_file(tid: str, name: str, side: str | None = None) -> Path:
    if not PAGE_NAME_RE.fullmatch(name or ""):
        raise HTTPException(400, "非法页图名")
    if side is not None:
        if side not in {"a", "b"}:
            raise HTTPException(400, "非法页图面")
        return safe_upload_file(tid, "pages", side, name)
    return safe_upload_file(tid, "pages", name)


def resolve_ctx(
    authorization: str | None = None,
    *,
    perm: str | None = None,
) -> dict:
    if authorization is not None and not isinstance(authorization, str):
        authorization = None
    if perm:
        return auth.require_perm(authorization, DATA, perm)
    return auth.session_context(authorization, DATA)


def _enrich_hits_with_ocr_boxes(
    hits: list[dict], words_a: list[dict], words_b: list[dict] | None = None
) -> list[dict]:
    """为无坐标的百度 diff / 缺失项用 OCR 词猜 bbox"""
    words_b = words_b or []
    for h in hits:
        if h.get("bboxes") or h.get("bboxes_b"):
            h["no_bbox"] = False
            continue
        text_a = h.get("text_a") or ""
        text_b = h.get("text_b") or ""
        # excel 字段：用 excel_value 猜
        if not text_a and h.get("excel_value") and h.get("category") != "baidu_diff":
            text_a = str(h.get("excel_value") or "")[:80]
        boxes = locate_text_in_ocr(text_a, words_a) if text_a else []
        boxes_b = locate_text_in_ocr(text_b, words_b) if text_b and words_b else []
        if boxes:
            h["bboxes"] = boxes
            h["page"] = boxes[0].get("page") or h.get("page") or 1
            h["bbox_source"] = "ocr_guess"
        if boxes_b:
            h["bboxes_b"] = boxes_b
            h["bbox_source"] = (h.get("bbox_source") or "") + "+ocr_guess_b"
        h["no_bbox"] = not bool(h.get("bboxes") or h.get("bboxes_b"))
        if h.get("no_bbox") and h.get("category") == "baidu_diff":
            h["ux_hint"] = h.get("ux_hint") or "open_baidu_report"
    return hits


def run_pdf_pdf_job(
    tid: str,
    pdf_a: Path,
    pdf_b: Path,
    max_pages: int,
    title: str,
    *,
    mode: str = "pdf_pdf",
    label_a: str = "A稿",
    label_b: str = "B稿",
    note: str | None = None,
    use_baidu_diff: bool = True,
) -> dict[str, Any]:
    """
    mode:
      - pdf_pdf: 正稿/错稿 — 优先百度文档比对，失败回退本地 OCR diff
      - cross_spec: 跨规格 — 百度比对 + 本地白名单过滤
    """
    tdir = UPLOADS / tid
    # 双 PDF 审稿用高清（小刀版 220dpi 只有 ~1000px，OCR 会碎）
    pa = render_pdf_pages(
        pdf_a, tdir / "pages" / "a", max_pages=max_pages, quality="compare"
    )
    pb = render_pdf_pages(
        pdf_b, tdir / "pages" / "b", max_pages=max_pages, quality="compare"
    )

    baidu_diff: dict[str, Any] | None = None
    baidu_err: str | None = None
    hits: list[dict] = []
    engines: list[str] = []

    if use_baidu_diff:
        try:
            baidu_diff = baidu_docdiff.compare_files(
                pdf_a, pdf_b, timeout_sec=150.0
            )
            if baidu_diff.get("ok") or baidu_diff.get("diffs") is not None:
                hits = baidu_docdiff.diffs_to_hits(
                    baidu_diff, label_a=label_a, label_b=label_b
                )
                engines.append("baidu:textdiff")
                # 跨规格：对百度 diff 做白名单弱化（净含量/条码类）
                if mode == "cross_spec":
                    hits = _filter_cross_spec_baidu_hits(hits)
            else:
                baidu_err = str(
                    baidu_diff.get("error_type")
                    or baidu_diff.get("status")
                    or "not ok"
                )
        except Exception as e:
            baidu_err = str(e)

    # 本地 OCR 兜底 / 补充；标签默认用文件名
    ta, wa, eng_a, _ma = _ocr_pages(pa)
    tb, wb, eng_b, _mb = _ocr_pages(pb)
    engines.append(f"{eng_a}/{eng_b}")
    if not label_a or label_a in ("A稿", "规格A", "页1"):
        label_a = Path(pdf_a).stem or label_a
    if not label_b or label_b in ("B稿", "规格B", "页2"):
        label_b = Path(pdf_b).stem or label_b
    local_hits = compare_cross_spec(
        wa,
        wb,
        ta,
        tb,
        label_a=label_a,
        label_b=label_b,
        mode="cross_spec" if mode == "cross_spec" else "pdf_pdf",
    )
    from rapidfuzz import fuzz
    from app.fields import normalize

    sim = float(fuzz.token_set_ratio(normalize(ta), normalize(tb)))

    if not hits:
        hits = local_hits
        if baidu_err:
            hits.insert(
                0,
                {
                    "id": "baidu_diff_fallback",
                    "field": "百度文档比对不可用 · 已回退本地对齐",
                    "excel_value": baidu_err[:300],
                    "status": "疑点",
                    "evidence": "请检查控制台是否开通「智能文档分析-文档比对」资源",
                    "score": 0.0,
                    "decision": "pending",
                    "bboxes": [],
                    "page": 1,
                    "category": "baidu_diff",
                    "no_bbox": True,
                    "ux_hint": "open_baidu_report",
                },
            )
    else:
        # 保留本地统计作为补充（非 issue 可省略刷屏）
        local_issues = [
            h for h in local_hits if h.get("category") == "issue"
        ][:8]
        for h in local_issues:
            h = dict(h)
            h["id"] = f"local_{h.get('id')}"
            h["field"] = f"[本地OCR] {h.get('field')}"
            hits.append(h)

    # OCR 猜坐标：改善「无坐标」体验
    hits = _enrich_hits_with_ocr_boxes(hits, wa, wb)

    from app import text_verify

    return {
        "id": tid,
        "title": title,
        "type": mode,
        "status": "pending_review",
        "created_at": now_iso(),
        "engine": " + ".join(engines),
        "engine_version": text_verify.ENGINE_VERSION,
        "engine_features": text_verify.ENGINE_FEATURES,
        "note": note,
        "label_a": label_a,
        "label_b": label_b,
        "disclaimer": (
            "AI 仅标疑点。跨规格：净含量/条码预期可不同；"
            "关键短语覆盖 + LCS 字符差；优先百度文档比对。"
        ),
        "pages": _page_urls(tid, pa, "a"),
        "pages_b": _page_urls(tid, pb, "b"),
        "hits": hits,
        "summary": _summary(hits),
        "similarity": (baidu_diff or {}).get("similarity") or sim,
        "render": {
            "quality": "compare",
            "dpi": (pa[0].get("dpi") if pa else None),
            "size_a": {"w": pa[0]["width"], "h": pa[0]["height"]} if pa else None,
            "size_b": {"w": pb[0]["width"], "h": pb[0]["height"]} if pb else None,
        },
        "baidu_diff": {
            "ok": (baidu_diff or {}).get("ok"),
            "task_id": (baidu_diff or {}).get("task_id"),
            "similarity": (baidu_diff or {}).get("similarity"),
            "total_diff": (baidu_diff or {}).get("total_diff"),
            "report_url": (baidu_diff or {}).get("report_url"),
            "sdk_url": (baidu_diff or {}).get("sdk_url"),
            "error": baidu_err,
        }
        if baidu_diff or baidu_err
        else None,
        "ocr_text": ta[:8000],
        "ocr_text_b": tb[:8000],
        "audit": [],
        "actor": "审核员",
    }


def _filter_cross_spec_baidu_hits(hits: list[dict]) -> list[dict]:
    """跨规格：净含量/条码/纯数字规格差异标为预期可不同（一致）"""
    import re

    vol = re.compile(
        r"\d+(?:\.\d+)?\s*(?:ml|mL|g|G|克|毫升)", re.I
    )
    barcode = re.compile(r"\d{12,14}")
    kw = ("净含量", "条码", "条形码", "规格")

    out = []
    for h in hits:
        if h.get("category") != "baidu_diff" or h.get("id") == "baidu_diff_overview":
            out.append(h)
            continue
        blob = f"{h.get('excel_value','')} {h.get('evidence','')} {h.get('field','')}"
        if any(k in blob for k in kw) or vol.search(blob) or barcode.search(blob):
            # 两边仅规格数字不同
            a = h.get("excel_value") or ""
            # 粗判：去掉数字后很像
            stripped = vol.sub("", a)
            stripped = barcode.sub("", stripped)
            h = dict(h)
            h["status"] = "一致"
            h["field"] = f"预期可不同 · {h.get('field')}"
            h["evidence"] = "跨规格白名单（净含量/条码/规格）· " + (
                h.get("evidence") or ""
            )
            h["category"] = "expected_diff"
        out.append(h)
    return out


def _apply_ocr_ensemble(
    hits: list[dict],
    pa: list[dict],
    pb: list[dict],
    ta: str,
    tb: str,
    meta_a: dict,
    meta_b: dict,
) -> tuple[list[dict], dict]:
    """
    多 OCR 交叉：general 辅识别 + 假未对上回收 + 字差置信度。
    失败不影响主结果。
    """
    from app import ocr_ensemble

    ensemble: dict[str, Any] = {"enabled": True, "ok": False}
    try:
        sec_a, _wa2, m2a = ocr_ensemble.run_secondary_ocr(pa, api="general") if pa else ("", [], {"ok": False})
        sec_b, _wb2, m2b = ocr_ensemble.run_secondary_ocr(pb, api="general") if pb else ("", [], {"ok": False})
        agr_a = ocr_ensemble.agreement_score(ta, sec_a) if sec_a else {"score": None}
        agr_b = ocr_ensemble.agreement_score(tb, sec_b) if sec_b else {"score": None}
        if sec_a or sec_b:
            hits = ocr_ensemble.apply_ensemble_to_hits(
                hits,
                secondary_a=sec_a,
                secondary_b=sec_b,
                agreement_a=agr_a,
                agreement_b=agr_b,
            )
        ensemble = {
            "enabled": True,
            "ok": bool(m2a.get("ok") or m2b.get("ok")),
            "api": "general",
            "a": {"secondary": m2a, "agreement": agr_a},
            "b": {"secondary": m2b, "agreement": agr_b},
            "rescued_false_miss": sum(
                1 for h in hits if h.get("ocr_false_miss")
            ),
            "low_conf_diff": sum(
                1 for h in hits if h.get("ocr_confidence") == "low"
            ),
        }
        if meta_a is not None:
            meta_a["ocr_ensemble"] = ensemble.get("a")
        if meta_b is not None:
            meta_b["ocr_ensemble"] = ensemble.get("b")
    except Exception as e:
        ensemble = {"enabled": True, "ok": False, "error": str(e)[:200]}
    return hits, ensemble


def _build_dual_page_task(
    *,
    tid: str,
    title: str,
    label_a: str,
    label_b: str,
    file_name_a: str,
    file_name_b: str,
    pa: list[dict],
    pb: list[dict],
    source_mode: str = "single_dual_pdf",
    prefer_net_content_labels: bool = False,
) -> dict[str, Any]:
    """
    双页文案对比共用构建：主 OCR → 严格 1:1 → 多 OCR 交叉 → 规则/AI 摘要。
    与 Excel 确认单路径完全独立。
    """
    from rapidfuzz import fuzz
    from app.fields import normalize
    from app import text_verify, text_compare_ui
    from app.cross_spec import detect_net_content_label

    ta, wa, eng_a, meta_a = _ocr_pages(pa) if pa else ("", [], "none", {})
    tb, wb, eng_b, meta_b = _ocr_pages(pb) if pb else ("", [], "none", {})
    for w in wa:
        w["page"] = 1
    for w in wb:
        w["page"] = 1

    # 列名：优先用页面净含量区分两面（如 artwork·75g / artwork·25g）
    if prefer_net_content_labels or (
        "面1" in (label_a or "") and "面2" in (label_b or "")
    ):
        vol_a = detect_net_content_label(ta)
        vol_b = detect_net_content_label(tb)
        stem = (label_a or "面").split("·")[0] or "包装"
        if vol_a and vol_b and vol_a != vol_b:
            label_a = f"{stem}·{vol_a}"
            label_b = f"{stem}·{vol_b}"
        elif vol_a and not vol_b:
            label_a = f"{stem}·{vol_a}"
        elif vol_b and not vol_a:
            label_b = f"{stem}·{vol_b}"

    # P1–P2：分区 ROI → 区内裁块 OCR → 区内 1:1；失败回退全页 1:1
    zone_pipeline: dict = {"mode": "fallback_fullpage", "ok": False}
    hits: list[dict] = []
    try:
        from app.dual_zone import compare_dual_page_by_zones

        img_a = pa[0]["path"] if pa else None
        img_b = pb[0]["path"] if pb else None
        pw_a = int((pa[0].get("width") if pa else 0) or 2000)
        ph_a = int((pa[0].get("height") if pa else 0) or 2800)
        pw_b = int((pb[0].get("width") if pb else 0) or 2000)
        ph_b = int((pb[0].get("height") if pb else 0) or 2800)
        hits, zone_pipeline = compare_dual_page_by_zones(
            image_a=img_a,
            image_b=img_b,
            words_a=wa,
            words_b=wb,
            text_a=ta,
            text_b=tb,
            label_a=label_a,
            label_b=label_b,
            page_w_a=pw_a,
            page_h_a=ph_a,
            page_w_b=pw_b,
            page_h_b=ph_b,
            do_crop_ocr=True,
        )
        zone_pipeline["ok"] = True
    except Exception as e:
        zone_pipeline = {
            "mode": "fallback_fullpage",
            "ok": False,
            "error": str(e)[:200],
        }
        hits = compare_cross_spec(
            wa, wb, ta, tb, label_a=label_a, label_b=label_b, mode="pdf_internal"
        )
        hits = _filter_cross_spec_baidu_hits(hits)

    hits, ensemble = _apply_ocr_ensemble(hits, pa, pb, ta, tb, meta_a, meta_b)
    # 终检：ensemble 后仍禁止假一致
    try:
        from app.cross_spec import filter_false_aligned_hits, dedupe_compare_hits

        hits = filter_false_aligned_hits(hits, label_a=label_a, label_b=label_b)
        hits = dedupe_compare_hits(hits)
    except Exception:
        pass

    sim = float(fuzz.token_set_ratio(normalize(ta), normalize(tb))) if tb else 0.0
    ov = next((h for h in hits if h.get("category") == "overview"), None)
    if ov and ov.get("score") is not None:
        sim = float(ov["score"])

    dpi_a = (pa[0].get("dpi") if pa else None) or "?"
    paddle_used = bool(
        (meta_a.get("paddle_vl") or {}).get("ok")
        or (meta_b.get("paddle_vl") or {}).get("ok")
    )
    layout_meta = (ov or {}).get("_layout_meta") or {}
    if ov and "_layout_meta" in ov:
        ov.pop("_layout_meta", None)
    compare_md = (ov or {}).get("compare_md") or layout_meta.get("markdown") or ""
    layout_blocks = (ov or {}).get("layout_blocks") or {
        "a": layout_meta.get("blocks_a") or [],
        "b": layout_meta.get("blocks_b") or [],
    }
    if layout_meta.get("zone_pipeline"):
        zone_pipeline = {**zone_pipeline, **(layout_meta.get("zone_pipeline") or {})}

    draft_task = {
        "title": title,
        "type": "pdf_internal",
        "product": "dual_page_copy_compare",
        "label_a": label_a,
        "label_b": label_b,
        "hits": hits,
        "ocr_text": ta,
        "ocr_text_b": tb,
    }
    text_brief = text_compare_ui.build_rule_brief(draft_task)
    try:
        if minimax.status().get("configured"):
            text_brief = text_compare_ui.summarize_with_ai(draft_task)
    except Exception:
        pass

    eng_tag = f"{eng_a} / {eng_b}"
    if zone_pipeline.get("ok"):
        eng_tag += "+red_box_roi"
    if ensemble.get("ok"):
        eng_tag += "+ocr_ensemble"

    return {
        "id": tid,
        "title": title,
        "type": "pdf_internal",
        "product": "dual_page_copy_compare",
        "product_label": "双页文案对比",
        "status": "pending_review",
        "created_at": now_iso(),
        "engine": eng_tag,
        "engine_version": text_verify.ENGINE_VERSION,
        "engine_features": text_verify.ENGINE_FEATURES,
        "label_a": label_a,
        "label_b": label_b,
        "file_name_a": file_name_a,
        "file_name_b": file_name_b,
        "source_mode": source_mode,
        "note": None,
        "ui_mode": "text_compare",
        "disclaimer": (
            "双页文案对比：两面并排同一套红框网格 → 框内裁块 OCR → "
            "框内多/少/错字 · 跨框不互比 · 人审点红框/#序号改稿 · "
            "列名优先净含量区分两面。"
        ),
        "red_boxes_a": zone_pipeline.get("red_boxes_a") or [],
        "red_boxes_b": zone_pipeline.get("red_boxes_b") or [],
        "pages": _page_urls(tid, pa, "a") if pa else [],
        "pages_b": _page_urls(tid, pb, "b") if pb else [],
        "hits": hits,
        "summary": _summary(hits),
        "text_compare_brief": text_brief,
        "layout_blocks": layout_blocks,
        "compare_md": compare_md,
        "zone_pipeline": zone_pipeline,
        "similarity": sim,
        "render": {
            "dpi": dpi_a,
            "quality": "compare",
            "pages_rendered": len(pa) + len(pb),
            "size_a": {"w": pa[0]["width"], "h": pa[0]["height"]} if pa else None,
            "size_b": {"w": pb[0]["width"], "h": pb[0]["height"]} if pb else None,
        },
        "ocr_meta": {
            "a": {
                k: meta_a.get(k)
                for k in (
                    "api",
                    "prob_mean",
                    "words",
                    "zone_boost",
                    "paddle_vl",
                    "ocr_ensemble",
                )
                if meta_a
            },
            "b": {
                k: meta_b.get(k)
                for k in (
                    "api",
                    "prob_mean",
                    "words",
                    "zone_boost",
                    "paddle_vl",
                    "ocr_ensemble",
                )
                if meta_b
            },
            "paddle_vl_used": paddle_used,
            "ensemble": ensemble,
            "dual_zone": {
                "ok": zone_pipeline.get("ok"),
                "mode": zone_pipeline.get("mode"),
                "zone_stats": zone_pipeline.get("zone_stats"),
            },
        },
        "ocr_text": ta[:12000],
        "ocr_text_b": tb[:12000],
        "audit": [],
        "actor": "审核员",
    }


def run_pdf_internal_job(tid: str, pdf: Path, title: str) -> dict[str, Any]:
    """
    双页文案对比 · 单 PDF 双页：拆 pages_a / pages_b。
    列名 = 文件名·面1 / 文件名·面2。
    """
    tdir = UPLOADS / tid
    page_metas_all = render_pdf_pages(
        pdf, tdir / "pages" / "_all", max_pages=2, quality="compare"
    )
    pa_dir = tdir / "pages" / "a"
    pb_dir = tdir / "pages" / "b"
    pa_dir.mkdir(parents=True, exist_ok=True)
    pb_dir.mkdir(parents=True, exist_ok=True)
    pa: list[dict] = []
    pb: list[dict] = []
    for m in page_metas_all:
        src = Path(m["path"])
        if m["page"] == 1:
            dest = pa_dir / "page_01.png"
            dest.write_bytes(src.read_bytes())
            pa.append({**m, "path": str(dest), "name": dest.name, "page": 1})
        else:
            dest = pb_dir / "page_01.png"
            dest.write_bytes(src.read_bytes())
            pb.append({**m, "path": str(dest), "name": dest.name, "page": 1})

    pdf_stem = Path(pdf).stem or "包装"
    return _build_dual_page_task(
        tid=tid,
        title=title,
        label_a=f"{pdf_stem}·面1",
        label_b=f"{pdf_stem}·面2",
        file_name_a=pdf.name,
        file_name_b=pdf.name,
        pa=pa,
        pb=pb,
        source_mode="single_dual_pdf",
        prefer_net_content_labels=True,
    )


def run_dual_pdf_compare_job(
    tid: str,
    pdf_a: Path,
    pdf_b: Path,
    title: str,
) -> dict[str, Any]:
    """
    双页文案对比 · 两个 PDF：各取首页，列名 = 各自文件名。
    算法与单 PDF 双页同一套 1:1 + 多 OCR 交叉。
    """
    tdir = UPLOADS / tid
    pa = render_pdf_pages(pdf_a, tdir / "pages" / "a", max_pages=1, quality="compare")
    pb = render_pdf_pages(pdf_b, tdir / "pages" / "b", max_pages=1, quality="compare")
    stem_a = Path(pdf_a).stem or "面A"
    stem_b = Path(pdf_b).stem or "面B"
    return _build_dual_page_task(
        tid=tid,
        title=title,
        label_a=stem_a,
        label_b=stem_b,
        file_name_a=pdf_a.name,
        file_name_b=pdf_b.name,
        pa=pa,
        pb=pb,
        source_mode="two_pdfs",
    )


# ── Auth ──────────────────────────────────────────────


class LoginBody(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=40)


@app.post("/api/auth/login")
def login(body: LoginBody):
    sess = auth.create_session(body.display_name, DATA)
    audit_log.append(
        DATA,
        action="login",
        actor=sess["display_name"],
        detail={"role": sess.get("role")},
    )
    return sess


@app.post("/api/auth/logout")
def logout(
    response: Response,
    authorization: str | None = Header(default=None),
):
    s = auth.get_session(authorization)
    actor = s["display_name"] if s else "匿名"
    auth.logout(authorization, DATA)
    audit_log.append(DATA, action="logout", actor=actor)
    _clear_session_cookie(response)
    return {"ok": True}


@app.get("/api/auth/me")
def me(authorization: str | None = Header(default=None)):
    s = auth.get_session(authorization)
    if not s:
        return {"logged_in": False, "display_name": None, "role": None, "perms": []}
    role = s.get("role") or auth.resolve_role(str(s["display_name"]), DATA)
    return {
        "logged_in": True,
        "display_name": s["display_name"],
        "role": role,
        "perms": sorted(auth.ROLE_PERMS.get(role, set())),
        "expires_at": s["expires_at"],
    }


@app.get("/api/auth/users")
def auth_users(authorization: str | None = Header(default=None)):
    """仅管理员可看用户表，避免枚举冒充。"""
    auth.require_perm(authorization, DATA, "manage_users")
    return {
        "users": auth.list_users(DATA),
        "require_known": True,
        "display_login": auth.display_login_allowed(),
    }


@app.get("/api/auth/methods")
def auth_methods():
    return {
        "feishu": feishu_oauth.oauth_ready(),
        "display_login": auth.display_login_allowed(),
        "login_url": "/api/auth/feishu/login",
        "public_base": feishu_oauth.public_base(),
    }


@app.get("/api/auth/feishu/login")
def feishu_login():
    if not feishu_oauth.app_id():
        raise HTTPException(500, "未配置 FEISHU_APP_ID")
    if not feishu_oauth.app_secret():
        raise HTTPException(503, "未配置 FEISHU_APP_SECRET（只放本机环境变量，不要提交）")
    return RedirectResponse(feishu_oauth.authorize_url(), status_code=302)


@app.get("/api/auth/feishu/callback")
def feishu_callback(code: str = "", state: str = "", error: str = ""):
    if error:
        return HTMLResponse(
            f"<p>飞书拒绝授权：{error}</p><p><a href='/api/auth/feishu/login'>重试</a></p>",
            status_code=400,
        )
    if not feishu_oauth.consume_state(state):
        return HTMLResponse(
            "<p>登录已过期或 state 无效。</p><p><a href='/api/auth/feishu/login'>重新用飞书进入</a></p>",
            status_code=400,
        )
    try:
        ident = feishu_oauth.exchange_code(code)
        sess = auth.session_from_feishu(ident["open_id"], ident["name"], DATA)
    except HTTPException as e:
        return HTMLResponse(
            "<p>未登录看不到任务和文件。</p>"
            f"<p>{e.detail}</p>"
            "<p><a href='/api/auth/feishu/login'>换一个飞书号</a></p>",
            status_code=e.status_code,
        )
    except Exception as e:
        return HTMLResponse(
            f"<p>飞书登录失败：{e}</p><p><a href='/api/auth/feishu/login'>重试</a></p>",
            status_code=400,
        )
    audit_log.append(
        DATA,
        action="login_feishu",
        actor=sess["display_name"],
        detail={"source": "feishu", "role": sess.get("role")},
    )
    dest = feishu_oauth.public_base().rstrip("/") + "/"
    resp = RedirectResponse(dest, status_code=302)
    _set_session_cookie(resp, sess["token"])
    return resp

# ── Health / audit ────────────────────────────────────


@app.get("/api/health")
def health():
    return {"ok": True, "version": APP_VERSION}


@app.get("/api/health/detail")
def health_detail(authorization: str | None = Header(default=None)):
    auth.require_perm(authorization, DATA, "manage_users")
    from app.baidu_paddle_vl import ping_paddle_vl

    baidu = ping_baidu()
    baidu.pop("token_prefix", None)
    return {
        "ok": True,
        "version": APP_VERSION,
        "data_dir": str(DATA),
        "baidu": {k: v for k, v in baidu.items() if k != "token_prefix"},
        "paddle_vl": ping_paddle_vl(),
        "minimax": minimax.status(),
        "feishu": {**feishu_push.push_status(), **feishu_oauth.status()},
        "tvt_lite": {
            "engine_version": text_verify.ENGINE_VERSION,
            "features": text_verify.ENGINE_FEATURES,
        },
        "display_login": auth.display_login_allowed(),
        "public": config.public_mode(),
    }


@app.get("/api/engine/tvt")
def engine_tvt_meta(authorization: str | None = Header(default=None)):
    """前端用来判断旧任务是否需要重建"""
    auth.require_perm(authorization, DATA, "read")
    return {
        "engine_version": text_verify.ENGINE_VERSION,
        "features": text_verify.ENGINE_FEATURES,
        "min_recommended": text_verify.ENGINE_VERSION,
    }


@app.get("/api/eval/gold")
def list_gold_cases(authorization: str | None = Header(default=None)):
    """列出金标集案例"""
    auth.require_perm(authorization, DATA, "read")
    from app import eval_gold

    cases = eval_gold.load_gold_cases()
    return {
        "count": len(cases),
        "cases": [
            {
                "id": c.get("id"),
                "title": c.get("title"),
                "task_id": c.get("task_id"),
                "fields": len(c.get("fields") or []),
            }
            for c in cases
        ],
    }


@app.post("/api/eval/run")
def run_gold_eval(
    authorization: str | None = Header(default=None),
    task_id: str | None = None,
):
    """
    对金标集跑指标（对照已存在任务 hits，不重跑 OCR）。
    若金标带 task_id 则加载该任务；可选 query task_id 只评一案。
    """
    auth.require_perm(authorization, DATA, "read")
    from app import eval_gold

    cases = eval_gold.load_gold_cases()
    if task_id:
        cases = [c for c in cases if c.get("task_id") == task_id or c.get("id") == task_id]
    reports = []
    for c in cases:
        tid = c.get("task_id")
        if not tid:
            reports.append(
                {
                    "case_id": c.get("id"),
                    "error": "gold missing task_id — bind to a reviewed task",
                }
            )
            continue
        try:
            task = load_task(str(tid))
        except Exception as e:
            reports.append({"case_id": c.get("id"), "error": str(e)})
            continue
        reports.append(eval_gold.evaluate_task_against_gold(c, task))
    ok_reports = [r for r in reports if "error" not in r]
    return {
        "aggregate": eval_gold.aggregate_reports(ok_reports),
        "reports": reports,
        "engine_version": text_verify.ENGINE_VERSION,
    }


@app.post("/api/tasks/{tid}/export-gold")
def export_task_gold(
    tid: str,
    authorization: str | None = Header(default=None),
):
    """从任务导出金标骨架到 data/gold/（需人工校对 expected_status）"""
    auth.require_perm(authorization, DATA, "create")
    from app import eval_gold

    task = load_task(tid)
    gold = eval_gold.export_gold_from_task(task)
    out = DATA / "gold" / f"export-{tid}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(gold, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "path": str(out), "fields": len(gold.get("fields") or [])}


@app.post("/api/tasks/{tid}/graphics-diff")
def task_graphics_diff(
    tid: str,
    authorization: str | None = Header(default=None),
):
    """P3：双 PDF 任务的像素 diff（A/B 首页）"""
    auth.require_perm(authorization, DATA, "read")
    task = load_task(tid)
    if not (task.get("pages") and task.get("pages_b")):
        raise HTTPException(400, "仅双稿任务支持图形 diff")
    from app.graphics_diff import compare_images

    pa = task["pages"][0]
    pb = task["pages_b"][0]
    # resolve local paths
    def _local(url: str, side: str | None = None) -> Path:
        # /api/tasks/{tid}/pages/a/page_01.png
        name = Path(url).name
        if side:
            return UPLOADS / tid / "pages" / side / name
        return UPLOADS / tid / "pages" / name

    path_a = _local(pa.get("url") or "", "a")
    path_b = _local(pb.get("url") or "", "b")
    if not path_a.exists():
        path_a = UPLOADS / tid / "pages" / "a" / (pa.get("name") or "page_01.png")
    if not path_b.exists():
        path_b = UPLOADS / tid / "pages" / "b" / (pb.get("name") or "page_01.png")
    if not path_a.exists() or not path_b.exists():
        raise HTTPException(404, "页面图不存在，请重建任务")
    out = UPLOADS / tid / "graphics_diff_ab.png"
    result = compare_images(path_a, path_b, out)
    result["preview_url"] = f"/api/tasks/{tid}/graphics-diff.png"
    task["graphics_diff"] = result
    save_task(task)
    return result


@app.get("/api/tasks/{tid}/graphics-diff.png")
def task_graphics_diff_png(tid: str, authorization: str | None = Header(default=None)):
    auth.require_perm(authorization, DATA, "read")
    p = safe_upload_file(tid, "graphics_diff_ab.png")
    if not p.exists():
        raise HTTPException(404, "请先 POST /graphics-diff")
    return FileResponse(p, media_type="image/png")


@app.post("/api/ops/backup")
def ops_backup(
    include_uploads: bool = False,
    authorization: str | None = Header(default=None),
):
    ctx = auth.require_perm(authorization, DATA, "backup")
    meta = backup.create_backup(DATA, include_uploads=include_uploads, keep=20)
    backup.write_manifest(DATA, meta)
    audit_log.append(
        DATA,
        action="backup",
        actor=ctx["name"],
        detail={"name": meta.get("name"), "size": meta.get("size"), "files": meta.get("files")},
    )
    return meta


@app.get("/api/ops/backups")
def ops_list_backups(authorization: str | None = Header(default=None)):
    auth.require_perm(authorization, DATA, "backup")
    return {"items": backup.list_backups(DATA)}


@app.get("/api/ops/backups/{name}")
def ops_download_backup(name: str, authorization: str | None = Header(default=None)):
    auth.require_perm(authorization, DATA, "backup")
    p = backup.backup_path(DATA, name)
    if not p:
        raise HTTPException(404, "备份不存在")
    return FileResponse(p, filename=name, media_type="application/gzip")


@app.get("/api/audit")
def get_audit(
    limit: int = 80,
    task_id: str | None = None,
    authorization: str | None = Header(default=None),
):
    auth.require_perm(authorization, DATA, "read")
    return audit_log.list_entries(DATA, limit=min(limit, 500), task_id=task_id)


@app.post("/api/feishu/test")
def feishu_test(authorization: str | None = Header(default=None)):
    ctx = auth.require_perm(authorization, DATA, "manage_users")
    actor = ctx["name"]
    r = feishu_push.send_text(
        f"【备案审核工作台】手动测试推送\n操作人：{actor}\n时间：{now_iso()}"
    )
    audit_log.append(DATA, action="feishu_test", actor=actor, detail=r)
    return r


# ── Tasks ─────────────────────────────────────────────


@app.get("/api/presets")
def list_presets(authorization: str | None = Header(default=None)):
    auth.require_perm(authorization, DATA, "read")
    if not SAMPLES or not SAMPLES.exists():
        return []
    return [
        {
            "id": k,
            "title": v["title"],
            "type": v["type"],
            "note": v.get("note"),
        }
        for k, v in PRESETS.items()
    ]


@app.get("/api/tasks")
def list_tasks(
    authorization: str | None = Header(default=None),
    mine: bool = False,
    q: str | None = None,
):
    ctx = auth.require_perm(authorization, DATA, "read")
    needle = (q or "").strip().lower()
    items = []
    for p in sorted(TASKS.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        t = json.loads(p.read_text(encoding="utf-8"))
        owner = t.get("owner") or t.get("created_by") or t.get("actor")
        if mine and ctx.get("name") and owner and owner != ctx["name"] and ctx.get("role") != "admin":
            continue
        product_name = str(t.get("product_name") or "")
        title = str(t.get("title") or "")
        if needle and needle not in f"{product_name} {title}".lower():
            continue
        items.append(
            {
                "id": t["id"],
                "title": title,
                "product_name": product_name,
                "type": t["type"],
                "status": t["status"],
                "created_at": t.get("created_at"),
                "summary": t.get("summary"),
                "actor": t.get("actor"),
                "owner": owner,
                "completed_by": t.get("completed_by"),
            }
        )
    open_rows = [x for x in items if x.get("status") != "completed"]
    done_rows = [x for x in items if x.get("status") == "completed"]
    open_rows.sort(key=lambda x: x.get("created_at") or "", reverse=True)
    done_rows.sort(key=lambda x: x.get("created_at") or "", reverse=True)
    return open_rows + done_rows


class CreateFromPreset(BaseModel):
    preset_id: str
    max_pages: int = 2
    actor: str = "审核员"
    notify: bool = True


@app.post("/api/tasks/from-preset")
def create_from_preset(
    body: CreateFromPreset,
    authorization: str | None = Header(default=None),
):
    if body.preset_id not in PRESETS:
        raise HTTPException(400, "未知 preset")
    if not SAMPLES or not SAMPLES.exists():
        raise HTTPException(412, "未配置 WB_SAMPLES_DIR，或样本目录不存在")
    ctx = auth.require_perm(
        authorization, DATA, "create"
    )
    actor = ctx["name"]
    preset = PRESETS[body.preset_id]
    tid = uuid.uuid4().hex[:12]
    tdir = UPLOADS / tid
    tdir.mkdir(parents=True, exist_ok=True)
    body.max_pages = clamp_max_pages(body.max_pages)
    try:
        if preset["type"] == "excel_pdf":
            excel = tdir / "source.xlsx"
            pdf = tdir / "artwork.pdf"
            if not Path(preset["excel"]).exists() or not Path(preset["pdf"]).exists():
                raise HTTPException(412, f"样本文件不存在：{preset['title']}")
            shutil.copy(preset["excel"], excel)
            shutil.copy(preset["pdf"], pdf)
            pouch_path = None
            if preset.get("pdf_pouch"):
                pouch_path = tdir / "artwork_pouch.pdf"
                shutil.copy(preset["pdf_pouch"], pouch_path)
            task = run_excel_pdf_job(
                tid,
                excel,
                pdf,
                body.max_pages,
                preset["title"],
                note=preset.get("note"),
                pdf_pouch=pouch_path,
                surface_a_label=preset.get("surface_a") or "花盒",
                surface_b_label=preset.get("surface_b") or "膜袋",
            )
        elif preset["type"] in ("pdf_pdf", "cross_spec"):
            a, b = tdir / "a.pdf", tdir / "b.pdf"
            shutil.copy(preset["pdf_a"], a)
            shutil.copy(preset["pdf_b"], b)
            task = run_pdf_pdf_job(
                tid,
                a,
                b,
                body.max_pages,
                preset["title"],
                mode=preset["type"],
                label_a=preset.get("label_a") or "A稿",
                label_b=preset.get("label_b") or "B稿",
                note=preset.get("note"),
            )
        elif preset["type"] == "report_summary":
            pdf = tdir / "report.pdf"
            shutil.copy(preset["pdf"], pdf)
            rs = run_report_summary_job(
                tid, pdf, tdir, title=preset["title"], use_ai=True
            )
            task = {
                "id": tid,
                "title": preset["title"],
                "type": "report_summary",
                "status": "pending_review",
                "created_at": now_iso(),
                "engine": rs["engine"],
                "note": preset.get("note"),
                "disclaimer": "摘要由报告结论页摘抄生成，须人核对原文。",
                "pages": rs.get("pages") or [],
                "hits": rs["hits"],
                "summary": rs["summary_counts"],
                "report_summary": {
                    k: v
                    for k, v in (rs.get("summary") or {}).items()
                    if not str(k).startswith("_")
                },
                "extract": rs.get("extract"),
                "docx_url": rs.get("docx_url"),
                "docx_name": rs.get("docx_name"),
                "ocr_text": rs.get("ocr_text"),
                "audit": [],
                "actor": actor,
            }
        else:
            pdf = tdir / "artwork.pdf"
            shutil.copy(preset["pdf"], pdf)
            task = run_pdf_internal_job(tid, pdf, preset["title"])
        task["actor"] = actor
        task["created_by"] = actor
        task["owner"] = actor
        task.setdefault("audit", []).append(
            {"at": now_iso(), "actor": actor, "action": "create", "via": "preset", "preset_id": body.preset_id}
        )
        save_task(task)
        audit_log.append(
            DATA,
            action="task_create",
            actor=actor,
            task_id=tid,
            detail={"via": "preset", "preset_id": body.preset_id, "summary": task.get("summary")},
        )
        if body.notify:
            fr = feishu_push.notify_task_created(task, actor)
            task["feishu_create"] = fr
            save_task(task)
            audit_log.append(DATA, action="feishu_notify", actor=actor, task_id=tid, detail=fr)
        return task
    except Exception as e:
        raise HTTPException(500, f"处理失败: {e}") from e


@app.post("/api/tasks/upload")
async def create_from_upload(
    task_type: str = Form(...),
    title: str = Form("上传任务"),
    max_pages: int = Form(2),
    actor: str = Form("审核员"),
    notify: bool = Form(True),
    # carton=花盒 | pouch=膜袋；Excel 任务二选一，单面识别
    pack_surface: str = Form("carton"),
    product_name: str = Form(""),
    excel: UploadFile | None = File(None),
    pdf: UploadFile | None = File(None),
    pdf_pouch: UploadFile | None = File(None),  # 兼容旧客户端，忽略双面
    pdf_a: UploadFile | None = File(None),
    pdf_b: UploadFile | None = File(None),
    authorization: str | None = Header(default=None),
):
    ctx = auth.require_perm(authorization, DATA, "create")
    who = ctx["name"]
    tid = uuid.uuid4().hex[:12]
    tdir = UPLOADS / tid
    tdir.mkdir(parents=True, exist_ok=True)
    limit = MAX_UPLOAD_MB * 1024 * 1024
    max_pages = clamp_max_pages(max_pages)

    async def save_up(uf: UploadFile, dest: Path, kind: str) -> None:
        written = 0
        head = b""
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as fh:
            while True:
                chunk = await uf.read(1024 * 1024)
                if not chunk:
                    break
                if not head:
                    head = chunk[:8]
                written += len(chunk)
                if written > limit:
                    fh.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(
                        400,
                        f"文件超过 {MAX_UPLOAD_MB}MB：{uf.filename}。"
                        f"可压缩转曲 PDF，或设置环境变量 WB_MAX_UPLOAD_MB 提高上限。",
                    )
                fh.write(chunk)
        if written == 0:
            dest.unlink(missing_ok=True)
            raise HTTPException(400, f"空文件：{uf.filename or dest.name}")
        if kind == "xlsx" and not head.startswith(b"PK"):
            dest.unlink(missing_ok=True)
            raise HTTPException(400, "Excel 必须是 .xlsx（ZIP 格式），不接受空文件或旧 .xls")
        if kind == "pdf" and not head.startswith(b"%PDF"):
            dest.unlink(missing_ok=True)
            raise HTTPException(400, f"不是有效的 PDF：{uf.filename}")

    try:
        if task_type == "excel_pdf":
            pname = (product_name or "").strip()
            if not pname:
                raise HTTPException(400, "品名必填")
            if not excel or not pdf:
                raise HTTPException(400, "需要 excel + 包装 PDF（花盒或膜袋二选一）")
            ep, pp = tdir / "source.xlsx", tdir / "artwork.pdf"
            await save_up(excel, ep, "xlsx")
            await save_up(pdf, pp, "pdf")
            # 单面：花盒 / 膜袋 二选一（不再同时识别两面）
            surf = (pack_surface or "carton").strip().lower()
            if surf in ("pouch", "膜袋", "bag"):
                surface_label = "膜袋"
            else:
                surface_label = "花盒"
            # 文件名/标题含膜袋时自动纠正
            name_hint = f"{title} {pdf.filename or ''}"
            if re.search(r"膜袋|pouch", name_hint, re.I) and surf not in (
                "carton",
                "花盒",
            ):
                surface_label = "膜袋"
            job_title = (title or "").strip() or pname
            if job_title == "Excel↔包装":
                job_title = pname
            task = run_excel_pdf_job(
                tid,
                ep,
                pp,
                max_pages,
                job_title,
                pdf_pouch=None,  # 强制单面
                surface_a_label=surface_label,
                surface_b_label="膜袋",
            )
            task["pack_surface"] = surface_label
            task["label_a"] = surface_label
            task["product_name"] = pname
            task["title"] = job_title
        elif task_type in ("pdf_pdf", "cross_spec"):
            if not pdf_a or not pdf_b:
                raise HTTPException(400, "需要 pdf_a + pdf_b")
            a, b = tdir / "a.pdf", tdir / "b.pdf"
            await save_up(pdf_a, a, "pdf")
            await save_up(pdf_b, b, "pdf")
            labels = (
                ("30ml", "95ml")
                if task_type == "cross_spec"
                else ("A稿", "B稿")
            )
            task = run_pdf_pdf_job(
                tid,
                a,
                b,
                max_pages,
                title or ("跨规格对齐" if task_type == "cross_spec" else "PDF↔PDF"),
                mode=task_type,
                label_a=labels[0],
                label_b=labels[1],
                note="净含量/条码预期可不同" if task_type == "cross_spec" else None,
            )
        elif task_type == "pdf_internal":
            # 独立验收：单双页 PDF，或两个 PDF（各一面）
            if pdf_a and pdf_b:
                a, b = tdir / "a.pdf", tdir / "b.pdf"
                await save_up(pdf_a, a, "pdf")
                await save_up(pdf_b, b, "pdf")
                task = run_dual_pdf_compare_job(
                    tid, a, b, title or "双页文案对比"
                )
            elif pdf:
                p = tdir / "artwork.pdf"
                await save_up(pdf, p, "pdf")
                task = run_pdf_internal_job(tid, p, title or "双页文案对比")
            else:
                raise HTTPException(
                    400,
                    "双页文案对比需要：一个双页 PDF，或 pdf_a + pdf_b 两个 PDF",
                )
        elif task_type == "report_summary":
            if not pdf:
                raise HTTPException(400, "需要检测报告 pdf")
            p = tdir / "report.pdf"
            await save_up(pdf, p, "pdf")
            rs = run_report_summary_job(
                tid, p, tdir, title=title or "检测报告功效摘要", use_ai=True
            )
            task = {
                "id": tid,
                "title": title or "检测报告功效摘要",
                "type": "report_summary",
                "status": "pending_review",
                "created_at": now_iso(),
                "engine": rs["engine"],
                "note": "有文字层报告 · Word 摘抄",
                "disclaimer": "摘要由报告结论页摘抄生成，须人核对原文。",
                "pages": rs.get("pages") or [],
                "hits": rs["hits"],
                "summary": rs["summary_counts"],
                "report_summary": {
                    k: v
                    for k, v in (rs.get("summary") or {}).items()
                    if not str(k).startswith("_")
                },
                "extract": rs.get("extract"),
                "docx_url": rs.get("docx_url"),
                "docx_name": rs.get("docx_name"),
                "ocr_text": rs.get("ocr_text"),
                "audit": [],
                "actor": who,
            }
        else:
            raise HTTPException(
                400,
                "task_type 无效。第一期请用 excel_pdf（或 pdf_pdf / pdf_internal / cross_spec / report_summary）",
            )
        task["actor"] = who
        task["created_by"] = who
        task["owner"] = who
        task.setdefault("audit", []).append(
            {"at": now_iso(), "actor": who, "action": "create", "via": "upload", "task_type": task_type}
        )
        save_task(task)
        audit_log.append(
            DATA,
            action="task_create",
            actor=who,
            task_id=tid,
            detail={"via": "upload", "task_type": task_type, "summary": task.get("summary")},
        )
        if notify:
            fr = feishu_push.notify_task_created(task, who)
            task["feishu_create"] = fr
            save_task(task)
            audit_log.append(DATA, action="feishu_notify", actor=who, task_id=tid, detail=fr)
        return task
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"处理失败: {e}") from e


@app.get("/api/tasks/{tid}")
def get_task(tid: str, authorization: str | None = Header(default=None)):
    auth.require_perm(authorization, DATA, "read")
    return load_task(tid)


class DeleteTaskBody(BaseModel):
    actor: str = "审核员"
    # 可选：二次确认标题前缀，防误删（前端传 title 前若干字）
    confirm_title: str | None = None


@app.delete("/api/tasks/{tid}")
def delete_task(
    tid: str,
    body: DeleteTaskBody = DeleteTaskBody(),
    authorization: str | None = Header(default=None),
):
    """
    删除任务 JSON + uploads/{tid} 目录（OCR 页、源文件、报告等）。
    审核员/管理员可删；只读不可。
    """
    task = load_task(tid)
    ctx = auth.require_perm(
        authorization, DATA, "delete"
    )
    who = ctx["name"]
    title = str(task.get("title") or "")
    # 若前端传了 confirm_title，要求与任务标题前缀一致（防点错）
    conf = (body.confirm_title or "").strip()
    if conf and not title.startswith(conf[: min(8, len(conf))]):
        raise HTTPException(400, "确认标题与任务不一致，已取消删除")

    # 删 JSON
    jp = task_path(tid)
    if jp.exists():
        jp.unlink()
    # 删上传目录
    udir = UPLOADS / tid
    if udir.exists() and udir.is_dir():
        shutil.rmtree(udir, ignore_errors=True)

    audit_log.append(
        DATA,
        action="delete_task",
        actor=who,
        task_id=tid,
        detail={"title": title[:120], "type": task.get("type"), "status": task.get("status")},
    )
    return {
        "ok": True,
        "id": tid,
        "title": title,
        "deleted_by": who,
    }


@app.get("/api/tasks/{tid}/docx")
def get_docx(tid: str, authorization: str | None = Header(default=None)):
    auth.require_perm(authorization, DATA, "read")
    task = load_task(tid)
    name = Path(str(task.get("docx_name") or "efficacy_summary.docx")).name
    if name.endswith(".tmp") or "/" in name or "\\" in name:
        raise HTTPException(400, "非法 Word 文件名")
    p = safe_upload_file(tid, name)
    if not p.exists():
        raise HTTPException(404, "Word 尚未生成")
    return FileResponse(
        p,
        filename=f"{task.get('title') or '功效摘要'}.docx",
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )


@app.get("/api/tasks/{tid}/pages/{name}")
def get_page(tid: str, name: str, authorization: str | None = Header(default=None)):
    auth.require_perm(authorization, DATA, "read")
    p = page_file(tid, name)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


@app.get("/api/tasks/{tid}/pages/{side}/{name}")
def get_page_side(
    tid: str,
    side: str,
    name: str,
    authorization: str | None = Header(default=None),
):
    auth.require_perm(authorization, DATA, "read")
    p = page_file(tid, name, side)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


class DecisionBody(BaseModel):
    hit_id: str
    decision: Literal["confirm", "issue", "ignore", "pending"]
    actor: str = "审核员"
    note: str | None = None


@app.post("/api/tasks/{tid}/decision")
def decide(
    tid: str,
    body: DecisionBody,
    authorization: str | None = Header(default=None),
):
    task = load_task(tid)
    if task["status"] not in ("pending_review", "in_review"):
        raise HTTPException(400, "当前状态不可审核")
    ctx = auth.require_perm(
        authorization, DATA, "decide"
    )
    who = ctx["name"]
    task["status"] = "in_review"
    task["actor"] = who
    found = False
    field_name = None
    prev = None
    for h in task.get("hits") or []:
        if h["id"] == body.hit_id:
            prev = h.get("decision")
            h["decision"] = body.decision
            h["decided_by"] = who
            h["decided_at"] = now_iso()
            if body.note is not None:
                h["note"] = str(body.note).strip()
            field_name = h.get("field")
            found = True
            break
    if not found:
        raise HTTPException(404, "字段不存在")
    entry = {
        "at": now_iso(),
        "actor": who,
        "action": "decision",
        "hit_id": body.hit_id,
        "field": field_name,
        "decision": body.decision,
        "prev": prev,
    }
    task.setdefault("audit", []).append(entry)
    save_task(task)
    audit_log.append(
        DATA,
        action="decision",
        actor=who,
        task_id=tid,
        detail={"hit_id": body.hit_id, "field": field_name, "decision": body.decision, "prev": prev},
    )
    return task


class AiReviewBody(BaseModel):
    actor: str = "审核员"
    only_uncertain: bool = True
    apply_status: bool = False  # True 时用模型 verdict 改写机审 status（decision 仍保持 pending）


@app.post("/api/tasks/{tid}/ai-review")
def ai_review(
    tid: str,
    body: AiReviewBody = AiReviewBody(),
    authorization: str | None = Header(default=None),
):
    """MiniMax-M3 对疑点/缺失做语义复核（第二层）。不自动终审。"""
    task = load_task(tid)
    ctx = auth.require_perm(
        authorization, DATA, "ai_review"
    )
    who = ctx["name"]
    try:
        result = minimax.review_hits(
            task.get("hits") or [],
            ocr_text=task.get("ocr_text") or "",
            task_title=task.get("title") or "",
            task_note=task.get("note") or "",
            only_uncertain=body.only_uncertain,
        )
    except Exception as e:
        audit_log.append(
            DATA,
            action="ai_review_error",
            actor=who,
            task_id=tid,
            detail={"error": str(e)},
        )
        raise HTTPException(500, f"MiniMax 复核失败: {e}") from e

    by_id = {str(r.get("id")): r for r in result.get("reviews") or []}
    updated = 0
    for h in task.get("hits") or []:
        r = by_id.get(str(h.get("id")))
        if not r:
            continue
        h["ai_review"] = {
            "verdict": r.get("verdict"),
            "confidence": r.get("confidence"),
            "reason": r.get("reason"),
            "suggested_decision": r.get("suggested_decision"),
            "model": (result.get("meta") or {}).get("model"),
            "layer": "semantic_l2",
            "at": now_iso(),
            "actor": who,
        }
        if body.apply_status and r.get("verdict") in ("一致", "疑点", "缺失"):
            h["status_before_ai"] = h.get("status")
            h["status"] = r["verdict"]
            h["evidence"] = f"[AI复核] {r.get('reason') or ''} · 原: {h.get('evidence') or ''}"[
                :400
            ]
        updated += 1

    task["summary"] = _summary(task.get("hits") or [])
    task["ai_review_meta"] = {
        "at": now_iso(),
        "actor": who,
        "count": updated,
        "meta": result.get("meta"),
        "layer": "semantic_l2",
    }
    task.setdefault("audit", []).append(
        {
            "at": now_iso(),
            "actor": who,
            "action": "ai_review",
            "count": updated,
            "apply_status": body.apply_status,
        }
    )
    save_task(task)
    audit_log.append(
        DATA,
        action="ai_review",
        actor=who,
        task_id=tid,
        detail={
            "count": updated,
            "apply_status": body.apply_status,
            "model": (result.get("meta") or {}).get("model"),
            "reviews": result.get("reviews"),
        },
    )
    return task


class TextCompareSummaryBody(BaseModel):
    actor: str = "审核员"
    use_ai: bool = True


@app.post("/api/tasks/{tid}/text-compare-summary")
def text_compare_summary(
    tid: str,
    body: TextCompareSummaryBody = TextCompareSummaryBody(),
    authorization: str | None = Header(default=None),
):
    """
    PDF 文字对比归纳：规则摘要必有；use_ai 时用 MiniMax 写人话结论。
    不改 hits 判定。
    """
    task = load_task(tid)
    if task.get("type") not in ("pdf_internal", "cross_spec", "pdf_pdf"):
        raise HTTPException(400, "仅 PDF 双页/双稿文字对比任务可用")
    ctx = auth.require_perm(
        authorization, DATA, "ai_review"
    )
    who = ctx["name"]
    from app import text_compare_ui

    brief = text_compare_ui.build_rule_brief(task)
    if body.use_ai:
        try:
            brief = text_compare_ui.summarize_with_ai(task)
        except Exception as e:
            brief = {**brief, "source": "rule_fallback", "ai_error": str(e)[:200]}
    brief["at"] = now_iso()
    brief["actor"] = who
    task["text_compare_brief"] = brief
    task["ui_mode"] = "text_compare"
    task.setdefault("audit", []).append(
        {
            "at": brief["at"],
            "actor": who,
            "action": "text_compare_summary",
            "source": brief.get("source"),
        }
    )
    save_task(task)
    return {"ok": True, "brief": brief, "task": task}


class TypoLayerBody(BaseModel):
    actor: str = "审核员"


@app.post("/api/tasks/{tid}/typo-check")
def typo_check_layer(
    tid: str,
    body: TypoLayerBody = TypoLayerBody(),
    authorization: str | None = Header(default=None),
):
    """
    第三层：漏字确认 = 裁块二次 OCR + MiniMax 文本。
    不重跑主引擎，不替代坐标匹配。
    """
    task = load_task(tid)
    ctx = auth.require_perm(
        authorization, DATA, "ai_review"
    )
    who = ctx["name"]
    try:
        result = vlm_layer.typo_confirm_hits(
            task.get("hits") or [],
            ocr_text=task.get("ocr_text") or "",
            task_title=task.get("title") or "",
            task=task,
        )
    except Exception as e:
        raise HTTPException(500, f"漏字确认失败: {e}") from e

    by_id = {str(r.get("id")): r for r in result.get("reviews") or []}
    updated = 0
    for h in task.get("hits") or []:
        r = by_id.get(str(h.get("id")))
        if not r:
            continue
        h["vlm_typo"] = {
            "verdict": r.get("verdict"),
            "confidence": r.get("confidence"),
            "reason": r.get("reason"),
            "suggested_decision": r.get("suggested_decision"),
            "crop_reocr": r.get("crop_reocr"),
            "reocr_snippet": r.get("reocr_snippet"),
            "layer": result.get("layer") or "vlm_typo_l3",
            "at": now_iso(),
            "actor": who,
        }
        # 裁块二次 OCR 确认一致时，建议分桶清空
        if r.get("suggested_decision") == "confirm" and r.get("crop_reocr"):
            h["doubt_bucket"] = None
        updated += 1

    task["vlm_typo_meta"] = {
        "at": now_iso(),
        "actor": who,
        "count": updated,
        "meta": result.get("meta"),
        "layer": result.get("layer") or "vlm_typo_l3",
    }
    task.setdefault("audit", []).append(
        {"at": now_iso(), "actor": who, "action": "typo_check", "count": updated}
    )
    save_task(task)
    audit_log.append(
        DATA,
        action="typo_check",
        actor=who,
        task_id=tid,
        detail={"count": updated, "meta": result.get("meta")},
    )
    return task


class CompleteBody(BaseModel):
    actor: str = "审核员"
    notify: bool = True
    conclusion: str = ""


@app.post("/api/tasks/{tid}/complete")
def complete(
    tid: str,
    body: CompleteBody,
    authorization: str | None = Header(default=None),
):
    task = load_task(tid)
    ctx = auth.require_perm(
        authorization, DATA, "complete"
    )
    who = ctx["name"]
    pending = [
        h
        for h in task.get("hits") or []
        if h.get("status") in ("疑点", "缺失") and h.get("decision") == "pending"
    ]
    if pending:
        raise HTTPException(400, f"仍有 {len(pending)} 条疑点/缺失未处理")
    conclusion = (body.conclusion or "").strip()
    if not conclusion:
        raise HTTPException(400, "请写下结论")
    issues = [h for h in task.get("hits") or [] if h.get("decision") == "issue"]
    task["status"] = "completed"
    task["completed_at"] = now_iso()
    task["completed_by"] = who
    task["actor"] = who
    task["conclusion"] = conclusion
    task["complete_kind"] = "rework" if issues else "signed"
    task.setdefault("audit", []).append(
        {"at": now_iso(), "actor": who, "action": "complete", "kind": task["complete_kind"]}
    )
    save_task(task)
    audit_log.append(
        DATA,
        action="complete",
        actor=who,
        task_id=tid,
        detail={"summary": task.get("summary")},
    )
    if body.notify:
        fr = feishu_push.notify_task_complete(task, who)
        task["feishu_complete"] = fr
        save_task(task)
        audit_log.append(DATA, action="feishu_notify", actor=who, task_id=tid, detail=fr)
    return task


@app.get("/api/tasks/{tid}/report.pdf")
def report_pdf(
    tid: str,
    authorization: str | None = Header(default=None),
):
    ctx = auth.require_perm(authorization, DATA, "export")
    t = load_task(tid)
    who = ctx["name"]
    out = safe_upload_file(tid, "audit_report.pdf")
    try:
        build_report_pdf(t, out)
    except Exception as e:
        raise HTTPException(500, f"PDF 生成失败: {e}") from e
    audit_log.append(
        DATA, action="export_report_pdf", actor=who, task_id=tid, detail={"path": str(out)}
    )
    t.setdefault("audit", []).append(
        {"at": now_iso(), "actor": who, "action": "export_report_pdf"}
    )
    save_task(t)
    return FileResponse(
        out,
        filename=f"审核报告-{t.get('title') or tid}.pdf",
        media_type="application/pdf",
    )


@app.post("/api/tasks/{tid}/archive/feishu")
def archive_feishu(
    tid: str,
    authorization: str | None = Header(default=None),
):
    """生成 PDF 并飞书个人推送归档摘要 + 本机路径提示"""
    t = load_task(tid)
    ctx = auth.require_perm(authorization, DATA, "archive")
    who = ctx["name"]
    out = UPLOADS / tid / "audit_report.pdf"
    try:
        build_report_pdf(t, out)
    except Exception as e:
        raise HTTPException(500, f"PDF 生成失败: {e}") from e
    fr = feishu_push.notify_report_archive(t, who, pdf_path=str(out))
    t["feishu_archive"] = fr
    t.setdefault("audit", []).append(
        {"at": now_iso(), "actor": who, "action": "archive_feishu", "detail": fr}
    )
    save_task(t)
    audit_log.append(
        DATA, action="archive_feishu", actor=who, task_id=tid, detail=fr
    )
    return {"ok": bool(fr.get("ok")), "pdf": f"/api/tasks/{tid}/report.pdf", "feishu": fr}


def _html_esc(s: Any) -> str:
    return (
        str(s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


@app.get("/api/tasks/{tid}/report")
def report_html(
    tid: str,
    authorization: str | None = Header(default=None),
):
    """HTML 审核报告。须登录。GET 不改任务 JSON。"""
    ctx = auth.require_perm(authorization, DATA, "read")
    t = load_task(tid)
    try:
        audit_log.append(DATA, action="export_report", actor=ctx["name"], task_id=tid)
    except Exception:
        pass

    rows = []
    for h in t.get("hits") or []:
        rows.append(
            f"<tr class='{_html_esc(h.get('status'))}'>"
            f"<td>{_html_esc(h.get('field'))}</td>"
            f"<td>{_html_esc(h.get('status'))}</td>"
            f"<td>{_html_esc(h.get('decision'))}</td>"
            f"<td>{_html_esc(h.get('decided_by') or '')}</td>"
            f"<td>{_html_esc(h.get('evidence'))}</td>"
            f"<td><pre>{_html_esc((h.get('excel_value') or '')[:200])}</pre></td></tr>"
        )
    audit_rows = []
    for a in (t.get("audit") or [])[-40:]:
        audit_rows.append(
            f"<tr><td>{_html_esc(a.get('at',''))}</td>"
            f"<td>{_html_esc(a.get('actor',''))}</td>"
            f"<td>{_html_esc(a.get('action') or a.get('decision') or '')}</td>"
            f"<td>{_html_esc(a.get('field') or a.get('hit_id') or '')}</td></tr>"
        )
    title = _html_esc(t.get("title"))
    note_html = (
        f"说明：{_html_esc(t.get('note'))}<br/>" if t.get("note") else ""
    )
    is_dual = (
        t.get("product") == "dual_page_copy_compare"
        or t.get("ui_mode") == "text_compare"
        or t.get("type") in ("pdf_internal", "pdf_pdf")
    )
    report_h1 = "双页文案对比报告" if is_dual else "备案审核报告"
    col_content = (
        f"{_html_esc(t.get('label_a') or '面1')} / {_html_esc(t.get('label_b') or '面2')}"
        if is_dual
        else "原文"
    )
    foot_line = (
        "本报告为「双页文案对比」产物，不依赖 Excel 确认单。"
        "AI/规则仅标疑点；人终审结论以上表「人审」为准；改稿可按 #序号 定位。"
        if is_dual
        else "本报告由备案审核工作台生成。AI 仅标疑点，人终审结论以上表「人审」为准。"
    )
    html = f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>{_html_esc(report_h1)} · {title}</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:960px;margin:32px auto;color:#111;padding:0 16px}}
h1{{font-size:20px}} h2{{font-size:15px;margin-top:28px}} .meta{{color:#666;font-size:13px;line-height:1.6}}
table{{width:100%;border-collapse:collapse;font-size:13px;margin-top:16px}}
th,td{{border:1px solid #e5e7eb;padding:8px;vertical-align:top}}
th{{background:#f9fafb;text-align:left}}
.一致{{background:#ecfdf5}} .疑点{{background:#fffbeb}} .缺失{{background:#fef2f2}}
pre{{white-space:pre-wrap;margin:0;font-size:12px}}
.foot{{margin-top:24px;font-size:12px;color:#666}}
</style></head><body>
<h1>{_html_esc(report_h1)}</h1>
<p class="meta">任务：{title} · ID {_html_esc(t.get('id'))}<br/>
产品：{_html_esc(t.get('product_label') or ('双页文案对比' if is_dual else '确认单核对'))}<br/>
状态：{_html_esc(t.get('status'))} · 引擎：{_html_esc(t.get('engine') or t.get('engine_version'))}<br/>
列名：{_html_esc(t.get('label_a') or '—')} ↔ {_html_esc(t.get('label_b') or '—')}<br/>
创建：{_html_esc(t.get('created_at'))} · 创建人：{_html_esc(t.get('created_by') or t.get('actor'))}<br/>
终审：{_html_esc(t.get('completed_by') or '—')} · {_html_esc(t.get('completed_at') or '未完成')}<br/>
汇总：{_html_esc(t.get('summary'))}<br/>
{note_html}
</p>
<table><thead><tr><th>序号/字段</th><th>机审</th><th>人审</th><th>操作人</th><th>证据</th><th>{col_content}</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table>
<h2>审计轨迹</h2>
<table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th></tr></thead>
<tbody>{''.join(audit_rows) or '<tr><td colspan=4>无</td></tr>'}</tbody></table>
<p class="foot">{_html_esc(foot_line)}<br/>
{_html_esc(t.get('disclaimer',''))}</p>
</body></html>"""
    return HTMLResponse(html)


_brand_dir = ROOT.parent / "ui" / "public" / "brand"
if _brand_dir.is_dir():
    app.mount("/brand", StaticFiles(directory=str(_brand_dir)), name="brand")

_ui_assets = ROOT.parent / "ui" / "dist" / "assets"
if _ui_assets.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_ui_assets)), name="ui-assets")


@app.get("/")
def index():
    """验收入口只使用 React 构建。"""
    built = UI_DIST / "index.html"
    if built.is_file():
        return FileResponse(built)
    raise HTTPException(
        503,
        "审稿台前端未构建。请在 apps/web/ui 执行 npm run build。",
    )
