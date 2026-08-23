# AGENTS.md

请用中文回复。

## 项目

`beian`：供应链备案审核网页。打样台调用 `workers/packaging`（缺 Blender 要失败写清）。第一期验收人刘籽烨，收尾 2026-08-31。

## 硬约束

- 不重写审核引擎和 3D 流水线，在迁入代码上改。
- 不重写 3D 流水线。打样台只调用 `workers/packaging`，缺 Blender 要写清失败。
- 不得提交 `.env`、`.env.baidu`、`.env.secrets`、`backend/data` 运行时文件、稿件、Vite 缓存、`.claude/`。
- 不得读取或打印真实密钥。
- 不得自行改 DNS、发布飞书版本、购买云、映射公网端口。
- 公网/Tunnel 后禁止显示名裸登录。
- Mac 绿灯不等于 Windows 已验收。杭州生产怎么升版见文末「Deploy Configuration」。合 `main` 后 runner 自动跑 `release.ps1`；Actions 红或公网 health 对不上 VERSION 时不要报已上线。
- 对照失败或已完成的单不能签字；干净签字单不能再对红；对红后优先读非空 `hits_v2`（空数组回退第一轮）。
- 飞书授权失败回到飞书，不要把远程验收人送到本机 `:8787`。JSON 404 不是 Vite 挂了；只有 HTML 或空 Content-Type 才当开发页没转到 8787。

## 目录

- 网页：`apps/web/ui`（React+TS）+ `apps/web/server`（Hono+TS，对外 :8787）
- 对照 worker：`apps/web/backend`（Python，由 TS `app.cli` 调用）
- 3D CLI：`workers/packaging/`
- 本机配置：侧栏「设置」→ 默认 `apps/web/backend/data/settings.json` + `settings.secrets.json`（gitignore；`WB_DATA_DIR` 可改）。密钥不要写进前端或仓库。
- 文档入口：`README.md`（启动、设置）、`DESIGN.md`（视觉）、`docs/00-charter.md`（8/31 章程）、`docs/adr-004-ousterhout-design.md`（深模块）、`docs/designs/review-job-module.md`（对照/对红/打样入队）、`CHANGELOG.md`、`TODOS.md`。实现约定见下面「设计哲学」。
- 入口：开发口 `:5173`（Vite 听本机网卡，`/api` 反代到 8787）；产品/验收入口 `:8787`。不要再加第三个 HTTP 入口。
- 旧 `apps/web/frontend/` 已退役，不要再往里面加功能。

## 加长作业（对照 / 对红 / 打样）

对照 / 对红 / 打样共用作业合同。确认合同不必启动产品。

0. 不启动产品、先核对 CLI 合同：

```bash
cd apps/web/backend && PYTHONPATH=. .venv/bin/python -m app.cli --help
```

禁止：`uvicorn`、新 FastAPI 路由、把 `m.save_task` 抄回 CLI。产品入口仍是 `./scripts/dev-start.sh` → Hono `:8787`。

1. CLI 在 `apps/web/backend/app/cli.py`。stderr 打 `STAGE <name>`。stdout 最后一行是结果 JSON（不要 `ocr_text`）。不要 `save_task`。
   打样不是 `app.cli` 子命令；`jobs.ts` 调 `workers/packaging`；HTTP 仍是 `/api/mockups`。

2. 第一次 queued 落盘之后，只有 `apps/web/server/src/jobs.ts` 再写任务文件。`enqueue({ kind, id })`。路由只 save queued 一次，之后这个 tid 归 `jobs.ts`。

3. Hono 动作立即返回。没有 `/api/jobs` 资源。

4. 测试：抄 `jobs.test.ts` 的对照块。必写断言：第二单 queued、GET 无 `job_pid`、没有最后一行 JSON →「对照中断」、对红失败仍可签字。pytest：CLI 不 `save_task`；`--help` 含 `STAGE` / `save_task` / `packaging`。

