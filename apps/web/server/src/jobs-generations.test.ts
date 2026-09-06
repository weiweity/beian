import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";
import type { QualityVerifyInput, QualityVerifyResult } from "./renderGenerations.js";
import type {
  JobsTestHooks,
  RenderGenerationExecuteInput,
  RenderGenerationExecuteResult,
  RenderPlanVerifierInput,
  VerifiedRenderPlanSnapshot,
  RenderGenerationPreparer,
} from "./jobs.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-jobs-gen-");

const {
  RENDER_GENERATION_IDEMPOTENCY_LIMIT,
  activateRenderGeneration,
  enqueueRenderGenerationMutation,
  queueSnapshot,
  reclaimOnBoot,
  relightMockupStudio,
  repairMockupPrintFaces,
  resetJobsTestHooks,
  retryMockup,
  setJobsLiveForTest,
  setJobsTestHooks,
  tryStart,
} = await import("./jobs.js");
const { fileOf, loadMockup, publicMockup, publicMockupSummary, readMockupFromDisk, saveMockup } = await import("./mockup.js");
const {
  G0_LEGACY_ORIGINAL_ID,
  RENDER_GENERATION_DIR,
  RENDER_GENERATION_UNWIRED_NOTE,
  openRenderGenerationStore,
} = await import("./renderGenerations.js");
const { resetMockupAtomicWriteTestHooks, setMockupAtomicWriteTestHooks } = await import("./mockupAtomicWrite.js");

const FACES = ["front", "right", "back", "left", "top", "bottom"] as const;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function syntheticPng(r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([PNG_MAGIC, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.from([0, r, g, b]))), pngChunk("IEND", Buffer.alloc(0))]);
}

function syntheticGlb(marker: string): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, extras: { marker } }));
  const jsonPad = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
  const bin = Buffer.from(marker.padEnd(8, "\0"));
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  const body = Buffer.concat([jsonHeader, jsonChunk, binHeader, binChunk]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

function unwiredVerifier(input: QualityVerifyInput): QualityVerifyResult {
  return {
    generation_id: input.generation_id,
    contract_sha256: input.contract_sha256,
    content_fingerprint: input.content_fingerprint,
    verifier_status: "accepted",
    quality_status: "unwired",
    verifier: "rf03b-test",
    note: RENDER_GENERATION_UNWIRED_NOTE,
  };
}

function wipeJobDisk() {
  const root = process.env.WB_DATA_DIR || "";
  if (!root.includes("beian-jobs-gen-")) return;
  for (const sub of ["tasks", "mockups", "uploads"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
  }
}

afterEach(() => {
  resetJobsTestHooks();
  resetMockupAtomicWriteTestHooks();
  wipeJobDisk();
});

const viewer = { id: "ou_gen", name: "籽烨", admin: false };
const WHITE_A = syntheticPng(40, 10, 10);
const WHITE_B = syntheticPng(10, 40, 10);
const NEW_A = syntheticPng(9, 8, 7);
const NEW_B = syntheticPng(6, 5, 4);
const NEW_GLB = syntheticGlb("g-new");

function tid(n: number): string {
  return n.toString(16).padStart(12, "0");
}

function jobDir(id: string): string {
  return join(process.env.WB_DATA_DIR || "", "mockups", id);
}

function seedDoneJob(id: string) {
  const dir = jobDir(id);
  mkdirSync(join(dir, "assets"), { recursive: true });
  const whiteA = join(dir, `${id}_pack_front_right_white.png`);
  const whiteB = join(dir, `${id}_pack_back_left_white.png`);
  const glb = join(dir, "box.glb");
  const ppt = join(dir, "deck.pptx");
  const sheet = join(dir, "26F23A_white_sheet.pdf");
  writeFileSync(whiteA, WHITE_A);
  writeFileSync(whiteB, WHITE_B);
  writeFileSync(glb, syntheticGlb("g0"));
  writeFileSync(ppt, "ppt");
  writeFileSync(sheet, "pdf");
  for (const face of FACES) writeFileSync(join(dir, "assets", `panel_${face}.png`), syntheticPng(1, 2, 3));
  const resolved = join(dir, "resolved_job.json");
  writeFileSync(
    resolved,
    JSON.stringify({
      schema: "resolved-packaging-job/1",
      assets: Object.fromEntries(FACES.map((face) => [face, join(dir, "assets", `panel_${face}.png`)])),
      outputs: { front_right: whiteA, back_left: whiteB },
      render: { substrate_rgba: [1, 1, 1, 1] },
    }),
  );
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ products: [{ code: id.slice(0, 8) }] }));
  saveMockup({
    id,
    status: "done",
    created_at: "2026-09-05T00:00:00.000Z",
    files: [
      { key: "white_a", path: whiteA, name: `${id}_pack_front_right_white.png` },
      { key: "white_b", path: whiteB, name: `${id}_pack_back_left_white.png` },
      { key: "glb", path: glb, name: "box.glb" },
      { key: "ppt", path: ppt, name: "deck.pptx" },
      { key: "sheet", path: sheet, name: "26F23A_white_sheet.pdf" },
    ],
    owner: "ou_gen",
    created_by: "籽烨",
    job_kind: "mockup",
    job_status: "succeeded",
    structure_engine: "v2",
    structure_status: "ready",
    manifest_path: join(dir, "manifest.json"),
  });
  return { dir, whiteA, whiteB, glb };
}

function virtualId(id: string): string {
  return openRenderGenerationStore({
    jobRoot: jobDir(id),
    jobId: id,
    qualityVerifier: unwiredVerifier,
  }).virtualLegacyCurrentId();
}

function writeExecutorOutputs(candidateDir: string) {
  const whiteA = join(candidateDir, "front_right_white.png");
  const whiteB = join(candidateDir, "back_left_white.png");
  const glb = join(candidateDir, "box.glb");
  writeFileSync(whiteA, NEW_A);
  writeFileSync(whiteB, NEW_B);
  writeFileSync(glb, NEW_GLB);
  return [
    { key: "white_a" as const, path: whiteA },
    { key: "white_b" as const, path: whiteB },
    { key: "glb" as const, path: glb },
  ];
}

function controlledPlanVerifier(input: RenderPlanVerifierInput): VerifiedRenderPlanSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bytes.toString("utf8"));
  } catch {
    throw new Error("受控验证器拒绝：不是 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("受控验证器拒绝：合同不是对象");
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.schema !== "resolved-packaging-job/1") {
    throw new Error("受控验证器拒绝：schema 不是测试夹具");
  }
  const assets = rec.assets;
  const outputs = rec.outputs;
  const render = rec.render;
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
    throw new Error("受控验证器拒绝：缺少 assets");
  }
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    throw new Error("受控验证器拒绝：缺少 outputs");
  }
  if (!render || typeof render !== "object" || Array.isArray(render)) {
    throw new Error("受控验证器拒绝：缺少 render");
  }
  const assetRec = assets as Record<string, unknown>;
  for (const face of FACES) {
    if (typeof assetRec[face] !== "string" || !assetRec[face]) {
      throw new Error(`受控验证器拒绝：缺少 ${face}`);
    }
  }
  const outRec = outputs as Record<string, unknown>;
  if (typeof outRec.front_right !== "string" || typeof outRec.back_left !== "string") {
    throw new Error("受控验证器拒绝：缺少输出");
  }
  return {
    identitySha256: createHash("sha256").update(input.bytes).digest("hex"),
    bytes: input.bytes,
    profile: input.mode === "upgrade" ? "packshot-neutral-v1" : "compat-legacy-v0",
    verifier: "rf03b-test-plan",
  };
}

function generationHooks(extra: JobsTestHooks = {}): JobsTestHooks {
  return {
    qualityVerifier: unwiredVerifier,
    verifyRenderPlan: controlledPlanVerifier,
    ...extra,
  };
}

function bindExecutorResult(input: RenderGenerationExecuteInput, outputs: RenderGenerationExecuteResult["outputs"]): RenderGenerationExecuteResult {
  return {
    outputs,
    contract_sha256: input.plan.identitySha256,
    plan_identity_sha256: input.plan.identitySha256,
    source_generation_id: input.sourceGenerationId,
  };
}

function gatedExecutor() {
  let release!: (ok: boolean, illegal?: boolean) => void;
  const gate = new Promise<{ ok: boolean; illegal?: boolean }>((resolve) => {
    release = (ok, illegal) => resolve({ ok, illegal });
  });
  return {
    release: (ok = true, illegal = false) => release(ok, illegal),
    run: async (input: RenderGenerationExecuteInput): Promise<RenderGenerationExecuteResult> => {
      const { ok, illegal } = await gate;
      if (!ok) throw new Error("执行器失败");
      if (illegal) {
        return bindExecutorResult(input, [{ key: "white_a", path: join(input.jobRoot, "outside.png") }]);
      }
      return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
    },
  };
}

async function waitUntil(fn: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(label);
}

function fileBytes(job: NonNullable<ReturnType<typeof loadMockup>>, key: string) {
  const file = fileOf(job, key);
  assert.ok(file?.path, `missing ${key}`);
  return readFileSync(file.path);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (err) {
    assert.equal((err as { code?: string }).code, code, String(err));
  }
}

