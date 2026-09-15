#!/usr/bin/env python3
"""Export one local .ai through Illustrator structure JSX.

Selects the file by SHA-256 so Hangzhou paste need not type Chinese names.
Does not stop 8787 or cloudflared, does not kill Illustrator, does not mark gold.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import uuid
from pathlib import Path

WORKER = Path(__file__).resolve().parent.parent / "illustrator" / "illustrator_worker.py"
DEFAULT_APP = Path(
    r"C:\Program Files\Adobe\Adobe Illustrator 2026\Support Files\Contents\Windows\Illustrator.exe"
)


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def find_by_sha256(root: Path, digest: str) -> Path:
    want = digest.strip().lower()
    if len(want) != 64 or any(c not in "0123456789abcdef" for c in want):
        raise SystemExit("source_sha256 must be 64 hex chars")
    for path in sorted(root.glob("*.ai")):
        if file_sha256(path) == want:
            return path
    raise SystemExit(f"no .ai in {root} matches {want}")


def build_payload(
    *,
    source: Path,
    out_dir: Path,
    application: Path,
    print_layers: list[str],
    proposal_layers: list[str],
) -> dict[str, object]:
    digest = file_sha256(source)
    return {
        "application": str(application),
        "source_ai": str(source),
        "source_sha256": digest,
        "full_pdf": str(out_dir / "full.pdf"),
        "print_pdf": str(out_dir / "artwork.pdf"),
        "structure_json": str(out_dir / "structure.json"),
        "result_json": str(out_dir / "illustrator_result.json"),
        "debug_log": str(out_dir / "jsx_debug.log"),
        "attempt_id": uuid.uuid4().hex,
        "semantic_assignments": {},
        "proposal_layers": proposal_layers,
        "print_layers": print_layers,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--application", type=Path, default=DEFAULT_APP)
    parser.add_argument("--print-layers", default="印刷")
    parser.add_argument("--proposal-layers", default="刀线")
    parser.add_argument("--timeout", type=int, default=1260)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    source = find_by_sha256(args.source_dir, args.sha256)
    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = build_payload(
        source=source,
        out_dir=out_dir,
        application=args.application,
        print_layers=[part for part in args.print_layers.split(",") if part.strip()],
        proposal_layers=[part for part in args.proposal_layers.split(",") if part.strip()],
    )
    if not payload["print_layers"] or not payload["proposal_layers"]:
        raise SystemExit("print_layers and proposal_layers must be non-empty")
    if not payload["source_sha256"]:
        raise SystemExit("source_sha256 is required for semantic export")
    config_path = out_dir / "illustrator_input.json"
    config_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("source", source.name)
    print("source_sha256", payload["source_sha256"])
    print("attempt_id", payload["attempt_id"])
    print("config", config_path)
    if args.dry_run:
        print("dry-run")
        return 0
    result = subprocess.run(
        [sys.executable, str(WORKER), str(config_path), "--timeout", str(args.timeout)],
        check=False,
    )
    print("worker-exit", result.returncode)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
