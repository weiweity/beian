#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent
RUNNER = ROOT / "run_export.applescript"
WINDOWS_RUNNER = ROOT / "run_export.vbs"
LEGACY_JSX = ROOT / "export_ai.jsx"
STRUCTURE_JSX = ROOT / "export_structure.jsx"


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def select_jsx(config: dict) -> Path:
    """V2 is opt-in until pipeline cutover; legacy configs are unchanged."""
    return STRUCTURE_JSX if config.get("structure_json") else LEGACY_JSX


def windows_cscript_path() -> Path:
    windows_root = Path(
        os.environ.get("SystemRoot")
        or os.environ.get("WINDIR")
        or r"C:\Windows"
    )
    candidate = windows_root / "System32" / "cscript.exe"
    return candidate if candidate.is_file() else Path("cscript.exe")


def windows_runner_command(
    mode: str,
    runtime_jsx: Path | None = None,
    *,
    cscript: Path | None = None,
) -> list[str]:
    if mode not in {"probe", "run"}:
        raise ValueError(f"unsupported Windows Illustrator runner mode: {mode}")
    command = [
        str(cscript or windows_cscript_path()),
        "//Nologo",
        str(WINDOWS_RUNNER),
        mode,
    ]
    if mode == "run":
        if runtime_jsx is None:
            raise ValueError("runtime_jsx is required in run mode")
        command.append(str(runtime_jsx))
    return command


def parse_windows_probe(stdout: str) -> tuple[str, int]:
    fields = stdout.strip().split("\t")
    if len(fields) != 2 or not fields[0].strip():
        raise ValueError("Windows Illustrator probe returned an invalid response")
    return fields[0].strip(), int(fields[1].strip())


