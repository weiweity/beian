import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-print-faces-");
const { DATA_DIR } = await import("./config.js");
const { repairMockupPrintFaces, queueSnapshot, reclaimOnBoot, resetJobsTestHooks, setJobsTestHooks, setJobsLiveForTest, tryStart } = await import("./jobs.js");
const { saveMockup, readMockupFromDisk, publicMockup, deleteMockup, beginStructureConfirmation } = await import("./mockup.js");
const { releaseReadiness } = await import("./releaseAdmission.js");
const viewer = { id: "reviewer", name: "审核员", admin: false };
const id = "aa00aa00aa01";
const otherId = "aa00aa00aa02";
const png = Buffer.from("89504e470d0a1a0a", "hex");
const ok = { code: 0, stdout: "", stderr: "", timedOut: false };
function seed(tid = id) {
  const dir = join(DATA_DIR, "mockups", tid);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "artwork.pdf"), "%PDF synthetic");
  writeFileSync(join(dir, "resolved.json"), JSON.stringify({ schema: "resolved-packaging-job/3", faces: {} }));
  writeFileSync(join(dir, "assets", "panel_front.png"), Buffer.concat([png, Buffer.from("old")]));
  saveMockup({ id: tid, status: "done", job_kind: "mockup", job_status: "succeeded", created_at: "2026-09-08T00:00:00Z", files: [],
    structure_engine: "v2", structure_status: "ready", structure_artwork_path: join(dir, "artwork.pdf"), structure_resolution_path: join(dir, "resolved.json") });
  return dir;
}
function faces(assets: string) {
  mkdirSync(assets, { recursive: true });
  for (const face of ["front", "back", "left", "right"]) writeFileSync(join(assets, `panel_${face}.png`), png);
}
async function settled(tid = id) {
  for (let n = 0; n < 100; n++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    const job = readMockupFromDisk(tid)!;
    if (["succeeded", "failed"].includes(job.print_faces_request?.status || "")) return job;
  }
  throw new Error("repair did not settle");
}
afterEach(() => { resetJobsTestHooks(); rmSync(join(DATA_DIR, "mockups"), { recursive: true, force: true }); });

it("acknowledges before worker completes, deduplicates peers, persists queued work and blocks drain", async () => {
  seed(); seed(otherId);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  setJobsTestHooks({ runPrintFaceRepair: async opts => { calls++; opts.onSpawn?.(112233); await gate; faces(opts.assets); return ok; } });
  try {
    const accepted = await Promise.race([repairMockupPrintFaces(id, viewer), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("HTTP still waits for worker")), 100))]);
    assert.equal(accepted.status, "done");
    const again = await repairMockupPrintFaces(id, { ...viewer, id: "peer" });
    assert.equal(again.print_faces_request?.id, accepted.print_faces_request?.id);
    await repairMockupPrintFaces(otherId, viewer);
    assert.equal(calls, 1);
    const snapshot = queueSnapshot();
    assert.equal(snapshot.blender.running, 1);
    assert.equal(snapshot.blender.queued, 1);
    assert.equal(releaseReadiness({ admission: { state: "draining", active: 0 }, jobs: [snapshot.blender], uploads: { active: 0, waiting: 0 }, notifications: { active: 0 } }).ready, false);
    assert.throws(() => deleteMockup(id), /正在补印刷面/);
    assert.throws(() => beginStructureConfirmation(readMockupFromDisk(id)!), /正在补印刷面/);
    const body = JSON.stringify(publicMockup(readMockupFromDisk(id)!));
    for (const privateValue of ["worker_pid", "source_sha256", "print_faces_request", DATA_DIR]) assert.equal(body.includes(privateValue), false);
  } finally { release(); }
  assert.equal((await settled()).print_faces_repaired_by, viewer.id);
  assert.equal((await settled(otherId)).status, "done");
  assert.equal(calls, 2);
  assert.equal(queueSnapshot().blender.running, 0);
});

it("boot resumes queued work and replays an interrupted attempt only after the old PID is absent", async () => {
  seed();
  setJobsLiveForTest("blender", "another-job");
  await repairMockupPrintFaces(id, viewer);
  assert.equal(readMockupFromDisk(id)?.print_faces_request?.status, "queued");
  const queued = readMockupFromDisk(id)!;
  queued.print_faces_request!.status = "running";
  queued.print_faces_request!.worker_pid = 112233;
  const previousId = queued.print_faces_request!.id;
  saveMockup(queued);
  resetJobsTestHooks();
  setJobsTestHooks({ inspectWorker: () => "missing", runPrintFaceRepair: async opts => { faces(opts.assets); return ok; } });
  reclaimOnBoot();
  const finished = await settled();
  assert.equal(finished.print_faces_request?.status, "succeeded");
  assert.notEqual(finished.print_faces_request?.id, previousId);
});

