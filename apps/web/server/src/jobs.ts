import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { compareBookkeeping } from "./billing.js";
import { notifyJobFinished } from "./notify.js";
import {
  collectOutputs,
  loadAllMockups,
  loadMockup,
  saveMockup,
  type MockupJob,
} from "./mockup.js";
import {
  loadAllTasks,
  loadTask,
  nowIso,
  saveTask,
  taskOwner,
  type JobKind,
  type Task,
} from "./tasks.js";
import { compareTask, killTree, reworkTask, runPackaging, type RunPythonResult } from "./workers.js";
import { rasterAiFile } from "./aiRaster.js";

const STAGE_LABEL: Record<string, string> = {
  render_pdf: "出图",
  ocr: "认字",
  match: "对照",
  blender: "打样",
  export: "导出",
};

const MERGE_ALLOW = new Set([
  "hits",
  "hits_v2",
  "pages",
  "pages_b",
  "pages_v2",
  "status",
  "summary",
  "engine",
  "engine_version",
  "engine_features",
  "note",
  "disclaimer",
  "label_a",
  "label_b",
  "text_source",
  "has_pdf_text_layer",
  "pack_profile",
  "layout_zones",
  "surfaces",
  "multi_surface",
  "qrcodes",
  "round",
  "artwork_v2",
  "rework_check",
]);

const OCR_TIMEOUT_MS = 180_000;
const MOCKUP_TIMEOUT_MS = 420_000;

type Slot = "ocr" | "blender" | "illustrator";

const live: Record<Slot, string | null> = { ocr: null, blender: null, illustrator: null };

export type JobsTestHooks = {
  runCompare?: typeof compareTask;
  runRework?: typeof reworkTask;
  runPack?: typeof runPackaging;
  runRaster?: (opts: { source: string; outDir: string }) => Promise<{ ok: boolean; png?: string; message: string }>;
  notify?: typeof notifyJobFinished;
  killTree?: typeof killTree;
  bookkeeping?: typeof compareBookkeeping;
};

let hooks: JobsTestHooks = {};

export function setJobsTestHooks(next: JobsTestHooks): void {
  hooks = next;
}

export function resetJobsTestHooks(): void {
  hooks = {};
  live.ocr = null;
  live.blender = null;
  live.illustrator = null;
}

export function queueSnapshot(): {
  ocr: { running: number; queued: number };
  blender: { running: number; queued: number };
  illustrator: { running: number; queued: number };
} {
  const tasks = loadAllTasks();
  const mocks = loadAllMockups();
  const ocrQueued = tasks.filter((t) => isOcr(t.job_kind) && t.job_status === "queued").length;
  const ocrRunning = tasks.filter((t) => isOcr(t.job_kind) && t.job_status === "running").length;
  const ai = mocks.filter((j) => needsRaster(j));
  const rest = mocks.filter((j) => !needsRaster(j));
  const bQueued = rest.filter((j) => j.job_status === "queued").length;
  const bRunning = rest.filter((j) => j.job_status === "running" && j.job_stage !== "illustrator").length;
  return {
    ocr: { running: ocrRunning, queued: ocrQueued },
    blender: { running: bRunning, queued: bQueued },
    illustrator: {
      running: ai.filter((j) => j.job_status === "running").length,
      queued: ai.filter((j) => j.job_status === "queued").length,
    },
  };
}

export function decorateQueueAhead<T extends { id?: string; created_at?: string; job_kind?: string; job_status?: string }>(
  rows: T[],
): Array<T & { queue_ahead: number }> {
  const ranks = queueRanks();
  return rows.map((row) => ({
    ...row,
    queue_ahead: queueAheadFrom(ranks, row.id || "", row.job_kind, row.job_status),
  }));
}

export function publicTask(task: Task, viewer?: { name: string; admin: boolean }): Record<string, unknown> {
  if (viewer && !viewer.admin) {
    const owner = taskOwner(task);
    if (owner && owner !== viewer.name) {
      throw Object.assign(new Error("没有权限"), { status: 403 });
    }
  }
  const {
    job_pid: _pid,
    notify_job_id: _nk,
    notify_sent: _ns,
    reclaim_count: _rc,
    status_before_job: _sb,
    ...rest
  } = task;
  return {
    ...rest,
    queue_ahead: queueAheadFrom(queueRanks(), task.id, task.job_kind, task.job_status),
  };
}

