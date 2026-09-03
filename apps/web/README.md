# 审稿室网页

对外 HTTP 是 `server/`（Hono + TypeScript，:8787）。  
对照引擎在 `backend/`（Python worker）。  
界面在 `ui/`（React + Ant Design 6）。  
旧 `frontend/` 已删除；网页入口只有 `ui/` + Hono `server/`。

## 启动

仓库根目录：

```bash
./scripts/dev-start.sh
```

或本目录 `start.command`（同样走 TypeScript 入口）。

开发时另开 UI：

```bash
cd ui && npm run dev
```

浏览器：开发用 http://127.0.0.1:5173/（Vite 听本机网卡，`/api` 反代到 8787），验收用构建后的 http://127.0.0.1:8787/。JSON 404 不是 Vite 挂了；`/api` 返回 HTML 或空 Content-Type 才是。

## 密钥

管理员优先点侧栏「设置」；审核员只能查看状态和运行允许的探测。也可以：

```bash
cp backend/.env.baidu.example backend/.env.baidu
cp backend/.env.secrets.example backend/.env.secrets
chmod 600 backend/.env.baidu backend/.env.secrets
```

设置页写入 `backend/data/settings.json` 与 `settings.secrets.json`，覆盖 env 文件。不要提交。

## 结构

```text
ui/          React 审稿台 / 打样台 / 历史 / 设置（WaitCard；核对页初始无恒等 transform，非初始状态才用 CSS transform 1–6× + rAF 拖动，不上 OpenSeadragon；核对窗 portal 到应用顶层，可盖侧栏/页头/签字/画布并拖到视口底边，窗内弹层更高；收起有动画，边框八向缩放；桌面待选正面一屏包含预览/选项/错误/主动作，选层只给 admin；打样台只交稿，点进度进打样单：有地面图时正面成片大约 480px 的 5:6 主图，预览和下载同一合成器，页头藏 PPT、灯光收到「调灯」；没有地面图时仍一屏三图看形、浅底+内描边、页头「下载 PPT」。下面印刷面读字；透明产品层套白底，产品/背景灯光分开调；打样中和失败可重试；每张图右上角下载；不下 PDF；点下载底部提示不挡操作；GLB 全屏居中；打样台/打样单主区白底深字，GLB 中性环境；地址 `/reviewup` `/reviewup/new` `/review/:id` `/mockup` `/mockup/new` `/mockup/:id` `/history` `/settings`；离开后看板/侧栏/历史记录仍显示阶段）
server/      TypeScript HTTP（jobs.ts 管对照/对红/打样入队；`/brand/*` 挂 `ui/public`）
backend/     Python worker + 测试（cli 不写任务 JSON）
```
