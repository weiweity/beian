# AGENTS.md

请用中文回复。

## 项目

`beian`：供应链备案审核网页。打样台调用 `workers/packaging`（缺 Blender 要失败写清）。平面出图用 pymupdf（对照同一 `.venv`），杭州不要装 qlmanage。第一期验收人刘籽烨，收尾 2026-08-31。

## 硬约束

- 不重写审核引擎和 3D 流水线，在迁入代码上改。
- 不重写 3D 流水线。打样台只调用 `workers/packaging`，缺 Blender 要写清失败。
- 不得提交 `.env`、`.env.baidu`、`.env.secrets`、`backend/data` 运行时文件、稿件、Vite 缓存、`.claude/`。
- 不得 `git add -A`。`docs/designs/hangzhou-production-cutover.md` 禁止进仓（已 gitignore）。推迟的 `docs/designs/login-and-permissions.md` 未 ignore，发版只按文件名 add。
- 不得读取或打印真实密钥。
- 不得自行改 DNS、发布飞书版本、购买云、映射公网端口。
- 公网/Tunnel 后禁止显示名裸登录。
- Mac 绿灯不等于 Windows 已验收。杭州生产怎么升版见文末「Deploy Configuration」。合 `main` 后 runner 自动跑 `release.ps1`；Actions 红或公网 health 对不上 VERSION 时不要报已上线。
- 对照失败或已完成的单不能签字；干净签字单不能再对红；对红后优先读非空 `hits_v2`（空数组回退第一轮）。工艺说明 / 颜色要求 / 版本号的 pending 不挡签字。
- 飞书授权失败回到飞书，不要把远程验收人送到本机 `:8787`。JSON 404 不是 Vite 挂了；只有 HTML 或空 Content-Type 才当开发页没转到 8787。

## 目录

- 网页：`apps/web/ui`（React+TS）+ `apps/web/server`（Hono+TS，对外 :8787）
- 对照 worker：`apps/web/backend`（Python，由 TS `app.cli` 调用）
- 3D CLI：`workers/packaging/`
- 本机配置：侧栏「设置」→ 默认 `apps/web/backend/data/settings.json` + `settings.secrets.json`（gitignore；`WB_DATA_DIR` 可改）。密钥不要写进前端或仓库。
- 文档入口：`README.md`（启动、设置）、`DESIGN.md`（视觉）、`docs/00-charter.md`（8/31 章程）、`docs/adr-004-ousterhout-design.md`（深模块）、`docs/designs/review-job-module.md`（对照/对红/打样入队）、`CHANGELOG.md`、`TODOS.md`。实现约定见下面「设计哲学」。
- 入口：开发口 `:5173`（Vite 听本机网卡，`/api` 反代到 8787）；产品/验收入口 `:8787`。不要再加第三个 HTTP 入口。
- 旧 `apps/web/frontend/` 已删除；网页入口只有 `apps/web/ui` + Hono `apps/web/server`。

## 加长作业（对照 / 对红 / 打样）

对照 / 对红 / 打样共用作业合同。确认合同不必启动产品。

0. 不启动产品、先核对 CLI 合同：

```bash
cd apps/web/backend && PYTHONPATH=. .venv/bin/python -m app.cli --help
```

禁止：`uvicorn`、把 FastAPI 加回来、把 `save_task` 抄回 CLI。产品入口仍是 `./scripts/dev-start.sh` → Hono `:8787`。

1. CLI 在 `apps/web/backend/app/cli.py`。stderr 打 `STAGE <name>`。stdout 最后一行是结果 JSON（不要 `ocr_text`）。不要 `save_task`。
   打样不是 `app.cli` 子命令；`jobs.ts` 调 `workers/packaging`；HTTP 仍是 `/api/mockups`。packaging stderr 打 `STAGE render_pdf|blender|export`（出图/打样/导出）。平面出图 pymupdf 先，macOS `qlmanage` 只在 pymupdf 失败时兜底。

2. 第一次 queued 落盘之后，只有 `apps/web/server/src/jobs.ts` 再写任务文件。`enqueue({ kind, id })`。路由只 save queued 一次，之后这个 tid 归 `jobs.ts`。

3. Hono 动作立即返回。没有 `/api/jobs` 资源。

4. 测试：抄 `jobs.test.ts` 的对照块。必写断言：第二单 queued、GET 无 `job_pid`、没有最后一行 JSON →「对照中断」、对红失败仍可签字。pytest：CLI 不 `save_task`；`--help` 含 `STAGE` / `save_task` / `packaging`。打样出图测 pymupdf（`test_packaging_thumbnail.py`），不要假定有 qlmanage。打样 PDF 测铺白和 Pillow 兜底（`test_packaging_dieline.py`）：pymupdf 已落盘则不覆盖，不要让人再装插件。