export function enqueue(opts: { kind: JobKind; id: string }): Task | MockupJob {
  try {
    tryStart();
  } catch (err) {
    console.warn("tryStart failed:", err instanceof Error ? err.message : err);
  }
  if (opts.kind === "mockup") {
    const job = loadMockup(opts.id);
    if (!job) throw Object.assign(new Error("没有这单打样"), { status: 404 });
    return job;
  }
  return loadTask(opts.id);
}

export function reclaimOnBoot(): void {
  live.ocr = null;
  live.blender = null;
  live.illustrator = null;
  for (const task of loadAllTasks()) reclaimTask(task);
  for (const job of loadAllMockups()) reclaimMockup(job);
  for (const task of loadAllTasks()) {
    if (task.notify_job_id && !task.notify_sent && (task.job_status === "succeeded" || task.job_status === "failed")) {
      void fireTaskNotify(task, task.job_status === "succeeded");
    }
  }
  for (const job of loadAllMockups()) {
    if (job.notify_job_id && !job.notify_sent && (job.job_status === "succeeded" || job.job_status === "failed")) {
      void fireMockupNotify(job, job.job_status === "succeeded");
    }
  }
  tryStart();
}

export function tryStart(): void {
  if (!live.ocr) {
    const next = oldestOcrQueued();
    if (next) claimOcr(next);
  }
  if (!live.illustrator) {
    const next = oldestAiQueued();
    if (next) claimAi(next);
  }
  if (!live.blender) {
    const next = oldestMockupQueued();
    if (next) claimMockup(next);
  }
}

function isOcr(kind: string | undefined): boolean {
  return kind === "compare" || kind === "rework";
}

function allowedResultStatus(kind: string | undefined, raw: unknown): string {
  const s = String(raw || "");
  if (kind === "rework") {
    if (s === "in_review" || s === "pending_review") return s;
    return "in_review";
  }
  return s === "pending_review" ? s : "pending_review";
}

function oldestOcrQueued(): Task | undefined {
  return loadAllTasks()
    .filter((t) => isOcr(t.job_kind) && t.job_status === "queued")
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))[0];
}

function needsRaster(job: MockupJob): boolean {
  return /\.ai$/i.test(job.source_path || "") && !job.raster_png;
}

function oldestAiQueued(): MockupJob | undefined {
  return loadAllMockups()
    .filter((j) => j.job_status === "queued" && needsRaster(j))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}

function oldestMockupQueued(): MockupJob | undefined {
  return loadAllMockups()
    .filter((j) => j.job_status === "queued" && !needsRaster(j))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}

type QueueRanks = { ocr: Map<string, number>; mockup: Map<string, number> };

function queueRanks(): QueueRanks {
  const ocr = new Map<string, number>();
  const mockup = new Map<string, number>();
  const ocrQueued = loadAllTasks()
    .filter((t) => isOcr(t.job_kind) && t.job_status === "queued")
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  ocrQueued.forEach((t, i) => ocr.set(t.id, i));
  const mockQueued = loadAllMockups()
    .filter((j) => j.job_status === "queued")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  mockQueued.forEach((j, i) => mockup.set(j.id, i));
  return { ocr, mockup };
}

function queueAheadFrom(ranks: QueueRanks, id: string, kind: string | undefined, status: string | undefined): number {
  if (status !== "queued") return 0;
  if (kind === "mockup") return ranks.mockup.get(id) ?? 0;
  return ranks.ocr.get(id) ?? 0;
}

function claimOcr(task: Task): void {
  task.job_status = "running";
  task.job_started_at = nowIso();
  task.job_eta_s = 40;
  task.job_error = undefined;
  delete task.job_pid;
  if (!task.notify_job_id) {
    task.notify_job_id = `${task.id}:${task.job_kind}:${task.job_started_at}`;
    task.notify_sent = false;
  }
  saveTask(task);
  live.ocr = task.id;
  const startedAt = task.job_started_at;
  void runOcr(task.id, startedAt);
}

function claimMockup(job: MockupJob): void {
  job.job_status = "running";
  job.status = "running";
  job.job_started_at = nowIso();
  job.job_stage = "blender";
  job.job_stage_label = STAGE_LABEL.blender;
  job.job_eta_s = 240;
  job.job_error = undefined;
  delete job.job_pid;
  if (!job.notify_job_id) {
    job.notify_job_id = `${job.id}:mockup:${job.job_started_at}`;
    job.notify_sent = false;
  }
  saveMockup(job);
  live.blender = job.id;
  const startedAt = job.job_started_at;
  void runMockup(job.id, startedAt);
}

