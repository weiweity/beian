# ADR-006：持续复杂度治理与 TypeScript/Python 边界

日期：2026-08-29

## 状态

已决定。质量门禁先于存量删除落地；后续清理必须独立 PR，并让基线单调缩小。

## 背景

仓库同时包含 React/TypeScript 产品层、Python 对照计算和 Blender/Illustrator 宿主脚本。仅靠一次人工盘点无法阻止死代码重新增长；直接把 Python 全量重写为 TypeScript，又会重建 PyMuPDF、openpyxl、Shapely 与 Blender `bpy` 已经提供的能力，并不能消除 Illustrator/Blender 的运行时边界。

需要一套持续回答以下问题的机制：

1. 新 PR 是否引入了新的未使用文件、导出、依赖或 Python 定义；
2. 已删除的存量是否及时从基线移除；
3. 动态 CLI、Vite、测试、Illustrator 与 Blender 入口是否被准确建模；
4. 质量检查是否与杭州生产 runner 完全隔离。

## 决定

### 1. 保留 TypeScript 控制面 + Python 计算内核

- React + Hono/TypeScript 继续持有唯一 HTTP 产品边界、身份、上传、队列、任务状态、错误翻译和运行编排。
- Python 保留 OCR、PDF、表格、几何和 Blender 计算，通过既有 `python -m app.cli`、stderr `STAGE`、stdout 最后一行 JSON 合同调用。
- 不新增 Python HTTP、端口或第二套任务持久化。
- 只有单个模块能证明迁移后减少依赖/进程边界，并通过金标行为等价测试时，才单独讨论迁移；不建立“全量 Python 改写”任务。

### 2. 一个只读质量编排器

`scripts/quality/check-complexity.mjs` 是唯一入口，负责：

- 调用 Knip/Vulture 并统一结果；TypeScript 编译器门禁继续由 `npm run typecheck` 承担；
- 限时、限制输出并统一失败语义；
- 将工具输出归一化为稳定 finding；
- 比较当前基线和目标分支基线；本地默认解析 `origin/HEAD`（再回退 `origin/main` / `main`），无法找到时失败关闭，CI 仍传入 PR base 的精确 SHA；
- 输出人类可读或 JSON 报告。

编排器没有写基线路径。`config/quality/dead-code-baseline.json` 只能由经过评审的代码变更修改。

### 3. 两速扫描

- `npm run quality`：PR 硬门。Knip 使用完整仓库引用图，让测试入口可证明测试钩子的存在；Playwright 支撑代码、仓库脚本和宿主 JSX 都在项目范围内，真正的动态入口逐个列名，禁止用目录通配符把孤儿文件伪装成入口；Vulture 只收 80% 及以上置信度。当前条目以 `config/quality/dead-code-baseline.json` 和本次扫描结果为准，不在本 ADR 维护易漂移计数；操作顺序与验证边界见 [TESTING.md](../TESTING.md)。
- `npm run quality:deep`：人工 report-only。Knip 增加 production 视角，Vulture 降到 60% 置信度，用于专门 cleanup PR 取证；不参与日常基线，不自动删除。

直接把 production 视角作为 PR 基线会把大量仅供测试验证的稳定导出误判为死代码，因此不采用。深审仍保留该视角，但与快速门禁分开。

### 4. 单调基线

门禁状态如下：

```text
actual == baseline       -> PASS
actual - baseline != []  -> FAIL_NEW_FINDING
baseline - actual != []  -> FAIL_STALE_BASELINE
PR baseline - base != [] -> FAIL_BASELINE_GROWTH
tool/error/timeout       -> FAIL_TOOLING
```

finding 身份由工具、类型、仓库相对路径和符号组成；行号只用于展示，避免代码移动制造无意义基线变更。同一身份在同一文件出现多次时按重数比较，新增第二处同名诊断仍会失败，不能被第一处折叠。扫描器精确版本也写入基线，升级工具时必须重新人工复核。

### 5. 依赖与 CI 隔离