5. UI 等待：`shouldShowWaitCard`（`queued` | `running` | `comparing`；`done`/`failed`/`completed` 不当等待）。离开核对页后，看板 `liveJobLine` 和侧栏 `liveNavPulse` 仍显示阶段。打样台只交稿；点进度/已出图进单独打样单（WaitCard 或一屏三图：正面+侧面、反面+侧面、GLB），不要在打样台底下摊开结果。下载提示走 `mockupHud.ts`（不挡点击）；GLB 全屏走 `mockupFullscreen.ts`。等待圆盘是 `WaitLoader`（对照中 / 对红中 / 打样中，不要英文 Generating）。核对页框在 `pinBox.ts`：有 bbox 才画真框，钉在框中心，不编造顶排钉；隐藏钉只藏圆圈；显示框单独开关，拖动画布暂时藏框。缩放在 `canvasZoom.ts`：CSS `transform` 1–6×（滚轮、放大/缩小/复位、点序号放大该框），拖动走 rAF 且禁止 img 原生拖拽，不上 OpenSeadragon。核对窗 `reviewDock.ts` 液态玻璃浮在整页最上面（含侧栏），进页展开并叠在左侧栏上，可随意拖，不挤页图；窗 z 最高可盖画布，夹住不盖页头签字；收起/展开 280ms 动画，可拖，边框上下左右和四个斜角都能缩放；左列当前字段顶栏是疑点/错误点（有才出现）再 Excel 应印 / 稿上 OCR，右列疑点列表；结论在页头签字旁。确认单底部工艺说明 / 颜色要求 / 版本号不进机审（只认字段名开头，不要误杀「执行标准版本号」；旧单假疑点签字时也跳过）。离开核对页或打样台后，历史记录仍列出进行中的单并显示 `liveJobLine`，点进去仍是 WaitCard / 打样单。稿上 OCR 走 `hitText.ts`（`coverage.hit` 回退，并列出 `coverage.miss` 和命中项数；品名/品牌/logo 没字就说明稿上多半是图）。打样先读稿上的刀线/刀版还原切面；密折痕先密后疏试间距；没有刀线才回退已登记 JSON。不能按比例硬套方盒。下载白底只给 `front_right` / `back_left`，不要把 `ai-raster` 或 PPT 质检 PNG 当成白底。预览 inline，点下载才附件。地址按台分开：`/reviewup` `/reviewup/new` `/review/:id` `/mockup` `/mockup/new` `/mockup/:id` `/history` `/settings`，后退换台。旧 `/` `/new` `/review` 302 到审稿台新地址。

调试：对外 `job_error` 用短中文。Node 日志写 problem + cause + fix。打开 `DATA_DIR/tasks/{tid}.json`。不要新 FastAPI 路由。

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

- 产品想法 → /office-hours
- 架构 → /plan-eng-review
- 完整审查 → /autoplan
- 缺陷 → /investigate
- 发 PR → /ship（只在 Mac 开发机。杭州生产机禁止 /ship 产品功能。）没听到用户说 `/ship` 或「开始 ship」不要出 PR。用户说「先不进入 ship」就只改代码。
- 合 main → /land-and-deploy（只合 GitHub。不重启杭州、不改 DNS。）
- 杭州上线 → 合 `main` 后等 `hangzhou-release` 变绿，再等约 20 秒，公网 health 的 version 等于刚合进去的 VERSION。不要报已上线。不要给杭州贴 pull / rebuild / 重启 8787 的升级提示词，除非 runner 灰掉或对照挡住发版。`release.ps1` 碰到 `cannot lock ref origin/main` 要删掉这条 ref 再 fetch，不要秒红。
- 用户贴的 `www.jianghua.site` / 开工板截图是杭州当前 VERSION，不是你工作区未合的分支。没 land 绿之前不要拿公网画面证明「已经改好了」。
- 配置发布 → /setup-deploy
- 写 issue → /spec

## 易忘约定（防记忆漂移）

升 VERSION 时：`VERSION` 文件和 `apps/web/server/src/index.ts` 里的 `VERSION` 常量必须同号。`package.json` 只写三位（npm 不认第四位）：MICRO（`0.12.8.0` → `0.12.8.1`）三位不动；PATCH/MINOR/MAJOR 才改三位。4 位号，本线现为 `0.13.x.0`。用户点名大版本才跳 MINOR。开放 PR 的 VERSION 若落后于 `main`，不合；先 `/ship` 重占号。

