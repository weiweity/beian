# RF-03C2 异步桥接验收台账

> 归档说明（2026-09-06，第 08 批）：下文保留原实施/返修时的授权、测试和未接线状态，不能用历史次数证明本次发布验收。当前批次承接已经拆分的存储、Python 候选与进程桥接，仅交付 jobs 内部队列、代际提交及适配接口；真实适配器仍未默认注册，runtime quality 仍为 unwired，Windows 新桥托管、HTTP/UI 接线、真实 Blender/L2 与业务开放均不在本次完成范围。提交/发布状态以本批 PR 和匹配发布证据为准。

## 2026-09-06 第 08 批独立组合验证

基于第 07 批合并后的 main `b997601` 组合验证，保留前序贴图独立副本与有界管道等待修复。服务端 **650 passed、1 skipped**，界面 **339 passed**，全量 Python **883 passed、5 skipped**（190.73 秒）；类型/UI 构建与质量检查通过，质量基线仍为 59 项，质量工具合同 **47 passed**。本地 Node 25.8.2；不是 Windows 或真实 Blender 验收。

四条新增 Python 参数化测试实际调用 Node bridge/adapter/jobs 和 Python RF-02，只有 Blender subprocess 为替身。真实 adapter 的候选结果仍因 runtime quality unwired 拒绝进入新代 current。

独立对抗审查复现旧删除入口可删除 `done` 主单下仍在运行的新代。先取得 queued/running/failed-with-PID/succeeded-with-PID 四项 RED，补删除 guard 后通过；新增测试还覆盖损坏 PID=0 的拒删、源文件/job.json 不变以及无 PID 终态仍可删。未操作真实单。

首轮新工作树测试早于 UI 构建，六项 SPA 测试返回 503；完成构建后全量复跑通过，未改 SPA 业务代码。静态工具无法识别仅从 Python 动态加载的 adapter，补直接构造入口测试并移除三个未使用类型导出后通过，未放宽门禁。日志为 `/tmp/beian-pr08-tests-final.log`、`/tmp/beian-pr08-types-final.log`、`/tmp/beian-pr08-quality-final.log` 和 `/tmp/beian-pr08-quality-tests.log`。

本批仍无生产默认注册、新 HTTP/UI、Windows 新桥 containment、完整资源预算、runtime quality 实现、真实 Blender/L2 或业务开放。发布链另按本批 PR 与匹配 SHA 核验，不能用本节的 L0 数字替代。

## 历史：2026-09-06 拆分复验：继承输出管道等待边界

第 07 批修复已同步本组合树：父进程 exit 后最多等待 `terminationGraceMs` 排空管道，届时先返回失败并关闭本次流；不强杀失去身份的组，组未确认退出仍不调用 onClose，jobs 保留共享槽。受控后代继承 stdout/stderr 的回归先红后绿，验证结算早于后代自行退出且不释放存活组。服务端 598 passed、1 skipped；Python generation 38 passed（含四条真实 Node→Python 入口，Blender 为替身）；类型/UI 构建通过。日志为 `/tmp/beian-pr08-repair-{server,python,types}.log`。

下方 C2.3 的“继承管道可使 close 延迟”仍是 Node 事件事实，但不再使调用者无限等 close；持续存活/未知组仍保留占用。Windows 托管、Linux 实机、真实 Blender、L1/L2、runtime quality 与生产开放未验证或未完成。

## C2.3 Codex 进程组退出屏障（2026-09-05）

**当前结论：C2.3 本地安全收口通过（DONE_WITH_CONCERNS）。已修复 POSIX 父进程先退出时误释放共享槽的缺口；不是跨平台进程树托管完成，不是生产接线或画质验收。**

沿用 `codex/3d-rfe02-lighting-evidence` 独立工作树；本轮仍由 Codex 实施，无 Grok/子 agent，无提交、推送、PR、合并、部署或真实 Blender/Illustrator 操作。

### 根因、复现与修复

按 `/investigate` 先复现再修。原桥接把 `ChildProcess.close` 当作完成屏障并调用 `onClose` 清 PID；但实际 Python `subprocess.run(capture_output=True)` 启动的 Blender 不持有 Node 的输出管道，Python 先退出时 Node 可以 close，而 Blender 仍在运行。原重启恢复也把父 PID `missing/other` 直接当作退出证明。

