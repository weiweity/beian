from __future__ import annotations

import io
from app import main


def _save(task: dict) -> None:
    main.save_task(task)


def _task(**extra) -> dict:
    base = {
        "id": "0123456789ab",
        "title": "某某精华",
        "product_name": "某某精华",
        "type": "excel_pdf",
        "status": "in_review",
        "hits": [
            {
                "id": "h1",
                "field": "净含量",
                "status": "疑点",
                "decision": "pending",
                "excel": "50ml",
                "pdf": "50 ml",
                "page": 2,
            }
        ],
        "audit": [],
    }
    base.update(extra)
    return base


def test_upload_requires_product_name(client, reviewer):
    r = client.post(
        "/api/tasks/upload",
        headers=reviewer,
        data={"task_type": "excel_pdf", "title": "Excel↔包装"},
        files={
            "excel": (
                "a.xlsx",
                io.BytesIO(b"PK\x03\x04xxxx"),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            "pdf": ("a.pdf", io.BytesIO(b"%PDF-1.4\n"), "application/pdf"),
        },
    )
    assert r.status_code == 400
    assert "品名" in r.text


def test_list_tasks_q_filters_product_name(client, reviewer):
    _save(_task(id="aaaaaaaaaaaa", product_name="某某精华", title="某某精华"))
    _save(_task(id="bbbbbbbbbbbb", product_name="另一支霜", title="另一支霜"))
    r = client.get("/api/tasks?q=精华", headers=reviewer)
    assert r.status_code == 200
    names = {row["product_name"] for row in r.json()}
    assert names == {"某某精华"}
    miss = client.get("/api/tasks?q=没有这个品", headers=reviewer)
    assert miss.status_code == 200
    assert miss.json() == []


def test_decide_persists_note(client, reviewer):
    _save(_task())
    r = client.post(
        "/api/tasks/0123456789ab/decision",
        headers=reviewer,
        json={"hit_id": "h1", "decision": "issue", "note": "少了空格"},
    )
    assert r.status_code == 200, r.text
    hit = next(h for h in r.json()["hits"] if h["id"] == "h1")
    assert hit["decision"] == "issue"
    assert hit["note"] == "少了空格"


def test_complete_blocked_when_pending_doubt(client, reviewer):
    _save(_task())
    r = client.post(
        "/api/tasks/0123456789ab/complete",
        headers=reviewer,
        json={"conclusion": "先签了", "notify": False},
    )
    assert r.status_code == 400
    assert "未处理" in r.text


def test_complete_allows_issues_and_uses_rework_copy(client, reviewer, monkeypatch):
    seen = {}

    def fake_notify(task, who):
        seen["text_kind"] = task.get("complete_kind")
        seen["title"] = task.get("title")
        return {"ok": True, "skipped": True}

    monkeypatch.setattr(main.feishu_push, "notify_task_complete", fake_notify)
    _save(
        _task(
            hits=[
                {
                    "id": "h1",
                    "field": "净含量",
                    "status": "疑点",
                    "decision": "issue",
                    "note": "多了空格",
                    "excel": "50ml",
                    "pdf": "50 ml",
                    "page": 2,
                }
            ]
        )
    )
    r = client.post(
        "/api/tasks/0123456789ab/complete",
        headers=reviewer,
        json={"conclusion": "净含量空格要改", "notify": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "completed"
    assert body["complete_kind"] == "rework"
    assert body["conclusion"] == "净含量空格要改"
    assert seen["text_kind"] == "rework"


def test_feishu_complete_says_rework_not_final(monkeypatch):
    captured: dict[str, str] = {}

    def fake_send(text: str):
        captured["text"] = text
        return {"ok": True}

    monkeypatch.setattr(main.feishu_push, "send_text", fake_send)
    main.feishu_push.notify_task_complete(
        {
            "title": "某某精华",
            "id": "0123456789ab",
            "complete_kind": "rework",
            "conclusion": "空格要改",
            "hits": [{"decision": "issue", "field": "净含量", "status": "疑点"}],
            "summary": {},
        },
        "审核员",
    )
    assert "待设计改稿" in captured["text"]
    assert "终审完成" not in captured["text"]
    assert "AI" not in captured["text"]


def test_index_requires_ui_dist(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "UI_DIST", tmp_path / "missing-dist")
    r = client.get("/")
    assert r.status_code == 503
    assert "npm run build" in r.text
    built = tmp_path / "ui-dist"
    built.mkdir()
    (built / "index.html").write_text("<html>审稿台</html>", encoding="utf-8")
    monkeypatch.setattr(main, "UI_DIST", built)
    r2 = client.get("/")
    assert r2.status_code == 200
    assert "审稿台" in r2.text
    assert "备案审核工作台" not in r2.text  # 旧 frontend 文案不应出现
