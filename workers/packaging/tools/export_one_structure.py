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
HASH_CHUNK = 1024 * 1024
# Same outer wait as workers/packaging/illustrator/unattended_wait.OUTER_SECONDS.
OUTER_SECONDS = 1260


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def split_layers(raw: str) -> list[str]:
    return [part.strip() for part in raw.split(",") if part.strip()]


def find_by_sha256(root: Path, digest: str) -> Path:
    want = digest.strip().lower()
    if len(want) != 64 or any(c not in "0123456789abcdef" for c in want):
        raise SystemExit("source_sha256 must be 64 hex chars")
    if not root.is_dir():
        raise SystemExit(f"source-dir is not a directory: {root}")
    for path in sorted(root.glob("*.ai")):
        try:
            got = file_sha256(path)
        except OSError:
            continue
        if got == want:
            return path
    raise SystemExit(f"no .ai in {root} matches {want}")


def build_payload(
    *,
    source: Path,
    out_dir: Path,
    application: Path,
    print_layers: list[str],
    proposal_layers: list[str],
    source_sha256: str,
) -> dict[str, object]:
    return {
        "application": str(application),
        "source_ai": str(source),
        "source_sha256": source_sha256,
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
    parser.add_argument("--timeout", type=int, default=OUTER_SECONDS)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    requested = args.sha256.strip().lower()
    source = find_by_sha256(args.source_dir, requested)
    digest = file_sha256(source)
    if digest != requested:
        raise SystemExit("source_sha256 no longer matches the selected file")
    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = build_payload(
        source=source,
        out_dir=out_dir,
        application=args.application,
        print_layers=split_layers(args.print_layers),
        proposal_layers=split_layers(args.proposal_layers),
        source_sha256=digest,
    )
    if not payload["print_layers"] or not payload["proposal_layers"]:
        raise SystemExit("print_layers and proposal_layers must be non-empty")
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
