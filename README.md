# beian

供应链飞书网页。一个工作场，两张台：审稿台（Excel ↔ 备案 PDF，人终审）、打样台（平面稿 → 3D）。

第一期用户刘籽烨。8/31 先交审稿台。

## 仓库

| 路径 | 内容 |
|---|---|
| `apps/web/ui` | React + Ant Design 6 审稿台 / 打样台 / 历史 / 设置 |
| `apps/web/server` | Hono + TypeScript，对外 HTTP `:8787` |
| `apps/web/backend` | Python 对照 worker（TS 用 `python -m app.cli` 调用）。PDF 按页分为活字 / 转曲 / 图片：活字直接读文字层，其他页只跑一次 OCR，再进入既有字段规则与单钉证据收敛；成分表按完整原料原子核对，并只在可靠正文锚点或高密度成分块内定位，模糊命中保留为人工疑点 |
| `workers/packaging/` | 2D→3D CLI，打样台调用。V2 以显式 `cut/crease/...` 语义为结构事实；确定性曲线适配、统一毫米坐标、连通分量隔离和有界拓扑只消费已确认的结构语义。无对象语义的旧稿目前只盘点与源稿绑定的纯描边候选层，公开选层入口完成前不得形成生产候选或进入 Blender。管理员在真实展开图上只选产品正面；候选身份和几何推导的默认朝向仍作为内部锚点交给同一确认引擎，其余五面自动推导。不按颜色、零散矩形或 bbox 静默套盒。macOS 用 AppleScript，Windows 由登录桌面的 Illustrator Agent 经命名管道执行现有 VBS/JSX，服务进程不在 Session 0 拉起 Illustrator。平面出图用 pymupdf（对照同一 Python）；杭州不需要 macOS qlmanage。PPT 用两张白底写 OOXML；两张白底再合成一页 PDF。缺 PPT/PDF 仍算出图 |
| `docs/` | 章程、ADR、设计 |

旧 `apps/web/frontend` 已删除。网页入口只有 `apps/web/ui` + Hono `apps/web/server`；对照规则和 Blender 仍是 Python。见 `docs/adr-002-typescript-http.md`。

## 文档

| 文件 | 内容 |
|---|---|
| `DESIGN.md` | 视觉、侧栏、审稿/打样文案 |
| `apps/web/README.md` | Web 子系统边界、入口与本地启动关系 |
| `apps/web/ui/README.md` | UI 开发、构建与浏览器回归入口 |
| `apps/web/backend/data/gold/README.md` | L2 金标数据格式与人工核定边界 |
| `apps/web/backend/app/reference/README.md` | 受控化妆品原料参考词典的判定边界、来源与更新流程 |
| `docs/00-charter.md` | 8/31 章程 |
| `docs/adr-001-frontend-stack.md` | 历史前端选型；旧前端已退场，以当前 React + Hono 结构为准 |
| `docs/adr-002-typescript-http.md` | 为什么对外 HTTP 是 TypeScript |
| `docs/adr-003-settings-overlay.md` | 本机设置覆盖密钥文件 |
| `docs/adr-004-ousterhout-design.md` | 深模块、唯一入口、8/31 前不拆引擎 |
| `docs/adr-005-packaging-structure-v2.md` | 包装语义 IR、人工确认闸门与 V1 退场条件 |
| `docs/adr-006-continuous-complexity-governance.md` | TypeScript 控制面 / Python 计算内核边界、死代码单调基线与 PR 质量门禁 |
| `docs/designs/compare-pdf-ingest-v2.md` | PDF 按页选源、单 OCR、版面区域与单钉证据合同 |
| `docs/designs/review-job-module.md` | 当前对照、对红、打样入队与失败语义合同 |
| `docs/designs/review-rework-loop.md` | 部分被替代；保留对红循环与金标语义的历史依据 |
| `docs/designs/hangzhou-setup-board.md` | 部分被替代的杭州开工板批准快照；现行运维合同见本 README 与 Windows README |
| `docs/designs/two-desks-review-and-mockup.md` | 已被替代的早期两张台需求发现记录 |
| `docs/risks.md` | 密钥、Tunnel、3D 验收门 |
| `CHANGELOG.md` | 已发布版本 |
| `TODOS.md` | 未做项 |
| `AGENTS.md` | 给代理的硬约束、加长作业合同、易忘约定（MICRO 不改 `package.json` 三位；禁止 `git add -A`） |
| `scripts/windows/README.md` | 杭州 Windows 生产备忘 |
| `workers/packaging/README.md` | 打样 CLI、`PackagingStructure` 语义合同、完整盒型与正面锚点确认、pymupdf 平面出图、白底/PPT/GLB 产物合同 |

## 本机启动

```bash
./scripts/dev-start.sh
```