- Knip 精确锁在独立的 `tools/quality/package-lock.json`；该目录不是 npm workspace，不进入根 `package.json` / `package-lock.json`，因此不会改变杭州 release dependency fingerprint。
- Vulture 精确锁在 `apps/web/backend/requirements-quality.txt`，不得进入生产 `requirements.txt`。
- 项目 skill 采用正向许可：`.agents/skills` 的实际一级目录、`skills-lock.json` 和质量脚本内审核清单必须完全相等，空锁、额外目录、额外锁项、符号链接或未知 skill 都失败。`antd` skill 是仓库内 vendored 权威源，锁项必须是 `sourceType: "local"` 且指向自身受 Git 管理的目录；上游仓库和标准 skill restore/update 不是本地 hardening 的恢复源，恢复只能来自受信任的 Git 提交并重新核验内容哈希。
- skill 不获得自动 shell 权限。所有可执行示例必须经过 `scripts/quality/antd-readonly.mjs`；包装器不用 shell，固定 `@ant-design/cli@6.6.1`，强制 `CI=1`、`NO_UPDATE_CHECK=1`，只允许审核过的只读子命令和仓库内路径，并拒绝 setup、升级、外部提交及可写迁移参数。CLI 缺失或版本不符时失败关闭，不得由普通设计任务修改开发机工具链。
- `.github/workflows/quality.yml` 把职责拆成两个 GitHub-hosted job：`windows-2022` 在原生 Windows PowerShell 5.1 下实跑 `.NET File.Replace` 的无备份原子替换合同，并以不注册、不启动、不停止、不禁用生产任务的合同脚本验证 Illustrator Agent 的隐藏任务、持久/临时触发器与 `Quiesce` 顺序；Linux Node 22 job 分别安装产品依赖与 `tools/quality`，再运行 `npm run test:quality`、`npm run quality`、完整 `npm test` 和严格 `npm run typecheck`/UI build。质量工具链要求 Node 20.19+ 或 22.12+，不并入产品 `Node >=20` 的 L0 合同。
- npm 的跨平台 optional-dependency 缺口会让 macOS 生成的根 lock 漏掉 Rollup Linux 原生包（[npm/cli#4828](https://github.com/npm/cli/issues/4828)）。CI 只在缺包时从已安装 Rollup 读取精确版本，以 `--no-save --package-lock=false` 补齐 Linux 包；不修改产品 manifest/lock，不把质量 CI 需求带入杭州依赖图。
- 质量 workflow 不使用杭州/self-hosted runner，不调用 `release.ps1`，不持有生产环境或密钥。
- `.github/workflows/hangzhou-release.yml` 保持只接收可信 `main` push，不因质量治理改变。

### 6. 删除需要四类证据

非显然代码删除必须同时核对：

1. 静态引用：Knip/Vulture/CodeGraph/文本引用没有有效调用路径；
2. 行为测试：相关成功和失败语义仍被 L0 覆盖；
3. 运行入口：CLI、动态 import、workspace scripts、Vite、测试发现、Illustrator/Blender 宿主入口均已检查；
4. 生产边界：不改变 `:8787`、杭州 Session 1 Agent 或发布交易栅栏。

证据不足时先补测试或保留代码，不把“扫描器说没用”直接等同于可删除。

## 后果

- 新死代码和基线扩张会在 PR 阶段失败；修掉存量后不删除基线条目也会失败。
- 初始基线明确暴露现有债务，但不会要求在治理 PR 中同时大删业务代码。
- server 打开 `noUnusedLocals` / `noUnusedParameters`；UI 已有同等门禁。
- 深度扫描更慢、候选更多，按需人工执行，不新增 cron、服务或看板。
- 存量 cleanup PR 可以逐批删除并收缩基线，失败时独立回滚，不与治理基础设施耦合。

## 依据

- [Knip 配置](https://knip.dev/reference/configuration) 与 [project files 指南](https://knip.dev/guides/configuring-project-files)：入口和项目边界必须显式配置，避免靠大范围 ignore 掩盖假阳性。
- [Knip production mode](https://knip.dev/features/production-mode)：生产视角适合深度审计，但测试与非生产入口需要单独处理。
- [Vulture 官方仓库](https://github.com/jendrikseipp/vulture)：置信度阈值与 whitelist 适合保守处理 Python 动态调用。
- [Node.js child_process](https://nodejs.org/api/child_process.html)：现有 TypeScript→Python CLI 是标准进程隔离边界。
- [Blender Python API](https://docs.blender.org/api/main/info_tips_and_tricks.html)：`bpy` 属于 Blender 宿主能力，语言改写不能消除该运行时。
- [DeepSeek Harness packages](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md)：借鉴显式 service/provider/consumer 边界、模块关系和 CI 新鲜度检查；不以提交数量作为设计目标。
