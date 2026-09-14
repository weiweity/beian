"""Ship audit gaps: synthetic inputs only, no product/native/browser execution."""

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import cli
import evidence
import plan
import protocol
import scenarios
import q05_receipt
import test_q05_receipt
from probes import face_probe, render_probe


class ShipCoverage(unittest.TestCase):
    def test_plan_strict_persists_refusals_without_launching_workload(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bound = {
                "repo": root, "out": root / "out", "python": Path(sys.executable),
                "node": None, "npm": None, "tsx": None, "blender": None,
                "probe_dir": root / "absent", "python_modules": {"pymupdf": False},
                "binding_reasons": [],
            }
            destination = root / "plan.json"
            with patch.object(cli, "_plan_bindings", return_value=bound), \
                    patch.object(protocol, "measure_command") as launch, \
                    contextlib.redirect_stdout(io.StringIO()):
                code = cli.main(["plan", "--out", str(root / "out"), "--strict",
                                 "--out-json", str(destination)])
            self.assertEqual(code, 2)
            launch.assert_not_called()
            result = json.loads(destination.read_text())
            self.assertFalse(result["all_ok"])
            self.assertEqual(len(result["refused"]), len(scenarios.SCENARIOS))
            by_id = {row["id"]: row for row in result["scenes"]}
            self.assertIn("missing_node", by_id["dual-upload"]["reasons"])
            self.assertIn("missing_npm", by_id["relight"]["reasons"])
            self.assertIn("missing_probe", by_id["normal"]["reasons"])
            self.assertTrue(all(row["argv"] is None for row in result["scenes"]))

    def test_interpreter_lookup_timeout_and_launch_error_refuse(self):
        for failure in (OSError("fixture executable unavailable"),
                        subprocess.TimeoutExpired("fixture python", 10)):
            with self.subTest(failure=type(failure).__name__), \
                    patch.object(plan.subprocess, "run", side_effect=failure):
                self.assertFalse(plan.interpreter_has_module(Path("/fixture/python"), "pymupdf"))
        for code in (0, 1):
            with patch.object(plan.subprocess, "run", return_value=SimpleNamespace(returncode=code)):
                self.assertEqual(plan.interpreter_has_module(Path("/fixture/python"), "pymupdf"), code == 0)

    def test_corrupt_result_files_are_missing_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scene = root / "over-cap"
            scene.mkdir()
            self.assertIsNone(evidence.read_result_json(root, "over-cap"))
            for raw in ("{", "[]", "null", '"text"'):
                with self.subTest(raw=raw):
                    (scene / "result.json").write_text(raw)
                    result = evidence.read_result_json(root, "over-cap")
                    self.assertIsNone(result)
                    judgment = evidence.judge_scene(scenarios.SCENARIO_CONTRACT["over-cap"],
                        {"exit_code": 0, "cancelled": False, "samples": [{}]}, result)
                    self.assertFalse(judgment["passed"])
                    self.assertIn("missing_result", judgment["reasons"])
                    self.assertEqual((scene / "result.json").read_text(), raw)

    def test_aggregate_invalid_measurements_and_failed_rounds_do_not_become_statistics(self):
        rounds = [
            {"exit_code": 0, "behavior_passed": True, "runs": [
                {"name": "ok", "seconds": 2, "peak_tree_rss_bytes": 0},
                {"name": "invalid", "seconds": True, "peak_tree_rss_bytes": float("nan")}]},
            {"exit_code": 0, "behavior_passed": True, "runs": [
                {"name": "ok", "seconds": 4, "peak_tree_rss_bytes": 8},
                {"name": "invalid", "seconds": -1, "peak_tree_rss_bytes": float("inf")}]},
            {"exit_code": 4, "behavior_passed": False, "runs": [
                {"name": "ok", "seconds": 999, "peak_tree_rss_bytes": 999}]},
        ]
        result = evidence.summarize_rounds(rounds, 4)
        self.assertFalse(result["behavior_passed"])
        self.assertFalse(result["budget_valid"])
        self.assertEqual(result["summary"]["ok"]["seconds"],
                         {"status": "observed", "count": 2, "min": 2, "median": 3, "max": 4})
        for field in result["summary"]["invalid"].values():
            self.assertEqual(field, {"status": "not_assessed", "count": 0,
                                     "min": None, "median": None, "max": None})
        self.assertEqual(result["rounds"], rounds)

    def test_repeat_cross_round_drift_retains_failed_round_and_stops_before_third(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "new"
            calls = []

            def run_round(args):
                calls.append(args.out)
                root = Path(args.out)
                report = {"identity": {"head": str(len(calls))}, "identity_unchanged": True,
                          "behavior_passed": True, "runs": []}
                (root / "report.json").write_text(json.dumps(report))
                return 0

            args = cli.build_parser().parse_args(["run", "--repo", str(HERE),
                                                 "--out", str(output), "--repeat", "3"])
            with patch.object(cli, "cmd_run", side_effect=run_round):
                self.assertEqual(cli.cmd_repeat(args), 4)
            result = json.loads((output / "aggregate.json").read_text())
            self.assertEqual(len(calls), 2)
            self.assertFalse((output / "round3").exists())
            self.assertEqual([row["exit_code"] for row in result["rounds"]], [0, 4])
            self.assertFalse(result["behavior_passed"])
            self.assertTrue(all(len(row["report_sha256"]) == 64 for row in result["rounds"]))

    def test_face_success_paper_failure_and_repeat_use_resolved_inputs(self):
        for case in ("normal", "exact-cap-paper", "failure-after-front", "repeat"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)
                seen = []

                class MappingError(Exception):
                    code = "artwork_transform_invalid"

                def renderer(pdf, resolved, assets, **kwargs):
                    seen.append(resolved)
                    self.assertEqual(kwargs, {"raster_width_px": 256})
                    self.assertEqual(pdf.read_bytes(), b"synthetic")
                    if case == "failure-after-front":
                        self.assertEqual(resolved["faces"]["back"], {})
                        raise MappingError()
                    return {"front": {"width": 256}}

                result = face_probe.execute_case(out, out / "run", case, renderer=renderer,
                    mapping_error=MappingError, pdf_builder=lambda path, _: path.write_bytes(b"synthetic"))
                self.assertTrue(result["ok"], result)
                self.assertEqual(len(seen), 8 if case == "repeat" else 1)
                if case == "exact-cap-paper":
                    self.assertTrue(all(face == {"paper_only": True} for face in seen[0]["faces"].values()))
                self.assertEqual(json.loads((out / "run/result.json").read_text()), result)

    def test_render_result_success_and_failure_are_persisted_and_exit_distinctly(self):
        for status, expected in (("pass", 0), ("fail", 1), ("not-run", 1)):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                report = {"quality_layers": {"runtime_hard": {"status": status}}, "fixtures": ["stub"]}
                result = render_probe.execute(root, root / "out", root / "unused-blender",
                                             eval_runner=lambda **_: report)
                self.assertEqual(result["ok"], expected == 0)
                self.assertEqual(json.loads((root / "out/result.json").read_text()), result)
                with patch.object(render_probe, "parse_args", return_value=(root, root, root)), \
                        patch.object(render_probe, "execute", return_value=result), \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(render_probe.main([]), expected)

    def test_render_default_adapter_forwards_two_fixtures_without_updating_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module = SimpleNamespace(load_fixture_manifest=lambda: "fixture-manifest",
                fixture_by_id=lambda manifest, key: (manifest, key))
            with patch.object(render_probe, "load_eval_module", return_value=module), \
                    patch.object(module, "run_eval", create=True,
                                 return_value={"quality_layers": {"runtime_hard": {"status": "pass"}}}) as run:
                self.assertTrue(render_probe.execute(root, root / "out", root / "stub-blender")["ok"])
            self.assertEqual(run.call_args.kwargs["fixtures"], [
                ("fixture-manifest", "rf00-tall-carton"), ("fixture-manifest", "rf00-wide-carton")])
            self.assertFalse(run.call_args.kwargs["update_baseline"])
            self.assertTrue(run.call_args.kwargs["render_blender"])
            self.assertEqual(run.call_args.kwargs["blender_executable"], root / "stub-blender")
            with self.assertRaisesRegex(SystemExit, "missing render_quality_eval"):
                render_probe.load_eval_module(root)

    def test_q05_cross_round_identity_or_command_drift_stops_before_command_two(self):
        for mutation in ("identity", "command"):
            with self.subTest(mutation=mutation):
                fixture = test_q05_receipt.RunnerGate()
                fixture.setUp()
                try:
                    script = fixture.stubbed_runner(receipt_exit=0)
                    if mutation == "identity":
                        stub = script.with_name("q05_receipt.py")
                        stub.write_text(stub.read_text().replace(".write_text('{}')",
                            ".write_text(json.dumps({'round': pathlib.Path(args[args.index('--output-file')+1]).parent.name}))"))
                    else:
                        fixture.command.write_text('printf "# changed\\n" >> "$Q05_ROUND_CMD_FILE"\n')
                    result = fixture.run_script(script)
                    self.assertEqual(result.returncode, 5, result.stderr)
                    self.assertIn("ROUND_IDENTITY_CHANGED", result.stderr)
                    self.assertTrue((fixture.out / "round1/exitcode").exists())
                    self.assertFalse((fixture.out / "round2/exitcode").exists())
                    self.assertFalse((fixture.out / "round3").exists())
                finally:
                    fixture.doCleanups()

    def test_q05_malformed_nested_sidecar_fails_without_altering_raw_payload(self):
        fixture = test_q05_receipt.ReceiptGate()
        fixture.setUp()
        try:
            fixture.identity["manifest"] = {"indexHtml": "synthetic", "assets": ["invalid"]}
            fixture.sidecar.write_text(json.dumps(fixture.identity))
            original = fixture.raw.read_bytes()
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(fixture.run_receipt(), 5)
            self.assertEqual(fixture.raw.read_bytes(), original)
            self.assertFalse((fixture.round / "round-receipt.json").exists())
        finally:
            fixture.doCleanups()


if __name__ == "__main__":
    unittest.main()
