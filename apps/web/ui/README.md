# beian UI（React + TypeScript + Ant Design 6）

审稿台（任务 / 新建 / 审核）、打样台、历史记录、设置（开工板 + 费用账单）。对照 / 对红 / 打样排队时用等待卡，不要假取消。没有自建登录页：未登录会跳飞书授权。

飞书身份、`/api/tasks`、`/api/settings`、`/api/mockups` 已接线。包装图放大仍待接 OpenSeadragon。

```bash
cd apps/web/ui
npm install
npm run dev
```

浏览器：http://127.0.0.1:5173/（Vite 听本机网卡，端口占用即失败）  
`/api` 代理到 TypeScript 服务 `127.0.0.1:8787`（`apps/web/server`，不是 FastAPI）。5173 登录闪或 `/api` 返回 HTML / 空 Content-Type：打开 http://127.0.0.1:8787/。飞书授权失败再走飞书，不要把远程验收人指到本机。JSON 404 不是代理挂了。

组件查询（本机已装）：

```bash
antd info Button --lang zh --format json
antd demo Upload drag --format json
```