新增三项受控进程回归：后代继承独立进程组、忽略 SIGTERM、不占父进程 stdout/stderr；父进程分别正常返回、非零退出、被取消退出。修复前 **0/3 通过**（错误成功，或只报 worker_exit/cancelled 并释放）；修复后 **3/3 通过**，均拒绝为 `process_group_unconfirmed`，不发释放回调，且当场确认父 PID 消失、后代仍存活。受控后代 1 秒后自行退出；每项测试最终确认整个组消失，没有按 PID 杀真实进程。

| 合同 | 当前行为 |
|---|---|
| 支持平台 | 当前 bridge 仅启用已实现进程组方案的 macOS/Linux。Windows 在 spawn 前明确 `process_containment_unavailable`，不启动 Python、不发送请求；不是说 Windows 无法实现，而是本仓尚无相应托管实现。旧产品 pipeline 路径不变。 |
| 退出证据 | 新模块只用 `kill(-pgid, 0)` 只读探测本次独立组，只有 `ESRCH` 为 missing；present 不代表所有权，权限错误/其它错误/非法 ID/不支持平台均 unknown。 |
| 运行中释放 | 父 close 后组 missing 才调用匹配身份的 `onClose`。组存在/未知就返回失败，但 jobs 保留 PID/token 和共享槽；成功 JSON、取消、超时均不能绕过此屏障。未能启动的进程不存在需要释放的所有权。 |
| 信号边界 | 父仍存活时沿用本次独立组 TERM→KILL；父 exit 后停止延迟强杀，不凭旧组号自动追杀孤儿。专用 group signal 不使用旧 `killTree` 的单 PID fallback，也不使用 Windows taskkill 作为证明。 |
| 重启恢复 | 新协议父 PID missing/other 后还需组 missing 才清 PID；present/unknown/探测异常继续围栏。只有当前命令精确匹配的 owned 父进程才允许尝试组终止；终止返回后仍须确认父和组退出。父 gone 后不再按旧所有权重复 kill。旧协议恢复保持原语义。 |
| 用户数据 | 不改旧 current、成片、F 参数、模板、默认 profile、生产适配器注册或 HTTP/UI。未确认后代退出时，宁可保留占用，也不启动另一单竞争 Blender。 |

### 验证记录

- 专项桥接/进程组/jobs：**94 passed、1 skipped**，退出 0；包括上述真实受控进程、6 组 missing/other × present/unknown/异常的重启围栏、owned 父退出但组存活，以及 ESRCH/权限错误/非法标识/platform 策略。
- 服务端全量：**597 passed、1 skipped**，退出 0，约 7.0 秒。比 C2.2 新增 17 项通过的回归及 1 项平台专用测试。证据 `/tmp/rf03c23-server.log`。
- 相关 packaging pytest（generation、pipeline_v2、render_contract）：**200 passed**，退出 0，117.41 秒；包含真实 Node → adapter/bridge → Python/RF-02 的四条跨语言入口，仅 Blender 调用为受控替身。证据 `/tmp/rf03c23-packaging.log`。
- `npm run typecheck -w beian-server`、`git diff --check`：均退出 0。未运行 UI/build、全仓 Python 或 `/ship` 质量门。
- Windows 专用拒绝启动测试在 Mac 跳过，跨语言 Python 测试也显式只在已支持 POSIX 平台运行。Mac 绿灯不表示 Windows 验证通过。

Python 有 5 项 SWIG 既有弃用警告；Node 专项有测试临时目录为每个 fixture 登记 exit 清理造成的 MaxListeners 警告，未改无关测试清理模块，也不把它说成产品进程泄漏。

相对本轮开始 270 个范围内文件的 SHA-256 快照：修改 6 个既有文件（jobs、bridge、两份 TS 测试、Python 跨语言测试的平台标注、本台账），新增 `renderGenerationProcess.ts` 及测试；无删除。F/UI、renderer、pipeline、render_contract、profiles/质量基线和其余既有内容保持原字节；未提交/推送。

### 运行时质量门核对与下一步

现有 Python 输出仍固定 `quality.status=unwired` / `runtime_gate=pending`；真实 adapter 仍返回 `runtimeQuality=unwired`；jobs 在新代 seal/current 前拒绝。存储层 `QualityVerifyResult` 只有 unwired/failed 语义，测试的 `verifier_status=accepted` 是结构证据合同，不是图像质量通过。正式视觉 approved baseline 仍是独立批准事项，本轮未写。

