# 测试与验证

本文件是测试范围、命令、顺序和证据口径的主源；根 AGENTS 只保留入口，架构原因见 [ADR-006](docs/adr-006-continuous-complexity-governance.md)。路径和命令均以仓库根为起点，明确写了 `cd` 的除外。文档不自动安装依赖或授权真实数据、外部调用及生产动作。

## 按风险选择

按变更风险选择验证，不把下列命令全部当作每次任务的必跑清单：

- 解释/只读诊断：核实必要证据即可；需要复现时先确认不会触发未授权的外部调用或数据写入。
- 纯文档/规则调整：检查 diff、引用和规则一致性，运行 `git diff --check`；不启动产品、不运行业务全量测试。
- 局部代码修改：覆盖受影响行为及失败路径，运行相关测试；类型/构建变化检查对应 workspace，交互变化选择相关 E2E。已有有效覆盖可复用，不为实现细节机械补测试。
- 跨模块合同、公共基础设施或无法可靠界定影响范围的修改：扩大到相关完整测试集；全项目影响或 `/ship` 时运行完整 L0。验证通过且代码未再改时不重复运行；新增修改、失败或未解决风险才补验。
- `/ship` 保留完整 L0、UI build、`test:quality` 和 `quality` 门禁；普通任务按需验证不构成发布豁免。环境缺失时报告未验证项及影响，不擅自安装生产依赖或拿合成结果代替真实验收。

三层。`npm test` 只等于 L0。不要在杭州跑单测。不要单测打外网、OCR、Blender、Illustrator COM。

- L0 单测（Mac，`/ship` 必绿）：仓库根目录 `npm test`。复杂度工具链独立运行，不把 Knip 的 Node 版本要求泄漏到产品 `Node >=20` 合同；`/ship` 还必须在 Node 20.19+ 或 22.12+ 下执行 `npm run test:quality` 和 `npm run quality`。
  - 服务端：`npm run test -w beian-server`（`node:test`，`apps/web/server/src/*.test.ts`）
  - 界面：`npm run test -w beian-ui`（`node:test`，`src/**/*.test.ts` 自动发现；纯函数，不引入 RTL）
  - 对照 worker：`cd apps/web/backend && .venv/bin/python -m pytest -q`（CLI 契约 + 对照/打样单测。没有 FastAPI 测试）
- 发版 L1（杭州 `hangzhou-release`）：`release.ps1` 在 transaction fence 内查 health.ok、version==VERSION、8787 listener、logo PNG，并通过生产 Session 1 Agent 验证管道 → VBS → 唯一 JSX 的身份链。不跑 `npm test`，也不替代真实稿 L2。这是 AGENTS「该版本已上线」的证据层。
- 质量门杭州实跑：RF-11 `blender-contract-smoke.ps1` → `blender_contract_smoke.py`，输出仅 `RUNNER_TEMP`。`0.21.46.0` hangzhou-release `34191398011`（SHA `3fcfea75`）真跑 `WINDOWS_BLENDER_CONTRACT_SMOKE ok`，墙钟约 62s；发版 `TimeoutMs` 为 90000。wrapper 用 Job Object：`PROC_THREAD_ATTRIBUTE_JOB_LIST` + `CREATE_SUSPENDED`，`KILL_ON_JOB_CLOSE` 杀树。未解析到 Blender 时跳过、不回滚；跳过不算质量门杭州实跑完成。超时杀树分支该次未走到。不能用 Mac 合成代替。RF-10 三层分类与冒烟合同测试随默认 worker/server L0（`test_packaging_render_quality_layers.py`、`test_packaging_blender_contract_smoke.py`、`windows-release-script.test.ts`），不启动 Blender。词义见 [TODOS.md](TODOS.md) 状态口径。
- L2 金标（人核定后）：`apps/web/backend/scripts/run_eval.py`。未核定的 `data/gold` 不进默认 `npm test`
- 类型：`npm run typecheck -w beian-server` 与 `npm run build -w beian-ui`
- 浏览器交互（Mac）：`npm run test:e2e`（Vite + 合成 API，只验证页面行为，不替代真实 Hono / 发版 L1）。Q05 `mockup-preview-upgrade.spec.ts` 默认自建临时目录并构建；显式 `BEIAN_Q05_DIST=<dir>` 只读复用已由 `buildQ05ArtifactInto` 盖章的产物，身份不匹配失败关闭、不回退构建、不删除该目录。这是测量隔离，不是正式性能预算。
- 复杂度门禁（Mac / GitHub-hosted PR）：`npm run quality`；基线只读、只能经评审缩小，新增发现、过期条目或相对 base 扩张都失败。本地自动解析 `origin/HEAD`（再回退 `origin/main` / `main`），找不到目标分支就失败关闭；CI 使用 PR base 精确 SHA。同文件同名诊断按重数比较，行号移动不改变身份，但新增第二处不能被折叠。`npm run quality:deep` 只生成手工清理报告，不自动删除。`npm run test:quality` 还要求 `.agents/skills` 实际目录、审核清单与 `skills-lock.json` 完全一致；项目 skill 不自动授予 shell。`antd` 是仓库 vendored 源，只能经 `scripts/quality/antd-readonly.mjs` 调固定 6.6.1；禁止用上游 restore/update 覆盖本地 hardening，恢复走受信任 Git 提交并重验哈希。
- `.github/workflows/quality.yml` 的 Linux Node 22 质量 job 与 `windows-2022` PowerShell 5.1 合同 job 都使用 GitHub-hosted runner；禁止使用杭州/self-hosted runner。Windows job 实跑 `.NET File.Replace` 无备份原子替换，并验证 Illustrator Agent 计划任务的隐藏窗口、持久/临时触发器和 `Quiesce` 顺序；它不注册或控制生产任务，不调用 `release.ps1`，也不替代发版 L1。Knip 只锁在 `tools/quality`，Vulture 只放 `requirements-quality.txt`，两者不得进入杭州生产依赖图。
- 新增或修改产品逻辑要有相应行为测试（含失败路径）；纯文档、格式和不改行为的调整不机械新增测试。不要把密钥写进测试。

