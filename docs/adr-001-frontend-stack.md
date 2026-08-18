# ADR-001 前端栈与设计来源

日期：2026-08-18  
状态：已接受（用户否决「沿用原生 JS」）  
覆盖：8/31 第一期网页，不含 3D 查看器

## 决策

1. **前端改为 TypeScript + React 18 + Vite + Ant Design 6。** 后端仍是 FastAPI，不改成 Node。组件 API 以 `@ant-design/cli` / `antd` skill 为准，不要凭记忆写 props。
2. **设计哲学对齐** `customer-agent-prototype/DESIGN.md` 里的**内部工具纪律**，不复制该仓的产品壳。视觉 token 用 Ant Design，产品结构仍是审稿台。
3. 现有 `apps/web/frontend/`（原生 JS + Geist + OpenSeadragon）作为对照实现，React 壳达到「刘籽烨能审一单」后删除或移入 `archive/`。

## 为什么换栈

- 你明确要求 TS + React，与客服 Demo 同一套工程习惯。
- 9 月接 3D（GLB 查看器）时，React 组件边界比 2700 行 `app.js` 更可控。
- 飞书登录态、任务列表、审稿台可以分组件测。

## 代价（必须写进日历）

- 审稿台（左图右表 + OpenSeadragon）要重接，不是换皮肤。
- 相对「只接飞书」，大约多 3–5 个工作日。8/31 仍只保证：登录 + 上传 Excel/PDF + 人终审。
- Windows 生产要多装 Node 20 LTS 做 `pnpm build`，或在 Mac 构建后只部署 `dist/`。

## 从客服 DESIGN.md 继承什么

| 继承 | 不继承 |
|---|---|
| React + TypeScript | Electron / 多窗口 / 狐狸头 |
| 本地中文字体栈，禁 Google Fonts | `--fox` 紫品牌、玻璃胶囊 |
| CSS 变量 SSOT；矩形半径 8px | Dashboard 9 模块、BI 图 |
| 状态不能只靠颜色，必须有字 | DEMO / MOCK 当主界面装饰 |
| 焦点环、40px 热区、reduced-motion | 输入法式浮窗几何 |
| 禁止把「复制/机审」写成「已发送/已过审」 | 客服话术、VOC、达肤妍 Demo 文案 |
| 浅色工作台 + 一个识别色，不铺渐变、不卡片墙 | 深色主题第一期可不做 |

备案识别色不要用客服紫。第一期用中性墨色 + 一个克制蓝（焦点/主按钮），风险用红/黄并配文字。

## 仓库形状（下一步脚手架）

```
apps/web/
  backend/           FastAPI 不动
  frontend/          旧静态页，过渡期保留
  ui/                新建：Vite + React + TS
    src/
      pages/         任务 / 新建 / 审核
      components/    审稿台、差异列表
      styles/tokens.css
```

开发：`ui` 走 Vite 代理到 `127.0.0.1:8787`。  
生产：`pnpm build` 的 `dist/` 由 FastAPI 当静态目录挂出去。飞书网页应用打开的仍是同一个 HTTPS 域名。

## 不做

- 不把客服 Demo 的 `src/renderer` 拷进 beian。
- 不把 beian 做成 Electron 桌面应用。
- 不在 8/31 做设计系统网站或 3D 查看器。