5. UI 等待：`shouldShowWaitCard`（`queued` | `running` | `comparing`）。

调试：对外 `job_error` 用短中文。Node 日志写 problem + cause + fix。打开 `DATA_DIR/tasks/{tid}.json`。不要新 FastAPI 路由。

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

- 产品想法 → /office-hours
- 架构 → /plan-eng-review
- 完整审查 → /autoplan
- 缺陷 → /investigate
- 发 PR → /ship（只在 Mac 开发机。杭州生产机禁止 /ship 产品功能。）
- 合 main → /land-and-deploy（只合 GitHub。不重启杭州、不改 DNS。）
- 杭州上线 → 合 `main` 后等 `hangzhou-release` 变绿，再等约 20 秒，公网 health 的 version 等于刚合进去的 VERSION。不要报已上线。不要给杭州贴 pull / rebuild / 重启 8787 的升级提示词，除非 runner 灰掉或对照挡住发版。
- 配置发布 → /setup-deploy
- 写 issue → /spec

## Design System

改任何界面之前先读 `DESIGN.md`。字体、色、间距、侧栏、核对页都以那份为准。锁定稿是 Figma Web 页，不是飞书顶栏。

- Figma：https://www.figma.com/design/BL3PGUjLGLPb9iUZMzRhD6 （`Web · 锁定稿`。侧栏材质对照：`Web · 侧栏材质对照`。iPad 页是探索，不是实现依据。）
- Ant Design 6 只当零件箱。`colorPrimary` = `#805898`，不要默认蓝，不要旧主色 `#722ED1`。
- 左侧玻璃侧栏切「审稿台 / 打样台 / 历史记录 / 设置」。展开 280px，折叠 76px。不要飞书顶栏。页底淡紫雾；侧栏与主区连成一块 28px 圆角工作场。≤1024 默认折叠；≤720 展开为遮罩抽屉。
- 侧栏顶用 `apps/web/ui/public/brand/logo-mark.png`。折叠时悬停变成展开按钮（同一 44pt）。完整 `shine-mage.png` 只放拒绝页。
- 左下角飞书头像 36px + `花名（真名）` 15px，例如 `天元（魏炜）`。
- 空审核单不画三栏。设置里有「外观」：主题、13–28px 字号（可手写）、侧栏材质（实心 / 毛玻璃 / 液态玻璃）、侧栏雾面对比度滑条、差异标记。只写 `localStorage`。深色走品牌紫雾，不是灰黑中台。
- 审稿：专属核对页，左画布 + 编号钉，右一对一检视。结论由人写。禁止「AI 已过审」。
- 历史记录是侧栏 tab，不是第三张台。
- 打样台 8/31 不对业务开放。QA 时标出任何与 `DESIGN.md` 不符的实现。

## Testing

- 服务端：`npm run test -w beian-server`（`node:test`，`apps/web/server/src/*.test.ts`）
- 界面：`npm run test -w beian-ui`（`node:test`，`authGate` / `nav` / `appearance` / `tasksBoard` / `waitCard`）
- 对照 worker：`cd apps/web/backend && .venv/bin/python -m pytest -q`
- 全量：仓库根目录 `npm test`（server + ui + pytest）
- 类型：`npm run typecheck -w beian-server` 与 `npm run build -w beian-ui`
- 新逻辑要有行为测试（含失败路径）。不要把密钥写进测试。

## 设计哲学

来源：John Ousterhout《软件设计的哲学》第 2 版，经 Codex 顾问蒸馏（`docs/adr-004-ousterhout-design.md`）。管复杂性，不是把文件切碎。