function asyncPrepared(input: Parameters<RenderGenerationPreparer>[0]) {
  const sourceAssets = FACES.map(key => {
    const path = join(input.jobRoot, "assets", `panel_${key}.png`);
    const bytes = readFileSync(path);
    return { key, path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  return {
    plan: { ...controlledPlanVerifier(input), sourceAssets },
    execute: async (execution: RenderGenerationExecuteInput) => {
      assert.equal(existsSync(execution.candidateDir), false, "only the executor creates its candidate");
      mkdirSync(execution.candidateDir);
      return bindExecutorResult(execution, writeExecutorOutputs(execution.candidateDir));
    },
  };
}

function enqueueAsync(id: string, requestId = "async-request") {
  const source = virtualId(id);
  return enqueueRenderGenerationMutation({ jobId: id, viewer, clientRequestId: requestId,
    mode: "legacy_relight", sourceGenerationId: source, expectedCurrentGenerationId: source });
}

describe("RF-03C2.2 asynchronous preparation and ownership", () => {
  it("rejects malformed admission fields without persisting a mutation", () => {
    const id = tid(602);
    seedDoneJob(id);
    const source = virtualId(id);
    const input = { jobId: id, viewer, clientRequestId: "valid-request", mode: "legacy_relight" as const,
      sourceGenerationId: source, expectedCurrentGenerationId: source };
    for (const patch of [{ mode: "unknown" }, { clientRequestId: "short" }, { sourceGenerationId: "../source" },
      { expectedCurrentGenerationId: "/private/current" }, { studioAdjustment: null }, { studioAdjustment: [] },
      { studioAdjustment: { profile: "custom" } }, { studioAdjustment: { product_light: NaN } },
      { studioAdjustment: { background_light: Infinity } }, { studioAdjustment: { product_light: "1" } }]) {
      expectCode(() => enqueueRenderGenerationMutation({ ...input, ...patch } as never), "render_generation_invalid");
      assert.equal(readMockupFromDisk(id)?.render_mutation, undefined);
      assert.equal(existsSync(join(jobDir(id), RENDER_GENERATION_DIR)), false);
    }
  });

  it("fails an adapterless queued mutation on boot without importing or executing", () => {
    const id = tid(603);
    seedDoneJob(id);
    setJobsLiveForTest("blender", tid(699));
    setJobsTestHooks({ qualityVerifier: unwiredVerifier, prepareRenderGeneration: async () => { assert.fail("must remain queued"); } });
    assert.equal(enqueueAsync(id).mutation.status, "queued");
    resetJobsTestHooks();
    reclaimOnBoot();
    reclaimOnBoot();
    const job = readMockupFromDisk(id)!;
    assert.equal(job.render_mutation?.status, "failed");
    assert.equal(job.current_render_generation_id, undefined);
    assert.deepEqual(fileBytes(job, "white_a"), WHITE_A);
    assert.equal(existsSync(join(jobDir(id), RENDER_GENERATION_DIR)), false);
    assert.equal(queueSnapshot().blender.running, 0);
  });

  for (const defect of ["empty-bytes", "rewritten-bytes", "profile-path", "verifier-path", "missing-faces", "duplicate-face"] as const) {
    it(`rejects an asynchronous verification receipt with ${defect} before importing or executing`, async () => {
      const id = tid(600);
      seedDoneJob(id);
      let executions = 0;
      setJobsTestHooks({ qualityVerifier: unwiredVerifier, prepareRenderGeneration: async input => {
        const prepared = asyncPrepared(input);
        if (defect === "empty-bytes") prepared.plan.bytes = Buffer.alloc(0);
        if (defect === "rewritten-bytes") prepared.plan.bytes = Buffer.from("{}");
        if (defect === "profile-path") prepared.plan.profile = "../profile";
        if (defect === "verifier-path") prepared.plan.verifier = "/private/verifier";
        if (defect === "missing-faces") prepared.plan.sourceAssets.pop();
        if (defect === "duplicate-face") prepared.plan.sourceAssets[5] = { ...prepared.plan.sourceAssets[0] };
        return { ...prepared, execute: async execution => { executions++; return prepared.execute(execution); } };
      } });
      enqueueAsync(id);
      await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "failed", defect);
      assert.equal(executions, 0);
      assert.equal(existsSync(join(jobDir(id), RENDER_GENERATION_DIR)), false);
      assert.equal(readMockupFromDisk(id)?.current_render_generation_id, undefined);
      assert.deepEqual(fileBytes(loadMockup(id)!, "white_a"), WHITE_A);
    });
  }

  for (const defect of ["contract", "plan", "source", "missing-glb"] as const) {
    it(`rejects executor ${defect} without sealing or switching current`, async () => {
      const id = tid(601);
      seedDoneJob(id);
      setJobsTestHooks({ qualityVerifier: unwiredVerifier, prepareRenderGeneration: async input => {
        const prepared = asyncPrepared(input);
        return { ...prepared, execute: async execution => {
          const result = await prepared.execute(execution);
          if (defect === "contract") result.contract_sha256 = "f".repeat(64);
          if (defect === "plan") result.plan_identity_sha256 = "f".repeat(64);
          if (defect === "source") result.source_generation_id = "other-source";
          if (defect === "missing-glb") result.outputs = result.outputs.filter(row => row.key !== "glb");
          return result;
        } };
      } });
      enqueueAsync(id);
      await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "failed", defect);
      assert.equal(readMockupFromDisk(id)?.current_render_generation_id, undefined);
      assert.deepEqual(fileBytes(loadMockup(id)!, "white_a"), WHITE_A);
      assert.equal(readdirSync(join(jobDir(id), RENDER_GENERATION_DIR)).some(name => name.startsWith("g1-")), false);
      assert.equal(queueSnapshot().blender.running, 0);
    });
  }

  it("rejects an oversized source plan before queueing or starting validation", () => {
    const id = tid(399);
    seedDoneJob(id);
    writeFileSync(join(jobDir(id), "resolved_job.json"), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    setJobsTestHooks({ qualityVerifier: unwiredVerifier,
      prepareRenderGeneration: async () => { assert.fail("oversized plan must not start"); } });
    expectCode(() => enqueueAsync(id), "render_generation_invalid");
    assert.equal(loadMockup(id)?.render_mutation, undefined);
  });
  it("requires a quality adapter before accepting an async request", () => {
    const id = tid(400);
    seedDoneJob(id);
    setJobsTestHooks({ prepareRenderGeneration: async () => { assert.fail("must not start"); } });
    expectCode(() => enqueueAsync(id), "render_generation_unavailable");
    assert.equal(loadMockup(id)?.render_mutation, undefined);
  });
  it("binds the plan bytes at admission and refuses a changed plan before async preparation", async () => {
    const id = tid(398);
    seedDoneJob(id);
    let starts = 0;
    setJobsTestHooks({ qualityVerifier: unwiredVerifier, prepareRenderGeneration: async input => { starts++; return asyncPrepared(input); } });
    setJobsLiveForTest("blender", tid(499));
    assert.equal(enqueueAsync(id).mutation.status, "queued");
    const path = join(jobDir(id), "resolved_job.json");
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(" ")]));
    setJobsLiveForTest("blender", null);
    tryStart();
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "failed", "queued plan identity must stay bound");
    assert.equal(starts, 0);
    assert.equal(existsSync(join(jobDir(id), RENDER_GENERATION_DIR)), false);
  });
  it("returns without awaiting validation, shares the slot, replays idempotently and lets only the executor create candidates", async () => {
    const id = tid(401), waiter = tid(402);
    seedDoneJob(id); seedDoneJob(waiter);
    let resolveValidation!: () => void;
    const gate = new Promise<void>(resolve => { resolveValidation = resolve; });
    let entered = 0;
    setJobsTestHooks({ qualityVerifier: unwiredVerifier, prepareRenderGeneration: async input => {
      entered++;
      const prepared = asyncPrepared(input);
      if (input.jobId === id) await gate;
      return prepared;
    } });
    const first = enqueueAsync(id);
    assert.equal(first.mutation.status, "running");
    assert.equal(enqueueAsync(id).mutation.id, first.mutation.id);
    assert.equal(enqueueAsync(waiter).mutation.status, "queued");
    assert.equal(entered, 1);
    assert.equal(existsSync(join(jobDir(id), RENDER_GENERATION_DIR)), false);
    assert.deepEqual(fileBytes(loadMockup(id)!, "white_a"), WHITE_A);
    resolveValidation();
    await waitUntil(() => loadMockup(waiter)?.render_mutation?.status === "succeeded", "waiter should run");
    assert.equal(entered, 2);
    assert.equal(loadMockup(id)?.render_mutation?.status, "succeeded");
  });

  for (const change of ["plan", "output", "asset", "request"] as const) {
    it(`rejects ${change} changes while asynchronous validation is pending, before import`, async () => {
      const id = tid(410);
      const seeded = seedDoneJob(id);
      let resolveValidation!: () => void;
      const gate = new Promise<void>(resolve => { resolveValidation = resolve; });
      let executions = 0;
      setJobsTestHooks({ qualityVerifier: unwiredVerifier, prepareRenderGeneration: async input => {
        const prepared = asyncPrepared(input);
        await gate;
        return { ...prepared, execute: async execution => { executions++; return prepared.execute(execution); } };
      } });
      enqueueAsync(id);
      if (change === "plan") writeFileSync(join(seeded.dir, "resolved_job.json"), "{}");
      if (change === "output") writeFileSync(seeded.whiteA, NEW_A);
      if (change === "asset") writeFileSync(join(seeded.dir, "assets", "panel_front.png"), NEW_A);
      if (change === "request") {
        const disk = readMockupFromDisk(id)!;
        disk.render_generation_request!.source_generation_id = "changed";
        saveMockup(disk);
      }
      resolveValidation();
      await waitUntil(() => loadMockup(id)?.render_mutation?.status === "failed", "stale validation must fail");
      assert.equal(executions, 0);
      assert.equal(existsSync(join(seeded.dir, RENDER_GENERATION_DIR)), false);
      assert.equal(loadMockup(id)?.current_render_generation_id, undefined);
    });
  }

  it("persists each spawn identity, clears only its matching close, and keeps private fields out of public JSON", async () => {
    const id = tid(420);
    seedDoneJob(id);
    setJobsTestHooks({ qualityVerifier: unwiredVerifier, prepareRenderGeneration: async input => {
      const identity = `${id}:${input.mutationId}:${"a".repeat(32)}`;
      input.observer.onSpawn!(71234, identity);
      assert.equal(readMockupFromDisk(id)?.render_generation_request?.worker_execution_id, identity);
      assert.doesNotMatch(JSON.stringify(publicMockup(loadMockup(id)!)), /71234|worker_execution_id|worker_protocol/);
      input.observer.onClose!(71234, `${id}:${input.mutationId}:${"b".repeat(32)}`);
      assert.equal(readMockupFromDisk(id)?.render_generation_request?.worker_pid, 71234);
      input.observer.onClose!(71234, identity);
      assert.equal(readMockupFromDisk(id)?.render_generation_request?.worker_pid, undefined);
      return asyncPrepared(input);
    } });
    enqueueAsync(id);
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "succeeded", "owned lifecycle should complete");
  });

  it("retains the shared fence after an executor rejection with an unconfirmed PID, then recovers by the exact generation identity", async () => {
    const id = tid(430), waiter = tid(431);
    seedDoneJob(id); seedDoneJob(waiter);
    let expectedId = "";
    let state: "unknown" | "missing" = "unknown";
    let executions = 0;
    setJobsTestHooks({ qualityVerifier: unwiredVerifier,
      inspectGenerationGroup: () => "missing",
      inspectWorker: (_pid, expected) => {
        assert.equal(expected.kind, "render_generation");
        if (expected.kind === "render_generation") assert.equal(expected.executionId, expectedId);
        return state;
      }, killTree: () => { assert.fail("unknown/missing must not be killed"); },
      prepareRenderGeneration: async input => {
        const prepared = asyncPrepared(input);
        if (input.jobId === id) {
          expectedId = `${id}:${input.mutationId}:${"c".repeat(32)}`;
          input.observer.onSpawn!(71235, expectedId);
          throw new Error("controlled rejection with no close evidence");
        }
        return { ...prepared, execute: async execution => { executions++; return prepared.execute(execution); } };
      },
    });
    enqueueAsync(id);
    enqueueAsync(waiter);
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "failed", "failure persisted");
    tryStart(); reclaimOnBoot(); reclaimOnBoot();
    assert.equal(executions, 0);
    assert.equal(loadMockup(waiter)?.render_mutation?.status, "queued");
    expectCode(() => enqueueAsync(id, "cannot-overwrite-owned-request"), "render_generation_busy");
    state = "missing";
    reclaimOnBoot();
    await waitUntil(() => loadMockup(waiter)?.render_mutation?.status === "succeeded", "confirmed exit should release slot");
    assert.equal(executions, 1);
    assert.equal(readMockupFromDisk(id)?.render_generation_request?.worker_pid, undefined);
  });

  it("does not let unwired runtime quality activate an otherwise valid candidate", async () => {
    const id = tid(440);
    seedDoneJob(id);
    setJobsTestHooks({ qualityVerifier: unwiredVerifier, prepareRenderGeneration: async input => {
      const prepared = asyncPrepared(input);
      return { ...prepared, execute: async execution => ({ ...await prepared.execute(execution), runtimeQuality: "unwired" }) };
    } });
    enqueueAsync(id);
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "failed", "quality must refuse");
    assert.equal(loadMockup(id)?.current_render_generation_id, undefined);
    assert.deepEqual(fileBytes(loadMockup(id)!, "white_a"), WHITE_A);
    assert.equal(readdirSync(join(jobDir(id), RENDER_GENERATION_DIR)).some(name => name.startsWith("g1-")), false);
  });

  for (const corrupt of ["missing", "wrong-mutation"]) {
    it(`keeps the recovery fence when the new protocol execution identity is ${corrupt}`, async () => {
      const id = tid(450);
      seedDoneJob(id);
      setJobsTestHooks({ qualityVerifier: unwiredVerifier,
        inspectWorker: () => { assert.fail("corrupt evidence must not be interpreted as other"); },
        killTree: () => { assert.fail("must not kill"); },
        prepareRenderGeneration: async input => {
          input.observer.onSpawn!(71236, `${id}:${input.mutationId}:${"d".repeat(32)}`);
          throw new Error("interrupted before close");
        },
      });
      enqueueAsync(id);
      await waitUntil(() => loadMockup(id)?.render_mutation?.status === "failed", "interruption");
      const disk = readMockupFromDisk(id)!;
      disk.render_generation_request!.worker_execution_id = corrupt === "missing" ? undefined : `${id}:wrong:${"d".repeat(32)}`;
      saveMockup(disk);
      reclaimOnBoot(); reclaimOnBoot();
      assert.equal(readMockupFromDisk(id)?.render_generation_request?.worker_pid, 71236);
      expectCode(() => enqueueAsync(id, "still-busy"), "render_generation_busy");
    });
  }

  it("rechecks verified face bytes inside the final commit lock", async () => {
    const id = tid(460);
    seedDoneJob(id);
    setJobsTestHooks({ qualityVerifier: unwiredVerifier, prepareRenderGeneration: async input => asyncPrepared(input),
      generationFailpoints: { afterSealBeforePointer: () => {
        writeFileSync(join(jobDir(id), "assets", "panel_bottom.png"), NEW_B);
      } },
    });
    enqueueAsync(id);
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "failed", "stale face after seal");
    assert.equal(loadMockup(id)?.current_render_generation_id, undefined);
    assert.deepEqual(fileBytes(loadMockup(id)!, "white_a"), WHITE_A);
  });
});