魏炜飞书真名或花名「魏炜」才是杭州机箱管理员，能扫 Blender / Illustrator（含 PATH）。不要凭显示名「管理员」提权。升版后旧 cookie 仍是审核员，要重新走飞书登录。伸美其他人默认审稿员：能进审稿台，不能扫本机 exe。2026-08-24 当周不做品牌登录闪屏、申请权限工单（office-hours D1=A）。

飞书推送不必装 lark-cli。点「发一条测试」用已填的飞书应用发给**当前登录**；成功才打开 `FEISHU_ENABLED` 并在空时写入 `FEISHU_OPEN_ID`。`lark_send` 需要 `create` 权限（只读访客 403）。开工板绿 ≠ 籽烨已收到；她当审稿接收人要在「飞书推送」页自己再测。不要把开关 / open_id / bot 当主路径让人手填。探测 id `lark_send` 的 pending/结果必须画在行 `lark`，否则按钮看起来没反应。

MiniMax 未开语义复核是「未用」，不是「可用」；探测是 `GET /v1/models`，不是对话也不是余额。百度 OCR 绿 = 对照同款识别接口通了，不是静默授权。已通的密钥默认折叠，点开才改。

开工板是线性进度 + 7 行清单，不要画成圆环仪表，不要用「通 / 不通」当状态字。界面单测只测纯函数，不引入 RTL。

杭州打样平面出图走 pymupdf（对照同一 `.venv`），不要让人装 qlmanage。macOS Quick Look 只在 pymupdf 失败时兜底。打样先读稿上的刀线/刀版还原切面，密折痕先密后疏试间距，没有刀线才回退已登记 JSON，不能按比例硬套方盒。离开核对页后看板/侧栏/历史记录仍看阶段，不要只把进度画在 WaitCard 上。核对页缩放用 CSS transform，不要接 OpenSeadragon。核对窗液态玻璃浮在整页最上面（含侧栏），进页展开并叠在左侧栏上，可随意拖，不挤页图；窗不盖签字；收起/展开有动画，可拖，边框上下左右和斜角都能缩放；隐藏钉只藏圆圈；显示框单独开关。打样台和打样单主区白底深字（深色主题也是）；GLB 中性环境；每张图右上角下载；页头「下载+PPT」（没写成仍显示，点了出「PPT 没写成，白底仍可下」）；有 PDF 时旁边还能下 PDF；点下载底部提示不挡操作；GLB 全屏居中；截图时下载钮藏起来；全屏被拒写「全屏打不开」。已经出过的白底图要重新打样才会变。PDF 槽按源图比例 contain。打样 PPT 先用两张白底写 OOXML，不依赖 Node；写不出才试演示文稿运行时。缺 PPT 不要把整单判失败；两张白底仍合成 PDF（页底先铺白；pymupdf 写不出且还没落盘才用已装 Pillow，不要盖掉已写成的文件，不要新装包）。

## Design System

改任何界面之前先读 `DESIGN.md`。字体、色、间距、侧栏、核对页都以那份为准。锁定稿是 Figma Web 页，不是飞书顶栏。

- Figma：https://www.figma.com/design/BL3PGUjLGLPb9iUZMzRhD6 （`Web · 锁定稿`。侧栏材质对照：`Web · 侧栏材质对照`。iPad 页是探索，不是实现依据。）
- Ant Design 6 只当零件箱。`colorPrimary` = `#805898`，不要默认蓝，不要旧主色 `#722ED1`。
- 左侧玻璃侧栏切「审稿台 / 打样台 / 历史记录 / 设置」。展开 280px，折叠 76px。不要飞书顶栏。页底淡紫雾；侧栏与主区连成一块 28px 圆角工作场。≤1024 默认折叠；≤720 展开为遮罩抽屉。
- 侧栏顶用 `apps/web/ui/public/brand/logo-mark.png`。折叠时悬停变成展开按钮（同一 44pt）。完整 `shine-mage.png` 只放拒绝页。
- 左下角飞书头像 36px + `花名（真名）` 15px，例如 `天元（魏炜）`。
- 空审核单不画三栏。设置里有「外观」：主题、13–28px 字号（可手写）、侧栏材质（实心 / 毛玻璃 / 液态玻璃）、侧栏雾面对比度滑条、差异标记。只写 `localStorage`。深色走品牌紫雾，不是灰黑中台。
- 审稿：专属核对页，画布吃满宽度。钉和框分开关；「隐藏钉」只藏编号圆圈。左图 CSS transform 缩放（1–6×），拖动走 rAF，禁止原生图片拖拽，不上 OpenSeadragon。核对窗浮在整页最上面（含侧栏），进页展开并叠在左侧栏上，可随意拖，不挤页图；窗不盖签字。收起/展开有动画，可拖，边框上下左右和斜角都能缩放。左列先疑点再 Excel 应印。结论写在页头签字旁。禁止「AI 已过审」。
- 历史记录是侧栏 tab，不是第三张台。进行中的审稿/打样也列在里面，点进去看进度。
- 打样台 8/31 不对业务开放。打样台和打样单主区白底深字（不是紫雾台，深色主题也是）；每张图右上角下载，页头「下载+PPT」；截图时下载钮藏起来。QA 时标出任何与 `DESIGN.md` 不符的实现。