- 以 2026-08-31 刘籽烨独立完成 Excel↔PDF 人工终审为当前首要目标；不为 ERP、BI、自动审批或 3D 业务开放扩展设计。
- 优先做深模块：对外接口少而稳定，把进程、路径、超时、供应商差异和失败处理藏在实现内。
- 遇到只转发参数、迫使调用者理解内部步骤的浅模块，先尝试加深现有模块，不要继续叠包装层。
- 把 `apps/web/server` 作为唯一 HTTP 产品边界和 `:8787` 唯一验收入口。
- 把 `apps/web/backend` 视为 worker；TS 只能通过 `python -m app.cli` 调用，不得新增 Python HTTP 路由或以 uvicorn 启动产品。
- 不得在 `:5173`、`:8787` 之外增加第三个开发、验收或生产入口；必须写清每个现存入口的用途。
- 新登录、身份、会话和计费能力只放在 `apps/web/server` 的 Hono 层，不得复制到 Python。
- 保持不同层有不同抽象：UI 表达审核动作，Hono 表达产品用例，Python 表达对照命令，`workers/packaging` 表达 3D 作业。
- 把复杂度向下拉：调用者不应知道 Python 模块结构、Blender 命令、飞书 OAuth 步骤或供应商账单分页。
- 会一起变化且共享隐藏知识的代码放在一起；仅因文件较长，不得机械拆分。
- 不得「一页签一个 package」或「一动作一个 5 行函数」；按稳定接口和信息隐藏划分模块。
- 新增参数前先判断能否在模块内部推导默认值，避免把特殊情况和供应商细节泄漏给调用者。
- 能通过接口定义消除错误就不要增加错误分支；不能消除时，返回可执行、面向用户的失败原因。
- `workers/packaging` 缺 Blender 时必须明确失败，不得静默降级、伪造成功或另建 3D 流水线。
- 每个非琐碎改动先比较至少两个设计，记录为什么选择接口更小、泄漏更少的方案；预留约 10%–20% 时间做设计。
- 注释写约束、原因和失败语义，不复述代码；名称必须体现产品边界，如 worker、snapshot、human decision。
- 沿用已有术语、路径和错误格式；发现 `frontend/`、FastAPI、Hono 三套说法并存时，不得再发明第四套。
- 人工终审不可抽象成机器过审；账单 `charge_status` 必须保持 `unknown`，除非已有可核验的供应商扣费事实。

## Deploy Configuration (configured by /setup-deploy)

