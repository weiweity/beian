# ADR-004：以深模块和信息隐藏约束 8/31 交付

日期：2026-08-19

来源：John Ousterhout《软件设计的哲学》第 2 版，经 Codex 顾问蒸馏。Grok 按顾问 PATCH_LIST 写入，未改运行时。

## 状态

已决定。

## 决定

在不改变既定技术架构的前提下，以「减少变更放大、认知负担和未知依赖」为新增代码与评审标准。

1. `apps/web/server` 是唯一 HTTP 产品层和 `:8787` 对外入口。
2. `apps/web/backend` 只作为本地 Python worker，由 `apps/web/server/src/workers.ts` 通过 `python -m app.cli` 调用。
3. `workers/packaging` 只通过 `apps/web/server/src/mockup.ts` 接入；缺 Blender 必须明确失败。
4. 飞书身份、会话、设置和计费的新行为只在 Hono 层实现。
5. UI 只表达用户操作和结果，不理解 OAuth、供应商账单、Python 模块或 Blender 命令。
6. 优先加深现有模块，不按页面、按钮或短函数机械增加 package 和包装层。
7. 非琐碎设计至少比较两个接口方案，选择调用者所需知识更少的方案。

## 为什么

当前交付只有 2–3 名上海供应链用户，8/31 的关键结果是刘籽烨能独立完成一单真实 Excel↔PDF 人工终审。最大风险不是缺少扩展框架，而是同一能力曾在 TS、Python、旧前端和多个入口间重复，导致修改需要同步多处，且无法判断哪一层生效。

因此，新增设计必须减少：

- 变更放大：修改登录或计费时只改一个产品边界。
- 认知负担：UI 和 Hono 调用者不需要理解 worker 内部。
- 未知依赖：入口、身份来源、人工结论和失败状态都有唯一归属。

## 本仓库中的深模块

### `apps/web/server/src/workers.ts`

对 Hono 暴露 `compareTask`、`reworkTask`、`runPackaging` 等产品动作，并隐藏 Python 路径、环境变量、子进程、超时、退出码和 stderr。后续应保持接口窄，不把对照内部函数暴露给 TS。

### `apps/web/backend/app/cli.py`

它应是 Python worker 的唯一外部接口：接收受控命令和文件路径，输出机器可读结果，以非零退出码和明确 stderr 表达失败。调用者不应知道 `fields.py`、OCR 或任务文件如何组合。

### Hono 身份边界

`apps/web/server/src/auth.ts` 与 `index.ts` 应隐藏飞书 OAuth、白名单、会话 cookie 和角色解析。UI 只需要「当前身份、可用登录方式、退出」。

### `apps/web/server/src/billing.ts`

向设置页提供供应商快照和本地台账，隐藏分页、缓存与供应商差异。没有真实扣费证据时，`charge_status` 统一为 `unknown`，不让调用者推断。

## 已收口的浅模块与仍需避免的泄漏

- `apps/web/backend/app/cli.py` 只依赖 `compare_core.py`。FastAPI `app.main`、Python 会话/OAuth 和遗留 HTTP 测试已删除。身份只在 Hono `auth.ts`。
- `apps/web/ui/src/api.ts` 已删除未使用的 `loginDisplay`，本机显示名登录只保留服务端 loopback 入口。
- `apps/web/server/src/auth.ts` 的 `requestLooksLikeFeishu` 未接入真实策略，名称表达了比实现更强的安全承诺。
- `apps/web/frontend/` 已删除，网页入口只有 `apps/web/ui` + Hono `apps/web/server`。
- `:5173` 与 `:8787` 两个开发入口若没有明确用途，会把代理失败误判为产品故障。现网：UI 只在 HTML/空 Content-Type 时提示去 `:8787`；飞书授权失败留在飞书；JSON 404 不当成 Vite 挂了。
- 按审稿台、打样台或设置页各建一套服务/package，会制造浅层转发和重复身份逻辑。

这些是后续治理对象，不授权本次重写。

## 分层规则

- `apps/web/ui`：用户意图、展示状态、人工审核交互。
- `apps/web/server`：HTTP、认证授权、产品流程、设置、计费快照、worker 编排。
- `apps/web/backend`：Excel↔PDF 对照与既有 OCR/字段规则。
- `workers/packaging`：既有 3D 作业及 Blender 依赖。

相邻层只能通过上一层提供的稳定接口交互。上层不得读取下层内部数据结构来拼装业务结果。

## 错误与特殊情况

- 能由模块内部选择路径、默认值或供应商适配时，不向调用者增加参数。
- worker 超时、文件无效、OCR 失败和缺 Blender 必须成为明确失败状态。
- 不允许把失败改写为成功、空结果或「AI 已过审」。
- 人工结论由用户填写；系统不得代替最终审核人。
- 只有待审状态可审核结论或签字；已有第二轮页的单不得再对红；已签字仅当结论为待设计改稿才可对红。对红后优先使用非空 `hits_v2`，空数组回退第一轮。
- 计费无法核实扣费时统一返回 `unknown`，不增加猜测状态。

## 2026-08-31 前

- 冻结 Hono、CLI、packaging 三条边界。
- 写清 `:5173` 仅用于 UI 开发，`:8787` 才是验收入口。
- 新登录和计费只进入 Hono。
- 对新增行为覆盖成功与失败路径。
- FastAPI HTTP 壳、Python 重复登录和旧前端都已删除。对照只走 `compare_core` + CLI。
- 验证 Windows 环境；Mac 通过不代表验收完成。

## 2026-08-31 后

另行设计并审批后，才可考虑：

- 删除未接入的策略函数。
- 统一开发入口与启动说明。
- 根据真实变化模式决定是否继续拆分 `index.ts`，不得只按行数拆分。

## 不做

- 不重写 `fields.py`、OCR、对照引擎或 Blender 流水线。
- 不把 Python worker 改写成 TypeScript。
- 不启动 uvicorn 作为产品入口。
- 不引入 qiankun、微前端、异步队列、SQLite、ERP 或 BI。
- 不按页面建立 package，不追求短函数指标。
- 不自动审批，不生成「AI 已过审」结论。
- 不增加 npm 包、服务端口或第三套登录实现。

## 后果

新增代码的接口数量会受到约束，局部实现可以适度变长，只要它隐藏了复杂度且仍可测试。短期保留部分已知债务，以避免 8/31 前扩大改动面；这些债务必须保持冻结，不能继续复制。

## 后续评审问句

- 这个 PR 是否增加了新的入口、端口、HTTP 层或身份事实源？
- 调用者是否开始知道 Python 内部函数、Blender 命令、OAuth 步骤或供应商分页？
- 新模块是否隐藏了足够复杂度，还是只做参数转发的浅包装？
- 是否因页面、按钮或函数长度而机械拆 package，增加跨文件跳转和共同修改？
- 登录或计费行为是否只落在 `apps/web/server`，并删除了新增重复实现？
- worker 和缺 Blender 的失败是否明确、可测试，且没有静默降级？
- 改动是否直接服务刘籽烨 8/31 人工终审，还是偷偷扩成 ERP、BI、自动审批或 3D 开放？