下一步顺序：

1. 完成 Windows 的可验证进程托管与重启恢复合同，再在目标平台验证。需要受控启动前纳管、所有后代退出证据和异常恢复，不能只查父 PID 或依赖 taskkill 返回码。不得因此开放杭州真实任务。
2. 定义并实现独立 runtime hard-gate 证据：绑定本次计划/合同、执行 nonce、候选和输出字节，把几何/六面/可解码/必需产物等硬合同与视觉评分、人工验收分开。不得给现有 unwired 状态改名冒充通过，也不得凭 stdout 自报 pass 切 current。
3. 补运行时资源预算与实际 Blender/Windows 验证后，才评估默认注册；RF-04、默认 F、L2/UAT 和发布不在本轮。

**剩余边界：** 进程组不是操作系统级全树 containment，主动 `setsid()`/脱离组的后代不受本屏障覆盖；当前受控 Python→Blender 路径未这样启动子进程。没有 Windows Job Object、持久托管句柄或跨重启的可安全追杀孤儿能力。孤儿持续存在、权限不足或未知身份时会保留围栏，不承诺自动清理/恢复；不能手工删 PID 假装恢复。继承父输出管道的长期后代仍可能使 close 延迟，槽位继续保留。未验证断电、Linux 实机、Windows L1 或真实稿 L2，也不宣称全部 I/O/资源预算完成。

## 历史检查点：C2.2 Codex 接线记录（2026-09-05）

**当时结论：C2.2 内部接线与本地合同验收通过；不是 C2 生产就绪或画质验收完成。进程释放语义由上方 C2.3 修正。**

用户继续授权下一步，由 Codex 自行实现，无 Grok/子 agent。沿用同一分支与工作树，保留既有 F/UI/renderer/profile 内容，未提交/推送/PR/合并/部署，未调用真实 Blender/Illustrator、未操作真实任务。

### 选择与范围

没有把同步 `verifyRenderPlan` 强转成 Promise，也没有在持有同步提交锁时等待 Python。新增异步 prepare 接口，已完成单的入队先做权限、幂等、current/source、busy、适配器可用性和计划存在性检查，持久化 queued 后立即返回；出队占共享 Blender 槽后才验证。验证不通过是本次 mutation failed，旧单继续 done、旧图不变。

同步受控验证 hook 只为 B 的既有合同兼容保留。实际异步工厂 `createRenderGenerationPreparer()` 调 C2.1 bridge → C1 Python → RF-02，并返回绑定本次已验证字节/六面/模式/调灯的执行闭包。它没有被默认注册到生产启动；质量适配器缺失仍 unavailable。

本轮范围：jobs.ts、mockup.ts 的私有执行字段、workers.ts 的生成进程身份识别、bridge 及其协议、Python CLI 的执行标签解析、相关测试与本台账；新增 `renderGenerationAdapter.ts`。不改 index.ts/HTTP/UI、质量基线、renderer、registry、VERSION、依赖或旧同步审稿 worker。

### 已实现合同

| 项目 | 处理 |
|---|---|
| 异步等待竞态 | 入队绑定源计划字节 SHA；排队期间计划改变在 prepare 前拒绝。验证前冻结请求/源输出；验证返回后、g0 导入前重查 mutation/current/source/计划字节/六面；执行后、seal 后最终 job 锁内再查。等待期间换计划、产品图、贴图或请求均不得进入执行/切图。 |
| 入队读取预算 | `mockupRenderPlanBytes` 在读取前检查普通文件及 8 MiB 上限，并按初始长度加 1 字节有界读取，读取期间增长/长度或 mtime 变化拒绝；不能先无界 readFileSync 再检查大小。 |
| 候选目录唯一创建者 | jobs 统一指向 `.render-generations/.candidate-<mutation>`。真实 adapter 不预建候选，由 C1 独占创建；存储层负责父目录。旧受控 executor 仍由 jobs 独占创建，兼容 B 测试，不让 Python 接收既存目录。 |
| 完整输入绑定 | Node 不复制 RF-02 解析器；由实际 CLI 验证源字节与六面，adapter 把已验证六面路径/hash/长度返回给 jobs，最终提交前再核对；实际执行闭包只允许已验证的单号/mutation/模式/字节/调灯。 |
| 每次 spawn 身份 | 命令显式 `--execution-id <job>:<mutation>:<random32hex>`；验证进程与渲染进程使用不同 token。token 只是所有权标识，不是认证、权限或渲染合同身份。Python 严格解析标签形状，不用它授权路径。 |
| jobs 单写者 | `onSpawn` 在 stdin 前持久化 PID + execution id + protocol；`onClose` 仅清理完全匹配本次身份的 PID。错 token 的迟到 close 不得清掉其它执行。私有字段不进公开详情/列表。 |
| 不明进程围栏 | 即使 mutation failed，未确认的 PID 仍占共享槽，同单新请求/激活不能覆盖它。恢复仍 inspect → 仅 owned 才 kill → 再 inspect；missing/other 才清 PID 后放槽。 |
| 身份损坏 | 新协议却缺 token、错误 mutation 或标签非法时为 unknown，保留围栏，不回退旧 pipeline.py 检查并误当 other。旧协议数据继续原恢复语义。 |
| 质量停止点 | 实际 adapter 固定返回 runtimeQuality=unwired，jobs 在新代 seal 之前明确拒绝。即使受控 quality hook 存在，也不能靠实际 adapter 的出图成功切 current。允许此前 g0 原图导入与私有候选留存，不生成 g1 ready；不递归清理。 |

