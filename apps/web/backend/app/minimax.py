"""
MiniMax-M3 · 语义复核层（OpenAI 兼容 Chat Completions）

职责：对 OCR+规则判为「疑点/缺失」的字段做二次语义判断。
不替代百度 OCR 坐标；不自动过审。
"""
from __future__ import annotations

import json
import re
from typing import Any

import httpx

from app import config

# 国内常见：api.minimaxi.com；国际：api.minimax.io
DEFAULT_BASES = (
    "https://api.minimaxi.com/v1",
    "https://api.minimax.io/v1",
)


def status() -> dict[str, Any]:
    key = config.get("MINIMAX_API_KEY")
    return {
        "configured": bool(key),
        "model": config.get("MINIMAX_MODEL") or "MiniMax-M3",
        "base_url": config.get("MINIMAX_BASE_URL") or DEFAULT_BASES[0],
        "wired": True,
    }


def _bases() -> list[str]:
    primary = (config.get("MINIMAX_BASE_URL") or DEFAULT_BASES[0]).rstrip("/")
    out = [primary]
    for b in DEFAULT_BASES:
        if b.rstrip("/") not in out:
            out.append(b.rstrip("/"))
    return out


def chat(
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.2,
    max_tokens: int = 8192,
) -> tuple[str, dict[str, Any]]:
    """返回 (assistant_text, meta)。meta 含 finish_reason / usage。"""
    key = config.get("MINIMAX_API_KEY")
    if not key:
        raise RuntimeError("未配置 MINIMAX_API_KEY（backend/.env.secrets）")
    model = config.get("MINIMAX_MODEL") or "MiniMax-M3"
    last_err: Exception | None = None
    for base in _bases():
        url = f"{base}/chat/completions"
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        try:
            # trust_env=False：避免本机 SOCKS 代理缺 socksio 时整段失败；
            # 若直连失败再带代理重试。
            clients = [
                httpx.Client(timeout=120.0, trust_env=False),
                httpx.Client(timeout=120.0, trust_env=True),
            ]
            body = None
            for client in clients:
                try:
                    with client:
                        r = client.post(
                            url,
                            headers={
                                "Authorization": f"Bearer {key}",
                                "Content-Type": "application/json",
                            },
                            json=payload,
                        )
                        body = r.json() if r.content else {}
                        if r.status_code >= 400:
                            last_err = RuntimeError(
                                f"{base} HTTP {r.status_code}: {body or r.text[:300]}"
                            )
                            body = None
                            continue
                        break
                except Exception as e:
                    last_err = e
                    body = None
                    continue
            if not body:
                continue
            choices = body.get("choices") or []
            if not choices:
                last_err = RuntimeError(f"{base} 无 choices: {body}")
                continue
            choice0 = choices[0] or {}
            msg = choice0.get("message") or {}
            text = msg.get("content") or ""
            # M3 可能夹带 <think>…</think>
            text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.I).strip()
            if not text:
                # 部分返回把结论放 reasoning 字段
                text = (msg.get("reasoning") or msg.get("reasoning_content") or "").strip()
            finish = (
                choice0.get("finish_reason")
                or choice0.get("finish_details")
                or body.get("finish_reason")
                or ""
            )
            if isinstance(finish, dict):
                finish = str(finish.get("type") or finish.get("reason") or "")
            return text, {
                "model": body.get("model") or model,
                "base_url": base,
                "usage": body.get("usage"),
                "id": body.get("id"),
                "finish_reason": str(finish or ""),
                "max_tokens": max_tokens,
            }
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"MiniMax 调用失败: {last_err}")


