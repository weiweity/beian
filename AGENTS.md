# AGENTS.md

请用中文回复。

## 项目

`beian`：供应链备案审核网页 + 未接线的 3D Worker。第一期验收人刘籽烨，收尾 2026-08-31。

## 硬约束

- 不重写审核引擎和 3D 流水线，在迁入代码上改。
- 不重写 3D 流水线。打样台只调用 `workers/packaging`，缺 Blender 要写清失败。
- 不得提交 `.env`、`.env.baidu`、`.env.secrets`、`backend/data` 运行时文件、稿件。
- 不得读取或打印真实密钥。
- 不得自行改 DNS、发布飞书版本、购买云、映射公网端口。
- 公网/Tunnel 后禁止显示名裸登录。
- Mac 绿灯不等于 Windows 已验收。

## 目录

- 网页：`apps/web/ui`（React+TS）+ `apps/web/server`（Hono+TS，对外 :8787）
- 对照 worker：`apps/web/backend`（Python，由 TS `app.cli` 调用）
- 3D CLI：`workers/packaging/`
- 本机配置：右上角点姓名 →「设置」→ `data/settings.json` + `data/settings.secrets.json`（gitignore）。密钥不要写进前端或仓库。
- 章程：`docs/00-charter.md`
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
- 对照 worker：`cd apps/web/backend && .venv/bin/python -m pytest -q`
- 全量：仓库根目录 `npm test`
- 类型：`npm run typecheck -w beian-server` 与 `npm run build -w beian-ui`
- 新逻辑要有行为测试（含失败路径）。不要把密钥写进测试。
