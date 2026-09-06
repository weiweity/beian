# RF-03B 队列与 current 提交接线交付记录

> 归档说明（2026-09-06，第 08 批）：下文保留原实施/返修时的授权、测试和未接线状态，不能用历史次数证明本次发布验收。当前批次承接已经拆分的存储、Python 候选与进程桥接，仅交付 jobs 内部队列、代际提交及适配接口；真实适配器仍未默认注册，runtime quality 仍为 unwired，Windows 新桥托管、HTTP/UI 接线、真实 Blender/L2 与业务开放均不在本次完成范围。提交/发布状态以本批 PR 和匹配发布证据为准。

STATUS: **DONE_WITH_CONCERNS**

RF-03B.5 有界返修已落地（恢复槽：终态 failed 不能代替 worker 退出确认）。B.4 出队前身份、B.3 受信验证与调灯透传、B.2 满员账本与词法根校验保留。**不宣称 RF-03B 整体已验收，不宣称真实 RF-02 验证器、staging 执行器或质量门已接线。** 尚未开放 HTTP/UI，未切换默认 F，未跑 Blender，未验证 Windows/断电耐久性。不提交、不推送、不 PR、不部署。本记录不代替只读台账 `packaging-quality-rf03-acceptance.md`。

## RF-03B.5 有界返修

Codex 独立探针 `/tmp/rf03b4-recovery-probe.mts`（只读，未改）当时为：inspect 始终 owned、killTree 受控抛错（无真实进程），`reclaimOnBoot` 仍把旧 mutation 标 failed 并启动另一 queued job；输出 `OWNED_KILL_FAILED_NEW_EXECUTIONS 1 OLD_STATUS failed INSPECTS 1`。根因是 `recoverInterruptedMutation` 在 owned 终止失败后仍 `failPersistedMutation`，`reclaimOnBoot` 先清空 `live.blender`，`tryStart` 把终态 failed 当成 worker 已退出并放槽。

只改白名单：`jobs.ts` / `jobs-generations.test.ts`、本记录。未改 `mockup.ts` / `renderGenerations.ts`、未改独立探针、未改全局 `tasks.ts`、未改依赖/质量基线、未切默认 F。原分支其余未提交工作只读保留。未新增生产轮询、HTTP 或 UI 控制面。

### 恢复槽围栏（确认安全之前）

拒绝把 mutation `failed` 当成 Blender 进程退出。选定方案：沿用 `clearPersistedWorker` 的 inspect → 仅 owned 才 kill → 再 inspect；generation 恢复对 pid 复用 `other` 按确认解除（不杀无关进程），`unknown` 不 kill。

- owned 终止失败、杀完仍 owned、unknown：mutation 保持 `running`，保留 `worker_pid`，`live.blender` 占住该单。不能领其他 Blender 工作，同 job 新请求 `render_generation_busy`。两次 `reclaimOnBoot` 不能绕过。
- missing：不 kill，mutation `failed`，解除共享槽。
- pid 复用 other：不杀无关进程，mutation `failed`，解除共享槽。
- `tryStart` 在领 Blender 之前若发现 running + 待核验 `worker_pid`，重新占槽（`reclaimOnBoot` 会先清 `live.blender`）。
- 无 `worker_pid` 的中断 running 仍标失败（没有待核验身份）。queued 且缺适配器仍失败，不留假排队。
- 安全解除后，排队 waiter 可正常 claim 并提交；同 job 新请求不再 busy。

独立探针复跑（未改脚本）：`OWNED_KILL_FAILED_NEW_EXECUTIONS 0 OLD_STATUS running INSPECTS 1`。`/tmp/rf03b3-queue-source-probe.mts` 仍为 `QUEUED_STALE_SOURCE failed EXECUTIONS 0`。`/tmp/rf03b3-identity-acceptance.mts` 仍为计划/请求 seal 后失败、调灯成功。

## RF-03B.4 有界返修

Codex 独立探针 `/tmp/rf03b3-queue-source-probe.mts`（只读，未改）当时为：共享槽等待时替换旧白图，`VIRTUAL_SOURCE_CHANGED true`，放槽后仍 `QUEUED_STALE_SOURCE succeeded EXECUTIONS 1`。根因是出队后才取当前源快照，首次 g0 导入使用实时 `virtualLegacyCurrentId()`，未比对入队时的 `request.source` / `expected`，把用户没选的新源当原请求执行。

只改白名单：`jobs.ts` / `jobs-generations.test.ts`、本记录。未改 `renderGenerations.ts`、未改独立探针、未改全局 `tasks.ts`、未改依赖/质量基线、未切默认 F。原分支其余未提交工作只读保留。

