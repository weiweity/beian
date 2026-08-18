"""
百度智能云 · 文字识别 OCR

默认：accurate（高精度含位置）— 支持图上高亮
也可用 accurate_basic（无位置，更便宜）

文档：https://ai.baidu.com/ai-doc/OCR/1k3h7y3db · tk3h7y2aq
"""
from __future__ import annotations

import base64
import os
import time
import urllib.parse
from pathlib import Path

import httpx

TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token"
OCR_URLS = {
    "accurate_basic": "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic",
    "accurate": "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate",
    "general_basic": "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic",
    "general": "https://aip.baidubce.com/rest/2.0/ocr/v1/general",
    "qrcode": "https://aip.baidubce.com/rest/2.0/ocr/v1/qrcode",
}

_token_cache: dict = {"token": None, "expires_at": 0.0}


def load_baidu_env(env_path: Path | None = None) -> dict[str, str]:
    path = env_path or Path(__file__).resolve().parent.parent / ".env.baidu"
    data: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            data[k.strip()] = v.strip().strip('"').strip("'")
    for k in (
        "BAIDU_OCR_API_KEY",
        "BAIDU_OCR_SECRET_KEY",
        "BAIDU_OCR_APP_ID",
        "BAIDU_OCR_API",
        "BAIDU_PADDLE_VL",
        "BAIDU_PADDLE_VL_TIMEOUT",
        "BAIDU_PADDLE_VL_SPAN",
    ):
        if os.environ.get(k):
            data[k] = os.environ[k]
    return data


def get_access_token(api_key: str, secret_key: str, force: bool = False) -> str:
    now = time.time()
    if (
        not force
        and _token_cache["token"]
        and now < float(_token_cache["expires_at"]) - 60
    ):
        return str(_token_cache["token"])

    params = {
        "grant_type": "client_credentials",
        "client_id": api_key,
        "client_secret": secret_key,
    }
    with httpx.Client(timeout=30.0) as client:
        r = client.post(TOKEN_URL, params=params)
        r.raise_for_status()
        body = r.json()
    if "access_token" not in body:
        raise RuntimeError(f"获取 access_token 失败: {body}")
    _token_cache["token"] = body["access_token"]
    _token_cache["expires_at"] = now + float(body.get("expires_in", 2592000))
    return str(body["access_token"])