### 本轮验证

| 最终验证 | 结果 | 证据 |
|---|---|---|
| 服务端全量 | **580 passed**，退出 0（原 565 + 本轮 14 jobs、1 worker 身份回归） | `/tmp/rf03c22-server-final.log` |
| 相关 packaging pytest | **200 passed**，退出 0，119.98 s | `/tmp/rf03c22-packaging.log` |
| 最后跨语言复跑 | **4 passed、34 deselected**，退出 0；验证/bridge/adapter/jobs 四条入口，属于上述 pytest 子集 | `/tmp/rf03c22-jobs-integration-final.log` |
| 服务端类型、差异空白检查 | 均退出 0 | `npm run typecheck -w beian-server`、`git diff --check` |

Python 有 5 项既有 SWIG DeprecationWarning，无失败。未执行全仓 Python、UI/build、发布 quality 门禁、Windows 或真实 Blender。没有把局部回归当 `/ship` 完成。

相对本轮开始的 269 文件 SHA-256 快照，仅 9 个既有文件变化（本范围实现/测试/台账），新增 1 个 adapter；无删除。UI、renderer、pipeline.py、RF-02 render_contract.py、profile registry、质量基线及既有 F 证据保持原字节。

- 专项 jobs / workers / bridge：81 passed；包含异步占槽/幂等/旧图可读、四类等待篡改、私有进程身份、失败仍占槽/安全恢复、损坏 token 围栏、锁内六面复核和 unwired 质量拒绝。
- 跨语言真实链路：实际 jobs → 实际 adapter/bridge → 实际 CLI/RF-02/私有 snapshot/nonce/card，仅 Blender subprocess 为受控替身；最终准确停在“质量门未接线”，旧 current 不切、原文件不变、worker PID 清除。其余独立验证、缺 Blender 负例和 adapter 生命周期路径也通过。
- 源码/测试没有依靠生产 DATA_DIR、网络、Blender 或 Illustrator。测试目录内的 g0/候选是合成文件，不是实际订单代际。

### 仍然不能宣称完成

- **C2 生产就绪未完成：** 没有默认生产 adapter 注册、新 HTTP/UI 或真实 runtime quality gate；旧 quality 类型仅支持 unwired/failed，不能临时造 pass。
- **完整进程树可靠性未证明：** 当前记录并验证的是 Python bridge 父进程。正常 close/取消及受控恢复不证明父进程意外先死后的孤儿 Blender 已退出；不能用父 PID missing/other 推导全部后代已退出。Windows 进程树、重启、断电、持久进程身份损坏的人工恢复仍需独立处理后才能开放生产。
- **运行时预算尚需闭环：** 沿用 B 存储/提交中的同步文件哈希和文件复制，不宣称整条路径所有 I/O 都不阻塞事件循环。新增的是 Python 等待异步化，不是大文件吞吐或全程内存/磁盘准入验收。
- **无真实画质/L1/L2/UAT 证据**，未切默认 F、未运行 Blender smoke、未进入 RF-04 或发布。

下一阶段优先补完整进程树退出证据与 runtime hard gate，再讨论注册实际运行时适配器；不直接开放产品重渲。