### 出队前身份重核（任何 g0 / 候选目录 / 执行器之前）

拒绝继续用实时虚拟代当排队请求的源，也拒绝在执行时用当前 `files` 冒充历史 source。选定方案：入队仍只接受**当前代**作为源；出队前从磁盘重核。

- `claimGenerationMutation` 在改 running、占 Blender 槽、调用执行器之前，从磁盘重核：完整请求身份、payload 与幂等账本、`expected_current` / `started_current` 对应当前指针或虚拟代、source 仍是当前代。失败则 mutation `failed`，不导入 g0，不建候选目录，不执行。
- `runGenerationMutation` 在 `assertGenerationExecutable`、g0 `sealGeneration`、候选目录和 executor 之前再核一次。g0 导入的 `expectedCurrentGenerationId` 用请求里冻结的 expected，不再调用实时 `virtualLegacyCurrentId()`。
- 首次虚拟代在排队期间被换掉：`render_generation_stale` / failed，current 仍为空，磁盘文件保持被换后的现况（不切到执行器输出），不写 g0。
- 托管单排队期间 current 指针被换掉：同样 stale/failed，保留当时磁盘指针与文件，不跑第二轮执行器。
- 本切片不支持非 current source：托管后若 `source !== current`，入队即 `render_generation_invalid`（「只接受当前代作为源」），不留假 queued。历史源解析留给后续切片，不能拿当前 files 冒充。

独立探针复跑（未改脚本）：`VIRTUAL_SOURCE_CHANGED true`，`QUEUED_STALE_SOURCE failed EXECUTIONS 0`。`/tmp/rf03b3-identity-acceptance.mts` 仍为计划/请求 seal 后失败、调灯成功。

## RF-03B.3 有界返修

Codex 独立探针 `/tmp/rf03b-identity-probe.mts`（只读，未改）当时三例为：seal 后改 `resolved_job.json` 仍 succeeded 并切 current；seal 后只改磁盘 `source_generation_id` 仍 succeeded 并切 current；调灯 1.2/0.8 已持久化但执行器输入只有 `jobId/jobRoot/mutationId/mode/sourceGenerationId/contractSha256/profile/candidateDir`。`mockupRenderPlanBytes` 对任意 JSON 做 `JSON.parse` 再自报哈希，不能称 RF-02 已验证。

只改白名单：`jobs.ts` / `jobs-generations.test.ts`、`mockup.ts` / `mockup-generations.test.ts`、本记录。未改 `renderGenerations.ts`、未改独立探针、未改全局 `tasks.ts`、未改依赖/质量基线、未切默认 F。原分支其余未提交工作只读保留。

### 合同 3：验证适配器 + 不可变执行快照

拒绝把 `JSON.parse` 或自报哈希当 RF-02 验证，也拒绝在 TS 复制 Python `render_plan_for_resolved_job` / `blender_execution_plan`。选定方案：jobs 层定义必需的服务端验证适配器，生产未注入即 unavailable。

- 入队与执行都要求三个适配器同时存在：`verifyRenderPlan`、`runRenderGeneration`、`qualityVerifier`。缺任一：`render_generation_unavailable`，不留 queued。
- `mockupRenderPlanBytes` 只读磁盘原始字节（含非 JSON），不再 parse、不再返回 sha256。
- `verifyRenderPlan` 必须交回其验收的原字节、`identitySha256`、`profile`、具名 `verifier`。jobs **独立**对磁盘字节做 SHA-256：身份不一致、改写字节、缺 profile 都拒绝。profile 只从验证结果取，不信客户端，也不再用 mode 硬编码给新代。
- 执行器输入改为不可变快照：`plan.{identitySha256,bytes,profile,verifier}`、`sourceOutputs`（white_a/white_b/glb 路径+sha256+长度）、可选 `studioAdjustment`。删除顶层 `contractSha256` / `profile`。
- 执行器返回必须绑定快照：`contract_sha256`、`plan_identity_sha256`、`source_generation_id` 与执行快照一致，否则不固化。
- g0 导入仍用 `compat-legacy-v0`（原图身份），新代 profile 用验证结果。新输出仍只进本次 `.candidate-<mutationId>/`。

生产没有 RF-02 验证器、没有真实 staging 执行器。测试注入具名 `rf03b-test-plan` 受控验证器（只认合成夹具 `resolved-packaging-job/1` + 六面 assets / 两张输出 / render），**不是** RF-02 生产验证。

### 合同 4：锁内 fresh 身份重验

