# 金标集 v0

字段级真值，用于回归 TVT 引擎（Precision/Recall 以「需人看」为阳性）。

## 格式

```json
{
  "id": "gold-v0-xxx",
  "title": "…",
  "task_id": "已审任务 id",
  "fields": [
    {
      "field": "二维码",
      "expected_status": "一致",
      "doubt_bucket": null,
      "note": ""
    }
  ]
}
```

`expected_status` ∈ `一致 | 疑点 | 缺失 | 跳过`  
`doubt_bucket` 可选：`typo | ocr_unclear | branch | noise | reverse | coverage`

## 评测

```bash
cd backend
.venv/bin/python scripts/run_eval.py
# 或 API（需登录 token）
# POST /api/eval/run
# GET  /api/eval/gold
# POST /api/tasks/{id}/export-gold
```

## 扩充

1. 完成一单人审后：`POST /api/tasks/{id}/export-gold`  
2. 人工改 `expected_status`  
3. 把 `task_id` 绑到该任务  
4. 再跑 `run_eval.py`
