import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-mockup-gen-");

const {
  collectOutputs,
  deleteMockup,
  fileOf,
  generationManagedReject,
  isGenerationManagedMockup,
  mockupRenderPlanBytes,
  publicMockup,
  publicMockupSummary,
  readMockupFromDisk,
  resetMockupCache,
  saveMockup,
} = await import("./mockup.js");
const { resetMockupAtomicWriteTestHooks, setMockupAtomicWriteTestHooks } = await import("./mockupAtomicWrite.js");

afterEach(() => {
  resetMockupAtomicWriteTestHooks();
  resetMockupCache();
});

describe("generation-managed mockup files", () => {
  for (const [status, pid] of [["queued", undefined], ["running", undefined], ["failed", 71001], ["succeeded", 71001], ["failed", 0]] as const) {
    it(`refuses deletion of ${status} mutation with PID=${pid} while work or its evidence is outstanding`, () => {
      const id = "aa05aa05aa05";
      const dir = join(process.env.WB_DATA_DIR || "", "mockups", id);
      mkdirSync(dir, { recursive: true });
      const source = join(dir, "box.glb");
      writeFileSync(source, "source-must-survive");
      saveMockup({ id, status: "done", created_at: "2026-09-05T00:00:00Z",
        files: [{ key: "glb", path: source, name: "box.glb" }], owner: "ou_gen",
        render_mutation: { id: "m0123456789abcdef", mode: "legacy_relight", status },
        render_generation_request: {
          client_request_id: "delete-active-test", payload_sha256: "a".repeat(64), mutation_id: "m0123456789abcdef",
          mode: "legacy_relight", source_generation_id: "legacy-source", expected_current_generation_id: "legacy-source",
          started_current_generation_id: null, created_at: "2026-09-05T00:00:00Z", actor_id: "ou_gen",
          worker_pid: pid,
        },
      });
      const before = readFileSync(join(dir, "job.json"));
      assert.throws(() => deleteMockup(id), (err: unknown) => (err as { status?: number }).status === 409);
      assert.deepEqual(readFileSync(join(dir, "job.json")), before);
      assert.equal(readFileSync(source, "utf8"), "source-must-survive");
    });
  }

  it("omits malformed public mutation summaries and sanitizes failed mutation errors", () => {
    const base = { id: "aa07aa07aa07", status: "done" as const, created_at: "2026-09-05T00:00:00Z", files: [] };
    for (const mutation of [null, {}, { id: "m1", mode: "invalid", status: "failed" },
      { id: "m1", mode: "upgrade", status: "invalid" }, { id: "", mode: "upgrade", status: "queued" }]) {
      assert.equal(publicMockupSummary({ ...base, render_mutation: mutation } as never).render_mutation, undefined);
    }
    const summary = publicMockupSummary({ ...base, render_mutation: {
      id: "m1", mode: "upgrade", status: "failed", error: "candidate /Users/private/output.png failed",
    } });
    assert.equal(summary.render_mutation?.status, "failed");
    assert.doesNotMatch(summary.render_mutation?.error || "", /\/Users\/private/);
  });

  for (const status of ["failed", "succeeded"] as const) {
    it(`allows deletion of a ${status} terminal mutation once no PID remains`, () => {
      const id = "aa06aa06aa06";
      const dir = join(process.env.WB_DATA_DIR || "", "mockups", id);
      mkdirSync(dir, { recursive: true });
      saveMockup({ id, status: "done", created_at: "2026-09-05T00:00:00Z", files: [], owner: "ou_gen",
        render_mutation: { id: "m0123456789abcdef", mode: "legacy_relight", status } });
      deleteMockup(id);
      assert.equal(existsSync(dir), false);
      assert.equal(readMockupFromDisk(id), undefined);
    });
  }

  it("does not leak private mutation paths through public summary or detail", () => {
    const id = "aa01aa01aa01";
    const dir = join(process.env.WB_DATA_DIR || "", "mockups", id);
    mkdirSync(dir, { recursive: true });
    const genPath = join(dir, ".render-generations", "g0-legacy-original", "outputs", "front_right_white.png");
    writeFileSync(join(dir, "deck.pptx"), "ppt");
    saveMockup({
      id,
      status: "done",
      created_at: "2026-09-05T00:00:00Z",
      files: [
        { key: "white_a", path: genPath, name: "front_right_white.png" },
        { key: "ppt", path: join(dir, "deck.pptx"), name: "deck.pptx" },
      ],
      owner: "ou_gen",
      job_kind: "mockup",
      job_status: "succeeded",
      current_render_generation_id: "g0-legacy-original",
      render_mutation: { id: "m0123456789abcdef", mode: "legacy_relight", status: "succeeded" },
      render_generation_request: {
        client_request_id: "req-public-01",
        payload_sha256: "a".repeat(64),
        mutation_id: "m0123456789abcdef",
        mode: "legacy_relight",
        source_generation_id: "g0-legacy-original",
        expected_current_generation_id: "g0-legacy-original",
        started_current_generation_id: null,
        created_at: "2026-09-05T00:00:00Z",
        actor_id: "ou_gen",
        worker_pid: 9,
      },
      render_generation_idempotency: [
        {
          client_request_id: "req-public-01",
          payload_sha256: "a".repeat(64),
          mutation: { id: "m0123456789abcdef", mode: "legacy_relight", status: "succeeded" },
        },
      ],
    });
    const job = readMockupFromDisk(id)!;
    const detail = publicMockup(job);
    const summary = publicMockupSummary(job);
    const detailBlob = JSON.stringify(detail);
    const summaryBlob = JSON.stringify(summary);
    assert.equal(detail.has_render_generations, true);
    assert.equal(detail.current_render_generation_id, "g0-legacy-original");
    assert.equal(detail.render_mutation?.id, "m0123456789abcdef");
    assert.equal("render_generation_request" in detail, false);
    assert.equal("render_generation_request" in summary, false);
    assert.equal("render_generation_idempotency" in detail, false);
    assert.equal("render_generation_idempotency" in summary, false);
    assert.doesNotMatch(detailBlob, /render_generation_request|render_generation_idempotency|worker_pid|payload_sha256|\.render-generations|candidate|\/Users\/|C:\\/);
    assert.doesNotMatch(summaryBlob, /render_generation_request|render_generation_idempotency|worker_pid|\.render-generations/);
    assert.equal(detail.files.every((file) => !("path" in file)), true);
    assert.equal(isGenerationManagedMockup(job), true);
    assert.equal(generationManagedReject("relight").message.includes("旧重渲"), true);
  });

  it("uses fail-closed atomic replace after a generation pointer exists", () => {
    const id = "aa02aa02aa02";
    const dir = join(process.env.WB_DATA_DIR || "", "mockups", id);
    mkdirSync(dir, { recursive: true });
    saveMockup({
      id,
      status: "done",
      created_at: "2026-09-05T00:00:00Z",
      files: [{ key: "glb", path: join(dir, "box.glb"), name: "box.glb" }],
      owner: "ou_gen",
      job_kind: "mockup",
      job_status: "succeeded",
      current_render_generation_id: "g0-legacy-original",
    });
    const before = readFileSync(join(dir, "job.json"), "utf8");
    setMockupAtomicWriteTestHooks({
      rename: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    });
    assert.throws(() =>
      saveMockup({
        id,
        status: "done",
        created_at: "2026-09-05T00:00:00Z",
        files: [{ key: "glb", path: join(dir, "box.glb"), name: "box.glb" }],
        owner: "ou_gen",
        job_kind: "mockup",
        job_status: "succeeded",
        current_render_generation_id: "g1-should-not-land",
      }),
    );
    assert.equal(readFileSync(join(dir, "job.json"), "utf8"), before);
    assert.equal(readMockupFromDisk(id)?.current_render_generation_id, "g0-legacy-original");
  });

  it("keeps collectOutputs from walking hidden generation dirs and fileOf still uses listed paths", () => {
    const id = "aa03aa03aa03";
    const dir = join(process.env.WB_DATA_DIR || "", "mockups", id);
    const hidden = join(dir, ".render-generations", "g1-legacy-relight-aaaaaaaa-bbbbbbbb", "outputs");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(dir, "root_front_right_white.png"), "old");
    writeFileSync(join(hidden, "front_right_white.png"), "new");
    writeFileSync(join(dir, "box.glb"), "glb");
    const collected = collectOutputs(dir);
    assert.equal(collected.some((file) => (file.path || "").includes(".render-generations")), false);
    const job = {
      id,
      status: "done" as const,
      created_at: "2026-09-05T00:00:00Z",
      files: [
        { key: "white_a", path: join(hidden, "front_right_white.png"), name: "front_right_white.png" },
        { key: "glb", path: join(dir, "box.glb"), name: "box.glb" },
      ],
    };
    assert.match(fileOf(job, "white_a")?.path || "", /\.render-generations/);
    assert.equal(readFileSync(fileOf(job, "white_a")!.path!, "utf8"), "new");
  });

  it("reads raw resolved_job bytes and does not treat JSON.parse as RF-02 verification", () => {
    const id = "aa04aa04aa04";
    const dir = join(process.env.WB_DATA_DIR || "", "mockups", id);
    mkdirSync(dir, { recursive: true });
    const resolved = join(dir, "resolved_job.json");
    writeFileSync(resolved, "not-json");
    saveMockup({
      id,
      status: "done",
      created_at: "2026-09-05T00:00:00Z",
      files: [{ key: "glb", path: join(dir, "box.glb"), name: "box.glb" }],
      owner: "ou_gen",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const raw = mockupRenderPlanBytes(readMockupFromDisk(id)!);
    assert.ok(raw);
    assert.equal(raw.path, resolved);
    assert.equal(raw.bytes.toString("utf8"), "not-json");
    assert.equal("sha256" in raw, false);
  });
});
