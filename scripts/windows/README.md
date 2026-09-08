# Windows 生产备忘

第一期只要这台机器能跑：

- Node 20 LTS（对外入口是 `apps/web/server`，不是 Python HTTP）
- Python 3.12
- 仓库根目录 `npm install`；`npm run build -w beian-ui` 后才能打开 `http://127.0.0.1:8787/`
- 启动：Git Bash 跑 `./scripts/dev-start.sh`，或 `npm run start -w beian-server`
- `pip install -r apps/web/backend/requirements.txt`
- `cloudflared` Named Tunnel → `http://127.0.0.1:8787`
- 电源计划：不睡眠（运维项，不当本期验收）

打样台需要本机 Blender 可执行文件路径，在网页「设置」里填。不要只写 `blender`。

对外入口是 TypeScript（`apps/web/server`），不是 `uvicorn`。密钥和路径优先点侧栏「设置」里填。

生产数据必须设环境变量，不要放在 git 工作树里。PowerShell：

```
$env:WB_DATA_DIR="C:\supply\data"
$env:WB_PUBLIC="1"
$env:WB_DEV_DISPLAY_LOGIN="false"
```

cmd.exe 才用 `set WB_DATA_DIR=...`。PowerShell 里写 `set` 不会进子进程。

代码读取 `WB_DATA_DIR`。公网模式（`WB_PUBLIC=1`）若仍指向仓库内 `backend\data`，进程会拒绝启动。

## Illustrator 登录桌面 Agent

`beian-server-8787` 与 Actions runner 是 LocalSystem / Session 0；Illustrator 是带 GUI 的桌面程序，两者不能在同一会话内直接自动化。`release.ps1` 会同步计划任务 `beian-illustrator-agent`：它使用 `InteractiveToken`，只在当前管理员已登录的交互会话启动 `scripts\windows\illustrator-agent.ps1`。任务本身 Hidden，进程用 `-WindowStyle Hidden -NonInteractive`，避免桌面弹出可被误关的 PowerShell 窗口。锁屏或 UU 断开不会注销；真正注销后 Agent 停止，打样入口返回可重试的 412，不会从服务进程补拉隐藏 Illustrator。

Agent 空闲、读请求、等待执行锁和执行 cscript/COM 时都最多每 5 秒刷新一次心跳；Hono 与 Python 客户端统一在心跳停止超过 30 秒后拒绝接单。持久登录任务在 InteractiveToken 会话内每分钟存活触发一次，已运行实例由 `IgnoreNew` 跳过；异常退出另有每分钟 RestartOnFailure，最多 60 次。临时 L1 任务仍只有 AtLogOn，且只重试 3 次。发版在切换 Git checkout 前先把 Agent 变更责任写进恢复日志，再通过不可变安装器 `Quiesce`：先 `Disable-ScheduledTask`、再停止进程，但保留任务主体供目标版本同步或旧树回滚；维护卸载沿用同一停机顺序。此恢复不跨越注销，也不把 Adobe 拉到 Session 0。

心跳已停止但交互会话仍在（任务 `Ready`、`LastTaskResult=0xC000013A`）时，不要发版、不要清 fault fence、不要重新上传稿件。管理员确认桌面 Illustrator 无客户稿后关闭，然后：

```powershell
Start-ScheduledTask -TaskName "beian-illustrator-agent"
```

等 10 秒，确认任务变为 `Running`、心跳 PID 已更新且进程仍活，再跑只读 probe。永久修复不能只靠这一次手工启动。

Agent 只做会话桥：UTF-8 JSON 命名管道 `beian.illustrator.v1` → 现有 `cscript run_export.vbs` → 唯一 `export_structure.jsx`。结构 exporter 引用的固定 `curve_flatten.js` 与 `unattended_host.jsx` 会由 Agent 在 job 目录生成 runtime JSX 时确定性内联。COM 仍留在 VBS；PowerShell 不加载 `Illustrator.Application`。完工信号是本代 `illustrator_result.json`，不是墙钟 Kill；`saving_full_pdf` / `saving_artwork_pdf` / `writing_result` 期间禁止 Kill cscript。围栏 `illustrator-fault.json` 只在进程重启后仍有不明文档时落下。管道 ACL 只允许 LocalSystem 与注册的管理员，心跳绑定 SID、脚本哈希、版本、checkout、管道和 PID；客户端再核对实际管道服务 PID。协议只接受固定的 `probe` / `run` / `smoke`，不执行调用方传来的任意命令或脚本。PS5/cscript 的 GBK 输出由 Agent 在边界内按系统代码页解码，再编码为 UTF-8 JSON。

