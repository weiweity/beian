# 章程（路径 A，2026-08-18 批准）

## 一句话

2026-08-31 前，让刘籽烨不靠 VPN、不靠人盯屏，自己完成一单真实 Excel↔PDF 终审。3D 已同仓并由打样台接线，但不纳入 8/31 业务验收。

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
- 设计：只借用客服 Demo 的内部工具纪律，不复制它的 Electron 产品壳或 Dashboard；当前 Shine Mage 狐狸 Logo 与全部视觉以根目录 `DESIGN.md` 锁定稿为准。
- 暴露：Cloudflare Named Tunnel。飞书网页应用（OAuth 已接）。不买云，不映射端口。

详见 `docs/adr-001-frontend-stack.md`。实现约束见 `docs/adr-004-ousterhout-design.md`（不改变已批准的路径 A 和 8/31 验收范围）。

## 不作为 8/31 验收门槛

这是一条验收边界，不等于其中能力都未实现：平面出图已改用 pymupdf、页内 GLB 查看与 OOXML PPT 已落地，但仍不作为刘籽烨 8/31 Excel↔PDF 终审的签收条件。

Illustrator 会话桥的代码实现不等于杭州实机验收；Illustrator/Blender L1/L2、GLB 旋转业务验收、10 分钟 SLA、Tunnel 掉线告警、SQLite、通用异步队列、飞书正式发版、ERP/BI/自动过审仍不作为刘籽烨 8/31 人终审门。Hono 和 Tunnel 可作为系统服务，Illustrator Agent 必须保持登录用户的交互任务，不能为了“开机自启”退回 Session 0。