执行前冻结请求身份（source/mode/payload/expected/started/调灯）与计划字节/身份、源输出快照。执行返回后、seal 前重验一次（挡住执行中篡改，不固化 g1）。seal 后 `afterSealBeforePointer` 之后，在同一 job 锁内 `readMockupFromDisk` 再验：

- 完整请求身份仍等于冻结快照
- mutation 仍是同一 id/mode 且 status=running（假 succeeded 且无 current 不得跳过失败落盘）
- 当前代仍等于 `started_current_generation_id`
- 新鲜计划字节/身份/profile 仍等于执行快照
- 源文件路径与哈希仍等于快照

任一失败：不写 pointer，磁盘与缓存保持旧 current/files；seal 后失败时 ready 新代可 orphan。

### 独立探针注入合同（旧脚本不可直接跑通，不伪称通过）

`/tmp/rf03b-identity-probe.mts`、`/tmp/rf03b-independent-probe.mts`、`/tmp/rf03b2-independent-acceptance.mts` 仍只注入 `qualityVerifier` + `runRenderGeneration`，未注入 `verifyRenderPlan`，入队会 `render_generation_unavailable`。本刀**未改**这些只读探针，**不宣称它们通过**。

Codex 复验 B.3 需另写探针，最低注入：

```ts
setJobsTestHooks({
  qualityVerifier: unwiredVerifier, // quality_status 只能 unwired，不得写成 pass
  verifyRenderPlan: (input) => {
    // 必须验收磁盘字节；不得返回与磁盘不等的 bytes，不得自报与独立哈希不符的 identitySha256
    // 测试夹具：schema === "resolved-packaging-job/1" 且含 assets 六面、outputs.front_right/back_left、render
    return {
      identitySha256: sha256(input.bytes),
      bytes: input.bytes,
      profile: input.mode === "upgrade" ? "packshot-neutral-v1" : "compat-legacy-v0",
      verifier: "rf03b-test-plan",
    };
  },
  runRenderGeneration: async (input) => {
    // input 必有 plan.bytes / plan.identitySha256 / plan.profile / sourceOutputs
    // 有调灯时必有 studioAdjustment.product_light / background_light
    // 不得再读 top-level contractSha256 / profile
    return {
      outputs: [...], // 必须在 input.candidateDir 内
      contract_sha256: input.plan.identitySha256,
      plan_identity_sha256: input.plan.identitySha256,
      source_generation_id: input.sourceGenerationId,
    };
  },
});
```

执行器输入键：`jobId` `jobRoot` `mutationId` `mode` `sourceGenerationId` `candidateDir` `plan` `sourceOutputs`，有调灯时加 `studioAdjustment`。

## RF-03B.2 有界返修

B.1 独立 508 / typecheck / diff 通过，原探针 `REPLAY` / `ANCESTOR_REJECTED` / `EXTERNAL_BYTES ORIGINAL` 仍成立，但两个原 P1 边界可复现绕过：`ARBITRARY_TRUSTED_ALIAS_ACCEPTED`、`ALIAS_EXTERNAL_BYTES ALIAS_CHANGED`、`EVICTED_REQUEST_NEW_MUTATION true`。只改白名单：`jobs.ts` / `jobs-generations.test.ts`、`mockupAtomicWrite.ts` / 同名测试、`mockup.ts`（账本语义注释）、本记录。未改独立探针、未改全局 `tasks.ts`、未改依赖/质量基线、未切默认 F。原分支其余未提交工作只读保留。

### P1-1 满员 fail-closed（取代 B.1 的 silent eviction）

根因：`rememberIdempotencyFact` 在超过 16 条时 `shift` 最旧记录。第 17 个不同 `clientRequestId` 入队后，已接受过的 `eviction-request-0` 从账本消失；再重放会被当成新工作并产生新 mutation。只看 `latest` / `render_generation_request` 救不了被挤掉的旧号。

选定方案：有界账本仍是每单 16 条，**满员拒绝新 requestId，不挤旧记录，不扩建无界数据库**。

- 入队先查账本。已在账本（或当前 `render_generation_request` 回退）的号：同 payload 返回原终态 mutation，不跑执行器；异 payload `render_generation_invalid`。
- 新号在账本已有 16 条时：`render_generation_invalid`（409，文案含「账本已满」），不 persist、不占槽、不跑执行器。
- 更新已有号（queued → running → succeeded/failed）仍原地改 mutation 摘要，不占新槽。
- **容量/可用性权衡：** 一单最多 16 个不同 clientRequestId。第 17 个新号会被明确拒绝，直到产品另开容量决策。这是故意用可用性换「已接受的请求永不重执行」。16 次重渲对当前内部接线足够；不够时再评审上限，不能改成 silent eviction 或无界 JSON 数组。

