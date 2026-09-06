# RF-03C1：真实合同验证与隔离候选渲染底座

> 历史执行指令（2026-09-05），保留设计选择与合同来源，不触发新的 Grok 委派或心跳。第 06 批由 Codex 在独立发布分支集成；当前边界及本批验证以 `packaging-quality-rf03c1-acceptance.md` 顶部为准。下文测试计数和停止点是当时快照。

用户已授权下一步实施；Grok 编码，Codex 独立验收。RF-03B 在受控适配器范围已通过，不能等同生产接线。

## 当前范围与设计选择

继续当时的独立工作树、分支 `codex/3d-rfe02-lighting-evidence`，保留此前所有未提交工作。不自行 commit/push/PR/merge/deploy，不操作真实任务，不运行 Blender/Illustrator，不切默认 F，不开放 HTTP/UI，不安装依赖。

比较两个方案：TS 再实现 RF-02 校验并调用原位 relight，会产生两套合同且仍可能覆盖旧图，拒绝。选择 Python 复用 render_contract.py 与现有 run_blender_job，提供一次候选构建的深模块：可信根和已绑定请求进入，验证、准备、执行、证据在同一实现内，返回候选事实；不负责代际 ready/current 提交。

C1 只交 Python 底座与命令协议。C2 后续处理异步 Node 桥、PID 生命周期、验证凭证、runtime quality gate 与 jobs 适配器，不在本刀尝试用 spawnSync 阻塞 Hono 来满足 B 的同步验证 hook。生产仍 unavailable。完整自动质量门、真实 Blender smoke 和 RF-04 页面另列，不能造 pass 补空缺。

## 先读

完整 AGENTS.md；本文件；RF-03B 执行及验收记录；ADR-007 的 8、13、15、16 节；RF-02 render_contract.py 的 render_plan_for_resolved_job / blender_execution_plan / persistable_plan_from_bound_job，以及 pipeline.py 的 run_blender_job / run_blender_relight / 调灯合同调用路径。当前 CodeGraph 已实测无可用索引，直接针对性读，不重建。

## 白名单

- 新增 `workers/packaging/render_generation.py`：深模块及可直接调用的命令入口（不新增服务）。
- `workers/packaging/pipeline.py`：仅必要的候选执行复用接口，不能改既有默认路径/视觉参数。
- `workers/packaging/render_contract.py`：仅确有必要的受信候选转换公共函数，复用现有严格验证，不放宽历史合成/资产/输出保护。
- 新增 `apps/web/backend/tests/test_packaging_render_generation.py`。
- `apps/web/backend/tests/test_packaging_pipeline_v2.py`、`test_packaging_render_contract.py`：仅受影响行为回归。
- 新增 `docs/designs/packaging-quality-rf03c1-result.md`。

不改 jobs.ts/mockup.ts/renderGenerations.ts、UI、renderer 几何/材质/灯光实现、profile registry/history、RF-00/实验工具与基线、依赖锁文件、VERSION/CHANGELOG/AGENTS/TODOS、已验收文档或本执行指令。需要白名单外变更先报告，不自行扩范围。

## 必须交付

1. **真实验证**：调用 RF-02 单一源验证 persistable plan 和资产/输出合同；区分源 resolved job 字节身份与派生候选 plan 身份，不将二者共用一个冒充“已验证”的 SHA。合法 spec、已知 pre-RF02 V2 兼容合成、未知/缺失/冲突字段分别测试。单纯 JSON.parse、fixture schema、自回传 SHA 不能证明通过。结构输入不能降级猜测。
2. **输入绑定**：命令协议有明确 schema、字段白名单、类型/长度/数值预算；接收可信调用者指定 job root、候选目录及期望源字节/六面资产身份。可信根不能从 payload 自报 project_dir 或 assets 推导。磁盘实际 resolved 路径、内存计划和期望 SHA 必须闭合。缺失/篡改在启动前拒绝。这里只读合成 fixture；禁止枚举真实 DATA_DIR。
3. **独立候选**：源 root/ready 与其 job.json/resolved/result/日志/PNG/GLB/PPT/read assets 只读。所有可写输出、resolved job、Blender result、日志和 card 都限定到本次私有候选目录，候选不得与源重叠、指向 ready、覆盖既存候选或经 symlink/hardlink/case alias 越界。根入口规范化要兼容系统别名，但不能允许任意链接因指向可信根而获得授权。先验证，再独占创建；异常只处置本轮确有所有权的文件，不递归删除源或其它候选。
4. **真实执行复用**：提供 render-candidate 路径调用既有 run_blender_job，保留其磁盘校验、私有快照/nonce、回传身份校验和 shadow overflow 失败合同。不得直接使用 run_blender_relight 最后复制回原输出的提交段；不得复制 renderer，不能靠 fake subprocess 默认成功。测试 monkeypatch 子进程即可，本轮不运行真实 Blender。缺 Blender 诚实失败。候选已被验证后到进程启动前的源/资产身份变化仍应 fail-closed 或使用已绑定且可证明隔离的快照。
5. **模式与调灯**：复用现有 profile/合同解析与 studio 边界，明确 preserve/legacy_relight/upgrade 各自实际支持范围，不能硬编码 profile 字符串冒充转换；不能对未知 mode 静默默认。若升级需要另一个已锁定视觉语义，明确拒绝尚未实现的模式，交付可用的保留现有合同+允许调灯候选路径。调灯纳入新合同身份；源合同/文件保持不变，不写默认 registry。源计划与候选计划之间的确定性转换应能重验。
6. **产物证据**：结果包含源身份、候选身份、实际输出映射/hash、执行 nonce/状态及必要失败语义；不能信执行器报路径/hash而不读磁盘。两张产品 full、card、GLB 按现有必需输出校验；optional ground/set 可记录 warning，不把坏 optional 交付为好文件。深度质量门没实现则明确 pending/unwired，不能返回 production-ready 或冒充 runtime quality pass。不得写 ready index 或切 job current；只有后续 TS 存储层负责。
7. **CLI 合同**：有界单次命令，明确 validate/prepare/render-candidate 的实际支持动作；stdout 最后一行稳定 JSON，stderr 阶段/问题可诊断，不输出密钥或大资产内容。不改 app.cli、不加第三端口。可用模块入口/现有 packaging 调用约定，避免再造 HTTP。

## 验证与停止

用真正通过 RF-02 验证的小型合成 resolved job/六面资产构造正例，受控 subprocess 写 nonce 绑定的测试结果；错误字节身份/合同字段/asset identity/源路径、候选重叠和祖先链接在启动前失败；缺 Blender、非零退出、旧结果 nonce、结果路径/hash 冲突、缺必需输出/坏 optional 均不改源。正常路径须证明源目录所有文件 hash 与名单前后相等，新文件仅在本轮候选和既有私有执行快照中；不能用“全部拒绝”冒充成功能力。

重点证明成功可走真实 run_blender_job 调用链（子进程受控），而不是另造只在测试成功的实现。CLI 用合成文件运行 validate/prepare，真实 Blender 渲染留待 C1 验收后单列。

运行新增与受影响 packaging pytest、server 529 项原回归/typecheck、git diff --check。可显式用主工作树已有 `apps/web/backend/.venv/bin/python`，从本实现树运行测试，确保导入的是本树源码；没有依赖则报告，不安装。结果列文件、命令/计数/退出码、协议、未实现与下一门。完成停在 C1，Codex 独立复验后再推进。
