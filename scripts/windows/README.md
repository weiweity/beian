# Windows 备忘（8/31 不承诺开机自启）

第一期只要这台机器能跑：

- Node 20 LTS（对外入口是 `apps/web/server`，不是 Python HTTP）
- Python 3.12
- 仓库根目录 `npm install`；`npm run build -w beian-ui` 后才能打开 `http://127.0.0.1:8787/`
- 启动：Git Bash 跑 `./scripts/dev-start.sh`，或 `npm run start -w beian-server`
- `pip install -r apps/web/backend/requirements.txt`
- `cloudflared` Named Tunnel → `http://127.0.0.1:8787`
- 电源计划：不睡眠（运维项，不当本期验收）

打样台需要本机 Blender 可执行文件路径，在网页「设置」里填。不要只写 `blender`。

对外入口是 TypeScript（`apps/web/server`），不是 `uvicorn`。密钥和路径优先点侧栏「设置」里填。

生产数据必须设环境变量，不要放在 git 工作树里：

```
set WB_DATA_DIR=C:\supply\data
set WB_PUBLIC=1
set WB_DEV_DISPLAY_LOGIN=false
```

代码读取 `WB_DATA_DIR`。公网模式（`WB_PUBLIC=1`）若仍指向仓库内 `backend\data`，进程会拒绝启动。

## 升到本版之前

看板没有「对照中」再 pull / 重启。对照跑着时不要直接切版本。

## 上线后手工冒烟

1. 对照跑着时重启 Node：孤儿 Python 被杀掉，作业重新入队或变成「对照中断」。
2. 已有任务 JSON 可以被替换（Windows 上目标文件已存在时 replace 成功）。
3. 超时之后，任务管理器里没有第二条 python / blender。
4. 打开首页，侧栏狐狸标和导航图标应显示。`http://127.0.0.1:8787/brand/logo-mark.png` 应是 PNG，不是 404（v0.12.0.1 修了 Windows 把 `/brand` 目录多拼一层；图在 `apps/web/ui/public/brand`，不要另拷一份）。
