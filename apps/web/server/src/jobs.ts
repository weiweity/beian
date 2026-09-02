import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { compareBookkeeping } from "./billing.js";
import { notifyJobFinished } from "./notify.js";
import {
  assertCanManageMockup,
  collectOutputs,
  isMockupJobFile,
  loadAllMockups,
  loadMockup,
  mockupStoreSnapshot,
  resetMockupCache,
  resetMockupForRetry,
  saveMockup,
  type MockupJob,
} from "./mockup.js";
import {
  loadAllTasks,
  loadTasksForRecovery,
  loadTask,
  nowIso,
  saveTask,
  assertCanAccessTask,
  taskOwner,
  taskStoreSnapshot,
  type JobKind,
  type Task,
  type Viewer,
} from "./tasks.js";
import {
  compareTask,
  inspectWorkerProcess,
  killTree,
  preflightPackaging,
  reworkTask,
  runPackaging,
  type RunPythonResult,
  type WorkerProcessIdentity,
  type WorkerProcessState,
} from "./workers.js";
import { rasterAiFile } from "./aiRaster.js";

const STAGE_LABEL: Record<string, string> = {
  structure: "识别结构",
  render_pdf: "出图",
  ingest: "识稿",
  layout: "分区",
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
  "ingest",
  "pack_layout",
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
const activeMockupRetries = new Set<string>();

export type JobsTestHooks = {
  runCompare?: typeof compareTask;
  runRework?: typeof reworkTask;
  runPack?: typeof runPackaging;
  runStructure?: typeof preflightPackaging;
  runRaster?: (opts: { source: string; outDir: string }) => Promise<{ ok: boolean; png?: string; message: string }>;
  notify?: typeof notifyJobFinished;
  killTree?: typeof killTree;
  inspectWorker?: typeof inspectWorkerProcess;
  bookkeeping?: typeof compareBookkeeping;
};

let hooks: JobsTestHooks = {};
let activeNotifications = 0;

export function setJobsTestHooks(next: JobsTestHooks): void {
  hooks = next;
}

export function resetJobsTestHooks(): void {
  hooks = {};
  live.ocr = null;
  live.blender = null;
  live.illustrator = null;
  resetMockupCache();
}

export function notificationSnapshot(): { active: number } {
  return { active: activeNotifications };
}

export function queueSnapshot(): {
  ocr: { running: number; queued: number };
  blender: { running: number; queued: number };
  illustrator: { running: number; queued: number };
  unknown: number;
} {
  const taskStore = taskStoreSnapshot();
  const mockupStore = mockupStoreSnapshot();
  const tasks = taskStore.tasks;
  const mocks = mockupStore.jobs;
  const ocrQueued = tasks.filter((t) => isOcr(t.job_kind) && t.job_status === "queued").length;
  const ocrRunning = tasks.filter((t) => isOcr(t.job_kind) && t.job_status === "running").length;
  const ai = mocks.filter((j) => needsIllustrator(j));
  const rest = mocks.filter((j) => !needsIllustrator(j));
  const bQueued = rest.filter((j) => j.job_status === "queued").length;
  const bRunning = rest.filter((j) => j.job_status === "running" && j.job_stage !== "illustrator").length;
  return {
    // Disk state is durable; live slots close the short window before a worker
    // PID/status update is persisted and keep corrupted active records fail-closed.
    ocr: { running: Math.max(ocrRunning, live.ocr ? 1 : 0), queued: ocrQueued },
    blender: { running: Math.max(bRunning, live.blender ? 1 : 0), queued: bQueued },
    illustrator: {
      running: Math.max(ai.filter((j) => j.job_status === "running").length, live.illustrator ? 1 : 0),
      queued: ai.filter((j) => j.job_status === "queued").length,
    },
    unknown: taskStore.unreadable + mockupStore.unreadable,
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

export function publicTask(task: Task, viewer?: Viewer): Record<string, unknown> {
  if (viewer) assertCanAccessTask(task, viewer);
  const {
    job_pid: _pid,
    notify_job_id: _nk,
    notify_sent: _ns,
    reclaim_count: _rc,
    status_before_job: _sb,
    source_receipt: _sourceReceipt,
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

/** 先确认旧 worker 已退出，再改成 queued。完成回调靠 job_started_at 丢弃。 */
export function retryMockup(id: string, viewer: Viewer): MockupJob {
  const job = loadMockup(id);
  if (!job) throw Object.assign(new Error("没有这单打样"), { status: 404 });
  assertCanManageMockup(job, viewer);
  if (activeMockupRetries.has(id)) {
    throw Object.assign(new Error("这单正在重试，请稍候"), { status: 409 });
  }
  const pid = job.job_pid;
  const illustratorLive = live.illustrator === id;
  const blenderLive = live.blender === id;
  if ((job.job_status === "running" || job.job_status === "queued") && !pid && (illustratorLive || blenderLive)) {
    throw Object.assign(new Error("打样还在启动，请稍后再试"), { status: 409 });
  }
  activeMockupRetries.add(id);
  try {
    if (pid) {
      if (!clearPersistedWorker(pid, { kind: "mockup", id })) {
        throw Object.assign(new Error("打样还在跑，暂时不能重试"), { status: 409 });
      }
    }
    const fresh = loadMockup(id);
    if (!fresh) throw Object.assign(new Error("没有这单打样"), { status: 404 });
    resetMockupForRetry(fresh);
    if (illustratorLive) live.illustrator = null;
    if (blenderLive) live.blender = null;
    try {
      tryStart();
    } catch (err) {
      console.warn("retry mockup tryStart failed:", err instanceof Error ? err.message : err);
    }
    const next = loadMockup(id);
    if (!next) throw Object.assign(new Error("没有这单打样"), { status: 404 });
    return next;
  } finally {
    activeMockupRetries.delete(id);
  }
}

export function reclaimOnBoot(): void {
  live.ocr = null;
  live.blender = null;
  live.illustrator = null;
  for (const task of loadTasksForRecovery()) reclaimTask(task);
  for (const job of loadAllMockups()) reclaimMockup(job);
  for (const task of loadAllTasks()) {
    if (task.notify_job_id && !task.notify_sent && (task.job_status === "succeeded" || task.job_status === "failed")) {
      launchNotification(`task ${task.id}`, () => fireTaskNotify(task, task.job_status === "succeeded"));
    }
  }
  for (const job of loadAllMockups()) {
    if (job.notify_job_id && !job.notify_sent && (job.job_status === "succeeded" || job.job_status === "failed")) {
      launchNotification(`mockup ${job.id}`, () => fireMockupNotify(job, job.job_status === "succeeded"));
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

function needsStructure(job: MockupJob): boolean {
  return job.structure_engine === "v2" && job.structure_status === "analyzing";
}

function needsRaster(job: MockupJob): boolean {
  return job.structure_engine !== "v2" && /\.ai$/i.test(job.source_path || "") && !job.raster_png;
}

function needsIllustrator(job: MockupJob): boolean {
  return needsStructure(job) || needsRaster(job);
}

function oldestAiQueued(): MockupJob | undefined {
  return loadAllMockups()
    .filter((j) => j.job_status === "queued" && needsIllustrator(j))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}

function oldestMockupQueued(): MockupJob | undefined {
  return loadAllMockups()
    .filter(
      (j) =>
        j.job_status === "queued" &&
        !needsIllustrator(j) &&
        (j.structure_engine !== "v2" || j.structure_status === "ready"),
    )
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
  job.job_stage = "render_pdf";
  job.job_stage_label = STAGE_LABEL.render_pdf;
  job.job_eta_s = 240;
  job.job_error = undefined;
  delete job.job_finished_at;
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
  const structure = needsStructure(job);
  job.job_stage = structure ? "structure" : "illustrator";
  job.job_stage_label = structure ? STAGE_LABEL.structure : "转图";
  job.job_eta_s = structure ? 120 : 60;
  job.job_error = undefined;
  delete job.job_finished_at;
  saveMockup(job);
  live.illustrator = job.id;
  const startedAt = job.job_started_at;
  if (structure) void runStructure(job.id, startedAt);
  else void runAi(job.id, startedAt);
}

type StructureControl = {
  kind: "structure_resolution";
  structure_status: "review_required" | "unsupported";
  code?: string;
  message?: string;
  resolution_path?: string;
  details?: {
    artwork_pdf?: string | null;
    artwork_preview?: string | null;
    structure_sidecar?: string | null;
    source_sha256?: string | null;
  };
};

function structureControl(stderr: string): StructureControl | null {
  const lines = stderr.trim().split(/\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]) as Partial<StructureControl>;
      if (
        value.kind === "structure_resolution" &&
        (value.structure_status === "review_required" || value.structure_status === "unsupported")
      ) {
        return value as StructureControl;
      }
    } catch {
      /* next line */
    }
  }
  return null;
}

function preparedManifest(payload: Record<string, unknown> | null): string | null {
  const value = payload?.prepared_manifest;
  return typeof value === "string" && value.trim() ? value : null;
}

async function runStructure(id: string, startedAt: string): Promise<void> {
  const job = loadMockup(id);
  if (!job || job.job_started_at !== startedAt) return;
  const manifest = job.manifest_path || join(DATA_DIR, "mockups", id, "manifest.json");
  const run = hooks.runStructure || preflightPackaging;
  let result: RunPythonResult;
  try {
    result = await run(manifest, {
      onSpawn: (pid) => {
        const current = loadMockup(id);
        if (!current || current.job_started_at !== startedAt) return;
        current.job_pid = pid;
        saveMockup(current);
      },
      onStderrLine: (line) => {
        const match = /^STAGE\s+(\S+)/.exec(line);
        if (!match || match[1] !== "structure") return;
        const current = loadMockup(id);
        if (!current || current.job_started_at !== startedAt) return;
        current.job_stage = "structure";
        current.job_stage_label = STAGE_LABEL.structure;
        current.job_eta_s = 120;
        saveMockup(current);
      },
    });
  } catch (error) {
    result = {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  }
  finishStructure(id, startedAt, result);
}

function finishStructure(id: string, startedAt: string, result: RunPythonResult): void {
  const job = loadMockup(id);
  if (!job || job.job_started_at !== startedAt) {
    tryStart();
    return;
  }
  if (live.illustrator === id) live.illustrator = null;
  delete job.job_pid;
  job.job_finished_at = nowIso();
  if (result.timedOut) {
    markMockupFailed(job, "结构识别超时");
    return;
  }
  const control = structureControl(result.stderr);
  if (control) {
    const controlPaths = [
      control.resolution_path,
      control.details?.artwork_pdf,
      control.details?.artwork_preview,
      control.details?.structure_sidecar,
    ].filter((path): path is string => Boolean(path));
    if (
      !isMockupJobFile(job.id, control.resolution_path) ||
      controlPaths.some((path) => !isMockupJobFile(job.id, path))
    ) {
      markMockupFailed(job, "结构识别返回了无效文件");
      return;
    }
    job.structure_status = control.structure_status;
    job.structure_code = String(control.code || "structure_review_required");
    job.structure_message = String(control.message || "包装结构需要人工确认。");
    job.structure_resolution_path = control.resolution_path;
    job.structure_sidecar_path = control.details?.structure_sidecar || undefined;
    job.structure_artwork_path = control.details?.artwork_pdf || undefined;
    job.structure_artwork_preview_path = control.details?.artwork_preview || undefined;
    job.structure_source_sha256 = control.details?.source_sha256 || undefined;
    job.status = control.structure_status;
    job.job_status = "waiting_input";
    job.job_error = undefined;
    delete job.job_finished_at;
    saveMockup(job);
    tryStart();
    return;
  }
  if (result.code !== 0) {
    const failure = cliFailure(result.stderr);
    logCliFailure(`mockup ${job.id} structure`, failure);
    markMockupFailed(job, publicJobError(failure.error) || "结构识别中断");
    return;
  }
  const payload = lastJson(result.stdout);
  const nextManifest = preparedManifest(payload);
  if (!isMockupJobFile(job.id, nextManifest)) {
    markMockupFailed(job, "结构识别没有返回可继续的作业清单");
    return;
  }
  job.manifest_path = nextManifest;
  job.structure_status = "ready";
  job.structure_code = undefined;
  job.structure_message = undefined;
  job.status = "queued";
  job.job_status = "queued";
  job.job_stage = undefined;
  job.job_stage_label = undefined;
  job.job_eta_s = undefined;
  job.reclaim_count = 0;
  delete job.job_finished_at;
  saveMockup(job);
  tryStart();
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
  launchNotification(`task ${task.id}`, () => fireTaskNotify(task, true));
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
  attachRenderedPages(task);
  saveTask(task);
  launchNotification(`task ${task.id}`, () => fireTaskNotify(task, false));
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
    const failure = cliFailure(result.stderr);
    logCliFailure(`mockup ${job.id} render`, failure);
    markMockupFailed(job, publicJobError(failure.error) || "打样中断");
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
  launchNotification(`mockup ${job.id}`, () => fireMockupNotify(job, true));
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
  launchNotification(`mockup ${job.id}`, () => fireMockupNotify(job, false));
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

type CliFailure = { error: string; code?: string; cause?: string; fix?: string };

function cliFailure(stderr: string): CliFailure {
  const lines = stderr.trim().split(/\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]) as Record<string, unknown>;
      if (typeof v.error === "string") {
        return {
          error: v.error,
          code: typeof v.code === "string" ? v.code : undefined,
          cause: typeof v.cause === "string" ? v.cause : undefined,
          fix: typeof v.fix === "string" ? v.fix : undefined,
        };
      }
    } catch {
      /* next */
    }
  }
  return { error: "" };
}

function cliError(stderr: string): string {
  return cliFailure(stderr).error;
}

function safeCliDiagnostic(value: string | undefined): string {
  return String(value || "-")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/((?:token|secret|api[_-]?key|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, "$1***")
    // 私有 cause 只用于定位类别；数据目录和任务绝对路径不进入持久日志。
    .replace(/[A-Za-z]:\\[^\r\n]*/g, "[path]")
    .replace(/(^|[\s=:])\/(?:Users|home|var|tmp|opt|srv|Volumes|private)\/[^\r\n]*/g, "$1[path]")
    .slice(0, 240);
}

function logCliFailure(scope: string, failure: CliFailure): void {
  if (!failure.cause && !failure.fix && !failure.code) return;
  console.error(
    `${scope}: problem=${safeCliDiagnostic(failure.code || failure.error)} cause=${safeCliDiagnostic(failure.cause)} fix=${safeCliDiagnostic(failure.fix)}`,
  );
}

function publicJobError(msg: string): string | null {
  const s = msg.trim();
  if (!s) return null;
  if (/save_task|--help|JSON|stdout|stderr|python -m/i.test(s)) return null;
  if (/https?:\/\/|access_token|client_secret|client_id|api[_-]?key/i.test(s)) return null;
  return s.length > 80 ? s.slice(0, 80) : s;
}

type PagePng = { url: string; name: string; page: number };

function listPagePngs(dir: string, urlPrefix: string): PagePng[] {
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^page_\d+\.png$/i.test(name))
    .sort()
    .map((name) => {
      const n = Number((/^page_(\d+)\.png$/i.exec(name) || [])[1] || 0);
      return { name, page: n, url: `${urlPrefix}/${name}` };
    });
}

function attachRenderedPages(task: Task): void {
  if (task.job_kind === "rework") return;
  const root = join(DATA_DIR, "uploads", task.id, "pages");
  const api = `/api/tasks/${task.id}/pages`;
  if (!Array.isArray(task.pages) || task.pages.length === 0) {
    const flat = listPagePngs(root, api);
    const sideA = listPagePngs(join(root, "a"), `${api}/a`);
    const pages = flat.length ? flat : sideA;
    if (pages.length) task.pages = pages;
  }
  if (!Array.isArray(task.pages_b) || task.pages_b.length === 0) {
    const sideB = listPagePngs(join(root, "b"), `${api}/b`);
    if (sideB.length) task.pages_b = sideB;
  }
}

async function fireTaskNotify(task: Task, ok: boolean): Promise<void> {
  if (task.notify_sent) return;
  const key = task.notify_job_id || `${task.id}:${task.job_kind}:${task.job_started_at}`;
  if (!task.notify_job_id) {
    const cur = loadAllTasks().find((candidate) => candidate.id === task.id);
    if (!cur) return;
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
    // 已结束任务允许在通知飞行期间删除；晚到的通知只能放弃收尾，不能复活 JSON。
    const fresh = loadAllTasks().find((candidate) => candidate.id === task.id);
    if (!fresh) return;
    if (fresh.notify_job_id && fresh.notify_job_id !== key) return;
    fresh.notify_sent = true;
    saveTask(fresh);
  } else {
    console.warn("feishu job notify failed:", r.reason);
  }
}

/**
 * 所有脱离 HTTP 生命周期的通知都从这里登记。发版排空只依赖 active 计数，
 * 不需要知道通知来自作业完成还是人工签字。
 */
export function launchNotification(label: string, operation: () => Promise<void>): void {
  // Acquire before invoking the async operation. A release drain starting in
  // the same event-loop turn must wait for the local notify_sent outbox commit.
  activeNotifications += 1;
  void Promise.resolve()
    .then(operation)
    .catch((err: unknown) => {
      const cause = err instanceof Error ? err.message : String(err);
      console.warn(`jobs ${label}: 通知收尾异常。cause=${cause} fix=保留作业结果，启动时重试通知`);
    })
    .finally(() => {
      activeNotifications = Math.max(0, activeNotifications - 1);
    });
}

async function fireMockupNotify(job: MockupJob, ok: boolean): Promise<void> {
  if (job.notify_sent) return;
  const key = job.notify_job_id || `${job.id}:mockup:${job.job_started_at}`;
  if (!job.notify_job_id) {
    const cur = loadMockup(job.id);
    if (!cur) return;
    if (!cur.notify_job_id) {
      cur.notify_job_id = key;
      cur.notify_sent = false;
      saveMockup(cur);
    }
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
    if (!fresh) return;
    if (fresh.notify_job_id && fresh.notify_job_id !== key) return;
    fresh.notify_sent = true;
    saveMockup(fresh);
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
    task.job_kind = "compare";
    task.job_status = "failed";
    task.job_error = "对照中断";
    task.error = "对照中断";
    task.job_finished_at = nowIso();
    attachRenderedPages(task);
    saveTask(task);
    return;
  }
  if (task.job_status === "queued") return;
  if (task.job_status !== "running") return;
  const kind = task.job_kind === "rework" ? "rework" : "compare";
  if (!clearPersistedWorker(task.job_pid, { kind, id: task.id })) {
    task.job_status = "failed";
    task.job_error = "对照中断";
    task.job_finished_at = nowIso();
    if (task.job_kind === "rework") task.status = String(task.status_before_job || "pending_review");
    else {
      task.status = "compare_failed";
      task.error = "对照中断";
    }
    delete task.job_pid;
    attachRenderedPages(task);
    saveTask(task);
    return;
  }
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
    attachRenderedPages(task);
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
  attachRenderedPages(task);
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
  if (!clearPersistedWorker(job.job_pid, { kind: "mockup", id: job.id })) {
    job.status = "failed";
    job.job_status = "failed";
    job.job_error = "打样中断";
    job.error = "打样中断";
    job.job_finished_at = nowIso();
    delete job.job_pid;
    saveMockup(job);
    return;
  }
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

/** A persisted PID is never authority. Retry only after absence or confirmed termination. */
function clearPersistedWorker(pid: number | undefined, expected: WorkerProcessIdentity): boolean {
  if (!pid) return true;
  const inspect = hooks.inspectWorker || inspectWorkerProcess;
  const probe = (): WorkerProcessState => {
    try {
      return inspect(pid, expected);
    } catch {
      return "unknown";
    }
  };
  const before = probe();
  if (before === "missing") return true;
  if (before !== "owned") {
    console.warn(
      `jobs ${expected.id}: 不接管持久化 PID ${pid}。cause=${before === "other" ? "PID 已属于其他进程" : "无法核验进程归属"} fix=不杀进程且不自动重跑`,
    );
    return false;
  }
  try {
    (hooks.killTree || killTree)(pid, true);
  } catch {
    console.warn(`jobs ${expected.id}: 已确认 worker 但终止失败。cause=killTree 抛错 fix=不自动重跑`);
    return false;
  }
  const after = probe();
  if (after === "missing" || after === "other") return true;
  console.warn(`jobs ${expected.id}: worker 终止后仍无法确认退出。cause=${after} fix=不自动重跑`);
  return false;
}

function timedOut(started: string | undefined, ms: number): boolean {
  if (!started) return false;
  const t = Date.parse(started);
  if (!Number.isFinite(t)) return false;
  return t + ms < Date.now();
}
