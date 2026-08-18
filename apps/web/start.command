#!/bin/zsh
# 备案审核工作台 · 一键启动（稳健版）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
PORT="${WB_PORT:-8787}"
HOST="${WB_HOST:-127.0.0.1}"
LOG_DIR="$BACKEND/data/logs"
mkdir -p "$LOG_DIR"

cd "$BACKEND"

# 1) venv
if [[ ! -x .venv/bin/python ]]; then
  echo "→ 创建虚拟环境 .venv …"
  python3 -m venv .venv
  .venv/bin/pip install -U pip wheel
  if [[ -f requirements.txt ]]; then
    .venv/bin/pip install -r requirements.txt
  else
    .venv/bin/pip install fastapi "uvicorn[standard]" python-multipart openpyxl rapidfuzz pymupdf httpx pydantic
  fi
fi
# shellcheck disable=SC1091
source .venv/bin/activate
export PYTHONPATH="."

# 2) 密钥检查（不打印内容）
if [[ ! -f .env.baidu ]]; then
  echo "⚠ 缺少 backend/.env.baidu （可参考 .env.baidu.example）"
fi
if [[ ! -f .env.secrets ]]; then
  echo "⚠ 缺少 backend/.env.secrets （可参考 .env.secrets.example）"
fi
if [[ -f .env.baidu ]]; then
  chmod 600 .env.baidu 2>/dev/null || true
fi
if [[ -f .env.secrets ]]; then
  chmod 600 .env.secrets 2>/dev/null || true
fi

# 3) 端口占用
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠ 端口 $PORT 已被占用："
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
  if [[ "${WB_KILL_PORT:-}" == "1" ]]; then
    echo "→ WB_KILL_PORT=1，结束占用进程…"
    lsof -tiTCP:"$PORT" -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
    sleep 0.4
  else
    echo "   可换端口：WB_PORT=8790 $0"
    echo "   或强制释放：WB_KILL_PORT=1 $0"
    exit 1
  fi
fi

# 4) 启动前轻量备份任务 JSON（失败不阻断）
.venv/bin/python - <<'PY' 2>/dev/null || true
from pathlib import Path
try:
    from app import backup
    data = Path("data")
    if (data / "tasks").exists() and any((data / "tasks").glob("*.json")):
        m = backup.create_backup(data, include_uploads=False, keep=15)
        backup.write_manifest(data, m)
        print(f"→ 已备份任务 JSON：{m.get('name')} ({m.get('size')} bytes)")
except Exception as e:
    print(f"→ 启动备份跳过：{e}")
PY

# 5) 健康检查地址
echo ""
echo "══════════════════════════════════════"
echo " 备案审核工作台  http://${HOST}:${PORT}/"
echo " 日志  $LOG_DIR/uvicorn.log"
echo " Ctrl+C 停止"
echo "══════════════════════════════════════"
echo ""

# 6) 启动
exec .venv/bin/uvicorn app.main:app \
  --host "$HOST" \
  --port "$PORT" \
  --log-level info \
  2>&1 | tee -a "$LOG_DIR/uvicorn.log"
