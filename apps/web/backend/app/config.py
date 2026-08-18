"""加载本地密钥与配置（.env.baidu / .env.secrets）"""
from __future__ import annotations

import os
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent


def _load_env_file(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    if not path.exists():
        return data
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        data[k.strip()] = v.strip().strip('"').strip("'")
    return data


def load_all_env() -> dict[str, str]:
    cfg: dict[str, str] = {}
    cfg.update(_load_env_file(BACKEND / ".env.baidu"))
    cfg.update(_load_env_file(BACKEND / ".env.secrets"))
    cfg.update(_load_env_file(BACKEND / ".env"))
    # process env wins
    for k, v in os.environ.items():
        if k.startswith(("BAIDU_", "MINIMAX_", "FEISHU_", "AUTH_")):
            cfg[k] = v
    return cfg


def get(key: str, default: str = "") -> str:
    return load_all_env().get(key, default) or default


def truthy(key: str, default: bool = False) -> bool:
    v = get(key, "true" if default else "false").lower()
    return v in ("1", "true", "yes", "on")
