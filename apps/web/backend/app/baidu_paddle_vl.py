"""
百度 · 文档解析（PaddleOCR-VL）异步接口

文档：https://ai.baidu.com/ai-doc/OCR/Qmncwhwdt

用法：
  - 提交 task → 轮询 query → 下载 parse_result_url JSON
  - 抽出全文 + layout/span 坐标，供匹配增强与（可选）定位

环境变量（.env.baidu 或环境）：
  BAIDU_PADDLE_VL=1|on|true   开启（默认 off，避免未开通额度拖垮任务）
  BAIDU_PADDLE_VL_TIMEOUT=120 轮询最长秒数
  BAIDU_PADDLE_VL_SPAN=1      请求行坐标 return_span_boxes
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.parse
from pathlib import Path
from typing import Any

import httpx

from app.baidu_ocr import get_access_token, load_baidu_env

SUBMIT_URL = "https://aip.baidubce.com/rest/2.0/brain/online/v2/paddle-vl-parser/task"
QUERY_URL = "https://aip.baidubce.com/rest/2.0/brain/online/v2/paddle-vl-parser/task/query"


def paddle_vl_enabled() -> bool:
    cfg = load_baidu_env()
    v = (
        os.environ.get("BAIDU_PADDLE_VL")
        or cfg.get("BAIDU_PADDLE_VL")
        or "0"
    ).strip().lower()
    return v in ("1", "true", "on", "yes", "y")


def _timeout_sec() -> float:
    cfg = load_baidu_env()
    raw = os.environ.get("BAIDU_PADDLE_VL_TIMEOUT") or cfg.get(
        "BAIDU_PADDLE_VL_TIMEOUT"
    ) or "120"
    try:
        return max(30.0, float(raw))
    except Exception:
        return 120.0


def _want_span() -> bool:
    cfg = load_baidu_env()
    v = (
        os.environ.get("BAIDU_PADDLE_VL_SPAN")
        or cfg.get("BAIDU_PADDLE_VL_SPAN")
        or "1"
    ).strip().lower()
    return v in ("1", "true", "on", "yes", "y")


def submit_parse_task(
    file_bytes: bytes,
    *,
    file_name: str = "page.png",
    return_span_boxes: bool | None = None,
) -> dict[str, Any]:
    """提交解析任务，返回 {ok, task_id, error, raw}。"""
    cfg = load_baidu_env()
    ak = cfg.get("BAIDU_OCR_API_KEY") or cfg.get("BAIDU_API_KEY") or ""
    sk = cfg.get("BAIDU_OCR_SECRET_KEY") or cfg.get("BAIDU_SECRET_KEY") or ""
    if not ak or not sk:
        return {"ok": False, "error": "missing BAIDU_OCR AK/SK"}

    token = get_access_token(ak, sk)
    url = f"{SUBMIT_URL}?access_token={urllib.parse.quote(token)}"
    span = _want_span() if return_span_boxes is None else return_span_boxes
    data = {
        "file_data": base64.b64encode(file_bytes).decode("ascii"),
        "file_name": file_name or "page.png",
    }
    # 文档：return_span_boxes 是否返回行坐标
    if span:
        data["return_span_boxes"] = "true"

    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    body: dict = {}
    last_err: Exception | None = None
    for trust in (True, False):
        try:
            with httpx.Client(
                timeout=httpx.Timeout(120.0, connect=20.0), trust_env=trust
            ) as client:
                r = client.post(url, data=data, headers=headers)
                r.raise_for_status()
                body = r.json()
            last_err = None
            break
        except Exception as e:
            last_err = e
            continue
    if last_err and not body:
        return {"ok": False, "error": f"submit network: {last_err}"}

    if body.get("error_code") not in (0, None, "0"):
        return {
            "ok": False,
            "error": f"{body.get('error_code')}: {body.get('error_msg')}",
            "raw": body,
        }
    task_id = (body.get("result") or {}).get("task_id")
    if not task_id:
        return {"ok": False, "error": "no task_id", "raw": body}
    return {"ok": True, "task_id": task_id, "raw": body}


def query_parse_task(task_id: str) -> dict[str, Any]:
    """轮询一次，返回 {ok, status, markdown_url, parse_result_url, task_error, raw}。"""
    cfg = load_baidu_env()
    ak = cfg.get("BAIDU_OCR_API_KEY") or cfg.get("BAIDU_API_KEY") or ""
    sk = cfg.get("BAIDU_OCR_SECRET_KEY") or cfg.get("BAIDU_SECRET_KEY") or ""
    token = get_access_token(ak, sk)
    url = f"{QUERY_URL}?access_token={urllib.parse.quote(token)}"
    data = {"task_id": task_id}
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    body: dict = {}
    last_err: Exception | None = None
    for trust in (True, False):
        try:
            with httpx.Client(
                timeout=httpx.Timeout(60.0, connect=15.0), trust_env=trust
            ) as client:
                r = client.post(url, data=data, headers=headers)
                r.raise_for_status()
                body = r.json()
            last_err = None
            break
        except Exception as e:
            last_err = e
            continue
    if last_err and not body:
        return {"ok": False, "error": f"query network: {last_err}"}

    if body.get("error_code") not in (0, None, "0"):
        return {
            "ok": False,
            "error": f"{body.get('error_code')}: {body.get('error_msg')}",
            "raw": body,
        }
    result = body.get("result") or {}
    return {
        "ok": True,
        "status": result.get("status"),
        "markdown_url": result.get("markdown_url"),
        "parse_result_url": result.get("parse_result_url"),
        "task_error": result.get("task_error"),
        "raw": body,
    }


def wait_parse_result(
    task_id: str,
    *,
    timeout_sec: float | None = None,
    poll_sec: float = 4.0,
) -> dict[str, Any]:
    """轮询直到 success/failed 或超时。"""
    deadline = time.time() + (timeout_sec if timeout_sec is not None else _timeout_sec())
    last: dict[str, Any] = {}
    # 首次稍等再查
    time.sleep(min(6.0, poll_sec + 2))
    while time.time() < deadline:
        last = query_parse_task(task_id)
        if not last.get("ok"):
            time.sleep(poll_sec)
            continue
        st = (last.get("status") or "").lower()
        if st == "success":
            return last
        if st == "failed":
            return {
                "ok": False,
                "error": last.get("task_error") or "task failed",
                "raw": last.get("raw"),
            }
        time.sleep(poll_sec)
    return {
        "ok": False,
        "error": f"timeout after {_timeout_sec()}s",
        "last": last,
    }


def download_json(url: str) -> dict[str, Any] | list | None:
    if not url:
        return None
    last_err: Exception | None = None
    for trust in (True, False):
        try:
            with httpx.Client(
                timeout=httpx.Timeout(90.0, connect=20.0), trust_env=trust
            ) as client:
                r = client.get(url)
                r.raise_for_status()
                return r.json()
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"download parse_result failed: {last_err}")


def parse_result_to_text_and_words(
    parse_json: dict[str, Any],
    *,
    page: int = 1,
    page_w: int | None = None,
    page_h: int | None = None,
) -> tuple[str, list[dict], dict]:
    """
    把 VL 解析 JSON 转成 (text, words[{text,location,page}], meta)

    position: [x, y, w, h] 相对「解析页」坐标系；
    若提供 page_w/page_h 与 meta 页尺寸不一致，按比例缩放到渲染 PNG。
    """
    pages = parse_json.get("pages") or []
    if not pages:
        # 有的结构直接是 list
        if isinstance(parse_json, list):
            pages = parse_json
        else:
            return "", [], {"ok": False, "error": "no pages"}

    texts: list[str] = []
    words: list[dict] = []
    scale_x, scale_y = 1.0, 1.0

    for pi, pg in enumerate(pages):
        meta = pg.get("meta") or {}
        src_w = float(meta.get("page_width") or 0) or None
        src_h = float(meta.get("page_height") or 0) or None
        if page_w and src_w and src_w > 1:
            scale_x = float(page_w) / src_w
        if page_h and src_h and src_h > 1:
            scale_y = float(page_h) / src_h

        page_text = (pg.get("text") or "").strip()
        if page_text:
            # 去掉简单 html 标签便于短语匹配
            import re as _re

            plain = _re.sub(r"<[^>]+>", " ", page_text)
            plain = _re.sub(r"\s+", " ", plain).strip()
            texts.append(plain)
            texts.append(page_text)

        md = (pg.get("markdown") or "").strip()
        if md:
            import re as _re

            plain_md = _re.sub(r"<[^>]+>", " ", md)
            plain_md = _re.sub(r"!\[.*?\]\(.*?\)", " ", plain_md)
            plain_md = _re.sub(r"\s+", " ", plain_md).strip()
            if plain_md:
                texts.append(plain_md)

        # 表格 markdown / cells
        for tb in pg.get("tables") or []:
            tm = (tb.get("markdown") or tb.get("table_html") or "").strip()
            if tm:
                import re as _re

                texts.append(_re.sub(r"<[^>]+>", " ", tm))
            for cell in tb.get("cells") or []:
                ct = (cell.get("text") or "").strip()
                if ct:
                    texts.append(ct)
                pos = cell.get("position") or []
                box = _pos_to_location(pos, scale_x, scale_y)
                if ct and box:
                    words.append(
                        {
                            "text": ct,
                            "location": box,
                            "page": page if len(pages) == 1 else (pi + 1),
                            "source": "paddle_vl_table_cell",
                        }
                    )

        # layout 块
        for lay in pg.get("layouts") or []:
            t = (lay.get("text") or "").strip()
            pos = lay.get("position") or []
            if not t:
                continue
            if not page_text:
                texts.append(t)
            box = _pos_to_location(pos, scale_x, scale_y)
            if box:
                words.append(
                    {
                        "text": t,
                        "location": box,
                        "page": page if len(pages) == 1 else (pi + 1),
                        "source": "paddle_vl_layout",
                        "layout_type": lay.get("type"),
                    }
                )
            # span 行坐标
            for sp in lay.get("span_boxes") or []:
                st = sp.get("text")
                if isinstance(st, list):
                    st = "".join(str(x) for x in st)
                st = (st or "").strip()
                sloc = sp.get("location") or sp.get("position") or []
                if not st:
                    continue
                box2 = _pos_to_location(sloc, scale_x, scale_y)
                if box2:
                    words.append(
                        {
                            "text": st,
                            "location": box2,
                            "page": page if len(pages) == 1 else (pi + 1),
                            "source": "paddle_vl_span",
                        }
                    )

    full = "\n".join(texts)
    meta_out = {
        "ok": bool(full or words),
        "pages": len(pages),
        "words": len(words),
        "scale": [scale_x, scale_y],
        "text_len": len(full),
    }
    return full, words, meta_out


def _as_float(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except Exception:
            return None
    # 嵌套 list 取首个数字
    if isinstance(v, (list, tuple)) and v:
        return _as_float(v[0])
    return None


def _pos_to_location(
    pos: list | dict, scale_x: float, scale_y: float
) -> dict | None:
    """[x,y,w,h] 或 {left,top,width,height} → location dict。"""
    if isinstance(pos, dict):
        left = _as_float(pos.get("left", pos.get("x")))
        top = _as_float(pos.get("top", pos.get("y")))
        width = _as_float(pos.get("width", pos.get("w")))
        height = _as_float(pos.get("height", pos.get("h")))
        if None in (left, top, width, height):
            return None
        return {
            "left": int(left * scale_x),
            "top": int(top * scale_y),
            "width": max(2, int(width * scale_x)),
            "height": max(2, int(height * scale_y)),
        }
    if isinstance(pos, (list, tuple)) and len(pos) >= 4:
        x, y, w, h = _as_float(pos[0]), _as_float(pos[1]), _as_float(pos[2]), _as_float(pos[3])
        if None in (x, y, w, h):
            return None
        return {
            "left": int(x * scale_x),
            "top": int(y * scale_y),
            "width": max(2, int(w * scale_x)),
            "height": max(2, int(h * scale_y)),
        }
    return None


def _prepare_vl_payloads(
    path: Path,
    *,
    page_w: int | None,
    page_h: int | None,
) -> list[tuple[bytes, str, str, int, int, int, int]]:
    """
    返回多路提交：[(bytes, fname, tag, offset_left, offset_top, out_w, out_h), ...]
    刀版：整页 + 右栏（成分/脚注），避免 VL 只盯工艺表/主视觉。
    """
    from PIL import Image
    import io

    im = Image.open(path).convert("RGB")
    W, H = im.size
    page_w = page_w or W
    page_h = page_h or H
    out: list[tuple[bytes, str, str, int, int, int, int]] = []

    def to_jpeg(img: Image.Image, max_side: int = 3600, quality: int = 92) -> bytes:
        w, h = img.size
        if max(w, h) > max_side:
            sc = max_side / max(w, h)
            img = img.resize((int(w * sc), int(h * sc)), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return buf.getvalue()

    # 刀版：优先右栏（成分/脚注/生产）；整页可选（慢且易被工艺表抢走注意力）
    left = int(W * 0.48)
    # 1) 右栏全高
    right_crop = im.crop((left, 0, W, H))
    out.append(
        (
            to_jpeg(right_crop, max_side=3200),
            path.stem + "_right.jpg",
            "right_col",
            left,
            0,
            right_crop.size[0],
            right_crop.size[1],
        )
    )
    # 2) 成分密字带（约 y 22%–55%）
    y0, y1 = int(H * 0.22), int(H * 0.58)
    ing = im.crop((left, y0, W, y1))
    out.append(
        (
            to_jpeg(ing, max_side=2800),
            path.stem + "_ing.jpg",
            "ingredients_band",
            left,
            y0,
            ing.size[0],
            ing.size[1],
        )
    )
    # 3) 脚注+生产带（约 y 48%–78%）
    y2, y3 = int(H * 0.48), int(H * 0.78)
    foot = im.crop((left, y2, W, y3))
    out.append(
        (
            to_jpeg(foot, max_side=2800),
            path.stem + "_foot.jpg",
            "footnote_prod",
            left,
            y2,
            foot.size[0],
            foot.size[1],
        )
    )
    return out


def parse_image_file(
    path: str | Path,
    *,
    page: int = 1,
    page_w: int | None = None,
    page_h: int | None = None,
) -> dict[str, Any]:
    """
    对单张 PNG/JPG 跑 VL（整页 + 右栏多路），合并文本/词框。
    返回 {ok, text, words, meta, error}
    """
    path = Path(path)
    if not path.exists():
        return {"ok": False, "error": f"missing file {path}"}

    try:
        payloads = _prepare_vl_payloads(path, page_w=page_w, page_h=page_h)
    except Exception as e:
        return {"ok": False, "error": f"prepare: {e}"}

    all_text: list[str] = []
    all_words: list[dict] = []
    parts_meta: list[dict] = []
    any_ok = False

    for data, fname, tag, off_l, off_t, crop_w, crop_h in payloads:
        sub = submit_parse_task(data, file_name=fname)
        if not sub.get("ok"):
            parts_meta.append({"tag": tag, "ok": False, "error": sub.get("error"), "stage": "submit"})
            continue
        waited = wait_parse_result(sub["task_id"])
        if not waited.get("ok"):
            parts_meta.append(
                {
                    "tag": tag,
                    "ok": False,
                    "error": waited.get("error"),
                    "stage": "wait",
                    "task_id": sub["task_id"],
                }
            )
            continue
        purl = waited.get("parse_result_url")
        murl = waited.get("markdown_url")
        parse_json = None
        if purl:
            try:
                parse_json = download_json(purl)
            except Exception as e:
                parts_meta.append(
                    {
                        "tag": tag,
                        "ok": False,
                        "error": f"download: {e}",
                        "task_id": sub["task_id"],
                    }
                )
                continue
        if not isinstance(parse_json, dict):
            parts_meta.append({"tag": tag, "ok": False, "error": "no parse json"})
            continue

        # 裁块坐标：先映射到裁块像素，再加 offset
        text, words, meta = parse_result_to_text_and_words(
            parse_json,
            page=page,
            page_w=crop_w,
            page_h=crop_h,
        )
        if text:
            all_text.append(f"[paddle_vl:{tag}]\n{text}")
        for w in words:
            loc = w.get("location") or {}
            w2 = dict(w)
            w2["location"] = {
                "left": int(loc.get("left") or 0) + off_l,
                "top": int(loc.get("top") or 0) + off_t,
                "width": int(loc.get("width") or 0),
                "height": int(loc.get("height") or 0),
            }
            w2["page"] = page
            w2["vl_tag"] = tag
            all_words.append(w2)
        any_ok = any_ok or bool(text or words)
        parts_meta.append(
            {
                "tag": tag,
                "ok": True,
                "task_id": sub["task_id"],
                "text_len": len(text or ""),
                "words": len(words),
                "markdown_url": murl,
            }
        )

    return {
        "ok": any_ok,
        "text": "\n".join(all_text),
        "words": all_words,
        "meta": {"parts": parts_meta, "engine": "paddle_vl"},
        "error": None if any_ok else "all_parts_failed",
        "task_id": next((p.get("task_id") for p in parts_meta if p.get("task_id")), None),
    }


def ping_paddle_vl() -> dict[str, Any]:
    """健康检查：仅看配置与是否启用，不强制花额度。"""
    cfg = load_baidu_env()
    enabled = paddle_vl_enabled()
    has_ak = bool(
        (cfg.get("BAIDU_OCR_API_KEY") or cfg.get("BAIDU_API_KEY"))
        and (cfg.get("BAIDU_OCR_SECRET_KEY") or cfg.get("BAIDU_SECRET_KEY"))
    )
    return {
        "enabled": enabled,
        "configured": has_ak,
        "timeout_sec": _timeout_sec(),
        "span_boxes": _want_span(),
        "hint": (
            "已启用 PaddleOCR-VL 增强"
            if enabled and has_ak
            else (
                "未启用：在 backend/.env.baidu 加 BAIDU_PADDLE_VL=1"
                if has_ak
                else "缺少 BAIDU_OCR_API_KEY/SECRET"
            )
        ),
    }
