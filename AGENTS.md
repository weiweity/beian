# AGENTS.md

请用中文回复。

## 规则适用与任务完成

- 本文件适用于本仓库；继承宿主加载的全局规则及父目录规则，子目录规则只约束对应目录。按宿主指令优先级处理冲突；用户本轮明确范围和仍有效的授权优先于本文件与 Skill 的默认流程。不能用 Skill 扩大授权或越过安全边界。
- 解释、检查、诊断、审查、PLAN ONLY：读取必要证据，给结论、依据、未确认项及建议即完成；不自动修复、改配置或发布。用户同时明确要求“检查并优化/修复”时，修改属于已授权范围。
- 实施任务：完成范围内的修改、适度验证并报告结果，不只给计划或因常规实现选择反复确认。已有授权继续有效；“继续”推进当前阶段，不自动进入提交、推送、PR、合并、生产操作或删除阶段。
- 仅在缺少会实质影响结果的信息，或下一步超出授权时询问。先完成可独立推进的已授权工作；需要批准时展示具体对象、变更和验证结果。信息可从允许的只读证据推导时先核实，不把可选流程、工具缺失或模板问题当作整项任务的阻塞。
- 提交、推送、PR、合并/部署分别检查已有授权，不凭修复请求推导发布授权；已明确授权的同一动作无需重复询问。PR 仍遵守下文 `/ship` 的明确触发要求。发送消息（包括测试消息）、发布飞书版本、购买云、DNS/公网端口变更、重要数据删除须有对应明确授权。产品按钮行为说明不是代理执行该动作的授权。
- 修改前查看相关文件的 Git 状态和差异，保留用户未提交工作；不覆盖、不顺手清理无关改动。发现并发改动时合并兼容内容，仅在同一内容无法兼容时询问。
- 下文目录是定位入口，工程合同只在涉及对应模块时适用，不是每次任务的检查清单。查代码遵守全局 CodeGraph 条件；只读规则文档不必先查代码图。只读必要文件，不全面扫描无关文件、凭据、会话记录或缓存。
- 默认由当前 agent 完成；只有用户或已选定 Skill 明确要求时才使用子 agent / 多模型流程。保留用户明确的外部模型路由，不因本文件调整而换模型；普通解释、文档修改和局部修复不自动进入完整评审流水线。
- 完成报告区分文档/静态检查、本地测试、发版 L1、质量门杭州实跑、真实稿 L2 和生产发布；未执行的验证写明，不用计划、合成数据或旧快照证明当前验收。范围外建议不妨碍已授权工作结案。

## 项目与安全边界

`beian` 是供应链备案审核网页：React UI + Hono/TypeScript 控制面，Python 对照计算，打样只调用 `workers/packaging`。产品/验收入口 `:8787`；开发 Vite `:5173` 反代 `/api`，不得增加第三个入口。旧 `apps/web/frontend` 与 Python HTTP 壳已删除，不新增 FastAPI/uvicorn。

- 不重写审核引擎和 3D 流水线，在迁入代码上改；打样台只调用 `workers/packaging`，缺 Blender 要写清失败。
- 不得提交 `.env`、`.env.baidu`、`.env.secrets`、`backend/data` 运行时文件、稿件、Vite 缓存、`.claude/`。
- 不得 `git add -A`。`docs/designs/hangzhou-production-cutover.md` 禁止进仓（已 gitignore）。推迟的 `docs/designs/login-and-permissions.md` 未 ignore，发版只按文件名 add。
- 不得读取或打印真实密钥。
- 密钥不要写进前端或仓库。
- 不得自行改 DNS、发布飞书版本、购买云、映射公网端口。
- 公网/Tunnel 后禁止显示名裸登录。
- Mac 绿灯不等于 Windows 已验收。杭州生产怎么升版见 [发布合同](docs/contracts/release.md)。合 `main` 后 runner 自动跑 `release.ps1`；Actions 红或公网 health 对不上 VERSION 时不要报已上线。
- 对照失败或已完成的单不能签字；干净签字单不能再对红；对红后优先读非空 `hits_v2`（空数组回退第一轮）。工艺说明 / 颜色要求 / 版本号 / 更新内容的 pending 不挡签字。
- 飞书授权失败回到飞书，不要把远程验收人送到本机 `:8787`。JSON 404 不是 Vite 挂了；只有 HTML 或空 Content-Type 才当开发页没转到 8787。

## 按任务加载合同

根文件只负责授权、路由与完成条件。先按下面的触发条件读取对应合同；它们继承本文件，涉及的约束必须执行，无关主题不整批加载。共享接口变更读取受影响两侧。只读文档不必先查代码图；定位代码仍按宿主的 CodeGraph 条件执行。

| 触及范围 | 必读入口 |
|---|---|
| 测试范围、命令、CI、证据复用 | [TESTING.md](TESTING.md) |
| 文档主源、当前进度与历史资料 | [文档治理索引](docs/README.md)；未完成事项只维护 [TODOS.md](TODOS.md) |
| 公共接口、模块边界、数据模型 | [架构合同](docs/contracts/architecture.md) |
| 对照/对红/打样入队、上传、等待、作业持久化 | [作业合同](docs/contracts/jobs.md) |
| 审稿引擎与核对页、签字、人工结论 | [审稿合同](docs/contracts/review.md) |
| 打样结构、候选、六面 GLB、Illustrator、Blender 宿主 | [结构与宿主合同](docs/contracts/packaging-structure.md) |
| 成片、下载、灯光、补图/重试、缓存头、页面/资产路由 | [成片与资产合同](docs/contracts/packaging-presentation.md) |
| 身份、权限、会话、设置、飞书推送、版本号 | [身份与设置合同](docs/contracts/identity-settings.md) |
| 用户可见布局、样式、文案、交互 | 先读 [DESIGN.md](DESIGN.md) 和 [界面约束](docs/contracts/interface.md)，再按模块读上述合同；无关后端或文档修改不触发 |
| 发布实现、发布诊断、合并/部署、杭州运行时 | [杭州发布合同](docs/contracts/release.md) 与 [Windows README](scripts/windows/README.md) |