function claimAi(job: MockupJob): void {
  job.job_status = "running";
  job.status = "running";
  job.job_started_at = nowIso();
  job.job_stage = "illustrator";
  job.job_stage_label = "转图";
  job.job_eta_s = 60;
  job.job_error = undefined;
  saveMockup(job);
  live.illustrator = job.id;
  const startedAt = job.job_started_at;
  void runAi(job.id, startedAt);
}

async function runAi(id: string, startedAt: string): Promise<void> {
  const job = loadMockup(id);
  if (!job || job.job_started_at !== startedAt) return;
  const run = hooks.runRaster || rasterAiFile;
  const dir = join(DATA_DIR, "mockups", id);
  let result: { ok: boolean; png?: string; message: string };
  try {
    result = await run({ source: job.source_path || "", outDir: dir });
  } catch (err) {
    result = { ok: false, message: err instanceof Error ? err.message : "转图失败" };
  }
  const cur = loadMockup(id);
  if (!cur || cur.job_started_at !== startedAt) {
    if (live.illustrator === id) live.illustrator = null;
    tryStart();
    return;
  }
  if (live.illustrator === id) live.illustrator = null;
  if (!result.ok) {
    cur.job_status = "failed";
    cur.status = "failed";
    cur.job_error = result.message || "转图失败";
    cur.job_finished_at = nowIso();
    saveMockup(cur);
    tryStart();
    return;
  }
  cur.raster_png = result.png;
  cur.job_status = "queued";
  cur.status = "queued";
  cur.job_stage = undefined;
  saveMockup(cur);
  tryStart();
}