## 执行顺序与环境边界

1. 先确认已有依赖。质量工具单独位于 `tools/quality` 和 worker `requirements-quality.txt`；首次安装属于工具维护，缺依赖时说明范围，不把它写入产品依赖。
2. 根 `npm run typecheck` 包含 server 类型检查和 UI build；读取 UI 构建产物的服务端 SPA 测试必须在构建之后。不要再重复单独跑相同 UI build。
3. 孤儿检测合同在私有临时工作区使用同一份 Knip 配置，探针不写入产品工作区；可与只读质量扫描并行。其他测试仍按共享文件/环境决定是否并行。
4. 当前 CI 顺序是安装 → test:quality → quality（比较 base）→ typecheck/UI build → 完整 L0；Windows hosted 合同是独立 job，不能冒充发版 L1。
5. 普通单测不可调用真实 OCR、Blender、Illustrator COM 或外网；真实稿数据和原生环境必须显式选择，不因目录或软件存在而获得授权。

### 显式选择真实稿或原生应用

默认 `npm test` / worker `pytest` 会 deselect 标为 `real_artwork` 或 `native` 的测试；目录存在、软件已安装和 `-m` 筛选都不会自动启用。一个用例同时有两种标记时需要两个开关。五个真实稿测试（四个刀线、一个转曲 PDF）已经使用该规则。

在已核定的真实稿测试环境，明确选择对应测试：

```bash
cd apps/web/backend
.venv/bin/python -m pytest --run-real-artwork -m real_artwork
```

显式选择后样张缺失会失败并说明条件，不能以 skip 冒充验收。原生应用测试使用 `@pytest.mark.native` 和 `--run-native`，仍需符合设备与授权条件；这不是安装或启动原生软件的指令。未标记的未来测试不会自动分类，新增用例必须标记其真实数据/原生应用边界。仓库默认 L0 继续包括普通合成合同和接线测试。

## 有效证据与重跑

每次验证记录：目标 base/head 或源码快照、命令、退出码、环境、耗时、结果位置、skip/deselect 及原因。源码、测试、配置、锁文件或环境变化会使相关证据失效；只改文档可复用不受影响的业务结果。无法界定影响时扩大测试。可使用下列统一入口记录命令与源码指纹；它不自动跳过测试，也不代替依赖/运行时变化审查。

并行耗时不能相加作为总墙钟；记录各阶段以及关键等待。只要需要重跑就先说明失效原因。测试计数不等于覆盖率；合成文件校验不等于原生软件或真实 L2。

## 质量工具维护与 Skill 合同

首次配置质量工具的现有命令是 `npm ci --prefix tools/quality` 和 `apps/web/backend/.venv/bin/python -m pip install -r apps/web/backend/requirements-quality.txt`，仅在对应维护范围获准后执行。已安装则复用，日常验证不重复安装。