describe("RF-03B generation queue", () => {
  it("refuses enqueue when trusted adapters are missing and leaves no fake queued mutation", () => {
    const id = tid(1);
    seedDoneJob(id);
    const source = virtualId(id);
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          jobId: id,
          viewer,
          clientRequestId: "req-missing-adapters",
          mode: "legacy_relight",
          sourceGenerationId: source,
          expectedCurrentGenerationId: source,
        }),
      "render_generation_unavailable",
    );
    const job = loadMockup(id);
    assert.equal(job?.status, "done");
    assert.equal(job?.render_mutation, undefined);
    assert.equal(job?.current_render_generation_id, undefined);
  });

  it("queues behind the shared Blender slot, keeps old files readable, then commits once", async () => {
    const id = tid(2);
    seedDoneJob(id);
    const source = virtualId(id);
    const gate = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: gate.run }));
    setJobsLiveForTest("blender", tid(99));
    const first = enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-slot-wait-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    assert.equal(first.mutation.status, "queued");
    assert.equal(first.job_status, "done");
    assert.equal(queueSnapshot().blender.queued >= 1, true);
    assert.equal(fileBytes(loadMockup(id)!, "white_a").equals(WHITE_A), true);
    const again = enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-slot-wait-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    assert.equal(again.mutation.id, first.mutation.id);
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          jobId: id,
          viewer,
          clientRequestId: "req-slot-wait-01",
          mode: "upgrade",
          sourceGenerationId: source,
          expectedCurrentGenerationId: source,
        }),
      "render_generation_invalid",
    );
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          jobId: id,
          viewer,
          clientRequestId: "req-other-busy-01",
          mode: "legacy_relight",
          sourceGenerationId: source,
          expectedCurrentGenerationId: source,
        }),
      "render_generation_busy",
    );
    setJobsLiveForTest("blender", null);
    tryStart();
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "running", "should claim blender");
    assert.equal(loadMockup(id)?.status, "done");
    assert.equal(fileBytes(loadMockup(id)!, "white_a").equals(WHITE_A), true);
    gate.release(true);
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "succeeded", "should commit");
    const done = loadMockup(id)!;
    assert.equal(done.status, "done");
    assert.ok(done.current_render_generation_id);
    assert.notEqual(done.current_render_generation_id, G0_LEGACY_ORIGINAL_ID);
    assert.equal(fileBytes(done, "white_a").equals(NEW_A), true);
    assert.equal(done.files.some((f) => f.key === "ppt"), true);
    assert.equal(done.files.some((f) => f.key === "sheet"), true);
    const pub = publicMockup(done);
    const blob = JSON.stringify(pub);
    assert.equal(pub.has_render_generations, true);
    assert.equal(pub.current_render_generation_id, done.current_render_generation_id);
    assert.equal("render_generation_request" in pub, false);
    assert.doesNotMatch(blob, /render_generation_request|render_generation_idempotency|candidateDir|\.render-generations|\/Users\/|WB_DATA_DIR/);
    assert.equal(pub.files.every((f) => !("path" in f)), true);
    const summaryBlob = JSON.stringify(publicMockupSummary(done));
    assert.doesNotMatch(summaryBlob, /render_generation_request|render_generation_idempotency|\.candidate-/);
  });

  it("rereads disk so a poisoned cache cannot switch the wrong current", async () => {
    const id = tid(3);
    seedDoneJob(id);
    const source = virtualId(id);
    const gate = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: gate.run }));
    enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-cache-poison-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "running", "running");
    const cached = loadMockup(id)!;
    cached.current_render_generation_id = "g0-legacy-original";
    gate.release(true);
    await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "succeeded", "committed from disk");
    const disk = readMockupFromDisk(id)!;
    assert.ok(disk.current_render_generation_id);
    assert.notEqual(disk.current_render_generation_id, "g0-legacy-original");
    assert.equal(loadMockup(id)?.current_render_generation_id, disk.current_render_generation_id);
  });

  it("keeps disk and cache on the old current when pointer write fails", async () => {
    const id = tid(4);
    seedDoneJob(id);
    const source = virtualId(id);
    const gate = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: gate.run }));
    enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-write-fail-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "running", "running");
    setMockupAtomicWriteTestHooks({
      rename: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    });
    gate.release(true);
    await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "failed", "write fail closed");
    const disk = readMockupFromDisk(id)!;
    assert.equal(disk.current_render_generation_id, undefined);
    assert.equal(fileBytes(disk, "white_a").equals(WHITE_A), true);
    assert.equal(loadMockup(id)?.current_render_generation_id, undefined);
  });

  it("leaves a ready orphan when seal succeeds but pointer commit is aborted, and boot recovery is idempotent", async () => {
    const id = tid(5);
    seedDoneJob(id);
    const source = virtualId(id);
    const gate = gatedExecutor();
    setJobsTestHooks(generationHooks({
      runRenderGeneration: gate.run,
      generationFailpoints: {
        afterSealBeforePointer: () => {
          throw new Error("pointer-before-fail");
        },
      },
    }));
    enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-orphan-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    gate.release(true);
    await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "failed", "orphan fail");
    const dir = join(jobDir(id), RENDER_GENERATION_DIR);
    const ready = readdirSync(dir).filter((name) => name.startsWith("g"));
    assert.ok(ready.includes(G0_LEGACY_ORIGINAL_ID));
    assert.ok(ready.some((name) => name.startsWith("g1-")));
    assert.equal(readMockupFromDisk(id)?.current_render_generation_id, undefined);
    const store = openRenderGenerationStore({ jobRoot: jobDir(id), jobId: id, qualityVerifier: unwiredVerifier });
    const first = store.recoverOrphans();
    const second = store.recoverOrphans();
    reclaimOnBoot();
    reclaimOnBoot();
    assert.deepEqual(second.recovered, []);
    assert.ok([...first.already_indexed, ...first.recovered].length >= 1);
    assert.equal(readMockupFromDisk(id)?.current_render_generation_id, undefined);
    assert.equal(fileBytes(loadMockup(id)!, "white_a").equals(WHITE_A), true);
  });

  it("does not switch current when the executor fails or returns illegal paths", async () => {
    const failId = tid(6);
    seedDoneJob(failId);
    const failSource = virtualId(failId);
    const failGate = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: failGate.run }));
    enqueueRenderGenerationMutation({
      jobId: failId,
      viewer,
      clientRequestId: "req-exec-fail-01",
      mode: "legacy_relight",
      sourceGenerationId: failSource,
      expectedCurrentGenerationId: failSource,
    });
    failGate.release(false);
    await waitUntil(() => readMockupFromDisk(failId)?.render_mutation?.status === "failed", "executor fail");
    assert.equal(readMockupFromDisk(failId)?.current_render_generation_id, undefined);

    const badId = tid(7);
    seedDoneJob(badId);
    const badSource = virtualId(badId);
    const badGate = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: badGate.run }));
    enqueueRenderGenerationMutation({
      jobId: badId,
      viewer,
      clientRequestId: "req-illegal-out-01",
      mode: "legacy_relight",
      sourceGenerationId: badSource,
      expectedCurrentGenerationId: badSource,
    });
    badGate.release(true, true);
    await waitUntil(() => readMockupFromDisk(badId)?.render_mutation?.status === "failed", "illegal output");
    assert.equal(readMockupFromDisk(badId)?.current_render_generation_id, undefined);
    assert.equal(fileBytes(loadMockup(badId)!, "white_a").equals(WHITE_A), true);
  });

  it("rejects stale, unauthorized, and old in-place entry points without replacing images", async () => {
    const id = tid(8);
    const seeded = seedDoneJob(id);
    const source = virtualId(id);
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          jobId: id,
          viewer,
          clientRequestId: "req-stale-01",
          mode: "legacy_relight",
          sourceGenerationId: source,
          expectedCurrentGenerationId: "legacy-current-deadbeef",
        }),
      "render_generation_stale",
    );
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          jobId: id,
          viewer,
          clientRequestId: "req-profile-01",
          mode: "legacy_relight",
          sourceGenerationId: source,
          expectedCurrentGenerationId: source,
          profile: "compat-legacy-v0",
        } as never),
      "render_generation_invalid",
    );
    try {
      enqueueRenderGenerationMutation({
        jobId: id,
        viewer: { id: "other", name: "别人", admin: false },
        clientRequestId: "req-forbid-01",
        mode: "legacy_relight",
        sourceGenerationId: source,
        expectedCurrentGenerationId: source,
      });
      assert.fail("expected 403");
    } catch (err) {
      assert.equal((err as { status?: number }).status, 403);
    }
    assert.equal(loadMockup(id)?.render_mutation, undefined);
    const gate = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: gate.run }));
    enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-old-entry-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    gate.release(true);
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "succeeded", "managed");
    const before = fileBytes(loadMockup(id)!, "white_a");
    try {
      await relightMockupStudio(id, viewer);
      assert.fail("relight should reject");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "render_generation_managed");
    }
    try {
      await repairMockupPrintFaces(id, viewer);
      assert.fail("print faces should reject");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "render_generation_managed");
    }
    try {
      retryMockup(id, viewer);
      assert.fail("retry should reject");
    } catch (err) {
      assert.ok((err as { code?: string }).code === "render_generation_managed" || (err as Error).message.includes("已经出图"));
    }
    assert.equal(fileBytes(loadMockup(id)!, "white_a").equals(before), true);
    assert.equal(existsSync(seeded.whiteA), true);
  });

  it("activates a ready generation without occupying the Blender slot", async () => {
    const id = tid(9);
    seedDoneJob(id);
    const source = virtualId(id);
    const gate = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: gate.run }));
    enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-activate-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    gate.release(true);
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "succeeded", "first gen");
    const current = loadMockup(id)!.current_render_generation_id!;
    setJobsLiveForTest("blender", tid(77));
    const activated = activateRenderGeneration({
      jobId: id,
      viewer,
      generationId: G0_LEGACY_ORIGINAL_ID,
      expectedCurrentGenerationId: current,
    });
    assert.equal(activated.current_render_generation_id, G0_LEGACY_ORIGINAL_ID);
    assert.equal(fileBytes(activated, "white_a").equals(WHITE_A), true);
    assert.equal(queueSnapshot().blender.running >= 1, true);
  });

  const RECOVERY_MUTATION_ID = "m0123456789abcdef";

  function seedInterruptedRunning(id: string, pid: number): void {
    seedDoneJob(id);
    const job = loadMockup(id)!;
    const source = virtualId(id);
    job.render_mutation = { id: RECOVERY_MUTATION_ID, mode: "legacy_relight", status: "running", stage: "出图" };
    job.render_generation_request = {
      client_request_id: "req-boot-01",
      payload_sha256: createHash("sha256").update("x").digest("hex"),
      mutation_id: RECOVERY_MUTATION_ID,
      mode: "legacy_relight",
      source_generation_id: source,
      expected_current_generation_id: source,
      started_current_generation_id: null,
      created_at: "2026-09-05T00:00:00.000Z",
      actor_id: "ou_gen",
      worker_pid: pid,
    };
    saveMockup(job);
  }

  function enqueueWaiter(id: string, requestId: string) {
    const source = virtualId(id);
    return enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: requestId,
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
  }

  for (const parentState of ["missing", "other"] as const) {
    for (const groupState of ["present", "unknown", "throws"] as const) {
      it(`keeps the new-protocol fence for parent=${parentState}, group=${groupState}, until group absence is proved`, async () => {
        const id = tid(510), waiter = tid(511), pid = 72510;
        seedInterruptedRunning(id, pid); seedDoneJob(waiter);
        const job = loadMockup(id)!;
        job.render_generation_request!.worker_protocol = "render-generation/1";
        job.render_generation_request!.worker_execution_id = `${id}:${RECOVERY_MUTATION_ID}:${"d".repeat(32)}`;
        saveMockup(job);
        let released = false, executions = 0;
        setJobsTestHooks(generationHooks({
          inspectWorker: () => parentState,
          inspectGenerationGroup: value => {
            assert.equal(value, pid);
            if (released) return "missing";
            if (groupState === "throws") throw new Error("probe unavailable");
            return groupState;
          },
          killTree: () => { assert.fail("legacy killer must not be used"); },
          killGenerationGroup: () => { assert.fail("unowned parent/group must not be killed"); },
          runRenderGeneration: async input => {
            executions++;
            return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
          },
        }));
        enqueueWaiter(waiter, "orphan-waiter");
        reclaimOnBoot(); reclaimOnBoot();
        assertFenceHolds(id, waiter, pid, executions);
        released = true;
        reclaimOnBoot();
        await waitUntil(() => loadMockup(waiter)?.render_mutation?.status === "succeeded", "group absence releases waiter");
        assert.equal(executions, 1);
        assert.equal(readMockupFromDisk(id)?.render_generation_request?.worker_pid, undefined);
      });
    }
  }

  it("keeps the new-protocol fence when terminating the owned parent leaves its group alive", async () => {
    const id = tid(520), waiter = tid(521), pid = 72520;
    seedInterruptedRunning(id, pid); seedDoneJob(waiter);
    const job = loadMockup(id)!;
    job.render_generation_request!.worker_protocol = "render-generation/1";
    job.render_generation_request!.worker_execution_id = `${id}:${RECOVERY_MUTATION_ID}:${"e".repeat(32)}`;
    saveMockup(job);
    let parent: "owned" | "missing" = "owned", group: "present" | "missing" = "present";
    let kills = 0, executions = 0;
    setJobsTestHooks(generationHooks({
      inspectWorker: () => parent,
      inspectGenerationGroup: () => group,
      killTree: () => { assert.fail("no legacy PID fallback"); },
      killGenerationGroup: (value, force) => {
        assert.equal(value, pid); assert.equal(force, true);
        kills++; parent = "missing";
      },
      runRenderGeneration: async input => {
        executions++;
        return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
      },
    }));
    enqueueWaiter(waiter, "owned-orphan-waiter");
    reclaimOnBoot(); reclaimOnBoot();
    assertFenceHolds(id, waiter, pid, executions);
    assert.equal(kills, 1, "do not re-signal an orphan group using a stale parent identity");
    group = "missing";
    reclaimOnBoot();
    await waitUntil(() => loadMockup(waiter)?.render_mutation?.status === "succeeded", "whole group released");
    assert.equal(executions, 1);
  });

  function assertFenceHolds(oldId: string, nextId: string, pid: number, executions: number): void {
    const disk = readMockupFromDisk(oldId)!;
    assert.equal(disk.render_mutation?.status, "running");
    assert.equal(disk.render_generation_request?.worker_pid, pid);
    assert.equal(disk.current_render_generation_id, undefined);
    assert.equal(readMockupFromDisk(nextId)?.render_mutation?.status, "queued");
    assert.equal(executions, 0);
    assert.equal(queueSnapshot().blender.running >= 1, true);
    expectCode(() => enqueueWaiter(oldId, "req-same-job-busy"), "render_generation_busy");
    assert.equal(readMockupFromDisk(oldId)?.render_mutation?.id, RECOVERY_MUTATION_ID);
  }

  it("holds the Blender slot when owned kill fails and two recoveries cannot start another job", () => {
    const oldId = tid(10);
    const nextId = tid(110);
    seedInterruptedRunning(oldId, 4242);
    seedDoneJob(nextId);
    let inspects = 0;
    let kills = 0;
    let executions = 0;
    setJobsTestHooks(generationHooks({
      inspectWorker: (pid, expected) => {
        inspects += 1;
        assert.equal(pid, 4242);
        assert.deepEqual(expected, { kind: "mockup", id: oldId });
        return "owned";
      },
      killTree: () => {
        kills += 1;
        throw new Error("synthetic kill failure");
      },
      runRenderGeneration: async (input) => {
        executions += 1;
        return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
      },
    }));
    enqueueWaiter(nextId, "recovery-next-owned-kill");
    reclaimOnBoot();
    reclaimOnBoot();
    assertFenceHolds(oldId, nextId, 4242, executions);
    assert.equal(inspects >= 2, true);
    assert.equal(kills >= 2, true);
  });

  it("holds the Blender slot when kill returns but the worker is still owned", () => {
    const oldId = tid(11);
    const nextId = tid(111);
    seedInterruptedRunning(oldId, 4343);
    seedDoneJob(nextId);
    let inspects = 0;
    let kills = 0;
    let executions = 0;
    setJobsTestHooks(generationHooks({
      inspectWorker: (pid, expected) => {
        inspects += 1;
        assert.equal(pid, 4343);
        assert.deepEqual(expected, { kind: "mockup", id: oldId });
        return "owned";
      },
      killTree: (pid, force) => {
        assert.equal(pid, 4343);
        assert.equal(force, true);
        kills += 1;
      },
      runRenderGeneration: async (input) => {
        executions += 1;
        return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
      },
    }));
    enqueueWaiter(nextId, "recovery-next-still-owned");
    reclaimOnBoot();
    reclaimOnBoot();
    assertFenceHolds(oldId, nextId, 4343, executions);
    assert.equal(inspects >= 4, true);
    assert.equal(kills >= 2, true);
  });

  it("holds the Blender slot for unknown workers without killing, across two recoveries", () => {
    const oldId = tid(12);
    const nextId = tid(112);
    seedInterruptedRunning(oldId, 4444);
    seedDoneJob(nextId);
    let inspects = 0;
    let kills = 0;
    let executions = 0;
    setJobsTestHooks(generationHooks({
      inspectWorker: () => {
        inspects += 1;
        return "unknown";
      },
      killTree: () => {
        kills += 1;
        throw new Error("must not kill unknown");
      },
      runRenderGeneration: async (input) => {
        executions += 1;
        return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
      },
    }));
    enqueueWaiter(nextId, "recovery-next-unknown");
    reclaimOnBoot();
    reclaimOnBoot();
    assertFenceHolds(oldId, nextId, 4444, executions);
    assert.equal(inspects >= 2, true);
    assert.equal(kills, 0);
    const publicBlob = JSON.stringify(publicMockup(readMockupFromDisk(oldId)!));
    assert.doesNotMatch(publicBlob, /worker_pid|render_generation_request/);
  });

  it("releases the Blender slot without killing when the persisted worker is missing", async () => {
    const oldId = tid(13);
    const nextId = tid(113);
    seedInterruptedRunning(oldId, 4545);
    seedDoneJob(nextId);
    let kills = 0;
    let executions = 0;
    setJobsTestHooks(generationHooks({
      inspectWorker: () => "missing",
      killTree: () => {
        kills += 1;
      },
      runRenderGeneration: async (input) => {
        executions += 1;
        return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
      },
    }));
    enqueueWaiter(nextId, "recovery-next-missing");
    reclaimOnBoot();
    await waitUntil(() => readMockupFromDisk(nextId)?.render_mutation?.status === "succeeded", "missing released next");
    assert.equal(readMockupFromDisk(oldId)?.render_mutation?.status, "failed");
    assert.equal(readMockupFromDisk(oldId)?.current_render_generation_id, undefined);
    assert.equal(kills, 0);
    assert.equal(executions, 1);
    const again = enqueueWaiter(oldId, "req-after-missing-release");
    assert.equal(again.mutation.status === "queued" || again.mutation.status === "running" || again.mutation.status === "succeeded", true);
    await waitUntil(() => readMockupFromDisk(oldId)?.render_mutation?.status === "succeeded", "old job after missing");
    assert.notEqual(readMockupFromDisk(oldId)?.render_mutation?.id, RECOVERY_MUTATION_ID);
  });

  it("releases the Blender slot without killing when the pid now belongs to another process", async () => {
    const oldId = tid(14);
    const nextId = tid(114);
    seedInterruptedRunning(oldId, 4646);
    seedDoneJob(nextId);
    let kills = 0;
    let executions = 0;
    setJobsTestHooks(generationHooks({
      inspectWorker: () => "other",
      killTree: () => {
        kills += 1;
        throw new Error("must not kill reused pid");
      },
      runRenderGeneration: async (input) => {
        executions += 1;
        return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
      },
    }));
    enqueueWaiter(nextId, "recovery-next-other");
    reclaimOnBoot();
    await waitUntil(() => readMockupFromDisk(nextId)?.render_mutation?.status === "succeeded", "other released next");
    assert.equal(readMockupFromDisk(oldId)?.render_mutation?.status, "failed");
    assert.equal(readMockupFromDisk(oldId)?.current_render_generation_id, undefined);
    assert.equal(kills, 0);
    assert.equal(executions, 1);
  });

  it("keeps a waiter queued behind an unconfirmed worker then commits after a safe release", async () => {
    const oldId = tid(15);
    const nextId = tid(115);
    seedInterruptedRunning(oldId, 4747);
    seedDoneJob(nextId);
    let inspectState: "owned" | "missing" = "owned";
    let executions = 0;
    setJobsTestHooks(generationHooks({
      inspectWorker: () => inspectState,
      killTree: () => {
        throw new Error("synthetic kill failure");
      },
      runRenderGeneration: async (input) => {
        executions += 1;
        return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
      },
    }));
    enqueueWaiter(nextId, "recovery-next-then-release");
    reclaimOnBoot();
    assertFenceHolds(oldId, nextId, 4747, executions);
    inspectState = "missing";
    reclaimOnBoot();
    await waitUntil(() => readMockupFromDisk(nextId)?.render_mutation?.status === "succeeded", "safe release then commit");
    assert.equal(readMockupFromDisk(oldId)?.render_mutation?.status, "failed");
    assert.equal(executions, 1);
    assert.equal(fileBytes(readMockupFromDisk(nextId)!, "white_a").equals(NEW_A), true);
  });

  it("replays terminal mutations by clientRequestId after current switches, later requests, and payload conflicts", async () => {
    assert.equal(RENDER_GENERATION_IDEMPOTENCY_LIMIT, 16);
    const successId = tid(11);
    seedDoneJob(successId);
    const successSource = virtualId(successId);
    const successGate = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: successGate.run }));
    const firstInput = {
      jobId: successId,
      viewer,
      clientRequestId: "req-replay-success-01",
      mode: "legacy_relight" as const,
      sourceGenerationId: successSource,
      expectedCurrentGenerationId: successSource,
    };
    const first = enqueueRenderGenerationMutation(firstInput);
    successGate.release(true);
    await waitUntil(() => readMockupFromDisk(successId)?.render_mutation?.status === "succeeded", "first succeeded");
    const afterFirst = readMockupFromDisk(successId)!;
    const firstMutationId = first.mutation.id;
    const firstCurrent = afterFirst.current_render_generation_id;
    assert.ok(firstCurrent);
    assert.notEqual(firstCurrent, successSource);
    const replaySuccess = enqueueRenderGenerationMutation(firstInput);
    assert.equal(replaySuccess.mutation.id, firstMutationId);
    assert.equal(replaySuccess.mutation.status, "succeeded");
    assert.equal(replaySuccess.current_render_generation_id, firstCurrent);
    assert.equal(readMockupFromDisk(successId)?.render_mutation?.id, firstMutationId);
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          ...firstInput,
          mode: "upgrade",
        }),
      "render_generation_invalid",
    );
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          jobId: successId,
          viewer,
          clientRequestId: "req-replay-new-stale-01",
          mode: "legacy_relight",
          sourceGenerationId: successSource,
          expectedCurrentGenerationId: successSource,
        }),
      "render_generation_stale",
    );
    try {
      enqueueRenderGenerationMutation({ ...firstInput, viewer: { id: "other", name: "别人", admin: false } });
      assert.fail("expected 403");
    } catch (err) {
      assert.equal((err as { status?: number }).status, 403);
    }

    const secondGate = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: secondGate.run }));
    const second = enqueueRenderGenerationMutation({
      jobId: successId,
      viewer,
      clientRequestId: "req-replay-second-01",
      mode: "legacy_relight",
      sourceGenerationId: firstCurrent,
      expectedCurrentGenerationId: firstCurrent,
    });
    assert.equal(second.mutation.status === "queued" || second.mutation.status === "running", true);
    assert.notEqual(second.mutation.id, firstMutationId);
    const replayFirstWhileSecondQueued = enqueueRenderGenerationMutation(firstInput);
    assert.equal(replayFirstWhileSecondQueued.mutation.id, firstMutationId);
    assert.equal(replayFirstWhileSecondQueued.mutation.status, "succeeded");
    secondGate.release(true);
    await waitUntil(() => readMockupFromDisk(successId)?.render_mutation?.id === second.mutation.id, "second claimed");
    await waitUntil(() => readMockupFromDisk(successId)?.render_mutation?.status === "succeeded", "second succeeded");
    const afterSecond = readMockupFromDisk(successId)!;
    assert.notEqual(afterSecond.current_render_generation_id, firstCurrent);
    assert.equal(afterSecond.render_mutation?.id, second.mutation.id);
    const replayFirstAfterSecond = enqueueRenderGenerationMutation(firstInput);
    assert.equal(replayFirstAfterSecond.mutation.id, firstMutationId);
    assert.equal(replayFirstAfterSecond.mutation.status, "succeeded");
    assert.notEqual(replayFirstAfterSecond.mutation.id, afterSecond.render_mutation?.id);
    assert.equal(replayFirstAfterSecond.current_render_generation_id, afterSecond.current_render_generation_id);
    const replaySecond = enqueueRenderGenerationMutation({
      jobId: successId,
      viewer,
      clientRequestId: "req-replay-second-01",
      mode: "legacy_relight",
      sourceGenerationId: firstCurrent,
      expectedCurrentGenerationId: firstCurrent,
    });
    assert.equal(replaySecond.mutation.id, second.mutation.id);
    assert.equal(replaySecond.mutation.status, "succeeded");
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          jobId: successId,
          viewer,
          clientRequestId: "req-replay-second-01",
          mode: "upgrade",
          sourceGenerationId: firstCurrent,
          expectedCurrentGenerationId: firstCurrent,
        }),
      "render_generation_invalid",
    );
    const facts = afterSecond.render_generation_idempotency || [];
    assert.equal(facts.some((row) => row.client_request_id === "req-replay-success-01"), true);
    assert.equal(facts.some((row) => row.client_request_id === "req-replay-second-01"), true);
    const pub = publicMockup(afterSecond);
    assert.equal("render_generation_idempotency" in pub, false);
    assert.doesNotMatch(JSON.stringify(pub), /render_generation_idempotency|payload_sha256/);

    const failId = tid(12);
    seedDoneJob(failId);
    const failSource = virtualId(failId);
    const failGate = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: failGate.run }));
    const failInput = {
      jobId: failId,
      viewer,
      clientRequestId: "req-replay-fail-01",
      mode: "legacy_relight" as const,
      sourceGenerationId: failSource,
      expectedCurrentGenerationId: failSource,
    };
    const failed = enqueueRenderGenerationMutation(failInput);
    failGate.release(false);
    await waitUntil(() => readMockupFromDisk(failId)?.render_mutation?.status === "failed", "executor failed");
    assert.equal(readMockupFromDisk(failId)?.current_render_generation_id, undefined);
    const replayFailed = enqueueRenderGenerationMutation(failInput);
    assert.equal(replayFailed.mutation.id, failed.mutation.id);
    assert.equal(replayFailed.mutation.status, "failed");
    assert.equal(readMockupFromDisk(failId)?.render_mutation?.id, failed.mutation.id);
    assert.equal(readMockupFromDisk(failId)?.current_render_generation_id, undefined);
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          ...failInput,
          mode: "upgrade",
        }),
      "render_generation_invalid",
    );
    assert.equal(fileBytes(loadMockup(failId)!, "white_a").equals(WHITE_A), true);
  });

  it("fail-closes new requestIds at the bounded ledger and still replays accepted ones", async () => {
    const id = tid(13);
    seedDoneJob(id);
    const source = virtualId(id);
    let runs = 0;
    setJobsTestHooks(generationHooks({
      runRenderGeneration: async () => {
        runs += 1;
        throw new Error("synthetic failure");
      },
    }));
    const mutationIds: string[] = [];
    for (let n = 0; n < RENDER_GENERATION_IDEMPOTENCY_LIMIT; n += 1) {
      const result = enqueueRenderGenerationMutation({
        jobId: id,
        viewer,
        clientRequestId: `eviction-request-${n}`,
        mode: "legacy_relight",
        sourceGenerationId: source,
        expectedCurrentGenerationId: source,
      });
      if (n === 0) mutationIds[0] = result.mutation.id;
      mutationIds[n] = result.mutation.id;
      await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "failed", `failed terminal ${n}`);
    }
    const firstFailedId = mutationIds[0];
    assert.equal(runs, RENDER_GENERATION_IDEMPOTENCY_LIMIT);
    const full = readMockupFromDisk(id)!;
    const facts = full.render_generation_idempotency || [];
    assert.equal(facts.length, RENDER_GENERATION_IDEMPOTENCY_LIMIT);
    assert.equal(facts[0]?.client_request_id, "eviction-request-0");
    assert.equal(facts[0]?.mutation.id, firstFailedId);
    assert.equal(
      facts.some((row) => row.client_request_id === `eviction-request-${RENDER_GENERATION_IDEMPOTENCY_LIMIT}`),
      false,
    );
    try {
      enqueueRenderGenerationMutation({
        jobId: id,
        viewer,
        clientRequestId: `eviction-request-${RENDER_GENERATION_IDEMPOTENCY_LIMIT}`,
        mode: "legacy_relight",
        sourceGenerationId: source,
        expectedCurrentGenerationId: source,
      });
      assert.fail("expected full ledger to reject a new requestId");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "render_generation_invalid", String(err));
      assert.match((err as Error).message, /账本已满/);
    }
    assert.equal(runs, RENDER_GENERATION_IDEMPOTENCY_LIMIT);
    const afterReject = readMockupFromDisk(id)!;
    assert.equal((afterReject.render_generation_idempotency || []).length, RENDER_GENERATION_IDEMPOTENCY_LIMIT);
    assert.equal(afterReject.render_mutation?.id, mutationIds[RENDER_GENERATION_IDEMPOTENCY_LIMIT - 1]);
    assert.equal(afterReject.current_render_generation_id, undefined);
    const repeated = enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "eviction-request-0",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    assert.equal(repeated.mutation.id, firstFailedId);
    assert.equal(repeated.mutation.status, "failed");
    assert.equal(repeated.mutation.id !== firstFailedId, false);
    assert.equal(runs, RENDER_GENERATION_IDEMPOTENCY_LIMIT);
    assert.equal(readMockupFromDisk(id)?.render_mutation?.id, mutationIds[RENDER_GENERATION_IDEMPOTENCY_LIMIT - 1]);
    assert.equal(readMockupFromDisk(id)?.current_render_generation_id, undefined);
    const lastReplay = enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: `eviction-request-${RENDER_GENERATION_IDEMPOTENCY_LIMIT - 1}`,
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    assert.equal(lastReplay.mutation.id, mutationIds[RENDER_GENERATION_IDEMPOTENCY_LIMIT - 1]);
    assert.equal(lastReplay.mutation.status, "failed");
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          jobId: id,
          viewer,
          clientRequestId: "eviction-request-0",
          mode: "upgrade",
          sourceGenerationId: source,
          expectedCurrentGenerationId: source,
        }),
      "render_generation_invalid",
    );
    assert.equal(runs, RENDER_GENERATION_IDEMPOTENCY_LIMIT);
    assert.equal(fileBytes(loadMockup(id)!, "white_a").equals(WHITE_A), true);
    const pub = publicMockup(readMockupFromDisk(id)!);
    assert.equal("render_generation_idempotency" in pub, false);
    assert.doesNotMatch(JSON.stringify(pub), /render_generation_idempotency|eviction-request-0|payload_sha256/);
  });

  it("refuses enqueue when the plan verifier is missing even if executor and quality are injected", () => {
    const id = tid(14);
    seedDoneJob(id);
    const source = virtualId(id);
    setJobsTestHooks({
      qualityVerifier: unwiredVerifier,
      runRenderGeneration: async (input) => bindExecutorResult(input, writeExecutorOutputs(input.candidateDir)),
    });
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          jobId: id,
          viewer,
          clientRequestId: "req-missing-plan-verifier",
          mode: "legacy_relight",
          sourceGenerationId: source,
          expectedCurrentGenerationId: source,
        }),
      "render_generation_unavailable",
    );
    assert.equal(readMockupFromDisk(id)?.render_mutation, undefined);
    assert.equal(readMockupFromDisk(id)?.current_render_generation_id, undefined);
  });

  it("rejects a verifier that self-reports a hash and does not leave a queued mutation", () => {
    const id = tid(15);
    seedDoneJob(id);
    const source = virtualId(id);
    setJobsTestHooks(generationHooks({
      verifyRenderPlan: (input) => ({
        identitySha256: "ab".repeat(32),
        bytes: input.bytes,
        profile: "compat-legacy-v0",
        verifier: "rf03b-spoof-hash",
      }),
      runRenderGeneration: async (input) => bindExecutorResult(input, writeExecutorOutputs(input.candidateDir)),
    }));
    expectCode(
      () =>
        enqueueRenderGenerationMutation({
          jobId: id,
          viewer,
          clientRequestId: "req-spoof-hash-01",
          mode: "legacy_relight",
          sourceGenerationId: source,
          expectedCurrentGenerationId: source,
        }),
      "render_generation_invalid",
    );
    assert.equal(readMockupFromDisk(id)?.render_mutation, undefined);
  });

  it("passes immutable verified plan, source outputs and lighting to the executor and commits when nothing changes", async () => {
    const id = tid(16);
    seedDoneJob(id);
    const source = virtualId(id);
    let captured: RenderGenerationExecuteInput | undefined;
    const gate = gatedExecutor();
    const originalRun = gate.run;
    setJobsTestHooks(generationHooks({
      runRenderGeneration: async (input) => {
        captured = input;
        return originalRun(input);
      },
    }));
    enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-lighting-arrive-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
      studioAdjustment: { product_light: 1.2, background_light: 0.8 },
    });
    gate.release(true);
    await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "succeeded", "lighting commit");
    assert.ok(captured);
    assert.equal("contractSha256" in captured, false);
    assert.equal("profile" in captured, false);
    assert.equal(captured.studioAdjustment?.product_light, 1.2);
    assert.equal(captured.studioAdjustment?.background_light, 0.8);
    assert.equal(captured.plan.profile, "compat-legacy-v0");
    assert.equal(captured.plan.verifier, "rf03b-test-plan");
    assert.equal(Buffer.isBuffer(captured.plan.bytes), true);
    assert.equal(captured.plan.bytes.length > 0, true);
    assert.equal(captured.plan.identitySha256, createHash("sha256").update(captured.plan.bytes).digest("hex"));
    assert.equal(captured.sourceOutputs.some((row) => row.key === "white_a"), true);
    assert.equal(captured.sourceOutputs.some((row) => row.key === "white_b"), true);
    assert.equal(captured.sourceOutputs.some((row) => row.key === "glb"), true);
    const done = readMockupFromDisk(id)!;
    assert.ok(done.current_render_generation_id);
    assert.equal(fileBytes(done, "white_a").equals(NEW_A), true);
    assert.equal(done.render_generation_request?.studio_adjustment?.product_light, 1.2);
    assert.equal(done.render_generation_request?.studio_adjustment?.background_light, 0.8);
  });

  it("keeps the old current when request identity fields are mutated or missing after seal", async () => {
    const lighting = { product_light: 1.2, background_light: 0.8 };
    const cases: Array<{ label: string; apply: (job: NonNullable<ReturnType<typeof readMockupFromDisk>>) => void }> = [
      { label: "source_generation_id", apply: (job) => { job.render_generation_request!.source_generation_id = "g-other-source"; } },
      { label: "mode", apply: (job) => { job.render_generation_request!.mode = "upgrade"; } },
      { label: "payload_sha256", apply: (job) => { job.render_generation_request!.payload_sha256 = "ab".repeat(32); } },
      { label: "expected_current_generation_id", apply: (job) => { job.render_generation_request!.expected_current_generation_id = "legacy-current-deadbeef"; } },
      { label: "started_current_generation_id", apply: (job) => { job.render_generation_request!.started_current_generation_id = "g0-legacy-original"; } },
      { label: "mutation_id", apply: (job) => { job.render_generation_request!.mutation_id = "mffffffffffffffff"; } },
      { label: "client_request_id", apply: (job) => { job.render_generation_request!.client_request_id = "tampered-request-01"; } },
      { label: "product_light", apply: (job) => { job.render_generation_request!.studio_adjustment = { ...lighting, product_light: 9 }; } },
      { label: "background_light", apply: (job) => { job.render_generation_request!.studio_adjustment = { ...lighting, background_light: 9 }; } },
      { label: "missing source_generation_id", apply: (job) => { delete (job.render_generation_request as { source_generation_id?: string }).source_generation_id; } },
      { label: "missing mode", apply: (job) => { delete (job.render_generation_request as { mode?: string }).mode; } },
      { label: "missing payload_sha256", apply: (job) => { delete (job.render_generation_request as { payload_sha256?: string }).payload_sha256; } },
      { label: "missing expected_current_generation_id", apply: (job) => { delete (job.render_generation_request as { expected_current_generation_id?: string }).expected_current_generation_id; } },
      { label: "missing studio_adjustment", apply: (job) => { delete job.render_generation_request!.studio_adjustment; } },
      { label: "missing request", apply: (job) => { delete job.render_generation_request; } },
    ];
    for (const [index, item] of cases.entries()) {
      const id = tid(30 + index);
      seedDoneJob(id);
      const source = virtualId(id);
      const gate = gatedExecutor();
      setJobsTestHooks(generationHooks({
        runRenderGeneration: gate.run,
        generationFailpoints: {
          afterSealBeforePointer: () => {
            const disk = readMockupFromDisk(id)!;
            item.apply(disk);
            saveMockup(disk);
          },
        },
      }));
      enqueueRenderGenerationMutation({
        jobId: id,
        viewer,
        clientRequestId: `req-identity-${index.toString().padStart(2, "0")}`,
        mode: "legacy_relight",
        sourceGenerationId: source,
        expectedCurrentGenerationId: source,
        studioAdjustment: lighting,
      });
      gate.release(true);
      await waitUntil(() => ["failed", "succeeded"].includes(readMockupFromDisk(id)?.render_mutation?.status || ""), item.label);
      const disk = readMockupFromDisk(id)!;
      assert.equal(disk.render_mutation?.status, "failed", item.label);
      assert.equal(disk.current_render_generation_id, undefined, item.label);
      assert.equal(fileBytes(disk, "white_a").equals(WHITE_A), true, item.label);
      const ready = readdirSync(join(jobDir(id), RENDER_GENERATION_DIR)).filter((name) => name.startsWith("g"));
      assert.ok(ready.includes(G0_LEGACY_ORIGINAL_ID), item.label);
      assert.ok(ready.some((name) => name.startsWith("g1-")), `${item.label} ready orphan`);
    }
  });

  it("keeps the old current when the plan changes in flight or after seal", async () => {
    const idInflight = tid(50);
    seedDoneJob(idInflight);
    const sourceInflight = virtualId(idInflight);
    const gateInflight = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: gateInflight.run }));
    enqueueRenderGenerationMutation({
      jobId: idInflight,
      viewer,
      clientRequestId: "req-plan-inflight-01",
      mode: "legacy_relight",
      sourceGenerationId: sourceInflight,
      expectedCurrentGenerationId: sourceInflight,
    });
    await waitUntil(() => readMockupFromDisk(idInflight)?.render_mutation?.status === "running", "inflight running");
    writeFileSync(join(jobDir(idInflight), "resolved_job.json"), JSON.stringify({ schema: "changed-in-flight" }));
    gateInflight.release(true);
    await waitUntil(() => readMockupFromDisk(idInflight)?.render_mutation?.status === "failed", "inflight plan fail");
    assert.equal(readMockupFromDisk(idInflight)?.current_render_generation_id, undefined);
    assert.equal(fileBytes(loadMockup(idInflight)!, "white_a").equals(WHITE_A), true);
    const inflightReady = readdirSync(join(jobDir(idInflight), RENDER_GENERATION_DIR)).filter((name) => name.startsWith("g"));
    assert.equal(inflightReady.some((name) => name.startsWith("g1-")), false);

    const idSeal = tid(51);
    seedDoneJob(idSeal);
    const sourceSeal = virtualId(idSeal);
    const gateSeal = gatedExecutor();
    setJobsTestHooks(generationHooks({
      runRenderGeneration: gateSeal.run,
      generationFailpoints: {
        afterSealBeforePointer: () => {
          writeFileSync(join(jobDir(idSeal), "resolved_job.json"), JSON.stringify({ schema: "changed-after-seal" }));
        },
      },
    }));
    enqueueRenderGenerationMutation({
      jobId: idSeal,
      viewer,
      clientRequestId: "req-plan-after-seal-01",
      mode: "legacy_relight",
      sourceGenerationId: sourceSeal,
      expectedCurrentGenerationId: sourceSeal,
    });
    gateSeal.release(true);
    await waitUntil(() => readMockupFromDisk(idSeal)?.render_mutation?.status === "failed", "after-seal plan fail");
    const sealed = readMockupFromDisk(idSeal)!;
    assert.equal(sealed.current_render_generation_id, undefined);
    assert.equal(fileBytes(sealed, "white_a").equals(WHITE_A), true);
    const sealReady = readdirSync(join(jobDir(idSeal), RENDER_GENERATION_DIR)).filter((name) => name.startsWith("g"));
    assert.ok(sealReady.includes(G0_LEGACY_ORIGINAL_ID));
    assert.ok(sealReady.some((name) => name.startsWith("g1-")));
  });

  it("keeps the old current when source files change in flight or after seal", async () => {
    const idInflight = tid(52);
    const seededInflight = seedDoneJob(idInflight);
    const sourceInflight = virtualId(idInflight);
    const gateInflight = gatedExecutor();
    setJobsTestHooks(generationHooks({ runRenderGeneration: gateInflight.run }));
    enqueueRenderGenerationMutation({
      jobId: idInflight,
      viewer,
      clientRequestId: "req-source-inflight-01",
      mode: "legacy_relight",
      sourceGenerationId: sourceInflight,
      expectedCurrentGenerationId: sourceInflight,
    });
    await waitUntil(() => readMockupFromDisk(idInflight)?.render_mutation?.status === "running", "source inflight running");
    writeFileSync(seededInflight.whiteA, syntheticPng(99, 1, 1));
    gateInflight.release(true);
    await waitUntil(() => readMockupFromDisk(idInflight)?.render_mutation?.status === "failed", "source inflight fail");
    assert.equal(readMockupFromDisk(idInflight)?.current_render_generation_id, undefined);
    assert.equal(inflightReadyMissingG1(idInflight), true);

    const idSeal = tid(53);
    const seededSeal = seedDoneJob(idSeal);
    const sourceSeal = virtualId(idSeal);
    const gateSeal = gatedExecutor();
    setJobsTestHooks(generationHooks({
      runRenderGeneration: gateSeal.run,
      generationFailpoints: {
        afterSealBeforePointer: () => {
          writeFileSync(seededSeal.whiteA, syntheticPng(2, 99, 2));
        },
      },
    }));
    enqueueRenderGenerationMutation({
      jobId: idSeal,
      viewer,
      clientRequestId: "req-source-after-seal-01",
      mode: "legacy_relight",
      sourceGenerationId: sourceSeal,
      expectedCurrentGenerationId: sourceSeal,
    });
    gateSeal.release(true);
    await waitUntil(() => readMockupFromDisk(idSeal)?.render_mutation?.status === "failed", "source after-seal fail");
    assert.equal(readMockupFromDisk(idSeal)?.current_render_generation_id, undefined);
    const sealReady = readdirSync(join(jobDir(idSeal), RENDER_GENERATION_DIR)).filter((name) => name.startsWith("g"));
    assert.ok(sealReady.some((name) => name.startsWith("g1-")));
  });

  it("keeps the old current when mutation status changes after seal", async () => {
    for (const [offset, status] of [["queued", "queued"], ["failed", "failed"], ["succeeded", "succeeded"]] as const) {
      const id = tid(60 + ["queued", "failed", "succeeded"].indexOf(offset));
      seedDoneJob(id);
      const source = virtualId(id);
      const gate = gatedExecutor();
      setJobsTestHooks(generationHooks({
        runRenderGeneration: gate.run,
        generationFailpoints: {
          afterSealBeforePointer: () => {
            const disk = readMockupFromDisk(id)!;
            disk.render_mutation = { ...disk.render_mutation!, status };
            saveMockup(disk);
          },
        },
      }));
      enqueueRenderGenerationMutation({
        jobId: id,
        viewer,
        clientRequestId: `req-mut-status-${status}`,
        mode: "legacy_relight",
        sourceGenerationId: source,
        expectedCurrentGenerationId: source,
      });
      gate.release(true);
      await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "failed", `mutation ${status}`);
      const disk = readMockupFromDisk(id)!;
      assert.equal(disk.render_mutation?.status, "failed", status);
      assert.equal(disk.current_render_generation_id, undefined, status);
      assert.equal(fileBytes(disk, "white_a").equals(WHITE_A), true, status);
    }
  });

  it("fails a queued first generation when the virtual source changes before dequeue and does not import or execute", async () => {
    const id = tid(70);
    const seeded = seedDoneJob(id);
    const source = virtualId(id);
    let executions = 0;
    setJobsTestHooks(generationHooks({
      runRenderGeneration: async (input) => {
        executions += 1;
        return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
      },
    }));
    setJobsLiveForTest("blender", tid(901));
    const queued = enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-queue-virtual-stale-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    assert.equal(queued.mutation.status, "queued");
    const swapped = syntheticPng(99, 98, 97);
    writeFileSync(seeded.whiteA, swapped);
    assert.notEqual(virtualId(id), source);
    setJobsLiveForTest("blender", null);
    tryStart();
    await waitUntil(() => ["succeeded", "failed"].includes(readMockupFromDisk(id)?.render_mutation?.status || ""), "virtual stale terminal");
    const disk = readMockupFromDisk(id)!;
    assert.equal(disk.render_mutation?.status, "failed");
    assert.match(disk.render_mutation?.error || "", /源代|当前代/);
    assert.equal(executions, 0);
    assert.equal(disk.current_render_generation_id, undefined);
    assert.equal(fileBytes(disk, "white_a").equals(swapped), true);
    assert.equal(fileBytes(disk, "white_a").equals(NEW_A), false);
    const genDir = join(jobDir(id), RENDER_GENERATION_DIR);
    assert.equal(existsSync(genDir) && readdirSync(genDir).includes(G0_LEGACY_ORIGINAL_ID), false);
  });

  it("fails a queued hosted mutation when the current pointer changes before dequeue and does not execute", async () => {
    const id = tid(71);
    seedDoneJob(id);
    const source = virtualId(id);
    let executions = 0;
    setJobsTestHooks(generationHooks({
      runRenderGeneration: async (input) => {
        executions += 1;
        return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
      },
    }));
    enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-queue-hosted-first-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "succeeded", "hosted first");
    const afterFirst = readMockupFromDisk(id)!;
    const firstCurrent = afterFirst.current_render_generation_id;
    assert.ok(firstCurrent);
    const firstRuns = executions;
    setJobsLiveForTest("blender", tid(902));
    const queued = enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-queue-hosted-pointer-01",
      mode: "legacy_relight",
      sourceGenerationId: firstCurrent,
      expectedCurrentGenerationId: firstCurrent,
    });
    assert.equal(queued.mutation.status, "queued");
    const tampered = readMockupFromDisk(id)!;
    tampered.current_render_generation_id = G0_LEGACY_ORIGINAL_ID;
    saveMockup(tampered);
    setJobsLiveForTest("blender", null);
    tryStart();
    await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "failed", "hosted pointer stale");
    const disk = readMockupFromDisk(id)!;
    assert.equal(disk.render_mutation?.status, "failed");
    assert.match(disk.render_mutation?.error || "", /源代|当前代/);
    assert.equal(executions, firstRuns);
    assert.equal(disk.current_render_generation_id, G0_LEGACY_ORIGINAL_ID);
    assert.equal(fileBytes(disk, "white_a").equals(NEW_A), true);
    const ready = readdirSync(join(jobDir(id), RENDER_GENERATION_DIR)).filter((name) => name.startsWith("g"));
    assert.ok(ready.includes(G0_LEGACY_ORIGINAL_ID));
    assert.ok(ready.some((name) => name.startsWith("g1-")));
    assert.equal(ready.some((name) => name.startsWith("g2-")), false);
  });

  it("still commits a queued mutation with lighting after the shared slot waits when source and current stay put", async () => {
    const id = tid(72);
    seedDoneJob(id);
    const source = virtualId(id);
    let captured: RenderGenerationExecuteInput | undefined;
    let executions = 0;
    const gate = gatedExecutor();
    const originalRun = gate.run;
    setJobsTestHooks(generationHooks({
      runRenderGeneration: async (input) => {
        executions += 1;
        captured = input;
        return originalRun(input);
      },
    }));
    setJobsLiveForTest("blender", tid(903));
    const queued = enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-queue-success-lighting-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
      studioAdjustment: { product_light: 1.2, background_light: 0.8 },
    });
    assert.equal(queued.mutation.status, "queued");
    assert.equal(fileBytes(loadMockup(id)!, "white_a").equals(WHITE_A), true);
    setJobsLiveForTest("blender", null);
    tryStart();
    await waitUntil(() => loadMockup(id)?.render_mutation?.status === "running", "queued success claimed");
    gate.release(true);
    await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "succeeded", "queued success commit");
    assert.equal(executions, 1);
    assert.ok(captured);
    assert.equal(captured.studioAdjustment?.product_light, 1.2);
    assert.equal(captured.studioAdjustment?.background_light, 0.8);
    assert.equal(captured.plan.profile, "compat-legacy-v0");
    const done = readMockupFromDisk(id)!;
    assert.ok(done.current_render_generation_id);
    assert.equal(fileBytes(done, "white_a").equals(NEW_A), true);
  });

  it("rejects a historical source at enqueue and does not leave a fake queued mutation", async () => {
    const id = tid(73);
    seedDoneJob(id);
    const source = virtualId(id);
    let executions = 0;
    setJobsTestHooks(generationHooks({
      runRenderGeneration: async (input) => {
        executions += 1;
        return bindExecutorResult(input, writeExecutorOutputs(input.candidateDir));
      },
    }));
    enqueueRenderGenerationMutation({
      jobId: id,
      viewer,
      clientRequestId: "req-hist-first-01",
      mode: "legacy_relight",
      sourceGenerationId: source,
      expectedCurrentGenerationId: source,
    });
    await waitUntil(() => readMockupFromDisk(id)?.render_mutation?.status === "succeeded", "hist first");
    const afterFirst = readMockupFromDisk(id)!;
    const firstCurrent = afterFirst.current_render_generation_id;
    assert.ok(firstCurrent);
    assert.notEqual(firstCurrent, G0_LEGACY_ORIGINAL_ID);
    const firstRuns = executions;
    try {
      enqueueRenderGenerationMutation({
        jobId: id,
        viewer,
        clientRequestId: "req-hist-source-01",
        mode: "legacy_relight",
        sourceGenerationId: G0_LEGACY_ORIGINAL_ID,
        expectedCurrentGenerationId: firstCurrent,
      });
      assert.fail("expected historical source to be rejected");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "render_generation_invalid", String(err));
      assert.match((err as Error).message, /当前代作为源|历史源/);
    }
    const disk = readMockupFromDisk(id)!;
    assert.equal(disk.render_mutation?.id, afterFirst.render_mutation?.id);
    assert.equal(disk.render_mutation?.status, "succeeded");
    assert.equal(disk.current_render_generation_id, firstCurrent);
    assert.equal(executions, firstRuns);
    assert.equal(fileBytes(disk, "white_a").equals(NEW_A), true);
  });
});

function inflightReadyMissingG1(id: string): boolean {
  const dir = join(jobDir(id), RENDER_GENERATION_DIR);
  if (!existsSync(dir)) return true;
  return !readdirSync(dir).some((name) => name.startsWith("g1-"));
}
