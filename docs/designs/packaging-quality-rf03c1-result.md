# RF-03C1 真实合同验证与隔离候选渲染底座交付记录

> 本文是 2026-09-05 C1 历史交付记录；历史测试数、未提交状态和停止点不替代第 06 批重新验证，也不限制后续已明确授权的发布。当前 CLI 已有文件/stdin 双入口和 64 KiB 读取预算；下文将请求读取预算列为待办的表述属于历史状态。进程超时/生命周期、Node/jobs 接线、真实质量门与 Windows/L2 仍未由本批证明。第 06 批范围与当前结果见 `packaging-quality-rf03c1-acceptance.md` 顶部。

STATUS: **RF-03C1 Python 本地合同切片通过；C1.2 由 Codex 接手收尾并独立复验（2026-09-05）。不代表 RF-03 或生产验收完成。**

## Codex 最终收尾

用户取消 Grok 委派后，Codex 保留已写入的跨单 ready 祖先保护，补直接/多层后代拒绝及正常单内/外部候选成功回归，并修正取消前遗留的测试夹具父目录缺失。候选沿词法/真实祖先检查 ready 标记，不再限定 source job，不遍历全数据根。拒绝前后源单、其它 ready 单的文件字节和完整目录名单保持不变。

最终相关 Python 回归 **193 passed**（31 generation + 65 pipeline + 97 render contract）；另跑 ready/nonce 子集 **9 passed**；服务端 **529 passed**，服务端 typecheck 退出 0。独立探针覆盖正常候选/nonce、坏 GLB、源单与跨单 ready 后代；内存恢复旧谓词时新回归确实失败。首轮 1 failed/192 passed 属于已修正的夹具失败，未当作通过证据。完整日志和边界见 `packaging-quality-rf03c1-acceptance.md`。

Grok 运行状态为 cancelled，不是完成交付；心跳保持暂停。未提交、推送、PR、合并或部署。下文 C1.1 测试表及实施前快照为历史证据，不替代本轮结果。

本刀只交 Python 候选底座与命令协议。已用真正通过 RF-02 验证的小型合成 resolved job / 六面资产，以及受控 subprocess（nonce 绑定）覆盖正反路径。**不宣称生产接线、真实 Blender、质量门或 RF-03 完成。** 尚未开放 HTTP/UI，未切换默认 F，未跑 Blender/Illustrator/真实任务。不提交、不推送、不 PR、不部署。测试 hook 不是生产能力。本记录不代替只读台账 `packaging-quality-rf03-acceptance.md`。

Codex 首轮独立探针 `/tmp/rf03c1-independent-probe.py`（只读，未改）复现：`INVALID_GLB_ACCEPTED True rendered 9`、`READY_DESCENDANT_PREPARED prepared`、`NONCE_EVIDENCE None`。C1.1 按原白名单返修这三项。只读复放该探针时，第一项现在在 `collect_output_evidence` 抛 `RenderGenerationError: 必需输出 glb 不是可解析 GLB`（退出 1），不再 `ok/rendered`；探针未改，因此不会继续打印后两项。后两项由本树回归分别覆盖。

Codex 声明的 `rf03c1_before_hashes` 文件在本机 `/tmp` 与工作树中未找到。实施前对白名单相关已有文件自行做了 SHA-256 快照，见文末。

## C1.1 三项返修

