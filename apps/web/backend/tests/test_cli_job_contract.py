from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from app.cli import cmd_compare, cmd_rework
from app.main import emit_stage

BACKEND = Path(__file__).resolve().parents[1]
TID = "0123456789ab"


def _last_json(capsys) -> dict:
    captured = capsys.readouterr()
    last = captured.out.strip().splitlines()[-1]
    return json.loads(last)


def _forbid_save(*_a, **_k):
    raise AssertionError("save_task must not be called")


def test_cli_help_mentions_stage_save_task_packaging(tmp_path):
    env = os.environ.copy()
    env["PYTHONPATH"] = str(BACKEND) + os.pathsep + env.get("PYTHONPATH", "")
    env["WB_DATA_DIR"] = str(tmp_path / "data")
    r = subprocess.run(
        [sys.executable, "-m", "app.cli", "--help"],
        cwd=str(BACKEND),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert r.returncode == 0, r.stderr
    blob = r.stdout + r.stderr
    assert "STAGE" in blob
    assert "save_task" in blob
    assert "packaging" in blob


def test_cmd_compare_prints_task_json_without_save(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr("app.main.save_task", _forbid_save)
    monkeypatch.setattr(
        "app.main.run_excel_pdf_job",
        lambda *_a, **_k: {
            "id": TID,
            "status": "pending_review",
            "hits": [{"field": "净含量", "status": "疑点"}],
            "pages": ["page_01.png"],
            "ocr_text": "must-not-print",
            "audit": [],
        },
    )
    excel = tmp_path / "a.xlsx"
    pdf = tmp_path / "a.pdf"
    excel.write_bytes(b"PK")
    pdf.write_bytes(b"%PDF-1.4\n")
    data = tmp_path / "data"
    data.mkdir()
    code = cmd_compare(
        argparse.Namespace(
            tid=TID,
            excel=str(excel),
            pdf=str(pdf),
            product_name="某某精华",
            title="",
            surface="carton",
            max_pages="2",
            actor="tester",
            data_dir=str(data),
        )
    )
    assert code == 0
    payload = _last_json(capsys)
    assert payload["status"] == "pending_review"
    assert payload["hits"]
    assert "ocr_text" not in payload


def test_cmd_rework_prints_hits_v2_without_save(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr("app.main.save_task", _forbid_save)
    monkeypatch.setattr(
        "app.fields.parse_excel_fields",
        lambda _p: [{"field": "净含量", "excel_value": "50ml"}],
    )
    monkeypatch.setattr(
        "app.main._surface_job",
        lambda **_k: {
            "pages": [{"name": "page_01.png"}],
            "hits": [{"field": "净含量", "status": "一致", "page": 1}],
        },
    )
    data = tmp_path / "data"
    uploads = data / "uploads" / TID
    tasks = data / "tasks"
    uploads.mkdir(parents=True)
    tasks.mkdir(parents=True)
    (uploads / "source.xlsx").write_bytes(b"PK")
    pdf = tmp_path / "v2.pdf"
    pdf.write_bytes(b"%PDF-1.4\n")
    (tasks / f"{TID}.json").write_text(
        json.dumps(
            {
                "id": TID,
                "title": "某某精华",
                "label_a": "花盒",
                "status": "completed",
                "hits": [
                    {
                        "field": "净含量",
                        "decision": "issue",
                        "excel": "50ml",
                        "pdf": "50 ml",
                        "status": "疑点",
                        "page": 1,
                    }
                ],
                "ocr_text": "must-not-print",
                "audit": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    code = cmd_rework(
        argparse.Namespace(
            tid=TID,
            pdf=str(pdf),
            max_pages="2",
            actor="tester",
            data_dir=str(data),
        )
    )
    assert code == 0
    payload = _last_json(capsys)
    assert "hits_v2" in payload
    assert payload["status"] == "in_review"
    assert payload["round"] == 2
    assert payload["artwork_v2"] == "artwork_v2.pdf"
    assert "rework_check" in payload
    assert "pages_v2" in payload
    assert "ocr_text" not in payload


def test_cmd_rework_same_path_skips_copy2(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr("app.main.save_task", _forbid_save)
    monkeypatch.setattr(
        "app.fields.parse_excel_fields",
        lambda _p: [{"field": "净含量", "excel_value": "50ml"}],
    )
    monkeypatch.setattr(
        "app.main._surface_job",
        lambda **_k: {
            "pages": [{"name": "page_01.png"}],
            "hits": [{"field": "净含量", "status": "一致", "page": 1}],
        },
    )
    data = tmp_path / "data"
    uploads = data / "uploads" / TID
    tasks = data / "tasks"
    uploads.mkdir(parents=True)
    tasks.mkdir(parents=True)
    (uploads / "source.xlsx").write_bytes(b"PK")
    dest = uploads / "artwork_v2.pdf"
    dest.write_bytes(b"%PDF-1.4\n")
    (tasks / f"{TID}.json").write_text(
        json.dumps(
            {
                "id": TID,
                "title": "某某精华",
                "label_a": "花盒",
                "status": "completed",
                "hits": [],
                "audit": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    code = cmd_rework(
        argparse.Namespace(
            tid=TID,
            pdf=str(dest),
            max_pages="2",
            actor="tester",
            data_dir=str(data),
        )
    )
    assert code == 0
    payload = _last_json(capsys)
    assert payload["artwork_v2"] == "artwork_v2.pdf"
    assert dest.read_bytes().startswith(b"%PDF")


def test_emit_stage_writes_stderr(capsys):
    emit_stage("ocr")
    err = capsys.readouterr().err
    assert "STAGE ocr" in err
