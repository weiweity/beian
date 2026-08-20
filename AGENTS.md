# AGENTS.md

请用中文回复。

## 项目

`beian`：供应链备案审核网页。打样台调用 `workers/packaging`（缺 Blender 要失败写清）。第一期验收人刘籽烨，收尾 2026-08-31。

## 硬约束

- 不重写审核引擎和 3D 流水线，在迁入代码上改。
- 不重写 3D 流水线。打样台只调用 `workers/packaging`，缺 Blender 要写清失败。
- 不得提交 `.env`、`.env.baidu`、`.env.secrets`、`backend/data` 运行时文件、稿件、Vite 缓存、`.claude/`。
- 不得读取或打印真实密钥。
- 不得自行改 DNS、发布飞书版本、购买云、映射公网端口。
- 公网/Tunnel 后禁止显示名裸登录。
- Mac 绿灯不等于 Windows 已验收。
- 对照失败或已完成的单不能签字；干净签字单不能再对红；对红后优先读非空 `hits_v2`（空数组回退第一轮）。
- 飞书授权失败回到飞书，不要把远程验收人送到本机 `:8787`。JSON 404 不是 Vite 挂了；只有 HTML 或空 Content-Type 才当开发页没转到 8787。

## 目录

- 网页：`apps/web/ui`（React+TS）+ `apps/web/server`（Hono+TS，对外 :8787）
- 对照 worker：`apps/web/backend`（Python，由 TS `app.cli` 调用）
- 3D CLI：`workers/packaging/`
- 本机配置：右上角点姓名 →「设置」→ 默认 `apps/web/backend/data/settings.json` + `settings.secrets.json`（gitignore；`WB_DATA_DIR` 可改）。密钥不要写进前端或仓库。
- 文档入口：`README.md`（启动、设置）、`DESIGN.md`（视觉）、`docs/00-charter.md`（8/31 章程）、`docs/adr-004-ousterhout-design.md`（深模块）、`CHANGELOG.md`、`TODOS.md`。实现约定见下面「设计哲学」。
- 入口：开发口 `:5173`（Vite 听本机网卡，`/api` 反代到 8787）；产品/验收入口 `:8787`。不要再加第三个 HTTP 入口。
- 旧 `apps/web/frontend/` 已退役，不要再往里面加功能。

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

- 产品想法 → /office-hours
- 架构 → /plan-eng-review
- 完整审查 → /autoplan
- 缺陷 → /investigate
- 发 PR → /ship
- 写 issue → /spec

## Design System

改任何界面之前先读 `DESIGN.md`。字体、色、间距、顶栏、审稿构图都以那份为准。

- Ant Design 6 只当零件箱。`colorPrimary` = `#722ED1`，不要默认蓝。
- 顶栏切「审稿台 / 打样台」（字 + 底线，不要紫胶囊）。设置收在姓名菜单里。不要 220px 品牌侧栏。
- 左上角放完整 `apps/web/ui/public/brand/shine-mage.png`（狐狸头 + SHINE MAGE），不要裁成只留头，不要旁标「江华」。
- 审稿：左图画布 + 编号钉，右批注列，结论由人写。禁止「AI 已过审」。
- 打样台 8/31 不对业务开放。QA 时标出任何与 `DESIGN.md` 不符的实现。

## Testing

- 服务端：`npm run test -w beian-server`（`node:test`，`apps/web/server/src/*.test.ts`）
- 界面：`npm run test -w beian-ui`（`node:test`，现覆盖 `apps/web/ui/src/authGate.test.ts`）
- 对照 worker：`cd apps/web/backend && .venv/bin/python -m pytest -q`
- 全量：仓库根目录 `npm test`（server + ui + pytest）
- 类型：`npm run typecheck -w beian-server` 与 `npm run build -w beian-ui`
- 新逻辑要有行为测试（含失败路径）。不要把密钥写进测试。

## 设计哲学

来源：John Ousterhout《软件设计的哲学》第 2 版，经 Codex 顾问蒸馏（`docs/adr-004-ousterhout-design.md`）。管复杂性，不是把文件切碎。

- 以 2026-08-31 刘籽烨独立完成 Excel↔PDF 人工终审为当前首要目标；不为 ERP、BI、自动审批或 3D 业务开放扩展设计。
- 优先做深模块：对外接口少而稳定，把进程、路径、超时、供应商差异和失败处理藏在实现内。
- 遇到只转发参数、迫使调用者理解内部步骤的浅模块，先尝试加深现有模块，不要继续叠包装层。
- 把 `apps/web/server` 作为唯一 HTTP 产品边界和 `:8787` 唯一验收入口。
- 把 `apps/web/backend` 视为 worker；TS 只能通过 `python -m app.cli` 调用，不得新增 Python HTTP 路由或以 uvicorn 启动产品。
- 不得在 `:5173`、`:8787` 之外增加第三个开发、验收或生产入口；必须写清每个现存入口的用途。
- 新登录、身份、会话和计费能力只放在 `apps/web/server` 的 Hono 层，不得复制到 Python。
- 保持不同层有不同抽象：UI 表达审核动作，Hono 表达产品用例，Python 表达对照命令，`workers/packaging` 表达 3D 作业。
- 把复杂度向下拉：调用者不应知道 Python 模块结构、Blender 命令、飞书 OAuth 步骤或供应商账单分页。
- 会一起变化且共享隐藏知识的代码放在一起；仅因文件较长，不得机械拆分。
- 不得「一页签一个 package」或「一动作一个 5 行函数」；按稳定接口和信息隐藏划分模块。
- 新增参数前先判断能否在模块内部推导默认值，避免把特殊情况和供应商细节泄漏给调用者。
- 能通过接口定义消除错误就不要增加错误分支；不能消除时，返回可执行、面向用户的失败原因。
- `workers/packaging` 缺 Blender 时必须明确失败，不得静默降级、伪造成功或另建 3D 流水线。
- 每个非琐碎改动先比较至少两个设计，记录为什么选择接口更小、泄漏更少的方案；预留约 10%–20% 时间做设计。
- 注释写约束、原因和失败语义，不复述代码；名称必须体现产品边界，如 worker、snapshot、human decision。
- 沿用已有术语、路径和错误格式；发现 `frontend/`、FastAPI、Hono 三套说法并存时，不得再发明第四套。
- 人工终审不可抽象成机器过审；账单 `charge_status` 必须保持 `unknown`，除非已有可核验的供应商扣费事实。
