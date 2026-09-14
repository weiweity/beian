"""Q05 receipt/runner fixtures only; never build or launch a browser."""

import hashlib
import json
import os
import subprocess
import shutil
import shlex
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import q05_receipt as receipt


class ReceiptGate(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.artifact = self.root / "dist"
        self.artifact.mkdir()
        self.round = self.root / "round"
        self.round.mkdir()
        for rel in [*receipt.SOURCE_FILES, "VERSION", "package-lock.json", "apps/web/ui/src/main.ts"]:
            path = self.repo / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic\n")
        (self.artifact / "index.html").write_text('<script src="/assets/a.js"></script>')
        (self.artifact / "assets").mkdir()
        for name in ("a.js", "a.css"):
            (self.artifact / "assets" / name).write_text("fixture")
        self.identity = {
            "schema": "beian-q05-ui-prebuilt/1",
            "gitHead": "a" * 40,
            "sources": {
                "src/main.ts": receipt.sha256_file(self.repo / "apps/web/ui/src/main.ts"),
                "../../../package-lock.json": receipt.sha256_file(self.repo / "package-lock.json"),
            },
            "lock": {"path": "package-lock.json", "sha256": receipt.sha256_file(self.repo / "package-lock.json")},
            "manifest": {
                "indexHtml": receipt.sha256_file(self.artifact / "index.html"),
                "assets": {n: receipt.sha256_file(self.artifact / "assets" / n) for n in ("a.js", "a.css")},
            },
        }
        self.sidecar = self.artifact / ".beian-q05-ui-identity.json"
        self.sidecar.write_text(json.dumps(self.identity))
        (self.round / "measure").mkdir()
        self.raw = self.round / "measure/q05-heap-raf.json"
        self.payload = {
            "gitHead": self.identity["gitHead"],
            "artifact": {
                "mode": "prebuilt-external",
                "inputsSha": receipt.fingerprint(self.identity["sources"]),
                "artifactSha": receipt.fingerprint({"index.html": self.identity["manifest"]["indexHtml"],
                    **{f"assets/{k}": v for k, v in self.identity["manifest"]["assets"].items()}}),
            },
            "sources": {"thisSpec": receipt.sha256_file(self.repo / "apps/web/ui/e2e/mockup-preview-upgrade.spec.ts")},
            "measurement_windows": {"command_rss_wall": {"includes_ui_build": False}},
            "stages": [{"phase": f"stage-{i}", "heapAfterGc": {"cache": {"probe": True, "size": i}}} for i in range(11)],
        }
        self.raw.write_text(json.dumps(self.payload))
        (self.round / "measure/rf09-preview-measure-20260907.json").write_text(json.dumps({"samples": [{}] * 6}))
        self.command = self.round / "command.txt"
        self.command.write_text("synthetic command\n")
        (self.round / "rss-wall").mkdir()
        self.metrics = self.round / "rss-wall/q05-round1.metrics.json"
        self.metrics.write_text(json.dumps({"exit_code": 0, "cancelled": False, "samples": [{}]}))
        git_patch = patch.object(receipt, "git", side_effect=lambda _repo, *args:
            "" if args[0] == "status" else "main" if "--abbrev-ref" in args else "a" * 40)
        git_patch.start()
        self.addCleanup(git_patch.stop)
        self.before = self.round / "before.json"
        self.before.write_text(json.dumps(receipt.snapshot(self.repo.resolve(), self.artifact.resolve())))

    def run_receipt(self):
        return receipt.main([
            "--round-dir", str(self.round), "--round-number", "1", "--exit-code", "0",
            "--started-epoch", "100", "--ended-epoch", "101",
            "--command-file", str(self.command), "--repo", str(self.repo),
            "--artifact-dir", str(self.artifact), "--window-confirmed", "1",
            "--before-file", str(self.before),
        ])

    def test_identity_mismatch_returns_failure_without_rewriting_raw(self):
        self.payload["gitHead"] = "b" * 40
        self.raw.write_text(json.dumps(self.payload))
        before = hashlib.sha256(self.raw.read_bytes()).hexdigest()
        self.assertNotEqual(self.run_receipt(), 0)
        self.assertEqual(hashlib.sha256(self.raw.read_bytes()).hexdigest(), before)
        report = json.loads((self.round / "round-receipt.json").read_text())
        self.assertFalse(report["gate"]["passed"])

    def test_valid_round_passes_and_missing_cache_stays_not_assessed(self):
        self.payload["stages"][-1]["heapAfterGc"]["cache"] = {"probe": False, "size": None}
        self.raw.write_text(json.dumps(self.payload))
        self.assertEqual(self.run_receipt(), 0)
        report = json.loads((self.round / "round-receipt.json").read_text())
        self.assertTrue(report["gate"]["passed"])
        self.assertFalse(report["gate"]["budget_valid"])
        self.assertEqual(report["cache_probe_assessment"]["stages_not_assessed"], 1)

    def test_missing_raw_or_before_refuses(self):
        self.before.unlink()
        (self.round / "measure/rf09-preview-measure-20260907.json").unlink()
        self.assertEqual(self.run_receipt(), 5)

    def test_changed_spec_rejects_without_laundering_artifact(self):
        (self.repo / "apps/web/ui/e2e/mockup-preview-upgrade.spec.ts").write_text("changed")
        self.assertEqual(self.run_receipt(), 5)

    def test_added_build_input_rejects(self):
        (self.repo / "apps/web/ui/src/new.ts").write_text("new")
        self.assertEqual(self.run_receipt(), 5)

    def test_changed_asset_rejects(self):
        (self.artifact / "assets/a.js").write_text("changed")
        self.assertEqual(self.run_receipt(), 5)

    def test_payload_input_and_artifact_hash_mismatch_refuses(self):
        for key in ("inputsSha", "artifactSha"):
            self.payload["artifact"][key] = "c" * 64
        self.raw.write_text(json.dumps(self.payload))
        self.assertEqual(self.run_receipt(), 5)
        report = json.loads((self.round / "round-receipt.json").read_text())
        self.assertIn("payload:inputsSha_matches_sidecar", report["gate"]["reasons"])
        self.assertIn("payload:artifactSha_matches_sidecar", report["gate"]["reasons"])

    def test_symlink_input_refuses(self):
        source = self.repo / "apps/web/ui/src/main.ts"
        source.unlink()
        source.symlink_to(self.repo / "VERSION")
        self.assertEqual(self.run_receipt(), 5)

    def test_hidden_and_node_modules_inputs_do_not_reject_matching_sidecar(self):
        src = self.repo / "apps/web/ui/src"
        (src / ".DS_Store").write_text("finder")
        (src / ".cache").mkdir()
        (src / ".cache" / "secret.ts").write_text("nope")
        (src / ".hidden-link").symlink_to(src / "main.ts")
        nested = src / "node_modules" / "pkg"
        nested.mkdir(parents=True)
        (nested / "index.js").write_text("dep")
        (nested / "linked").symlink_to(src / "main.ts")
        labels = set(receipt.build_inputs(self.repo))
        walked = [name for name in labels if name.startswith(("src/", "public/"))]
        self.assertIn("src/main.ts", labels)
        self.assertNotIn("src/.DS_Store", labels)
        self.assertTrue(walked)
        self.assertFalse(
            any(part == "node_modules" or part.startswith(".") for name in walked for part in name.split("/"))
        )
        self.assertEqual(self.run_receipt(), 0)

    def test_remaining_src_symlink_still_refuses_after_hidden_prune(self):
        src = self.repo / "apps/web/ui/src"
        (src / ".DS_Store").write_text("finder")
        (src / "alias.ts").symlink_to(src / "main.ts")
        with self.assertRaises(ValueError) as raised:
            receipt.build_inputs(self.repo)
        self.assertEqual(str(raised.exception), "symlink_input")
        self.assertEqual(self.run_receipt(), 5)

    def test_identity_change_after_preflight_refuses(self):
        self.before.write_text(json.dumps({"old_identity": True}))
        self.assertEqual(self.run_receipt(), 5)
        report = json.loads((self.round / "round-receipt.json").read_text())
        self.assertIn("identity_changed_during_round", report["gate"]["reasons"])

    def test_existing_receipt_is_not_overwritten(self):
        destination = self.round / "round-receipt.json"
        destination.write_text("sentinel")
        self.assertEqual(self.run_receipt(), 5)
        self.assertEqual(destination.read_text(), "sentinel")

    def test_wrong_build_scope_refuses(self):
        self.payload["measurement_windows"]["command_rss_wall"]["includes_ui_build"] = True
        self.raw.write_text(json.dumps(self.payload))
        self.assertEqual(self.run_receipt(), 5)

    def test_missing_stage_refuses(self):
        self.payload["stages"].pop()
        self.raw.write_text(json.dumps(self.payload))
        self.assertEqual(self.run_receipt(), 5)

    def test_missing_rss_refuses(self):
        self.metrics.unlink()
        self.assertEqual(self.run_receipt(), 5)

    def test_malformed_payload_a_refuses(self):
        (self.round / receipt.RAW_PAYLOADS[1]).write_text("{}")
        self.assertEqual(self.run_receipt(), 5)

    def test_null_payload_a_samples_refuse(self):
        (self.round / receipt.RAW_PAYLOADS[1]).write_text(json.dumps({"samples": [None] * 6}))
        self.assertEqual(self.run_receipt(), 5)

    def test_sampler_failure_refuses(self):
        self.metrics.write_text(json.dumps({"exit_code": 0, "cancelled": False, "samples": [{}], "measurement_errors": ["ps"]}))
        self.assertEqual(self.run_receipt(), 5)

    def test_non_integer_rss_exit_code_refuses(self):
        self.metrics.write_text(json.dumps({"exit_code": False, "cancelled": False, "samples": [{}]}))
        self.assertEqual(self.run_receipt(), 5)

    def test_non_list_rss_samples_refuse(self):
        self.metrics.write_text(json.dumps({"exit_code": 0, "cancelled": False, "samples": "not samples"}))
        self.assertEqual(self.run_receipt(), 5)

    def test_non_object_rss_sample_refuses(self):
        self.metrics.write_text(json.dumps({"exit_code": 0, "cancelled": False, "samples": [True]}))
        self.assertEqual(self.run_receipt(), 5)

    def test_malformed_payload_or_sidecar_refuses(self):
        self.sidecar.write_text("[]")
        self.raw.write_text("[]")
        self.assertEqual(self.run_receipt(), 5)

    def test_boolean_or_negative_cache_size_is_not_assessed(self):
        for value in (True, -1):
            self.payload["stages"][0]["heapAfterGc"]["cache"]["size"] = value
            self.raw.write_text(json.dumps(self.payload))
            self.assertEqual(receipt.cache_assessment(self.round)["stages"][0]["status"], "not_assessed")

    def test_unavailable_git_does_not_equal_clean_tree(self):
        with patch.object(receipt, "git", side_effect=lambda _repo, *args:
                          None if args[0] == "status" else "main" if "--abbrev-ref" in args else "a" * 40):
            self.assertEqual(self.run_receipt(), 5)
        report = json.loads((self.round / "round-receipt.json").read_text())
        self.assertIn("repo_identity_missing_or_dirty", report["gate"]["reasons"])

    def test_unavailable_worktree_inventory_refuses_before_writing(self):
        with patch.object(receipt, "git", return_value=None):
            self.assertEqual(self.run_receipt(), 2)
        self.assertFalse((self.round / "round-receipt.json").exists())

    def test_output_cannot_be_inside_checkout_or_artifact(self):
        for path in (self.repo / "evidence", self.artifact / "evidence"):
            self.assertFalse(receipt.external_output(self.repo, self.artifact, path))
        self.assertTrue(receipt.external_output(self.repo, self.artifact, self.root / "outside"))

    def test_real_writer_and_runner_three_rounds_with_synthetic_payloads(self):
        # Real Git/receipt/runner plumbing, synthetic data only; no npm or browser.
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Fixture", "-c",
                        "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
                        "commit", "-qm", "synthetic fixture"], check=True)
        head = subprocess.check_output(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True).strip()
        self.identity["gitHead"] = self.payload["gitHead"] = head
        self.sidecar.write_text(json.dumps(self.identity))
        self.raw.write_text(json.dumps(self.payload))
        script = self.root / "synthetic-command.sh"
        code = """import pathlib, shutil, sys
source, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
shutil.copytree(source/'measure', root/'measure')
(root/'rss-wall').mkdir()
shutil.copyfile(source/'rss-wall/q05-round1.metrics.json', root/'rss-wall'/('q05-round'+sys.argv[3]+'.metrics.json'))
"""
        script.write_text("python3 -c " + shlex.quote(code) + " " + shlex.quote(str(self.round)) +
                          ' "$Q05_ROUND_DIR" "$Q05_ROUND_N"\n')
        output = self.root / "three-rounds"
        env = os.environ.copy()
        env.update(Q05_WT=str(self.repo), Q05_PREBUILT=str(self.artifact), Q05_ROUNDS_PARENT=str(output),
                   Q05_WINDOW_CONFIRMED="1", Q05_ROUND_CMD_FILE=str(script), Q05_ROUND_COUNT="3")
        result = subprocess.run(["sh", str(Path(receipt.__file__).with_name("q05_rounds.sh"))],
                                env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        for n in (1, 2, 3):
            report = json.loads((output / f"round{n}/round-receipt.json").read_text())
            self.assertTrue(report["gate"]["passed"])
            self.assertFalse(report["gate"]["budget_valid"])


class RunnerGate(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.dist = self.root / "dist"
        self.dist.mkdir()
        self.out = self.root / "run"
        self.command = self.root / "command.sh"
        self.command.write_text("exit 0\n")
        self.env = os.environ.copy()
        self.env.update(Q05_WT=str(self.repo), Q05_PREBUILT=str(self.dist), Q05_ROUNDS_PARENT=str(self.out),
                        Q05_WINDOW_CONFIRMED="1", Q05_ROUND_CMD_FILE=str(self.command), Q05_ROUND_COUNT="3")

    def run_script(self, path=None):
        return subprocess.run(["sh", str(path or Path(receipt.__file__).with_name("q05_rounds.sh"))],
                              env=self.env, capture_output=True, text=True, timeout=10)

    def test_default_command_stops_on_first_playwright_failure(self):
        # Capture actual shell arguments; never invoke the sampler or browser.
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        shim = bin_dir / "python3"
        shim.write_text('#!/bin/sh\nprintf \'%s\\n\' "$@"\n')
        shim.chmod(0o700)
        self.env.update(PATH=str(bin_dir) + os.pathsep + self.env["PATH"],
                        Q05_ROUND_DIR=str(self.out), Q05_ROUND_N="1")
        result = self.run_script(Path(receipt.__file__).with_name("q05_command.sh"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--max-failures=1", result.stdout.splitlines())
        self.assertFalse(self.out.exists())

    def test_unconfirmed_window_refuses_before_any_directory(self):
        self.env.pop("Q05_WINDOW_CONFIRMED")
        self.assertEqual(self.run_script().returncode, 2)
        self.assertFalse(self.out.exists())

    def test_real_preflight_missing_identity_never_executes_command(self):
        # Synthetic local Git repo only; no production repo or browser.
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        marker = self.root / "must-not-exist"
        self.command.write_text(f"touch '{marker}'\n")
        self.assertEqual(self.run_script().returncode, 5)
        self.assertFalse(marker.exists())
        self.assertFalse((self.out / "round2").exists())
        self.assertEqual((self.out / "round1/preflight.exitcode").read_text().strip(), "5")

    def test_existing_root_is_untouched(self):
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        self.out.mkdir()
        (self.out / "sentinel").write_text("keep")
        self.assertEqual(self.run_script().returncode, 3)
        self.assertEqual(list(self.out.iterdir()), [self.out / "sentinel"])

    def stubbed_runner(self, *, receipt_exit=5):
        # Stub only receipt/preflight to test the shell's exit propagation; no identity claim.
        tools = self.root / "tools"
        tools.mkdir()
        script = tools / "q05_rounds.sh"
        shutil.copyfile(Path(receipt.__file__).with_name("q05_rounds.sh"), script)
        stub = """import json, pathlib, sys
args = sys.argv
if '--check-output' in args: raise SystemExit(0)
if '--snapshot-only' in args:
    pathlib.Path(args[args.index('--output-file')+1]).write_text('{}')
    raise SystemExit(0)
root = pathlib.Path(args[args.index('--round-dir')+1])
(root/'round-receipt.json').write_text(json.dumps({'fixture_only': True}))
raise SystemExit(RECEIPT_EXIT)
""".replace("RECEIPT_EXIT", str(receipt_exit))
        (tools / "q05_receipt.py").write_text(stub)
        return script

    def test_receipt_failure_stops_after_one_round_and_preserves_logs(self):
        result = self.run_script(self.stubbed_runner(receipt_exit=5))
        self.assertEqual(result.returncode, 5)
        self.assertEqual((self.out / "round1/exitcode").read_text().strip(), "0")
        self.assertEqual((self.out / "round1/receipt.exitcode").read_text().strip(), "5")
        self.assertTrue((self.out / "round1/round-receipt.json").exists())
        self.assertFalse((self.out / "round2").exists())

    def test_command_failure_stops_even_when_receipt_succeeds(self):
        self.command.write_text("exit 7\n")
        self.assertEqual(self.run_script(self.stubbed_runner(receipt_exit=0)).returncode, 4)
        self.assertEqual((self.out / "round1/exitcode").read_text().strip(), "7")
        self.assertFalse((self.out / "round2").exists())

    def test_stubbed_success_executes_exactly_three_new_rounds(self):
        self.assertEqual(self.run_script(self.stubbed_runner(receipt_exit=0)).returncode, 0)
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["round1", "round2", "round3"])

    def test_invalid_count_refuses_without_creating_output(self):
        for count in ("0", "-1", "abc", "101", "99999999999999999999999999"):
            self.env["Q05_ROUND_COUNT"] = count
            self.assertEqual(self.run_script().returncode, 2)
            self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
