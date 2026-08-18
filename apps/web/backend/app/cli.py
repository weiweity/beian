"""TS 产品层调用的对照 worker。只接受本机绝对路径，不监听端口。"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from app import main as m


def _ok(payload: dict) -> int:
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def _err(msg: str, code: int = 2) -> int:
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False), file=sys.stderr)
    return code


def cmd_probe(args: argparse.Namespace) -> int:
    target = (args.target or "").strip()
    if target == "python":
        missing: list[str] = []
        for name in ("fitz", "openpyxl"):
            try:
                __import__(name)
            except Exception:
                missing.append(name)
        if missing:
            return _err("缺少依赖: " + ", ".join(missing))
        return _ok({"ok": True, "executable": sys.executable})
    if target == "baidu":
        from app.baidu_ocr import get_access_token
        from app.config import baidu_ak_sk

        ak, sk = baidu_ak_sk()
        if not ak or not sk:
            return _err("未配置百度 OCR")
        try:
            get_access_token(ak, sk, force=True)
        except Exception as exc:  # noqa: BLE001 — 探测要吞细节
            return _err("百度拒绝: " + str(exc)[:160])
        return _ok({"ok": True})
    return _err("未知探测")


def cmd_compare(args: argparse.Namespace) -> int:
    data = Path(args.data_dir).expanduser().resolve() if args.data_dir else None
    m.init_paths(data)
    tid = (args.tid or "").strip()
    if not m.TID_RE.fullmatch(tid):
        return _err("无效任务 id")
    excel = Path(args.excel).resolve()
    pdf = Path(args.pdf).resolve()
    if not excel.is_file() or not pdf.is_file():
        return _err("excel 或 pdf 不存在")
    product = (args.product_name or "").strip()
    if not product:
        return _err("品名必填")
    surface = "膜袋" if args.surface == "pouch" else "花盒"
    title = (args.title or "").strip() or product
    tdir = m.UPLOADS / tid
    tdir.mkdir(parents=True, exist_ok=True)
    ep, pp = tdir / "source.xlsx", tdir / "artwork.pdf"
    if excel != ep:
        shutil.copy2(excel, ep)
    if pdf != pp:
        shutil.copy2(pdf, pp)
    task = m.run_excel_pdf_job(
        tid,
        ep,
        pp,
        m.clamp_max_pages(int(args.max_pages or 2)),
        title,
        pdf_pouch=None,
        surface_a_label=surface,
        surface_b_label="膜袋",
    )
    task["product_name"] = product
    task["title"] = title
    task["pack_surface"] = surface
    task["label_a"] = surface
    task["owner"] = args.actor or ""
    task["created_by"] = args.actor or ""
    task["actor"] = args.actor or ""
    task.setdefault("audit", []).append(
        {"at": m.now_iso(), "actor": args.actor or "", "action": "create", "via": "ts-cli"}
    )
    m.save_task(task)
    return _ok({"ok": True, "id": tid, "status": task.get("status")})


def cmd_rework(args: argparse.Namespace) -> int:
    data = Path(args.data_dir).expanduser().resolve() if args.data_dir else None
    m.init_paths(data)
    tid = (args.tid or "").strip()
    task = m.load_task(tid)
    pdf = Path(args.pdf).resolve()
    if not pdf.is_file():
        return _err("新 PDF 不存在")
    dest = m.UPLOADS / tid / "artwork_v2.pdf"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pdf, dest)
    excel = m.UPLOADS / tid / "source.xlsx"
    if not excel.is_file():
        return _err("找不到原 Excel")
    from app.fields import parse_excel_fields

    fields = parse_excel_fields(str(excel))
    surface = task.get("label_a") or task.get("pack_surface") or "花盒"
    result = m._surface_job(
        tid=tid,
        pdf=dest,
        pages_subdir="v2",
        max_pages=m.clamp_max_pages(int(args.max_pages or 2)),
        surface_label=str(surface),
        fields=fields,
        title=str(task.get("title") or ""),
        filename=dest.name,
    )
    task["round"] = 2
    task["artwork_v2"] = "artwork_v2.pdf"
    task["pages_v2"] = result.get("pages") or []
    task["hits_v2"] = result.get("hits") or []
    task["status"] = "in_review"
    prior = [
        h
        for h in (task.get("hits") or [])
        if h.get("decision") == "issue"
    ]
    v2_by_field = {(h.get("field") or ""): h for h in task["hits_v2"]}
    rematch = []
    for old in prior:
        field = old.get("field") or ""
        new = v2_by_field.get(field)
        rematch.append(
            {
                "field": field,
                "expected_text": old.get("excel") or old.get("excel_value") or old.get("expected"),
                "observed_text": old.get("pdf") or old.get("found"),
                "v1_status": old.get("status"),
                "v2_status": (new or {}).get("status") or "待人工确认",
                "page": (new or {}).get("page") or old.get("page"),
            }
        )
    task["rework_check"] = rematch
    task.setdefault("audit", []).append(
        {"at": m.now_iso(), "actor": args.actor or "", "action": "rework_v2"}
    )
    m.save_task(task)
    return _ok({"ok": True, "id": tid, "round": 2, "checks": len(rematch)})


def main() -> int:
    p = argparse.ArgumentParser(prog="beian-review-worker")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("compare")
    c.add_argument("--tid", required=True)
    c.add_argument("--excel", required=True)
    c.add_argument("--pdf", required=True)
    c.add_argument("--product-name", required=True)
    c.add_argument("--title", default="")
    c.add_argument("--surface", default="carton")
    c.add_argument("--max-pages", default="2")
    c.add_argument("--actor", default="")
    c.add_argument("--data-dir", default="")

    r = sub.add_parser("rework")
    r.add_argument("--tid", required=True)
    r.add_argument("--pdf", required=True)
    r.add_argument("--max-pages", default="2")
    r.add_argument("--actor", default="")
    r.add_argument("--data-dir", default="")

    pr = sub.add_parser("probe")
    pr.add_argument("--target", required=True, choices=("python", "baidu"))

    args = p.parse_args()
    if args.cmd == "compare":
        return cmd_compare(args)
    if args.cmd == "rework":
        return cmd_rework(args)
    if args.cmd == "probe":
        return cmd_probe(args)
    return _err("未知命令")


if __name__ == "__main__":
    raise SystemExit(main())
