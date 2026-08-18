# AGENTS.md

请用中文回复。

## 项目

`beian`：供应链备案审核网页 + 未接线的 3D Worker。第一期验收人刘籽烨，收尾 2026-08-31。

## 硬约束

- 不重写审核引擎和 3D 流水线，在迁入代码上改。
- 不把 3D 做成 8/31 验收项，不给业务开放 3D 提交口。
- 不得提交 `.env`、`.env.baidu`、`.env.secrets`、`backend/data` 运行时文件、稿件。
- 不得读取或打印真实密钥。
- 不得自行改 DNS、发布飞书版本、购买云、映射公网端口。
- 公网/Tunnel 后禁止显示名裸登录。
- Mac 绿灯不等于 Windows 已验收。

## 目录

- 网页：`apps/web/`
- 3D CLI：`workers/packaging/`
- 章程：`docs/00-charter.md`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

- 产品想法 → /office-hours
- 架构 → /plan-eng-review
- 完整审查 → /autoplan
- 缺陷 → /investigate
- 发 PR → /ship
- 写 issue → /spec
