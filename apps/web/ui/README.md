# beian UI（React + TypeScript + Ant Design 6）

审稿台（任务 / 新建 / 审核）、打样台、历史记录、设置（开工板 + 费用账单）。对照 / 对红 / 打样排队时用等待卡，不要假取消。离开后再进看板、打样台或历史记录，卡片、侧栏圆点和历史行仍显示阶段；点进行中的审稿进等待卡，打样进打样单。核对页有 bbox 才画真框，钉在框中心；「显示钉」和「显示框」分开，拖动画布时框暂时藏。核对窗液态玻璃浮在整页最上面（含侧栏），进页展开并叠在左侧栏上，收起/展开有动画，可拖，边框上下左右和斜角都能缩放；页头签字和画布放大/钉仍点得到，结论写在页头。打样台和打样单分开，点进度进打样单（一屏三图：正面+侧面、反面+侧面、GLB）。打样台和打样单主区白底深字；GLB 中性环境、曝光收一点。地址：`/` `/new` `/review/:id` `/mockup` `/mockup/:id` `/history` `/settings`，后退换台。没有自建登录页：未登录会跳飞书授权。

飞书身份、`/api/tasks`、`/api/settings`、`/api/mockups` 已接线。核对页包装图用 CSS transform 缩放（1–6×）并 rAF 拖动，不上 OpenSeadragon。

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
