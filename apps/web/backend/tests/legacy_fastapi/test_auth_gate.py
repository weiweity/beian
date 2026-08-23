from __future__ import annotations

import io

from app import auth, config, main


def test_anonymous_reads_are_401(client):
    tid = "0123456789ab"
    paths = [
        "/api/tasks",
        f"/api/tasks/{tid}",
        f"/api/tasks/{tid}/pages/page_01.png",
        f"/api/tasks/{tid}/pages/a/page_01.png",
        f"/api/tasks/{tid}/report",
        f"/api/tasks/{tid}/report.pdf",
        f"/api/tasks/{tid}/docx",
        f"/api/tasks/{tid}/graphics-diff.png",
        "/api/audit",
        "/api/auth/users",
        "/api/presets",
        "/api/eval/gold",
        "/api/engine/tvt",
        "/api/health/detail",
    ]
    for path in paths:
        r = client.get(path)
        assert r.status_code in (401, 403), f"{path} -> {r.status_code} {r.text}"


def test_x_actor_cannot_impersonate(client):
    r = client.get(
        "/api/tasks",
        headers={"X-Actor": "%E7%AE%A1%E7%90%86%E5%91%98"},
    )
    assert r.status_code == 401
    r = client.post(
        "/api/tasks/upload",
        headers={"X-Actor": "%E7%AE%A1%E7%90%86%E5%91%98"},
        data={"task_type": "excel_pdf", "actor": "admin"},
        files={
            "excel": ("a.xlsx", io.BytesIO(b"PK\x03\x04empty"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            "pdf": ("a.pdf", io.BytesIO(b"%PDF-1.4\n"), "application/pdf"),
        },
    )
    assert r.status_code == 401


def test_unknown_display_name_forbidden(client):
    r = client.post("/api/auth/login", json={"display_name": "路人甲"})
    assert r.status_code == 403


def test_health_is_thin(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body == {"ok": True, "version": main.APP_VERSION}
    assert "baidu" not in body
    assert "token_prefix" not in str(body)


def test_login_and_list_tasks(client, reviewer):
    r = client.get("/api/tasks", headers=reviewer)
    assert r.status_code == 200
    assert r.json() == []


def test_users_admin_only(client, reviewer, admin):
    assert client.get("/api/auth/users", headers=reviewer).status_code == 403
    r = client.get("/api/auth/users", headers=admin)
    assert r.status_code == 200
    names = {u["name"] for u in r.json()["users"]}
    assert "审核员" in names


def test_empty_upload_rejected(client, reviewer):
    r = client.post(
        "/api/tasks/upload",
        headers=reviewer,
        data={"task_type": "excel_pdf", "product_name": "测品"},
        files={
            "excel": ("a.xlsx", io.BytesIO(b""), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            "pdf": ("a.pdf", io.BytesIO(b"%PDF-1.4\n"), "application/pdf"),
        },
    )
    assert r.status_code == 400
    assert "空文件" in r.text


def test_fake_pdf_rejected(client, reviewer):
    r = client.post(
        "/api/tasks/upload",
        headers=reviewer,
        data={"task_type": "excel_pdf", "product_name": "测品"},
        files={
            "excel": ("a.xlsx", io.BytesIO(b"PK\x03\x04xxxx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            "pdf": ("a.pdf", io.BytesIO(b"not-a-pdf"), "application/pdf"),
        },
    )
    assert r.status_code == 400
    assert "PDF" in r.text


def test_page_name_and_tid_rejected(client, reviewer):
    r = client.get("/api/tasks/not-a-tid/pages/page_01.png", headers=reviewer)
    assert r.status_code == 400
    r = client.get("/api/tasks/0123456789ab/pages/../secret.png", headers=reviewer)
    assert r.status_code in (400, 404)
    r = client.get("/api/tasks/0123456789ab/pages/foo.png", headers=reviewer)
    assert r.status_code == 400


def test_public_mode_kills_display_login(data_dir, monkeypatch):
    monkeypatch.setenv("WB_PUBLIC", "1")
    monkeypatch.setenv("AUTH_REQUIRE_KNOWN", "true")
    monkeypatch.setenv("WB_DATA_DIR", str(data_dir / "prod"))
    auth.SESSIONS.clear()
    main.init_paths(data_dir / "prod")
    from fastapi.testclient import TestClient

    with TestClient(main.app) as c:
        r = c.post("/api/auth/login", json={"display_name": "审核员"})
        assert r.status_code == 410
    monkeypatch.delenv("WB_PUBLIC", raising=False)
    main.init_paths(data_dir)


def test_cors_not_star():
    assert "*" not in config.cors_origins()


def test_baidu_key_alias():
    ak, sk = config.baidu_ak_sk({"BAIDU_API_KEY": "aa", "BAIDU_SECRET_KEY": "ss"})
    assert (ak, sk) == ("aa", "ss")
    ak, sk = config.baidu_ak_sk(
        {"BAIDU_OCR_API_KEY": "ocr", "BAIDU_OCR_SECRET_KEY": "sec", "BAIDU_API_KEY": "old"}
    )
    assert ak == "ocr" and sk == "sec"


def test_save_task_atomic(data_dir):
    main.init_paths(data_dir)
    main.save_task({"id": "0123456789ab", "title": "t", "status": "pending_review"})
    loaded = main.load_task("0123456789ab")
    assert loaded["title"] == "t"