- 产品 / 验收：http://127.0.0.1:8787/ （先 `cd apps/web/ui && npm run build`）
- 开发 UI：http://127.0.0.1:5173/ （`npm run dev:ui`；Vite 听本机网卡，`/api` 反代到 8787，端口占用即失败）
- 台地址：`/reviewup` 审稿台、`/reviewup/new` 审稿工作台、`/review/:id` 核对页、`/mockup` 打样台、`/mockup/new` 打样工作台、`/mockup/:id` 打样单、`/history`、`/settings`。旧 `/` `/new` `/review` 会转到新地址。后退换台。
- 审稿双井或打样 `.ai` 选齐后会按 1 MiB 分片上传。进度到 100% 只表示浏览器已发完，看到「服务器确认中」后还要等「待开工」；网络波动会自动重连 3 次，仍失败则显示「已暂停」，服务器保留已收到的字节。SPA 换台和整页刷新都能找回上传会话；重新选择同一份文件会从服务器偏移量继续。要换稿点「停止并删除 / 删除暂存」，会同步清掉服务器会话或待开工回执。
- 打样台可按品名/文件名搜索，并在看板与表格之间切换；卡片右侧状态可换行，不遮住品名。新稿支持两份同时上传，第三份会提示等待其中一份完成。历史记录同时列出上传中、服务器确认、已暂停、待开工、处理中和已结束记录；筛选后固定每页 10 行，有删除权限时点「编辑」可全选本页并批量删除可删除记录，进行中的作业不能删除。删除请求丢响应时可安全重试。核对页默认打开已完成的第二版（如有），可切回上一版，也可用「全屏核对」。页图优先加载可放大的矢量核对面，初始 1× 不创建恒等 transform 合成层，生成或加载失败时自动退回高清 PNG；进页先跳到第一条未处理疑点，图上只显示当前字段的钉和框，面积达到页面 30% 的框按未定位处理。横向核对窗先用同事口吻说明原因和要核对的内容，结论下拉紧跟在嘱咐后面，下方并排显示 Excel 应印与稿上读到；命中比只在「查看全部」中出现，窗底显示这单和本页还剩几条。标为一致或忽略后自动进入下一条未处理疑点。核对窗位于应用顶层，可拖到视口任何位置，收起后仍能贴近底边。
- 网页新打样单固定进入语义结构 V2，不再回落到旧刀线猜测。状态分开显示：`识别结构中` → `待确认结构` / `当前不支持` → `打样中`。有显式对象语义的 AI 才会经曲线适配、统一坐标、连通分量隔离和拓扑预检发布完整“盒身环 + 封口组件”候选，并把真实 artwork 放在盒型图下；没有对象语义的旧 AI 目前只盘点与源稿绑定的纯描边候选层，页面仍提示回 Illustrator 标记并重新上传，公开选层入口完成前不能进入生产拓扑或 Blender。标准相向对开摇盖按两个物理成员的组合覆盖识别；原始 PDF 未绘制区和物理未覆盖区都保留 Alpha，在 Blender 中露出配置的纸板基底，不再要求单片覆盖整面或填白。未知基材默认白卡，牛皮纸/深色纸板必须显式配置；最终 GLB 会解码内嵌 PNG 核对 RGBA/Alpha 像素，并回读验证六面 UV 方向、镜像以及纸板 Core 的六个实体边界。外盒与内衬都成立时仍是不同整套候选、较大盒型在前，颜色不参与判断；页面只用“上一张 / 下一张”切换真实展开图，不展示尺寸、封口算法或 CAD 术语。管理员只选择印有品名和主视觉的产品正面并点「生成打样图」；预检引擎为每个正面写入几何推导的默认朝向，页面不再要求客户选择 0/90/180/270°。确认过期返回可刷新重选的 409，语义上不能成盒返回 422，并在原位显示，不当成网络中断。未确认、超出资源预算或严格复核失败时不会进 Blender。侧栏版本号来自已登录的 `/api/status.version`，紧跟在姓名下面，不在前端另写常量。合入后的杭州 Session 1 Agent → VBS → 唯一 JSX 身份冒烟是 L1 发布门；真实 Illustrator → Blender、六面贴图和管理员金标是独立 L2 业务验收，不是运行时开关。
- Windows 打样要求管理员处于已登录的交互桌面，登录任务 `beian-illustrator-agent` 会在 Session 1 建立受 ACL 保护的 UTF-8 命名管道。Hono 和 Actions runner 仍可留在 LocalSystem/Session 0，但只能通过该管道请求 Illustrator；用户注销、Agent 心跳过期或持久故障围栏尚未由交互管理员确认清除时，开始打样会在领取上传回执前返回可重试的 412，不会退回 Session 0 启动 Adobe。锁屏或 UU 断开不等于注销；恢复步骤见 `scripts/windows/README.md`。

