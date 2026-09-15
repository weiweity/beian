from pathlib import Path
import hashlib
import json
import subprocess
import sys

import pytest

TOOLS = Path(__file__).resolve().parents[4] / "workers" / "packaging" / "tools"
sys.path.insert(0, str(TOOLS))
import export_one_structure as eos  # noqa: E402
from export_one_structure import (  # noqa: E402
    DEFAULT_APP,
    OUTER_SECONDS,
    WORKER,
    build_payload,
    file_sha256,
    find_by_sha256,
    main,
    split_layers,
)


def write_ai(tmp_path: Path, name: str = "carton.ai", body: bytes = b"ai-bytes") -> tuple[Path, str]:
    sample = tmp_path / name
    sample.write_bytes(body)
    return sample, hashlib.sha256(body).hexdigest()


def test_find_by_sha256_and_payload_includes_digest(tmp_path: Path) -> None:
    sample, digest = write_ai(tmp_path, body=b"%PDF-1.4 synthetic-ai")
    found = find_by_sha256(tmp_path, digest)
    assert found == sample
    out = tmp_path / "run"
    application = Path(
        "C:/Program Files/Adobe/Adobe Illustrator 2026/Support Files/Contents/Windows/Illustrator.exe"
    )
    payload = build_payload(
        source=found,
        out_dir=out,
        application=application,
        print_layers=["印刷"],
        proposal_layers=["刀线"],
        source_sha256=digest,
    )
    assert payload["source_sha256"] == digest
    assert payload["source_ai"] == str(found)
    assert payload["application"] == str(application)
    assert payload["print_layers"] == ["印刷"]
    assert payload["proposal_layers"] == ["刀线"]
    assert payload["semantic_assignments"] == {}
    assert payload["full_pdf"] == str(out / "full.pdf")
    assert payload["print_pdf"] == str(out / "artwork.pdf")
    assert payload["structure_json"] == str(out / "structure.json")
    assert payload["result_json"] == str(out / "illustrator_result.json")
    assert payload["debug_log"] == str(out / "jsx_debug.log")
    assert len(str(payload["attempt_id"])) == 32


def test_file_sha256_matches_stdlib_digest(tmp_path: Path) -> None:
    sample, digest = write_ai(tmp_path, body=b"chunked-hash" * 100)
    assert file_sha256(sample) == digest


def test_missing_hash_exits(tmp_path: Path) -> None:
    write_ai(tmp_path, name="other.ai", body=b"nope")
    with pytest.raises(SystemExit, match="no .ai"):
        find_by_sha256(tmp_path, "a" * 64)


def test_missing_source_dir_exits(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="no .ai"):
        find_by_sha256(tmp_path / "absent", "a" * 64)


@pytest.mark.parametrize("digest", ["", "abc", "0" * 63, "g" * 64, "0" * 63 + "x"])
def test_find_by_sha256_rejects_invalid_digest(tmp_path: Path, digest: str) -> None:
    write_ai(tmp_path)
    with pytest.raises(SystemExit, match="64 hex"):
        find_by_sha256(tmp_path, digest)


def test_find_by_sha256_normalizes_case_and_whitespace(tmp_path: Path) -> None:
    sample, digest = write_ai(tmp_path)
    assert find_by_sha256(tmp_path, f"  {digest.upper()}\n") == sample


def test_find_by_sha256_ignores_non_ai_and_returns_sorted_match(tmp_path: Path) -> None:
    body = b"same-ai"
    digest = hashlib.sha256(body).hexdigest()
    (tmp_path / "zzz.txt").write_bytes(body)
    (tmp_path / "notes.pdf").write_bytes(body)
    write_ai(tmp_path, name="z-carton.ai", body=body)
    earlier, _ = write_ai(tmp_path, name="a-carton.ai", body=body)
    write_ai(tmp_path, name="other.ai", body=b"different")
    assert find_by_sha256(tmp_path, digest) == earlier


def test_find_by_sha256_does_not_recurse_into_subdirs(tmp_path: Path) -> None:
    nested = tmp_path / "2D平面图"
    nested.mkdir()
    _sample, digest = write_ai(nested)
    with pytest.raises(SystemExit, match="no .ai"):
        find_by_sha256(tmp_path, digest)


def test_worker_constant_resolves_to_real_file() -> None:
    expected = (
        Path(__file__).resolve().parents[4]
        / "workers"
        / "packaging"
        / "illustrator"
        / "illustrator_worker.py"
    )
    assert WORKER.resolve() == expected.resolve()
    assert WORKER.is_file()
    assert OUTER_SECONDS == 1260


def test_split_layers_strips_whitespace() -> None:
    assert split_layers("印刷, 烫金") == ["印刷", "烫金"]
    assert split_layers(" , , ") == []


def test_dry_run_writes_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _sample, digest = write_ai(tmp_path)
    out = tmp_path / "run"
    monkeypatch.setattr(
        eos.subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("dry-run must not spawn Illustrator"),
    )
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
    assert data["print_layers"] == ["印刷"]
    assert data["proposal_layers"] == ["刀线"]
    assert data["application"] == str(DEFAULT_APP)


@pytest.mark.parametrize("flag", ["--print-layers", "--proposal-layers"])
def test_main_rejects_blank_layers(tmp_path: Path, flag: str) -> None:
    _sample, digest = write_ai(tmp_path)
    with pytest.raises(SystemExit, match="must be non-empty"):
        main(
            [
                "--source-dir",
                str(tmp_path),
                "--sha256",
                digest,
                "--out-dir",
                str(tmp_path / "run"),
                flag,
                ", ,",
                "--dry-run",
            ]
        )


def test_main_splits_layers_and_custom_application(tmp_path: Path) -> None:
    _sample, digest = write_ai(tmp_path)
    out = tmp_path / "nested" / "run"
    application = tmp_path / "Illustrator.exe"
    code = main(
        [
            "--source-dir",
            str(tmp_path),
            "--sha256",
            digest,
            "--out-dir",
            str(out),
            "--print-layers",
            "印刷, 烫金",
            "--proposal-layers",
            "刀线, 结构",
            "--application",
            str(application),
            "--dry-run",
        ]
    )
    assert code == 0
    data = json.loads((out / "illustrator_input.json").read_text(encoding="utf-8"))
    assert data["print_layers"] == ["印刷", "烫金"]
    assert data["proposal_layers"] == ["刀线", "结构"]
    assert data["application"] == str(application)
    assert data["semantic_assignments"] == {}


def test_main_forwards_timeout_and_worker_exit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _sample, digest = write_ai(tmp_path)
    out = tmp_path / "run"
    captured: dict[str, object] = {}

    def fake_run(cmd: list[str], check: bool = False) -> subprocess.CompletedProcess[str]:
        captured["cmd"] = list(cmd)
        captured["check"] = check
        return subprocess.CompletedProcess(cmd, 7)

    monkeypatch.setattr(eos.subprocess, "run", fake_run)
    code = main(
        [
            "--source-dir",
            str(tmp_path),
            "--sha256",
            digest,
            "--out-dir",
            str(out),
            "--timeout",
            "90",
        ]
    )
    assert code == 7
    assert captured["check"] is False
    cmd = captured["cmd"]
    assert isinstance(cmd, list)
    assert cmd[0] == sys.executable
    assert cmd[1] == str(WORKER)
    assert cmd[2] == str(out / "illustrator_input.json")
    assert cmd[3:5] == ["--timeout", "90"]
    printed = capsys.readouterr().out
    assert "worker-exit 7" in printed
    assert "dry-run" not in printed
    assert (out / "illustrator_input.json").is_file()