def ocr_image_bytes(
    png_or_jpg: bytes,
    *,
    api: str | None = None,
    with_location: bool = True,
    paragraph: bool = True,
) -> tuple[str, list[dict], dict]:
    """
    返回 (全文, words[{text,location,page,paragraph_id?}], meta)

    location: {left, top, width, height} 像素，相对本图

    paragraph=True（默认）：请求百度段落信息。
    百度 accurate/general 支持 paragraph=true，返回 paragraphs_result：
      [{ "words_result_idx": [0,1,2] }, ...]  — 行序号聚类成段（版面几何，非深度语义）。
    各 word 会打 paragraph_id / para_source=baidu。
    """
    cfg = load_baidu_env()
    ak = cfg.get("BAIDU_OCR_API_KEY") or ""
    sk = cfg.get("BAIDU_OCR_SECRET_KEY") or ""
    # 要坐标必须用 accurate / general
    default_api = "accurate" if with_location else "accurate_basic"
    api_name = api or cfg.get("BAIDU_OCR_API") or default_api
    if with_location and api_name.endswith("_basic"):
        api_name = "accurate"
    # 环境变量可关段落：BAIDU_OCR_PARAGRAPH=0
    env_para = (cfg.get("BAIDU_OCR_PARAGRAPH") or os.environ.get("BAIDU_OCR_PARAGRAPH") or "").strip()
    if env_para in ("0", "false", "False", "no"):
        paragraph = False
    if not ak or not sk:
        raise RuntimeError("未配置百度 OCR：backend/.env.baidu")
    if api_name not in OCR_URLS:
        raise ValueError(f"未知 API {api_name}")

    token = get_access_token(ak, sk)
    url = f"{OCR_URLS[api_name]}?access_token={urllib.parse.quote(token)}"
    img_b64 = base64.b64encode(png_or_jpg).decode("ascii")
    data = {
        "image": img_b64,
        "detect_direction": "true",
        # 行业：先版面成段再比对；百度给出行→段索引
        "paragraph": "true" if paragraph else "false",
        # 开启字级置信度：低置信 → 审核「看不清」而非硬「缺失」
        "probability": "true",
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    body = {}
    last_err: Exception | None = None
    for trust in (True, False):
        try:
            with httpx.Client(timeout=httpx.Timeout(90.0, connect=20.0), trust_env=trust) as client:
                r = client.post(url, data=data, headers=headers)
                r.raise_for_status()
                body = r.json()
            last_err = None
            break
        except Exception as e:
            last_err = e
            continue
    if last_err and not body:
        raise RuntimeError(f"百度 OCR 网络失败: {last_err}") from last_err

    if body.get("error_code"):
        raise RuntimeError(
            f"百度 OCR 错误 {body.get('error_code')}: {body.get('error_msg')}"
        )

    words: list[dict] = []
    lines: list[str] = []
    probs: list[float] = []
    for item in body.get("words_result") or []:
        w = item.get("words")
        if not w:
            continue
        lines.append(str(w))
        loc = item.get("location") or {}
        # probability: {average, variance, min} 或 直接 float
        pr = item.get("probability")
        avg_p = None
        min_p = None
        if isinstance(pr, dict):
            try:
                avg_p = float(pr.get("average")) if pr.get("average") is not None else None
            except Exception:
                avg_p = None
            try:
                min_p = float(pr.get("min")) if pr.get("min") is not None else None
            except Exception:
                min_p = None
        elif pr is not None:
            try:
                avg_p = float(pr)
                min_p = avg_p
            except Exception:
                pass
        if avg_p is not None:
            probs.append(avg_p)
        words.append(
            {
                "text": str(w),
                "location": {
                    "left": int(loc.get("left") or 0),
                    "top": int(loc.get("top") or 0),
                    "width": int(loc.get("width") or 0),
                    "height": int(loc.get("height") or 0),
                },
                "prob_avg": avg_p,
                "prob_min": min_p,
                "line_index": len(words),  # words_result 序号，供 paragraphs 索引
            }
        )

    # 百度段落：words_result_idx → 行聚段（版面聚类，非语义 embedding）
    paragraphs_raw = body.get("paragraphs_result") or []
    paragraphs: list[dict] = []
    for pi, para in enumerate(paragraphs_raw):
        clean_idxs: list[int] = []
        for i in para.get("words_result_idx") or []:
            try:
                clean_idxs.append(int(i))
            except Exception:
                continue
        texts: list[str] = []
        for idx in clean_idxs:
            if 0 <= idx < len(words):
                words[idx]["paragraph_id"] = pi
                words[idx]["para_source"] = "baidu"
                texts.append(words[idx].get("text") or "")
        joined = _join_cn_line_parts(texts)
        if joined:
            paragraphs.append(
                {
                    "id": pi,
                    "source": "baidu",
                    "line_idxs": clean_idxs,
                    "text": joined,
                    "line_count": len(clean_idxs),
                }
            )

    # 段落全文：段间换行，段内已粘连 → 下游跨行问题更少
    if paragraphs:
        text = "\n".join(p["text"] for p in paragraphs)
    else:
        text = "\n".join(lines)
    meta = {
        "api": api_name,
        "words_result_num": body.get("words_result_num", len(words)),
        "log_id": body.get("log_id"),
        "probability": bool(probs),
        "prob_mean": round(sum(probs) / len(probs), 4) if probs else None,
        "prob_min": round(min(probs), 4) if probs else None,
        "paragraph_requested": bool(paragraph),
        "paragraphs_result_num": body.get("paragraphs_result_num", len(paragraphs)),
        "paragraphs": paragraphs,
        "paragraph_source": "baidu" if paragraphs else None,
    }
    return text, words, meta


def _join_cn_line_parts(parts: list[str]) -> str:
    """段内多行拼接：中文去空格，英文保留空格。"""
    import re

    raw = []
    for t in parts:
        t = (t or "").strip()
        if t:
            raw.append(t)
    if not raw:
        return ""
    s = "".join(raw)
    # 若原行间本该有空格（纯英文词），用空格连接更稳
    if all(re.fullmatch(r"[A-Za-z0-9\s\.\-/%]+", p or "") for p in raw):
        s = " ".join(raw)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", s)
    s = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[①②③④⑤⑥⑦⑧⑨⑩\d])", "", s)
    s = re.sub(r"(?<=[①②③④⑤⑥⑦⑧⑨⑩\d])\s+(?=[\u4e00-\u9fff])", "", s)
    return s