5173 登录闪或 `/api` 返回 HTML / 空 Content-Type：打开 http://127.0.0.1:8787/，或重启 `npm run dev:ui`。飞书授权失败回到飞书重试，不要把远程验收人指到本机。JSON 404（任务不存在等）不是 Vite 挂了。

不要跑 uvicorn。没有 `app.main`。产品入口只有 Hono `:8787`。

测服务端、界面和对照 CLI：仓库根目录 `npm test`（Mac；不打外网）。复杂度治理使用隔离的质量工具链：Mac 首次运行先在 Node 20.19+ 或 22.12+ 下执行 `npm ci --prefix tools/quality`，再把 Vulture 装进现有 worker 虚拟环境：`apps/web/backend/.venv/bin/python -m pip install -r apps/web/backend/requirements-quality.txt`；随后运行 `npm run test:quality` 和 `npm run quality`。PR 的 GitHub-hosted Linux Node 22 job 依次执行质量合同、单调基线、完整 L0 与独立类型检查；另一个 GitHub-hosted `windows-2022` job 只在 Windows PowerShell 5.1 下实跑 `.NET File.Replace` 的无备份原子替换合同。两者都不使用杭州 self-hosted 生产 runner，也不调用 `release.ps1`；`/ship` 同样要求这些门禁都绿。`npm run quality` 检查 Knip 与高置信 Vulture，并要求 `config/quality/dead-code-baseline.json` 只减不增；TypeScript 则由 `npm run typecheck` 独立检查。本地会自动从 `origin/HEAD`（回退 `origin/main` / `main`）读取目标分支基线，找不到就失败并要求显式传 `--base-ref`，PR CI 则使用精确 base SHA。同文件同名诊断按出现次数核对，不会因行号移动误报，也不会把新增的第二处折叠掉。编排器只读基线，不会自动删代码。人工清理前可跑 `npm run quality:deep` 查看 production/低置信候选。Knip 锁在 `tools/quality/package-lock.json`，Vulture 锁在 `apps/web/backend/requirements-quality.txt`；两者都不进入产品 Node 合同或杭州生产依赖图。浏览器交互回归另跑 `npm run test:e2e`；它使用 Vite + 合成 API，验证页面行为，不替代真实 Hono `:8787` 或杭州 Windows L1。杭州生产不跑单测；可信 `main` release transaction 会检查 health/version/listener/logo，并通过生产 Session 1 Agent 完成管道 → VBS → 唯一 JSX 的身份冒烟。真实稿结构、六面贴图和 Blender 仍属于人工 L2。只要服务端：`npm run test -w beian-server`。只要界面：`npm run test -w beian-ui`。

`npm run test:quality` 同时校验 `.agents/skills` 实际目录、审核清单与 `skills-lock.json` 完全一致；空锁、额外 skill、远程来源、符号链接、自动 shell 权限或绕过包装器的命令都会失败。仓库内 `antd` skill 是 vendored 权威源，不能用标准 skill restore/update 从上游覆盖；需要恢复时从受信任的 Git 提交还原并重新核验哈希。知识查询只走 `node scripts/quality/antd-readonly.mjs`：它固定已审核的 `@ant-design/cli@6.6.1`、关闭更新检查、不经 shell、只读仓库内路径，并拒绝 setup、升级、外部提交和可写迁移参数。CLI 缺失或版本不符时失败关闭，由独立、显式批准的工具维护任务处理。

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

这不是 3D 打样容器：打样台仍要求宿主机 Blender 与 Illustrator；macOS AppleScript、Windows VBScript/COM 都只负责启动同一份 JSX 语义导出器，不随镜像提供。容器能启动不代表 Windows 3D 流水线已验收。

</details>

## 给别人用：设置页

登录后点侧栏「设置」。管理员可在这里保存飞书、百度 OCR、MiniMax、Python、Blender 配置并扫描本机程序；其他审核员可看状态和运行允许的探测，但不能改系统配置或扫描电脑。开工板看登录/审稿/打样能不能干活；费用账单进页再拉，不轮询。外观（主题、字号、侧栏材质：实心 / 毛玻璃 / 液态玻璃）只写这台浏览器，不进密钥文件。

- 密钥只写到本机数据目录（默认 `apps/web/backend/data/settings.secrets.json`，0600，不进 git；可用 `WB_DATA_DIR` 改）
- 界面只显示是否已填
- 「测一下」只在服务端连外部 API
- 也可以继续用 `apps/web/backend/.env.baidu` / `.env.secrets` 打底，设置页覆盖它们

账号目录写在同一数据目录下的 `users.json`（`name` / `open_id` / `role`，可选 `disabled`）。飞书 `open_id` 是唯一授权键；姓名和花名只用于显示，不能授予管理员权限。角色只配置为 `admin` / `reviewer` / `viewer`，不在 JSON 里散落页面级权限开关：

