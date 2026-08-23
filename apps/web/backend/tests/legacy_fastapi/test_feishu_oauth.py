from __future__ import annotations

from app import auth, feishu_oauth


def test_authorize_url_has_client_and_redirect():
    url = feishu_oauth.authorize_url()
    assert "contact:user.base" not in url
    assert "cli_aa0ebd6422385ce0" in url
    assert "redirect_uri=" in url
    assert "response_type=code" in url


def test_auth_methods_public(client):
    r = client.get("/api/auth/methods")
    assert r.status_code == 200
    body = r.json()
    assert "feishu" in body
    assert body["login_url"] == "/api/auth/feishu/login"


def test_feishu_login_without_secret_is_503(client, monkeypatch):
    monkeypatch.setenv("FEISHU_APP_ID", "cli_aa0ebd6422385ce0")
    monkeypatch.setenv("FEISHU_APP_SECRET", "")
    r = client.get("/api/auth/feishu/login", follow_redirects=False)
    assert r.status_code == 503


def test_feishu_callback_rejects_bad_state(client):
    r = client.get(
        "/api/auth/feishu/callback",
        params={"code": "x", "state": "nope"},
        follow_redirects=False,
    )
    assert r.status_code == 400


def test_feishu_callback_unknown_open_id(client, monkeypatch):
    monkeypatch.setattr(
        feishu_oauth,
        "exchange_code",
        lambda code: {"open_id": "ou_stranger", "name": "路人"},
    )
    state = feishu_oauth.new_state()
    r = client.get(
        "/api/auth/feishu/callback",
        params={"code": "abc", "state": state},
        follow_redirects=False,
    )
    assert r.status_code == 403
    assert "白名单" in r.text


def test_feishu_callback_allowlist_sets_cookie(client, monkeypatch):
    monkeypatch.setenv("FEISHU_ALLOW_OPEN_IDS", "ou_allowed_user")
    monkeypatch.setattr(
        feishu_oauth,
        "exchange_code",
        lambda code: {"open_id": "ou_allowed_user", "name": "刘籽烨"},
    )
    state = feishu_oauth.new_state()
    r = client.get(
        "/api/auth/feishu/callback",
        params={"code": "abc", "state": state},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert r.cookies.get("wb_session")
    token = r.cookies.get("wb_session")
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["logged_in"] is True
    assert me.json()["display_name"] == "刘籽烨"


def test_exchange_code_does_not_inherit_socks_proxy(monkeypatch):
    monkeypatch.setenv("ALL_PROXY", "socks5://127.0.0.1:1")
    monkeypatch.setenv("all_proxy", "socks5://127.0.0.1:1")
    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    monkeypatch.delenv("https_proxy", raising=False)
    monkeypatch.delenv("HTTP_PROXY", raising=False)
    monkeypatch.delenv("http_proxy", raising=False)
    monkeypatch.setenv("FEISHU_APP_ID", "cli_aa0ebd6422385ce0")
    monkeypatch.setenv("FEISHU_APP_SECRET", "secret")
    seen: list[dict] = []

    class FakeResp:
        status_code = 200
        content = b"{}"

        def json(self):
            return {"code": 0, "open_id": "ou_1", "name": "测"}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            seen.append(kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def request(self, *args, **kwargs):
            return FakeResp()

    monkeypatch.setattr(feishu_oauth.httpx, "Client", FakeClient)
    out = feishu_oauth.exchange_code("abc")
    assert seen
    assert all(spec.get("trust_env") is False for spec in seen)
    assert all(not str(spec.get("proxy") or "").lower().startswith("socks") for spec in seen)
    assert out["open_id"] == "ou_1"


def test_exchange_code_prefers_http_proxy_then_retries(monkeypatch):
    monkeypatch.setenv("https_proxy", "http://127.0.0.1:7897")
    monkeypatch.setenv("ALL_PROXY", "socks5://127.0.0.1:1")
    monkeypatch.setenv("FEISHU_APP_ID", "cli_aa0ebd6422385ce0")
    monkeypatch.setenv("FEISHU_APP_SECRET", "secret")
    seen: list[dict] = []

    class FakeResp:
        status_code = 200
        content = b"{}"

        def json(self):
            return {"code": 0, "open_id": "ou_2", "name": "测"}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            seen.append(kwargs)
            if kwargs.get("proxy"):
                raise feishu_oauth.httpx.ConnectTimeout("boom")

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def request(self, *args, **kwargs):
            return FakeResp()

    monkeypatch.setattr(feishu_oauth.httpx, "Client", FakeClient)
    out = feishu_oauth.exchange_code("abc")
    assert seen[0].get("proxy") == "http://127.0.0.1:7897"
    assert "proxy" not in seen[1]
    assert out["open_id"] == "ou_2"


def test_cookie_middleware_reads_session(client, reviewer):
    token = reviewer["Authorization"].split(" ", 1)[1]
    client.cookies.set("wb_session", token)
    r = client.get("/api/tasks")
    assert r.status_code == 200
    assert r.json() == []
