#!/usr/bin/env python3
"""Repeatable R04 resource-measurement CLI. Synthetic by default; no product load."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import protocol  # noqa: E402
import scenarios  # noqa: E402

SYNTHETIC_CHILD = HERE / "synthetic_child.py"


def _load_rows(path: Path | None) -> list[dict] | None:
    if path is None:
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and "processes" in payload:
        payload = payload["processes"]
    if not isinstance(payload, list):
        raise SystemExit("process snapshot JSON must be a list or {processes: [...]}")
    return payload


def _outside_repo(repo: Path, output: Path) -> None:
    repo_r = repo.resolve()
    probe = output if output.exists() else output.parent
    try:
        probe.resolve().relative_to(repo_r)
    except ValueError:
        return
    raise SystemExit("evidence output must be outside the checkout")


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def cmd_identity(args: argparse.Namespace) -> int:
    identity = protocol.collect_identity(Path(args.repo))
    print(json.dumps(identity, indent=2))
    if args.out:
        _write_json(Path(args.out) / "identity.json", identity)
    return 0 if identity["complete"] else 2


def cmd_preflight(args: argparse.Namespace) -> int:
    rows = _load_rows(Path(args.process_snapshot_json) if args.process_snapshot_json else None)
    if rows is None:
        rows = protocol.snapshot_processes()
    result = protocol.preflight_from_rows(rows)
    result["observation_limits"] = protocol.observation_limits()
    print(json.dumps({k: v for k, v in result.items() if k != "foreign_load"}, indent=2))
    print(f"foreign_count={len(result['foreign_load'])}")
    if args.out:
        _write_json(Path(args.out) / "preflight.json", result)
    if args.formal_budget and not result["budget_eligible"]:
        return 3
    return 0


def cmd_matrix(_args: argparse.Namespace) -> int:
    payload = {
        "schema": protocol.SCHEMA,
        "scenarios": scenarios.SCENARIOS,
        "coverage_index": scenarios.coverage_index(),
        "synthetic_suite": list(scenarios.SYNTHETIC_SUITE),
        "note": "exclusive_command is for a later exclusive window; this CLI does not start Blender/browsers",
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def _bundle(
    *,
    repo: Path,
    output: Path,
    identity: dict,
    preflight: dict,
    runs: list[dict],
    workload_kind: str,
    exclusive: bool,
    mode: str,
) -> dict:
    validity = protocol.budget_validity(
        identity=identity,
        preflight=preflight,
        runs=runs,
        workload_kind=workload_kind,
        exclusive=exclusive,
    )
    return {
        "schema": protocol.SCHEMA,
        "mode": mode,
        "identity": identity,
        "preflight": {k: v for k, v in preflight.items() if k != "foreign_load"}
        | {"foreign_count": len(preflight.get("foreign_load") or [])},
        "headroom": protocol.headroom(output),
        "observation_limits": protocol.observation_limits(),
        "owned_process_policy": protocol.OWNED_PROCESS_POLICY,
        "pixel_cap": protocol.PIXEL_CAP,
        "matrix": scenarios.SCENARIOS,
        "coverage_index": scenarios.coverage_index(),
        "runs": [protocol.command_summary(run) | {
            "foreign_load": run.get("foreign_load"),
            "cancelled": run.get("cancelled"),
            "metrics_path": run.get("metrics_path"),
            "peak_rss_note": run.get("peak_rss_note"),
        } for run in runs],
        "commands": [protocol.command_summary(run) for run in runs],
        "validity": validity,
        "budget_valid": validity["budget_valid"],
        "unverified": [
            scene["id"]
            for scene in scenarios.SCENARIOS
            if scene["this_round"] == "not-run"
        ],
    }


def _persist_bundle(output: Path, bundle: dict) -> None:
    _write_json(output / "report.json", bundle)
    _write_json(output / "identity.json", bundle["identity"])
    _write_json(output / "commands.json", bundle["commands"])
    _write_json(output / "scenarios.json", {
        "matrix": bundle["matrix"],
        "coverage_index": bundle["coverage_index"],
        "unverified": bundle["unverified"],
    })
    (output / "REPORT.md").write_text(protocol.render_report_md(bundle), encoding="utf-8")


def cmd_measure_command(args: argparse.Namespace) -> int:
    repo = Path(args.repo)
    output = Path(args.out)
    _outside_repo(repo, output)
    output.mkdir(parents=True, exist_ok=True)
    identity = protocol.collect_identity(repo)
    rows = _load_rows(Path(args.process_snapshot_json) if args.process_snapshot_json else None)
    preflight = protocol.preflight_from_rows(rows if rows is not None else protocol.snapshot_processes())
    exclusive = bool(args.formal_budget)
    workload_kind = args.workload_kind
    if args.formal_budget and (not identity["complete"] or not preflight["budget_eligible"]):
        bundle = _bundle(
            repo=repo,
            output=output,
            identity=identity,
            preflight=preflight,
            runs=[],
            workload_kind=workload_kind,
            exclusive=exclusive,
            mode="formal-budget-refused",
        )
        _persist_bundle(output, bundle)
        return 2 if not identity["complete"] else 3
    run = protocol.measure_command(
        args.name,
        list(args.command),
        cwd=repo if args.cwd is None else Path(args.cwd),
        output_dir=output,
        sample_interval_s=args.sample_interval,
    )
    bundle = _bundle(
        repo=repo,
        output=output,
        identity=identity,
        preflight=preflight,
        runs=[run],
        workload_kind=workload_kind,
        exclusive=exclusive,
        mode="measure-command",
    )
    _persist_bundle(output, bundle)
    if args.formal_budget and not bundle["budget_valid"]:
        return 4
    if run.get("measurement_errors"):
        return 4
    code = run.get("exit_code")
    return (128 - code if code < 0 else code) if isinstance(code, int) else 4


def cmd_run(args: argparse.Namespace) -> int:
    repo = Path(args.repo)
    output = Path(args.out)
    _outside_repo(repo, output)
    output.mkdir(parents=True, exist_ok=True)
    identity = protocol.collect_identity(repo)
    rows = _load_rows(Path(args.process_snapshot_json) if args.process_snapshot_json else None)
    preflight = protocol.preflight_from_rows(rows if rows is not None else protocol.snapshot_processes())
    exclusive = args.mode == "exclusive" or bool(args.formal_budget)
    if args.mode == "exclusive":
        bundle = _bundle(
            repo=repo,
            output=output,
            identity=identity,
            preflight=preflight,
            runs=[],
            workload_kind="product",
            exclusive=False,
            mode="exclusive-plan-only",
        )
        bundle["note"] = (
            "exclusive mode prints/persists the command plan only; "
            "this slice does not start Blender or browser load"
        )
        bundle["exclusive_plan"] = scenarios.SCENARIOS
        _persist_bundle(output, bundle)
        print(json.dumps({"mode": "exclusive-plan-only", "budget_valid": False}, indent=2))
        return 0
    if args.formal_budget and (not identity["complete"] or not preflight["budget_eligible"]):
        bundle = _bundle(
            repo=repo,
            output=output,
            identity=identity,
            preflight=preflight,
            runs=[],
            workload_kind="synthetic",
            exclusive=True,
            mode="formal-budget-refused",
        )
        _persist_bundle(output, bundle)
        return 2 if not identity["complete"] else 3

    runs = []
    for item in scenarios.SYNTHETIC_SUITE:
        if item.get("cancel_after_s") is not None:
            deadline = time.monotonic() + float(item["cancel_after_s"])

            def cancel_check(moment=deadline) -> bool:
                return time.monotonic() >= moment
        else:
            cancel_check = None
        command = [
            sys.executable,
            str(SYNTHETIC_CHILD),
            "--mode",
            item["child_mode"],
            "--out",
            str(output / item["id"]),
        ]
        run = protocol.measure_command(
            item["id"],
            command,
            cwd=HERE,
            output_dir=output,
            sample_interval_s=args.sample_interval,
            cancel_check=cancel_check,
        )
        runs.append(run)

    bundle = _bundle(
        repo=repo,
        output=output,
        identity=identity,
        preflight=preflight,
        runs=runs,
        workload_kind="synthetic",
        exclusive=exclusive,
        mode=args.mode,
    )
    _persist_bundle(output, bundle)
    print(json.dumps({
        "budget_valid": bundle["budget_valid"],
        "validity": bundle["validity"],
        "commands": bundle["commands"],
    }, indent=2))
    if args.formal_budget and not bundle["budget_valid"]:
        return 4
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="R04 repeatable resource measurement harness (synthetic default)"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    identity = sub.add_parser("identity", help="record environment/version/fixture identity")
    identity.add_argument("--repo", default=".")
    identity.add_argument("--out")
    identity.set_defaults(func=cmd_identity)

    preflight = sub.add_parser("preflight", help="classify injected or live process snapshots")
    preflight.add_argument("--process-snapshot-json")
    preflight.add_argument("--out")
    preflight.add_argument("--formal-budget", action="store_true")
    preflight.set_defaults(func=cmd_preflight)

    matrix = sub.add_parser("matrix", help="print old R04 matrix and exclusive-run mapping")
    matrix.set_defaults(func=cmd_matrix)

    measure = sub.add_parser("measure-command", help="sample one command; keep metrics on failure")
    measure.add_argument("--repo", default=".")
    measure.add_argument("--out", required=True)
    measure.add_argument("--name", required=True)
    measure.add_argument("--cwd")
    measure.add_argument("--sample-interval", type=float, default=protocol.SAMPLE_INTERVAL_S)
    measure.add_argument("--process-snapshot-json")
    measure.add_argument("--formal-budget", action="store_true")
    measure.add_argument(
        "--workload-kind",
        choices=("synthetic", "product"),
        default="synthetic",
    )
    measure.add_argument("command", nargs=argparse.REMAINDER)
    measure.set_defaults(func=cmd_measure_command)

    run = sub.add_parser("run", help="synthetic-local suite or exclusive plan")
    run.add_argument("--repo", default=".")
    run.add_argument("--out", required=True)
    run.add_argument("--mode", choices=("synthetic-local", "exclusive"), default="synthetic-local")
    run.add_argument("--sample-interval", type=float, default=0.05)
    run.add_argument("--process-snapshot-json")
    run.add_argument("--formal-budget", action="store_true")
    run.set_defaults(func=cmd_run)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "measure-command":
        command = list(args.command)
        if command and command[0] == "--":
            command = command[1:]
        if not command:
            parser.error("measure-command requires a command after --")
        args.command = command
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
