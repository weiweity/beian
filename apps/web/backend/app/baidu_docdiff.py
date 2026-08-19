"""
百度智能文档分析 · 文档比对 API（异步）

提交：POST /file/2.0/brain/online/v1/textdiff/create_task
查询：POST /file/2.0/brain/online/v1/textdiff/query_task

文档：https://cloud.baidu.com/doc/OCR/s/Glqd7jgmf
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx

from app.baidu_ocr import get_access_token, load_baidu_env

CREATE_URL = "https://aip.baidubce.com/file/2.0/brain/online/v1/textdiff/create_task"
QUERY_URL = "https://aip.baidubce.com/file/2.0/brain/online/v1/textdiff/query_task"
SDK_URL_TMPL = (
    "https://textmind-sdk.bce.baidu.com/textmind/sdk/textdiff/{task_id}"
    "?access_token={token}"
)


def _token() -> str:
    cfg = load_baidu_env()
    ak = cfg.get("BAIDU_OCR_API_KEY") or cfg.get("BAIDU_API_KEY") or ""
    sk = cfg.get("BAIDU_OCR_SECRET_KEY") or cfg.get("BAIDU_SECRET_KEY") or ""
    if not ak or not sk:
        raise RuntimeError("未配置百度 AK/SK")
    return get_access_token(ak, sk)


def create_compare_task(
    base_path: str | Path,
    compare_path: str | Path,
    *,
    seal: bool = False,
    handwriting: bool = False,
    full_half_width: bool = True,
) -> dict[str, Any]:
    """提交比对任务，返回 {task_id, raw}"""
    base_path = Path(base_path)
    compare_path = Path(compare_path)
    if not base_path.exists() or not compare_path.exists():
        raise FileNotFoundError("比对文件不存在")

    token = _token()
    url = f"{CREATE_URL}?access_token={token}"
    # param：特殊差异识别参数（JSON 字符串）
    data = {
        "param": json.dumps(
            {
                "sealRecognition": seal,
                "handWritingRecognition": handwriting,
                "fullWidthHalfWidthRecognition": full_half_width,
                "fontFamilyRecognition": False,
                "fontSizeRecognition": False,
            },
            ensure_ascii=False,
        )
    }
    files = {
        "baseFile": (base_path.name, base_path.read_bytes(), "application/pdf"),
        "compareFile": (
            compare_path.name,
            compare_path.read_bytes(),
            "application/pdf",
        ),
    }
    last_err: Exception | None = None
    body: dict[str, Any] = {}
    for trust in (True, False):
        try:
            with httpx.Client(timeout=httpx.Timeout(180.0, connect=30.0), trust_env=trust) as client:
                r = client.post(url, data=data, files=files)
                body = r.json() if r.content else {}
            last_err = None
            break
        except Exception as e:
            last_err = e
            continue
    if last_err and not body:
        raise RuntimeError(f"文档比对提交网络失败: {last_err}") from last_err
    if body.get("error_code") not in (0, None, "0"):
        # 有的成功也无 error_code
        if "result" not in body or not (body.get("result") or {}).get("taskId"):
            raise RuntimeError(
                f"文档比对提交失败: {body.get('error_code')} {body.get('error_msg') or body}"
            )
    task_id = (body.get("result") or {}).get("taskId") or (body.get("result") or {}).get(
        "task_id"
    )
    if not task_id:
        raise RuntimeError(f"文档比对未返回 taskId: {body}")
    return {"task_id": task_id, "raw": body, "token": token}


def query_compare_task(task_id: str) -> dict[str, Any]:
    token = _token()
    url = f"{QUERY_URL}?access_token={token}"
    last_err: Exception | None = None
    for trust in (True, False):
        try:
            with httpx.Client(timeout=httpx.Timeout(90.0, connect=20.0), trust_env=trust) as client:
                # 官方示例用 multipart files 传 taskId，form data 会 Invalid parameter
                r = client.post(url, files={"taskId": (None, task_id)})
                return r.json() if r.content else {}
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"文档比对查询网络失败: {last_err}") from last_err


def wait_compare_task(
    task_id: str,
    *,
    timeout_sec: float = 180.0,
    poll_sec: float = 5.0,
) -> dict[str, Any]:
    """轮询直到 success/failed 或超时"""
    t0 = time.time()
    last: dict[str, Any] = {}
    while time.time() - t0 < timeout_sec:
        last = query_compare_task(task_id)
        if last.get("error_code") not in (0, None, "0") and last.get("error_code"):
            # 查询本身错误
            if "result" not in last:
                raise RuntimeError(
                    f"文档比对查询失败: {last.get('error_code')} {last.get('error_msg')}"
                )
        result = last.get("result") or {}
        status = (result.get("status") or "").lower()
        if status in ("success", "failed"):
            return last
        # 子任务也可能直接成功
        subs = result.get("subTaskList") or []
        if subs and all(
            (s.get("compareStatus") or "").lower() in ("success", "failed") for s in subs
        ):
            return last
        time.sleep(poll_sec)
    return last


def compare_files(
    base_path: str | Path,
    compare_path: str | Path,
    *,
    timeout_sec: float = 180.0,
) -> dict[str, Any]:
    """
    端到端比对。
    返回规范化结果：
    {
      ok, task_id, status, similarity, total_diff,
      report_url, base_pdf_url, compare_pdf_url,
      sdk_url, diffs: [{id, type, page, content, context, boxes, side...}],
      raw
    }
    """
    created = create_compare_task(base_path, compare_path)
    task_id = created["task_id"]
    token = created.get("token") or _token()
    body = wait_compare_task(task_id, timeout_sec=timeout_sec)
    result = body.get("result") or {}
    status = (result.get("status") or "").lower()
    subs = result.get("subTaskList") or []
    sub = subs[0] if subs else {}

    sim_raw = sub.get("similarity") or ""
    try:
        sim = float(str(sim_raw).replace("%", "").strip()) if sim_raw else None
    except Exception:
        sim = None

    diffs: list[dict] = []
    for item in sub.get("diffItemList") or []:
        diffs.append(
            {
                "id": item.get("id"),
                "base_page": item.get("basePageNum"),
                "compare_page": item.get("comparePageNum"),
                "base_type": item.get("baseDiffType"),
                "compare_type": item.get("compareDiffType"),
                "base_content": item.get("baseDiffContent") or "",
                "compare_content": item.get("compareDiffContent") or "",
                "base_context": item.get("baseDiffContext") or "",
                "compare_context": item.get("compareDiffContext") or "",
                "base_box": item.get("baseBoxArea") or [],
                "compare_box": item.get("compareBoxArea") or [],
            }
        )

    ok = status == "success" or (sub.get("compareStatus") or "").lower() == "success"
    return {
        "ok": ok,
        "task_id": task_id,
        "status": status or sub.get("compareStatus"),
        "similarity": sim,
        "similarity_raw": sim_raw,
        "total_diff": int(sub.get("totalDiff") or len(diffs) or 0),
        "report_url": sub.get("reportOssURL") or "",
        "base_pdf_url": sub.get("baseDocOssURL") or "",
        "compare_pdf_url": sub.get("compareDocOssURL") or "",
        "base_name": sub.get("baseDocName") or "",
        "compare_name": sub.get("compareDocName") or "",
        "sdk_url": SDK_URL_TMPL.format(task_id=task_id, token=token),
        "duration": result.get("duration") or "",
        "error_type": result.get("errorType") or "",
        "diffs": diffs,
        "raw_status": body.get("error_msg") or "",
        "error_code": body.get("error_code"),
    }


def _norm_diff_text(s: str) -> str:
    import re

    t = (s or "").replace("\u3000", " ").replace("\xa0", " ")
    t = re.sub(r"\s+", "", t)
    return t.lower()


def _is_noise_diff(a_txt: str, b_txt: str) -> bool:
    """误报降噪：空白、纯标点、归一化后相同、仅空白差异"""
    import re

    a, b = (a_txt or "").strip(), (b_txt or "").strip()
    if not a and not b:
        return True
    na, nb = _norm_diff_text(a), _norm_diff_text(b)
    if na == nb:
        return True
    # 仅标点/符号
    if na and re.fullmatch(r"[\W_]+", na) and (not nb or re.fullmatch(r"[\W_]+", nb)):
        return True
    if nb and re.fullmatch(r"[\W_]+", nb) and (not na or re.fullmatch(r"[\W_]+", na)):
        return True
    # 单字符无意义抖动
    if len(na) <= 1 and len(nb) <= 1:
        return True
    return False


def diffs_to_hits(
    compare_result: dict[str, Any],
    *,
    label_a: str = "A稿",
    label_b: str = "B稿",
    max_items: int = 40,
) -> list[dict[str, Any]]:
    """把百度 diff 转成工作台 hits（含无坐标标记与噪声过滤）"""
    hits: list[dict[str, Any]] = []
    sim = compare_result.get("similarity")
    raw_diffs = list(compare_result.get("diffs") or [])
    total = compare_result.get("total_diff") or len(raw_diffs) or 0
    ok = compare_result.get("ok")

    overview_status = "一致"
    if not ok:
        overview_status = "疑点"
    elif sim is not None:
        if sim < 90:
            overview_status = "疑点" if sim >= 70 else "缺失"
        if total and total > 0 and sim is not None and sim < 99:
            overview_status = "疑点" if total < 30 else overview_status

    hits.append(
        {
            "id": "baidu_diff_overview",
            "field": "百度文档比对 · 总览",
            "excel_value": f"{label_a} ↔ {label_b}",
            "status": overview_status if ok else "疑点",
            "evidence": (
                f"相似度 {compare_result.get('similarity_raw') or sim or '—'} · "
                f"差异点 {total} · 引擎 baidu:textdiff · "
                f"{'成功' if ok else '失败/超时 ' + str(compare_result.get('error_type') or '')}"
                f" · 无坐标时请点「百度比对/SDK」看官方高亮"
            ),
            "score": float(sim) if sim is not None else 0.0,
            "decision": "pending",
            "bboxes": [],
            "page": 1,
            "category": "baidu_diff",
            "no_bbox": True,
            "ux_hint": "open_baidu_report",
            "report_url": compare_result.get("report_url") or "",
            "sdk_url": compare_result.get("sdk_url") or "",
        }
    )

    type_map = {
        "insert": "新增",
        "delete": "删除",
        "replace": "替换",
    }
    kept = 0
    skipped_noise = 0
    for i, d in enumerate(raw_diffs):
        if kept >= max_items:
            break
        bt = type_map.get(str(d.get("base_type") or ""), d.get("base_type") or "")
        ct = type_map.get(str(d.get("compare_type") or ""), d.get("compare_type") or "")
        a_txt = (d.get("base_content") or "").strip()
        b_txt = (d.get("compare_content") or "").strip()
        if _is_noise_diff(a_txt, b_txt):
            skipped_noise += 1
            continue
        field = f"差异 · {bt or ct or '变更'}"
        excel_val = f"{label_a}: {a_txt or '—'}\n{label_b}: {b_txt or '—'}"
        boxes = []
        bb = d.get("base_box") or []
        if isinstance(bb, list) and len(bb) >= 4:
            boxes.append(
                {
                    "page": int(d.get("base_page") or 1),
                    "left": int(bb[0]),
                    "top": int(bb[1]),
                    "width": int(bb[2]),
                    "height": int(bb[3]),
                }
            )
        boxes_b = []
        cb = d.get("compare_box") or []
        if isinstance(cb, list) and len(cb) >= 4:
            boxes_b.append(
                {
                    "page": int(d.get("compare_page") or 1),
                    "left": int(cb[0]),
                    "top": int(cb[1]),
                    "width": int(cb[2]),
                    "height": int(cb[3]),
                }
            )
        no_bbox = not boxes and not boxes_b
        evidence = (
            f"页{d.get('base_page') or '?'}/{d.get('compare_page') or '?'} · "
            f"上下文A: {(d.get('base_context') or '')[:80]} · "
            f"B: {(d.get('compare_context') or '')[:80]}"
        )
        if no_bbox:
            evidence = "⚠ 无图坐标 · 请对照文字或打开百度比对报告 · " + evidence
        hits.append(
            {
                "id": f"bd_{i}_{d.get('id') or i}",
                "field": field,
                "excel_value": excel_val[:500],
                "status": "疑点",
                "evidence": evidence,
                "score": 50.0 if not no_bbox else 45.0,
                "decision": "pending",
                "bboxes": boxes,
                "bboxes_b": boxes_b,
                "page": int(d.get("base_page") or 1),
                "side": "a",
                "category": "baidu_diff",
                "text_a": a_txt[:300],
                "text_b": b_txt[:300],
                "no_bbox": no_bbox,
                "ux_hint": "open_baidu_report" if no_bbox else "focus_bbox",
            }
        )
        kept += 1

    if skipped_noise:
        hits[0]["evidence"] += f" · 已降噪过滤 {skipped_noise} 条空/标点差异"
        hits[0]["noise_filtered"] = skipped_noise
    return hits