L0 覆盖：16 条失败入账后，第 17 个新号拒绝且执行器次数不变；重放 `eviction-request-0` / 最后一条均返回原 failed mutation，`EVICTED_REQUEST_NEW_MUTATION` 等价为 false；异 payload 仍拒绝；图片与 current 不变；公开 JSON 仍无账本。

独立探针在 `n=0..16` 循环里对第 17 个**新**号没有 try/catch，因此在满员拒绝处退出 7，**不会打印** `EVICTED_REQUEST_NEW_MUTATION`。这不是旧 requestId 被重执行；探针未改。同一场景由 `jobs-generations.test.ts` 的 fail-closed 用例覆盖。

### P1-2 词法根 + 逐段后代（取代 B.1 的 realpath∈trusted 放行）

根因：`assertTrustedAncestors` 向上走时，若当前分量是 symlink 且 `realpath(current)` 恰好等于可信根（`/private/tmp`、`DATA_DIR` 等），就当系统别名返回。攻击者在任务树里自建 `inside/trusted-alias -> /private/tmp`，词法路径仍在 `/private/tmp/...` 下，写入却跟随别名改到 `outside/task/job.json`。

选定方案：只允许**明确配置根的原始词法入口**及**已验证系统别名入口**（`DATA_DIR`、`os.tmpdir()` 及其 realpath，POSIX `/tmp` `/private/tmp` `/var/tmp` `/private/var/tmp`）。从覆盖 dest 的最长词法根**向下逐段** `lstat`（不跟随当前分量）。只有选定根自己可以是已验证别名（macOS `/tmp→/private/tmp`）。内部 symlink 即使指向 `DATA_DIR` 或 `/tmp` 也 `symlink_dir`。任意路径不得因目标恰好等于可信根而获权。

拒绝时外部字节与目录名单不变、不落临时文件。macOS `/tmp` 下普通目录祖先仍可写。rename 失败 / dest symlink / hardlink / 缺父目录 / 非目录祖先 / 非可信根 回归保留。

### 独立探针（只读，未改 `/tmp/rf03b-independent-probe.mts`）

| 项 | 首轮 | RF-03B.1 | RF-03B.2 |
|---|---|---|---|
| 成功后同 request 重放 | `REPLAY_REJECTED render_generation_stale` | `REPLAY` 原 mutation `succeeded` | 同 B.1 |
| 祖先 symlink 写入 | `ANCESTOR_WRITE_ACCEPTED` | `ANCESTOR_REJECTED render_generation_invalid` | 同 B.1 |
| 外部 job.json | `CHANGED` | `ORIGINAL` | 同 B.1 |
| 任意 trusted-alias→/private/tmp | （探针当时无此项） | `ARBITRARY_TRUSTED_ALIAS_ACCEPTED` / `ALIAS_CHANGED` | `TRUSTED_ALIAS_REJECTED render_generation_invalid` / `ALIAS_EXTERNAL_BYTES ORIGINAL` |
| 16 条后重放第 0 号 | （未覆盖） | `EVICTED_REQUEST_NEW_MUTATION true` | 第 17 个新号满员抛 `render_generation_invalid`（探针退出 7，未打印该行）；L0 证明重放第 0 号不产生新 mutation |

## RF-03B.1 有界返修

Codex 独立复核首轮 501 通过，但独立探针当时为 `REPLAY_REJECTED render_generation_stale`、`ANCESTOR_WRITE_ACCEPTED`、`EXTERNAL_BYTES CHANGED`。只改白名单：`jobs.ts` / `jobs-generations.test.ts`、`mockupAtomicWrite.ts` / 同名测试、`mockup.ts` / `mockup-generations.test.ts`（类型与公开泄漏）、本记录。未改独立探针、未改全局 `tasks.ts`、未改质量基线、未切默认 F。原分支其余未提交工作只读保留。

### P1-1 幂等保留范围（已决定）

持久化有界账本 `render_generation_idempotency`（每单最多 `RENDER_GENERATION_IDEMPOTENCY_LIMIT = 16` 条），覆盖 **queued / running / succeeded / failed**。每条含 `client_request_id`、`payload_sha256`（mode + source + canonical adjustment，不含 expected current）、以及该 request 的 mutation 公开摘要。

