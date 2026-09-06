import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runVerification, sourceSnapshot } from "./verify.mjs";

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), "beian-verify-contract-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "repo");
  mkdirSync(root);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  // A fixture needs a HEAD reference, but no commit or product checkout is changed.
  assert.equal(spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root }).status, 0);
  writeFileSync(join(root, "source.py"), "original\n");
  return { root, output: join(parent, "evidence") };
}
const nodeStep = (code) => ({ command: process.execPath, args: ["-e", code], cwd: "." });

test("failure retains its exit code and prevents later commands", async (t) => {
  const { root, output } = fixture(t);
  const result = await runVerification(root, "python", output, [nodeStep('console.log("failed-step");process.exit(7)'), nodeStep('throw Error("must not run")')]);
  assert.equal(result.receipt.exit_code, 7);
  assert.equal(result.receipt.commands.length, 1);
  assert.match(readFileSync(result.receipt.commands[0].log, "utf8"), /failed-step/);
  assert.equal(JSON.parse(readFileSync(result.receiptPath, "utf8")).exit_code, 7);
});

test("a passing command cannot certify concurrently changed source", async (t) => {
  const { root, output } = fixture(t);
  const result = await runVerification(root, "python", output, [nodeStep('require("fs").writeFileSync("source.py", "changed")')]);
  assert.equal(result.receipt.commands[0].exit_code, 0);
  assert.equal(result.receipt.source_stable, false);
  assert.equal(result.receipt.exit_code, 1);
});

test("separates prose from source but includes executable skill policy", (t) => {
  const { root } = fixture(t);
  const first = sourceSnapshot(root);
  writeFileSync(join(root, "README.md"), "prose");
  const prose = sourceSnapshot(root);
  assert.equal(first.source_sha256, prose.source_sha256);
  assert.notEqual(first.documentation_sha256, prose.documentation_sha256);
  mkdirSync(join(root, ".agents/skills/example"), { recursive: true });
  writeFileSync(join(root, ".agents/skills/example/SKILL.md"), "policy");
  assert.notEqual(prose.source_sha256, sourceSnapshot(root).source_sha256);
});

test("does not include private runtime paths in evidence fingerprints", (t) => {
  const { root } = fixture(t);
  const before = sourceSnapshot(root);
  writeFileSync(join(root, ".env"), "synthetic-placeholder");
  mkdirSync(join(root, "apps/web/backend/data"), { recursive: true });
  writeFileSync(join(root, "apps/web/backend/data/task.json"), "synthetic-placeholder");
  assert.deepEqual(sourceSnapshot(root), before);
});

test("a missing executable fails with a persisted receipt", async (t) => {
  const { root, output } = fixture(t);
  const result = await runVerification(root, "python", output, [{ command: join(root, "missing"), args: [], cwd: "." }]);
  assert.notEqual(result.receipt.exit_code, 0);
  assert.ok(result.receipt.commands[0].launch_error);
});

test("deadline stops a synthetic command and records timeout", async (t) => {
  const { root, output } = fixture(t);
  const result = await runVerification(root, "python", output, [nodeStep(`
    require("child_process").spawn(process.execPath, ["-e", 'setTimeout(()=>require("fs").writeFileSync("late-write", "bad"),500)']);
    setInterval(()=>{},1000);
  `)], 150);
  assert.equal(result.receipt.exit_code, 124);
  assert.equal(result.receipt.commands[0].timed_out, true);
  await new Promise((done) => setTimeout(done, 600));
  assert.equal(existsSync(join(root, "late-write")), false);
});

test("rejects output inside the checkout before writing evidence", async (t) => {
  const { root } = fixture(t);
  await assert.rejects(runVerification(root, "docs", join(root, "..evidence")), /outside the checkout/);
  assert.equal(existsSync(join(root, "..evidence")), false);
});

test("rejects output through an external symlink into the checkout", async (t) => {
  const { root, output } = fixture(t);
  symlinkSync(root, output, "dir");
  await assert.rejects(runVerification(root, "docs", output), /outside the checkout/);
  await assert.rejects(runVerification(root, "docs", join(output, "new-evidence")), /outside the checkout/);
  assert.equal(existsSync(join(root, "new-evidence")), false);
});

test("a parent exiting early cannot leave background descendants alive", async (t) => {
  const { root, output } = fixture(t);
  const result = await runVerification(root, "python", output, [nodeStep(`
    const child=require("child_process").spawn(process.execPath, ["-e", 'setTimeout(()=>require("fs").writeFileSync("late-write", "bad"),500)'], {stdio:"ignore"});
    child.unref();
    process.exit(7);
  `)], 150);
  assert.equal(result.receipt.exit_code, 7);
  await new Promise((done) => setTimeout(done, 600));
  assert.equal(existsSync(join(root, "late-write")), false);
});

test("synthetic lanes cannot inherit private or native pytest opt-ins", async (t) => {
  const { root, output } = fixture(t);
  const previous = process.env.PYTEST_ADDOPTS;
  process.env.PYTEST_ADDOPTS = "--run-native --run-real-artwork";
  try {
    const result = await runVerification(root, "python", output, [nodeStep('require("assert").equal(process.env.PYTEST_ADDOPTS, "--durations=20")')]);
    assert.equal(result.receipt.exit_code, 0);
  } finally {
    if (previous === undefined) delete process.env.PYTEST_ADDOPTS;
    else process.env.PYTEST_ADDOPTS = previous;
  }
});

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`${signal} persists interruption and prevents subsequent steps`, async (t) => {
    const { root, output } = fixture(t);
    const code = `import {runVerification} from ${JSON.stringify(new URL("./verify.mjs", import.meta.url).href)};
      const result=await runVerification(${JSON.stringify(root)},"python",${JSON.stringify(output)},[
        ${JSON.stringify(nodeStep('require("fs").writeFileSync("ready", "ready");setInterval(()=>{},1000)'))},
        ${JSON.stringify(nodeStep('require("fs").writeFileSync("unexpected", "bad")'))}
      ]);
      console.log(JSON.stringify(result.receipt));`;
    const runner = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    t.after(() => { try { process.kill(-runner.pid, "SIGKILL"); } catch {} });
    let stdout = "";
    runner.stdout.on("data", (chunk) => { stdout += chunk; });
    const finished = new Promise((done) => runner.on("close", done));
    const until = Date.now() + 5000;
    while (!existsSync(join(root, "ready")) && Date.now() < until) await new Promise((done) => setTimeout(done, 20));
    assert.equal(existsSync(join(root, "ready")), true);
    runner.kill(signal);
    assert.equal(await finished, 0);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.exit_code, exitCode);
    assert.equal(receipt.commands.length, 1);
    assert.equal(existsSync(join(root, "unexpected")), false);
  });
}
