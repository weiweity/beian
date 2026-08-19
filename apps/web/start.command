#!/bin/zsh
# 对外入口是 TypeScript :8787。旧 uvicorn 不再当产品层。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec "$ROOT/scripts/dev-start.sh"