1. **ready 后代。** 候选不得是任何 ready 根或其任意后代。ready 根按磁盘 `generation.json` 标记发现，不只看 basename `g*` 或候选自身的 `generation.json`。创建前失败；ready 完整目录名单与字节不变。合法 `job/.render-generations/.candidate` 与独立 tmp 候选仍可通过。祖先 symlink 与大小写别名按 lineage/normcase/inode 拦截。
2. **GLB / PNG 结构。** 必需 GLB 与 PNG/card 复用 `glb_verify.load_glb_artifact` 与 `_decode_png_rgba` 做基本可解码 / header-length-chunk-JSON 检查，不复制深度几何或视觉质量门。坏 optional 含合法 magic 的截断 PNG 只进 warning，不列为好输出。合成成功 fixture 改为最小有效 GLB（JSON 对象 + BIN chunk），不再用 12 字节头。`quality.status=unwired`，`production_ready=false`。
3. **nonce。** 外层结果返回 `run_blender_job` 本轮验证成功后写入 `verified_nonce_holder` 的 snapshot nonce；不从 `blender_result.json` 或自报字段抄回。`run_blender_job` 默认仍不把 `execution_nonce` 写进返回 job（RF-02 负例保持）。

## 设计选择

拒绝在 TS 再实现 RF-02 校验并调用原位 relight（两套合同，且可能覆盖旧图）。选定 Python 深模块：可信根和已绑定请求进入，验证、准备、执行、证据在同一实现内，返回候选事实；不负责代际 ready/current 提交。

`run_blender_relight` 的提交段仍只给旧 blender-only 路径。候选走 `remap_job_outputs_to_candidate` + 既有 `run_blender_job`（私有快照 / nonce / 回传身份 / shadow overflow）。调灯只写进私有 snapshot 的 `light_energy_scale` / `world_strength`，磁盘候选 `render` 仍与 RF-02 spec 一致。`upgrade` 明确拒绝：另一套已锁定视觉语义尚未实现，不能硬编码 profile 字符串冒充转换。

## 实际文件

白名单内：

- 新增 `workers/packaging/render_generation.py`（深模块 + 单次 CLI）
- `workers/packaging/pipeline.py`：候选复用接口、`run_blender_job` 可选 `snapshot_studio_adjustment`（默认 `None`）与可选 `verified_nonce_holder`（默认 `None`，成功后填本轮 snapshot nonce，不写进 job）
- 新增 `apps/web/backend/tests/test_packaging_render_generation.py`
- `apps/web/backend/tests/test_packaging_pipeline_v2.py`：仅新增 nonce holder 回归，不改 RF-02 默认负例
- 新增 `docs/designs/packaging-quality-rf03c1-result.md`（本记录）

C1.1 未改：`render_contract.py`、`test_packaging_render_contract.py`、jobs.ts / mockup.ts / renderGenerations.ts、UI、renderer、profile registry、质量基线、依赖、VERSION、规划指令。独立探针 `/tmp/rf03c1-independent-probe.py` 只读未改。保留此前未提交工作。

## 命令协议

请求 schema：`packaging-render-generation-request/1`

字段白名单：`schema` `action` `job_root` `candidate_dir` `mode` `expected_source_sha256` `expected_asset_sha256` `studio_adjustment` `blender_executable`。禁止自报 `project_dir` / `assets` / `profile` / 输出路径。

| action | 需要 candidate_dir | 需要 blender_executable | 写盘 |
|---|---|---|---|
| `validate` | 否 | 否 | 只读 |
| `prepare` | 是 | 否 | 独占新建候选目录并写入候选 `resolved_job.json` |
| `render-candidate` | 是 | 是（普通文件，不能是 symlink） | prepare + 调用既有 `run_blender_job` |

mode：`preserve`（要求源已有完整 spec）、`legacy_relight`（允许已知 pre-RF02 V2 合成 compat-legacy-v0）、`upgrade`（`render_generation_unsupported`）。

CLI：`python workers/packaging/render_generation.py REQUEST.json`。stdout 最后一行稳定 JSON；stderr `STAGE validate|prepare|blender` 与 problem/cause/fix。不改 `app.cli`，不加第三端口。

源身份是磁盘 `resolved_job.json` 原始字节 SHA-256。候选计划身份是 RF-02 `fingerprint_token`。候选代际身份是 `packaging-render-generation-identity/1`（源计划身份 + mode + 调灯），三者不得互相冒充“已验证”。

## 七条合同

