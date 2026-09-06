# RF-03B：队列与 current 提交接线

> 归档说明（2026-09-06，第 08 批）：下文保留原实施/返修时的授权、测试和未接线状态，不能用历史次数证明本次发布验收。当前批次承接已经拆分的存储、Python 候选与进程桥接，仅交付 jobs 内部队列、代际提交及适配接口；真实适配器仍未默认注册，runtime quality 仍为 unwired，Windows 新桥托管、HTTP/UI 接线、真实 Blender/L2 与业务开放均不在本次完成范围。提交/发布状态以本批 PR 和匹配发布证据为准。

用户已要求开始 RF-03B；Grok 实现，Codex 独立验收。继承原分支 `codex/3d-rfe02-lighting-evidence` 全部未提交工作，不 commit/push/PR/部署、不跑 Blender/Illustrator、不操作真实任务、不切默认 F。

## 前置与边界

先完整读 AGENTS.md、ADR-007 第15/16节、RF-03A 交付与 `packaging-quality-rf03-acceptance.md`。CodeGraph 无可用索引，按已确认回退针对性读源码，禁止重建索引。跳过技能附带升级、遥测、自动提交。RF-03A 两项 P1 已通过，不能回退历史可读/源新鲜度隔离或写入前路径防护。

本刀交付内部队列与提交闭环，不开放新 HTTP/UI、不切换既有 relight 的 HTTP 返回合同。后续真实 worker staging 适配与 HTTP 202 产品接线单列；本刀不能伪称端到端产品完成。真实适配器未就绪必须拒绝入队，不把测试 hook/quality unwired 当生产绿灯。

## 比较与选型

拒绝“存储模块自行 saveMockup + 绕开全局槽的异步 worker”；选 jobs.ts 唯一调度和写者、renderGenerations 仅管理产物/返回 patch。拒绝修改全局 tasks.replaceFile 影响审稿；generation-managed mockup 使用专用 fail-closed 原子保存，普通历史行为不顺手重构。

## 允许修改

- apps/web/server/src/jobs.ts、jobs.test.ts（或新增 jobs-generations.test.ts）
- apps/web/server/src/mockup.ts、mockup-files.test.ts（或新增 mockup-generations.test.ts）
- apps/web/server/src/renderGenerations.ts、renderGenerations.test.ts：仅所需接线扩展，保留 A.2 回归
- 可新增 apps/web/server/src/mockupAtomicWrite.ts 与同名测试：实现专用原子写，不能建立第二 job 写者
- 新增 docs/designs/packaging-quality-rf03b-result.md

禁止改 index.ts、UI、Python、tasks.ts、依赖/锁文件/质量基线、VERSION、规划指令与旧验收台账。需要扩范围则报告，不借 test-only 自动打开产品。

## 必须交付

1. jobs 内部代际 mutation 入队函数：验证服务端 mode/source/current/访问权限、请求身份、done 状态、job 级互斥；持久化小型 mutation 摘要及请求，快速返回，生成期间 job.status 始终 done。重复请求幂等；同 request ID 不同 payload 拒绝；不同请求同 job busy；expected current 不符 stale。内部参数不得直接信任客户端 profile/path。
2. 复用现有全局唯一 Blender 槽；其他 job 占槽时 queued，不伪造完成、不立即以忙替代排队。缺少可信执行/质量适配器时明确 unavailable 且不留假 queued。测试可注入执行器并控制 Promise，生产不能默认用 unwired 验证结果激活。
3. 定义最小执行适配器合同：取得已验证服务端 render plan/合同与原输出，g0 先安全导入；新输出仅在本次私有 staging/candidate 内生成，不能把旧原位 runPackagingBlenderOnly 直接当安全适配器。回调返回 generation/output 身份须经存储校验；无实际适配器的边界如实记录，不复制 Python renderer 逻辑。
4. 完成时在同 job 锁内从磁盘重读 job（loadMockup 缓存不够）；核对 mutation ID、source/current、期望身份仍有效，随后一次持久化更新 current_render_generation_id + 派生 files + mutation 终态。不要提前修改缓存引用；写失败时内存和磁盘都保持旧 current。files 保留 ppt/sheet/read 等非代际 key，不能丢下载。ready orphan 留存且可恢复，失败不切换。
5. 专用原子写：临时文件与 job.json 同目录，独占创建、路径/祖先防护、文件 fsync；用 rename 原子替换。任何平台 rename 失败都保持旧文件，绝不 copyFile 覆盖兜底、绝不先 unlink 目标。无需实现/运行 PowerShell 或生产脚本。Windows 用实际 Node rename 成功路径、失败则明确错误；本地 mock 不能宣称 Windows 耐久性。所有已带 generation 指针的后续 saveMockup 也必须走专用路径，不让旧保存函数破坏保证。
6. 启动恢复：只扫描确有 generation/mutation 的单；恢复 orphan 索引不自动激活；进程中断的 mutation 明确终态或安全恢复，不能盲重跑在途 worker。使用现有 worker 身份合同，不能杀不明进程。两次恢复幂等；旧单无代际不得批量迁移。
7. 旧 retry/relight/补面路径不能 collectOutputs 后覆盖已托管 generation 的 files；此刀暂未迁移旧入口时，对不安全操作稳定拒绝且保留图片。普通无 generation 单行为保持不变。激活历史代不占 Blender 槽，但和最终提交共用 job 锁；按当前访问规则鉴权。
8. 私有身份/路径/mutation 执行信息不泄漏公共详情和列表；公开只需当前代与小型状态摘要。新增字段不得通过对象 spread 直接泄漏，测试覆盖。无路由创建不是权限验证豁免。

## 对应验证与停止条件

用小型合成文件和受控执行器验证：共享槽排队/释放；生成期间 fileOf 仍可读旧图；幂等/busy/stale/无权限；真实磁盘重读对抗缓存旧值；写失败时 disk/cache 一致；完成提交一次切换；worker 失败、输出非法、缺适配器都不切图；rename 后 pointer 前失败 orphan；启动恢复两轮；旧入口不覆盖 generation；非代际 key 保留；公开无路径；A.2 全回归。

独立跑 focused、server 全量、server typecheck、diff 检查；质量工具可用现有主工作树 Python（QUALITY_PYTHON），不安装包、不改基线。报告新出口未接线与真实缺陷，禁止以 mock 通过宣称生产接口已上线。

输出 STATUS、文件清单、逐条实现/未完成对应、实际命令计数/退出码、风险与下一接线门。未实现项明确标为未完成，不以计划替代。Codex 随后验收；本刀不进入 RF-04 或 ship。
