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

生产数据必须设环境变量，不要放在 git 工作树里。PowerShell：

```
$env:WB_DATA_DIR="C:\supply\data"
$env:WB_PUBLIC="1"
$env:WB_DEV_DISPLAY_LOGIN="false"
```

cmd.exe 才用 `set WB_DATA_DIR=...`。PowerShell 里写 `set` 不会进子进程。

代码读取 `WB_DATA_DIR`。公网模式（`WB_PUBLIC=1`）若仍指向仓库内 `backend\data`，进程会拒绝启动。

Clash 开系统代理时，备案域名和 `127.0.0.1` 必须直连。self-hosted runner 若走 `127.0.0.1:7897` 会被拒绝（`Runner connect error`），设 DIRECT 或关掉 Clash 再听 job。控制台里「所提供的模式无法找到文件」乱码，是 cmd/PowerShell 在 GBK 下找不到通配文件，不是 8787 挂了。

## CD（只在杭州本机）

合进 GitHub `main` 后，本机 **GitHub Actions self-hosted runner**（标签 `hangzhou`）跑下面的脚本。没有 runner 时仍可在杭州手工执行。脚本随仓库走。

看板没有对照中。仓库根目录 PowerShell（不要并行跑）：

```
powershell -ExecutionPolicy Bypass -File scripts\windows\release.ps1
```

脚本会：查 health（对照/打样/Illustrator 在跑或排队就失败）→ 校验 `$env:WB_DATA_DIR` 不在仓库内 → `git fetch` 并把 `package-lock.json` 复位到 HEAD（丢掉 npm 改脏的锁文件）→ 还有别的已跟踪改动、或本地 main 比 origin 多 commit，**先失败、不停 8787** → **再** `taskkill /T /F /PID` 只杀监听 8787 的那棵树（不杀全部 node.exe，不动 cloudflared）→ `Invoke-Git merge --ff-only origin/main` + 锁文件有变才 `npm ci` + 补 Windows 的 Rollup 可选包 + 编 UI + 启动。Git 拉码之后清掉 `GITHUB_TOKEN` 再跑 npm。merge/编/起失败时：`git reset --hard` 回停机前 SHA（只回这次升版，不是收拾操作员脏文件），缺 `node_modules`/`dist` 就在旧树上重装重编，再 `schtasks /Run beian-server-8787`。Actions 超时/取消时 workflow 的 `if: failure()` 也会 `/Run` 同一任务。顺利时公网会空 2–5 分钟。health 不通且 8787 仍在听，或还有 python/blender，会失败，不会当空闲。文件是 UTF-8 BOM，给中文 Windows 的 PowerShell 5 用。

`-Restart` 现在多余，行为一样。Mac 禁止 `cloudflared tunnel run beian`。

不要用 GitHub-hosted runner（`ubuntu-latest` / `windows-latest`）升这台机。不要 SSH。self-hosted 只打标签 `hangzhou`。

## 升到本版之前

看板没有「对照中」再 pull / 重启。对照跑着时不要直接切版本。

## 上线后手工冒烟

1. 对照跑着时重启 Node：孤儿 Python 被杀掉，作业重新入队或变成「对照中断」。
2. 已有任务 JSON 可以被替换（Windows 上目标文件已存在时 replace 成功）。
3. 超时之后，任务管理器里没有第二条 python / blender。
4. 打开首页，侧栏狐狸标和导航图标应显示。`http://127.0.0.1:8787/brand/logo-mark.png` 应是 PNG，不是 404（v0.12.0.1 修了 Windows 把 `/brand` 目录多拼一层；图在 `apps/web/ui/public/brand`，不要另拷一份）。