| # | 合同 | 结果 |
|---|---|---|
| 1 | 真实验证：RF-02 单一源验证 persistable plan 与资产/输出；区分源字节身份与派生候选 plan 身份；合法 spec、已知 pre-RF02 V2 合成、未知/缺失/冲突字段分别测；JSON.parse / 自报 SHA 不能证明通过；结构不降级猜测 | **已实现（合成 fixture）。** `render_plan_for_resolved_job` + `validate_job_asset_contract` / `validate_job_output_contract`；候选再走 `blender_execution_plan` 与 `persistable_plan_from_bound_job`。preserve 缺 spec 拒绝合成。 |
| 2 | 输入绑定：命令 schema/白名单/预算；可信根由调用者指定 job_root，不能从 payload 自报推导；磁盘路径、内存计划、期望 SHA 闭合；缺失/篡改启动前拒绝；只读合成 fixture | **已实现。** 自报 `project_dir` 不授权；越界资产拒绝。 |
| 3 | 独立候选：源只读；可写输出限定本次私有目录；不得重叠/指向 ready/覆盖既存/经 symlink/hardlink/case alias 越界；根入口兼容系统别名但不能因链接碰巧指向可信根获权；先验证再独占创建；异常不递归删源或其他候选 | **C1.2：源单与跨单 ready 根及其任意后代均在创建前拒绝（祖先标记 + 层级，不只 basename）。** Mac/POSIX 合成路径。Windows junction 未证明。 |
| 4 | 真实执行复用既有 `run_blender_job`；不用 relight 提交段；不复制 renderer；不能靠 fake subprocess 默认成功；缺 Blender 诚实失败；验证后到启动前身份变化 fail-closed | **已实现（受控子进程）。** 成功路径检查命令含 `render_job.py`、snapshot nonce、调灯到达 snapshot。缺 Blender 在独占创建前失败。 |
| 5 | 模式与调灯：复用 profile/合同；不能硬编码 profile 冒充转换；未知 mode 不静默默认；upgrade 明确拒绝；调灯纳入新合同身份；源合同不变 | **preserve / legacy_relight + 调灯已实现；upgrade 未实现（明确拒绝）。** 调灯 0.1–4.0，只乘 snapshot 灯光，不写 registry。 |
| 6 | 产物证据读磁盘；两张产品 full、card、GLB 必需；坏 optional 只 warning；质量 pending/unwired；不写 ready、不切 current | **C1.1：必需 GLB/PNG 走现有结构解析；截断 optional 不当好文件；外层返回本轮已验证 nonce。** 质量仍 `unwired` / `production_ready=false`，不是 runtime quality pass。 |
| 7 | 单次 CLI；validate/prepare/render-candidate；stdout 最后一行 JSON | **单次协议已实现。** 不等于完整运行时资源边界；请求文件读取预算及 Blender 子进程超时/生命周期仍须后续桥接补齐。 |

## 测试

当时本实现树无 `apps/web/backend/.venv`，按指令使用主工作树已有的 `apps/web/backend/.venv/bin/python`，从本实现树跑测试（导入本树源码）。未安装依赖，未改基线。

C1.1 隔离测试（未杀 Codex 独立 pytest 会话；`-p no:cacheprovider` 与独立 `--basetemp`）：

| 命令 | 退出码 | 计数 |
|---|---|---|
| `pytest -q tests/test_packaging_render_generation.py` | 0 | **26 pass / 0 fail**（本轮实测；含 ready 后代/大小写/symlink、GLB/PNG 结构、nonce 绑定） |
| `pytest -q tests/test_packaging_pipeline_v2.py tests/test_packaging_render_contract.py` | 0 | **162 pass / 0 fail**（65 + 97；含新增 `verified_nonce_holder` 回归，RF-02 nonce 负例仍绿） |
| 只读复放 `/tmp/rf03c1-independent-probe.py` | 1 | 第一项：`必需输出 glb 不是可解析 GLB`；探针未改，未打印 READY/NONCE 行 |
| `git diff --check`（C1.1 白名单） | 0 | 无行尾空白 |
| C1 当时 `cd apps/web/server && npm test` / `tsc` | （本返修未重跑） | C1.1 未改 TS/renderer/registry；**不能用旧 529 代替本轮验收** |