运行证据写到 `$env:WB_DATA_DIR\runtime\illustrator-agent.json`，日志在 `$env:WB_DATA_DIR\logs\illustrator-agent.jsonl`。从 `D:\beian` 只读探测：

```powershell
& $env:WB_PYTHON workers\packaging\illustrator\illustrator_agent.py probe --timeout 120
```

返回必须包含 `ok=true`、`session_id>0`、可见窗口、Illustrator PID 与空文档名列表。Session 0、无窗口、心跳过期或未知已开稿都不能继续打样。每次执行在 cscript/COM 前把 `$env:WB_DATA_DIR\runtime\illustrator-fault.json` 写成 `active` 作业围栏，正常完成或已证明清理完成才删除。心跳 `busy` 只表示正在干活，新打样单排队，不是离线，也不要把 busy 清成围栏。`faulted` 只在进程重启后仍有不明文档、或 Illustrator 无法再启动时落下；saving 超时不得因此锁死全厂。不能编辑心跳把它改回 idle，也不能靠重启/升版自动清 `faulted`。

管理员确认桌面无稿，并确认 Illustrator、AIRobin、cscript、wscript 及其他临时 Agent 都已退出后，在**交互式、已提升权限**的 PowerShell 运行下列显式恢复；脚本会再次核对会话、管理员身份、任务和进程，随后清围栏并重装登录任务。LocalSystem、Session 0、仍有桌面自动化进程或普通卸载都不能清除：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-illustrator-agent.ps1 -ClearFaultFence
```

不要安装 PowerShell 7、.NET SDK 或 pywin32，也不要手工在 Session 0 启动 Illustrator。

Clash 开系统代理时，备案域名和 `127.0.0.1` 必须直连。self-hosted runner 若走 `127.0.0.1:7897` 会被拒绝（`Runner connect error`），设 DIRECT 或关掉 Clash 再听 job。控制台里「所提供的模式无法找到文件」乱码，是 cmd/PowerShell 在 GBK 下找不到通配文件，不是 8787 挂了。

## CD（只在杭州本机）

合进 GitHub `main` 后，本机 **GitHub Actions self-hosted runner**（标签 `hangzhou`）只接受该次 `main` push，运行 `.github/workflows/hangzhou-release.yml`。workflow 从事件提交下载经过绑定的发布组件，并把同一个完整 `GITHUB_SHA` 交给 `release.ps1`。杭州仓库里的脚本可能落后于事件提交，因此没有“直接运行本地 `release.ps1`”的兜底入口。runner 灰掉时先恢复同一 runner，再对刚才那条可信 push run 使用 **Re-run failed jobs**；被在途作业挡住时先让作业结束，再重跑同一 run。不要创建可选 ref 的手工 workflow，也不要从分支或本地 checkout 发版。

发版按一个有 journal 的事务执行：

1. 8787 仍在线时，Actions 用 GitHub Contents API 把事件 SHA 对应的 `release.ps1`、`release-recover.ps1`、Agent 安装器和依赖指纹工具下载到 `RUNNER_TEMP`，再把同一个完整 `GITHUB_SHA` 作为 `-TargetSha` 显式传入 `D:\beian`；bootstrap 不 fetch/checkout/reset 生产 index。脚本自身带认证 fetch，只改 refs；它确认目标 commit 属于 `origin/main`、当前 HEAD 可 ff-only 到目标，并把依赖核对、VERSION、journal 与最终 HEAD 全部绑定该不可变 SHA。后续 main 即使推进到另一个提交，也不会由旧脚本顺带部署；过期或倒退目标会在停服前退出。npm 弄脏的 `package-lock.json` 直接按 HEAD blob 恢复工作树，不切分支、不写 index，并校验工作树、`main`、`WB_DATA_DIR`、Python、Windows Rollup。随后由 Node 解析真实 `package-lock.json`（包括 npm 的空键 `packages[""]`）比较当前 SHA 与目标 SHA 的规范化依赖图及 Python requirements，并实际执行 npm `--offline` 图校验、tsx、真实 `apps/web/server/src/index.ts` 的 Hono 服务入口导入、Vite、Rollup 原生模块、`pip check` 与 worker import 冷启动探针；原生命令无法启动时直接失败，不复用先前命令的 `LASTEXITCODE`。只变根版本号不算依赖变化；真实依赖变化、环境不完整、网络、401、Clash、未提交改动、本地额外 commit 或既有 Git 锁都在停服前失败。

   Windows PowerShell 5.1 下，禁止把 `git` 等原生命令的实时输出直接接到 `Select-Object -First` 后再读取 `$LASTEXITCODE`：下游提前停止管道会把成功命令误报为 `-1`。发布脚本和独立恢复脚本分别用自包含的 Git 结果合同，先完整收集输出并立即保存退出码，再做单行/状态解析；Installer、Agent 与 L1 smoke 也按同一顺序读取 checkout 身份。发布、独立恢复和 Illustrator Agent 的 6 个 `[System.IO.File]::Replace` 调用点在不生成备份时必须传 `[System.Management.Automation.Language.NullString]::Value`；普通 `$null` 会被 Windows PowerShell 5.1 绑定成空字符串路径并报“路径格式不合法”。GitHub-hosted `windows-2022` 质量 job 实跑这一 `.NET` 语义，并在不注册或控制生产任务的前提下构造、解析 Illustrator Agent 计划任务合同；服务端 L0 再静态锁定脚本内容。两者都不调用 `release.ps1` 或触达杭州生产。独立恢复文件不能依赖 checkout 中的公共模块，因为它必须在工作树切换中途仍可运行。journal 尚未落盘时的 `finally` 只清理本次事务拥有的已知文件，清理失败仅告警，绝不能覆盖首个发布异常。
2. Hono 用随机控制令牌和发布方生成的 `lease_id` 原子进入 admission drain。除不可变静态资源、health 和受 token 保护的 release control 外，动态页面和所有业务 API（包括 SPA 会话检查及会清理 session/OAuth 状态的 GET）暂时返回“系统正在安全升版”。`ReleaseCoordinator` 在 Node `fetch` 边界同步登记每个请求；Hono handler promise 和 `ServerResponse` 的 `finish/close/error` 是两个独立闩锁，二者都结束才从请求 Map 删除，既不会截断 GLB/PPT/PNG，也不会因客户端提前断开、压缩体未再消费而留下标量幽灵计数。control 只返回脱敏的请求编号、方法、路由类别、年龄和闩锁状态，不暴露 URL 参数。队列同时合并磁盘记录与内存 worker 槽；任何不可读任务/打样记录都形成 `jobs_unknown`。只有请求、作业、上传租约、作业通知 outbox、签字通知和 Agent 全部空闲，Hono 才返回稳定的 `ready/blocker_codes`。
3. 停服前把恢复脚本、Agent 安装器、旧 `apps\web\ui\dist` 的逐文件 SHA-256 快照及原子 journal 写到 `$env:WB_DATA_DIR\runtime\release\`。目录 ACL 只允许 LocalSystem 与本机 Administrators；journal 记录停机前 SHA/VERSION、发布 PID/精确进程启动 FILETIME、脚本与 UI 快照哈希。SYSTEM 任务 `beian-release-watchdog` 每分钟检查一次，省略 repetition duration，直到 journal 被成功解除前持续重试；ACL 目录内的独占 `release.lock` 保证正常发版和恢复不能并行，不依赖可被低权限进程预占的全局命名 mutex。journal 写成后，在线短租约通过 loopback `PUT` 提升为没有到期时间的 transaction fence；首次 legacy 离线切换直接写同样的 transaction fence。
4. 只通过 WinSW `Stop-Service beian-server-8787` 停服务。服务状态已停但 8787 仍监听时直接失败并恢复，不对 netstat PID 做 `taskkill`，不杀全部 `node.exe`，也不动 cloudflared。
5. `git merge --ff-only <TargetSha>` 后必须确认 `HEAD == TargetSha`，并再次证明该目标的依赖图未变；随后直接复用停服前验证过的 `node_modules` 与 Python 环境，只编新 UI、按新 checkout 同步 InteractiveToken Agent，最后重启 WinSW。目标 Node 启动前会重写同一 `lease_id` 的 transaction fence，因此新进程从第一条请求起仍处于 drain；版本、listener、品牌 PNG 与 journal commit 全部成功后，脚本才通过已验证的新 control 原子解除。`committed` 是不可逆切换点：之后不再回旧树；若 Actions 恰好在放行前后中断，独立 recovery 会重启并核对同一目标版本、幂等解除 fence，避免“新版本接单后又回滚”。
6. merge、构建、Agent 同步、重启或冒烟失败时，独立恢复脚本按 journal 恢复旧 UI 快照、回到精确的停机前 SHA/VERSION，再对实际将启动的旧树重跑同一组离线冷启动探针，并恢复旧 checkout 对应的 Agent 任务；最终再次核对 SHA、UI 指纹和 Agent 身份。merge 前 journal 会在确认精确锁白名单全部不存在后写入不可变 owner、operation、ref、基线、策略哈希和起始 FILETIME；恢复只处理 `index.lock`、HEAD/main、ORIG_HEAD 及对应 reflog 的七个精确候选。恢复进程取得独占锁后必须重新读取并验证 journal，锁前快照不能提供路径或身份授权。发布进程或任一 Git 进程仍活、字段被覆盖、锁更早、策略不符或不能独占时都保留现场，`recovery_failed` 重试也不能扩大删除授权；首个 `failed_from_stage` 不会被后续重试覆盖。恢复路径不执行 npm/Python 在线安装，也不重建旧 UI。回滚目标为 `0.20+` 时，旧 Node 启动前也先写同一 `lease_id` 的 transaction fence，核对 health/version/control/listener 后才原子开放；回滚到不认识 admission 和持久 Illustrator fault fence 的 legacy 版本时，恢复会先保持 8787 停止，并要求 fault 文件以及 Illustrator/AIRobin/cscript/wscript 全部不存在，否则保留 journal 等待人工清场，不会启动旧服务。Actions 被取消、PowerShell 被杀、发版超过两分钟或机器短时掉电时，watchdog 继续做同一恢复；不会因时钟到期把未知版本或尚未验证的回滚代际开放接单。

恢复失败会保留 `$env:WB_DATA_DIR\runtime\release\release-journal.json` 和 `beian-release-watchdog`，`last_error` 是当前阻塞；不要删 journal、不要手工 `sc start` 掩盖现场。下一次发版会先要求这笔旧事务恢复完成。`release.ps1` 与独立恢复脚本都带 UTF-8 BOM，供中文 Windows PowerShell 5.1 正确解析。

RF-11：`scripts/windows/blender-contract-smoke.ps1` 在 Illustrator Session 1 身份冒烟之后调用 `workers/packaging/tools/blender_contract_smoke.py`。输出只写 `RUNNER_TEMP`，复用 quality eval 与 `render_generation.compare_glb_artifact_contract` / hash 门，PowerShell 不复制 GLB 或 generation 检查。`0.21.46.0` hangzhou-release `34191398011` 真跑 `WINDOWS_BLENDER_CONTRACT_SMOKE ok`（约 62s）；`release.ps1` 传入 `-TimeoutMs 90000`。wrapper 用 Job Object：`PROC_THREAD_ATTRIBUTE_JOB_LIST` + `CREATE_SUSPENDED`，`KILL_ON_JOB_CLOSE` / `TerminateJobObject` 杀树。发版路径未解析到 `WB_BLENDER` / `BLENDER_EXECUTABLE` / `settings.json` 中的可执行文件时跳过、不回滚。跳过不算质量门杭州实跑完成，也不否定发版 L1（health / Illustrator Session 1）。独立脚本缺 `RUNNER_TEMP` / `WB_PYTHON`、超时、hash/GLB/generation 合同失败会非零退出；此时仍在 `Write-StartupDrainFence` 之后、`Commit-ReleaseRecovery` / `Open-TargetReleaseDrain` 之前，走 `Invoke-ArmedRecovery "升版失败"`。词义见 [TODOS.md](../../TODOS.md) 状态口径。

当前脚本会在切换 Git checkout 前先通过不可变安装器 Quiesce 旧 Agent 登录任务；新 UI 构建后，再按目标 checkout 重新注册/启动，避免旧进程或每分钟存活触发器跨越版本身份切换。旧 PID 未退出、Agent 正 busy 或 faulted 都拒绝切换，回滚会在 reset 前再次 Quiesce，并利用保留的 principal 按旧 checkout 恢复任务。它只同步 InteractiveToken 任务，不会把 Illustrator 注册成 Session 0 服务。目标 8787 在 transaction fence 后启动并通过 health/version 身份核对后，发版脚本还会调用生产 Agent 完成管道 → VBS → 唯一 JSX 的 Session 1 冒烟；Session、可见窗口、空文档、脚本哈希、发布版本、checkout 或管道服务 PID 任一不符都会回滚，业务仍不开放。PR 和可选择 ref 的手工工作流都不能触达杭州生产 runner。

从 `0.20.0.0` 起，停服务前还会读取 `$env:WB_DATA_DIR\runtime\release-control.json`，用其中不打印的随机令牌和发布方生成的 `lease_id` 让 Hono 原子进入 admission drain。每个 Node 进程同时生成随机 `instance_id`；PowerShell 必须用 control token 向 loopback identity 接口在线挑战，并同时匹配协议、实例、版本、PID 和真实 8787 listener，不能只凭容易复用的 PID 或宽松时间窗认领进程。除不可变静态资源、health 和受令牌保护的控制接口外，动态页面和全部业务 API 都会暂时返回“系统正在安全升版”；这样新增路由默认纳入，避免 SPA、session/OAuth 清理等隐藏写入漏过。Hono 聚合在途请求、队列、上传租约、作业通知 outbox、签字通知与 Agent 状态，只向 PowerShell 返回稳定的 `ready/blocker_codes`，发布脚本不再理解任务目录、状态或心跳结构。journal 落盘前使用 2 分钟可续租 lease，发版在这个准备阶段中断才会自动恢复接单；journal 与 watchdog 就绪后立即提升为不自动过期的 transaction fence，此后只能由匹配 `lease_id` 的提交或恢复路径解除。升版失败时脚本强制重启 WinSW，并要求 `/api/health.version` 精确等于回滚树 `VERSION`；`0.20.0.0` 及以后还必须完成上述在线实例核对，旧版本回滚才允许没有 control 文件。control 文件只有在记录的 PID 已退出时才会作为陈旧文件清理。

依赖升级必须先作为独立运维变更把新旧运行环境都预置并可离线验证，再调整本合同；当前脚本不会在停服后临时访问 npm/PyPI。这样依赖变更会明确保持旧服务，而不是把生产可用性赌在外网。

`0.19.x → 0.20.x` 首次切换时，旧 Node 尚不会生成 release control，不能在继续对外接单时安全自举。这里按受控代际范围而不是绑死 `0.20.0.0`，因此首个 0.20 发布若在停服前失败，后续仅含发布修复的 0.20.x 仍可完成同一次迁移；目标达到 0.21 或来源已经是 0.20 时都不能复用此授权。合并后的第一条可信 `main` push run 会 fail-closed 并保持旧服务；不要创建手工 workflow，也不要从分支重跑。杭州管理员进入一次经批准的维护窗并停止旧 WinSW 服务，然后在 GitHub Actions 打开**刚才那一条失败的 push run**，选择 **Re-run failed jobs**。重跑保留同一个不可变 `GITHUB_SHA`，且只有 `event=push`、`ref=refs/heads/main`、`run_attempt>1` 时 workflow 才传一次性授权。脚本仍会连续两次只读核对持久任务状态、最近两分钟分片会话、30 分钟内 multipart 临时目录、仓库所属进程以及 Illustrator/Blender/cscript 桌面自动化；任一活动项或不可读记录都会拒绝切换，并且只接受精确的 0.19→0.20 代际。后续版本即使重跑也不能绕过 control/version 门。从 `0.20.0.0` 起 control 文件缺失、版本/实例/PID 不符或 drain 无法解除都会拒绝发版，不再退回非原子空闲检查。令牌和 lease 只在杭州数据目录及 loopback 请求头内使用，不写日志、仓库或 Actions 输出。

`-Restart` 现在多余，行为一样。Mac 禁止 `cloudflared tunnel run beian`。

不要用 GitHub-hosted runner（`ubuntu-latest` / `windows-latest`）升这台机。不要 SSH。self-hosted 只打标签 `hangzhou`。

## 升到本版之前

升级只走可信 `main` push 的 `hangzhou-release` 事务，不手工 pull、重建或重启 8787。发版被在途作业挡住时等待作业结束；在获得重跑授权后，仅重跑同一可信 push run。状态查询不授权生产操作。

## 隔离环境恢复验收（须单独授权）

以下故障注入只用于已授权的隔离环境，不在生产真实作业中执行。常规上线验证由发布事务及只读 health 完成。

1. 合成对照跑着时重启 Node：孤儿 Python 被杀掉，作业重新入队或变成「对照中断」。
2. 已有任务 JSON 可以被替换（Windows 上目标文件已存在时 replace 成功）。
3. 超时之后，任务管理器里没有第二条 python / blender。
4. 打开首页，侧栏狐狸标和导航图标应显示。`http://127.0.0.1:8787/brand/logo-mark.png` 应是 PNG，不是 404（v0.12.0.1 修了 Windows 把 `/brand` 目录多拼一层；图在 `apps/web/ui/public/brand`，不要另拷一份）。
5. 本机 `GET /api/health` 或登录后的 `GET /api/status` 应带 `jobs.illustrator.agent.ready=true`，且 probe 返回 Session 1、可见窗口和空文档列表。可信 `main` release transaction 内的 L1 只证明管道 → VBS → JSX 的身份链；真实稿结构、六面贴图和 Blender 仍需单独 L2。
