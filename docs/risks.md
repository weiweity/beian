# 风险与建仓硬门

| ID | 风险 | 处理 |
|---|---|---|
| R1 | 密钥进 Git | `.gitignore`；只拷 example；commit 前扫描 |
| R2 | 稿件/任务 JSON 进仓 | 忽略 uploads/tasks/logs/backups；不拷 `backend/data` 运行时 |
| R3 | Tunnel 后显示名裸奔 | 公网前打开 `WB_PUBLIC=1`（关掉显示名登录）。TS 入口不读 `AUTH_REQUIRE_KNOWN`（那是退役 FastAPI 的门） |
| R4 | 3D 在 Windows 不可用 | 打样台已调用 `workers/packaging`；8/31 验收不含打样；Mac 绿灯不等于 Windows 能跑。平面出图走 pymupdf，不要拿 Mac qlmanage 当杭州证据 |
| R5 | 中文桌面路径 | 仓库在 `Desktop/beian` ASCII 名；生产建议 `C:\supply\app` |
| R6 | 家用电脑睡眠 | 文档记录；不当 8/31 验收 |
| R7 | 误把页内旋转当备案交付 | 备案用白底静帧；GLB 只给她本机截图。8/31 不对业务承诺打样 |

扫描命令（本地）：

```bash
# 有 gitleaks 时
gitleaks detect --source . --no-git
# 没有时至少搜密钥文件名和常见 token 形
```