- 入队先查账本，再做 expected current stale / busy / 适配器检查。
- 同 `clientRequestId` + 同 payload：返回**原 mutation**（即使 current 已切换、即使后面又来了第二请求）。访问检查仍在锁前。
- 同 `clientRequestId` + 不同 payload：`render_generation_invalid`，不执行新工作。
- 新请求仍校验 expected current；不符 `render_generation_stale`。
- B.1 曾「超出 16 条丢最旧」。B.2 改为满员拒绝新号、不 shift。见上文 RF-03B.2 P1-1。

公开详情/列表仍不序列化 `render_generation_request` / `render_generation_idempotency`。

### P1-2 可信祖先

`atomicReplaceJobJson` 在**创建临时文件前**和 **rename 前**都走 `assertTrustedAncestors`：从目标父目录向上 `lstat`（不跟随当前分量）。中间祖先 symlink 一律 `symlink_dir`，外部字节与目录名单不变。

B.1 用 realpath∈可信根放行系统别名，会被 `inside/trusted-alias -> /private/tmp` 绕过。B.2 改为配置词法根 + 向下逐段校验，见上文 RF-03B.2 P1-2。目标文件 symlink/hardlink 保护保留。rename 失败仍不 copyFile、不先 unlink 目标。

生产路径缺执行器/质量适配器时明确 `render_generation_unavailable` 且不留假 queued。测试注入的受控执行器 + `quality_status=unwired` **不是**产品完成，不能当生产绿灯。独立探针对照表见上文 RF-03B.2。

## 设计选择

拒绝存储模块自行 `saveMockup` 或绕开全局 Blender 槽的第二写者。`jobs.ts` 仍是调度和 job.json 唯一写者；`renderGenerations.ts` 只返回校验过的 patch。generation-managed 单走专用 `atomicReplaceJobJson`；全局 `tasks.replaceFile` 的 copyFile 回退未改，避免牵动审稿。

## 实际文件

白名单内：

- `apps/web/server/src/jobs.ts`（入队、共享槽、执行适配器合同、锁内磁盘重读提交、启动恢复、旧入口拒绝；B.3 增加验证适配器与执行快照；B.4 出队前重核 expected/source/已接受身份，g0 不再用实时虚拟代；B.5 恢复槽围栏：owned/unknown 未确认前不放槽）
- `apps/web/server/src/jobs-generations.test.ts`
- `apps/web/server/src/mockup.ts`（代际字段、专用原子写路由、公开摘要、`fileOf` 路径 jail、旧 retry 拒绝；B.3 `mockupRenderPlanBytes` 改为原始字节读取）
- `apps/web/server/src/mockup-generations.test.ts`
- `apps/web/server/src/renderGenerations.ts`（`isRenderGenerationOutputKey`；代际 id 允许 ADR 中的连字符 slug，例如 `g1-legacy-relight-…`。**B.3 / B.4 未改。**）
- `apps/web/server/src/renderGenerations.test.ts`（A.2 回归 + 连字符 id / key 分类。**B.3 / B.4 未改。**）
- `apps/web/server/src/mockupAtomicWrite.ts`（B.3 / B.4 未改）
- `apps/web/server/src/mockupAtomicWrite.test.ts`（B.3 / B.4 未改）
- `docs/designs/packaging-quality-rf03b-result.md`（本记录）

未改：`index.ts`、UI、Python、`tasks.ts`、依赖/锁文件/质量基线、VERSION、规划指令、旧验收台账、默认 profile。现有 dirty / untracked F/UI/Python 只读保留。

## 八条实现对应