it("unconfirmed interrupted workers retain the durable fence, including the spawn/persist gap", async () => {
  for (const pid of [112233, undefined]) {
    seed();
    setJobsLiveForTest("blender", "another-job");
    await repairMockupPrintFaces(id, viewer);
    const job = readMockupFromDisk(id)!;
    job.print_faces_request!.status = "running";
    job.print_faces_request!.worker_pid = pid;
    saveMockup(job);
    resetJobsTestHooks();
    let starts = 0;
    setJobsTestHooks({ inspectWorker: () => "unknown", runPrintFaceRepair: async () => { starts++; return ok; } });
    reclaimOnBoot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 0);
    assert.equal(queueSnapshot().blender.running, 1);
    assert.equal(readMockupFromDisk(id)?.print_faces_request?.status, "running");
  }
});

it("changed source is rejected before running and a failed crop preserves public assets", async () => {
  const dir = seed();
  const before = readFileSync(join(dir, "assets", "panel_front.png"));
  setJobsLiveForTest("blender", "another-job");
  await repairMockupPrintFaces(id, viewer);
  writeFileSync(join(dir, "artwork.pdf"), "%PDF changed");
  let calls = 0;
  setJobsTestHooks({ runPrintFaceRepair: async opts => { calls++; faces(opts.assets); return { ...ok, code: 1 }; } });
  setJobsLiveForTest("blender", null); tryStart();
  assert.match((await settled()).print_faces_request?.error || "", /底稿已变化/);
  assert.equal(calls, 0);
  await repairMockupPrintFaces(id, viewer);
  assert.equal((await settled()).print_faces_request?.status, "failed");
  assert.deepEqual(readFileSync(join(dir, "assets", "panel_front.png")), before);
  assert.equal(queueSnapshot().blender.running, 0);
});

it("unreadable repair state fails release closed", async () => {
  const dir = seed();
  const job = readMockupFromDisk(id)!;
  writeFileSync(join(dir, "job.json"), JSON.stringify({ ...job, print_faces_request: { status: "queued" } }));
  assert.equal(queueSnapshot().unknown, 1);
});


it("a replaced assets symlink cannot redirect publication outside the job", async () => {
  const dir = seed();
  const outside = join(DATA_DIR, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "panel_front.png"), "untouched");
  setJobsTestHooks({ runPrintFaceRepair: async opts => {
    faces(opts.assets);
    rmSync(join(dir, "assets"), { recursive: true });
    symlinkSync(outside, join(dir, "assets"), "dir");
    return ok;
  } });
  await repairMockupPrintFaces(id, viewer);
  assert.equal((await settled()).print_faces_request?.status, "failed");
  assert.equal(readFileSync(join(outside, "panel_front.png"), "utf8"), "untouched");
});

it("a queued acknowledgement survives a process restart without an HTTP client", async () => {
  seed();
  setJobsLiveForTest("blender", "another-job");
  await repairMockupPrintFaces(id, viewer);
  resetJobsTestHooks();
  setJobsTestHooks({ runPrintFaceRepair: async opts => { faces(opts.assets); return ok; } });
  reclaimOnBoot();
  const finished = await settled();
  assert.equal(finished.print_faces_request?.status, "succeeded");
  // Terminal repair audit must not make a later normal render unreadable.
  saveMockup({ ...finished, status: "queued", job_status: "queued" });
  assert.equal(queueSnapshot().unknown, 0);
  assert.equal(queueSnapshot().blender.queued, 1);
});

it("zero worker exit without every required staged face never overwrites the old front", async () => {
  const dir = seed();
  const before = readFileSync(join(dir, "assets", "panel_front.png"));
  setJobsTestHooks({ runPrintFaceRepair: async opts => {
    mkdirSync(opts.assets, { recursive: true });
    writeFileSync(join(opts.assets, "panel_front.png"), png);
    return ok;
  } });
  await repairMockupPrintFaces(id, viewer);
  assert.equal((await settled()).print_faces_request?.status, "failed");
  assert.deepEqual(readFileSync(join(dir, "assets", "panel_front.png")), before);
});

it("publication failure after required faces remains retryable through refresh and queueing", async () => {
  const dir = seed();
  // A later optional destination fails after the four required faces were published.
  mkdirSync(join(dir, "assets", "panel_top.png"));
  setJobsTestHooks({ runPrintFaceRepair: async opts => {
    faces(opts.assets);
    writeFileSync(join(opts.assets, "panel_top.png"), png);
    return ok;
  } });
  await repairMockupPrintFaces(id, viewer);
  const failed = await settled();
  assert.equal(failed.print_faces_request?.status, "failed");
  const refreshed = publicMockup(readMockupFromDisk(id)!);
  for (const face of ["front", "back", "left", "right"]) {
    assert.ok(refreshed.files.some(file => file.key === `read_${face}`));
  }
  assert.equal(refreshed.can_repair_print_faces, true);
  assert.equal(refreshed.status, "done");
  rmSync(join(dir, "assets", "panel_top.png"), { recursive: true });
  setJobsLiveForTest("blender", "another-job");
  const queued = await repairMockupPrintFaces(id, viewer);
  assert.equal(queued.print_faces_request?.status, "queued");
  assert.notEqual(queued.print_faces_request?.id, failed.print_faces_request?.id);
  assert.equal(publicMockup(queued).can_repair_print_faces, true);
  setJobsLiveForTest("blender", null); tryStart();
  const finished = await settled();
  assert.equal(finished.print_faces_request?.status, "succeeded");
  assert.equal(publicMockup(finished).can_repair_print_faces, false);
});
