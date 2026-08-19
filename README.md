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

## 文档

| 文件 | 内容 |
|---|---|
| `DESIGN.md` | 视觉、顶栏、审稿/打样文案 |
| `docs/00-charter.md` | 8/31 章程 |
| `docs/adr-002-typescript-http.md` | 为什么对外 HTTP 是 TypeScript |
| `docs/adr-003-settings-overlay.md` | 本机设置覆盖密钥文件 |
| `docs/risks.md` | 密钥、Tunnel、3D 验收门 |
| `docs/designs/` | 对红循环、两张台 |
| `CHANGELOG.md` | 已发布版本 |
| `TODOS.md` | 未做项 |
| `AGENTS.md` | 给代理的硬约束 |
| `scripts/windows/README.md` | 杭州 Windows 生产备忘 |

## 本机启动

```bash
./scripts/dev-start.sh
```

- 产品：http://127.0.0.1:8787/ （先 `cd apps/web/ui && npm run build`）
- 开发 UI：http://127.0.0.1:5173/ （`npm run dev:ui`，API 反代到 8787）

不要再跑 `uvicorn app.main:app` 当入口。

测服务端和对照 worker：仓库根目录 `npm test`。只要服务端：`npm run test -w beian-server`。

## 给别人用：设置页

登录后点右上角姓名 →「设置」。飞书、百度 OCR、MiniMax、Python、Blender 都在这里填。开工板看登录/审稿/打样能不能干活；费用账单进页再拉，不轮询。

- 密钥只写到本机数据目录（默认 `apps/web/backend/data/settings.secrets.json`，0600，不进 git；可用 `WB_DATA_DIR` 改）
- 界面只显示是否已填
- 「测一下」只在服务端连外部 API
- 也可以继续用 `apps/web/backend/.env.baidu` / `.env.secrets` 打底，设置页覆盖它们

白名单用户写同一数据目录下的 `users.json`（`name` / `open_id` / `role`）。

## 飞书

在飞书开放平台把重定向配成：

`https://www.jianghua.site/api/auth/feishu/callback`

（或你在设置页写的「对外网址」+ `/api/auth/feishu/callback`）

只放行伸美企业的飞书号。同一企业第一次进来会写入本机 `users.json`。其他公司主体直接拒绝，加白名单也进不来。

公网 / Tunnel 前打开设置里的「公网模式」，关闭显示名登录。

## 不要提交

密钥、`.venv`、任务 JSON、上传稿、`.ai/.pdf/.xlsx` 样本、`settings.json`、`settings.secrets.json`。见 `.gitignore`。

## 生产

杭州 Windows + Cloudflare Named Tunnel → `127.0.0.1:8787`。Mac 只做开发。