async function runOcr(id: string, startedAt: string): Promise<void> {
  const task = loadTask(id);
  const onSpawn = (pid: number) => {
    const t = loadTask(id);
    if (t.job_started_at !== startedAt || t.job_status !== "running") return;
    t.job_pid = pid;
    saveTask(t);
  };
  const onStderrLine = (line: string) => applyStage(id, startedAt, line, 40);
  let result: RunPythonResult;
  try {
    if (task.job_kind === "rework") {
      const run = hooks.runRework || reworkTask;
      result = await run({
        tid: id,
        pdf: join(DATA_DIR, "uploads", id, "artwork_v2.pdf"),
        actor: taskOwner(task),
        onSpawn,
        onStderrLine,
      });
    } else {
      const run = hooks.runCompare || compareTask;
      result = await run({
        tid: id,
        excel: join(DATA_DIR, "uploads", id, "source.xlsx"),
        pdf: join(DATA_DIR, "uploads", id, "artwork.pdf"),
        productName: String(task.product_name || task.title || ""),
        title: task.title,
        surface: compareSurface(task),
        actor: taskOwner(task),
        onSpawn,
        onStderrLine,
      });
    }
  } catch (err) {
    result = {
      code: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }
  finishOcr(id, startedAt, result);
}

function finishOcr(id: string, startedAt: string, result: RunPythonResult): void {
  const task = loadTask(id);
  if (task.job_started_at !== startedAt) {
    tryStart();
    return;
  }
  if (live.ocr === id) live.ocr = null;
  delete task.job_pid;
  task.job_finished_at = nowIso();
  if (result.timedOut) {
    markOcrFailed(task, "超时");
    return;
  }
  if (result.code !== 0) {
    const cli = cliError(result.stderr);
    markOcrFailed(task, publicJobError(cli) || "对照中断");
    return;
  }
  const payload = lastJson(result.stdout);
  if (!payload) {
    const cli = cliError(result.stderr);
    const msg = publicJobError(cli) || "对照中断";
    if (!publicJobError(cli)) {
      console.warn(
        `jobs ${id}: stdout 最后一行不是 JSON。跑 python -m app.cli --help。不要 save_task。`,
      );
    }
    markOcrFailed(task, msg);
    return;
  }
  mergeResult(task, payload);
  task.status = allowedResultStatus(task.job_kind, payload.status);
  task.job_status = "succeeded";
  task.job_error = undefined;
  saveTask(task);
  void fireTaskNotify(task, true);
  (hooks.bookkeeping || compareBookkeeping)(true, { task_id: task.id, actor: taskOwner(task) });
  tryStart();
}

function markOcrFailed(task: Task, publicMsg: string): void {
  if (task.job_kind === "rework") {
    task.status = String(task.status_before_job || "pending_review");
  } else {
    task.status = "compare_failed";
    task.error = publicMsg;
  }
  task.job_status = "failed";
  task.job_error = publicMsg;
  task.job_finished_at = task.job_finished_at || nowIso();
  delete task.job_pid;
  saveTask(task);
  void fireTaskNotify(task, false);
  (hooks.bookkeeping || compareBookkeeping)(false, { task_id: task.id, actor: taskOwner(task) });
  tryStart();
}

async function runMockup(id: string, startedAt: string): Promise<void> {
  const job = loadMockup(id);
  if (!job) {
    if (live.blender === id) live.blender = null;
    tryStart();
    return;
  }
  const manifest = job.manifest_path || join(DATA_DIR, "mockups", id, "manifest.json");
  let result: RunPythonResult;
  try {
    const run = hooks.runPack || runPackaging;
    result = await run(manifest, {
      onSpawn: (pid) => {
        const cur = loadMockup(id);
        if (!cur || cur.job_started_at !== startedAt) return;
        cur.job_pid = pid;
        saveMockup(cur);
      },
      onStderrLine: (line) => {
        const m = /^STAGE\s+(\S+)/.exec(line);
        if (!m) return;
        const label = STAGE_LABEL[m[1]];
        if (!label) return;
        const cur = loadMockup(id);
        if (!cur || cur.job_started_at !== startedAt) return;
        cur.job_stage = m[1];
        cur.job_stage_label = label;
        cur.job_eta_s = 240;
        saveMockup(cur);
      },
    });
  } catch (err) {
    result = {
      code: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }
  finishMockup(id, startedAt, result);
}

function finishMockup(id: string, startedAt: string, result: RunPythonResult): void {
  const job = loadMockup(id);
  if (!job || job.job_started_at !== startedAt) {
    tryStart();
    return;
  }
  if (live.blender === id) live.blender = null;
  delete job.job_pid;
  job.job_finished_at = nowIso();
  const outDir = join(DATA_DIR, "mockups", id);
  if (result.timedOut) {
    markMockupFailed(job, "超时");
    return;
  }
  if (result.code !== 0) {
    markMockupFailed(job, publicJobError(cliError(result.stderr)) || "打样中断");
    return;
  }
  const files = collectOutputs(outDir);
  if (!files.length) {
    markMockupFailed(job, "打样没有输出文件");
    return;
  }
  job.files = files;
  job.status = "done";
  job.job_status = "succeeded";
  job.job_error = undefined;
  saveMockup(job);
  void fireMockupNotify(job, true);
  tryStart();
}

function markMockupFailed(job: MockupJob, msg: string): void {
  job.status = "failed";
  job.job_status = "failed";
  job.error = msg;
  job.job_error = msg;
  job.job_finished_at = job.job_finished_at || nowIso();
  delete job.job_pid;
  saveMockup(job);
  void fireMockupNotify(job, false);
  tryStart();
}

function applyStage(id: string, startedAt: string, line: string, eta: number): void {
  const m = /^STAGE\s+(\S+)/.exec(line);
  if (!m) return;
  const label = STAGE_LABEL[m[1]];
  if (!label) return;
  const t = loadTask(id);
  if (t.job_started_at !== startedAt || t.job_status !== "running") return;
  t.job_stage = m[1];
  t.job_stage_label = label;
  t.job_eta_s = eta;
  saveTask(t);
}

function compareSurface(task: Task): string {
  const raw = String(task.pack_surface || task.label_a || "carton").trim();
  if (raw === "pouch" || raw === "膜袋") return "pouch";
  return "carton";
}

function mergeResult(task: Task, payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    if (!MERGE_ALLOW.has(key)) continue;
    (task as Record<string, unknown>)[key] = value;
  }
}

function lastJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split(/\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const v = JSON.parse(last) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* not json */
  }
  return null;
}

function cliError(stderr: string): string {
  const lines = stderr.trim().split(/\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]) as { error?: unknown };
      if (typeof v.error === "string") return v.error;
    } catch {
      /* next */
    }
  }
  return "";
}

function publicJobError(msg: string): string | null {
  const s = msg.trim();
  if (!s) return null;
  if (/save_task|--help|JSON|stdout|stderr|python -m/i.test(s)) return null;
  if (s.length > 80) return null;
  return s;
}

