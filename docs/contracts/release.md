# 杭州发布合同

本文件保存原 AGENTS 的对应工程合同，仅在涉及本主题时读取。产品行为不构成执行作业、发送消息或操作生产的授权。日期与验收状态是记录时快照，当前结论须绑定本次证据。路径除链接外均相对仓库根。

本节只在发布实现、发布诊断或已授权的合并/部署任务中适用。查询状态不授权恢复 runner、重跑工作流或操作生产；已有明确授权则按下列可信链执行，不重复询问。合 `main` 会自动触发杭州发布，执行前必须确认已有授权涵盖这一效果。完成标准是对应 merge SHA 的可信 `main` push run 变绿、杭州/Tunnel 来源和 VERSION 相符、公网 health 验证通过；只报告这些已验证事实（发版 L1）。质量门杭州实跑、L2 和业务开放另行列出，见 [TODOS.md](../../TODOS.md)。不得将 Skill 的自动删分支、回滚或平台部署默认项作为额外授权。

- Platform: 杭州 Windows（UU 远程「人事-台式」）+ Cloudflare Named Tunnel。不是 Fly / Vercel。生产发布的 GitHub Actions 只跑 **self-hosted `hangzhou`**（机器名 `hangzhou-windows`）；GitHub-hosted runner 只跑 `.github/workflows/quality.yml` 的质量合同，禁止升生产。
- Production URL: https://www.jianghua.site
- Deploy workflow: `.github/workflows/hangzhou-release.yml`（仅 `push` `main`；从事件 SHA 下载发布组件到 `RUNNER_TEMP`，再以不可变 `TargetSha` 操作 `D:\beian`；PR 与可选择 ref 的 `workflow_dispatch` 禁止触达生产 runner）。
- Deploy status command: 无平台 CLI。看 [hangzhou-release](https://github.com/weiweity/beian/actions/workflows/hangzhou-release.yml) 是否绿。杭州环回才是杭州进程：`curl -sS http://127.0.0.1:8787/api/health`。公网 health 仅在 Named Tunnel 跑在杭州时有效。
- Merge method: squash
- Project type: web app（Hono `:8787`）
- Post-deploy health check: Actions 绿后再等约 20 秒，`https://www.jianghua.site/api/health` 的 `version` 等于刚合进去的 `VERSION`，且带 `jobs.illustrator`。隧道必须在杭州；Mac 上的 cloudflared 不当生产。`/api/health` 的 `version` 目前写死在 `apps/web/server/src/index.ts`，不能单独当发版证据；以杭州工作树 `VERSION` 文件和 merge SHA 为准。

### 机器分工

- Mac：开发。入口 `http://127.0.0.1:8787`。跑 `/ship`（出 PR）和 `/land-and-deploy`（squash 合 `main`）。不要 SSH。不要把 `www.jianghua.site` 当本机开发入口。不要只开 Vite `:5173` 就点开始打样/对照——`:8787` 没开时 `/api` 会变成 HTML，单不会入队。
- 杭州 Windows「人事-台式」：生产。入口 `https://www.jianghua.site` → 本机 `:8787` → Cloudflare Named Tunnel（只在杭州跑）。仓库 `D:\beian`，数据 `C:\supply\data`（`WB_PUBLIC=1`，`WB_DEV_DISPLAY_LOGIN=false`）。self-hosted runner 机器名 `hangzhou-windows`、标签 `hangzhou`。密钥只在杭州开工板 / `C:\supply\data`，不进仓库；Mac 不要要、不要写密钥。
- 远程：UU 远程用来看着人事-台式。Mac 对话不能 SSH 进杭州，也不能把 UU 当成自动部署后端。杭州机开机即可；`:8787`、cloudflared、Actions runner 是 Windows 服务（无人值守）。Illustrator/Blender/对照仍要交互桌面，不要做成 Session 0 服务。

### Custom deploy hooks

- Pre-merge: `/ship` 已跑 `npm test` 与 ui build。Mac `/land-and-deploy` 只合 GitHub。
- Deploy trigger: **合进 `main` 后，只由杭州 self-hosted runner 处理该次可信 `main` push**。workflow 从事件提交下载绑定过的发布组件，并把同一个完整 `GITHUB_SHA` 作为不可变 `TargetSha` 交给 `release.ps1`；杭州 checkout 里的本地脚本不是兜底入口。runner 灰掉就先恢复同一 runner；对照/打样/Illustrator 在途就等作业结束，然后仅对刚才那条 push run 使用 **Re-run failed jobs**。`0.19.x → 0.20.x` 首次切换也是在批准维护窗停止旧 WinSW 后重跑同一失败 run，不创建 `workflow_dispatch`，不从分支、本地 checkout 或另一 SHA 发版；来源已是 `0.20` 或目标达到 `0.21` 时不得复用该授权。

  发布脚本在不停服时完成不可变 SHA、依赖图、离线运行时和 admission readiness 核对；随后用 ACL journal、SYSTEM watchdog、WinSW 停服、ff-only、UI 构建、InteractiveToken Agent 同步、transaction fence 和 Session 1 发版 L1 身份冒烟组成一个恢复事务。Illustrator 身份冒烟之后，`release.ps1` 调用 RF-11 `blender-contract-smoke.ps1`（只写 `RUNNER_TEMP`，复用 quality eval 与 generation GLB/hash 门）。`0.21.45.0` 杭州真跑约 63s。`0.21.46.0` 把发版 `TimeoutMs` 冻结为 90000。wrapper 用 Job Object 杀树（`PROC_THREAD_ATTRIBUTE_JOB_LIST` + `CREATE_SUSPENDED`，`KILL_ON_JOB_CLOSE`）。未解析到 Blender 可执行文件时跳过、不回滚；跳过不算质量门杭州实跑完成。超时或合同失败仍走既有 `Invoke-ArmedRecovery "升版失败"`。这不是真实感或 L2 证据。Job Object 须下次可信 main 发版证明。请求生命周期必须由 Node `fetch` 最外层的 `ReleaseCoordinator` 按请求登记，并同时等待 handler 与 `ServerResponse finish/close/error`；不得退回 Hono 中间件标量计数、`Response.body` 包装器、超时清零或 PID/连接数猜测。恢复必须在独占锁内重读 journal；回滚到不理解 fault fence 的 legacy 版本前会保持 8787 停止，并要求 Illustrator fault 文件及 Illustrator/AIRobin/cscript/wscript 全部不存在。脚本不杀全部 `node.exe`，不做 PID 型 listener 清理，不动 cloudflared，不在停服后在线安装 npm/Python 依赖。密钥只在杭州数据目录和 loopback 控制头内，不进仓库或日志。细节见 `scripts/windows/README.md`。

- 杭州 Grok 禁止：在生产机 `/ship` 新功能、改产品代码当开发机用、把生产隧道指到 Mac、对照跑着时 pull/重启、`git reset --hard`。发版后若只脏 `package-lock.json`，先只读检查差异和来源；仅在确认是可丢弃的发版副产物且已获丢弃该改动的明确授权后，杭州才执行 `git checkout -- package-lock.json`，不得以“只脏此文件”推定可覆盖。
- Mac Grok 禁止：
  - `cloudflared tunnel run beian`（隧道只能在杭州，抢了就 1033/串台）
  - 合完 PR 立刻说「已上线」
  - 给杭州贴 pull / rebuild / 重启 8787 或本地执行 `release.ps1` 的升级提示词；runner 灰掉只恢复 runner，在途作业结束后只重跑同一可信 push run
  - 把 `www.jianghua.site` 当本机开发入口
  - 改 Cloudflare DNS、飞书控制台、买云、映射端口
  - 指挥杭州改产品代码或当开发机
  - 向杭州要密钥
- 杭州运维（Mac 不改、不贴升级步骤）：Clash 系统代理时备案域名必须直连，否则进度条会绕日本节点；原记录把 Error 1033 归因为 Named Tunnel 和 `:8787` 都不在；该归因不能仅凭错误码确认，应分别核查 Tunnel 与杭州 listener。恢复仍由杭州在对应授权下处理，Mac 不动 DNS。站点拆包是以后的产品活。
- `release.ps1` 起停 `:8787` 只走 WinSW 服务 `beian-server-8787`（`Restart-Service`），不要 `schtasks /Create ONLOGON`。cloudflared 是官方 Windows 服务（token），发版不动隧道。
- Deploy status: [hangzhou-release](https://github.com/weiweity/beian/actions/workflows/hangzhou-release.yml) 绿 → 约 20 秒 → 公网 health 的 version 等于 VERSION。公网再用 `/canary https://www.jianghua.site` 前，先确认 Mac 没有 cloudflared。
- Health check: `https://www.jianghua.site/api/health` 必须打到杭州。细节见 `scripts/windows/README.md`。
