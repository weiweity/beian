"""
金标集评测：字段级 Precision / Recall / 混淆矩阵。

金标 JSON 格式（data/gold/*.json）:
{
  "id": "case-01",
  "title": "...",
  "task_id": "optional-existing-task",
  "fields": [
    {"field": "二维码", "expected_status": "一致", "note": ""},
    {"field": "文案", "expected_status": "疑点", "doubt_bucket": "typo"}
  ]
}

或从任务导出：字段名 + 人工 status。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


GOLD_DIR_DEFAULT = Path(__file__).resolve().parent.parent / "data" / "gold"

# 状态归并：评测时「一致」为正类免审；「疑点/缺失」为需人看
_NEED_HUMAN = frozenset({"疑点", "缺失"})
_OK = frozenset({"一致", "跳过"})


def load_gold_cases(gold_dir: Path | None = None) -> list[dict[str, Any]]:
    d = Path(gold_dir or GOLD_DIR_DEFAULT)
    if not d.exists():
        return []
    cases = []
    for p in sorted(d.glob("*.json")):
        if p.name.startswith("_"):
            continue
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(raw, dict) and raw.get("fields"):
            raw["_path"] = str(p)
            cases.append(raw)
    return cases


def _norm_status(s: str) -> str:
    s = (s or "").strip()
    if s in ("一致", "疑点", "缺失", "跳过"):
        return s
    return "疑点"


def _field_key(name: str) -> str:
    return (name or "").replace("\n", " ").strip()


def match_hit(hits: list[dict], field_name: str) -> dict | None:
    key = _field_key(field_name)
    for h in hits:
        if _field_key(h.get("field") or "") == key:
            return h
    # 模糊：包含
    for h in hits:
        hf = _field_key(h.get("field") or "")
        if key in hf or hf in key:
            return h
    return None


def evaluate_case(
    gold: dict[str, Any],
    hits: list[dict[str, Any]],
) -> dict[str, Any]:
    """单案字段级对比。"""
    rows = []
    tp = fp = fn = tn = 0
    status_ok = 0
    status_total = 0
    for g in gold.get("fields") or []:
        fname = g.get("field") or ""
        exp = _norm_status(g.get("expected_status") or g.get("status") or "")
        hit = match_hit(hits, fname)
        pred = _norm_status(hit.get("status") if hit else "缺失")
        status_total += 1
        if pred == exp:
            status_ok += 1
        # 二分类：需人看 vs 免审
        exp_h = exp in _NEED_HUMAN
        pred_h = pred in _NEED_HUMAN
        if exp_h and pred_h:
            tp += 1
            cell = "TP"
        elif not exp_h and pred_h:
            fp += 1
            cell = "FP"  # 假阳：多报疑点
        elif exp_h and not pred_h:
            fn += 1
            cell = "FN"  # 漏放
        else:
            tn += 1
            cell = "TN"
        bucket_ok = True
        exp_b = g.get("doubt_bucket")
        pred_b = (hit or {}).get("doubt_bucket")
        if exp_b:
            bucket_ok = pred_b == exp_b
        rows.append(
            {
                "field": fname,
                "expected": exp,
                "predicted": pred,
                "cell": cell,
                "doubt_bucket_exp": exp_b,
                "doubt_bucket_pred": pred_b,
                "bucket_ok": bucket_ok,
                "score": (hit or {}).get("score"),
            }
        )
    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if (precision + recall)
        else 0.0
    )
    return {
        "case_id": gold.get("id") or gold.get("task_id") or "?",
        "title": gold.get("title") or "",
        "status_accuracy": status_ok / status_total if status_total else 0.0,
        "status_ok": status_ok,
        "status_total": status_total,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision_human": round(precision, 4),
        "recall_human": round(recall, 4),
        "f1_human": round(f1, 4),
        "rows": rows,
    }


def evaluate_task_against_gold(
    gold: dict[str, Any],
    task: dict[str, Any],
) -> dict[str, Any]:
    return evaluate_case(gold, task.get("hits") or [])


def aggregate_reports(reports: list[dict[str, Any]]) -> dict[str, Any]:
    if not reports:
        return {
            "cases": 0,
            "precision_human": 0.0,
            "recall_human": 0.0,
            "f1_human": 0.0,
            "status_accuracy": 0.0,
            "tp": 0,
            "fp": 0,
            "fn": 0,
            "tn": 0,
        }
    tp = sum(r["tp"] for r in reports)
    fp = sum(r["fp"] for r in reports)
    fn = sum(r["fn"] for r in reports)
    tn = sum(r["tn"] for r in reports)
    sok = sum(r["status_ok"] for r in reports)
    stot = sum(r["status_total"] for r in reports)
    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if (precision + recall)
        else 0.0
    )
    return {
        "cases": len(reports),
        "precision_human": round(precision, 4),
        "recall_human": round(recall, 4),
        "f1_human": round(f1, 4),
        "status_accuracy": round(sok / stot, 4) if stot else 0.0,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "status_ok": sok,
        "status_total": stot,
    }


def export_gold_from_task(task: dict[str, Any]) -> dict[str, Any]:
    """从已审任务导出金标骨架（expected = 当前 status，需人工校对）。"""
    fields = []
    for h in task.get("hits") or []:
        if (h.get("field") or "").startswith("【"):
            continue
        fields.append(
            {
                "field": h.get("field"),
                "expected_status": h.get("status") or "疑点",
                "doubt_bucket": h.get("doubt_bucket"),
                "note": "auto-exported — please human-verify",
            }
        )
    return {
        "id": f"export-{task.get('id')}",
        "title": task.get("title") or "",
        "task_id": task.get("id"),
        "fields": fields,
        "engine_version": task.get("engine_version"),
    }
