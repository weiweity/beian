# beian UI（React + TypeScript + Ant Design 6）

审稿台（任务 / 新建 / 审核）、打样台、设置（开工板 + 费用账单）。没有自建登录页：未登录会跳飞书授权。

飞书身份、`/api/tasks`、`/api/settings`、`/api/mockups` 已接线。包装图放大仍待接 OpenSeadragon。

```bash
cd apps/web/ui
npm install
npm run dev
```

浏览器：http://127.0.0.1:5173/  
`/api` 代理到 TypeScript 服务 `127.0.0.1:8787`（`apps/web/server`，不是 FastAPI）。

组件查询（本机已装）：

```bash
antd info Button --lang zh --format json
antd demo Upload drag --format json
```
