from pathlib import Path
import hashlib
import json
import sys

import pytest

TOOLS = Path(__file__).resolve().parents[4] / "workers" / "packaging" / "tools"
sys.path.insert(0, str(TOOLS))
from export_one_structure import build_payload, find_by_sha256, main  # noqa: E402


def test_find_by_sha256_and_payload_includes_digest(tmp_path: Path) -> None:
    sample = tmp_path / "carton.ai"
    sample.write_bytes(b"%PDF-1.4 synthetic-ai")
    digest = hashlib.sha256(sample.read_bytes()).hexdigest()
    found = find_by_sha256(tmp_path, digest)
    assert found == sample
    out = tmp_path / "run"
    payload = build_payload(
        source=found,
        out_dir=out,
        application=Path("C:/Program Files/Adobe/Adobe Illustrator 2026/Support Files/Contents/Windows/Illustrator.exe"),
        print_layers=["印刷"],
        proposal_layers=["刀线"],
    )
    assert payload["source_sha256"] == digest
    assert payload["source_ai"] == str(found)
    assert payload["print_layers"] == ["印刷"]
    assert payload["proposal_layers"] == ["刀线"]
    assert len(str(payload["attempt_id"])) == 32


def test_missing_hash_exits(tmp_path: Path) -> None:
    (tmp_path / "other.ai").write_bytes(b"nope")
    with pytest.raises(SystemExit, match="no .ai"):
        find_by_sha256(tmp_path, "a" * 64)


def test_dry_run_writes_config(tmp_path: Path) -> None:
    sample = tmp_path / "carton.ai"
    sample.write_bytes(b"ai-bytes")
    digest = hashlib.sha256(sample.read_bytes()).hexdigest()
    out = tmp_path / "run"
    code = main(
        [
            "--source-dir",
            str(tmp_path),
            "--sha256",
            digest,
            "--out-dir",
            str(out),
            "--dry-run",
        ]
    )
    assert code == 0
    data = json.loads((out / "illustrator_input.json").read_text(encoding="utf-8"))
    assert data["source_sha256"] == digest
    assert data["structure_json"].endswith("structure.json")
