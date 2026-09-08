#!/usr/bin/env python3
"""CLI for recropping print faces. Not pipeline.py — never starts Blender."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from structure_v2.artwork import ArtworkMappingError  # noqa: E402
from structure_v2.repair import repair_print_faces  # noqa: E402


def _under_job_dir(job_dir: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(job_dir.resolve())
        return True
    except ValueError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="从 V2 artwork 补切印刷面，不跑 Blender")
    parser.add_argument("--execution-id", help="private queue attempt identity")
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--artwork", type=Path, required=True)
    parser.add_argument("--resolved", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--raster-width", type=int, default=10_000)
    args = parser.parse_args()
    job_dir = args.job_dir.expanduser().resolve()
    artwork = args.artwork.expanduser().resolve()
    resolved = args.resolved.expanduser().resolve()
    assets = args.assets.expanduser().resolve()
    if not job_dir.is_dir():
        print(json.dumps({"ok": False, "error": "打样目录不存在"}, ensure_ascii=False), file=sys.stderr)
        return 2
    for path in (artwork, resolved, assets):
        if not _under_job_dir(job_dir, path):
            print(json.dumps({"ok": False, "error": "切面路径超出打样目录"}, ensure_ascii=False), file=sys.stderr)
            return 2
    try:
        sizes = repair_print_faces(artwork, resolved, assets, raster_width_px=args.raster_width)
    except ArtworkMappingError as error:
        print(json.dumps({"ok": False, "error": error.message, "code": error.code}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 — CLI boundary
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, "faces": sizes}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
