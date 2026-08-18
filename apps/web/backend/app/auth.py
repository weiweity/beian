"""显示名登录 · 角色（admin / reviewer / viewer）· session 落盘"""
from __future__ import annotations

import json
import secrets
import time
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote

from fastapi import Header, HTTPException


def _decode_actor_header(raw: str | None) -> str:
    """X-Actor 可能是 encodeURIComponent 后的中文"""
    # 防止误把 FastAPI Header() 默认对象当字符串传入
    if raw is None or not isinstance(raw, str):
        return ""
    s = raw.strip()
    if not s:
        return ""
    try:
        s = unquote(s)
    except Exception:
        pass
    return s[:40]

SESSIONS: dict[str, dict[str, Any]] = {}
SESSION_TTL_SEC = 7 * 24 * 3600

Role = Literal["admin", "reviewer", "viewer"]

# 权限矩阵
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
    {"name": "审核员", "role": "reviewer", "note": "默认可审"},
    {"name": "魏炜", "role": "reviewer", "note": ""},
    {"name": "只读", "role": "viewer", "note": "仅查看导出"},
    {"name": "访客", "role": "viewer", "note": ""},
]


def _sessions_path(data_dir: Path) -> Path:
    return data_dir / "sessions.json"


def _users_path(data_dir: Path) -> Path:
    return data_dir / "users.json"


def load_sessions(data_dir: Path) -> None:
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
    p.write_text(json.dumps(SESSIONS, ensure_ascii=False, indent=2), encoding="utf-8")


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
        {"name": u.get("name"), "role": u.get("role") or "reviewer", "note": u.get("note") or ""}
        for u in ensure_users_file(data_dir)
        if u.get("name")
    ]


def resolve_role(display_name: str, data_dir: Path) -> str:
    name = (display_name or "").strip()
    for u in ensure_users_file(data_dir):
        if str(u.get("name") or "").strip() == name:
            role = str(u.get("role") or "reviewer").lower()
            if role in ROLE_PERMS:
                return role
            return "reviewer"
    # 未知显示名：默认可审（便于本地试用），viewer 需显式登记
    return "reviewer"


def has_perm(role: str, perm: str) -> bool:
    return perm in ROLE_PERMS.get(role or "viewer", set())


def create_session(display_name: str, data_dir: Path) -> dict[str, Any]:
    name = (display_name or "").strip()
    if not name or len(name) > 40:
        raise HTTPException(400, "显示名 1–40 字")
    # 可选：仅允许登记用户（AUTH_REQUIRE_KNOWN=true）
    from app import config

    if config.truthy("AUTH_REQUIRE_KNOWN", False):
        known = {str(u.get("name") or "").strip() for u in ensure_users_file(data_dir)}
        if name not in known:
            raise HTTPException(403, f"未登记用户「{name}」，请联系管理员加入 users.json")

    role = resolve_role(name, data_dir)
    token = secrets.token_urlsafe(24)
    now = time.time()
    sess = {
        "token": token,
        "display_name": name,
        "role": role,
        "created_at": now,
        "expires_at": now + SESSION_TTL_SEC,
    }
    SESSIONS[token] = sess
    save_sessions(data_dir)
    return {
        "token": token,
        "display_name": name,
        "role": role,
        "perms": sorted(ROLE_PERMS.get(role, set())),
        "expires_at": sess["expires_at"],
    }


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


def require_actor(
    authorization: str | None = Header(default=None),
    x_actor: str | None = Header(default=None, alias="X-Actor"),
) -> str:
    s = get_session(authorization)
    if s:
        return str(s["display_name"])
    decoded = _decode_actor_header(x_actor)
    if decoded:
        return decoded
    return "匿名"


def session_context(
    authorization: str | None,
    data_dir: Path,
    *,
    body_actor: str | None = None,
    x_actor: str | None = None,
) -> dict[str, Any]:
    """统一解析当前操作人 + 角色"""
    s = get_session(authorization)
    if s:
        role = s.get("role") or resolve_role(str(s["display_name"]), data_dir)
        return {
            "name": str(s["display_name"]),
            "role": role,
            "logged_in": True,
            "perms": sorted(ROLE_PERMS.get(role, set())),
        }
    name = (body_actor or _decode_actor_header(x_actor) or "匿名").strip()[:40] or "匿名"
    role = resolve_role(name, data_dir) if name != "匿名" else "viewer"
    return {
        "name": name,
        "role": role,
        "perms": sorted(ROLE_PERMS.get(role, set())),
        "logged_in": False,
    }


def require_perm(
    authorization: str | None,
    data_dir: Path,
    perm: str,
    *,
    body_actor: str | None = None,
    x_actor: str | None = None,
) -> dict[str, Any]:
    ctx = session_context(authorization, data_dir, body_actor=body_actor, x_actor=x_actor)
    if not has_perm(ctx["role"], perm):
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