成功路径证明：源目录文件 hash 名单前后相等；新文件只在本轮候选（私有 blender snapshot 在 tempfile 中并于 `run_blender_job` finally 删除）。负例在启动前失败且源成片不变。不是“全部拒绝”冒充成功能力。

未跑真实 Blender、Illustrator、Windows、断电、真实稿、`DATA_DIR` 枚举。未开 HTTP/UI。

## 明确未完成（不是产品完成）

- **无 Node 异步桥。** C2 才接 jobs 适配器、PID 生命周期、验证凭证。不能用 `spawnSync` 阻塞 Hono 冒充 B 的同步验证 hook。生产入队仍 unavailable。
- **无真实 quality 门。** 结果固定 unwired/pending，不得写成 pass 或 production-ready。
- **`upgrade` 未实现。** 需要另一套已锁定视觉语义时明确 `render_generation_unsupported`。
- **未切默认 F，未跑真实 Blender。** CLI 的 render-candidate 在本刀只用受控子进程证明调用链。
- **Windows 路径/junction/大小写卷未证明。**
- **不写 ready index、不切 current。** 后续 TS 存储层负责。

## 风险与下一接线门

1. C2：异步 Node 桥调用本 CLI/模块，把候选目录交给已有 `sealGeneration`；禁止原位 `runPackagingBlenderOnly`。
2. 真实 RF-02 验证适配器应消费本模块的源字节 SHA + plan identity，不能再用测试夹具 schema 或自报哈希。
3. 调灯目前是 snapshot 乘法叠加，不改 registry/spec；若以后要把调灯写进 persistable spec，必须先有新的已锁定 profile，不能改已发布 ID。
4. 候选目录由调用者指定。产品路径应落在 job 隐藏代际目录下的 `.candidate-*`，不要指向 `gN-` ready。
5. 完整自动质量门、真实 Blender smoke 和 RF-04 页面另列。

本刀停在 RF-03C1 C1.2 本地合同验收通过。不进入 C2/RF-04 或 ship。**不宣称真实渲染、质量门或 RF-03 整体完成。** 后续先完成异步桥与运行时边界，再开展实际渲染和质量验收。

## 实施前文件快照（本机，替代未找到的 Codex 文件）

| 文件 | SHA-256（实施前） | C1 后 |
|---|---|---|
| `workers/packaging/pipeline.py` | `fe37d017f6c0ae47ef079a89268b40ceae86b08cc3bb10154f20f46fc84cad0f` | `fe7eddd56bb7f2336b75343a04f11a4d4c6b8d27bb9f10eb1b01f73cd63823f0`（仅候选复用接口） |
| `workers/packaging/render_contract.py` | `4b9cc52533f6f2fc0c83ecebb258bca420c6191075c67eef7047812c122bc5fe` | 相同 |
| `apps/web/backend/tests/test_packaging_pipeline_v2.py` | `26d573de6be9fed0de24b6e44934485ef0a1f6607f4616028aa3650befa90675` | 相同 |
| `apps/web/backend/tests/test_packaging_render_contract.py` | `030fd452b097d75d0ffda9ffaf67fe3bc5260b4afcb25e35c1706836d7f59c17` | 相同 |
| `apps/web/server/src/jobs.ts` | `69c602281a883f8d8cac5a59b253563d60533e39589c7e4eb411233f924d7151` | 相同 |
| `apps/web/server/src/mockup.ts` | `16ad76b065535b06388f3d808b3d333cd00a89cfdd64e899d213c5a892f0f049` | 相同 |
| `apps/web/server/src/renderGenerations.ts` | `4231a2e6583cadbaf0b63b2287f0b44702a3c9e3ac52f79362cf1071b2a14878` | 相同 |
