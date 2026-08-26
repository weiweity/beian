# beian

供应链飞书网页。一个工作场，两张台：审稿台（Excel ↔ 备案 PDF，人终审）、打样台（平面稿 → 3D）。

第一期用户刘籽烨。8/31 先交审稿台。

## 仓库

| 路径 | 内容 |
|---|---|
| `apps/web/ui` | React + Ant Design 6 审稿台 / 打样台 / 历史 / 设置 |
| `apps/web/server` | Hono + TypeScript，对外 HTTP `:8787` |
| `apps/web/backend` | Python 对照 worker（TS 用 `python -m app.cli` 调用） |
| `workers/packaging/` | 2D→3D CLI，打样台调用。先读稿上刀线还原盒面（密折痕先密后疏）；平面出图用 pymupdf（对照同一 Python）；杭州不需要 macOS qlmanage。PPT 用两张白底写 OOXML，不依赖 Node；写不出才试演示文稿运行时。两张白底再合成一页 PDF（页底先铺白，槽按源图比例 contain；pymupdf 写不出且还没落盘才用已装 Pillow，不盖掉已写成的文件）。缺 PPT/PDF 仍算出图 |
| `docs/` | 章程、ADR、设计 |

旧 `apps/web/frontend` 已删除。网页入口只有 `apps/web/ui` + Hono `apps/web/server`；对照规则和 Blender 仍是 Python。见 `docs/adr-002-typescript-http.md`。

## 文档

| 文件 | 内容 |
|---|---|
| `DESIGN.md` | 视觉、侧栏、审稿/打样文案 |
| `docs/00-charter.md` | 8/31 章程 |
| `docs/adr-002-typescript-http.md` | 为什么对外 HTTP 是 TypeScript |
| `docs/adr-003-settings-overlay.md` | 本机设置覆盖密钥文件 |
| `docs/adr-004-ousterhout-design.md` | 深模块、唯一入口、8/31 前不拆引擎 |
| `docs/risks.md` | 密钥、Tunnel、3D 验收门 |
| `docs/designs/` | 对红循环、两张台、作业模块（对照/对红/打样入队） |
| `CHANGELOG.md` | 已发布版本 |
| `TODOS.md` | 未做项 |
| `AGENTS.md` | 给代理的硬约束、加长作业合同、易忘约定（MICRO 不改 `package.json` 三位；禁止 `git add -A`） |
| `scripts/windows/README.md` | 杭州 Windows 生产备忘 |
| `workers/packaging/README.md` | 打样 CLI、刀线还原盒面（密折痕先密后疏）、pymupdf 平面出图（不靠 qlmanage）；PPT 用白底写 OOXML；两张白底合成 PDF（槽 contain；pymupdf 写不出且未落盘才用 Pillow）；棚只提亮，不改盒子材质 |

## 本机启动

```bash
./scripts/dev-start.sh
```

- 产品 / 验收：http://127.0.0.1:8787/ （先 `cd apps/web/ui && npm run build`）
- 开发 UI：http://127.0.0.1:5173/ （`npm run dev:ui`；Vite 听本机网卡，`/api` 反代到 8787，端口占用即失败）
- 台地址：`/reviewup` 审稿台、`/reviewup/new` 审稿工作台、`/review/:id` 核对页、`/mockup` 打样台、`/mockup/new` 打样工作台、`/mockup/:id` 打样单、`/history`、`/settings`。旧 `/` `/new` `/review` 会转到新地址。后退换台。
- 审稿双井或打样 `.ai` 选齐后会先上传。进度到 100% 只表示浏览器已发完，看到「服务器确认中」后还要等「待开工」；这时切去别页再回来仍可继续。要换一组稿先点「放弃上传」，会同时清掉服务器上的待开工回执。回执已生成时，整页刷新后可从台面的待开工卡继续；回执生成前刷新或断网仍需重新选择文件。
- 打样台可按品名/文件名搜索，并在看板与表格之间切换。新稿支持两份同时流式上传，第三份会提示等待其中一份完成。历史记录可按审稿/打样、时间和生成人筛选；有删除权限时点「编辑」可全选并批量删除已结束的单，进行中的单不能删除。核对页默认打开已完成的第二版（如有），可切回上一版，也可用「全屏核对」。

