from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[1]


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _run_eval(
    gold_dir: Path,
    tasks_dir: Path,
    *,
    task_id: str | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        "scripts/run_eval.py",
        "--gold-dir",
        str(gold_dir),
        "--tasks-dir",
        str(tasks_dir),
    ]
    if task_id is not None:
        command.extend(["--task-id", task_id])
    return subprocess.run(
        command,
        cwd=BACKEND,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )


def test_run_eval_fails_when_gold_directory_is_empty(tmp_path: Path) -> None:
    gold_dir = tmp_path / "gold"
    tasks_dir = tmp_path / "tasks"
    gold_dir.mkdir()
    tasks_dir.mkdir()

    result = _run_eval(gold_dir, tasks_dir)

    assert result.returncode == 1
    assert "No gold cases found" in result.stdout


def test_run_eval_fails_when_no_task_can_be_evaluated(tmp_path: Path) -> None:
    gold_dir = tmp_path / "gold"
    tasks_dir = tmp_path / "tasks"
    gold_dir.mkdir()
    tasks_dir.mkdir()
    _write_json(
        gold_dir / "case.json",
        {
            "id": "missing-task",
            "task_id": "0123456789ab",
            "fields": [{"field": "品名", "expected_status": "一致"}],
        },
    )

    result = _run_eval(gold_dir, tasks_dir)

    assert result.returncode == 1
    assert "No evaluable gold cases" in result.stdout


def test_run_eval_task_id_filter_fails_when_no_gold_case_matches(tmp_path: Path) -> None:
    gold_dir = tmp_path / "gold"
    tasks_dir = tmp_path / "tasks"
    gold_dir.mkdir()
    tasks_dir.mkdir()
    task_id = "0123456789ab"
    _write_json(
        gold_dir / "case.json",
        {
            "id": "known-case",
            "task_id": task_id,
            "fields": [{"field": "品名", "expected_status": "一致"}],
        },
    )
    _write_json(
        tasks_dir / f"{task_id}.json",
        {"id": task_id, "hits": [{"field": "品名", "status": "一致"}]},
    )

    result = _run_eval(gold_dir, tasks_dir, task_id="not-a-known-case")

    assert result.returncode == 1
    assert "No gold cases found" in result.stdout
    assert "case=known-case" not in result.stdout


def test_run_eval_aggregates_evaluable_cases_and_exits_zero(tmp_path: Path) -> None:
    gold_dir = tmp_path / "gold"
    tasks_dir = tmp_path / "tasks"
    gold_dir.mkdir()
    tasks_dir.mkdir()
    first_task_id = "0123456789ab"
    second_task_id = "abcdef012345"
    _write_json(
        gold_dir / "first.json",
        {
            "id": "matching-case",
            "task_id": first_task_id,
            "fields": [
                {"field": "品名", "expected_status": "一致"},
                {"field": "净含量", "expected_status": "疑点"},
            ],
        },
    )
    _write_json(
        tasks_dir / f"{first_task_id}.json",
        {
            "id": first_task_id,
            "hits": [
                {"field": "品名", "status": "一致"},
                {"field": "净含量", "status": "疑点"},
            ],
        },
    )
    _write_json(
        gold_dir / "second.json",
        {
            "id": "mismatching-case",
            "task_id": second_task_id,
            "fields": [
                {"field": "品牌", "expected_status": "缺失"},
                {"field": "条码", "expected_status": "一致"},
            ],
        },
    )
    _write_json(
        tasks_dir / f"{second_task_id}.json",
        {
            "id": second_task_id,
            "hits": [
                {"field": "品牌", "status": "一致"},
                {"field": "条码", "status": "疑点"},
            ],
        },
    )

    result = _run_eval(gold_dir, tasks_dir)

    assert result.returncode == 0, result.stderr
    assert "case=matching-case acc=100.00%" in result.stdout
    assert "case=mismatching-case acc=0.00%" in result.stdout
    separator, marker, aggregate_json = result.stdout.partition("---\n")
    assert marker == "---\n", separator
    aggregate = json.loads(aggregate_json)
    assert aggregate == {
        "cases": 2,
        "precision_human": 0.5,
        "recall_human": 0.5,
        "f1_human": 0.5,
        "status_accuracy": 0.5,
        "tp": 1,
        "fp": 1,
        "fn": 1,
        "tn": 1,
        "status_ok": 2,
        "status_total": 4,
    }
