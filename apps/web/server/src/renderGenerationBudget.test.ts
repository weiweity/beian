import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { makeTestTempDir } from "./testTemp.js";
import { candidateDiskBytes, createRenderLifecycle, releaseRenderReservation, renderGroupMemory,
  renderReservationPath } from "./renderGenerationBudget.js";

const MiB = 1024 * 1024;
function fixture(extra: Partial<Parameters<typeof createRenderLifecycle>[0]> = {}) {
  const root = makeTestTempDir("beian-render-budget-");
  const input = { root, mutationId: "mtest", timeoutMs: 10000, diskBytes: 8 * MiB, memoryBytes: 512 * MiB, ...extra };
  return { input, root, path: renderReservationPath(root, input.mutationId) };
}

it("physically reserves credit, consumes before writes, preserves unknown ownership, releases once", () => {
  const f = fixture();
  const budget = createRenderLifecycle(f.input);
  const st = lstatSync(f.path);
  assert.equal(st.size, 8 * MiB);
  assert.ok(st.blocks * 512 >= st.size);
  assert.throws(() => createRenderLifecycle(f.input), /EEXIST/);
  budget.beforeWrite(MiB);
  assert.equal(lstatSync(f.path).size, 7 * MiB);
  budget.release(false);
  assert.equal(existsSync(f.path), true);
  budget.release(true); budget.release(true);
  assert.throws(() => budget.check(), /lifecycle_closed/);
  assert.equal(existsSync(f.path), false);
  assert.equal(existsSync(f.path + ".json"), false);
});

it("expired allocation unwinds its owned reservation and metadata before any process exists", () => {
  const f = fixture({ timeoutMs:1, diskBytes:8*MiB });
  assert.throws(() => createRenderLifecycle(f.input), /timeout/);
  assert.equal(existsSync(f.path), false);
  assert.equal(existsSync(f.path + ".json"), false);
});

it("all candidate files consume credit including undeclared outputs; exhaustion does not remove them", () => {
  const f = fixture();
  const budget = createRenderLifecycle(f.input);
  const candidate = join(f.root, ".candidate-test"); mkdirSync(candidate);
  writeFileSync(join(candidate, "undeclared.bin"), Buffer.alloc(MiB));
  budget.observe(candidate);
  assert.equal(candidateDiskBytes(candidate), MiB);
  assert.equal(lstatSync(f.path).size, 7 * MiB);
  budget.observe(candidate); // Re-observation cannot charge twice.
  assert.equal(lstatSync(f.path).size, 7 * MiB);
  assert.throws(() => budget.beforeWrite(8 * MiB), /disk_budget/);
  budget.release(true);
  assert.equal(readFileSync(join(candidate, "undeclared.bin")).length, MiB);
});

it("bounded census rejects symlinks and file-count explosions without following them", () => {
  const root = makeTestTempDir("beian-render-census-");
  const outside = makeTestTempDir("beian-render-outside-");
  writeFileSync(join(outside, "keep"), "unchanged");
  symlinkSync(outside, join(root, "link"));
  assert.throws(() => candidateDiskBytes(root), /candidate_file_type/);
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "unchanged");
  const large = makeTestTempDir("beian-render-many-");
  for (let i = 0; i < 256; i++) writeFileSync(join(large, String(i)), "");
  assert.throws(() => candidateDiskBytes(large), /candidate_file_budget/);
});

it("cancellation and expired deadlines reject writes and still allow owned credit cleanup", async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  const budget = createRenderLifecycle(f.input);
  controller.abort();
  assert.throws(() => budget.beforeWrite(1), /cancelled/);
  budget.release(true);
  const next = fixture({ timeoutMs: 200, diskBytes: MiB });
  const expiring = createRenderLifecycle(next.input);
  await delay(220);
  assert.throws(() => expiring.check(), /timeout/);
  expiring.release(true);
});

it("recovery releases recorded reservation inode only; replacement is preserved", () => {
  const f = fixture();
  const budget = createRenderLifecycle(f.input);
  // This represents process restart after file descriptors have been lost.
  budget.release(false);
  releaseRenderReservation(f.root, f.input.mutationId);
  assert.equal(existsSync(f.path), false);
  const g = fixture(); const second = createRenderLifecycle(g.input);
  renameSync(g.path, g.path + ".owned");
  writeFileSync(g.path, "replacement must survive");
  assert.throws(() => releaseRenderReservation(g.root, g.input.mutationId), /reservation_changed/);
  assert.throws(() => second.release(true), /reservation_changed/);
  assert.equal(readFileSync(g.path, "utf8"), "replacement must survive");
  // Restore the test-owned inode so its still-live handle can close safely.
  renameSync(g.path, g.path + ".replacement"); renameSync(g.path + ".owned", g.path); second.release(true);
});

it("an actual allocator process exit leaves recoverable owned credit, not a permanent disk leak", () => {
  const f = fixture();
  const module = new URL("./renderGenerationBudget.ts",import.meta.url).href;
  const child = spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",
    `import {createRenderLifecycle} from ${JSON.stringify(module)}; createRenderLifecycle(${JSON.stringify(f.input)}); process.exit(37);`],
    {encoding:"utf8",timeout:10000});
  assert.equal(child.status,37,child.stderr);
  assert.equal(existsSync(f.path),true);
  releaseRenderReservation(f.root,f.input.mutationId);
  assert.equal(existsSync(f.path),false);
  assert.equal(existsSync(f.path + ".json"),false);
});

it("recovery rejects oversized, null, linked and foreign metadata without deleting credit", () => {
  for (const kind of ["oversized", "null", "linked", "foreign"] as const) {
    const f = fixture(); const budget = createRenderLifecycle(f.input);
    budget.release(false);
    const metadata = f.path + ".json";
    const original = readFileSync(metadata);
    if (kind === "linked") {
      renameSync(metadata, metadata + ".owned"); symlinkSync(metadata + ".owned", metadata);
    } else if (kind === "oversized") writeFileSync(metadata, Buffer.alloc(4097));
    else if (kind === "null") writeFileSync(metadata, "null");
    else writeFileSync(metadata, JSON.stringify({ ...JSON.parse(original.toString()), mutationId:"another" }));
    assert.throws(() => releaseRenderReservation(f.root,f.input.mutationId), /reservation_metadata/);
    assert.equal(existsSync(f.path),true);
    assert.equal(readFileSync(f.path).length,8*MiB);
  }
});

it("real detached child RSS is counted with the server and triggers the memory failure path", async () => {
  const f = fixture({ memoryBytes: 192 * MiB });
  const budget = createRenderLifecycle(f.input);
  const child = spawn(process.execPath, ["-e", "global.b=Buffer.alloc(192*1024*1024,7); console.log('ready');setTimeout(()=>{},10000)"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(child.stdout!, "data");
    assert.ok(renderGroupMemory(child.pid!) >= 192 * MiB);
    assert.throws(() => budget.observe(join(f.root, "absent"), child.pid), /memory_budget/);
  } finally {
    const exited = once(child, "close"); child.kill("SIGKILL"); await exited;
    budget.release(true);
  }
});