| # | 合同 | 结果 |
|---|---|---|
| 1 | 内部代际 mutation 入队：校验 mode/source/current/权限、done、job 互斥；持久化小型摘要；快速返回；生成期间 `job.status` 始终 `done`；同 request 幂等；同 ID 不同 payload 拒绝；不同请求 busy；expected 不符 stale；不信任客户端 profile/path | **已实现；RF-03B.2 满员 fail-closed；RF-03B.4 只接受当前代作为源。** 成功/失败后同 request 重放返回原 mutation；16 条后新号明确拒绝，已接受的旧号不重执行。历史 source 入队即 invalid，不留假队列。无适配器时根本不入队。 |
| 2 | 复用全局唯一 Blender 槽；他单占槽则 queued，不伪造完成、不立刻以忙替代排队；缺适配器 unavailable 且不留假 queued；测试可注入执行器；生产不能默认 unwired 激活 | **已实现；RF-03B.3 三个适配器都必填；RF-03B.4 出队前 stale 不占槽。** 生产 `hooks` 为空则 412 `render_generation_unavailable`。测试注入 `verifyRenderPlan` + `runRenderGeneration` + `qualityVerifier`。排队期间源/指针变化则 failed，换下一个 waiter。 |
| 3 | 最小执行适配器：已验证合同与原输出；g0 先安全导入；新输出只进本次候选目录；不能把 `runPackagingBlenderOnly` 当安全适配器；回调身份须经存储校验；无真实适配器如实拒绝 | **RF-03B.3：测试合同已实现，生产适配器未接线。** 入队前必须有验证+执行+质量三个适配器，否则 unavailable 不留 queued。执行器拿到不可变已验证计划字节/身份、源输出快照和调灯，而不是顶层 SHA/硬编码 profile。返回必须绑定快照。`JSON.parse` 与自报哈希不再冒充 RF-02。`runPackagingBlenderOnly` 仍只给旧 relight。 |
| 4 | 完成时锁内从磁盘重读（不用 `loadMockup` 缓存当事实）；核对 mutation/source/current；一次写入 current + 派生 files + mutation 终态；写失败内存和磁盘保持旧 current；保留 ppt/sheet/read；ready orphan 留存；失败不切换 | **RF-03B.3 锁内 fresh 重验保留；RF-03B.4 把 source/expected 核验提前到出队前。** 排队后虚拟源或托管指针变化：failed，不导入被换掉的源，不执行，旧 pointer/files 保留。 |
| 5 | 专用原子写：同目录临时文件、独占创建、祖先防护、文件 fsync、rename；失败不 copyFile、不先 unlink 目标；Windows 走实际 Node rename，失败明确报错；已带 pointer 的后续 `saveMockup` 走专用路径 | **Mac/POSIX 路径已实现；RF-03B.2 改为词法根逐段校验。** Windows 耐久性未证明。`MOCKUP_ATOMIC_WRITE_WINDOWS_DURABILITY_PROVEN=false`。 |
| 6 | 启动恢复：只扫描确有 generation/mutation 的单；orphan 只补索引不激活；中断 mutation 明确终态，不盲重跑；沿用 worker 身份合同，不杀不明进程；两次恢复幂等；旧单不批量迁移 | **RF-03B.5：终态 failed 不再代替 worker 退出。** owned 终止失败 / 仍 owned / unknown 保持 running 与槽围栏，两次恢复不能绕过。missing / pid 复用 other 不杀无关进程后才 fail 并放槽。queued 缺适配器仍失败。 |
| 7 | 旧 retry/relight/补面不能 `collectOutputs` 覆盖已托管 files；未迁移的旧入口稳定拒绝并保留图片；无 generation 单行为不变；激活历史代不占 Blender 槽，但与提交共用 job 锁 | **已实现。** `render_generation_managed` / 已出图拒绝。 |
| 8 | 私有身份/路径/mutation 执行信息不进公开详情和列表；新增字段不得靠对象 spread 泄漏；无路由不是权限豁免 | **已实现。** 公开只有 `has_render_generations`、当前代 id、小型 `render_mutation`；`render_generation_request` / `render_generation_idempotency` 不序列化。入队仍 `assertCanManageMockup`。 |

## 验证（设计要求的场景）

