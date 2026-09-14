#!/usr/bin/env python3
"""Regression for the R04 measurement harness. No product/Blender/browser load."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import cli  # noqa: E402
import protocol  # noqa: E402
import scenarios  # noqa: E402
import evidence  # noqa: E402

REPO = HERE.parents[1]
CHILD = HERE / "synthetic_child.py"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_file(path: Path, timeout_s: float = 5.0) -> str:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if path.is_file() and path.stat().st_size:
            return path.read_text(encoding="utf-8").strip()
        time.sleep(0.05)
    raise AssertionError(f"missing {path}")


def _wait_gone(pid: int, timeout_s: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not _alive(pid):
            return
        time.sleep(0.05)
    raise AssertionError(f"pid {pid} still alive")


def _row(pid: int, ppid: int, rss_kb: int, cpu: float, comm: str, **extra) -> dict:
    row = {"pid": pid, "ppid": ppid, "rss_bytes": rss_kb * 1024, "cpu": cpu, "comm": comm}
    row.update(extra)
    return row


class ParseAndDetect(unittest.TestCase):
    def test_parse_ps_table(self) -> None:
        text = "  10  1  100  0.0 /sbin/launchd\n  99  10  2048  51.5 Google Chrome\n"
        rows = protocol.parse_ps_table(text)
        self.assertEqual(rows[0]["pid"], 10)
        self.assertEqual(rows[1]["rss_bytes"], 2048 * 1024)
        self.assertEqual(rows[1]["comm"], "Google Chrome")

    def test_process_tree_and_rss_sum(self) -> None:
        rows = [
            _row(1, 0, 10, 0, "init"),
            _row(10, 1, 20, 0, "harness"),
            _row(11, 10, 30, 0, "child"),
            _row(12, 11, 40, 0, "grand"),
            _row(99, 1, 999, 0, "other"),
        ]
        owned = protocol.process_tree(rows, 10)
        self.assertEqual(owned, {10, 11, 12})
        self.assertEqual(protocol.tree_rss_bytes(rows, owned), (20 + 30 + 40) * 1024)

    def test_injected_blender_is_foreign_unless_owned(self) -> None:
        rows = [_row(1, 0, 1, 0, "init"), _row(50, 1, 8, 3.0, "blender")]
        foreign = protocol.classify_foreign(rows, {1}, self_pid=1)
        self.assertEqual([item["pid"] for item in foreign], [50])
        owned = protocol.classify_foreign(rows, {1, 50}, self_pid=1)
        self.assertEqual(owned, [])

    def test_cpu_threshold_matches_old_protocol(self) -> None:
        quiet = [_row(1, 0, 1, 0, "init"), _row(8, 1, 8, 49.0, "Google Chrome")]
        loud = [_row(1, 0, 1, 0, "init"), _row(8, 1, 8, 51.0, "Google Chrome")]
        self.assertEqual(protocol.classify_foreign(quiet, {1}, 1), [])
        self.assertEqual(protocol.classify_foreign(loud, {1}, 1)[0]["pid"], 8)
        for comm in ("python3", "node", "Adobe Illustrator"):
            rows = [_row(1, 0, 1, 0, "init"), _row(9, 1, 8, 80.0, comm)]
            self.assertTrue(protocol.classify_foreign(rows, {1}, 1), comm)

    def test_preflight_refuses_formal_budget(self) -> None:
        rows = [_row(1, 0, 1, 0, "init"), _row(7, 1, 8, 1.0, "Blender")]
        pre = protocol.preflight_from_rows(rows, owned_pids={1}, self_pid=1)
        self.assertFalse(pre["budget_eligible"])
        self.assertIn("foreign_render_or_stress_load", pre["reasons"])

    def test_other_harness_via_command_text(self) -> None:
        rows = [
            _row(1, 0, 1, 0, "init"),
            _row(4, 1, 8, 1.0, "python3", command="python3 scripts/resource-stress/cli.py run"),
        ]
        foreign = protocol.classify_foreign(rows, {1}, 1)
        self.assertEqual(foreign[0]["pid"], 4)


class IdentityHeadroomValidity(unittest.TestCase):
    def test_missing_identity_is_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            identity = protocol.collect_identity(Path(tmp))
        self.assertFalse(identity["complete"])
        self.assertTrue(identity["missing"])

    def test_repo_identity_complete(self) -> None:
        identity = protocol.collect_identity(REPO)
        self.assertTrue(identity["complete"], identity["missing"])
        self.assertEqual(identity["head"], subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip())
        self.assertEqual(identity["version"], (REPO / "VERSION").read_text().strip())
        self.assertIn("VERSION", identity["files"])

    def test_validity_true_only_when_all_facts_hold(self) -> None:
        good = protocol.budget_validity(
            identity={"complete": True},
            preflight={"budget_eligible": True},
            runs=[{"foreign_load": [], "exit_code": 0, "samples": [{}]}],
            workload_kind="product",
            exclusive=True,
        )
        self.assertTrue(good["budget_valid"])
        missing = protocol.budget_validity(
            identity={"complete": False},
            preflight={"budget_eligible": True},
            runs=[{"foreign_load": [], "exit_code": 0, "samples": [{}]}],
            workload_kind="product",
            exclusive=True,
        )
        self.assertFalse(missing["budget_valid"])
        self.assertIn("identity_incomplete", missing["reasons"])
        noisy = protocol.budget_validity(
            identity={"complete": True},
            preflight={"budget_eligible": True},
            runs=[{"foreign_load": [{"t": 0.1}]}],
            workload_kind="product",
            exclusive=True,
        )
        self.assertIn("foreign_load_during_run", noisy["reasons"])
        synthetic = protocol.budget_validity(
            identity={"complete": True},
            preflight={"budget_eligible": True},
            runs=[{"foreign_load": [], "exit_code": 0, "samples": [{}]}],
            workload_kind="synthetic",
            exclusive=True,
        )
        self.assertIn("synthetic_workload", synthetic["reasons"])

    def test_headroom_unavailable_when_not_observable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            disk = protocol.disk_available(path)
            self.assertEqual(disk["status"], "observed")
            self.assertGreater(disk["available_bytes"], 0)
            memory = protocol.memory_available(sysconf=lambda _name: (_ for _ in ()).throw(ValueError("nope")))
            self.assertEqual(memory["status"], "unavailable")
            self.assertNotIn("available_bytes", memory)

    def test_32mp_is_not_memory_budget(self) -> None:
        self.assertEqual(protocol.PIXEL_CAP["maximum_face_pixels"], 32_000_000)
        self.assertFalse(protocol.PIXEL_CAP["is_process_memory_budget"])


class MeasureLifecycle(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def _measure(self, name: str, mode: str, **kwargs):
        extra = []
        if "sleep" in kwargs:
            extra += ["--sleep", str(kwargs.pop("sleep"))]
        command = [sys.executable, str(CHILD), "--mode", mode, "--out", str(self.out / name), *extra]
        return protocol.measure_command(
            name,
            command,
            cwd=HERE,
            output_dir=self.out,
            sample_interval_s=0.05,
            **kwargs,
        )

    def test_success_keeps_metrics_without_rss_threshold(self) -> None:
        run = self._measure("synthetic-success", "success")
        self.assertEqual(run["exit_code"], 0)
        self.assertFalse(run["cancelled"])
        self.assertIsInstance(run["samples"], list)
        self.assertGreaterEqual(run["peak_tree_rss_bytes"], 0)
        self.assertIn("not an absolute peak", run["peak_rss_note"])
        self.assertTrue((self.out / "synthetic-success.metrics.json").is_file())
        self.assertGreaterEqual(run["disk_delta"]["logical"], 0)
        self.assertTrue((self.out / "synthetic-success" / "payload.bin").is_file())

    def test_failure_keeps_metrics_and_exit_code(self) -> None:
        run = self._measure("synthetic-fail", "fail")
        self.assertEqual(run["exit_code"], 7)
        payload = json.loads((self.out / "synthetic-fail.metrics.json").read_text(encoding="utf-8"))
        self.assertEqual(payload["exit_code"], 7)
        self.assertIn("samples", payload)

    def test_cancel_reaps_owned_not_decoy(self) -> None:
        decoy = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            start_new_session=True,
        )
        self.addCleanup(lambda: decoy.poll() is None and protocol.stop_owned_group(decoy.pid, grace_s=0))
        started = time.monotonic()

        def cancel() -> bool:
            return time.monotonic() >= started + 0.2

        run = self._measure("synthetic-cancel", "hang", cancel_check=cancel)
        self.assertTrue(run["cancelled"])
        pid_text = (self.out / "synthetic-cancel" / "child_pid.txt").read_text(encoding="utf-8").strip()
        _wait_gone(int(pid_text))
        self.assertTrue(_alive(decoy.pid), "harness must not kill unrelated processes")
        protocol.stop_owned_group(decoy.pid, grace_s=0)
        decoy.wait(timeout=2)

    def test_sampling_wraps_up(self) -> None:
        run = self._measure("wrap", "success")
        self.assertIsNotNone(run["after"])
        metrics = self.out / "wrap.metrics.json"
        stdout = self.out / "wrap.stdout.log"
        self.assertTrue(metrics.is_file())
        self.assertTrue(stdout.is_file())
        metrics.read_text(encoding="utf-8")
        stdout.read_text(encoding="utf-8")
        if len(run["samples"]) >= 2:
            self.assertGreaterEqual(run["samples"][-1]["t"], run["samples"][0]["t"])

    def test_queue_times_observed_or_unavailable(self) -> None:
        queued = self._measure("queue", "queue", sleep=0.15)
        q = queued["queue_run_times"]["queued_seconds"]
        r = queued["queue_run_times"]["running_seconds"]
        self.assertEqual(q["status"], "observed")
        self.assertGreater(q["seconds"], 0)
        self.assertEqual(r["status"], "observed")
        self.assertGreater(r["seconds"], 0)
        success = self._measure("noqueue", "success")
        self.assertEqual(success["queue_run_times"]["queued_seconds"]["status"], "unavailable")

    def test_missing_executable_still_writes_metrics(self) -> None:
        run = protocol.measure_command(
            "missing",
            [str(self.out / "no-such-binary")],
            cwd=HERE,
            output_dir=self.out,
            sample_interval_s=0.05,
        )
        self.assertNotEqual(run["exit_code"], 0)
        self.assertTrue(run["launch_error"])
        self.assertTrue((self.out / "missing.metrics.json").is_file())


class ParentExitAndSources(unittest.TestCase):
    def test_parent_sigterm_reaps_owned_child(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = Path(tmp.name)
        proc = subprocess.Popen(
            [
                sys.executable,
                str(HERE / "cli.py"),
                "measure-command",
                "--repo",
                str(REPO),
                "--out",
                str(out),
                "--name",
                "parent-exit",
                "--sample-interval",
                "0.05",
                "--",
                sys.executable,
                str(CHILD),
                "--mode",
                "hang",
                "--out",
                str(out / "parent-exit"),
            ]
        )
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        pid = int(_wait_file(out / "parent-exit" / "child_pid.txt"))
        os.kill(proc.pid, signal.SIGTERM)
        proc.wait(timeout=8)
        _wait_gone(pid)
        self.assertTrue((out / "parent-exit.metrics.json").is_file())
        metrics = json.loads((out / "parent-exit.metrics.json").read_text(encoding="utf-8"))
        self.assertTrue(metrics["cancelled"])

    def test_sources_do_not_kill_by_name(self) -> None:
        text = (HERE / "protocol.py").read_text(encoding="utf-8") + (HERE / "cli.py").read_text(encoding="utf-8")
        for banned in ("pkill", "killall", "pgrep"):
            self.assertNotIn(banned, text)
        self.assertIn("killpg", text)
        self.assertIn("start_new_session", text)

    def test_mac_tests_do_not_claim_job_object(self) -> None:
        blob = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (HERE / "protocol.py", HERE / "cli.py", HERE / "README.md")
            if path.is_file()
        )
        self.assertIn("not-verified", protocol.OWNED_PROCESS_POLICY["windows_job_object"])
        self.assertNotIn("Job Object verified", blob)


class MatrixAndCli(unittest.TestCase):
    def test_matrix_covers_r04_items(self) -> None:
        index = scenarios.coverage_index()
        for item in scenarios.required_r04_items():
            self.assertTrue(index.get(item), item)
        for scene in scenarios.SCENARIOS:
            self.assertTrue(scene["exclusive_command"])
            self.assertIn("{repo}", " ".join(scene["exclusive_command"]))

    def test_product_and_mocked_commands_keep_distinct_budget_modes(self):
        by_id = {row["id"]: row["exclusive_command"] for row in scenarios.SCENARIOS}
        self.assertIn("product", by_id["near-cap"])
        self.assertIn("--formal-budget", by_id["blender-serial"])
        self.assertNotIn("--formal-budget", by_id["illustrator-busy"])
        self.assertNotIn("--formal-budget", by_id["relight"])
        self.assertNotIn("--formal-budget", by_id["over-cap"])
        self.assertNotIn("--formal-budget", by_id["failure-after-front"])
        self.assertNotIn("--formal-budget", by_id["dual-upload"])
        self.assertNotIn("{probe}/", " ".join(by_id["normal"]))
        self.assertIn("scripts/resource-stress/probes/face_probe.py", " ".join(by_id["normal"]))

    def test_cli_synthetic_run_never_valid_budget(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = Path(tmp.name)
        code = cli.main(["run", "--repo", str(REPO), "--out", str(out), "--mode", "synthetic-local"])
        self.assertEqual(code, 0)
        bundle = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertFalse(bundle["budget_valid"])
        self.assertIn("synthetic_workload", bundle["validity"]["reasons"])
        names = {item["name"] for item in bundle["commands"]}
        self.assertIn("synthetic-fail", names)
        blob = json.dumps(bundle["commands"])
        self.assertNotIn("face_probe.py", blob)
        self.assertNotIn("upload-probe.mjs", blob)
        self.assertFalse(bundle.get("budget_effective"))
        fail = next(item for item in bundle["commands"] if item["name"] == "synthetic-fail")
        self.assertEqual(fail["exit_code"], 7)
        report = (out / "REPORT.md").read_text(encoding="utf-8")
        self.assertIn("32MP", report)
        self.assertIn("不是 R04 整项验收", report)
        self.assertIn("Windows Job Object", report)

    def test_formal_budget_refuses_injected_blender(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = Path(tmp.name)
        snapshot = out / "snap.json"
        snapshot.write_text(
            json.dumps([_row(1, 0, 1, 0, "init"), _row(22, 1, 8, 2.0, "blender")]),
            encoding="utf-8",
        )
        code = cli.main([
            "run",
            "--repo",
            str(REPO),
            "--out",
            str(out / "evidence"),
            "--formal-budget",
            "--process-snapshot-json",
            str(snapshot),
        ])
        self.assertEqual(code, 3)
        bundle = json.loads((out / "evidence" / "report.json").read_text(encoding="utf-8"))
        self.assertFalse(bundle["budget_valid"])
        self.assertEqual(bundle["commands"], [])

    def test_missing_identity_cannot_mint_budget(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        empty = Path(tmp.name) / "repo"
        empty.mkdir()
        out = Path(tmp.name) / "out"
        code = cli.main([
            "run",
            "--repo",
            str(empty),
            "--out",
            str(out),
            "--formal-budget",
        ])
        self.assertEqual(code, 2)
        bundle = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertFalse(bundle["identity"]["complete"])
        self.assertFalse(bundle["budget_valid"])
        self.assertIn("identity_incomplete", bundle["validity"]["reasons"])

    def test_exclusive_mode_is_plan_only(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = Path(tmp.name)
        with patch.dict(os.environ, {"BEIAN_BLENDER": ""}, clear=False):
            code = cli.main(["run", "--repo", str(REPO), "--out", str(out), "--mode", "exclusive"])
        self.assertEqual(code, 0)
        bundle = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(bundle["mode"], "exclusive-plan-only")
        self.assertFalse(bundle["budget_valid"])
        self.assertEqual(bundle["commands"], [])
        self.assertIn("blender-serial", bundle["unverified"])
        self.assertFalse(bundle.get("budget_effective"))
        resolved = bundle["resolved_plan"]
        self.assertFalse(resolved["this_slice_executes_product"])
        blender = next(row for row in resolved["scenes"] if row["id"] == "blender-serial")
        self.assertFalse(blender["ok"])
        self.assertIn("blender_not_specified", blender["reasons"])



class IntegrationRegressions(unittest.TestCase):
    def test_empty_failed_or_unsampled_runs_are_not_budgets(self):
        for runs in ([], [{"exit_code": 7, "samples": [{}]}], [{"exit_code": 0, "samples": []}], [{"exit_code": 0, "samples": [{}], "cancelled": True}]):
            with self.subTest(runs=runs):
                result = protocol.budget_validity(identity={"complete": True}, preflight={"budget_eligible": True}, runs=runs, workload_kind="product", exclusive=True)
                self.assertFalse(result["budget_valid"])

    def test_leader_exit_does_not_leave_ignoring_descendant(self):
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp) / "pid"
            child_code = "import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path(" + repr(str(pidfile)) + ").write_text(str(os.getpid())); time.sleep(30)"
            leader_code = "import subprocess,sys,time; from pathlib import Path; subprocess.Popen([sys.executable,'-c'," + repr(child_code) + "]); p=Path(" + repr(str(pidfile)) + "); " + "\nwhile not p.exists(): time.sleep(.01)"
            try:
                result = protocol.measure_command("orphan", [sys.executable, "-c", leader_code], cwd=REPO, output_dir=Path(tmp), sample_interval_s=.02)
                pid = int(_wait_file(pidfile))
                _wait_gone(pid)
                self.assertEqual(result["exit_code"], 0)
            finally:
                if pidfile.exists():
                    try: os.kill(int(pidfile.read_text()), signal.SIGKILL)
                    except ProcessLookupError: pass


class ReviewRegressions(unittest.TestCase):
    def test_cross_checkout_identity_pins_executing_harness(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "other-checkout"
            target.mkdir()
            (target / "VERSION").write_text("synthetic")
            actual_tools = Path(protocol.__file__).resolve().parent
            with patch.object(protocol, "_git", return_value="synthetic-head"), \
                    patch.object(protocol, "_tool_version", return_value={"status": "unavailable"}), \
                    patch.object(protocol, "_sha256_file", side_effect=lambda path:
                                 "a" * 64 if path.parent == actual_tools else "b" * 64):
                identity = protocol.collect_identity(target)
            self.assertTrue(identity["complete"])
            self.assertEqual(identity["harness"]["directory"], str(actual_tools))
            self.assertEqual(identity["harness"]["files"]["cli.py"], "a" * 64)
            self.assertIn("probes/face_probe.py", identity["harness"]["files"])
            self.assertIn("probes/face_probe.py", identity["harness"]["probes"])
            self.assertTrue(all(value == "b" * 64 for value in identity["files"].values()))

    def test_missing_executing_harness_source_makes_identity_incomplete(self):
        original = protocol._sha256_file
        with patch.object(protocol, "_sha256_file", side_effect=lambda path:
                          None if path.name == "evidence.py" else original(path)):
            identity = protocol.collect_identity(REPO)
        self.assertFalse(identity["complete"])
        self.assertIn("harness:evidence.py", identity["missing"])

    def test_missing_probe_source_makes_identity_incomplete(self):
        original = protocol._sha256_file
        with patch.object(protocol, "_sha256_file", side_effect=lambda path:
                          None if path.as_posix().endswith("probes/face_probe.py") else original(path)):
            identity = protocol.collect_identity(REPO)
        self.assertFalse(identity["complete"])
        self.assertIn("harness:probes/face_probe.py", identity["missing"])

    def test_behavior_and_budget_judgments_are_distinct(self):
        for item in scenarios.SYNTHETIC_SUITE:
            cancelled = "cancel_after_s" in item
            good = {"exit_code": -15 if cancelled else item["expect_exit"], "cancelled": cancelled,
                    "samples": [{}], "measurement_errors": []}
            judgment = evidence.judge_synthetic(item, good)
            self.assertTrue(judgment["passed"])
            self.assertFalse(judgment["budget_effective"])
            for mutation in ({"samples": []}, {"measurement_errors": ["ps failed"]}, {"launch_error": "failed"},
                             {"cancelled": not cancelled}, {"exit_code": False}, {"samples": "bad"}):
                self.assertFalse(evidence.judge_synthetic(item, good | mutation)["passed"])

    def test_repeat_uses_new_directories_retains_raw_metrics_and_summarizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "new"
            code = cli.main(["run", "--repo", str(REPO), "--out", str(out), "--repeat", "2"])
            self.assertEqual(code, 0)
            aggregate = json.loads((out / "aggregate.json").read_text())
            self.assertTrue(aggregate["behavior_passed"])
            self.assertFalse(aggregate["budget_effective"])
            self.assertEqual(aggregate["completed_rounds"], 2)
            for scene in scenarios.SYNTHETIC_SUITE:
                values = []
                for n in (1, 2):
                    raw = out / f"round{n}" / f"{scene['id']}.metrics.json"
                    values.append(json.loads(raw.read_text())["seconds"])
                summary = aggregate["summary"][scene["id"]]["seconds"]
                self.assertEqual(summary["min"], min(values))
                self.assertEqual(summary["median"], sum(values) / 2)
                self.assertEqual(summary["max"], max(values))
            original = (out / "aggregate.json").read_bytes()
            self.assertEqual(cli.main(["run", "--repo", str(REPO), "--out", str(out), "--repeat", "2"]), 3)
            self.assertEqual((out / "aggregate.json").read_bytes(), original)

    def test_repeat_stops_before_later_round_on_unexpected_behavior(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "new"
            with patch.object(evidence, "judge_synthetic", return_value={"passed": False}):
                self.assertEqual(cli.main(["run", "--repo", str(REPO), "--out", str(out), "--repeat", "3"]), 4)
            self.assertFalse((out / "round2").exists())
            result = json.loads((out / "aggregate.json").read_text())
            self.assertFalse(result["behavior_passed"])
            self.assertEqual(result["summary"], {})

    def test_identity_drift_stops_before_next_round(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "new"
            state = protocol.collect_identity(REPO)
            with patch.object(protocol, "collect_identity", side_effect=[state, state | {"head": "changed"}]):
                self.assertEqual(cli.main(["run", "--repo", str(REPO), "--out", str(out), "--repeat", "2"]), 4)
            self.assertFalse((out / "round2").exists())
            report = json.loads((out / "round1/report.json").read_text())
            self.assertFalse(report["identity_unchanged"])

    def test_invalid_repeat_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "never-created"
            for extra in (["--repeat", "0"], ["--repeat", "101"], ["--repeat", "2", "--formal-budget"],
                          ["--repeat", "2", "--mode", "exclusive"]):
                with self.assertRaises(SystemExit):
                    cli.main(["run", "--out", str(out), *extra])
                self.assertFalse(out.exists())

    def test_suite_stops_on_unexpected_exit_and_keeps_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = protocol.measure_command
            def wrong_exit(*args, **kwargs):
                result = original(*args, **kwargs)
                result["exit_code"] = 9
                return result
            with patch.object(protocol, "measure_command", side_effect=wrong_exit) as measure:
                code = cli.main(["run", "--repo", str(REPO), "--out", tmp])
            self.assertEqual(code, 4)
            self.assertEqual(measure.call_count, 1)
            report = json.loads((Path(tmp) / "report.json").read_text())
            self.assertFalse(report["behavior_passed"])
            self.assertFalse(report["budget_valid"])
            self.assertTrue((Path(tmp) / "synthetic-success.metrics.json").exists())

    def test_sampler_failure_keeps_metrics(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls = 0
            def snapshot():
                nonlocal calls
                calls += 1
                if calls > 1: raise OSError("synthetic ps failure")
                return []
            result = protocol.measure_command("sample-error", [sys.executable,"-c","import time; time.sleep(10)"], cwd=REPO, output_dir=Path(tmp), snapshot_fn=snapshot)
            self.assertTrue(result["measurement_errors"])
            self.assertTrue((Path(tmp)/"sample-error.metrics.json").exists())

    def test_run_names_and_existing_evidence_are_protected(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("../escape", "/absolute", "", "a/b"):
                with self.assertRaises(ValueError):
                    protocol.measure_command(name, [sys.executable,"-c","pass"], cwd=REPO, output_dir=Path(tmp))
            (Path(tmp)/"used").mkdir()
            with self.assertRaises(FileExistsError):
                protocol.measure_command("used", [sys.executable,"-c","pass"], cwd=REPO, output_dir=Path(tmp))

    def test_invalid_intervals_rejected_before_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            for interval in (0, -1, float("nan"), float("inf")):
                with self.assertRaises(ValueError):
                    protocol.measure_command("bad", [sys.executable,"-c","pass"], cwd=REPO, output_dir=Path(tmp), sample_interval_s=interval)

    def test_cli_preserves_command_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = cli.main(["measure-command","--repo",str(REPO),"--out",tmp,"--name","bad-command","--",sys.executable,"-c","raise SystemExit(7)"])
            self.assertEqual(code,7)

    def test_malformed_timing_is_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            for value in ([], {"queued_seconds":-1,"running_seconds":float("nan")}):
                (Path(tmp)/"timing.json").write_text(json.dumps(value))
                timing=protocol._load_timing(Path(tmp))
                self.assertEqual(timing["queued_seconds"]["status"],"unavailable")

if __name__ == "__main__":
    unittest.main()
