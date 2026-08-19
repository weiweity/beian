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

对外入口是 TypeScript（`apps/web/server`），不是 `uvicorn`。密钥和路径优先点右上角姓名 →「设置」里填。

生产数据必须设环境变量，不要放在 git 工作树里：

```
set WB_DATA_DIR=C:\supply\data
set WB_PUBLIC=1
set WB_DEV_DISPLAY_LOGIN=false
```

代码读取 `WB_DATA_DIR`。公网模式（`WB_PUBLIC=1`）若仍指向仓库内 `backend\data`，进程会拒绝启动。