def _repair_json_text(blob: str) -> str:
    """截断 JSON 的轻量修补：补全未闭合引号/括号。"""
    s = (blob or "").strip()
    if not s:
        return s
    # 去掉尾部不完整的 key/value 碎片（逗号后无完整对）
    s = re.sub(r",\s*(\"[^\"]*\"?\s*:)?\s*$", "", s)
    # 未闭合字符串
    if s.count('"') % 2 == 1:
        s += '"'
    # 补 ] }
    open_sq = s.count("[") - s.count("]")
    open_cu = s.count("{") - s.count("}")
    if open_sq > 0:
        s += "]" * open_sq
    if open_cu > 0:
        s += "}" * open_cu
    return s


def _extract_json(text: str) -> Any:
    text = (text or "").strip()
    if not text:
        return None
    candidates: list[str] = [text]
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m:
        candidates.insert(0, m.group(1).strip())
    i, j = text.find("{"), text.rfind("}")
    if i >= 0 and j > i:
        candidates.append(text[i : j + 1])
    i2, j2 = text.find("["), text.rfind("]")
    if i2 >= 0 and j2 > i2:
        candidates.append(text[i2 : j2 + 1])
    # 截断场景：只有开头 {
    if i >= 0 and (j < i or j < 0):
        candidates.append(text[i:])
    for raw in candidates:
        for attempt in (raw, _repair_json_text(raw)):
            if not attempt:
                continue
            try:
                return json.loads(attempt)
            except Exception:
                continue
    # 捞 reviews 数组残片 / 截断中的完整对象
    m = re.search(r'"reviews"\s*:\s*(\[[\s\S]*)', text)
    if m:
        arr = _repair_json_text(m.group(1))
        try:
            parsed = json.loads(arr)
            if isinstance(parsed, list):
                return {"reviews": parsed}
        except Exception:
            pass
        # 逐个完整 {...} 对象
        objs = re.findall(r"\{[^{}]*\"id\"[^{}]*\}", m.group(1))
        recovered = []
        for o in objs:
            try:
                recovered.append(json.loads(o))
            except Exception:
                try:
                    recovered.append(json.loads(_repair_json_text(o)))
                except Exception:
                    continue
        if recovered:
            return {"reviews": recovered}
    return None


SYSTEM_PROMPT = """你是化妆品/护肤品包装备案文案审核助手（Text Verification 复核层）。
工作台已用 OCR+规则做了字段匹配；你只对「疑点/缺失」做语义复核，不替代人审。

护肤品行业隐性规则（必须遵守）：
1. 确认单常写「多规格」（5片+单片、30ml+95ml），包装往往只印当前装：
   - 净含量/条码：包装命中其中一种装型 → 建议 confirm（一致），reason 写清「多规格分支」。
   - 全部装型都找不到 → 疑点/缺失。
2. 成分表（INCI）：允许换行、顿号/逗号、全半角、拉丁名大小写；OCR 易把「（」粘连、漏 1–2 个微量成分。
   - 主成分类似且仅微量 OCR 噪声 → 可 confirm 或 pending，不要因 1 个拉丁名断字就 issue。
   - 明显整段缺失/步骤01与02颠倒 → issue。
3. 文案/卖点：漏字、错字（如「光感能」缺「焕」）→ issue；仅标点/空格 → confirm。
4. 使用方法：①②③④ 主体在即可；「洽询/治询」等 OCR 形近字 → pending 让人看图。
5. 【反向】包装有确认单无：若内容像成分碎片/工艺表/OCR 乱码 → confirm 或 pending 并说明噪声；
   若是清晰多出来的功效卖点/错误品名 → issue。
6. 二维码：有「公众号/译龄/扫码」引导即 confirm，勿因缺「扫码关注」四字判疑点；二维码是图形，不是长文案。
7. 禁止替人终审；suggested_decision 仅建议。
8. 只输出 JSON，不要 Markdown、不要思考过程。
9. reason 每条不超过 40 字；reviews 数组必须完整闭合。

输出格式（严格，字段勿增删）：
{"reviews":[{"id":"字段id","verdict":"一致|疑点|缺失","confidence":0.9,"reason":"一句话","suggested_decision":"confirm|issue|pending"}]}

suggested_decision：confirm=建议确认一致；issue=建议标为问题；pending=仍需人看图。"""


