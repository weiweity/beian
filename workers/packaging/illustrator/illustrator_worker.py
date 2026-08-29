#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from illustrator_agent import IllustratorAgentError, request_agent


RUNNER = ROOT / "run_export.applescript"
LEGACY_JSX = ROOT / "export_ai.jsx"
STRUCTURE_JSX = ROOT / "export_structure.jsx"


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def select_jsx(config: dict) -> Path:
    """V2 is opt-in until pipeline cutover; legacy configs are unchanged."""
    return STRUCTURE_JSX if config.get("structure_json") else LEGACY_JSX


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


def agent_error_exit_code(error: IllustratorAgentError) -> int:
    if error.code == "illustrator_timeout":
        return 3
    if error.code in {
        "illustrator_agent_offline",
        "illustrator_agent_faulted",
        "illustrator_recovery_failed",
        "illustrator_agent_wrong_session",
        "illustrator_no_window",
        "illustrator_process_identity_mismatch",
        "illustrator_unavailable",
    }:
        return 6
    return 2


def write_agent_error(error: IllustratorAgentError) -> None:
    print(
        json.dumps(
            {"kind": "illustrator_agent_error", **error.as_dict()},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        file=sys.stderr,
    )


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
        config["document_already_open"] = False
        config_path.write_text(
            json.dumps(config, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        try:
            agent_result = request_agent(
                "run",
                config_path=str(config_path),
                exporter="structure" if config.get("structure_json") else "legacy",
                # The Session 1 agent is outside this worker's process tree. Keep
                # its deadline inside Hono's budget so cleanup finishes first.
                timeout_seconds=max(30, args.timeout - 30),
            )
        except IllustratorAgentError as error:
            write_agent_error(error)
            return agent_error_exit_code(error)
        illustrator_version = str(agent_result.get("illustrator_version") or "unknown")
        warmup_elapsed = float(agent_result.get("warmup_elapsed_ms") or 0) / 1000
        external_open_elapsed = 0.0
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
    if sys.platform != "win32":
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
    if sys.platform != "win32" and (process.returncode != 0 or not result_path.is_file()):
        print(process.stdout, file=sys.stderr)
        print(process.stderr, file=sys.stderr)
        return 2
    if not result_path.is_file():
        print("Illustrator agent reported success without result_json", file=sys.stderr)
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
