"""任务 JSON / 上传目录备份"""
from __future__ import annotations

import json
import shutil
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def backup_dir(data_dir: Path) -> Path:
    d = data_dir / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def create_backup(
    data_dir: Path,
    *,
    include_uploads: bool = False,
    keep: int = 20,
) -> dict[str, Any]:
    """
    打包 tasks/*.json + sessions.json + audit.jsonl（可选 uploads）。
    返回 {ok, path, size, files}
    """
    root = backup_dir(data_dir)
    name = f"wb-backup-{_stamp()}.tar.gz"
    out = root / name
    tasks = data_dir / "tasks"
    files: list[str] = []

    with tarfile.open(out, "w:gz") as tar:
        if tasks.exists():
            for p in sorted(tasks.glob("*.json")):
                tar.add(p, arcname=f"tasks/{p.name}")
                files.append(f"tasks/{p.name}")
        for extra in ("sessions.json", "audit.jsonl", "users.json"):
            p = data_dir / extra
            if p.exists():
                tar.add(p, arcname=extra)
                files.append(extra)
        if include_uploads:
            uploads = data_dir / "uploads"
            if uploads.exists():
                tar.add(uploads, arcname="uploads")
                files.append("uploads/")

    # prune old
    archives = sorted(root.glob("wb-backup-*.tar.gz"), key=lambda p: p.stat().st_mtime, reverse=True)
    removed = 0
    for old in archives[max(1, keep) :]:
        try:
            old.unlink()
            removed += 1
        except OSError:
            pass

    return {
        "ok": True,
        "path": str(out),
        "name": name,
        "size": out.stat().st_size,
        "files": len(files),
        "file_list": files[:50],
        "pruned": removed,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def list_backups(data_dir: Path, limit: int = 30) -> list[dict[str, Any]]:
    root = backup_dir(data_dir)
    items = []
    for p in sorted(root.glob("wb-backup-*.tar.gz"), key=lambda x: x.stat().st_mtime, reverse=True)[
        :limit
    ]:
        items.append(
            {
                "name": p.name,
                "size": p.stat().st_size,
                "mtime": datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(),
            }
        )
    return items


def backup_path(data_dir: Path, name: str) -> Path | None:
    if not name or ".." in name or "/" in name or not name.startswith("wb-backup-"):
        return None
    p = backup_dir(data_dir) / name
    return p if p.exists() else None


def write_manifest(data_dir: Path, meta: dict[str, Any]) -> None:
    p = backup_dir(data_dir) / "last_backup.json"
    p.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
