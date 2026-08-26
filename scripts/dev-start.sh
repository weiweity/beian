#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/apps/web/backend"
SERVER="$ROOT/apps/web/server"
PORT="${WB_PORT:-8787}"
HOST="${WB_HOST:-127.0.0.1}"

if [[ ! -x "$BACKEND/.venv/bin/python" ]]; then
  PY=python3
  if command -v python3.12 >/dev/null 2>&1; then
    PY=python3.12
  fi
  "$PY" -m venv "$BACKEND/.venv"
  "$BACKEND/.venv/bin/pip" install -U pip wheel
  "$BACKEND/.venv/bin/pip" install -r "$BACKEND/requirements.txt"
fi

if [[ ! -f "$BACKEND/.env.baidu" ]]; then
  echo "⚠ 缺少 apps/web/backend/.env.baidu （参考 .env.baidu.example）"
fi
if [[ ! -f "$BACKEND/.env.secrets" ]]; then
  echo "⚠ 缺少 apps/web/backend/.env.secrets （参考 .env.secrets.example）"
fi

cd "$ROOT"
if [[ ! -x "$ROOT/node_modules/.bin/tsx" \
  || ! -x "$ROOT/apps/web/ui/node_modules/.bin/vite" \
  || ! -d "$ROOT/node_modules/@google/model-viewer" ]]; then
  npm install
fi

export WB_PORT="$PORT"
export WB_HOST="$HOST"
export WB_PYTHON="$BACKEND/.venv/bin/python"
export PYTHONPATH="$BACKEND"
export WB_DATA_DIR="${WB_DATA_DIR:-$BACKEND/data}"
cd "$SERVER"
exec npx tsx src/index.ts
