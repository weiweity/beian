#!/usr/bin/env python3
"""Repeatable R04 resource-measurement CLI. Synthetic by default; no product load."""

from __future__ import annotations

import argparse
import json
import hashlib
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import protocol  # noqa: E402
import scenarios  # noqa: E402
import evidence  # noqa: E402
import plan  # noqa: E402

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
        "historical_disposition": plan.HISTORICAL_DISPOSITION,
        "note": (
            "exclusive_command still contains placeholders; "
            "`plan` resolves argv. This command does not start Blender/browsers/probes"
        ),
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def _plan_bindings(args: argparse.Namespace, repo: Path, output: Path) -> dict:
    return plan.bindings(
        repo=repo,
        out=output,
        python=getattr(args, "python", None) or sys.executable,
        node=getattr(args, "node", None),
        npm=getattr(args, "npm", None),
        tsx=getattr(args, "tsx", None),
        blender=getattr(args, "blender", None) or plan.env_blender(),
    )


def cmd_plan(args: argparse.Namespace) -> int:
    repo = Path(args.repo)
    output = Path(args.out)
    payload = plan.resolve_plan(_plan_bindings(args, repo, output), scene_id=args.scene)
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    if args.out_json:
        _write_json(Path(args.out_json), payload)
    if args.scene:
        return 0 if payload["scenes"] and payload["scenes"][0]["ok"] else 2
    if args.strict and not payload["all_ok"]:
        return 2
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
    identity_after = protocol.collect_identity(repo)
    identity_unchanged = identity_after == identity
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
    bundle["identity_after"] = identity_after
    bundle["identity_unchanged"] = identity_unchanged
    metrics_path = Path(run["metrics_path"]) if run.get("metrics_path") else None
    original_metrics = metrics_path.read_bytes() if metrics_path and metrics_path.is_file() else None
    spec = scenarios.SCENARIO_CONTRACT.get(args.name)
    judgment = None
    if spec is not None:
        spec_with_id = {**spec, "id": args.name}
        result_payload = evidence.read_result_json(output, args.name)
        judgment = evidence.judge_scene(spec_with_id, run, result_payload, bundle["validity"])
        bundle["behavior"] = [judgment]
        bundle["behavior_passed"] = judgment["passed"] is True and identity_unchanged is True
        bundle["fail_close"] = judgment["fail_close"]
        bundle["budget_effective"] = False
    else:
        bundle["budget_effective"] = False
        bundle["behavior_passed"] = identity_unchanged is True
    _persist_bundle(output, bundle)
    if original_metrics is not None and metrics_path is not None and metrics_path.read_bytes() != original_metrics:
        return 4
    if identity_unchanged is not True:
        return 4
    if judgment is not None and (judgment["fail_close"] or not judgment["passed"]):
        return 4
    if args.formal_budget and not bundle["budget_valid"]:
        return 4
    if run.get("measurement_errors"):
        return 4
    code = run.get("exit_code")
    return (128 - code if code < 0 else code) if isinstance(code, int) else 4


def cmd_run(args: argparse.Namespace) -> int:
    if args.repeat is not None:
        return cmd_repeat(args)
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
        bundle["resolved_plan"] = plan.resolve_plan(_plan_bindings(args, repo, output))
        bundle["budget_effective"] = False
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
    judgments = []
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
        judgment = evidence.judge_synthetic(item, run)
        judgments.append(judgment)
        if not judgment["passed"]:
            break

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
    bundle["behavior"] = judgments
    bundle["identity_after"] = protocol.collect_identity(repo)
    bundle["identity_unchanged"] = bundle["identity_after"] == identity
    bundle["behavior_passed"] = len(judgments) == len(scenarios.SYNTHETIC_SUITE) and all(
        j["passed"] for j in judgments
    )
    bundle["budget_effective"] = False
    _persist_bundle(output, bundle)
    print(json.dumps({
        "budget_valid": bundle["budget_valid"],
        "validity": bundle["validity"],
        "commands": bundle["commands"],
    }, indent=2))
    if not bundle["behavior_passed"] or not bundle["identity_unchanged"] or (args.formal_budget and not bundle["budget_valid"]):
        return 4
    return 0


def cmd_repeat(args: argparse.Namespace) -> int:
    output = Path(args.out).resolve()
    _outside_repo(Path(args.repo), output)
    try:
        output.mkdir()  # Exclusive creation; never reuse another run's evidence root.
    except FileExistsError:
        print("REFUSE_EXISTING_OUTPUT", file=sys.stderr)
        return 3
    rounds = []
    for number in range(1, args.repeat + 1):
        round_dir = output / f"round{number}"
        round_dir.mkdir()
        one = argparse.Namespace(**vars(args) | {"repeat": None, "out": str(round_dir)})
        code = cmd_run(one)
        report_path = round_dir / "report.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        if rounds and report["identity"] != rounds[0]["identity"]:
            code = 4
        rounds.append({
            "round": number,
            "exit_code": code,
            "behavior_passed": report.get("behavior_passed") is True,
            "report_path": str(report_path),
            "identity": report["identity"],
            "identity_unchanged": report["identity_unchanged"],
            "report_sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(),
            "metrics": [{"path": run["metrics_path"], "sha256": hashlib.sha256(
                Path(run["metrics_path"]).read_bytes()).hexdigest()} for run in report["runs"]],
            "runs": report["runs"],
        })
        summary = evidence.summarize_rounds(rounds, args.repeat)
        _write_json(output / "aggregate.json", summary)
        if code != 0:
            return code
    return 0 if summary["behavior_passed"] else 4


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

    planned = sub.add_parser("plan", help="resolve matrix argv; never executes product or native apps")
    planned.add_argument("--repo", default=".")
    planned.add_argument("--out", required=True)
    planned.add_argument("--python")
    planned.add_argument("--node")
    planned.add_argument("--npm")
    planned.add_argument("--tsx")
    planned.add_argument("--blender", help="explicit Blender executable; never guessed from /Applications")
    planned.add_argument("--scene", help="resolve one scene; unknown ids fail closed")
    planned.add_argument("--out-json", help="optional path to persist the plan JSON")
    planned.add_argument("--strict", action="store_true", help="exit 2 if any scene is refused")
    planned.set_defaults(func=cmd_plan)

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
    run.add_argument("--repeat", type=int, help="1–100 synthetic rounds in an exclusively new output root")
    run.add_argument("--python")
    run.add_argument("--node")
    run.add_argument("--npm")
    run.add_argument("--tsx")
    run.add_argument("--blender", help="explicit Blender executable for exclusive plan; never guessed")
    run.set_defaults(func=cmd_run)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "run" and args.repeat is not None:
        if not 1 <= args.repeat <= 100 or args.mode != "synthetic-local" or args.formal_budget:
            parser.error("--repeat requires 1–100 rounds of non-formal synthetic-local mode")
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
