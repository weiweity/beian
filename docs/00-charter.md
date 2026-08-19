# 章程（路径 A，2026-08-18 批准）

## 一句话

2026-08-31 前，让刘籽烨不靠 VPN、不靠人盯屏，自己完成一单真实 Excel↔PDF 终审。3D 进仓不接线。

## 前提

1. 验收人：刘籽烨。模块：远程 Excel+PDF 人终审。
2. 3D 同仓，不算 8/31 验收。
3. 本目录为唯一 Git 根。迁入 workbench 与 packaging_pipeline，不第三套引擎。
4. 公网后：飞书身份 + 白名单。显示名作废。
5. Mac 开发，杭州 Windows 生产。
6. 私有 GitHub；密钥和稿件不进仓。

## 选型

- HTTP 产品层：TypeScript + Hono（`apps/web/server`），挂 React 静态资源。
- 对照引擎 / 3D 流水线：Python worker（`apps/web/backend`、`workers/packaging`），不重写规则。
- 设计：对齐客服 Demo 的内部工具纪律（见根目录 `DESIGN.md`），不搬 Electron / 狐狸 / Dashboard。
- 暴露：Cloudflare Named Tunnel。飞书网页应用（OAuth 已接）。不买云，不映射端口。

详见 `docs/adr-001-frontend-stack.md`。实现约束见 `docs/adr-004-ousterhout-design.md`（不改变已批准的路径 A 和 8/31 验收范围）。

## 不做（8/31）

Illustrator COM、qlmanage 替换、GLB 旋转验收、10 分钟 SLA、Windows 开机自启、SQLite、异步队列、PPT 重写、飞书正式发版、ERP/BI/自动过审。