## 历史检查点：C2.1 本地合同验收通过

Codex 完成异步桥和回归，未调用 Grok。关闭的是 **C2.1**，不是 C2 全部、真实渲染或生产接线。当前下一步为下文 C2.2 jobs 适配及恢复身份接线，质量门仍需单独闭环。

## 授权与本轮范围（2026-09-05）

以下路径、分支和授权仅描述当时的施工现场，不要求恢复旧工作树，也不构成当前执行授权。后续独立交付与保留边界见 [RF-03 收口记录](packaging-quality-rf03-runtime-closeout.md)。

用户要求下一步由 Codex 实施，不再调用 Grok。沿用 `/Users/hutou/Desktop/beian-3d-rfe02-lighting-evidence` 的 `codex/3d-rfe02-lighting-evidence`，保留全部已有未提交改动，不创建重复工作树，不提交/推送/PR/合并/部署。

本轮是 **C2.1：异步命令桥与进程内验证凭证**，不是 C2 全部完成。C1 的 Python 底座已验收；B 的 `verifyRenderPlan` 仍为同步钩子、候选目录仍由 jobs 预建、质量验证仍未接线。不能把异步函数强转成同步验证器，也不能让 Python 复用一个已经存在的候选目录。故此切片暂不修改或注册 jobs 生产适配器。

## 设计取舍

比较：

1. 同步子进程验证或 TS 复制 RF-02，再套用已有 B 钩子：会阻塞 Hono，或产生第二套合同；拒绝。
2. 单个异步深模块持有验证请求、进程生命周期和一次性凭证：Python 保持合同事实源；Node 只做输入/输出字节、路径、协议及新鲜度复核；采用。

命令使用有界 stdin，不在源/ready 目录写请求 JSON，也不再加 HTTP 服务。包装脚本路径及 Python/数据根来自服务端构造器，不来自客户端或执行结果。实现不用 `spawnSync` / `execFileSync`，不扫描真实数据根。

本轮文件：新增 `apps/web/server/src/renderGenerationBridge.ts`、对应 `.test.ts`、本台账；修改 `workers/packaging/render_generation.py` 的 CLI 请求读取、以及 `apps/web/backend/tests/test_packaging_render_generation.py`。其余既有文件不在范围内。

## 当前合同

| 项目 | 实现与边界 |
|---|---|
| 真实验证 | `verify()` 异步调用 C1 CLI → RF-02；Node 不重新解释 spec/profile/结构。回传源字节 SHA、六面 SHA、计划身份、profile、调灯必须闭合。 |
| 验证凭证 | 冻结对象 + bridge 实例私有 WeakMap；复制、序列化、跨实例或使用第二次均失败。一次渲染尝试即消费，失败后必须重验。它不是持久化凭证，也不授权 quality pass。 |
| 新鲜度 | 验证前后、执行前后异步重读源计划与六面资产；拒绝路径越界、内部 symlink、hardlink 和身份变化。大文件分块哈希，计划读取不超过 8 MiB，单资产/产物不超过 512 MiB。 |
| 候选所有权 | 只允许本单 `.render-generations/.candidate-<id>`；父目录由将来的存储层管理，bridge 不预建候选。既存目录在调用前拒绝，Python 保留跨单 ready 祖先检查与独占创建。 |
| 请求预算 | 文件与 stdin 两入口均最多 64 KiB，超限在 JSON 解析/源读取前拒绝。 |
| 子进程 | `spawn` + pipe；默认最长 1260 秒，终止宽限最多 5 秒，stdout/stderr 各 1 MiB、未完成 stderr 行 64 KiB。超时/取消/溢出触发本次进程组终止；不产生按时间伪造的完成。 |
| 完成屏障 | 成功及已启动进程的失败只在 `close` 后结算。`onSpawn` 同步所有权回调先于 stdin，回调失败不投递请求。阶段只透传 validate/prepare/blender，不把原始 stderr 暴露给页面。 |
| 产物证据 | 结果绑定源、计划、候选身份、调灯、目录和 nonce；full/card/GLB 必须齐全。重新从本次候选读磁盘 hash/长度，检查路径/链接；保留 optional warning，坏 optional 不能同时列为好产物。实际 PNG/GLB 基础解码仍由 Python 完成。 |
| 失败语义 | 缺 Blender 等错误保留短 code/cause，不输出原始路径、日志或稿件内容。未知协议、非零退出、伪造质量成功一律拒绝。 |
| 质量与发布 | 只接受 `unwired` / `wired=false` / `runtime_gate=pending` / `production_ready=false`。不写 generation.json、ready index、current、job.json，不开放新路由/界面。 |

