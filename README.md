# beian

供应链飞书网页。一个工作场，两张台：审稿台（Excel ↔ 备案 PDF，人终审）、打样台（平面稿 → 3D）。

第一期用户刘籽烨。8/31 先交审稿台。

## 仓库

| 路径 | 内容 |
|---|---|
| `apps/web/ui` | React + Ant Design 6 审稿台 / 打样台 / 设置 |
| `apps/web/server` | Hono + TypeScript，对外 HTTP `:8787` |
| `apps/web/backend` | Python 对照 worker（TS 用 `python -m app.cli` 调用） |
| `apps/web/frontend` | 已退役的原生页，不要再改 |
| `workers/packaging/` | 2D→3D CLI，打样台调用 |
| `docs/` | 章程、ADR、设计 |

HTTP 是 TypeScript。对照规则和 Blender 仍是 Python。见 `docs/adr-002-typescript-http.md`。

## 本机启动

```bash
./scripts/dev-start.sh
```

- 产品：http://127.0.0.1:8787/ （先 `cd apps/web/ui && npm run build`）
- 开发 UI：http://127.0.0.1:5173/ （`npm run dev:ui`，API 反代到 8787）

不要再跑 `uvicorn app.main:app` 当入口。

## 给别人用：设置页

登录后顶栏右侧「设置」。飞书、百度 OCR、MiniMax、Python、Blender 都在这里填。

- 密钥只写到本机 `data/settings.secrets.json`（0600，不进 git）
- 界面只显示是否已填
- 「测一下」只在服务端连外部 API
- 也可以继续用 `apps/web/backend/.env.baidu` / `.env.secrets` 打底，设置页覆盖它们

白名单用户写本机 `data/users.json`（`name` / `open_id` / `role`）。

## 飞书

在飞书开放平台把重定向配成：

`https://www.jianghua.site/api/auth/feishu/callback`

（或你在设置页写的「对外网址」+ `/api/auth/feishu/callback`）

第一次若 403，页面会带 `open_id`。写进 `users.json` 或设置页的额外白名单。

公网 / Tunnel 前打开设置里的「公网模式」，关闭显示名登录。

## 不要提交

密钥、`.venv`、任务 JSON、上传稿、`.ai/.pdf/.xlsx` 样本、`settings.json`、`settings.secrets.json`。见 `.gitignore`。

## 生产

杭州 Windows + Cloudflare Named Tunnel → `127.0.0.1:8787`。Mac 只做开发。