- Platform: 杭州 Windows（UU 远程「人事-台式」）+ Cloudflare Named Tunnel。不是 Fly / Vercel。GitHub Actions 只跑 **self-hosted `hangzhou`**（机器名 `hangzhou-windows`），禁止 GitHub-hosted runner 升生产。
- Production URL: https://www.jianghua.site
- Deploy workflow: `.github/workflows/hangzhou-release.yml`（`push` `main` / `workflow_dispatch` → 本机 `D:\beian\scripts\windows\release.ps1`）。
- Deploy status command: 无平台 CLI。看 [hangzhou-release](https://github.com/weiweity/beian/actions/workflows/hangzhou-release.yml) 是否绿。杭州环回才是杭州进程：`curl -sS http://127.0.0.1:8787/api/health`。公网 health 仅在 Named Tunnel 跑在杭州时有效。
- Merge method: squash
- Project type: web app（Hono `:8787`）
- Post-deploy health check: Actions 绿后再等约 20 秒，`https://www.jianghua.site/api/health` 的 `version` 等于刚合进去的 `VERSION`，且带 `jobs.illustrator`。隧道必须在杭州；Mac 上的 cloudflared 不当生产。`/api/health` 的 `version` 目前写死在 `apps/web/server/src/index.ts`，不能单独当发版证据；以杭州工作树 `VERSION` 文件和 merge SHA 为准。

### 机器分工

- Mac：开发。入口 `http://127.0.0.1:8787`。跑 `/ship`（出 PR）和 `/land-and-deploy`（squash 合 `main`）。不要 SSH。不要把 `www.jianghua.site` 当本机开发入口。
- 杭州 Windows「人事-台式」：生产。入口 `https://www.jianghua.site` → 本机 `:8787` → Cloudflare Named Tunnel（只在杭州跑）。仓库 `D:\beian`，数据 `C:\supply\data`（`WB_PUBLIC=1`，`WB_DEV_DISPLAY_LOGIN=false`）。self-hosted runner 机器名 `hangzhou-windows`、标签 `hangzhou`。密钥只在杭州开工板 / `C:\supply\data`，不进仓库；Mac 不要要、不要写密钥。
- 远程：UU 远程用来看着人事-台式。Mac 对话不能 SSH 进杭州，也不能把 UU 当成自动部署后端。杭州要开机 + UU 登录、不要睡眠。保活是登录后常驻（不是无人值守 Windows 服务），由杭州运维，不进仓库。

### Custom deploy hooks

- Pre-merge: `/ship` 已跑 `npm test` 与 ui build。Mac `/land-and-deploy` 只合 GitHub。
- Deploy trigger: **合进 `main` 后由杭州 self-hosted runner 跑 `release.ps1`**。对照/打样/Illustrator 在跑会失败并保持旧进程。日常 Mac 只合 `main`、等 Actions 绿。杭州手工补跑同一脚本只在 runner 灰或对照挡住时由杭州自己执行，Mac 不要主动贴：

  脚本先 `fetch`、丢掉 npm 改脏的 `package-lock.json`；若还有别的本地改动则**不停** 8787。通过后才停监听 8787 的进程树再 pull（2–5 分钟公网空白）。`npm ci` 不再改锁文件。pull/编/起失败且 8787 没听时，用已有 `beian-server-8787` 计划任务把旧进程拉回来。不动 cloudflared，不杀全部 `node.exe`。PowerShell 环境变量用 `$env:WB_DATA_DIR`（不要 `set`）。密钥用网页开工板填，不进仓库。Cloudflare Named Tunnel 只在杭州跑，指 `http://127.0.0.1:8787`。Mac 必须停掉 `cloudflared tunnel run beian`。不要用 `./scripts/dev-start.sh` 当杭州生产启动（zsh）。细节见 `scripts/windows/README.md`。

- 杭州 Grok 禁止：在生产机 `/ship` 新功能、改产品代码当开发机用、把生产隧道指到 Mac、对照跑着时 pull/重启、`git reset --hard`。发版后若只脏 `package-lock.json`，杭州自己 `git checkout -- package-lock.json`。
- Mac Grok 禁止：
  - `cloudflared tunnel run beian`（隧道只能在杭州，抢了就 1033/串台）
  - 合完 PR 立刻说「已上线」
  - 给杭州贴 pull / rebuild / 重启 8787 的升级提示词（除非 GitHub Settings → Actions → Runners 里 `hangzhou-windows` 变灰，或对照/打样/Illustrator 挡住发版）
  - 把 `www.jianghua.site` 当本机开发入口
  - 改 Cloudflare DNS、飞书控制台、买云、映射端口
  - 指挥杭州改产品代码或当开发机
  - 向杭州要密钥
- 杭州运维（Mac 不改、不贴升级步骤）：Clash 系统代理时备案域名必须直连，否则进度条会绕日本节点；Error 1033 = Named Tunnel 和 `:8787` 都不在，杭州自己拉起，Mac 不动 DNS。站点拆包是以后的产品活。
- `release.ps1` 里 `schtasks /Create /F` 重建 `beian-server-8787` 时，启动脚本可能写回 `%TEMP%\beian-start-prod.cmd`。自动更新仍能完成。把「不限时 + `C:\Tools\beian-server-run.cmd`」写进仓库现在不是必须。隧道任务 `beian-cloudflared` 发版不会动。
- Deploy status: [hangzhou-release](https://github.com/weiweity/beian/actions/workflows/hangzhou-release.yml) 绿 → 约 20 秒 → 公网 health 的 version 等于 VERSION。公网再用 `/canary https://www.jianghua.site` 前，先确认 Mac 没有 cloudflared。
- Health check: `https://www.jianghua.site/api/health` 必须打到杭州。细节见 `scripts/windows/README.md`。
