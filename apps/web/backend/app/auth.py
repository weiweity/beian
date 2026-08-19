"""Session-only 身份。禁止 X-Actor / body.actor 提权。"""
from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException


SESSIONS: dict[str, dict[str, Any]] = {}
SESSION_TTL_SEC = 7 * 24 * 3600

Role = Literal["admin", "reviewer", "viewer"]

ROLE_PERMS: dict[str, set[str]] = {
    "admin": {
        "read",
        "create",
        "decide",
        "complete",
        "delete",
        "export",
        "backup",
        "archive",
        "ai_review",
        "manage_users",
    },
    "reviewer": {
        "read",
        "create",
        "decide",
        "complete",
        "delete",
        "export",
        "archive",
        "ai_review",
    },
    "viewer": {"read", "export"},
}

DEFAULT_USERS: list[dict[str, Any]] = [
    {"name": "管理员", "role": "admin", "note": "可备份/管理"},
    {"name": "审核员", "role": "reviewer", "note": "本机显示名"},
    {"name": "魏炜", "role": "reviewer", "note": ""},
    {"name": "刘籽烨", "role": "reviewer", "note": "第一期验收人", "open_id": ""},
    {"name": "只读", "role": "viewer", "note": "仅查看导出"},
    {"name": "访客", "role": "viewer", "note": ""},
]


def _sessions_path(data_dir: Path) -> Path:
    return data_dir / "sessions.json"


def _users_path(data_dir: Path) -> Path:
    return data_dir / "users.json"


def load_sessions(data_dir: Path) -> None:
    SESSIONS.clear()
    p = _sessions_path(data_dir)
    if not p.exists():
        return
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        now = time.time()
        for tok, s in (raw or {}).items():
            if float(s.get("expires_at", 0)) > now:
                SESSIONS[tok] = s
    except Exception:
        pass


def save_sessions(data_dir: Path) -> None:
    p = _sessions_path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(SESSIONS, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass


def ensure_users_file(data_dir: Path) -> list[dict[str, Any]]:
    p = _users_path(data_dir)
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps({"users": DEFAULT_USERS}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return list(DEFAULT_USERS)
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        users = raw.get("users") if isinstance(raw, dict) else raw
        if not isinstance(users, list) or not users:
            return list(DEFAULT_USERS)
        return users
    except Exception:
        return list(DEFAULT_USERS)


def list_users(data_dir: Path) -> list[dict[str, Any]]:
    return [
        {
            "name": u.get("name"),
            "role": u.get("role") or "reviewer",
            "note": u.get("note") or "",
            "open_id_set": bool(str(u.get("open_id") or "").strip()),
        }
        for u in ensure_users_file(data_dir)
        if u.get("name")
    ]


def env_allow_open_ids() -> set[str]:
    from app import config

    raw = config.get("FEISHU_ALLOW_OPEN_IDS") or ""
    return {p.strip() for p in raw.split(",") if p.strip().startswith("ou_")}


def find_user_by_open_id(open_id: str, data_dir: Path) -> dict[str, Any] | None:
    oid = (open_id or "").strip()
    if not oid:
        return None
    for u in ensure_users_file(data_dir):
        if str(u.get("open_id") or "").strip() == oid:
            return u
    return None


def resolve_role(display_name: str, data_dir: Path) -> str | None:
    name = (display_name or "").strip()
    if not name:
        return None
    for u in ensure_users_file(data_dir):
        if str(u.get("name") or "").strip() == name:
            role = str(u.get("role") or "reviewer").lower()
            return role if role in ROLE_PERMS else "reviewer"
    return None


def has_perm(role: str, perm: str) -> bool:
    return perm in ROLE_PERMS.get(role or "", set())


def display_login_allowed() -> bool:
    from app import config

    if config.public_mode():
        return False
    return config.truthy("WB_DEV_DISPLAY_LOGIN", True)


def create_session(display_name: str, data_dir: Path) -> dict[str, Any]:
    if not display_login_allowed():
        raise HTTPException(410, "显示名登录已关闭。公网请用飞书身份。")
    name = (display_name or "").strip()
    if not name or len(name) > 40:
        raise HTTPException(400, "显示名 1–40 字")
    role = resolve_role(name, data_dir)
    if role is None:
        raise HTTPException(403, f"未登记用户「{name}」，请联系管理员加入 users.json")
    return issue_session(name, role, data_dir, source="display")


def issue_session(
    display_name: str,
    role: str,
    data_dir: Path,
    *,
    open_id: str = "",
    source: str = "display",
) -> dict[str, Any]:
    if role not in ROLE_PERMS:
        role = "reviewer"
    token = secrets.token_urlsafe(24)
    now = time.time()
    sess = {
        "token": token,
        "display_name": display_name,
        "role": role,
        "open_id": (open_id or "")[:64],
        "source": source,
        "created_at": now,
        "expires_at": now + SESSION_TTL_SEC,
    }
    SESSIONS[token] = sess
    save_sessions(data_dir)
    return {
        "token": token,
        "display_name": display_name,
        "role": role,
        "perms": sorted(ROLE_PERMS.get(role, set())),
        "expires_at": sess["expires_at"],
        "source": source,
    }


def session_from_feishu(open_id: str, feishu_name: str, data_dir: Path) -> dict[str, Any]:
    oid = (open_id or "").strip()
    if not oid.startswith("ou_"):
        raise HTTPException(403, "飞书身份无效")
    user = find_user_by_open_id(oid, data_dir)
    allowed = bool(user) or oid in env_allow_open_ids()
    if not allowed:
        raise HTTPException(
            403,
            f"这个飞书号不在白名单（open_id={oid}）。请管理员写入 users.json 的 open_id，或环境变量 FEISHU_ALLOW_OPEN_IDS。",
        )
    if user:
        name = str(user.get("name") or feishu_name or "飞书用户")[:40]
        role = str(user.get("role") or "reviewer").lower()
    else:
        name = (feishu_name or "飞书用户")[:40]
        role = "reviewer"
    return issue_session(name, role, data_dir, open_id=oid, source="feishu")


def get_session(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    s = SESSIONS.get(token)
    if not s:
        return None
    if float(s.get("expires_at", 0)) < time.time():
        SESSIONS.pop(token, None)
        return None
    return s


def session_context(authorization: str | None, data_dir: Path) -> dict[str, Any]:
    """只认 Bearer session。没有登录就是未登录，不能靠请求头冒充。"""
    s = get_session(authorization)
    if not s:
        return {
            "name": None,
            "role": None,
            "logged_in": False,
            "perms": [],
        }
    role = s.get("role") or resolve_role(str(s["display_name"]), data_dir) or "viewer"
    return {
        "name": str(s["display_name"]),
        "role": role,
        "logged_in": True,
        "perms": sorted(ROLE_PERMS.get(role, set())),
    }


def require_session(authorization: str | None, data_dir: Path) -> dict[str, Any]:
    ctx = session_context(authorization, data_dir)
    if not ctx["logged_in"]:
        raise HTTPException(401, "未登录")
    return ctx


def require_perm(authorization: str | None, data_dir: Path, perm: str) -> dict[str, Any]:
    ctx = require_session(authorization, data_dir)
    if not has_perm(str(ctx["role"] or ""), perm):
        raise HTTPException(
            403,
            f"角色「{ctx['role']}」无权限：{perm}（当前用户 {ctx['name']}）",
        )
    return ctx


def logout(token: str | None, data_dir: Path) -> bool:
    if not token:
        return False
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if token in SESSIONS:
        del SESSIONS[token]
        save_sessions(data_dir)
        return True
    return False