5173 登录闪或 `/api` 返回 HTML / 空 Content-Type：打开 http://127.0.0.1:8787/，或重启 `npm run dev:ui`。飞书授权失败回到飞书重试，不要把远程验收人指到本机。JSON 404（任务不存在等）不是 Vite 挂了。

不要跑 uvicorn。没有 `app.main`。产品入口只有 Hono `:8787`。

测服务端、界面和对照 CLI：仓库根目录 `npm test`（Mac；不打外网）。浏览器交互回归另跑 `npm run test:e2e`；它使用 Vite + 合成 API，验证页面行为，不替代真实 Hono `:8787` 或杭州 Windows L1。杭州生产只做 health/logo 冒烟，不跑单测。只要服务端：`npm run test -w beian-server`。只要界面：`npm run test -w beian-ui`。

## Docker（当前未交付）

当前仓库没有 `Dockerfile`、`compose.yaml` 或 `.env.container.example`，所以下面的旧容器化计划**不能执行，也不代表已验收**。当前可执行入口仍是 `./scripts/dev-start.sh` → Hono `:8787`；若以后恢复容器化，必须连同这三个文件和跨架构验证一起交付。

<details>
<summary>历史容器化计划（仅供追溯，不可执行）</summary>

```bash
cp .env.container.example .env.container
# 按需填写 .env.container
docker compose --env-file .env.container up --build
```

如果构建时访问 npm/Python 官方源不稳定，可只在 `.env.container` 中把 `NPM_REGISTRY` 或 `PIP_INDEX_URL` 改为你们认可的镜像；这只影响镜像构建，不会改变宿主机 Docker 全局配置。

浏览器打开 `http://127.0.0.1:8787/`。在 Windows Docker Desktop 上使用 Linux containers；如果从 Apple Silicon Mac 构建后把镜像带到 Windows，应构建 `linux/amd64`：

```bash
docker buildx build --platform linux/amd64 -t beian:review-amd64 --load .
```

这不是 3D 打样容器：打样台仍要求宿主机 Blender，Illustrator/AppleScript 也不随镜像提供。容器能启动不代表 Windows 3D 流水线已验收。

</details>

## 给别人用：设置页

登录后点侧栏「设置」。管理员可在这里保存飞书、百度 OCR、MiniMax、Python、Blender 配置并扫描本机程序；其他审核员可看状态和运行允许的探测，但不能改系统配置或扫描电脑。开工板看登录/审稿/打样能不能干活；费用账单进页再拉，不轮询。外观（主题、字号、侧栏材质：实心 / 毛玻璃 / 液态玻璃）只写这台浏览器，不进密钥文件。

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

密钥、`.venv`、任务 JSON、上传稿、`.ai/.pdf/.xlsx` 样本、`settings.json`、`settings.secrets.json`、Vite 缓存（`.vite/`）、`.claude/`、`docs/designs/hangzhou-production-cutover.md`。见 `.gitignore`。不要 `git add -A`。

## 生产

杭州 Windows + Cloudflare Named Tunnel → `127.0.0.1:8787`。Mac 只做开发。合进 `main` 后，杭州 **self-hosted runner**（标签 `hangzhou`）跑 `scripts/windows/release.ps1`。对照在跑会失败并保持旧进程；先停 8787 那棵树再拉码，不动 cloudflared，不杀全部 node.exe。也可在杭州手工执行同一脚本。侧栏/拒绝页图标走 `/brand/…`（`apps/web/ui/public`）；Windows 上若 404，确认已拉到 v0.12.0.1+，冒烟见 `scripts/windows/README.md`。