`npm run test:quality` 同时校验 `.agents/skills` 实际目录、审核清单与 `skills-lock.json` 完全一致；空锁、额外 skill、远程来源、符号链接、自动 shell 权限或绕过包装器的命令都会失败。仓库内 `antd` skill 是 vendored 权威源，不能用标准 skill restore/update 从上游覆盖；需要恢复时从受信任的 Git 提交还原并重新核验哈希。知识查询只走 `node scripts/quality/antd-readonly.mjs`：它固定已审核的 `@ant-design/cli@6.6.1`、关闭更新检查、不经 shell、只读仓库内路径，并拒绝 setup、升级、外部提交和可写迁移参数。CLI 缺失或版本不符时失败关闭，由独立、显式批准的工具维护任务处理。


## 统一验证入口（Mac/Linux）

```bash
npm run verify -- docs
npm run verify -- python
npm run verify -- quality
# 跨域修改或明确进入 ship 时：
npm run verify -- full
```

| lane | 实际执行 |
|---|---|
| `docs` | `git diff --check`；链接和规则语义仍由本次审阅核对 |
| `python` | worker pytest 完整普通集合，输出最慢 20 项；默认不启用真实稿/原生标记 |
| `server` | UI build → server 全集，保证 SPA 构建产物先存在 |
| `ui` | UI build（含类型）→ UI 全集；交互 E2E 仍按需另跑 |
| `quality` | `test:quality` → `quality`，保留基线与 Skill 合同 |
| `full` | `test:quality` → `quality` → typecheck/UI build → 完整 L0；不重复构建 |

可加第二个参数指定仓库外的证据父目录。默认在系统临时目录创建独占子目录，写 `receipt.json` 和每一步日志。每个命令单独记录退出码，遇失败立即停止，防止后续成功掩盖前序失败；单步默认 30 分钟上限，超时/中断只终止该步创建的合成测试进程组，不用于原生应用或生产。

回执包含起止时间、命令与工作目录、Node/Python 版本、Git HEAD、代码/测试/配置/锁文件内容指纹、独立文档指纹、是否在执行期间变化。运行时数据、真实稿目录与 `.env*` 不读取；不复制环境变量或密钥。调用时固定合成测试的 `PYTEST_ADDOPTS=--durations=20`，不继承真实稿 opt-in。

回执只证明记录的本地运行，**不是自动缓存命中或发布豁免**。代码指纹变化时该次验证失败；普通文档变化单列，需人工检查是否影响该命令。已安装依赖、系统状态、忽略的构建产物或外部工具变化仍须核对；不要只凭哈希复用。最终 PR HEAD CI、发版 L1、质量门杭州实跑、真实 L2/UAT 保留各自证据。临时日志可能被系统清理，交付时保留必要摘要和对应 CI 链接。

### 补印刷面回归（R01）

局部后端回归：`node_modules/.bin/tsx --test apps/web/server/src/jobs-print-faces.test.ts apps/web/server/src/mockup-http.test.ts apps/web/server/src/jobs-generations.test.ts apps/web/server/src/workers.test.ts`。这些测试使用独立临时数据与合成 worker，覆盖202确认、同单幂等、跨单排队、drain、恢复围栏、旧图保留及进程记账失败；不调用 Blender/Illustrator/OCR。

先完成 UI build 后，可运行 `PLAYWRIGHT_ARTIFACT_ONLY=1 npm run test:e2e -w beian-ui -- e2e/mockup-board.spec.ts --grep '印刷面|补面'`。此模式从现有 dist 读取构建产物并拦截全部页面/API请求，不另起监听端口，适合5173已被用户进程占用时验证；构建过期时必须先重建。通过只证明合成浏览器行为，不替代 Hono/杭州真实任务。

### 本地运维工具切片（F02 / R04）

- [告警判断与 fixture 回放](scripts/monitoring/README.md)：`node --test scripts/monitoring/*.test.mjs scripts/monitoring/probes/*.test.mjs scripts/monitoring/delivery/*.test.mjs scripts/monitoring/runner/*.test.mjs`。包含探测适配器、投递模块与串联合成回归；不访问生产或发送通知。
- [资源采证工具](scripts/resource-stress/README.md)：`python3 scripts/resource-stress/test_harness.py -v`。只启动自建轻量合成子进程，覆盖采样、失败/取消与清理；不启动 Blender/浏览器压测，不构成独占预算或 Windows Job Object 证明。
- 两组当前为显式局部测试命令，不在根 `npm test` 默认集合中；修改对应工具或发版包含对应目录时必须单独执行。