def qrcode_image_bytes(png_or_jpg: bytes) -> tuple[list[dict], dict]:
    """
    二维码识别。
    返回 (codes[{text, location}], meta)
    文档：https://ai.baidu.com/ai-doc/OCR/qk3h7y5o7
    """
    cfg = load_baidu_env()
    ak = cfg.get("BAIDU_OCR_API_KEY") or ""
    sk = cfg.get("BAIDU_OCR_SECRET_KEY") or ""
    if not ak or not sk:
        raise RuntimeError("未配置百度 OCR：backend/.env.baidu")
    token = get_access_token(ak, sk)
    url = f"{OCR_URLS['qrcode']}?access_token={urllib.parse.quote(token)}"
    img_b64 = base64.b64encode(png_or_jpg).decode("ascii")
    data = {"image": img_b64}
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    body = {}
    last_err: Exception | None = None
    for trust in (True, False):
        try:
            with httpx.Client(timeout=httpx.Timeout(60.0, connect=20.0), trust_env=trust) as client:
                r = client.post(url, data=data, headers=headers)
                body = r.json() if r.content else {}
            last_err = None
            break
        except Exception as e:
            last_err = e
            continue
    if last_err and not body:
        raise RuntimeError(f"百度二维码网络失败: {last_err}") from last_err
    if body.get("error_code"):
        raise RuntimeError(
            f"百度二维码识别错误 {body.get('error_code')}: {body.get('error_msg')}"
        )
    codes: list[dict] = []
    # 兼容 codes_result / words_result 等字段
    for item in body.get("codes_result") or body.get("words_result") or []:
        if isinstance(item, str):
            codes.append({"text": item, "location": {}})
            continue
        text = (
            item.get("text")
            or item.get("words")
            or (item.get("text_url") if isinstance(item.get("text_url"), str) else None)
            or ""
        )
        if isinstance(item.get("text"), list):
            text = "\n".join(str(x) for x in item["text"])
        loc = item.get("location") or {}
        # 有的返回 vertexes_location
        if not loc and item.get("vertexes_location"):
            pts = item["vertexes_location"]
            try:
                xs = [int(p.get("x", 0)) for p in pts]
                ys = [int(p.get("y", 0)) for p in pts]
                loc = {
                    "left": min(xs),
                    "top": min(ys),
                    "width": max(xs) - min(xs),
                    "height": max(ys) - min(ys),
                }
            except Exception:
                loc = {}
        if text:
            codes.append(
                {
                    "text": str(text),
                    "location": {
                        "left": int(loc.get("left") or 0),
                        "top": int(loc.get("top") or 0),
                        "width": int(loc.get("width") or 0),
                        "height": int(loc.get("height") or 0),
                    },
                }
            )
    meta = {
        "api": "qrcode",
        "codes_result_num": body.get("codes_result_num", len(codes)),
        "log_id": body.get("log_id"),
    }
    return codes, meta


def ping_baidu() -> dict:
    cfg = load_baidu_env()
    ak = cfg.get("BAIDU_OCR_API_KEY") or ""
    sk = cfg.get("BAIDU_OCR_SECRET_KEY") or ""
    if not ak or not sk:
        return {"ok": False, "error": "missing AK/SK"}
    token = get_access_token(ak, sk, force=True)
    return {
        "ok": True,
        "app_id": cfg.get("BAIDU_OCR_APP_ID"),
        "api": cfg.get("BAIDU_OCR_API") or "accurate",
        "token_prefix": token[:12] + "...",
        "capabilities": ["accurate", "qrcode", "textdiff"],
    }