| 场景 | 证据 |
|---|---|
| 共享槽排队/释放 | `queues behind the shared Blender slot…`：占槽时 queued，放槽后 running→succeeded |
| 排队期间虚拟源变化 | `fails a queued first generation when the virtual source changes…`：failed，执行器 0 次，无 g0，current 空；独立探针 `QUEUED_STALE_SOURCE failed EXECUTIONS 0` |
| 排队期间托管 pointer 变化 | `fails a queued hosted mutation when the current pointer changes…`：failed，不跑第二轮，无 g2，指针保持被换后的磁盘值 |
| 正常排队成功 + 调灯 | `still commits a queued mutation with lighting…`：放槽后 succeeded，1.2/0.8 到达 executor |
| 历史 source 入队拒绝 | `rejects a historical source at enqueue…`：`render_generation_invalid`，mutation 仍是上一单 succeeded，执行器次数不变 |
| 生成期间 fileOf 仍读旧图 | `queues behind the shared Blender slot…`：running 时字节仍是原 WHITE_A |
| 幂等 / busy / stale / 无权限 | 同 request 返回原 mutation（在途、成功后、失败后、第二请求后、满 16 条后）；不同 payload 拒绝；第二请求 busy；新请求错误 expected stale；第 17 个新号满员拒绝；他人 403 且不落 mutation |
| 磁盘重读对抗缓存旧值 | 缓存被改成 `g0-legacy-original` 后仍按磁盘 null current 提交新代 |
| 写失败 disk/cache 一致 | 注入 rename EPERM：磁盘与缓存都没有新 current，旧图仍在 |
| 完成提交一次切换 | succeeded 后 `current_render_generation_id` 为 g1，fileOf 读到新 PNG；ppt/sheet 仍在 |
| worker 失败 / 输出非法 / 缺适配器不切图 | 执行器 throw、候选目录外路径、无 hook 入队均不切换 |
| rename 后 pointer 前失败 orphan | g0+g1 ready 留在隐藏目录；job.json 无 current；`recoverOrphans` 两轮无新 recovered |
| 启动恢复两轮 | **B.5：** running + unknown：保持 running、不 kill、占槽；再 recover 仍 running，不领下一单 |
| owned kill 失败占槽 | `holds the Blender slot when owned kill fails…`：两次 recover 后仍 running，waiter queued，执行器 0 次，同 job busy |
| kill 返回仍 owned | `holds the Blender slot when kill returns but the worker is still owned`：前后 inspect，仍 running，不领下一单 |
| unknown 不 kill | `holds the Blender slot for unknown workers without killing…`：kills=0，公开 JSON 无 worker_pid |
| missing 安全解除 | `releases the Blender slot without killing when the persisted worker is missing`：旧单 failed，waiter succeeded，同 job 可再入队 |
| pid 复用 other | `releases the Blender slot without killing when the pid now belongs to another process`：不 kill，旧单 failed，waiter succeeded |
| 围栏后安全解除回归 | `keeps a waiter queued behind an unconfirmed worker then commits after a safe release`：先 queued，inspect 改 missing 后 succeeded |
| 旧入口不覆盖 | 托管后 relight/补面/retry 拒绝，图片字节不变 |
| 非代际 key 保留 | 提交后 files 仍含 ppt、sheet |
| 公开无路径 | 详情/列表 JSON 无 `render_generation_request`、无 `render_generation_idempotency`、无 `.render-generations`、files 无 path |
| A.2 全回归 | `renderGenerations.test.ts` 20 pass（原 18 + 连字符 id + key 分类）；B.3 / B.4 未改该文件 |
| 调灯到达执行器 | `passes immutable verified plan…`：1.2/0.8 在 `studioAdjustment`，无顶层 `contractSha256`/`profile` |
| 缺计划验证器 | 仅注入执行器+质量：`render_generation_unavailable`，无 queued |
| 自报哈希 | 验证器返回与字节不符的 identity：入队 invalid，无 queued |
| 逐字段请求篡改/缺失 | seal 后改 source/mode/payload/expected/started/mutation/requestId/调灯或删字段：failed，旧图，g1 orphan |
| 执行中/固化后计划变化 | 执行中改 resolved_job：failed，无 g1；seal 后改：failed，g1 orphan，旧 current |
| 源文件变化 | 执行中/seal 后改 white_a：failed，不切到新图 |
| mutation 状态变化 | seal 后改 queued/failed/succeeded：不切 current；假 succeeded 且无 current 仍落 failed |

## 测试

| 命令 | 退出码 | 计数 |
|---|---|---|
| `cd apps/web/server && npx tsx --test src/mockupAtomicWrite.test.ts src/jobs-generations.test.ts src/mockup-generations.test.ts src/renderGenerations.test.ts` | 0 | **66 pass / 0 fail**（RF-03B 首轮 38；B.1 45；B.2 49；B.3 57；B.4 61；本返修 +5：替换 1 条 unknown→failed，新增 6 条围栏/解除） |
| `cd apps/web/server && npm test` | 0 | **529 pass / 0 fail**（RF-03A.2 为 481；RF-03B 首轮 501；B.1 508；B.2 512；B.3 520；B.4 524；本返修 +5） |
| `cd apps/web/server && npx tsc --noEmit` | 0 | 通过 |
| `git diff --check`（白名单已跟踪文件） | 0 | 无行尾空白；未跟踪测试/记录也无行尾空白 |
| `/tmp/rf03b4-recovery-probe.mts`（只读，未改） | 0 | `OWNED_KILL_FAILED_NEW_EXECUTIONS 0 OLD_STATUS running INSPECTS 1`（B.4 时为 1 / failed / 1） |
| `/tmp/rf03b3-queue-source-probe.mts`（只读，未改） | 0 | `VIRTUAL_SOURCE_CHANGED true`；`QUEUED_STALE_SOURCE failed EXECUTIONS 0` |
| `/tmp/rf03b3-identity-acceptance.mts`（只读，未改） | 0 | 计划/请求 seal 后 failed；调灯 succeeded，输入含 `studioAdjustment` |
| `/tmp/rf03b-identity-probe.mts` 等旧只读探针 | **未跑、不宣称通过** | 缺 `verifyRenderPlan` 注入后不可直接运行；新注入合同见上文 RF-03B.3 |