## Testing

三层。`npm test` 只等于 L0。不要在杭州跑单测。不要单测打外网、OCR、Blender、Illustrator COM。

- L0 单测（Mac，`/ship` 必绿）：仓库根目录 `npm test`
  - 服务端：`npm run test -w beian-server`（`node:test`，`apps/web/server/src/*.test.ts`）
  - 界面：`npm run test -w beian-ui`（`node:test`，`src/**/*.test.ts` 自动发现；纯函数，不引入 RTL）
  - 对照 worker：`cd apps/web/backend && .venv/bin/python -m pytest -q`（CLI 契约 + 对照/打样单测。没有 FastAPI 测试）
- L1 冒烟（杭州 `hangzhou-release`）：`release.ps1` 查 health.ok、version==VERSION、`jobs.illustrator`、logo PNG。不跑 `npm test`
- L2 金标（人核定后）：`apps/web/backend/scripts/run_eval.py`。未核定的 `data/gold` 不进默认 `npm test`
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
- 沿用已有术语、路径和错误格式；已删除旧 `frontend/` 和 FastAPI HTTP 壳，产品路径只有 React UI + Hono，对照只走 `python -m app.cli`。
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

- Mac：开发。入口 `http://127.0.0.1:8787`。跑 `/ship`（出 PR）和 `/land-and-deploy`（squash 合 `main`）。不要 SSH。不要把 `www.jianghua.site` 当本机开发入口。不要只开 Vite `:5173` 就点开始打样/对照——`:8787` 没开时 `/api` 会变成 HTML，单不会入队。
- 杭州 Windows「人事-台式」：生产。入口 `https://www.jianghua.site` → 本机 `:8787` → Cloudflare Named Tunnel（只在杭州跑）。仓库 `D:\beian`，数据 `C:\supply\data`（`WB_PUBLIC=1`，`WB_DEV_DISPLAY_LOGIN=false`）。self-hosted runner 机器名 `hangzhou-windows`、标签 `hangzhou`。密钥只在杭州开工板 / `C:\supply\data`，不进仓库；Mac 不要要、不要写密钥。
- 远程：UU 远程用来看着人事-台式。Mac 对话不能 SSH 进杭州，也不能把 UU 当成自动部署后端。杭州要开机 + UU 登录、不要睡眠。保活是登录后常驻（不是无人值守 Windows 服务），由杭州运维，不进仓库。

### Custom deploy hooks

- Pre-merge: `/ship` 已跑 `npm test` 与 ui build。Mac `/land-and-deploy` 只合 GitHub。
- Deploy trigger: **合进 `main` 后由杭州 self-hosted runner 跑 `release.ps1`**。对照/打样/Illustrator 在跑会失败并保持旧进程。日常 Mac 只合 `main`、等 Actions 绿。杭州手工补跑同一脚本只在 runner 灰或对照挡住时由杭州自己执行，Mac 不要主动贴：

  Actions 用 cmd `git fetch`（不要 PowerShell 把 git 的 stderr 当失败），再 `checkout origin/main -- scripts/windows/release.ps1`，这样盘上旧脚本坏了也能自愈。脚本进进程后先把该文件 `checkout HEAD` 清脏，再 `fetch`（只看 LASTEXITCODE；`cannot lock ref origin/main` 只删这一条再拉，网络失败不要动 tracking ref）、丢掉 npm 改脏的 `package-lock.json`；若还有别的本地改动则**不停** 8787。通过后才停监听 8787 的进程树再 `merge --ff-only`（2–5 分钟公网空白）。锁文件没变则跳过 `npm ci`。Git 之后清掉 `GITHUB_TOKEN` 再跑 npm。merge/编/起失败时回到停机前 SHA 再装/编，然后 `schtasks /Run beian-server-8787`。Actions `if: failure()` 也会 `/Run`（超时/取消时 catch 不会跑）。不动 cloudflared，不杀全部 `node.exe`。PowerShell 环境变量用 `$env:WB_DATA_DIR`（不要 `set`）。密钥用网页开工板填，不进仓库。Cloudflare Named Tunnel 只在杭州跑，指 `http://127.0.0.1:8787`。Mac 必须停掉 `cloudflared tunnel run beian`。不要用 `./scripts/dev-start.sh` 当杭州生产启动（zsh）。细节见 `scripts/windows/README.md`。

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
