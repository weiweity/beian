# beian UI（React + TypeScript + Ant Design 6）

审稿台（任务 / 新建 / 审核）、打样台、历史记录、设置（开工板 + 费用账单）。对照 / 对红 / 打样排队时用等待卡，不要假取消。离开后再进看板、打样台或历史记录，卡片、侧栏圆点和历史行仍显示阶段；点进行中的审稿进等待卡，打样进打样单。核对页有 bbox 才画真框，钉在框中心；「显示钉」和「显示框」分开，拖动画布时框暂时藏。初始 1× 页图不施加恒等 transform，避免高清 SVG 首屏被提前栅格化。核对窗液态玻璃 portal 到应用顶层，高于侧栏、页头、签字和画布；进页展开并叠在左侧栏上，可拖到视口任何位置，不挤页图。展开/收起按各自可见尺寸碰撞，收起后仍可拖到底边；边框上下左右和斜角都能缩放，窗内下拉弹层再高一层。疑点列表置顶；当前字段先 16px 嘱咐再结论下拉，Excel 应印与稿上读到两列。结论写在页头。打样台和打样单分开，点进度进打样单（一屏三图看形，下面印刷面读字）。桌面待确认结构把预览、选项、错误和主动作收在一屏。打样台和打样单主区白底深字；每张图右上角下载；页头「下载 PPT」（没写成仍显示，点了出「PPT 没写成，白底仍可下」），不提供 PDF 下载入口；点下载底部提示不挡操作；GLB 全屏居中；截图时下载钮藏起来；全屏被拒出「全屏打不开」；GLB 中性环境。地址：`/reviewup` `/reviewup/new` `/review/:id` `/mockup` `/mockup/new` `/mockup/:id` `/history` `/settings`，后退换台。旧 `/` `/new` `/review` 转到新地址。没有自建登录页：未登录会跳飞书授权。

飞书身份、`/api/tasks`、`/api/settings`、`/api/mockups` 已接线。核对页包装图用 CSS transform 缩放（1–6×）并 rAF 拖动，不上 OpenSeadragon；只有非初始缩放/平移才输出 transform，`will-change` 只在实际平移时短暂启用。打样单读字区同样走 `canvasZoom.ts` 1–6×；白底静帧不拿来读字。

```bash
cd apps/web/ui
npm install
npm run dev
```

浏览器：http://127.0.0.1:5173/（Vite 听本机网卡，端口占用即失败）  
`/api` 代理到 TypeScript 服务 `127.0.0.1:8787`（`apps/web/server`，不是 FastAPI）。5173 登录闪或 `/api` 返回 HTML / 空 Content-Type：打开 http://127.0.0.1:8787/。飞书授权失败再走飞书，不要把远程验收人指到本机。JSON 404 不是代理挂了。

组件查询只从仓库根目录走已审核的只读包装器；不要直接运行 `antd` CLI：

```bash
node scripts/quality/antd-readonly.mjs info Button --lang zh --format json
node scripts/quality/antd-readonly.mjs demo Upload drag --format json
```
