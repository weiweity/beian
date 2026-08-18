# 风险与建仓硬门

| ID | 风险 | 处理 |
|---|---|---|
| R1 | 密钥进 Git | `.gitignore`；只拷 example；commit 前扫描 |
| R2 | 稿件/任务 JSON 进仓 | 忽略 uploads/tasks/logs/backups；不拷 `backend/data` 运行时 |
| R3 | Tunnel 后显示名裸奔 | 第一期必须飞书身份 + `AUTH_REQUIRE_KNOWN=true` |
| R4 | 3D 在 Windows 不可用 | 8/31 不开放；源码仅归档 |
| R5 | 中文桌面路径 | 仓库在 `Desktop/beian` ASCII 名；生产建议 `C:\supply\app` |
| R6 | 家用电脑睡眠 | 文档记录；不当 8/31 验收 |
| R7 | 误把 PPT/渲染图当 3D | 页面不提供生产 3D 入口 |

扫描命令（本地）：

```bash
# 有 gitleaks 时
gitleaks detect --source . --no-git
# 没有时至少搜密钥文件名和常见 token 形
```