代码入口：`apps/web/ui`、`apps/web/server`、`apps/web/backend`、`workers/packaging`。本机设置在 gitignored 的 `apps/web/backend/data/settings.json` 和 `settings.secrets.json`（`WB_DATA_DIR` 可覆盖）；不读取或打印真实密钥。

## 执行与验证

- 开始时明确当前阶段、改动范围和完成条件，检查目标文件 Git 状态；同轮已读且未变的规则、代码和证据可复用。
- 普通任务按风险验证：纯文档只做 diff/引用/一致性检查；局部代码运行受影响测试，跨模块扩大范围；具体命令、顺序和真实稿限制见 [TESTING.md](TESTING.md)。
- 明确 `/ship` 才进入发布准备；保留完整 L0、UI build、`test:quality`、`quality` 和所选 Skill 的必需独立评审。普通任务的按需验证不是发布豁免。
- 已通过的结果在相关代码、测试、配置、依赖和环境未变时可复用；新增修改或失败只使相关证据失效，影响不能界定则扩大验证。最终 PR HEAD 的 CI 仍须核对，不能用旧快照替代。
- 可用 `npm run verify -- <lane>` 记录验证回执，具体分组见 TESTING；它不自动跳过测试。
- 有共享文件或构建产物依赖的步骤按顺序运行；每条命令单独保留退出码。质量探针已隔离；其他步骤仍须确认共享状态后再并行。不要让后一个成功命令覆盖前一个失败结果。
- 完成报告写改动、验证、未执行项和当前阶段。Code、L0、发版 L1、质量门杭州实跑、真实稿 L2、UAT、生产发布分别举证；不以合成数据或日期证明验收通过。

## Skill routing

用户明确点名 Skill 时读取对应 `SKILL.md`，在已授权范围内执行。未点名时按实际任务目标选取相关 Skill，不因出现“检查”“架构”“缺陷”等词就启动完整流程。宿主无专用 Skill 工具时按其支持方式读取文件，不因工具名称不同停止。

- 审计 Skill 内容不等于执行 Skill：只读相关规则，不运行其前置脚本、遥测、升级、配置修改或自动提交。
- Skill 的升级、功能引导、路由安装、自动 checkpoint、记忆写入等附带流程不属于日常项目任务；未获对应授权则跳过，不为这些可选步骤打断任务。已有明确偏好保留，但配置开关本身不替代本次动作所需授权。
- `/investigate` 用于诊断时止于根因/证据/修复建议；明确要求修复才进入实施和回归验证。普通修改的测试范围以 [TESTING.md](TESTING.md) 为准；`/ship` 门禁不削减。
- Skill 要求询问时先判断该问题是否已被本轮范围或有效授权回答；确需询问才给出具体原因。必需工具不可用时说明受影响步骤并完成其余工作，不伪称完成必需评审；可选工具不可用不阻塞。


- 产品探索、需求澄清 → /office-hours；简短解释不自动启动访谈
- 架构方案评审 → /plan-eng-review；解释现有架构不自动进入方案审批
- 明确要求 CEO/设计/工程/DX 完整方案评审流水线 → /autoplan；普通文件审查不触发。选定后保留该 Skill 的外部模型路由和独立评审要求
- 缺陷根因调查或修复 → /investigate，按上文区分诊断与实施
- 发 PR → /ship（只在 Mac 开发机。杭州生产机禁止 /ship 产品功能。）没听到用户说 `/ship` 或「开始 ship」不要出 PR。用户说「先不进入 ship」就只改代码。
- 合 main → /land-and-deploy（只合 GitHub。不重启杭州、不改 DNS。）
- 杭州上线 → 合 `main` 后等 `hangzhou-release` 变绿，再等约 20 秒，公网 health 的 version 等于刚合进去的 VERSION。按 [发布合同](docs/contracts/release.md) 报告发布证据；仅当对应 merge SHA 的发布链、杭州来源及公网 health/version 均验证通过时，才可表述“该版本已上线”。这句话只覆盖发版 L1（进程、VERSION、Illustrator Session 1）。质量门杭州实跑（Blender 合同冒烟真跑、超时冻结、Job Object）、L2、UAT 只写在 [TODOS.md](TODOS.md)，不要用已上线去勾它们。不要给杭州贴 pull / rebuild / 重启 8787 或本地执行 `release.ps1` 的升级提示词。runner 灰掉先恢复同一 runner；在途作业挡住发版就等作业结束，然后只重跑刚才那条可信 `main` push run。
- 用户贴的 `www.jianghua.site` / 开工板截图是杭州当前 VERSION，不是你工作区未合的分支。没 land 绿之前不要拿公网画面证明「已经改好了」。
- 配置发布 → /setup-deploy
- 写 issue → /spec

## Deploy Configuration (configured by /setup-deploy)

合 `main` 会自动触发杭州发布，合并授权必须涵盖这一效果；状态查询不授权恢复 runner、重跑或操作生产。平台为杭州 Windows self-hosted runner + Named Tunnel，合并方式 squash，产品地址 `https://www.jianghua.site`。完整步骤和禁止事项按 [杭州发布合同](docs/contracts/release.md) 执行，不根据 Skill 的通用平台默认项部署或删分支。
