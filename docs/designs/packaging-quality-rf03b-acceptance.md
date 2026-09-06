# RF-03B Codex 独立验收台账

> 归档说明（2026-09-06，第 08 批）：下文保留原实施/返修时的授权、测试和未接线状态，不能用历史次数证明本次发布验收。当前批次承接已经拆分的存储、Python 候选与进程桥接，仅交付 jobs 内部队列、代际提交及适配接口；真实适配器仍未默认注册，runtime quality 仍为 unwired，Windows 新桥托管、HTTP/UI 接线、真实 Blender/L2 与业务开放均不在本次完成范围。提交/发布状态以本批 PR 和匹配发布证据为准。

## 最终结论：RF-03B 内部切片本地验收通过（2026-09-05）

以 B.5 为最终本地检查点，原八条合同在受控适配器/合成文件范围通过。下文各 B.1–B.4 缺口为历史返修记录，不再是当前未修项。未证明 Windows、真实渲染、真实稿、质量门或生产行为；不宣称整条画质改造完成。

- Codex 全量 server：529 passed，0 failed；专项：66 passed，0 failed。日志 `/tmp/rf03b5-independent-tests.log`、`/tmp/rf03b5-focused.log`。
- server typecheck、git diff --check：退出 0。
- `/tmp/rf03b5-recovery-acceptance.mts`：退出 0；owned 终止失败时两次恢复都阻塞，随后受控状态 missing 时仅启动下一单一次。初版探针拼接发生 await 位置错误，修正独立脚本后才得到本结果；产品源码未因该脚本错误修改。
- `/tmp/rf03b3-queue-source-probe.mts`：过期虚拟源 failed、executor 0 次。
- `/tmp/rf03b3-identity-acceptance.mts`：计划/请求变化拒绝且旧图保留；正常请求成功、调灯 1.2/0.8 到达。
- 相对实施前文件快照，已有文件变化仅 jobs.ts、mockup.ts、renderGenerations.ts 及其测试（四个文件）；新增仅 jobs-generations、mockup-generations、mockupAtomicWrite 实现/测试、result 与本 Codex 验收记录。此前 F/UI/Python 工作保留。

### 下一阶段必须保留的边界

1. 实际 RF-02 计划验证、私有 staging worker 与质量适配器尚未接线；生产入队 unavailable。测试 hook 不是产品能力。
2. 尚无新 HTTP 202/UI，未切默认 F；真实渲染/Windows 与人工验收单列。后续产品接线须另有窄切片合同。
3. 每单 16 个已接受请求满后拒绝新号，旧号可重放；容量限制不可默默带入产品开放而不说明。
4. 非当前历史源生成在本切片明确拒绝；历史代激活与新代生成是不同动作。
5. 恢复围栏解除靠重新检查确认 worker missing/other，未新增生产轮询或控制界面。未确认退出不因 mutation 失败而放槽。
6. 未 commit/push/PR/merge/deploy，不将本地验收视为发布授权。

## 2026-09-05 RF-03B.2 检查点

结论：两个已复现 P1 的静态与本地合成回归通过；RF-03B 整体仍未验收，不是产品端到端或生产验证。

- Grok B.2：`run-mto8q4cq-yaflxf`，completed / DONE_WITH_CONCERNS。
- Codex 独立 server 全量：512 passed，0 failed。日志 `/tmp/rf03b2-independent-tests.log`。
- server typecheck、git diff --check：退出码 0。
- 原复现探针 `/tmp/rf03b-independent-probe.mts`：成功请求重放恢复；普通祖先和伪可信根链接均拒绝、外部字节保持 ORIGINAL。该旧脚本在第 17 个新请求触发容量拒绝后退出 7，不能写成整个脚本通过。
- 独立验收探针 `/tmp/rf03b2-independent-acceptance.mts`：退出码 0；容量满拒绝且 job.json 字节不变，最旧请求重放返回原 mutation；两个 symlink 场景拒绝。
- 保留上限是每单 16 个已接受请求；满后拒绝新请求，不淘汰旧记录。这是当前内部切片的可用性限制，不应未设计容量更新策略便开放生产。

## 待继续核查

### B.4 独立复验与 B.5 恢复槽缺口

- server 524 passed、typecheck/diff 退出 0；`/tmp/rf03b4-independent-tests.log`。
- 排队源变化探针 failed / EXECUTIONS 0；B.3 计划/请求变化拒绝、正常调灯成功探针继续通过。
- `/tmp/rf03b4-recovery-probe.mts` 使用受控 inspect/kill hook（不操作真实进程）：旧 worker 始终 owned、kill 抛错，reclaimOnBoot 后仍启动下一单；输出 `OWNED_KILL_FAILED_NEW_EXECUTIONS 1 OLD_STATUS failed INSPECTS 1`。已派 B.5 修复原第 6/2 条：终态失败不能替代进程退出确认；不明/仍存活 worker 在安全解除前保留共享槽 fence，两次恢复不得绕过。全局 tasks.ts/生产控制面不扩范围。

### B.3 独立复验与 B.4 排队身份缺口

- server 520 passed、typecheck 与 diff check 退出 0；日志 `/tmp/rf03b3-independent-tests.log`。
- `/tmp/rf03b3-identity-acceptance.mts` 退出 0：有受控验证器的正常请求 succeeded，调灯 1.2/0.8 到达；seal 后计划/请求变化 failed，原图和 current 保留。不是缺 hook 导致全部拒绝。
- `rf03b_before_hashes` 已有文件比较只有 jobs.ts、mockup.ts、renderGenerations.ts、renderGenerations.test.ts 变化，均在白名单；新增文件仍待最终清点。
- `/tmp/rf03b3-queue-source-probe.mts` 复现：共享槽等待时替换旧白图，virtual source 已变；放槽后仍 succeeded 且 executor 被调用一次。已派 B.4 修出队前 source/expected/current 身份校验，禁止把实时新源当原请求的源。托管历史源也必须准确解析或明确拒绝，不拿当前 files 冒充。

### B.3 已复现并退回有界返修

`/tmp/rf03b-identity-probe.mts`（独立合成文件，无真实任务）退出 0，三例显示：seal 后改 resolved_job.json 仍 succeeded 并切 current；seal 后只改磁盘请求 source_generation_id 仍 succeeded 并切 current；调灯 1.2/0.8 未到达 executor 输入。源码 mockupRenderPlanBytes 仅 JSON.parse，不能称 RF-02 可信验证。已派 Grok B.3 修原第 3/4 条合同：可信验证适配器边界、完整不可变执行快照、锁内 fresh 身份重验、调灯透传；生产适配器仍未接线，不扩产品范围。

1. RF-03B 全部变化相对实施前快照的白名单检查。
2. 执行器输入是否真正携带已验证服务端 render plan、源代和调灯参数；仅 JSON 可解析和字节哈希不等于 RF-02 合同通过。
3. 最终锁内提交是否重新校验请求/source/current/plan 身份。当前源码似乎只核对 mutation ID 与 current，需要独立对抗探针确认，不能先断言已修复。
4. 共享槽、恢复、旧入口和公共字段合同的剩余审查。

保留原未提交工作；未 commit/push/PR/merge/deploy，未跑 Blender/Illustrator/真实任务，未切默认 F，未开放 HTTP/UI。
