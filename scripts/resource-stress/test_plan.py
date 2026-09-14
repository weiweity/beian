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
import scenarios  # noqa: E402
from probes import face_probe, render_probe  # noqa: E402

REPO = HERE.parents[1]


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
        with tempfile.TemporaryDirectory() as tmp:
            bound = plan.bindings(repo=REPO, out=Path(tmp) / "out", python=sys.executable, node=sys.executable)
            upload = plan.resolve_scene("dual-upload", bound)
            normal = plan.resolve_scene("normal", bound)
        self.assertFalse(upload["ok"])
        self.assertIn("missing_tsx", upload["reasons"])
        self.assertTrue(normal["ok"], normal)


class SceneJudgment(unittest.TestCase):
    def test_expected_reject_exit_zero_is_behavior_not_budget(self) -> None:
        spec = {**scenarios.SCENARIO_CONTRACT["over-cap"], "id": "over-cap"}
        run = {"exit_code": 0, "cancelled": False, "samples": [{}], "measurement_errors": []}
        result = {
            "ok": True,
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
            {"ok": True, "expected_error": "other", "rows": [{"error": "other", "staging_left": []}]},
            {"budget_valid": False},
        )
        self.assertIn("error_class_mismatch", wrong["reasons"])
        dirty = evidence.judge_scene(
            spec,
            run,
            {
                "ok": True,
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
            "payload={'ok':True,'expected_error':'structure_limit_exceeded',"
            "'rows':[{'error':'structure_limit_exceeded','staging_left':[]}]}; "
            "(out/'result.json').write_text(json.dumps(payload))"
        )
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            snapshot = out / "snap.json"
            snapshot.write_text(json.dumps([{"pid": 1, "ppid": 0, "rss_bytes": 1024, "cpu": 0.0, "comm": "init"}]))
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
                "--process-snapshot-json",
                str(snapshot),
                "--sample-interval",
                "0.05",
                "--",
                sys.executable,
                "-c",
                stub,
                str(out / "ev" / "over-cap"),
            ])
            metrics = out / "ev" / "over-cap.metrics.json"
            original = metrics.read_bytes()
            report = json.loads((out / "ev" / "report.json").read_text(encoding="utf-8"))
            result = json.loads((out / "ev" / "over-cap" / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(code, 4)
            self.assertTrue(report["validity"]["budget_valid"])
            self.assertEqual(report["fail_close"], ["tool_claimed_valid_on_never_class"])
            self.assertFalse(report["budget_effective"])
            self.assertTrue(report["behavior"][0]["behavior_ok"])
            self.assertEqual(metrics.read_bytes(), original)
            self.assertEqual(result["expected_error"], "structure_limit_exceeded")

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


if __name__ == "__main__":
    unittest.main()
