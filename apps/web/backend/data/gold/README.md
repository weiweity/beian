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
cd apps/web/backend
.venv/bin/python scripts/run_eval.py
```

没有金标，或金标对应的任务都不存在时，命令必须非零退出；不能把 0 案例当成评测通过。

## 扩充

1. 完成一单人审后，在隔离副本中用 `app.eval_gold.export_gold_from_task` 生成草稿；不要提交 `data/tasks` 运行时文件。
2. 人工逐字段核定 `expected_status`，未核定草稿不能当金标。
3. 把 `task_id` 绑到该任务。
4. 再跑 `run_eval.py`。
