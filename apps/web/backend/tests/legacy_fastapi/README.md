退役 FastAPI HTTP 测试。产品入口是 Hono `:8787`，不要 `uvicorn`。

不进默认 `pytest`。手工：

```bash
cd apps/web/backend && .venv/bin/python -m pytest tests/legacy_fastapi -q
```
