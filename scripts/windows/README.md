# Windows 备忘（8/31 不承诺开机自启）

第一期只要这台机器能跑：

- Python 3.12
- `pip install -r apps/web/backend/requirements.txt`
- `cloudflared` Named Tunnel → `http://127.0.0.1:8787`
- 电源计划：不睡眠（运维项，不当本期验收）

不要安装进仓库的东西：Illustrator、Blender（3D 未接线）。

生产数据建议：`C:\supply\data`，用环境变量指过去，不要放在 git 工作树里。
