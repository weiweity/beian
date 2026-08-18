# beian

供应链飞书网页应用。第一期（2026-08-31）只让刘籽烨远程完成 Excel ↔ 备案 PDF 人终审。

3D 流水线源码在 `workers/packaging/`，**不对业务开放**，9 月再接线。

## 仓库

| 路径 | 内容 |
|---|---|
| `apps/web/` | 从现有 workbench 迁入的 FastAPI + 静态页 |
| `workers/packaging/` | 从 packaging_pipeline 迁入的 2D→3D CLI（未接线） |
| `docs/` | 章程与风险 |
| `scripts/` | 本机启动 |

## 本机启动（开发）

```bash
cd apps/web/backend
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.baidu.example .env.baidu
cp .env.secrets.example .env.secrets
# 填密钥后：chmod 600 .env.baidu .env.secrets
export PYTHONPATH="."
# 开发机可先关死匿名登录
# AUTH_REQUIRE_KNOWN=true
uvicorn app.main:app --host 127.0.0.1 --port 8787
```

浏览器：http://127.0.0.1:8787/

或：`./scripts/dev-start.sh`

## 8/31 验收

1. 刘籽烨用飞书打开约定域名（接入后），未登录看不到任务。
2. 白名单外看不到任务和文件。
3. 她上传一对真 Excel+PDF，完成人终审。
4. 差异能追到字段/页码/原文；OCR 不清显示待人工确认。
5. 本仓历史里没有密钥、uploads、样本稿。
6. 没有生产级 3D 提交口。

## 不要提交

密钥、`.venv`、任务 JSON、上传稿、`.ai/.pdf/.xlsx` 样本。见根目录 `.gitignore`。

## 生产

杭州 Windows + Cloudflare Named Tunnel → `127.0.0.1:8787`。Mac 只做开发。当前提交**还没有**飞书免登和 Tunnel 配置，那是建仓之后的工作。
