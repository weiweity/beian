import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-jobs-");

const { deleteTask, loadTask, replaceFile, saveTask } = await import("./tasks.js");
const {
  decorateQueueAhead,
  enqueue,
  launchNotification,
  notificationSnapshot,
  publicTask,
  queueSnapshot,
  reclaimOnBoot,
  resetJobsTestHooks,
  retryMockup,
  setJobsTestHooks,
} = await import("./jobs.js");

function wipeJobDisk() {
  const root = process.env.WB_DATA_DIR || "";
  if (!root.includes("beian-jobs-")) return;
  for (const sub of ["tasks", "mockups", "uploads"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
}

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
  wipeJobDisk();
});

describe("jobs dispatcher", () => {
  it("fails release snapshots closed on corrupt records while retaining the live slot", () => {
    setJobsTestHooks({
      runCompare: () => new Promise(() => undefined),
    });
    const id = tid(9);
    queuedCompare(id, "2026-08-20T09:59:00.000Z");
    enqueue({ kind: "compare", id });
    writeFileSync(join(process.env.WB_DATA_DIR || "", "tasks", `${id}.json`), "{half-written", "utf8");
    const snapshot = queueSnapshot();
    assert.equal(snapshot.ocr.running, 1);
    assert.equal(snapshot.unknown, 1);
  });

  it("fails release snapshots closed on unknown enums and contradictory active state", () => {
    const tasks = join(process.env.WB_DATA_DIR || "", "tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, `${tid(61)}.json`), JSON.stringify({
      id: tid(61),
      title: "非法枚举",
      type: "excel_pdf",
      status: "comparing",
      job_kind: "compare",
      job_status: "runnng",
    }));
    writeFileSync(join(tasks, `${tid(62)}.json`), JSON.stringify({
      id: tid(62),
      title: "矛盾状态",
      type: "excel_pdf",
      status: "pending_review",
      job_kind: "compare",
      job_status: "running",
      job_pid: 4242,
    }));
    const snapshot = queueSnapshot();
    assert.equal(snapshot.ocr.running, 0);
    assert.equal(snapshot.unknown, 2);
  });

  it("counts every detached notification until its operation settles", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    launchNotification("signed task test", () => gate);
    assert.deepEqual(notificationSnapshot(), { active: 1 });
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(notificationSnapshot(), { active: 0 });
  });

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
    const pub = publicTask(loadTask(tid(12)), { id: "ou_ziye", name: "籽烨", admin: false });
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
    assert.throws(() => publicTask(loadTask(tid(13)), { id: "ou_other", name: "别人", admin: false }), (err: Error & { status?: number }) => {
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

  it("reclaim never kills or reruns a reused pid", () => {
    let killed = 0;
    let reran = 0;
    const id = tid(83);
    setJobsTestHooks({
      inspectWorker: (pid, expected) => {
        assert.equal(pid, 4242);
        assert.deepEqual(expected, { kind: "compare", id });
        return "other";
      },
      killTree: () => {
        killed += 1;
      },
      runCompare: () => {
        reran += 1;
        return new Promise(() => {
          /* a reused pid must never enqueue this replacement */
        });
      },
    });
    saveTask({
      id,
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      job_kind: "compare",
      job_status: "running",
      job_pid: 4242,
      job_started_at: new Date().toISOString(),
      created_at: "2026-08-24T10:01:00.000Z",
    });

    reclaimOnBoot();

    const task = loadTask(id);
    assert.equal(killed, 0);
    assert.equal(reran, 0);
    assert.equal(task.job_status, "failed");
    assert.equal(task.status, "compare_failed");
    assert.equal(task.job_error, "对照中断");
  });

  it("reclaim kills and retries only a confirmed worker from this task", () => {
    let inspected = 0;
    let killed = 0;
    let reran = 0;
    const id = tid(84);
    setJobsTestHooks({
      inspectWorker: (pid, expected) => {
        inspected += 1;
        assert.equal(pid, 4343);
        assert.deepEqual(expected, { kind: "rework", id });
        return inspected === 1 ? "owned" : "missing";
      },
      killTree: (pid, force) => {
        assert.equal(pid, 4343);
        assert.equal(force, true);
        killed += 1;
      },
      runRework: () => {
        reran += 1;
        return new Promise(() => {
          /* keep the recovered OCR slot occupied */
        });
      },
    });
    saveTask({
      id,
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      status_before_job: "pending_review",
      job_kind: "rework",
      job_status: "running",
      job_pid: 4343,
      job_started_at: new Date().toISOString(),
      created_at: "2026-08-24T10:02:00.000Z",
    });

    reclaimOnBoot();

    const task = loadTask(id);
    assert.equal(inspected, 2);
    assert.equal(killed, 1);
    assert.equal(reran, 1);
    assert.equal(task.reclaim_count, 1);
    assert.equal(task.job_status, "running");
  });

  it("reclaim fails closed when process ownership cannot be inspected", () => {
    let killed = 0;
    let reran = 0;
    const id = tid(85);
    setJobsTestHooks({
      inspectWorker: () => "unknown",
      killTree: () => {
        killed += 1;
      },
      runCompare: () => {
        reran += 1;
        return new Promise(() => {
          /* inspection failure must not enqueue a duplicate */
        });
      },
    });
    saveTask({
      id,
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      job_kind: "compare",
      job_status: "running",
      job_pid: 4444,
      job_started_at: new Date().toISOString(),
      created_at: "2026-08-24T10:03:00.000Z",
    });

    reclaimOnBoot();

    assert.equal(killed, 0);
    assert.equal(reran, 0);
    assert.equal(loadTask(id).job_status, "failed");
  });

  it("reclaim fails closed when killing a confirmed worker throws", () => {
    let inspected = 0;
    let killed = 0;
    let reran = 0;
    const id = tid(86);
    setJobsTestHooks({
      inspectWorker: (pid, expected) => {
        inspected += 1;
        assert.equal(pid, 4545);
        assert.deepEqual(expected, { kind: "compare", id });
        return "owned";
      },
      killTree: () => {
        killed += 1;
        throw new Error("synthetic kill failure");
      },
      runCompare: () => {
        reran += 1;
        return new Promise(() => {
          /* a failed kill must never enqueue a duplicate */
        });
      },
    });
    saveTask({
      id,
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      job_kind: "compare",
      job_status: "running",
      job_pid: 4545,
      job_started_at: new Date().toISOString(),
      created_at: "2026-08-24T10:04:00.000Z",
    });

    reclaimOnBoot();

    assert.equal(inspected, 1);
    assert.equal(killed, 1);
    assert.equal(reran, 0);
    assert.equal(loadTask(id).job_status, "failed");
    assert.equal(loadTask(id).job_error, "对照中断");
  });

  it("reclaim fails closed when a confirmed worker is still owned after kill", () => {
    let inspected = 0;
    let killed = 0;
    let reran = 0;
    const id = tid(87);
    setJobsTestHooks({
      inspectWorker: (pid, expected) => {
        inspected += 1;
        assert.equal(pid, 4646);
        assert.deepEqual(expected, { kind: "rework", id });
        return "owned";
      },
      killTree: () => {
        killed += 1;
      },
      runRework: () => {
        reran += 1;
        return new Promise(() => {
          /* a process still alive after kill must never enqueue a duplicate */
        });
      },
    });
    saveTask({
      id,
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      status_before_job: "pending_review",
      job_kind: "rework",
      job_status: "running",
      job_pid: 4646,
      job_started_at: new Date().toISOString(),
      created_at: "2026-08-24T10:05:00.000Z",
    });

    reclaimOnBoot();

    assert.equal(inspected, 2);
    assert.equal(killed, 1);
    assert.equal(reran, 0);
    const task = loadTask(id);
    assert.equal(task.job_status, "failed");
    assert.equal(task.status, "pending_review");
    assert.equal(task.job_error, "对照中断");
  });

  it("reclaim verifies and kills a mockup pid with the mockup identity", async () => {
    const { loadMockup, saveMockup } = await import("./mockup.js");
    let inspected = 0;
    let killed = 0;
    const id = tid(88);
    setJobsTestHooks({
      inspectWorker: (pid, expected) => {
        inspected += 1;
        assert.equal(pid, 4747);
        assert.deepEqual(expected, { kind: "mockup", id });
        return inspected === 1 ? "owned" : "missing";
      },
      killTree: (pid, force) => {
        assert.equal(pid, 4747);
        assert.equal(force, true);
        killed += 1;
      },
    });
    saveMockup({
      id,
      status: "running",
      created_at: "2026-08-24T10:06:00.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "running",
      job_pid: 4747,
      reclaim_count: 1,
      job_started_at: new Date().toISOString(),
    });

    reclaimOnBoot();

    assert.equal(inspected, 2);
    assert.equal(killed, 1);
    const job = loadMockup(id);
    assert.equal(job?.job_status, "failed");
    assert.equal(job?.job_error, "打样中断");
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
    assert.deepEqual(notificationSnapshot(), { active: 1 });
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
    assert.deepEqual(notificationSnapshot(), { active: 0 });
  });

  it("does not recreate a task deleted while its notification is in flight", async () => {
    let release: ((value: { ok: boolean }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const gate = new Promise<{ ok: boolean }>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      setJobsTestHooks({
        runCompare: async () => ({
          code: 0,
          stdout: JSON.stringify({ status: "pending_review", hits: [] }) + "\n",
          stderr: "",
          timedOut: false,
        }),
        notify: () => {
          markStarted?.();
          return gate;
        },
      });
      const id = tid(58);
      queuedCompare(id, "2026-08-20T17:01:00.000Z");
      enqueue({ kind: "compare", id });
      await started;
      assert.equal(loadTask(id).job_status, "succeeded");
      deleteTask(id);
      release?.({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.throws(() => loadTask(id), (err: Error & { status?: number }) => err.status === 404);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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

  it("quarantines a pending_review task that contradicts its running job state", () => {
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
    assert.equal(t.job_status, "running");
    assert.equal(killedThis, 0);
    assert.equal(queueSnapshot().unknown, 1);
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

  it("V2 structure review is recoverable and never enters Blender", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    const root = join(process.env.WB_DATA_DIR || "", "mockups", tid(84));
    mkdirSync(root, { recursive: true });
    const resolutionPath = join(root, "structure_resolution.json");
    const artworkPath = join(root, "artwork.pdf");
    const sidecarPath = join(root, "structure.json");
    writeFileSync(resolutionPath, "{}");
    writeFileSync(artworkPath, "%PDF");
    writeFileSync(sidecarPath, "{}");
    let blenderCalls = 0;
    let notifyCalls = 0;
    setJobsTestHooks({
      runStructure: async () => ({
        code: 3,
        stdout: "",
        stderr:
          JSON.stringify({
            ok: false,
            kind: "structure_resolution",
            structure_status: "review_required",
            code: "structure_face_mapping_incomplete",
            message: "请选择完整盒型的正面和朝向。",
            resolution_path: resolutionPath,
            details: {
              artwork_pdf: artworkPath,
              structure_sidecar: sidecarPath,
              source_sha256: "a".repeat(64),
            },
          }) + "\n",
        timedOut: false,
      }),
      runPack: async () => {
        blenderCalls += 1;
        return { code: 1, stdout: "", stderr: "should not run", timedOut: false };
      },
      notify: async () => {
        notifyCalls += 1;
        return { ok: true };
      },
    });
    saveMockup({
      id: tid(84),
      status: "queued",
      created_at: "2026-08-27T00:00:00.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
      structure_engine: "v2",
      structure_status: "analyzing",
    });
    enqueue({ kind: "mockup", id: tid(84) });
    for (let index = 0; index < 50 && loadMockup(tid(84))?.job_status !== "waiting_input"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const job = loadMockup(tid(84));
    assert.equal(job?.status, "review_required");
    assert.equal(job?.job_status, "waiting_input");
    assert.equal(job?.structure_status, "review_required");
    assert.equal(job?.structure_code, "structure_face_mapping_incomplete");
    assert.equal(job?.structure_message, "请选择完整盒型的正面和朝向。");
    assert.equal(job?.job_finished_at, undefined);
    assert.equal(blenderCalls, 0);
    assert.equal(notifyCalls, 0);
    assert.equal(queueSnapshot().blender.running, 0);
  });

  it("V2 structure ready hands one prepared manifest to Blender", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    const root = join(process.env.WB_DATA_DIR || "", "mockups", tid(85));
    mkdirSync(root, { recursive: true });
    const preparedManifest = join(root, "prepared_manifest.json");
    writeFileSync(preparedManifest, "{}");
    let receivedManifest = "";
    setJobsTestHooks({
      runStructure: async () => ({
        code: 0,
        stdout: JSON.stringify({ success: true, prepared_manifest: preparedManifest }) + "\n",
        stderr: "STAGE structure\n",
        timedOut: false,
      }),
      runPack: (manifest) => {
        receivedManifest = manifest;
        return new Promise(() => {
          /* prove the Blender slot was claimed */
        });
      },
    });
    saveMockup({
      id: tid(85),
      status: "queued",
      created_at: "2026-08-27T00:00:01.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
      structure_engine: "v2",
      structure_status: "analyzing",
    });
    enqueue({ kind: "mockup", id: tid(85) });
    for (let index = 0; index < 50 && loadMockup(tid(85))?.job_stage !== "render_pdf"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const job = loadMockup(tid(85));
    assert.equal(job?.structure_status, "ready");
    assert.equal(job?.job_status, "running");
    assert.equal(job?.job_stage, "render_pdf");
    assert.equal(job?.manifest_path, preparedManifest);
    assert.equal(receivedManifest, preparedManifest);
  });

  it("V2 structure failure stores the actionable public error instead of a truncated log path", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    const originalConsoleError = console.error;
    const diagnosticLogs: string[] = [];
    console.error = (...values: unknown[]) => diagnosticLogs.push(values.map(String).join(" "));
    setJobsTestHooks({
      runStructure: async () => ({
        code: 2,
        stdout: "",
        stderr: JSON.stringify({
          ok: false,
          code: "illustrator_unavailable",
          error: "Illustrator 没有启动成功，请在杭州电脑打开后重试",
          cause: String.raw`fetch https://api.example.test/private with Bearer bearer-secret token=token-secret at /Users/operator/private/report.json and C:\supply\data\mockups\secret\illustrator.log`,
          fix: "cookie=session-secret; api_key=key-secret; secret: plain-secret",
        }) + "\n",
        timedOut: false,
      }),
    });
    saveMockup({
      id: tid(87),
      status: "queued",
      created_at: "2026-08-27T00:00:03.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
      structure_engine: "v2",
      structure_status: "analyzing",
    });

    try {
      enqueue({ kind: "mockup", id: tid(87) });
      for (let index = 0; index < 50 && loadMockup(tid(87))?.job_status !== "failed"; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(loadMockup(tid(87))?.job_error, "Illustrator 没有启动成功，请在杭州电脑打开后重试");
      assert.doesNotMatch(loadMockup(tid(87))?.job_error || "", /日志=|private runtime path/);
      const log = diagnosticLogs.join("\n");
      assert.match(log, /problem=illustrator_unavailable/);
      assert.match(log, /\[url\]/);
      assert.match(log, /Bearer \*\*\*/);
      assert.match(log, /token=\*\*\*/);
      assert.match(log, /\[path\]/);
      assert.match(log, /cookie=\*\*\*/);
      assert.match(log, /api_key=\*\*\*/);
      assert.match(log, /secret: \*\*\*/);
      assert.doesNotMatch(log, /api\.example|bearer-secret|token-secret|session-secret|key-secret|plain-secret|C:\\supply|operator\/private|secret\\illustrator/);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("V2 refuses a prepared manifest outside its own job directory", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    let blenderCalls = 0;
    setJobsTestHooks({
      runStructure: async () => ({
        code: 0,
        stdout: JSON.stringify({ success: true, prepared_manifest: "/tmp/outside-job.json" }) + "\n",
        stderr: "STAGE structure\n",
        timedOut: false,
      }),
      runPack: async () => {
        blenderCalls += 1;
        return { code: 0, stdout: "{}", stderr: "", timedOut: false };
      },
    });
    saveMockup({
      id: tid(86),
      status: "queued",
      created_at: "2026-08-27T00:00:02.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
      structure_engine: "v2",
      structure_status: "analyzing",
    });
    enqueue({ kind: "mockup", id: tid(86) });
    for (let index = 0; index < 50 && loadMockup(tid(86))?.job_status !== "failed"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(loadMockup(tid(86))?.job_error, "结构识别没有返回可继续的作业清单");
    assert.equal(blenderCalls, 0);
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
    assert.equal(loadMockup(tid(39))?.job_stage, "render_pdf");
    assert.equal(loadMockup(tid(39))?.job_stage_label, "出图");
    assert.equal(loadMockup(tid(40))?.job_status, "queued");
    assert.equal(queueSnapshot().blender.running, 1);
    assert.equal(queueSnapshot().blender.queued, 1);
  });

  it("stderr STAGE export becomes mockup job_stage_label 导出", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    setJobsTestHooks({
      runPack: async (_manifest, opts) => {
        opts?.onStderrLine?.("STAGE render_pdf");
        opts?.onStderrLine?.("STAGE export");
        return { code: 1, stdout: "", stderr: "打样中断", timedOut: false };
      },
    });
    saveMockup({
      id: tid(82),
      status: "queued",
      created_at: "2026-08-24T10:00:00.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
    });
    enqueue({ kind: "mockup", id: tid(82) });
    for (let i = 0; i < 50 && loadMockup(tid(82))?.job_stage !== "export"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const job = loadMockup(tid(82));
    assert.equal(job?.job_stage, "export");
    assert.equal(job?.job_stage_label, "导出");
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

  it("reclaims valid mockup orphans but quarantines a done/running contradiction", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    setJobsTestHooks({
      runPack: () =>
        new Promise(() => {
          /* occupy */
        }),
    });
    saveMockup({
      id: tid(50),
      status: "running",
      created_at: "2026-08-20T20:00:00.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "running",
      job_started_at: new Date().toISOString(),
    });
    saveMockup({
      id: tid(51),
      status: "running",
      created_at: "2026-08-20T20:00:01.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "running",
      reclaim_count: 1,
      job_started_at: new Date().toISOString(),
    });
    saveMockup({
      id: tid(52),
      status: "done",
      created_at: "2026-08-20T20:00:02.000Z",
      files: [{ key: "glb", name: "box.glb" }],
      job_kind: "mockup",
      job_status: "running",
    });
    reclaimOnBoot();
    assert.equal(loadMockup(tid(50))?.reclaim_count, 1);
    assert.ok(loadMockup(tid(50))?.job_status === "queued" || loadMockup(tid(50))?.job_status === "running");
    assert.equal(loadMockup(tid(51))?.job_status, "failed");
    assert.equal(loadMockup(tid(51))?.job_error, "打样中断");
    assert.equal(loadMockup(tid(52))?.job_status, "running");
    assert.equal(queueSnapshot().unknown, 1);
  });

  it("rework success becomes in_review and keeps v1 hits", async () => {
    setJobsTestHooks({
      runRework: async () => ({
        code: 0,
        stdout:
          JSON.stringify({ status: "in_review", hits_v2: [{ id: "v2" }], pages_v2: [{ name: "page_01.png" }] }) + "\n",
        stderr: "",
        timedOut: false,
      }),
    });
    saveTask({
      id: tid(53),
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      status_before_job: "pending_review",
      owner: "籽烨",
      hits: [{ id: "h1", decision: "issue" }],
      job_kind: "rework",
      job_status: "queued",
      created_at: "2026-08-20T21:00:00.000Z",
    });
    enqueue({ kind: "rework", id: tid(53) });
    for (let i = 0; i < 50 && loadTask(tid(53)).job_status !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const t = loadTask(tid(53));
    assert.equal(t.status, "in_review");
    assert.equal(t.job_status, "succeeded");
    assert.equal(t.hits?.[0]?.id, "h1");
    assert.equal(t.hits_v2?.[0]?.id, "v2");
  });

  it("worker status completed cannot skip the sign-off gate", async () => {
    setJobsTestHooks({
      runCompare: async () => ({
        code: 0,
        stdout: JSON.stringify({ status: "completed", hits: [] }) + "\n",
        stderr: "",
        timedOut: false,
      }),
    });
    queuedCompare(tid(59), "2026-08-20T23:30:00.000Z");
    enqueue({ kind: "compare", id: tid(59) });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(loadTask(tid(59)).status, "pending_review");
  });

  it("reclaim fails a 0.10 comparing task with no job_status", () => {
    saveTask({
      id: tid(60),
      title: "旧对照",
      type: "excel_pdf",
      status: "comparing",
      created_at: "2026-08-19T00:00:00.000Z",
    });
    reclaimOnBoot();
    const t = loadTask(tid(60));
    assert.equal(t.status, "compare_failed");
    assert.equal(t.job_kind, "compare");
    assert.equal(t.job_status, "failed");
    assert.equal(t.job_error, "对照中断");
    assert.equal(queueSnapshot().unknown, 0);
  });

  it("reclaim of a long-running orphan is 超时 not a rerun", () => {
    saveTask({
      id: tid(57),
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      job_kind: "compare",
      job_status: "running",
      job_started_at: "2020-01-01T00:00:00.000Z",
      created_at: "2026-08-20T23:10:00.000Z",
    });
    reclaimOnBoot();
    const t = loadTask(tid(57));
    assert.equal(t.status, "compare_failed");
    assert.equal(t.job_status, "failed");
    assert.equal(t.job_error, "超时");
  });

  it("ai raster uses illustrator slot and does not fill OCR", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    queuedCompare(tid(70), "2026-08-21T08:00:00.000Z");
    setJobsTestHooks({
      runCompare: () =>
        new Promise(() => {
          /* occupy ocr */
        }),
      runRaster: async () => ({ ok: true, png: "/tmp/x.png", message: "假 COM 已导出 PNG" }),
      runPack: () =>
        new Promise(() => {
          /* occupy blender if reached */
        }),
    });
    enqueue({ kind: "compare", id: tid(70) });
    saveMockup({
      id: tid(71),
      status: "queued",
      created_at: "2026-08-21T08:00:01.000Z",
      files: [],
      source_path: "/tmp/pack.ai",
      job_kind: "mockup",
      job_status: "queued",
    });
    enqueue({ kind: "mockup", id: tid(71) });
    for (let i = 0; i < 40 && !loadMockup(tid(71))?.raster_png; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(loadTask(tid(70)).job_status, "running");
    assert.equal(queueSnapshot().ocr.running, 1);
    assert.equal(loadMockup(tid(71))?.raster_png, "/tmp/x.png");
  });

  it("ai raster failure is Chinese and does not take OCR", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    setJobsTestHooks({
      runRaster: async () => ({ ok: false, message: "COM 被拒绝或文件打不开" }),
    });
    saveMockup({
      id: tid(72),
      status: "queued",
      created_at: "2026-08-21T08:01:00.000Z",
      files: [],
      source_path: "/tmp/fail.ai",
      job_kind: "mockup",
      job_status: "queued",
    });
    enqueue({ kind: "mockup", id: tid(72) });
    for (let i = 0; i < 40 && loadMockup(tid(72))?.job_status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const job = loadMockup(tid(72));
    assert.equal(job?.job_status, "failed");
    assert.equal(job?.job_error, "COM 被拒绝或文件打不开");
    assert.equal(job?.job_kind, "mockup");
  });

  it("loadMockup misses after job.json is deleted without clearing the cache first", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    saveMockup({
      id: tid(81),
      status: "queued",
      created_at: "2026-08-21T09:00:00.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
    });
    assert.equal(loadMockup(tid(81))?.id, tid(81));
    rmSync(join(process.env.WB_DATA_DIR || "", "mockups", tid(81), "job.json"));
    assert.equal(loadMockup(tid(81)), undefined);
  });

  it("compare fail keeps disk pages and stderr JSON error", async () => {
    const id = tid(90);
    const dir = join(process.env.WB_DATA_DIR || "", "uploads", id, "pages");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "page_01.png"), "png");
    setJobsTestHooks({
      runCompare: async () => ({
        code: 1,
        stdout: "",
        stderr: "STAGE match\n" + JSON.stringify({ ok: false, error: "对照阶段失败" }) + "\n",
        timedOut: false,
      }),
    });
    queuedCompare(id, "2026-08-24T01:00:00.000Z");
    enqueue({ kind: "compare", id });
    await new Promise((r) => setTimeout(r, 30));
    const t = loadTask(id);
    assert.equal(t.status, "compare_failed");
    assert.equal(t.job_error, "对照阶段失败");
    const page = t.pages?.[0] as { name?: string; page?: number; url?: string } | undefined;
    assert.equal(page?.name, "page_01.png");
    assert.equal(page?.page, 1);
    assert.equal(page?.url, `/api/tasks/${id}/pages/page_01.png`);
  });

  it("mockup stderr JSON error is job_error not 打样中断", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    setJobsTestHooks({
      runPack: async () => ({
        code: 2,
        stdout: "",
        stderr: JSON.stringify({ ok: false, error: "缺少 pypdf" }) + "\n",
        timedOut: false,
      }),
    });
    saveMockup({
      id: tid(91),
      status: "queued",
      created_at: "2026-08-24T01:01:00.000Z",
      files: [],
      job_kind: "mockup",
      job_status: "queued",
    });
    enqueue({ kind: "mockup", id: tid(91) });
    for (let i = 0; i < 50 && loadMockup(tid(91))?.job_status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(loadMockup(tid(91))?.job_error, "缺少 pypdf");
  });

  it("rework fail does not write disk v2 pngs into pages_v2", async () => {
    const id = tid(92);
    const dir = join(process.env.WB_DATA_DIR || "", "uploads", id, "pages");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "page_01.png"), "png");
    setJobsTestHooks({
      runRework: async () => ({
        code: 1,
        stdout: "",
        stderr: JSON.stringify({ ok: false, error: "对红中断了" }) + "\n",
        timedOut: false,
      }),
    });
    saveTask({
      id,
      title: "x",
      type: "excel_pdf",
      status: "comparing",
      status_before_job: "pending_review",
      owner: "籽烨",
      hits: [{ id: "h1", status: "疑点", decision: "confirm" }],
      job_kind: "rework",
      job_status: "queued",
      created_at: "2026-08-24T01:02:00.000Z",
    });
    enqueue({ kind: "rework", id });
    await new Promise((r) => setTimeout(r, 30));
    const t = loadTask(id);
    assert.equal(t.status, "pending_review");
    assert.equal(t.job_status, "failed");
    assert.equal(t.job_error, "对红中断了");
    assert.equal(t.pages, undefined);
    assert.equal(t.pages_v2, undefined);
  });

  it("job_error from a long stderr JSON is truncated, not dropped", async () => {
    const id = tid(93);
    const long = "对照阶段失败" + "x".repeat(80);
    setJobsTestHooks({
      runCompare: async () => ({
        code: 1,
        stdout: "",
        stderr: JSON.stringify({ ok: false, error: long }) + "\n",
        timedOut: false,
      }),
    });
    queuedCompare(id, "2026-08-24T01:03:00.000Z");
    enqueue({ kind: "compare", id });
    await new Promise((r) => setTimeout(r, 30));
    const t = loadTask(id);
    assert.equal(t.job_error, long.slice(0, 80));
    assert.equal((t.job_error || "").length, 80);
    assert.notEqual(t.job_error, long);
    assert.notEqual(t.job_error, "对照中断");
  });

  it("stderr JSON with a token URL is not shown as job_error", async () => {
    const id = tid(94);
    setJobsTestHooks({
      runCompare: async () => ({
        code: 1,
        stdout: "",
        stderr:
          JSON.stringify({
            ok: false,
            error: "Client error for url https://aip.baidubce.com/oauth/2.0/token?client_secret=x",
          }) + "\n",
        timedOut: false,
      }),
    });
    queuedCompare(id, "2026-08-24T01:04:00.000Z");
    enqueue({ kind: "compare", id });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(loadTask(id).job_error, "对照中断");
  });
});

describe("mockup retry", () => {
  const viewer = { id: "籽烨", name: "籽烨", admin: false };

  function writeSource(id: string): string {
    const dir = join(process.env.WB_DATA_DIR || "", "mockups", id);
    mkdirSync(dir, { recursive: true });
    const source = join(dir, "art.ai");
    writeFileSync(source, "%PDF-1.4\n");
    return source;
  }

  it("requeues a failed job that still has the source and keeps a ready structure", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    const id = tid(95);
    const source = writeSource(id);
    writeFileSync(join(process.env.WB_DATA_DIR || "", "mockups", id, "pipeline_result.json"), "{}");
    setJobsTestHooks({
      runPack: async () => ({ code: 1, stdout: "", stderr: "stop", timedOut: false }),
    });
    saveMockup({
      id,
      status: "failed",
      created_at: "2026-09-02T08:00:00.000Z",
      files: [],
      owner: "籽烨",
      source_path: source,
      job_kind: "mockup",
      job_status: "failed",
      job_error: "打样中断",
      error: "打样中断",
      structure_engine: "v2",
      structure_status: "ready",
    });
    const next = retryMockup(id, viewer);
    assert.ok(next.status === "queued" || next.status === "running");
    assert.equal(next.structure_status, "ready");
    assert.equal(existsSync(join(process.env.WB_DATA_DIR || "", "mockups", id, "pipeline_result.json")), false);
    for (let i = 0; i < 50 && loadMockup(id)?.job_status === "queued"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.notEqual(loadMockup(id)?.job_status, "queued");
  });

  it("kills a running mockup then requeues the same source", async () => {
    const { saveMockup, loadMockup } = await import("./mockup.js");
    const id = tid(96);
    const source = writeSource(id);
    let killed = 0;
    let inspects = 0;
    setJobsTestHooks({
      runPack: (_manifest, hooks) => {
        hooks?.onSpawn?.(4242);
        return new Promise(() => undefined);
      },
      inspectWorker: (pid) => {
        assert.equal(pid, 4242);
        inspects += 1;
        return inspects === 1 ? "owned" : "missing";
      },
      killTree: (pid, force) => {
        assert.equal(pid, 4242);
        assert.equal(force, true);
        killed += 1;
      },
    });
    saveMockup({
      id,
      status: "queued",
      created_at: "2026-09-02T08:01:00.000Z",
      files: [],
      owner: "籽烨",
      source_path: source,
      job_kind: "mockup",
      job_status: "queued",
      structure_engine: "v2",
      structure_status: "ready",
    });
    enqueue({ kind: "mockup", id });
    for (let i = 0; i < 50 && loadMockup(id)?.job_pid !== 4242; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(loadMockup(id)?.job_pid, 4242);
    const next = retryMockup(id, viewer);
    assert.equal(killed, 1);
    assert.ok(next.status === "queued" || next.status === "running");
    assert.notEqual(next.job_started_at, undefined);
  });

  it("refuses structure-confirm and unsupported jobs", async () => {
    const { saveMockup, loadMockup, beginStructureConfirmation, finishStructureConfirmation } = await import("./mockup.js");
    const reviewId = tid(99);
    saveMockup({
      id: reviewId,
      status: "review_required",
      created_at: "2026-09-02T08:04:00.000Z",
      files: [],
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "waiting_input",
      structure_engine: "v2",
      structure_status: "review_required",
    });
    assert.throws(() => retryMockup(reviewId, viewer), (err: unknown) => {
      return err instanceof Error && err.message === "先确认结构再打样" && (err as { status?: number }).status === 409;
    });
    const unsupportedId = tid(100);
    saveMockup({
      id: unsupportedId,
      status: "unsupported",
      created_at: "2026-09-02T08:05:00.000Z",
      files: [],
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "failed",
      structure_engine: "v2",
      structure_status: "unsupported",
    });
    assert.throws(() => retryMockup(unsupportedId, viewer), (err: unknown) => {
      return err instanceof Error && err.message === "当前结构还不支持，不能重试" && (err as { status?: number }).status === 409;
    });
    const lockId = tid(101);
    const source = writeSource(lockId);
    saveMockup({
      id: lockId,
      status: "failed",
      created_at: "2026-09-02T08:06:00.000Z",
      files: [],
      owner: "籽烨",
      source_path: source,
      job_kind: "mockup",
      job_status: "failed",
      structure_engine: "v2",
      structure_status: "ready",
    });
    beginStructureConfirmation(loadMockup(lockId)!);
    try {
      assert.throws(() => retryMockup(lockId, viewer), (err: unknown) => {
        return err instanceof Error && err.message === "结构正在确认，暂时不能重试" && (err as { status?: number }).status === 409;
      });
    } finally {
      finishStructureConfirmation(lockId);
    }
  });

  it("resets a v2 failed job that never reached ready back to analyzing", async () => {
    const { saveMockup } = await import("./mockup.js");
    const id = tid(102);
    const source = writeSource(id);
    setJobsTestHooks({
      runStructure: async () => ({ code: 1, stdout: "", stderr: "stop", timedOut: false }),
    });
    saveMockup({
      id,
      status: "failed",
      created_at: "2026-09-02T08:07:00.000Z",
      files: [],
      owner: "籽烨",
      source_path: source,
      job_kind: "mockup",
      job_status: "failed",
      structure_engine: "v2",
    });
    const next = retryMockup(id, viewer);
    assert.equal(next.structure_status, "analyzing");
    assert.ok(next.status === "queued" || next.status === "running");
  });

  it("refuses done jobs and missing artwork", async () => {
    const { saveMockup } = await import("./mockup.js");
    const doneId = tid(97);
    saveMockup({
      id: doneId,
      status: "done",
      created_at: "2026-09-02T08:02:00.000Z",
      files: [],
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    assert.throws(() => retryMockup(doneId, viewer), (err: unknown) => {
      return err instanceof Error && err.message === "已经出图，不用重试" && (err as { status?: number }).status === 409;
    });
    const missingId = tid(98);
    saveMockup({
      id: missingId,
      status: "failed",
      created_at: "2026-09-02T08:03:00.000Z",
      files: [],
      owner: "籽烨",
      source_path: join(process.env.WB_DATA_DIR || "", "mockups", missingId, "gone.ai"),
      job_kind: "mockup",
      job_status: "failed",
    });
    assert.throws(() => retryMockup(missingId, viewer), (err: unknown) => {
      return err instanceof Error && err.message === "稿件不在了，请重新上传" && (err as { status?: number }).status === 409;
    });
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