测试用小型合成 PNG/GLB 与受控 Promise 执行器。不依赖真实 `DATA_DIR`、网络、Blender、Illustrator。未跑 Windows，未跑断电，未跑真实稿。未开 HTTP/UI。

本机没有 `apps/web/backend/.venv`，未跑 `npm run quality`，未安装包、未改基线。

## 明确未完成（不是产品完成）

- **无真实 RF-02 验证适配器。** 生产 `verifyRenderPlan` 未接线。测试 `rf03b-test-plan` 只验收合成夹具，不能写成 RF-02 合同通过。
- **无真实 staging 适配器。** 生产不能把旧 `runPackagingBlenderOnly` 原位覆盖当安全执行器。缺验证/执行/质量 hook 时拒绝入队。
- **质量仍 unwired。** 测试验证器只允许 `unwired`，与 RF-03A 相同；不得写成 pass。
- **无 HTTP 202 / 无 UI。** `index.ts` 未改。没有 `/api/mockups/:id/render-generations`。
- **未切默认 F，未跑 Blender。**
- **Windows rename 替换 / 断电耐久性未证明。** 本地 mock 不能宣称 Windows 耐久性。
- **已托管单的详情/列表才出现 `has_render_generations` / 当前代 id / 小型 mutation 摘要。** 旧单这些字段为 `undefined`，`JSON.stringify` 不会写出。既有 relight POST 语义未改；无新路由。
- **历史 source 未接线。** 本切片入队拒绝非 current source；要用历史代重渲必须另开 ready 代文件解析与源新鲜度校验，不能拿当前 files 冒充。
- **恢复槽没有运行时重探。** owned/unknown 围栏只在启动恢复确认 missing/other 后解除。没有 HTTP/UI/轮询去杀或复查 fenced worker。

## 风险与下一接线门

1. 真实 worker 必须把新输出写进本次候选目录，再交给现有 `sealGeneration`；禁止原位 `runPackagingBlenderOnly`。
2. HTTP 202 产品接线单列：权限、幂等、公开摘要已在内部函数，但路由未开。
3. 质量适配器接线前，生产入队保持 unavailable。
4. Windows 指针写入需要真实 Node rename 成功路径的独立门，不能靠 copyFile。
5. 幂等账本上限 16 满员 fail-closed：第 17 个新 clientRequestId 被拒绝。这是容量换「旧号不重跑」；不够再评审上限，不能 silent eviction，也不能无界落盘。独立探针该段无 catch，退出 7；L0 已覆盖重放旧号。
6. 可信根是配置词法入口 + 已验证系统别名，不是「realpath 碰巧等于根」。Windows 祖先/junction 未在本机证明。内部 symlink 指向 DATA_DIR 或 /tmp 也拒绝。
7. 真实 RF-02 验证适配器必须验收 persistable plan，不能把测试夹具 schema 检查或 `JSON.parse` 当生产验证。接线前入队保持 unavailable。
8. 本切片明确拒绝非 current source。要用历史代重渲，必须另开接线：解析请求指定 ready 代的文件并做源新鲜度校验，不能拿当前 files 冒充。在此之前入队 fail-closed。
9. 恢复槽围栏只在 `reclaimOnBoot` 里 inspect/kill/inspect，并在 `tryStart` 按磁盘 running+worker_pid 重新占槽。没有生产轮询、HTTP 或 UI 去重探 fenced worker。owned 终止失败会一直占槽，直到下一次启动恢复看到 missing/other。这是故意用可用性换「不明/仍存活进程不放槽」。

本刀停在 RF-03B.5。不进入 RF-04 或 ship。不宣称 RF-03B 整体已验收。Codex 可用未改的 `/tmp/rf03b4-recovery-probe.mts` 复验恢复槽，并用 `/tmp/rf03b3-queue-source-probe.mts` 与 `/tmp/rf03b3-identity-acceptance.mts` 确认 B.4 未回退；不能拿未更新的 `/tmp/rf03b-identity-probe.mts` 当通过证据。

安全解除只发生在启动恢复的 inspect 确认 missing 或 pid 复用 other 之后；没有生产轮询、HTTP 或 UI 去重探 fenced worker。真实 Blender/Illustrator 进程、RF-02 验证器与 staging 执行器仍未接线。