## 验证记录

| 最终验证 | 结果 | 日志 |
|---|---|---|
| 服务端全量 | **565 passed**，退出 0；含 36 项桥接回归，原 529 项保持通过 | `/tmp/rf03c21-server-final.log` |
| generation / pipeline_v2 / render_contract 相关 pytest | **198 passed**，退出 0，112.11 s | `/tmp/rf03c21-packaging.log` |
| 最后一次桥接跨语言/CLI 专项 | **5 passed、31 deselected**，退出 0；属于上述 Python 测试子集，不累计计数 | `/tmp/rf03c21-python-bridge-final.log` |
| 服务端 typecheck | 退出 0 | `npm run typecheck -w beian-server` |
| Git whitespace | 已跟踪 diff 检查通过；新增三文件 no-index whitespace 检查无诊断 | `git diff --check`；no-index 的有差异退出码不当测试失败 |

Python 的 5 项 SWIG DeprecationWarning 不影响断言；未跑全仓 Python/UI/build/quality 发布门禁，本轮没有 `/ship`。运行环境为本机 Node 25.8.2 与主工作树既有 Python venv；不代替发布要求的 Node 20/22 和 Windows 验证。

相对接手前 266 文件 SHA-256 快照：既有文件只改变 `render_generation.py` 与其测试；新增仅 bridge 实现/测试及本台账；无删除。jobs/mockup/renderGenerations、UI、renderer、registry、基线和既有 F 证据字节未变化。

阶段记录：

- 桥接首轮专项：33 passed；包含正常正例与协议篡改、重放、源/资产变化、输出损坏、路径/链接、超时、取消、回调失败和启动失败。
- 最后补三条：所有权回调内取消不投递请求、文件错误不泄漏路径、忽略温和终止的本次受控子进程必须等强制终止并关闭后才完成。“取消后等待关闭”和“强制终止”这两种 POSIX 信号时序断言在 Windows 显式跳过，不伪称 Windows 已验证。
- Python 桥接专项：5 passed、31 deselected。既有真实 RF-02 fixture → 实际 Node bridge → 实际 Python CLI 验证；缺 Blender 失败。另一成功路径只替换 Blender subprocess，保留实际 CLI/RF-02/私有快照/nonce/回传验证/card 写入，Node 再验输出身份。没有运行 Blender。
- 端到端夹具首轮 1 failed/4 passed：误把 venv Python symlink 作为受控 Blender 路径，被现有安全规则正确拒绝。修夹具为独立普通文件后 5 passed；没有放宽产品检查。
- `app.cli --help` 退出 0：CLI/STAGE/save_task/packaging 边界仍成立。

## 明确未完成与下一步

1. **C2.2 jobs 适配：** 将同步验证边界改成异步准备 + 锁内新鲜度重验，保留入队幂等/权限/过期源保护；统一候选创建所有权。尚未注册任何 production adapter，生产仍 unavailable。
2. **进程持久化/恢复：** 当前 `onSpawn` 是桥接回调，不是 jobs 已持久化身份。stdin 请求不出现在命令行；B 旧 `pipeline.py + job id` 的恢复识别不能识别该命令。后续必须绑定 job/mutation/执行 token 并更新 owned/unknown/missing 围栏，不能复用旧 PID 假装已接线。
3. **进程树与全程预算：** 本轮本机测试证明单个受控进程的 close 屏障及 POSIX 取消。Windows taskkill、父进程意外先死后的孤儿 Blender、重启/断电均未证明。哈希前后处理不属于子进程计时器；更完整资源准入与恢复留给运行时接线，不能宣称全部运行时预算已闭环。
4. **质量门：** 真实 runtime hard gate、深度 GLB 六面/尺寸/UV/透明度、采样预算、磁盘准入等还未接线，不用 C1 基础解码替代。
5. **真实渲染、Windows、真实稿、RF-04/UI、默认 F 与发布：** 均未进入。Grok 心跳保持暂停。

只有以上生产接线条件闭环后，才能讨论让实际新代进入 ready/current。此文是 C2 当前主台账，C1/B 的历史未接线记录不被改写为生产完成。
