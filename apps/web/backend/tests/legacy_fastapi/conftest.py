from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import auth, main


@pytest.fixture()
def data_dir(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    return d


@pytest.fixture()
def client(data_dir):
    auth.SESSIONS.clear()
    main.init_paths(data_dir)
    with TestClient(main.app) as c:
        yield c


@pytest.fixture()
def reviewer(client):
    r = client.post("/api/auth/login", json={"display_name": "审核员"})
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def admin(client):
    r = client.post("/api/auth/login", json={"display_name": "管理员"})
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    return {"Authorization": f"Bearer {token}"}
