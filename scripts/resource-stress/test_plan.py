#!/usr/bin/env python3
"""Plan resolution, scene judgment, and refuse paths. No product/Blender load."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import cli  # noqa: E402
import evidence  # noqa: E402
import plan  # noqa: E402
import protocol  # noqa: E402
import scenarios  # noqa: E402
from probes import face_probe, render_probe  # noqa: E402

REPO = HERE.parents[1]
FIXTURES = json.loads((HERE / "behavior_fixtures.json").read_text(encoding="utf-8"))
QUIET_PS = [{"pid": 1, "ppid": 0, "rss_bytes": 1024, "cpu": 0.0, "comm": "init"}]
FOREIGN_PS = QUIET_PS + [{"pid": 999999, "ppid": 1, "rss_bytes": 1024, "cpu": 80.0, "comm": "node"}]


def _clean_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("BEIAN_BLENDER", None)
    return env


def _bound(tmp: Path, **extra):
    kwargs = dict(
        repo=REPO,
        out=tmp / "evidence",
        python=sys.executable,
        node=sys.executable,  # placeholder file that exists; real node tests pass --node
        tsx=HERE / "probes" / "node_argv.mjs",
        blender=None,
    )
    kwargs.update(extra)
    return plan.bindings(**kwargs)


class DispositionAndImport(unittest.TestCase):
    def test_seven_files_disposition(self) -> None:
        expected = {
            "face_probe.py": "adopted",
            "render_probe.py": "adopted",
            "upload-probe.mjs": "adopted",
            "queue-probe.mjs": "adopted",
            "budget-probe.mjs": "adopted",
            "measure.py": "replaced_by_existing",
            "write_report.py": "replaced_by_existing",
        }
        self.assertEqual({name: row["action"] for name, row in plan.HISTORICAL_DISPOSITION.items()}, expected)
        self.assertIsNone(plan.HISTORICAL_DISPOSITION["measure.py"]["in_repo"])
        self.assertIsNone(plan.HISTORICAL_DISPOSITION["write_report.py"]["in_repo"])

    def test_import_does_not_execute_product_or_guess_blender(self) -> None:
        self.assertIn("over-cap", face_probe.CASES)
        with self.assertRaises(SystemExit) as raised:
            render_probe.parse_args([str(REPO), "/tmp/out"], env={})
        self.assertIn("no Mac default", str(raised.exception))
        with self.assertRaises(SystemExit) as missing:
            render_probe.parse_args(
                [str(REPO), "/tmp/out", "/Applications/Blender.app/Contents/MacOS/Blender-not-a-default"],
                env={},
            )
        self.assertIn("not a file", str(missing.exception))


class PlanResolution(unittest.TestCase):
    def setUp(self) -> None:
        self._pymupdf = patch.object(plan, "interpreter_has_module", return_value=True)
        self._pymupdf.start()
        self.addCleanup(self._pymupdf.stop)

    def test_unknown_scene_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bound = _bound(Path(tmp))
            row = plan.resolve_scene("no-such-scene", bound)
        self.assertFalse(row["ok"])
        self.assertIn("unknown_scene", row["reasons"])

    def test_unresolved_placeholder_fails_closed(self) -> None:
        with self.assertRaises(ValueError) as raised:
            plan.interpolate(["echo", "{nope}"], {"repo": "/x"})
        self.assertIn("{nope}", str(raised.exception))

    def test_blender_is_not_guessed_from_path_or_applications(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"BEIAN_BLENDER": ""}, clear=False):
            bound = plan.bindings(repo=REPO, out=Path(tmp) / "out", python=sys.executable)
            self.assertIsNone(bound["blender"])
            row = plan.resolve_scene("blender-serial", bound)
        self.assertFalse(row["ok"])
        self.assertIn("blender_not_specified", row["reasons"])
        self.assertIsNone(row["argv"])
        self.assertNotIn("/Applications/Blender.app", json.dumps(row.get("argv")))

    def test_over_cap_plan_uses_in_repo_probe_without_formal_budget(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dummy_tsx = Path(tmp) / "tsx.mjs"
            dummy_tsx.write_text("export {}\n", encoding="utf-8")
            bound = plan.bindings(
                repo=REPO,
                out=Path(tmp) / "out",
                python=sys.executable,
                node=sys.executable,
                tsx=dummy_tsx,
            )
            row = plan.resolve_scene("over-cap", bound)
        self.assertTrue(row["ok"], row)
        self.assertIn("face_probe.py", " ".join(row["argv"]))
        self.assertNotIn("--formal-budget", row["argv"])
        self.assertEqual(row["budget_eligibility"], "NEVER")
        self.assertFalse(row["this_slice_execute"])
        self.assertFalse(row["runnable"])

    def test_cli_plan_unknown_scene_exits_2(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"BEIAN_BLENDER": ""}, clear=False):
            code = cli.main(["plan", "--repo", str(REPO), "--out", tmp, "--scene", "nope", "--python", sys.executable])
        self.assertEqual(code, 2)

    def test_help_and_plan_do_not_spawn_blender(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch("subprocess.Popen") as popen, patch.dict(
            os.environ, {"BEIAN_BLENDER": ""}, clear=False
        ):
            self.assertEqual(cli.main(["plan", "--repo", str(REPO), "--out", tmp, "--python", sys.executable]), 0)
            with self.assertRaises(SystemExit) as raised:
                cli.main(["--help"])
            self.assertEqual(raised.exception.code, 0)
        popen.assert_not_called()
        self.assertIn("plan", cli.build_parser().format_help())
        render_help = subprocess.run(
            [sys.executable, "-B", str(HERE / "probes/render_probe.py")],
            cwd=REPO,
            env=_clean_env(),
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(render_help.returncode, 0)
        self.assertIn("no Mac /Applications default", render_help.stderr + render_help.stdout)

    def test_missing_tsx_refuses_node_scenes_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.object(plan, "find_tsx", return_value=None):
            bound = plan.bindings(repo=REPO, out=Path(tmp) / "out", python=sys.executable, node=sys.executable)
            upload = plan.resolve_scene("dual-upload", bound)
            normal = plan.resolve_scene("normal", bound)
        self.assertFalse(upload["ok"])
        self.assertIn("missing_tsx", upload["reasons"])
        self.assertTrue(normal["ok"], normal)

    def test_present_tsx_resolves_node_scene_argv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dummy = Path(tmp) / "tsx.mjs"
            dummy.write_text("export {}\n", encoding="utf-8")
            bound = plan.bindings(
                repo=REPO, out=Path(tmp) / "out", python=sys.executable, node=sys.executable, tsx=dummy
            )
            upload = plan.resolve_scene("dual-upload", bound)
        self.assertTrue(upload["ok"], upload)
        self.assertTrue(upload["argv_resolved"])
        self.assertEqual(upload["dependencies_assessed"]["tsx"], True)

    def test_relative_tool_paths_survive_chdir_without_resolving_venv_links(self) -> None:
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bindir = root / "bin"
            bindir.mkdir()
            venv_python = bindir / "python"
            venv_python.symlink_to(sys.executable)
            (bindir / "node").write_text("#!/bin/sh\n", encoding="utf-8")
            (bindir / "tsx.mjs").write_text("export {}\n", encoding="utf-8")
            (bindir / "blender").write_text("#!/bin/sh\n", encoding="utf-8")
            elsewhere = root / "elsewhere"
            elsewhere.mkdir()
            try:
                os.chdir(root)
                bound = plan.bindings(
                    repo=REPO,
                    out=root / "out",
                    python="bin/python",
                    node="bin/node",
                    tsx="bin/tsx.mjs",
                    blender="bin/blender",
                )
                os.chdir(elsewhere)
                self.assertFalse((Path.cwd() / "bin" / "python").exists())
                for key in ("python", "node", "tsx", "blender"):
                    path = bound[key]
                    self.assertTrue(path.is_absolute(), key)
                    self.assertTrue(path.is_file(), key)
                self.assertEqual(bound["python"].name, "python")
                self.assertTrue(bound["python"].is_symlink())
                self.assertNotEqual(bound["python"].resolve(), bound["python"])
                upload = plan.resolve_scene("dual-upload", bound)
                self.assertTrue(upload["ok"], upload)
                self.assertTrue(Path(upload["argv"][0]).is_absolute())
                self.assertTrue(Path(upload["argv"][0]).is_file())
                self.assertIn(str(bound["node"]), upload["argv"])
                self.assertIn(str(bound["tsx"]), upload["argv"])
            finally:
                os.chdir(previous)

    def test_missing_pymupdf_refuses_face_scene(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.object(plan, "interpreter_has_module", return_value=False):
            bound = plan.bindings(repo=REPO, out=Path(tmp) / "out", python=sys.executable)
            row = plan.resolve_scene("over-cap", bound)
        self.assertFalse(row["ok"])
        self.assertIn("missing_pymupdf", row["reasons"])
        self.assertEqual(row["status"], "refused")
        self.assertEqual(row["dependencies_assessed"]["pymupdf"], False)
        self.assertTrue(row["argv_resolved"])
        self.assertIsNone(row["argv"])

    def test_blender_serial_does_not_require_pymupdf(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.object(plan, "interpreter_has_module", return_value=False):
            blender = Path(tmp) / "blender"
            blender.write_text("#!/bin/sh\n", encoding="utf-8")
            bound = plan.bindings(
                repo=REPO, out=Path(tmp) / "out", python=sys.executable, blender=blender
            )
            row = plan.resolve_scene("blender-serial", bound)
        self.assertTrue(row["ok"], row)
        self.assertEqual(row["dependencies_assessed"]["pymupdf"], "not_applicable")
        self.assertIn(str(blender.absolute()), row["argv"])

    def test_relight_plan_points_at_existing_ui_test(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            npm = Path(tmp) / "npm"
            npm.write_text("#!/bin/sh\n", encoding="utf-8")
            bound = plan.bindings(repo=REPO, out=Path(tmp) / "out", python=sys.executable, npm=npm)
            row = plan.resolve_scene("relight", bound)
        self.assertTrue(row["ok"], row)
        self.assertIn("src/pages/mockupStudio.test.ts", row["argv"])
        self.assertTrue((REPO / "apps/web/ui/src/pages/mockupStudio.test.ts").is_file())


class SceneJudgment(unittest.TestCase):
    def test_expected_reject_exit_zero_is_behavior_not_budget(self) -> None:
        spec = {**scenarios.SCENARIO_CONTRACT["over-cap"], "id": "over-cap"}
        run = {"exit_code": 0, "cancelled": False, "samples": [{}], "measurement_errors": []}
        result = {
            "ok": True,
            "case": "over-cap",
            "expected_error": "structure_limit_exceeded",
            "rows": [{"error": "structure_limit_exceeded", "staging_left": []}],
        }
        judgment = evidence.judge_scene(spec, run, result, {"budget_valid": False})
        self.assertTrue(judgment["passed"])
        self.assertTrue(judgment["behavior_ok"])
        self.assertFalse(judgment["budget_effective"])
        self.assertEqual(judgment["fail_close"], [])
        nonzero = evidence.judge_scene(spec, run | {"exit_code": 1}, result, {"budget_valid": False})
        self.assertFalse(nonzero["passed"])
        self.assertIn("unexpected_exit_or_cancel", nonzero["reasons"])

    def test_missing_result_and_wrong_error_and_cleanup_fail(self) -> None:
        spec = {**scenarios.SCENARIO_CONTRACT["over-cap"], "id": "over-cap"}
        run = {"exit_code": 0, "cancelled": False, "samples": [{}], "measurement_errors": []}
        missing = evidence.judge_scene(spec, run, None, {"budget_valid": False})
        self.assertFalse(missing["passed"])
        self.assertIn("missing_result", missing["reasons"])
        wrong = evidence.judge_scene(
            spec,
            run,
            {"ok": True, "case": "over-cap", "expected_error": "other", "rows": [{"error": "other", "staging_left": []}]},
            {"budget_valid": False},
        )
        self.assertIn("error_class_mismatch", wrong["reasons"])
        dirty = evidence.judge_scene(
            spec,
            run,
            {
                "ok": True,
                "case": "over-cap",
                "expected_error": "structure_limit_exceeded",
                "rows": [{"error": "structure_limit_exceeded", "staging_left": [".tmp"]}],
            },
            {"budget_valid": False},
        )
        self.assertIn("cleanup_failed", dirty["reasons"])

    def test_tool_claimed_budget_on_never_class_fail_closes_without_rewriting(self) -> None:
        spec = {**scenarios.SCENARIO_CONTRACT["over-cap"], "id": "over-cap"}
        run = {"exit_code": 0, "cancelled": False, "samples": [{}], "measurement_errors": []}
        result = {
            "ok": True,
            "case": "over-cap",
            "expected_error": "structure_limit_exceeded",
            "rows": [{"error": "structure_limit_exceeded", "staging_left": []}],
        }
        judgment = evidence.judge_scene(spec, run, result, {"budget_valid": True})
        self.assertFalse(judgment["passed"])
        self.assertTrue(judgment["behavior_ok"])
        self.assertIn("tool_claimed_valid_on_never_class", judgment["fail_close"])
        self.assertFalse(judgment["budget_effective"])
        self.assertTrue(judgment["original_budget_valid"])

    def test_measure_command_over_cap_stub_keeps_original_metrics(self) -> None:
        stub = (
            "import json,sys; from pathlib import Path; out=Path(sys.argv[1]); "
            "payload={'ok':True,'case':'over-cap','expected_error':'structure_limit_exceeded',"
            "'rows':[{'error':'structure_limit_exceeded','staging_left':[]}]}; "
            "(out/'result.json').write_text(json.dumps(payload))"
        )
        captured: dict[str, bytes] = {}
        original_measure = protocol.measure_command

        def wrap_measure(name, command, **kwargs):
            run = original_measure(name, command, **kwargs)
            captured["metrics"] = Path(run["metrics_path"]).read_bytes()
            captured["result"] = (Path(kwargs["output_dir"]) / name / "result.json").read_bytes()
            return run

        with tempfile.TemporaryDirectory() as tmp, patch.object(
            protocol, "snapshot_processes", return_value=QUIET_PS
        ), patch.object(protocol, "measure_command", side_effect=wrap_measure):
            out = Path(tmp)
            code = cli.main([
                "measure-command",
                "--repo",
                str(REPO),
                "--out",
                str(out / "ev"),
                "--name",
                "over-cap",
                "--formal-budget",
                "--workload-kind",
                "product",
                "--sample-interval",
                "0.05",
                "--",
                sys.executable,
                "-c",
                stub,
                str(out / "ev" / "over-cap"),
            ])
            metrics = out / "ev" / "over-cap.metrics.json"
            result_path = out / "ev" / "over-cap" / "result.json"
            report = json.loads((out / "ev" / "report.json").read_text(encoding="utf-8"))
            result = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertEqual(code, 4)
            self.assertTrue(report["validity"]["budget_valid"])
            self.assertEqual(report["fail_close"], ["tool_claimed_valid_on_never_class"])
            self.assertFalse(report["budget_effective"])
            self.assertTrue(report["behavior"][0]["behavior_ok"])
            self.assertEqual(metrics.read_bytes(), captured["metrics"])
            self.assertEqual(result_path.read_bytes(), captured["result"])
            self.assertEqual(result["expected_error"], "structure_limit_exceeded")

    def test_formal_budget_foreign_during_run_is_not_valid(self) -> None:
        stub = (
            "import json,sys; from pathlib import Path; out=Path(sys.argv[1]); "
            "payload={'ok':True,'case':'over-cap','expected_error':'structure_limit_exceeded',"
            "'rows':[{'error':'structure_limit_exceeded','staging_left':[]}]}; "
            "(out/'result.json').write_text(json.dumps(payload))"
        )
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            snapshot = out / "snap.json"
            snapshot.write_text(json.dumps(QUIET_PS), encoding="utf-8")
            with patch.object(protocol, "snapshot_processes", return_value=FOREIGN_PS):
                code = cli.main([
                    "measure-command",
                    "--repo", str(REPO), "--out", str(out / "ev"), "--name", "over-cap",
                    "--formal-budget", "--workload-kind", "product",
                    "--process-snapshot-json", str(snapshot),
                    "--sample-interval", "0.05", "--",
                    sys.executable, "-c", stub, str(out / "ev" / "over-cap"),
                ])
            report = json.loads((out / "ev" / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(code, 4)
            self.assertFalse(report["validity"]["budget_valid"])
            self.assertIn("foreign_load_during_run", report["validity"]["reasons"])
            self.assertFalse(report["budget_effective"])

    def test_measure_command_missing_result_fails_and_stops(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            code = cli.main([
                "measure-command",
                "--repo",
                str(REPO),
                "--out",
                str(out),
                "--name",
                "over-cap",
                "--sample-interval",
                "0.05",
                "--",
                sys.executable,
                "-c",
                "pass",
            ])
            self.assertEqual(code, 4)
            report = json.loads((out / "report.json").read_text(encoding="utf-8"))
            self.assertIn("missing_result", report["behavior"][0]["reasons"])
            self.assertFalse(report["behavior_passed"])

    def test_face_probe_stub_expected_reject_and_cleanup(self) -> None:
        class MappingError(Exception):
            def __init__(self, code: str) -> None:
                self.code = code

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)

            def renderer(*_args, **_kwargs):
                raise MappingError("structure_limit_exceeded")

            def pdf_builder(path: Path, _case: str) -> None:
                path.write_bytes(b"%PDF-STUB")

            result = face_probe.execute_case(
                REPO,
                out,
                "over-cap",
                renderer=renderer,
                mapping_error=MappingError,
                pdf_builder=pdf_builder,
            )
            self.assertTrue(result["ok"])
            self.assertEqual(result["expected_error"], "structure_limit_exceeded")

            def dirty(*_args, **_kwargs):
                assets = out / "dirty" / "assets"
                assets.mkdir(parents=True, exist_ok=True)
                (assets / ".staging").write_text("x", encoding="utf-8")
                raise MappingError("structure_limit_exceeded")

            dirty_out = out / "dirty"
            failed = face_probe.execute_case(
                REPO,
                dirty_out,
                "over-cap",
                renderer=dirty,
                mapping_error=MappingError,
                pdf_builder=pdf_builder,
            )
            self.assertFalse(failed["ok"])
            self.assertIn("cleanup_failed", failed["reasons"])

    def test_face_probe_unknown_case_refuses(self) -> None:
        with self.assertRaises(SystemExit) as raised:
            face_probe.parse_args([str(REPO), "/tmp/x", "not-a-case"])
        self.assertIn("unknown face case", str(raised.exception))

    def test_shared_behavior_fixtures(self) -> None:
        for case in FIXTURES["cases"]:
            with self.subTest(case["id"]):
                if "python_scene" in case["judges"]:
                    spec = {**scenarios.SCENARIO_CONTRACT[case["scene"]], "id": case["scene"]}
                    run = case.get("run") or FIXTURES["run"]
                    judgment = evidence.judge_scene(spec, run, case["result"], {"budget_valid": False})
                    if case["expect_pass"]:
                        self.assertTrue(judgment["passed"], (case["id"], judgment["reasons"]))
                    else:
                        self.assertFalse(judgment["passed"], case["id"])
                        self.assertTrue(
                            any(reason in judgment["reasons"] for reason in case["expect_reasons_any"]),
                            (case["id"], judgment["reasons"]),
                        )
                if "face_rows" in case["judges"]:
                    judged = face_probe.judge_rows("over-cap", case["result"]["rows"])
                    if case["expect_pass"]:
                        self.assertTrue(judged["ok"], (case["id"], judged["reasons"]))
                    else:
                        self.assertFalse(judged["ok"], case["id"])
                        self.assertTrue(
                            any(reason in judged["reasons"] for reason in case["expect_reasons_any"]),
                            (case["id"], judged["reasons"]),
                        )

    def test_cli_missing_staging_fails_closed(self) -> None:
        stub = (
            "import json,sys; from pathlib import Path; "
            "p={'ok':True,'case':'over-cap','expected_error':'structure_limit_exceeded',"
            "'rows':[{'error':'structure_limit_exceeded'}]}; "
            "Path(sys.argv[1]).write_text(json.dumps(p))"
        )
        with tempfile.TemporaryDirectory() as tmp, patch.object(protocol, "snapshot_processes", return_value=QUIET_PS):
            out = Path(tmp)
            code = cli.main([
                "measure-command", "--repo", str(REPO), "--out", str(out),
                "--name", "over-cap", "--sample-interval", "0.05", "--",
                sys.executable, "-c", stub, str(out / "over-cap" / "result.json"),
            ])
            report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(code, 4)
        self.assertFalse(report["behavior_passed"])
        self.assertTrue(
            any(reason in report["behavior"][0]["reasons"] for reason in ("cleanup_unproven", "missing_result")),
            report["behavior"][0]["reasons"],
        )

    def test_measure_command_identity_drift_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "synthetic-repo"
            repo.mkdir()
            for rel in protocol.IDENTITY_FILES:
                path = repo / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("0.0.0.0\n" if rel == "VERSION" else "synthetic identity fixture\n")
            def git(*args: str) -> None:
                subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
            git("init", "-q")
            git("add", *protocol.IDENTITY_FILES)
            git("-c", "user.name=Acceptance Fixture", "-c", "user.email=fixture@example.invalid",
                "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                "commit", "-qm", "synthetic identity fixture")
            out = root / "measurement"
            stub = (
                "import json,sys; from pathlib import Path; "
                "Path(sys.argv[1]).write_text('0.0.0.1\\n'); "
                "p={'ok':True,'case':'normal','expected_error':None,'rows':[{'error':None,'staging_left':[]}]}; "
                "Path(sys.argv[2]).write_text(json.dumps(p))"
            )
            captured: dict[str, bytes] = {}
            original_measure = protocol.measure_command

            def wrap_measure(name, command, **kwargs):
                run = original_measure(name, command, **kwargs)
                captured["metrics"] = Path(run["metrics_path"]).read_bytes()
                result_path = Path(kwargs["output_dir"]) / name / "result.json"
                if result_path.is_file():
                    captured["result"] = result_path.read_bytes()
                return run

            with patch.object(protocol, "snapshot_processes", return_value=QUIET_PS), patch.object(
                protocol, "measure_command", side_effect=wrap_measure
            ):
                code = cli.main([
                    "measure-command", "--repo", str(repo), "--out", str(out), "--name", "normal",
                    "--sample-interval", "0.05", "--",
                    sys.executable, "-c", stub, str(repo / "VERSION"), str(out / "normal" / "result.json"),
                ])
            report = json.loads((out / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(code, 4)
            self.assertIn("identity_after", report)
            self.assertFalse(report["identity_unchanged"])
            self.assertFalse(report["behavior_passed"])
            self.assertNotEqual(report["identity"]["version"], report["identity_after"]["version"])
            self.assertEqual(report["identity"]["version"], "0.0.0.0")
            saved_identity = json.loads((out / "identity.json").read_text(encoding="utf-8"))
            self.assertEqual(saved_identity["version"], "0.0.0.0")
            self.assertEqual((out / "normal.metrics.json").read_bytes(), captured["metrics"])
            self.assertEqual((out / "normal" / "result.json").read_bytes(), captured["result"])

    def test_cli_budget_unhashable_mode_fails_with_report(self) -> None:
        payload = {
            "ok": True,
            "rows": [
                {"mode": [], "cause": None, "remaining_after_release": 0},
                {"mode": "disk-exhaustion", "cause": "disk_budget", "remaining_after_release": 0},
                {"mode": "cancel", "cause": "cancelled", "remaining_after_release": 0},
                {"mode": "ownership-unknown", "cause": None, "remaining_after_release": 0},
            ],
        }
        stub = (
            "import json,sys; from pathlib import Path; "
            "Path(sys.argv[1]).write_text(sys.argv[2])"
        )
        captured: dict[str, bytes] = {}
        original_measure = protocol.measure_command

        def wrap_measure(name, command, **kwargs):
            run = original_measure(name, command, **kwargs)
            captured["metrics"] = Path(run["metrics_path"]).read_bytes()
            captured["result"] = (Path(kwargs["output_dir"]) / name / "result.json").read_bytes()
            return run

        with tempfile.TemporaryDirectory() as tmp, patch.object(
            protocol, "snapshot_processes", return_value=QUIET_PS
        ), patch.object(protocol, "measure_command", side_effect=wrap_measure):
            out = Path(tmp)
            code = cli.main([
                "measure-command", "--repo", str(REPO), "--out", str(out),
                "--name", "fail-cancel", "--sample-interval", "0.05", "--",
                sys.executable, "-c", stub, str(out / "fail-cancel" / "result.json"), json.dumps(payload),
            ])
            report_path = out / "report.json"
            self.assertTrue(report_path.is_file())
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertNotEqual(code, 0)
            self.assertFalse(report["behavior_passed"])
            self.assertEqual((out / "fail-cancel.metrics.json").read_bytes(), captured["metrics"])
            self.assertEqual((out / "fail-cancel" / "result.json").read_bytes(), captured["result"])

    def test_generic_measure_command_failure_is_not_behavior_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.object(protocol, "snapshot_processes", return_value=QUIET_PS):
            out = Path(tmp)
            code = cli.main([
                "measure-command", "--repo", str(REPO), "--out", str(out),
                "--name", "demo", "--sample-interval", "0.05", "--",
                sys.executable, "-c", "raise SystemExit(7)",
            ])
            report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(code, 7)
        self.assertTrue(report["identity_unchanged"])
        self.assertIsNot(report.get("behavior_passed"), True)
        self.assertEqual(report["commands"][0]["exit_code"], 7)

    def test_generic_measure_command_success_cancel_and_sampler(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.object(protocol, "snapshot_processes", return_value=QUIET_PS):
            out = Path(tmp)
            ok = cli.main([
                "measure-command", "--repo", str(REPO), "--out", str(out / "ok"),
                "--name", "demo", "--sample-interval", "0.05", "--",
                sys.executable, "-c", "pass",
            ])
            success = json.loads((out / "ok" / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(ok, 0)
        self.assertTrue(success["identity_unchanged"])
        self.assertTrue(success["behavior_passed"])

        def fake_run(*, cancelled: bool, errors: list[str], directory: Path) -> dict:
            metrics = directory / "demo.metrics.json"
            metrics.write_text("{}", encoding="utf-8")
            return {
                "name": "demo",
                "command": [sys.executable, "-c", "pass"],
                "cwd": str(REPO),
                "exit_code": 0,
                "seconds": 0.01,
                "cancelled": cancelled,
                "samples": [{}],
                "measurement_errors": errors,
                "launch_error": None,
                "metrics_path": str(metrics),
            }

        with tempfile.TemporaryDirectory() as tmp, patch.object(protocol, "snapshot_processes", return_value=QUIET_PS):
            out = Path(tmp)
            with patch.object(protocol, "measure_command", return_value=fake_run(cancelled=True, errors=[], directory=out)):
                code = cli.main([
                    "measure-command", "--repo", str(REPO), "--out", str(out),
                    "--name", "demo", "--", sys.executable, "-c", "pass",
                ])
            report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(code, 4)
        self.assertIsNot(report.get("behavior_passed"), True)

        with tempfile.TemporaryDirectory() as tmp, patch.object(protocol, "snapshot_processes", return_value=QUIET_PS):
            out = Path(tmp)
            with patch.object(
                protocol, "measure_command", return_value=fake_run(cancelled=False, errors=["ps failed"], directory=out)
            ):
                code = cli.main([
                    "measure-command", "--repo", str(REPO), "--out", str(out),
                    "--name", "demo", "--", sys.executable, "-c", "pass",
                ])
            report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(code, 4)
        self.assertIsNot(report.get("behavior_passed"), True)

    def _write_face_result_stub(self, case: str) -> tuple[str, str]:
        payload = {
            "ok": True,
            "case": case,
            "expected_error": None,
            "rows": [{"error": None, "staging_left": []}],
        }
        return (
            "import json,sys; from pathlib import Path; "
            "Path(sys.argv[1]).write_text(sys.argv[2])"
        ), json.dumps(payload)

    def test_cli_near_cap_rejects_normal_size_result(self) -> None:
        stub, payload = self._write_face_result_stub("normal")
        with tempfile.TemporaryDirectory() as tmp, patch.object(protocol, "snapshot_processes", return_value=QUIET_PS):
            out = Path(tmp)
            code = cli.main([
                "measure-command", "--repo", str(REPO), "--out", str(out),
                "--name", "near-cap", "--sample-interval", "0.05", "--",
                sys.executable, "-c", stub, str(out / "near-cap" / "result.json"), payload,
            ])
            report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(code, 4)
        self.assertFalse(report["behavior_passed"])
        self.assertIn("case_mismatch", report["behavior"][0]["reasons"])

    def test_cli_near_cap_accepts_matching_case(self) -> None:
        stub, payload = self._write_face_result_stub("near-cap")
        with tempfile.TemporaryDirectory() as tmp, patch.object(protocol, "snapshot_processes", return_value=QUIET_PS):
            out = Path(tmp)
            code = cli.main([
                "measure-command", "--repo", str(REPO), "--out", str(out),
                "--name", "near-cap", "--sample-interval", "0.05", "--",
                sys.executable, "-c", stub, str(out / "near-cap" / "result.json"), payload,
            ])
            report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertTrue(report["behavior_passed"])
        self.assertTrue(report["behavior"][0]["passed"])
        self.assertNotIn("case_mismatch", report["behavior"][0]["reasons"])


if __name__ == "__main__":
    unittest.main()
