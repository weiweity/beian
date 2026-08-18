"""飞书个人推送 · 调用本机 lark-cli"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any

from app import config


def _lark_bin() -> str | None:
    return shutil.which("lark-cli")


def push_status() -> dict[str, Any]:
    oid = config.get("FEISHU_OPEN_ID")
    return {
        "enabled": config.truthy("FEISHU_ENABLED", True) and bool(oid),
        "open_id_set": bool(oid),
        "display_name": config.get("FEISHU_DISPLAY_NAME") or "",
        "as": config.get("FEISHU_AS") or "bot",
        "lark_cli": bool(_lark_bin()),
    }


def send_text(text: str) -> dict[str, Any]:
    if not config.truthy("FEISHU_ENABLED", True):
        return {"ok": False, "skipped": True, "reason": "FEISHU_ENABLED=false"}
    open_id = config.get("FEISHU_OPEN_ID")
    if not open_id:
        return {"ok": False, "skipped": True, "reason": "missing FEISHU_OPEN_ID"}
    bin_path = _lark_bin()
    if not bin_path:
        return {"ok": False, "error": "lark-cli not found"}

    as_who = config.get("FEISHU_AS") or "bot"
    env = os.environ.copy()
    env["LARKSUITE_CLI_NO_UPDATE_NOTIFIER"] = "1"
    env["LARKSUITE_CLI_NO_SKILLS_NOTIFIER"] = "1"
    # 截断防过长
    body = text if len(text) <= 3500 else text[:3400] + "\n…(截断)"
    cmd = [
        bin_path,
        "im",
        "+messages-send",
        "--as",
        as_who,
        "--user-id",
        open_id,
        "--text",
        body,
        "--json",
    ]
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=45,
            env=env,
        )
        out = (r.stdout or "").strip()
        err = (r.stderr or "").strip()
        payload: dict[str, Any] = {}
        if out:
            try:
                payload = json.loads(out)
            except Exception:
                payload = {"raw": out[:500]}
        ok = r.returncode == 0 and (
            payload.get("ok") is True or payload.get("ok") is None and r.returncode == 0
        )
        # lark envelope
        if isinstance(payload, dict) and "ok" in payload:
            ok = bool(payload["ok"])
        return {
            "ok": ok,
            "returncode": r.returncode,
            "data": payload.get("data") if isinstance(payload, dict) else None,
            "error": None if ok else (payload.get("error") if isinstance(payload, dict) else err or out),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "lark-cli timeout"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def notify_task_complete(task: dict[str, Any], actor: str) -> dict[str, Any]:
    s = task.get("summary") or {}
    issues = [
        h
        for h in (task.get("hits") or [])
        if h.get("decision") == "issue"
        or (h.get("status") in ("疑点", "缺失") and h.get("decision") not in ("confirm", "ignore"))
    ]
    issue_lines = []
    for h in issues[:12]:
        issue_lines.append(f"· [{h.get('status')}] {h.get('field')} → {h.get('decision')}")
    more = f"\n…另有 {len(issues) - 12} 条" if len(issues) > 12 else ""
    text = (
        f"【备案审核】终审完成\n"
        f"任务：{task.get('title')}\n"
        f"ID：{task.get('id')}\n"
        f"审核人：{actor}\n"
        f"汇总：一致 {s.get('一致', 0)} · 疑点 {s.get('疑点', 0)} · 缺失 {s.get('缺失', 0)}\n"
        f"人审标为问题：{sum(1 for h in (task.get('hits') or []) if h.get('decision') == 'issue')} 条\n"
        + ("\n".join(issue_lines) + more if issue_lines else "（无待关注 issue 列表）")
        + f"\n报告：http://127.0.0.1:8787/api/tasks/{task.get('id')}/report"
    )
    return send_text(text)


def notify_task_created(task: dict[str, Any], actor: str) -> dict[str, Any]:
    s = task.get("summary") or {}
    warn = int(s.get("疑点") or 0) + int(s.get("缺失") or 0)
    text = (
        f"【备案审核】新任务已创建\n"
        f"任务：{task.get('title')}\n"
        f"ID：{task.get('id')}\n"
        f"创建人：{actor}\n"
        f"归属：{task.get('owner') or actor}\n"
        f"引擎：{task.get('engine')}\n"
        f"汇总：一致 {s.get('一致', 0)} · 疑点 {s.get('疑点', 0)} · 缺失 {s.get('缺失', 0)}\n"
        f"{'⚠ 有 ' + str(warn) + ' 条需人审' if warn else '全部一致，仍请抽检'}\n"
        f"打开：http://127.0.0.1:8787/"
    )
    return send_text(text)


def notify_report_archive(
    task: dict[str, Any], actor: str, *, pdf_path: str = ""
) -> dict[str, Any]:
    """归档通知：报告链接 + 本机 PDF 路径（飞书无法直接收任意本地文件时用文字）"""
    s = task.get("summary") or {}
    tid = task.get("id")
    text = (
        f"【备案审核】报告归档\n"
        f"任务：{task.get('title')}\n"
        f"ID：{tid}\n"
        f"操作人：{actor}\n"
        f"状态：{task.get('status')}\n"
        f"汇总：一致 {s.get('一致', 0)} · 疑点 {s.get('疑点', 0)} · 缺失 {s.get('缺失', 0)}\n"
        f"HTML：http://127.0.0.1:8787/api/tasks/{tid}/report\n"
        f"PDF：http://127.0.0.1:8787/api/tasks/{tid}/report.pdf\n"
        + (f"本机文件：{pdf_path}\n" if pdf_path else "")
        + "请在内网浏览器下载 PDF 归档。"
    )
    return send_text(text)
