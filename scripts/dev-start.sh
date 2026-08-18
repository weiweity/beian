#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/apps/web/backend"
PORT="${WB_PORT:-8787}"
HOST="${WB_HOST:-127.0.0.1}"
cd "$BACKEND"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
  .venv/bin/pip install -U pip wheel
  .venv/bin/pip install -r requirements.txt
fi
# shellcheck disable=SC1091
source .venv/bin/activate
export PYTHONPATH="."
if [[ ! -f .env.baidu ]]; then
  echo "⚠ 缺少 apps/web/backend/.env.baidu （参考 .env.baidu.example）"
fi
if [[ ! -f .env.secrets ]]; then
  echo "⚠ 缺少 apps/web/backend/.env.secrets （参考 .env.secrets.example）"
fi
exec .venv/bin/uvicorn app.main:app --host "$HOST" --port "$PORT" --log-level info
