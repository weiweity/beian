# CLAUDE.md

请用中文回复。项目约定见 `AGENTS.md`。

文档入口：根目录 `README.md`（启动、设置、文档表）、`DESIGN.md`（视觉）、`docs/00-charter.md`（8/31 章程）、`docs/adr-004-ousterhout-design.md`（深模块约束）、`CHANGELOG.md`、`TODOS.md`。实现约定见 `AGENTS.md` 的「设计哲学」。

开发口 `:5173`（Vite 听本机网卡，`/api` 反代到 8787），验收入口 `:8787`。飞书授权失败留在飞书；JSON 404 不是 Vite 挂了。

## Design System

Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
