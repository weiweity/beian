#!/usr/bin/env node
/** Explicit local verification lanes with per-command evidence; never a cache bypass. */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const step = (args, cwd = ".") => ({ command: npm, args, cwd });
export const LANES = {
  docs: [{ command: "git", args: ["diff", "--check"], cwd: "." }],
  python: [{ command: process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
    args: ["-m", "pytest", "-q", "--durations=20"], cwd: "apps/web/backend" }],
  server: [step(["run", "build", "-w", "beian-ui"]), step(["run", "test", "-w", "beian-server"])],
  ui: [step(["run", "build", "-w", "beian-ui"]), step(["run", "test", "-w", "beian-ui"])],
  quality: [step(["run", "test:quality"]), step(["run", "quality"])],
  full: [step(["run", "test:quality"]), step(["run", "quality"]), step(["run", "typecheck"]), step(["test"])],
};

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Cannot collect Git evidence: ${result.error?.message || result.stderr}`);
  return result.stdout;
}

export function sourceSnapshot(root) {
  const code = createHash("sha256"), docs = createHash("sha256");
  const files = [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))].sort();
  let count = 0;
  for (const name of files) {
    // Do not read private runtime data, artwork, or credential files for evidence.
    if (/(^|\/)\.env[^/]*(\/|$)|(^|\/)settings\.secrets\.json$/.test(name)
      || name.startsWith("apps/web/backend/data/") || name.startsWith("测试/")) continue;
    const file = join(root, name);
    let bytes, kind = "file";
    try {
      const stat = lstatSync(file);
      kind = stat.isSymbolicLink() ? "symlink" : "file";
      bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      kind = "deleted";
      bytes = Buffer.alloc(0);
    }
    // Skill Markdown is executable policy input to quality checks, not prose.
    const hash = name.endsWith(".md") && !name.startsWith(".agents/") ? docs : code;
    hash.update(JSON.stringify([name, kind, bytes.length]) + "\0");
    hash.update(bytes);
    count++;
  }
  return { head: git(root, ["rev-parse", "HEAD"]).trim(), files: count,
    source_sha256: code.digest("hex"), documentation_sha256: docs.digest("hex") };
}

async function runStep(root, item, log, timeoutMs) {
  const start = performance.now();
  const fd = openSync(log, "wx");
  try {
    return await new Promise((done) => {
      let launchError = null;
      let timedOut = false;
      let interrupted = null;
      // Explicit synthetic lanes cannot inherit a private/native pytest opt-in.
      const child = spawn(item.command, item.args, { cwd: resolve(root, item.cwd), shell: false,
        env: { ...process.env, PYTEST_ADDOPTS: "--durations=20" },
        stdio: ["ignore", fd, fd], detached: true });
      const stopOwnedGroup = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") launchError = error.message; }
      };
      const onInterrupt = () => { interrupted = 130; stopOwnedGroup(); };
      const onTerminate = () => { interrupted = 143; stopOwnedGroup(); };
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
      // This runner is Mac/Linux only. Kill only the group created for this
      // synthetic step, so a timed-out npm parent cannot leave tests running.
      const deadline = setTimeout(() => {
        timedOut = true;
        stopOwnedGroup();
      }, timeoutMs);
      child.on("error", (error) => { launchError = error.message; });
      child.on("close", (code, signal) => {
        clearTimeout(deadline);
        // A failed or successful parent can leave background descendants alive.
        // Finish our owned group before collecting the after-snapshot.
        stopOwnedGroup();
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onTerminate);
        done({ ...item, log, exit_code: interrupted ?? (timedOut ? 124 : (launchError ? (code || 1) : (code ?? 1))), signal,
          launch_error: launchError, timed_out: timedOut, elapsed_ms: Math.round(performance.now() - start) });
      });
    });
  } finally { closeSync(fd); }
}

function physicalDestination(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A dangling symlink is not a missing directory we may safely create.
    let existing;
    try { existing = lstatSync(path); }
    catch (statError) { if (statError.code !== "ENOENT") throw statError; }
    if (existing) throw error;
    return join(physicalDestination(dirname(path)), basename(path));
  }
}

export async function runVerification(root, lane, outputRoot = tmpdir(), steps = LANES[lane], timeoutMs = 1_800_000) {
  if (process.platform === "win32") throw new Error("verify supports Mac/Linux L0; use the existing hosted PowerShell contract workflow for Windows.");
  if (!Object.hasOwn(LANES, lane)) throw new Error(`Unknown lane: ${lane}`);
  const outputRelative = relative(realpathSync(root), physicalDestination(resolve(outputRoot)));
  if (!outputRelative || (outputRelative !== ".." && !outputRelative.startsWith("../") && !isAbsolute(outputRelative))) {
    throw new Error("Evidence output must be outside the checkout.");
  }
  mkdirSync(outputRoot, { recursive: true });
  const directory = mkdtempSync(join(outputRoot, "beian-verify-"));
  const before = sourceSnapshot(root);
  const started = new Date().toISOString();
  const commands = [];
  for (const item of steps) {
    const result = await runStep(root, item, join(directory, `step-${commands.length + 1}.log`), timeoutMs);
    commands.push(result);
    if (result.exit_code !== 0) break;
  }
  const after = sourceSnapshot(root);
  const python = spawnSync(join(root, "apps/web/backend/.venv/bin/python"), ["--version"], { encoding: "utf8", timeout: 5_000 });
  const sourceStable = before.source_sha256 === after.source_sha256;
  const documentationStable = before.documentation_sha256 === after.documentation_sha256;
  const exitCode = commands.find((result) => result.exit_code !== 0)?.exit_code
    ?? (sourceStable && (lane !== "docs" || documentationStable) ? 0 : 1);
  const receipt = { schema: "beian-verification/1", lane, root, started_at: started, finished_at: new Date().toISOString(),
    environment: { node: process.version, node_executable: process.execPath, platform: process.platform, arch: process.arch,
      python: python.status === 0 ? python.stdout.trim() : null, pytest_addopts: "--durations=20" },
    before, after, source_stable: sourceStable, documentation_stable: documentationStable,
    commands, exit_code: exitCode,
    evidence_limit: "Local command evidence only; dependency/runtime changes need review. Never skips checks or replaces final HEAD CI/L1/L2." };
  const receiptPath = join(directory, "receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return { receipt, receiptPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [lane, outputRoot, ...extra] = process.argv.slice(2);
  if (!lane || lane === "--help") {
    console.log("Usage: npm run verify -- <docs|python|server|ui|quality|full> [evidence-directory]\nRuns an explicit lane, stops at the first failure, and writes per-command logs/receipt outside the checkout by default.");
  } else if (!Object.hasOwn(LANES, lane) || extra.length) {
    console.error("Unknown lane or extra arguments; use --help.");
    process.exitCode = 2;
  } else {
    try {
      const result = await runVerification(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), lane, outputRoot);
      console.log(`${result.receipt.exit_code === 0 ? "PASS" : "FAIL"} ${lane}: ${result.receiptPath}`);
      process.exitCode = result.receipt.exit_code;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