async function fireTaskNotify(task: Task, ok: boolean): Promise<void> {
  if (task.notify_sent) return;
  const key = task.notify_job_id || `${task.id}:${task.job_kind}:${task.job_started_at}`;
  if (!task.notify_job_id) {
    const cur = loadTask(task.id);
    if (!cur.notify_job_id) {
      cur.notify_job_id = key;
      cur.notify_sent = false;
      saveTask(cur);
    }
  }
  const fn = hooks.notify || notifyJobFinished;
  const r = await fn({
    tid: task.id,
    title: String(task.product_name || task.title || task.id),
    kind: task.job_kind === "rework" ? "rework" : "compare",
    ok,
    error: task.job_error,
  });
  if (r.ok || r.skipped) {
    const fresh = loadTask(task.id);
    if (fresh.notify_job_id && fresh.notify_job_id !== key) return;
    fresh.notify_sent = true;
    saveTask(fresh);
  } else {
    console.warn("feishu job notify failed:", r.reason);
  }
}

async function fireMockupNotify(job: MockupJob, ok: boolean): Promise<void> {
  if (job.notify_sent) return;
  if (!job.notify_job_id) {
    job.notify_job_id = `${job.id}:mockup:${job.job_started_at}`;
    saveMockup(job);
  }
  const fn = hooks.notify || notifyJobFinished;
  const r = await fn({
    tid: job.id,
    title: job.id,
    kind: "mockup",
    ok,
    error: job.job_error,
  });
  if (r.ok || r.skipped) {
    const fresh = loadMockup(job.id);
    if (fresh) {
      fresh.notify_sent = true;
      saveMockup(fresh);
    }
  } else {
    console.warn("feishu mockup notify failed:", r.reason);
  }
}

function reclaimTask(task: Task): void {
  if (task.status === "pending_review" || task.status === "in_review" || task.status === "completed") {
    if (task.job_status === "running" || task.job_status === "queued") {
      task.job_status = "succeeded";
      saveTask(task);
    }
    return;
  }
  if (task.status === "compare_failed" && task.job_finished_at) return;
  if (task.status === "comparing" && task.job_status !== "queued" && task.job_status !== "running") {
    task.status = "compare_failed";
    task.job_status = "failed";
    task.job_error = "对照中断";
    task.error = "对照中断";
    task.job_finished_at = nowIso();
    saveTask(task);
    return;
  }
  if (task.job_status === "queued") return;
  if (task.job_status !== "running") return;
  const killer = hooks.killTree || killTree;
  if (task.job_pid) killer(task.job_pid, true);
  if (timedOut(task.job_started_at, OCR_TIMEOUT_MS)) {
    task.job_status = "failed";
    task.job_error = "超时";
    task.job_finished_at = nowIso();
    if (task.job_kind === "rework") task.status = String(task.status_before_job || "pending_review");
    else {
      task.status = "compare_failed";
      task.error = "超时";
    }
    delete task.job_pid;
    saveTask(task);
    return;
  }
  const n = task.reclaim_count || 0;
  if (n < 1) {
    task.job_status = "queued";
    task.reclaim_count = n + 1;
    delete task.job_pid;
    saveTask(task);
    return;
  }
  task.job_status = "failed";
  task.job_error = "对照中断";
  task.job_finished_at = nowIso();
  if (task.job_kind === "rework") task.status = String(task.status_before_job || "pending_review");
  else {
    task.status = "compare_failed";
    task.error = "对照中断";
  }
  delete task.job_pid;
  saveTask(task);
}

function reclaimMockup(job: MockupJob): void {
  if (job.status === "done") {
    if (job.job_status === "running" || job.job_status === "queued") {
      job.job_status = "succeeded";
      saveMockup(job);
    }
    return;
  }
  if (job.status === "failed" && job.job_finished_at) return;
  if (job.job_status === "queued") return;
  if (job.job_status !== "running") return;
  const killer = hooks.killTree || killTree;
  if (job.job_pid) killer(job.job_pid, true);
  if (timedOut(job.job_started_at, MOCKUP_TIMEOUT_MS)) {
    job.status = "failed";
    job.job_status = "failed";
    job.job_error = "超时";
    job.error = "超时";
    job.job_finished_at = nowIso();
    delete job.job_pid;
    saveMockup(job);
    return;
  }
  const n = job.reclaim_count || 0;
  if (n < 1) {
    job.job_status = "queued";
    job.status = "queued";
    job.reclaim_count = n + 1;
    delete job.job_pid;
    saveMockup(job);
    return;
  }
  job.status = "failed";
  job.job_status = "failed";
  job.job_error = "打样中断";
  job.error = "打样中断";
  job.job_finished_at = nowIso();
  delete job.job_pid;
  saveMockup(job);
}

function timedOut(started: string | undefined, ms: number): boolean {
  if (!started) return false;
  const t = Date.parse(started);
  if (!Number.isFinite(t)) return false;
  return t + ms < Date.now();
}