def _normalize_reviews(reviews: list, targets: list[dict]) -> list[dict]:
    by_id = {str(t["id"]): t for t in targets}
    clean = []
    for r in reviews:
        if not isinstance(r, dict):
            continue
        vid = str(r.get("id") or "")
        verdict = str(r.get("verdict") or "疑点")
        if verdict not in ("一致", "疑点", "缺失"):
            verdict = "疑点"
        conf = r.get("confidence")
        try:
            conf = float(conf)
        except Exception:
            conf = 0.5
        conf = max(0.0, min(1.0, conf))
        sug = str(r.get("suggested_decision") or "pending")
        if sug not in ("confirm", "issue", "pending", "ignore"):
            sug = "pending"
        clean.append(
            {
                "id": vid,
                "verdict": verdict,
                "confidence": conf,
                "reason": str(r.get("reason") or "")[:500],
                "suggested_decision": sug,
            }
        )
    # 补全模型漏掉的 id
    got = {c["id"] for c in clean}
    for t in targets:
        tid = str(t["id"])
        if tid not in got:
            clean.append(
                {
                    "id": tid,
                    "verdict": t.get("status") or "疑点",
                    "confidence": 0.3,
                    "reason": "模型未返回该字段结论",
                    "suggested_decision": "pending",
                }
            )
    return clean


def _fallback_reviews(
    targets: list[dict], *, reason: str
) -> list[dict]:
    return [
        {
            "id": t["id"],
            "verdict": t.get("status") or "疑点",
            "confidence": 0.3,
            "reason": reason,
            "suggested_decision": "pending",
        }
        for t in targets
    ]


def _review_batch(
    targets: list[dict],
    *,
    ocr_snip: str,
    task_title: str,
    task_note: str,
    max_tokens: int = 4096,
) -> tuple[list[dict], dict[str, Any], str]:
    """单批调用；解析失败时缩字段重试一次。"""
    user = {
        "task_title": task_title,
        "task_note": task_note or "",
        "fields_to_review": targets,
        "packaging_ocr_text": ocr_snip,
    }
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": "请复核下列字段，只输出完整 JSON（reviews 必须闭合）：\n"
            + json.dumps(user, ensure_ascii=False),
        },
    ]
    text, meta = chat(messages, max_tokens=max_tokens)
    parsed = _extract_json(text)
    usage = meta.get("usage") or {}
    finish = str(meta.get("finish_reason") or "")
    comp = int(usage.get("completion_tokens") or 0)
    hit_cap = finish in ("length", "max_tokens") or (
        max_tokens > 0 and comp >= max_tokens - 8
    )

    reviews: list[dict] = []
    if isinstance(parsed, dict) and isinstance(parsed.get("reviews"), list):
        reviews = parsed["reviews"]
    elif isinstance(parsed, list):
        reviews = parsed

    if not reviews and (hit_cap or not parsed):
        # 重试：更高 token + 更短 OCR + 强制短 reason
        slim = []
        for t in targets:
            slim.append(
                {
                    "id": t.get("id"),
                    "field": t.get("field"),
                    "excel_value": (t.get("excel_value") or "")[:280],
                    "status": t.get("status"),
                    "score": t.get("score"),
                    "evidence": (t.get("evidence") or "")[:120],
                }
            )
        user2 = {
            "task_title": task_title,
            "task_note": (task_note or "") + " reason≤30字。必须输出完整可解析 JSON。",
            "fields_to_review": slim,
            "packaging_ocr_text": ocr_snip[:3500],
        }
        messages2 = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "只输出 JSON：\n" + json.dumps(user2, ensure_ascii=False),
            },
        ]
        text2, meta2 = chat(messages2, max_tokens=max(max_tokens, 6144))
        parsed2 = _extract_json(text2)
        meta = {**meta, "retry": meta2, "retried": True}
        text = text2
        if isinstance(parsed2, dict) and isinstance(parsed2.get("reviews"), list):
            reviews = parsed2["reviews"]
        elif isinstance(parsed2, list):
            reviews = parsed2
        usage = (meta2.get("usage") or usage)
        finish = str(meta2.get("finish_reason") or finish)
        comp = int(usage.get("completion_tokens") or 0)
        hit_cap = finish in ("length", "max_tokens") or (
            int(meta2.get("max_tokens") or max_tokens) > 0
            and comp >= int(meta2.get("max_tokens") or max_tokens) - 8
        )

    if not reviews:
        if hit_cap:
            reason = f"模型输出被截断(finish={finish or 'length'}, tokens≈{comp})，请人审或重试"
        else:
            reason = "模型未返回可解析 JSON，请人审"
        reviews = _fallback_reviews(targets, reason=reason)
        meta = {**meta, "parse_failed": True, "hit_token_cap": hit_cap}

    return reviews, meta, text


