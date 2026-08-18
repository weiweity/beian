# 备案审核工作台 · M2.1 / v0.8（TVT-lite）

**设计：** Vercel / Linear 风 · 确认单原文 ↔ 包装定位 · 人终审  
**Excel↔PDF：** Text Verification 轻量版 `tvt-lite-1.15`（文字层优先 · 整段框 · 序列 diff · 反向）  
**双页文案对比（独立验收）：** 单双页 PDF 或两文件 · 栏左→右 · 真字差/真未对上 · 多 OCR 交叉 · 报告写「双页文案对比」  
**跨规格双 PDF：** 百度文档比对 + 可选像素图形 diff  
**登录 / 角色 / 审计 / 飞书 / MiniMax 复核：** 已接  

## 启动

**推荐一键：**

```bash
# 双击 start.command，或：
../../scripts/dev-start.sh
# 或本目录 start.command（请在仓库 apps/web 下执行）
# 端口占用时：WB_KILL_PORT=1 start.command
# 换端口：WB_PORT=8790 start.command
```

手动：

```bash
cd backend
source .venv/bin/activate
export PYTHONPATH="."
uvicorn app.main:app --host 127.0.0.1 --port 8787
```

浏览器：**http://127.0.0.1:8787/**

## 密钥（勿提交）

| 文件 | 说明 |
|------|------|
| `backend/.env.baidu` | 百度 OCR / 文档比对（参考 `.env.baidu.example`） |
| `backend/.env.secrets` | MiniMax / 飞书 / 权限开关（参考 `.env.secrets.example`） |

```bash
cp backend/.env.baidu.example backend/.env.baidu
cp backend/.env.secrets.example backend/.env.secrets
chmod 600 backend/.env.baidu backend/.env.secrets
```

## 角色权限

登记文件：`backend/data/users.json`（首次启动自动生成）

| 显示名示例 | role | 能力 |
|------------|------|------|
| 管理员 | admin | 全部 + **备份** |
| 审核员 / 魏炜 | reviewer | 建任务、决策、终审、导出、归档、AI |
| 只读 / 访客 | viewer | 仅查看 + 导出 HTML/PDF |

- 登录框输入**显示名**即可（与 `users.json` 匹配则带角色）  
- `AUTH_REQUIRE_KNOWN=true` 时仅允许登记名登录  
- 任务带 `owner` 归属；列表支持 `?mine=1`  

## 已实现

| 能力 | 状态 |
|------|------|
| 预置样本 / 任意上传 | ✅ |
| 百度 accurate 定位高亮 | ✅ |
| TVT-lite：文字层+OCR、成分分步、整段框、字符 diff、反向 | ✅ `tvt-lite-1.1` |
| 百度文档比对 + 无坐标 UX + 降噪 | ✅ |
| 字段对齐（单位/别名/软字段/条码卡） | ✅ |
| 宣称规则骨架 / A·B 像素 diff | ✅ 轻量 |
| 跨规格白名单 | ✅ |
| **双页文案对比**（独立、不依赖 Excel） | ✅ `pdf_internal` · 多 OCR 交叉 |
| 检测报告 → Word | ✅ |
| OpenSeadragon 双图 + navigator + 邻页预加载 | ✅ |
| 角色权限 / 任务归属 | ✅ |
| 任务 JSON 备份（启动 + API） | ✅ |
| HTML / **PDF** 报告 + **飞书归档** | ✅ |
| MiniMax AI 复核 | ✅ |
| 法务合规专模块 | ⏳ 后续 |

## 使用

1. 登录显示名（如「审核员」或「管理员」）  
2. **新建** / **样本库** 建任务  
3. 左图 OpenSeadragon：缩放、同步、全屏、右下角缩略图  
4. 右侧字段：有坐标 → 点即放大；**无坐标** → 看文字 + 百度比对/SDK  
5. 导出 **HTML / PDF**；**飞书归档** 推送链接  
6. admin：**侧栏「备份任务」** 或 `POST /api/ops/backup`  

## 运维

- 备份目录：`backend/data/backups/wb-backup-*.tar.gz`  
- 日志：`backend/data/logs/uvicorn.log`（经 start.command）  
- 启动时自动轻量备份任务 JSON（不含 uploads）  

## 结构

```text
workbench/
  start.command          一键启动
  backend/app/           FastAPI
  backend/data/tasks/    任务 JSON
  backend/data/backups/  备份
  backend/data/users.json
  frontend/              静态 UI + OSD
```
