#!/usr/bin/env python3
"""CLI: 金标评测（对照已有任务 hits）

用法:
  cd backend && .venv/bin/python scripts/run_eval.py
  .venv/bin/python scripts/run_eval.py --task-id c7a545a40404
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import eval_gold  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Gold-set eval for workbench TVT")
    ap.add_argument("--gold-dir", type=Path, default=ROOT / "data" / "gold")
    ap.add_argument("--tasks-dir", type=Path, default=ROOT / "data" / "tasks")
    ap.add_argument("--task-id", type=str, default=None)
    args = ap.parse_args()

    cases = eval_gold.load_gold_cases(args.gold_dir)
    if args.task_id:
        cases = [
            c
            for c in cases
            if c.get("task_id") == args.task_id or c.get("id") == args.task_id
        ]
    if not cases:
        print("No gold cases found in", args.gold_dir)
        return 1

    reports = []
    for c in cases:
        tid = c.get("task_id")
        if not tid:
            print(f"[skip] {c.get('id')}: no task_id")
            continue
        tp = args.tasks_dir / f"{tid}.json"
        if not tp.exists():
            print(f"[skip] {c.get('id')}: task {tid} missing")
            continue
        task = json.loads(tp.read_text(encoding="utf-8"))
        r = eval_gold.evaluate_task_against_gold(c, task)
        reports.append(r)
        print(
            f"case={r['case_id']} acc={r['status_accuracy']:.2%} "
            f"P={r['precision_human']:.2f} R={r['recall_human']:.2f} "
            f"F1={r['f1_human']:.2f} FP={r['fp']} FN={r['fn']}"
        )
        for row in r.get("rows") or []:
            if row["cell"] in ("FP", "FN") or row["expected"] != row["predicted"]:
                print(
                    f"  {row['cell']:2} {row['field'][:40]!r} "
                    f"exp={row['expected']} pred={row['predicted']}"
                )

    agg = eval_gold.aggregate_reports(reports)
    print("---")
    print(json.dumps(agg, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
