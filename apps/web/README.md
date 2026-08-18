# 审稿室网页

对外 HTTP 是 `server/`（Hono + TypeScript，:8787）。  
对照引擎在 `backend/`（Python worker）。  
界面在 `ui/`（React + Ant Design 6）。  
`frontend/` 已退役。

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

浏览器：http://127.0.0.1:5173/ 或构建后 http://127.0.0.1:8787/

## 密钥

优先用顶栏「设置」。也可以：

```bash
cp backend/.env.baidu.example backend/.env.baidu
cp backend/.env.secrets.example backend/.env.secrets
chmod 600 backend/.env.baidu backend/.env.secrets
```

设置页写入 `backend/data/settings.json` 与 `settings.secrets.json`，覆盖 env 文件。不要提交。

## 结构

```text
ui/          React 审稿台 / 打样台 / 设置
server/      TypeScript HTTP
backend/     Python worker + 测试
frontend/    退役
```
