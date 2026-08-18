"""飞书网页应用 OAuth 2.0。密钥只从环境读，不打印。"""
from __future__ import annotations

import os
import secrets
import ssl
import time
from typing import Any, Iterator
from urllib.parse import quote, urlencode

import httpx

from app import config

AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info"
# 须在开放平台「权限管理」用【用户身份】开通同名权限，否则授权页会 20027。
OAUTH_SCOPES = "contact:user.base:readonly"

_STATES: dict[str, float] = {}
STATE_TTL_SEC = 600


def public_base() -> str:
    raw = (config.get("WB_PUBLIC_BASE") or "https://www.jianghua.site").strip().rstrip("/")
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    return "https://" + raw


def app_id() -> str:
    return (config.get("FEISHU_APP_ID") or "cli_aa0ebd6422385ce0").strip()


def app_secret() -> str:
    return (config.get("FEISHU_APP_SECRET") or "").strip()


def redirect_uri() -> str:
    explicit = (config.get("FEISHU_REDIRECT_URI") or "").strip()
    if explicit:
        return explicit
    return public_base() + "/api/auth/feishu/callback"


def oauth_ready() -> bool:
    return bool(app_id() and app_secret())


def cookie_secure() -> bool:
    return public_base().startswith("https://")


def _purge_states() -> None:
    now = time.time()
    dead = [k for k, exp in _STATES.items() if exp < now]
    for k in dead:
        _STATES.pop(k, None)


def new_state() -> str:
    _purge_states()
    token = secrets.token_urlsafe(24)
    _STATES[token] = time.time() + STATE_TTL_SEC
    return token


def consume_state(state: str) -> bool:
    _purge_states()
    exp = _STATES.pop((state or "").strip(), None)
    return exp is not None and exp >= time.time()


def authorize_url() -> str:
    if not app_id():
        raise RuntimeError("未配置 FEISHU_APP_ID")
    params = {
        "client_id": app_id(),
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "state": new_state(),
        "scope": OAUTH_SCOPES,
    }
    return AUTHORIZE_URL + "?" + urlencode(params, quote_via=quote)


def exchange_code(code: str) -> dict[str, Any]:
    """用授权码换用户身份。不返回 access_token。"""
    secret = app_secret()
    if not secret:
        raise RuntimeError("未配置 FEISHU_APP_SECRET")
    code = (code or "").strip()
    if not code:
        raise RuntimeError("缺少授权码")
    payload = {
        "grant_type": "authorization_code",
        "client_id": app_id(),
        "client_secret": secret,
        "code": code,
        "redirect_uri": redirect_uri(),
    }
    r = _request("POST", TOKEN_URL, json=payload)
    body = r.json() if r.content else {}
    if r.status_code >= 400 or int(body.get("code") or 0) != 0:
        msg = body.get("error_description") or body.get("msg") or body.get("error") or "换票失败"
        raise RuntimeError(str(msg)[:200])
    data = body.get("data") if isinstance(body.get("data"), dict) else body
    open_id = str(
        data.get("open_id")
        or data.get("openid")
        or data.get("openId")
        or ""
    ).strip()
    name = str(data.get("name") or data.get("en_name") or "").strip()
    token = str(data.get("access_token") or "").strip()
    if (not open_id or not name) and token:
        info = _user_info(token)
        open_id = open_id or str(info.get("open_id") or "").strip()
        name = name or str(info.get("name") or info.get("en_name") or "").strip()
    if not open_id:
        raise RuntimeError("飞书未返回 open_id")
    return {"open_id": open_id, "name": name or "飞书用户"}


def _http_proxy() -> str | None:
    """只用 HTTP(S) 代理。SOCKS 未装 socksio 会整段失败，不能跟 ALL_PROXY。"""
    for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        raw = (os.environ.get(key) or "").strip()
        if raw and not raw.lower().startswith("socks"):
            return raw
    return None


def _client_kwargs() -> Iterator[dict[str, Any]]:
    timeout = httpx.Timeout(20.0, connect=6.0)
    proxy = _http_proxy()
    if proxy:
        yield {"timeout": timeout, "trust_env": False, "proxy": proxy}
    yield {"timeout": timeout, "trust_env": False}


def _request(method: str, url: str, **kwargs: Any) -> httpx.Response:
    last: Exception | None = None
    for spec in _client_kwargs():
        try:
            with httpx.Client(**spec) as client:
                return client.request(method, url, **kwargs)
        except (httpx.TransportError, ssl.SSLError, OSError, TimeoutError) as exc:
            last = exc
            continue
    raise RuntimeError(f"飞书接口连不上：{last}") from last


def _user_info(user_access_token: str) -> dict[str, Any]:
    try:
        r = _request(
            "GET",
            USER_INFO_URL,
            headers={"Authorization": f"Bearer {user_access_token}"},
        )
    except RuntimeError:
        return {}
    body = r.json() if r.content else {}
    if int(body.get("code") or 0) != 0:
        return {}
    data = body.get("data") if isinstance(body.get("data"), dict) else body
    return data if isinstance(data, dict) else {}


def status() -> dict[str, Any]:
    return {
        "oauth_ready": oauth_ready(),
        "app_id_set": bool(app_id()),
        "secret_set": bool(app_secret()),
        "redirect_uri": redirect_uri(),
        "public_base": public_base(),
        "scopes": OAUTH_SCOPES,
    }