def review_hits(
    hits: list[dict[str, Any]],
    *,
    ocr_text: str = "",
    task_title: str = "",
    task_note: str = "",
    only_uncertain: bool = True,
    batch_size: int = 0,
    max_tokens: int = 0,
) -> dict[str, Any]:
    """
    对 hit 列表做语义复核。
    batch_size>0 时分批（L3 漏字建议 2）；默认 L2 整批。
    返回 {reviews: [...], meta: {...}, raw: str}
    """
    targets = []
    for h in hits:
        if only_uncertain and h.get("status") not in ("疑点", "缺失"):
            continue
        # 二维码：L1 已有引导/品牌时不进语义纠结
        fg = h.get("field_group") or ""
        field = h.get("field") or ""
        if fg == "二维码" or "二维码" in field:
            if float(h.get("score") or 0) >= 88:
                continue
        targets.append(
            {
                "id": h.get("id"),
                "field": h.get("field"),
                "excel_value": (h.get("excel_value") or "")[:800],
                "status": h.get("status"),
                "score": h.get("score"),
                "evidence": h.get("evidence"),
                "page": h.get("page"),
            }
        )
    if not targets:
        return {
            "reviews": [],
            "meta": {"skipped": True, "reason": "无疑点/缺失需要复核"},
            "raw": "",
        }

    ocr_snip = (ocr_text or "")[:6000]
    bs = batch_size if batch_size and batch_size > 0 else len(targets)
    tok = max_tokens if max_tokens and max_tokens > 0 else 8192
    # 大批量时略收 token 每批，避免一次打满
    if bs < len(targets):
        tok = max(tok, 4096)

    all_reviews: list[dict] = []
    metas: list[dict] = []
    raws: list[str] = []
    for i in range(0, len(targets), bs):
        chunk = targets[i : i + bs]
        # 每批按字段数给足 completion
        per_tok = min(8192, max(2048, 900 * len(chunk) + 512))
        if max_tokens and max_tokens > 0:
            per_tok = max(per_tok, max_tokens // max(1, (len(targets) + bs - 1) // bs))
        revs, meta, text = _review_batch(
            chunk,
            ocr_snip=ocr_snip,
            task_title=task_title,
            task_note=task_note,
            max_tokens=per_tok,
        )
        all_reviews.extend(revs)
        metas.append(meta)
        raws.append(text[:2000])

    clean = _normalize_reviews(all_reviews, targets)
    meta_out: dict[str, Any] = {
        "batches": len(metas),
        "batch_size": bs,
        "model": (metas[0] or {}).get("model") if metas else None,
        "base_url": (metas[0] or {}).get("base_url") if metas else None,
        "usage": (metas[0] or {}).get("usage") if metas else None,
        "batch_metas": metas,
        "parse_failed": any(m.get("parse_failed") for m in metas),
    }
    return {"reviews": clean, "meta": meta_out, "raw": "\n---\n".join(raws)[:4000]}