| 角色 | 打样单 | 建单 | 确认结构 | 删除 |
|---|---|---|---|---|
| `admin` | 团队全部可读、可下载 | 可以 | 可以确认任意待确认单 | 任意已结束单 |
| `reviewer` | 团队全部可读、可下载 | 可以 | 不可以 | 仅本人已结束单 |
| `viewer` | 团队全部可读、可下载 | 不可以 | 不可以 | 不可以 |

审稿单仍保持原有所有者隔离；这里只把需要协作的打样单定义成团队资源。服务端以独立 `confirm_structure` 能力保护确认动作，页面只按 `/api/auth/me.perms` 显示可用动作，不能靠隐藏按钮代替服务端授权。管理员必须显式写成同一条记录里的 `open_id` + `role: "admin"`。删除记录或设置 `disabled: true` 后，该账号已有会话会在下一次请求立即失效；角色调整也会立即同步。重复 `open_id`、未知角色或不可读目录都会失败关闭：本机显示名登录 API 保留 503，飞书 OAuth 回调则进入“系统故障”错误页，二者都不会伪装成普通无权限或泛化 500。显式退出直接撤销 token，即使目录暂时损坏也不会在修复后恢复登录。

## 飞书

在飞书开放平台把重定向配成：

`https://www.jianghua.site/api/auth/feishu/callback`

（或你在设置页写的「对外网址」+ `/api/auth/feishu/callback`）

只放行伸美企业的飞书号。同一企业第一次进来会以 `reviewer` 写入本机 `users.json`；以后每次请求都重新以该目录中的 `open_id` 绑定校验角色。其他公司主体直接拒绝，加白名单也进不来。

公网 / Tunnel 前打开设置里的「公网模式」。服务端会同时拒绝并从持久化会话中清除旧显示名 token；显示名会话即使在非公网模式下也只能用于 loopback 主机。

## 不要提交

密钥、`.venv`、任务 JSON、上传稿、`.ai/.pdf/.xlsx` 样本、`settings.json`、`settings.secrets.json`、Vite 缓存（`.vite/`）、`.claude/`、`docs/designs/hangzhou-production-cutover.md`。见 `.gitignore`。不要 `git add -A`。

## 生产

杭州 Windows + Cloudflare Named Tunnel → `127.0.0.1:8787`。Mac 只做开发。合进 `main` 后，杭州 **self-hosted runner**（标签 `hangzhou`）跑 `scripts/windows/release.ps1`。workflow 先用 GitHub API 把事件 commit 的发版组件下载到 `RUNNER_TEMP`，并把同一个不可变 `GITHUB_SHA` 传给脚本；依赖核对、VERSION、journal、Git 锁所有权、ff-only 和最终 HEAD 全部绑定该 SHA，即使后续 main 已推进也不会用旧恢复协议部署新提交。bootstrap 不会在恢复 journal 建立前 checkout/reset 生产 index。空闲时 Hono 以可续租、会自动过期的 drain 原子停止动态页面和全部业务 API 请求；服务端在最外层 `app.fetch` 为每个请求建立生命周期记录，只有 Hono handler 与 Node `ServerResponse` 的 `finish/close/error` 两个闩锁都结束才清除，并同时等待内存 worker 槽、持久作业、上传、作业通知 outbox 与签字通知收尾。不可读任务记录会给出 `jobs_unknown`，不再当成空闲。静态资源、health 和 release control 保持可用。受 ACL 保护的 journal 与 SYSTEM watchdog 落盘后，短租约提升为不自动过期的事务围栏，只有同一提交/恢复事务能解除。停服前还要证明 npm/Python 依赖图未变，并实际导入真实 Hono 服务入口，确认现有运行环境可离线冷启动和旧 UI 快照可恢复；真实依赖变化或环境不完整会保持旧站在线并拒绝发版。回滚先切回旧 SHA、再探测实际将启动的旧树，不联网安装或重建旧 UI；硬中断遗留的 index、HEAD/main、ORIG_HEAD 及对应 reflog 锁，只有在 journal 的不可变 merge 所有权、全缺失基线、精确白名单、进程、时间和独占句柄全部吻合时才会逐个删除。全程不动 cloudflared、不杀全部 node.exe，也不按 netstat PID 强杀。脚本会同步 InteractiveToken 登录任务 `beian-illustrator-agent`，但不会把 Illustrator 变成 Session 0 服务；没有登录桌面时打样明确失败。`0.19→0.20` 的一次性维护窗和恢复证据见 `scripts/windows/README.md`。侧栏/拒绝页图标走 `/brand/…`（`apps/web/ui/public`）；Windows 上若 404，确认已拉到 v0.12.0.1+。
