"""全局审计日志 · JSONL"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _path(data_dir: Path) -> Path:
    return data_dir / "audit.jsonl"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def append(
    data_dir: Path,
    *,
    action: str,
    actor: str,
    task_id: str | None = None,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    entry = {
        "at": now_iso(),
        "action": action,
        "actor": actor,
        "task_id": task_id,
        "detail": detail or {},
    }
    p = _path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def list_entries(
    data_dir: Path,
    *,
    limit: int = 100,
    task_id: str | None = None,
) -> list[dict[str, Any]]:
    p = _path(data_dir)
    if not p.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if task_id and e.get("task_id") != task_id:
            continue
        rows.append(e)
        if len(rows) >= limit:
            break
    return rows
