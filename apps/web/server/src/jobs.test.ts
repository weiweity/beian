import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-jobs-"));

const { loadTask, replaceFile, saveTask } = await import("./tasks.js");
const {
  decorateQueueAhead,
  enqueue,
  publicTask,
  queueSnapshot,
  reclaimOnBoot,
  resetJobsTestHooks,
  setJobsTestHooks,
  tryStart,
} = await import("./jobs.js");

function tid(n: number): string {
  return n.toString(16).padStart(12, "0");
}

function queuedCompare(id: string, createdAt: string) {
  saveTask({
    id,
    title: "精华",
    product_name: "某某精华",
    type: "excel_pdf",
    status: "comparing",
    created_at: createdAt,
    owner: "籽烨",
    job_kind: "compare",
    job_status: "queued",
  });
}

afterEach(() => {
  resetJobsTestHooks();
});

describe("jobs dispatcher", () => {
  it("second compare stays queued while the OCR slot is full", async () => {
    const resolvers: Array<(v: { code: number; stdout: string; stderr: string; timedOut: boolean }) => void> = [];
    setJobsTestHooks({
      runCompare: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    });
    queuedCompare(tid(10), "2026-08-20T10:00:00.000Z");
    queuedCompare(tid(11), "2026-08-20T10:00:01.000Z");
    enqueue({ kind: "compare", id: tid(10) });
    assert.equal(loadTask(tid(10)).job_status, "running");
    assert.equal(loadTask(tid(11)).job_status, "queued");
    assert.equal(queueSnapshot().ocr.running, 1);
    assert.equal(queueSnapshot().ocr.queued, 1);
    const rows = decorateQueueAhead([
      { id: tid(11), created_at: "2026-08-20T10:00:01.000Z", job_kind: "compare", job_status: "queued" },
    ]);
    assert.equal(rows[0]?.queue_ahead, 0);
    resolvers[0]?.({
      code: 0,
      stdout: JSON.stringify({ status: "pending_review", hits: [{ id: "h1" }], created_at: "2099-01-01T00:00:00Z" }) + "\n",
      stderr: "",
      timedOut: false,
    });
    for (let i = 0; i < 50 && loadTask(tid(11)).job_status !== "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(loadTask(tid(10)).status, "pending_review");
    assert.equal(loadTask(tid(10)).created_at, "2026-08-20T10:00:00.000Z");
    assert.equal(loadTask(tid(11)).job_status, "running");
  });

  it("publicTask strips job_pid", () => {
    saveTask({
      id: tid(12),
      title: "x",
      product_name: "x",
      type: "excel_pdf",
      status: "comparing",
      owner: "籽烨",
      job_kind: "compare",
      job_status: "running",
      job_pid: 99999,
      notify_job_id: "secret",
    });
    const pub = publicTask(loadTask(tid(12)), { name: "籽烨", admin: false });
    assert.equal("job_pid" in pub, false);
    assert.equal("notify_job_id" in pub, false);
    assert.equal(pub.job_status, "running");
  });

  it("foreign owner cannot read a task", () => {
    saveTask({
      id: tid(13),
      title: "x",
      type: "excel_pdf",
      status: "pending_review",
      owner: "籽烨",
    });
    assert.throws(() => publicTask(loadTask(tid(13)), { name: "别人", admin: false }), (err: Error & { status?: number }) => {
      assert.equal(err.status, 403);
      return true;
    });
  });

  it("missing last-line JSON fails compare as 对照中断", async () => {
    setJobsTestHooks({
      runCompare: async () => ({ code: 0, stdout: "not-json\n", stderr: "", timedOut: false }),
    });
    queuedCompare(tid(14), "2026-08-20T11:00:00.000Z");
    enqueue({ kind: "compare", id: tid(14) });
    await new Promise((r) => setTimeout(r, 30));
    const t = loadTask(tid(14));
    assert.equal(t.status, "compare_failed");
    assert.equal(t.job_error, "对照中断");
  });

  it("rework failure returns to status_before_job so she can still sign", async () => {
    setJobsTestHooks({
      runRework: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    });
    saveTask({
      id: tid(15),
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      status_before_job: "pending_review",
      owner: "籽烨",
      hits: [{ id: "h1", status: "疑点", decision: "confirm" }],
      job_kind: "rework",
      job_status: "queued",
      created_at: "2026-08-20T12:00:00.000Z",
    });
    enqueue({ kind: "rework", id: tid(15) });
    await new Promise((r) => setTimeout(r, 30));
    const t = loadTask(tid(15));
    assert.equal(t.status, "pending_review");
    assert.equal(t.job_status, "failed");
    assert.ok(t.hits?.length);
  });

  it("reclaim treats running without pid as an orphan and requeues once", () => {
    saveTask({
      id: tid(16),
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      job_kind: "compare",
      job_status: "running",
      job_started_at: new Date().toISOString(),
      created_at: "2026-08-20T13:00:00.000Z",
    });
    setJobsTestHooks({
      runCompare: async () =>
        new Promise(() => {
          /* never */
        }),
    });
    reclaimOnBoot();
    const t = loadTask(tid(16));
    assert.ok(t.job_status === "queued" || t.job_status === "running");
    assert.equal(t.reclaim_count, 1);
  });

  it("boot retries notify when the key is set but not sent", async () => {
    let calls = 0;
    setJobsTestHooks({
      notify: async (opts) => {
        if (opts.tid === tid(17)) calls += 1;
        return { ok: true };
      },
    });
    saveTask({
      id: tid(17),
      title: "x",
      product_name: "某某精华",
      type: "excel_pdf",
      status: "pending_review",
      job_kind: "compare",
      job_status: "succeeded",
      notify_job_id: `${tid(17)}:compare:t`,
      notify_sent: false,
    });
    reclaimOnBoot();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 1);
    assert.equal(loadTask(tid(17)).notify_sent, true);
  });

  it("mockup exit 0 without files is failed", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    setJobsTestHooks({
      runPack: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    });
    saveMockup({
      id: tid(18),
      status: "queued",
      created_at: "2026-08-20T14:00:00.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
    });
    enqueue({ kind: "mockup", id: tid(18) });
    for (let i = 0; i < 50; i++) {
      const j = loadMockup(tid(18));
      if (j?.job_status === "failed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const job = loadMockup(tid(18));
    assert.equal(job?.status, "failed");
    assert.equal(job?.job_error, "打样没有输出文件");
  });

  it("nonzero worker exit does not succeed even if stdout has JSON", async () => {
    setJobsTestHooks({
      runCompare: async () => ({
        code: 2,
        stdout: JSON.stringify({ status: "pending_review", hits: [{ id: "h1" }] }) + "\n",
        stderr: "",
        timedOut: false,
      }),
    });
    queuedCompare(tid(19), "2026-08-20T15:00:00.000Z");
    enqueue({ kind: "compare", id: tid(19) });
    await new Promise((r) => setTimeout(r, 30));
    const t = loadTask(tid(19));
    assert.equal(t.status, "compare_failed");
    assert.equal(t.job_status, "failed");
  });

  it("maps pack_surface pouch to CLI pouch", async () => {
    let surface = "";
    setJobsTestHooks({
      runCompare: async (opts) => {
        surface = opts.surface;
        return {
          code: 0,
          stdout: JSON.stringify({ status: "pending_review", hits: [] }) + "\n",
          stderr: "",
          timedOut: false,
        };
      },
    });
    saveTask({
      id: tid(20),
      title: "膜袋",
      product_name: "膜袋",
      type: "excel_pdf",
      status: "comparing",
      created_at: "2026-08-20T16:00:00.000Z",
      pack_surface: "pouch",
      job_kind: "compare",
      job_status: "queued",
    });
    enqueue({ kind: "compare", id: tid(20) });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(surface, "pouch");
    assert.equal(loadTask(tid(20)).status, "pending_review");
  });

  it("parses only the last stdout line as result JSON", async () => {
    setJobsTestHooks({
      runCompare: async () => ({
        code: 0,
        stdout:
          JSON.stringify({ status: "pending_review", hits: [{ id: "old" }] }) +
          "\n" +
          JSON.stringify({ status: "pending_review", hits: [{ id: "new" }] }) +
          "\n",
        stderr: "",
        timedOut: false,
      }),
    });
    queuedCompare(tid(22), "2026-08-20T16:30:00.000Z");
    enqueue({ kind: "compare", id: tid(22) });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(loadTask(tid(22)).hits?.[0]?.id, "new");
  });

  it("notify does not un-sign a task completed while Feishu was in flight", async () => {
    let release: ((v: { ok: boolean }) => void) | undefined;
    const gate = new Promise<{ ok: boolean }>((r) => {
      release = r;
    });
    setJobsTestHooks({
      runCompare: async () => ({
        code: 0,
        stdout: JSON.stringify({ status: "pending_review", hits: [] }) + "\n",
        stderr: "",
        timedOut: false,
      }),
      notify: () => gate,
    });
    queuedCompare(tid(21), "2026-08-20T17:00:00.000Z");
    enqueue({ kind: "compare", id: tid(21) });
    for (let i = 0; i < 50 && loadTask(tid(21)).job_status !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const t = loadTask(tid(21));
    assert.equal(t.job_status, "succeeded");
    t.status = "completed";
    t.complete_kind = "signed";
    t.conclusion = "人看过了";
    saveTask(t);
    release?.({ ok: true });
    await new Promise((r) => setTimeout(r, 40));
    const fresh = loadTask(tid(21));
    assert.equal(fresh.status, "completed");
    assert.equal(fresh.complete_kind, "signed");
    assert.equal(fresh.notify_sent, true);
  });

  it("third compare stays queued behind two earlier OCR jobs", async () => {
    setJobsTestHooks({
      runCompare: () =>
        new Promise(() => {
          /* occupy the OCR slot */
        }),
    });
    queuedCompare(tid(30), "2026-08-20T18:00:00.000Z");
    queuedCompare(tid(31), "2026-08-20T18:00:01.000Z");
    queuedCompare(tid(32), "2026-08-20T18:00:02.000Z");
    enqueue({ kind: "compare", id: tid(30) });
    assert.equal(loadTask(tid(30)).job_status, "running");
    assert.equal(loadTask(tid(31)).job_status, "queued");
    assert.equal(loadTask(tid(32)).job_status, "queued");
    const rows = decorateQueueAhead([
      { id: tid(31), created_at: "2026-08-20T18:00:01.000Z", job_kind: "compare", job_status: "queued" },
      { id: tid(32), created_at: "2026-08-20T18:00:02.000Z", job_kind: "compare", job_status: "queued" },
    ]);
    assert.equal(rows[0]?.queue_ahead, 0);
    assert.equal(rows[1]?.queue_ahead, 1);
    assert.equal(queueSnapshot().ocr.queued, 2);
  });

  it("OCR timedOut marks compare_failed as 超时", async () => {
    setJobsTestHooks({
      runCompare: async () => ({ code: 1, stdout: "", stderr: "", timedOut: true }),
    });
    queuedCompare(tid(33), "2026-08-20T18:10:00.000Z");
    enqueue({ kind: "compare", id: tid(33) });
    await new Promise((r) => setTimeout(r, 30));
    const t = loadTask(tid(33));
    assert.equal(t.status, "compare_failed");
    assert.equal(t.job_status, "failed");
    assert.equal(t.job_error, "超时");
  });

  it("stderr STAGE ocr becomes job_stage_label 认字", async () => {
    setJobsTestHooks({
      runCompare: async (opts) => {
        opts.onStderrLine?.("noise");
        opts.onStderrLine?.("STAGE ocr");
        return {
          code: 0,
          stdout: JSON.stringify({ status: "pending_review", hits: [] }) + "\n",
          stderr: "",
          timedOut: false,
        };
      },
    });
    queuedCompare(tid(34), "2026-08-20T18:20:00.000Z");
    enqueue({ kind: "compare", id: tid(34) });
    for (let i = 0; i < 50 && loadTask(tid(34)).job_stage !== "ocr"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(loadTask(tid(34)).job_stage, "ocr");
    assert.equal(loadTask(tid(34)).job_stage_label, "认字");
  });

  it("cli error containing save_task is not shown to the reviewer", async () => {
    setJobsTestHooks({
      runCompare: async () => ({
        code: 1,
        stdout: "",
        stderr: JSON.stringify({ error: "save_task exploded" }) + "\n",
        timedOut: false,
      }),
    });
    queuedCompare(tid(35), "2026-08-20T18:30:00.000Z");
    enqueue({ kind: "compare", id: tid(35) });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(loadTask(tid(35)).job_error, "对照中断");
  });

  it("reclaim a second time fails the compare instead of looping", () => {
    saveTask({
      id: tid(36),
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      job_kind: "compare",
      job_status: "running",
      reclaim_count: 1,
      job_started_at: new Date().toISOString(),
      created_at: "2026-08-20T18:40:00.000Z",
    });
    reclaimOnBoot();
    const t = loadTask(tid(36));
    assert.equal(t.job_status, "failed");
    assert.equal(t.status, "compare_failed");
    assert.equal(t.job_error, "对照中断");
  });

  it("reclaim does not rerun a pending_review task with a dead pid", () => {
    let killedThis = 0;
    setJobsTestHooks({
      killTree: (pid: number) => {
        if (pid === 4242) killedThis += 1;
      },
      runCompare: async () =>
        new Promise(() => {
          /* must not start */
        }),
    });
    saveTask({
      id: tid(37),
      title: "x",
      type: "excel_pdf",
      status: "pending_review",
      job_kind: "compare",
      job_status: "running",
      job_pid: 4242,
      created_at: "2026-08-20T18:50:00.000Z",
    });
    reclaimOnBoot();
    const t = loadTask(tid(37));
    assert.equal(t.status, "pending_review");
    assert.equal(t.job_status, "succeeded");
    assert.equal(killedThis, 0);
  });

  it("does not resend Feishu when notify_sent is already true", async () => {
    let calls = 0;
    setJobsTestHooks({
      notify: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    saveTask({
      id: tid(38),
      title: "x",
      product_name: "某某精华",
      type: "excel_pdf",
      status: "pending_review",
      job_kind: "compare",
      job_status: "succeeded",
      notify_job_id: `${tid(38)}:compare:t`,
      notify_sent: true,
    });
    reclaimOnBoot();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 0);
    assert.equal(loadTask(tid(38)).notify_sent, true);
  });

  it("second mockup stays queued while the Blender slot is full", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    setJobsTestHooks({
      runPack: () =>
        new Promise(() => {
          /* occupy blender */
        }),
    });
    saveMockup({
      id: tid(39),
      status: "queued",
      created_at: "2026-08-20T19:00:00.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
    });
    saveMockup({
      id: tid(40),
      status: "queued",
      created_at: "2026-08-20T19:00:01.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
    });
    enqueue({ kind: "mockup", id: tid(39) });
    assert.equal(loadMockup(tid(39))?.job_status, "running");
    assert.equal(loadMockup(tid(40))?.job_status, "queued");
    assert.equal(queueSnapshot().blender.running, 1);
    assert.equal(queueSnapshot().blender.queued, 1);
  });

  it("mockup success collects glb output files", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { saveMockup, loadMockup } = await import("./mockup.js");
    const outDir = join(process.env.WB_DATA_DIR || "", "mockups", tid(41));
    mkdirSync(outDir, { recursive: true });
    setJobsTestHooks({
      runPack: async () => {
        writeFileSync(join(outDir, "box.glb"), "glb");
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    saveMockup({
      id: tid(41),
      status: "queued",
      created_at: "2026-08-20T19:10:00.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
    });
    enqueue({ kind: "mockup", id: tid(41) });
    for (let i = 0; i < 50 && loadMockup(tid(41))?.status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const job = loadMockup(tid(41));
    assert.equal(job?.status, "done");
    assert.equal(job?.job_status, "succeeded");
    assert.equal(job?.files?.some((f) => f.key === "glb"), true);
  });
});

describe("replaceFile", () => {
  it("overwrites an existing dest", () => {
    const p = join(process.env.WB_DATA_DIR || "", "replace-target.json");
    replaceFile(p, "{\"a\":1}");
    replaceFile(p, "{\"a\":2}");
    assert.equal(JSON.parse(readFileSync(p, "utf8")).a, 2);
  });
});
