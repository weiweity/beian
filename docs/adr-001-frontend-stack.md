# ADR-001 前端栈与设计来源

日期：2026-08-18  
状态：已接受（用户否决「沿用原生 JS」）。HTTP 产品层见 `docs/adr-002-typescript-http.md`；本机设置见 `docs/adr-003-settings-overlay.md`。视觉 token 以根目录 `DESIGN.md` 为准。  
覆盖：8/31 第一期网页，不含 3D 查看器

> 2026-08-26 修订：本 ADR 继续约束 React + TypeScript 的栈选择；其中 OpenSeadragon、中性蓝和下方“继承/不继承”表仅记录决策当时的迁移估算与来源比较，不再约束当前视觉。现行审稿缩放采用 CSS `transform` 1–6×，品牌色为 `#805898`，Logo、玻璃材质、圆角、看板与深色主题等全部 UI 合同以 `DESIGN.md` 为准。

## 决策

1. **前端改为 TypeScript + React 18 + Vite + Ant Design 6。** 本 ADR 决策时后端仍是 FastAPI；之后已按 ADR-002 改为 Hono 产品层。组件 API 以仓库内已审核的 `antd` skill 为准，只能从仓库根目录经 `node scripts/quality/antd-readonly.mjs` 查询，不要凭记忆写 props，也不要直接运行 CLI。
2. **设计哲学对齐** `customer-agent-prototype/DESIGN.md` 里的**内部工具纪律**，不复制该仓的产品壳。视觉 token 用 Ant Design，产品结构仍是审稿台。
3. 原 `apps/web/frontend/`（原生 JS + Geist + OpenSeadragon）曾作为对照实现；React 入口稳定后已直接删除，未保留 archive 副本。

## 为什么换栈

- 你明确要求 TS + React，与客服 Demo 同一套工程习惯。
- 9 月接 3D（GLB 查看器）时，React 组件边界比 2700 行 `app.js` 更可控。
- 飞书登录态、任务列表、审稿台可以分组件测。

## 代价（必须写进日历）

- 审稿台当时按“左图右表 + OpenSeadragon”估算为重接而非换皮；最终实现选择了接口更小的 CSS `transform` 缩放，不再引入 OpenSeadragon。
- 相对「只接飞书」，大约多 3–5 个工作日。8/31 仍只保证：登录 + 上传 Excel/PDF + 人终审。
- Windows 生产要多装 Node 20 LTS 做 `npm run build`，或在 Mac 构建后只部署 `dist/`。

## 决策当时的来源比较（历史）

下表只解释当时为何选 React，不是当前产品的视觉合同；其中品牌、狐狸 Logo、玻璃材质、圆角、看板和主题均已被 `DESIGN.md` 的锁定稿取代。

| 继承 | 不继承 |
|---|---|
| React + TypeScript | Electron / 多窗口 / 狐狸头 |
| 本地中文字体栈，禁 Google Fonts | `--fox` 紫品牌、玻璃胶囊 |
| CSS 变量 SSOT；矩形半径 8px | Dashboard 9 模块、BI 图 |
| 状态不能只靠颜色，必须有字 | DEMO / MOCK 当主界面装饰 |
| 焦点环、40px 热区、reduced-motion | 输入法式浮窗几何 |
| 禁止把「复制/机审」写成「已发送/已过审」 | 客服话术、VOC、达肤妍 Demo 文案 |
| 浅色工作台 + 一个识别色，不铺渐变、不卡片墙 | 深色主题第一期可不做 |

本 ADR 当时设想中性墨色 + 克制蓝；该视觉设想已由锁定稿取代。现行识别色是品牌紫 `#805898`，风险仍用红/黄并配文字，完整 token 只认 `DESIGN.md`。

## 仓库形状（下一步脚手架）

```
apps/web/
  backend/           Python 对照 worker（`python -m app.cli`）
  server/            Hono 产品 HTTP :8787
  ui/                新建：Vite + React + TS
    src/
      pages/         任务 / 新建 / 审核
      components/    审稿台、差异列表
      styles/tokens.css
```

开发：`ui` 走 Vite 代理到 `127.0.0.1:8787`。  
生产：`npm run build` 的 `dist/` 由 Hono 当静态目录挂出去。飞书网页应用打开的仍是同一个 HTTPS 域名。

## 不做

- 不把客服 Demo 的 `src/renderer` 拷进 beian。
- 不把 beian 做成 Electron 桌面应用。
- 不在 8/31 做设计系统网站或 3D 查看器。