def materialize_runtime_jsx(jsx_path: Path, config_path: Path) -> Path:
    """Bind the config path without duplicating the cross-platform JSX exporter."""
    runtime_path = config_path.with_name(f"{jsx_path.stem}.runtime.jsx")
    declaration = (
        "var PIPELINE_CONFIG_PATH = "
        + json.dumps(str(config_path), ensure_ascii=True)
        + ";\n"
    )
    runtime_path.write_text(
        declaration + jsx_path.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    return runtime_path


def warm_up_windows_illustrator(app_path: Path, timeout_seconds: int) -> str:
    if not app_path.is_file():
        raise RuntimeError(f"Illustrator executable does not exist: {app_path}")
    try:
        subprocess.Popen(
            [str(app_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise RuntimeError(f"Illustrator launch failed: {error}") from error

    deadline = time.monotonic() + timeout_seconds
    last_error = ""
    while time.monotonic() < deadline:
        try:
            process = subprocess.run(
                windows_runner_command("probe"),
                capture_output=True,
                text=True,
                timeout=15,
            )
            if process.returncode == 0:
                version, document_total = parse_windows_probe(process.stdout)
                if document_total != 0:
                    raise RuntimeError(
                        "Illustrator semantic export requires no other open documents"
                    )
                return version
            last_error = process.stderr.strip() or process.stdout.strip()
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            last_error = str(error)
        time.sleep(2)
    raise RuntimeError(f"Illustrator warm-up failed: {last_error}")


def warm_up_illustrator(app_path: Path, timeout_seconds: int) -> str:
    was_running = subprocess.run(
        ["/usr/bin/pgrep", "-x", "Adobe Illustrator"],
        capture_output=True,
        text=True,
    ).returncode == 0
    subprocess.run(
        ["/usr/bin/open", "-gj", "-a", str(app_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    deadline = time.monotonic() + timeout_seconds
    command = [
        "/usr/bin/osascript",
        "-e",
        'tell application id "com.adobe.illustrator" to get version',
    ]
    last_error = ""
    while time.monotonic() < deadline:
        try:
            process = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=15,
            )
            if process.returncode == 0 and process.stdout.strip():
                if not was_running:
                    time.sleep(10)
                return process.stdout.strip()
            last_error = process.stderr.strip()
        except subprocess.TimeoutExpired:
            last_error = "version probe timed out"
        time.sleep(2)
    raise RuntimeError(f"Illustrator warm-up failed: {last_error}")


def document_count() -> int:
    command = [
        "/usr/bin/osascript",
        "-e",
        'tell application id "com.adobe.illustrator" to do javascript "app.documents.length;"',
    ]
    process = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr.strip() or "document count probe failed")
    return int(process.stdout.strip())


def open_document_externally(
    app_path: Path,
    source_path: Path,
    timeout_seconds: int,
) -> float:
    if document_count() != 0:
        raise RuntimeError(
            "Illustrator fallback requires no other open documents"
        )
    started = time.perf_counter()
    subprocess.run(
        ["/usr/bin/open", "-g", "-a", str(app_path), str(source_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    deadline = time.monotonic() + timeout_seconds
    last_error = ""
    while time.monotonic() < deadline:
        try:
            if document_count() > 0:
                time.sleep(1)
                return time.perf_counter() - started
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            last_error = str(error)
        time.sleep(2)
    raise RuntimeError(f"Illustrator document open timed out: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Illustrator AI normalization worker")
    parser.add_argument("config", type=Path)
    parser.add_argument("--timeout", type=int, default=420)
    args = parser.parse_args()

    config_path = args.config.expanduser().resolve()
    config = load_json(config_path)
    output_keys = ["full_pdf", "print_pdf", "result_json"]
    if config.get("structure_json"):
        output_keys.append("structure_json")
    for key in output_keys:
        Path(config[key]).parent.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    warmup_started = time.perf_counter()
    app_path = Path(config["application"]).expanduser().resolve()
    if sys.platform == "win32":
        try:
            illustrator_version = warm_up_windows_illustrator(
                app_path,
                min(120, max(30, args.timeout // 3)),
            )
        except RuntimeError as error:
            print(str(error), file=sys.stderr)
            return 6
        warmup_elapsed = time.perf_counter() - warmup_started
        external_open_elapsed = 0.0
        config["document_already_open"] = False
    else:
        try:
            illustrator_version = warm_up_illustrator(
                app_path,
                min(120, max(30, args.timeout // 3)),
            )
        except RuntimeError as error:
            print(str(error), file=sys.stderr)
            return 6
        warmup_elapsed = time.perf_counter() - warmup_started
        open_budget = min(300, max(30, args.timeout - int(warmup_elapsed) - 60))
        source_path = Path(config["source_ai"]).expanduser().resolve()
        try:
            external_open_elapsed = open_document_externally(
                app_path,
                source_path,
                open_budget,
            )
        except RuntimeError as error:
            print(str(error), file=sys.stderr)
            return 7
        config["document_already_open"] = True
    config_path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    remaining_timeout = max(
        30,
        args.timeout - int(warmup_elapsed) - int(external_open_elapsed),
    )
    if sys.platform == "win32":
        runtime_jsx = materialize_runtime_jsx(select_jsx(config), config_path)
        command = windows_runner_command("run", runtime_jsx)
    else:
        command = [
            "/usr/bin/osascript",
            str(RUNNER),
            str(select_jsx(config)),
            str(config_path),
        ]
    try:
        process = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=remaining_timeout,
        )
    except subprocess.TimeoutExpired as error:
        print(
            f"Illustrator export timed out after {remaining_timeout}s: {error}",
            file=sys.stderr,
        )
        return 3

    result_path = Path(config["result_json"])
    if process.returncode != 0 or not result_path.is_file():
        print(process.stdout, file=sys.stderr)
        print(process.stderr, file=sys.stderr)
        return 2

    result = load_json(result_path)
    result["illustrator_version"] = illustrator_version
    result["warmup_elapsed_s"] = round(warmup_elapsed, 4)
    result["external_open_elapsed_s"] = round(external_open_elapsed, 4)
    result["worker_elapsed_s"] = round(time.perf_counter() - started, 4)
    result_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if not result.get("success"):
        print(json.dumps(result, ensure_ascii=False), file=sys.stderr)
        return 4
    required_outputs = ["full_pdf", "print_pdf"]
    if config.get("structure_json"):
        required_outputs.append("structure_json")
    for key in required_outputs:
        if not Path(result[key]).is_file():
            print(f"Illustrator did not create {key}: {result[key]}", file=sys.stderr)
            return 5
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
