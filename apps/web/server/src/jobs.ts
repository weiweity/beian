import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DATA_DIR, PACKAGING, PYTHON } from "./config.js";
import { compareBookkeeping } from "./billing.js";
import { notifyJobFinished } from "./notify.js";
import {
  applyRenderGenerationPatch,
  assertCanManageMockup,
  acceptStructureConfirmation,
  beginStructureConfirmation,
  collectOutputs,
  fileOf,
  finishStructureConfirmation,
  generationManagedReject,
  isGenerationManagedMockup,
  isMockupJobFile,
  loadAllMockups,
  loadMockup,
  mockupJobDir,
  mockupRenderPlanBytes,
  mockupStoreSnapshot,
  prepareStructureConfirmation,
  printFaceRepairSource,
  printFaceRepairActive,
  publicRenderMutation,
  readMockupFromDisk,
  requiredPrintFacesReady,
  resetMockupCache,
  resetMockupForRetry,
  saveMockup,
  stampAutoConfirmed,
  structureConfirmationActive,
  uniqueConfirmableAnchor,
  type MockupJob,
  type PublicRenderMutationSummary,
  type RenderGenerationIdempotencyFact,
  type RenderGenerationRequestRecord,
} from "./mockup.js";
import {
  G0_LEGACY_ORIGINAL_ID,
  RENDER_GENERATION_DIR,
  isRenderGenerationError,
  openRenderGenerationStore,
  type QualityVerifier,
  type RenderGenerationSource,
} from "./renderGenerations.js";
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
  confirmPackagingStructure,
  preflightPackaging,
  reworkTask,
  runPackaging,
  runPackagingBlenderOnly,
  runPrintFaceRepair,
  type RunPythonResult,
  type WorkerProcessIdentity,
  type WorkerProcessState,
} from "./workers.js";
import { inspectRenderGenerationGroup, recoverWindowsRenderGeneration, signalRenderGenerationGroup } from "./renderGenerationProcess.js";
import { rasterAiFile } from "./aiRaster.js";
import { readIllustratorAgentStatus } from "./illustratorAgent.js";
import type { RenderBridgeObserver } from "./renderGenerationBridge.js";
import { releaseRenderReservation } from "./renderGenerationBudget.js";
import { getRenderGenerationRuntime } from "./renderGenerationRuntime.js";

const STAGE_LABEL: Record<string, string> = {
  structure: "正在出图",
  illustrator_opening: "打开稿件",
  illustrator_inventory: "盘点图层",
  illustrator_saving_full_pdf: "保存整页 PDF",
  illustrator_saving_artwork_pdf: "保存印刷 PDF",
  illustrator_writing_result: "写出结构",
  illustrator_closing: "关闭文档",
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
const MOCKUP_TIMEOUT_MS = 1_260_000;

type Slot = "ocr" | "blender" | "illustrator";

const live: Record<Slot, string | null> = { ocr: null, blender: null, illustrator: null };
const activeMockupRetries = new Set<string>();
const relightStudioJobs = new Set<string>();

/** 服务端验证适配器入参。生产未接线；不得把 JSON.parse 当 RF-02 已验证。 */
export type RenderPlanVerifierInput = {
  jobId: string;
  jobRoot: string;
  mode: "legacy_relight" | "upgrade";
  bytes: Buffer;
  sourcePath: string;
};

/**
 * 验证适配器的受信结果。identitySha256 必须等于 jobs 对同一字节的独立哈希；
 * 不得改写计划字节或自报哈希。profile 由验证结果给出，不信客户端。
 */
export type VerifiedRenderPlanSnapshot = {
  identitySha256: string;
  bytes: Buffer;
  profile: string;
  verifier: string;
  sourceAssets?: RenderSourceOutputSnapshot[];
};

type RenderSourceOutputSnapshot = {
  key: string;
  path: string;
  sha256: string;
  bytes: number;
};

type RenderPlanVerifier = (input: RenderPlanVerifierInput) => VerifiedRenderPlanSnapshot;

export type RenderGenerationExecuteInput = {
  jobId: string;
  jobRoot: string;
  mutationId: string;
  mode: "legacy_relight" | "upgrade";
  sourceGenerationId: string;
  candidateDir: string;
  plan: {
    identitySha256: string;
    bytes: Buffer;
    profile: string;
    verifier: string;
  };
  sourceOutputs: RenderSourceOutputSnapshot[];
  studioAdjustment?: { product_light: number; background_light: number };
};

export type RenderGenerationExecuteResult = {
  outputs: RenderGenerationSource[];
  contract_sha256: string;
  plan_identity_sha256: string;
  source_generation_id: string;
  runtimeQuality?: "unwired" | "verified";
  qualityVerifier?: QualityVerifier;
};

type RenderGenerationExecutor = (input: RenderGenerationExecuteInput) => Promise<RenderGenerationExecuteResult>;

export type RenderGenerationPreparer = (input: RenderPlanVerifierInput & {
  mutationId: string;
  studioAdjustment?: { product_light: number; background_light: number };
  observer: RenderBridgeObserver;
}) => Promise<{ plan: VerifiedRenderPlanSnapshot; execute: RenderGenerationExecutor; lifecycle?: import("./renderGenerationBudget.js").RenderLifecycle }>;

export type JobsTestHooks = {
  runCompare?: typeof compareTask;
  runRework?: typeof reworkTask;
  runPack?: typeof runPackaging;
  runStructure?: typeof preflightPackaging;
  confirmStructure?: typeof confirmPackagingStructure;
  runPrintFaceRepair?: typeof runPrintFaceRepair;
  runRelight?: typeof runPackagingBlenderOnly;
  runRaster?: (opts: { source: string; outDir: string }) => Promise<{ ok: boolean; png?: string; message: string }>;
  notify?: typeof notifyJobFinished;
  killTree?: typeof killTree;
  inspectWorker?: typeof inspectWorkerProcess;
  inspectGenerationGroup?: typeof inspectRenderGenerationGroup;
  recoverWindowsGeneration?: typeof recoverWindowsRenderGeneration;
  killGenerationGroup?: typeof signalRenderGenerationGroup;
  bookkeeping?: typeof compareBookkeeping;
  /** 测试注入。生产不得默认用 unwired 验证结果激活。 */
  runRenderGeneration?: RenderGenerationExecutor;
  qualityVerifier?: QualityVerifier;
  /**
   * 服务端渲染计划验证适配器。生产未接线。
   * 测试必须注入明确受控验证器；禁止 JSON.parse 或自报哈希冒充 RF-02。
   */
  verifyRenderPlan?: RenderPlanVerifier;
  /** Async RF-02 preparation. No default registration while runtime quality is unwired. */
  prepareRenderGeneration?: RenderGenerationPreparer;
  generationFailpoints?: {
    afterSealBeforePointer?: (jobId: string) => void;
    beforeActivationAudit?: (jobId: string) => void;
  };
};

export type RenderGenerationMutationEnqueueInput = {
  jobId: string;
  viewer: Viewer;
  clientRequestId: string;
  mode: "legacy_relight" | "upgrade";
  sourceGenerationId: string;
  expectedCurrentGenerationId: string;
  studioAdjustment?: { product_light?: number; background_light?: number };
};

export type RenderGenerationMutationEnqueueResult = {
  mutation: PublicRenderMutationSummary;
  current_render_generation_id?: string;
  has_render_generations: boolean;
  job_status: MockupJob["status"];
};

const TEST_MOCKUP_STOP: JobsTestHooks = {
  runStructure: async () => ({ code: 1, stdout: "", stderr: '{"error":"test stop"}', timedOut: false }),
  runPack: async () => ({ code: 1, stdout: "", stderr: "test stop", timedOut: false }),
  runRaster: async () => ({ ok: false, message: "test stop" }),
  confirmStructure: async () => ({ code: 1, stdout: "", stderr: "test stop", timedOut: false }),
  runPrintFaceRepair: async () => ({ code: 1, stdout: "", stderr: "test stop", timedOut: false }),
  runRelight: async () => ({ code: 1, stdout: "", stderr: "test stop", timedOut: false }),
};

function testHooks(overrides: JobsTestHooks = {}): JobsTestHooks {
  return process.env.VITEST === "1" ? { ...TEST_MOCKUP_STOP, ...overrides } : overrides;
}

let hooks: JobsTestHooks = testHooks();
let activeNotifications = 0;

export function setJobsTestHooks(next: JobsTestHooks): void {
  hooks = testHooks(next);
}

export function resetJobsTestHooks(): void {
  hooks = testHooks();
  live.ocr = null;
  live.blender = null;
  live.illustrator = null;
  relightStudioJobs.clear();
  generationCommitLocks.clear();
  resetMockupCache();
}

export function setJobsLiveForTest(slot: Slot, id: string | null): void {
  if (process.env.VITEST !== "1") throw new Error("作业槽测试钩子只能在 VITEST 使用");
  live[slot] = id;
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
  const bQueued =
    rest.filter((j) => j.job_status === "queued").length +
    mocks.filter((j) => j.status === "done" && j.render_mutation?.status === "queued").length +
    mocks.filter((j) => j.print_faces_request?.status === "queued").length;
  const bRunning = rest.filter((j) => j.job_status === "running" && j.job_stage !== "illustrator").length +
    mocks.filter((j) => j.print_faces_request?.status === "running").length;
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

function persistPrintFaceFiles(job: MockupJob): MockupJob {
  if (isGenerationManagedMockup(job)) throw generationManagedReject("print-faces");
  job.files = collectOutputs(join(DATA_DIR, "mockups", job.id));
  saveMockup(job);
  return job;
}

function assertPrintFacePath(job: MockupJob, path: string, allowMissing = false): void {
  const root = mockupJobDir(job.id);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("切面路径超出打样目录。");
  let current = root;
  for (const part of ["", ...rel.split(/[\\/]/)]) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("切面路径不能使用符号链接。");
    } catch (error) {
      if (allowMissing && current === path && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/** Hash the accepted source in bounded chunks; a queued repair cannot silently switch artwork. */
function printFaceSourceHash(job: MockupJob): string {
  const source = printFaceRepairSource(job);
  if (!source) throw new Error("这单没有可用底稿，无法补生成。请重新打样。");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  for (const path of [source.artwork, source.resolved]) {
    assertPrintFacePath(job, path);
    const fd = openSync(path, "r");
    try {
      hash.update(path).update("\0");
      let count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
      hash.update("\0");
    } finally { closeSync(fd); }
  }
  return hash.digest("hex");
}

export async function repairMockupPrintFaces(id: string, viewer: Viewer): Promise<MockupJob> {
  const job = readMockupFromDisk(id);
  if (!job) throw Object.assign(new Error("没有这单打样"), { status: 404 });
  if (isGenerationManagedMockup(job)) throw generationManagedReject("print-faces");
  if (printFaceRepairActive(job)) return job;
  if (job.render_mutation?.status === "queued" || job.render_mutation?.status === "running"
    || job.render_generation_request?.worker_pid !== undefined || structureConfirmationActive(id)) {
    throw Object.assign(new Error("这单渲染版本或结构尚未结束，暂时不能补切面。"), { status: 409, code: "render_generation_busy" });
  }
  if (live.blender === id || job.status === "queued" || job.status === "running") {
    throw Object.assign(new Error("出图还在跑，现在不能补切面。"), { status: 409 });
  }
  if (job.status !== "done") throw Object.assign(new Error("只有已出图的纸盒才能补印刷面。"), { status: 409 });
  if (requiredPrintFacesReady(id) && !job.print_faces_request) return persistPrintFaceFiles(job);
  if (requiredPrintFacesReady(id) && job.print_faces_request?.status === "succeeded") return job;
  if (!printFaceRepairSource(job)) throw Object.assign(new Error("这单没有可用底稿，无法补生成。请重新打样。"), { status: 409 });
  job.print_faces_request = { id: randomBytes(16).toString("hex"), status: "queued", created_at: nowIso(),
    actor_id: viewer.id, source_sha256: printFaceSourceHash(job) };
  saveMockup(job);
  // The durable acknowledgement precedes scheduling and survives a lost HTTP response.
  queueMicrotask(() => { try { tryStart(); } catch { /* queued fact remains for boot recovery */ } });
  return job;
}

function finishPrintFaceRepair(id: string, requestId: string, error?: string): void {
  const job = readMockupFromDisk(id);
  const request = job?.print_faces_request;
  if (!job || !request || request.id !== requestId || request.status !== "running") return;
  request.status = error ? "failed" : "succeeded";
  request.finished_at = nowIso();
  request.error = error;
  delete request.worker_pid;
  if (!error) {
    job.print_faces_repaired_by = request.actor_id;
    job.print_faces_repaired_at = request.finished_at;
    persistPrintFaceFiles(job);
  } else saveMockup(job);
}

function publishPrintFaceRepair(job: MockupJob, assets: string): void {
  const faces = ["front", "back", "left", "right", "top", "bottom"];
  const required = faces.slice(0, 4);
  const files = faces.filter(face => existsSync(join(assets, `panel_${face}.png`)));
  if (required.some(face => !files.includes(face))) throw new Error("切面失败，请稍后再试。");
  for (const face of files) {
    const path = join(assets, `panel_${face}.png`);
    assertPrintFacePath(job, path);
    const header = Buffer.alloc(8);
    const fd = openSync(path, "r");
    try { readSync(fd, header, 0, 8, 0); } finally { closeSync(fd); }
    if (!header.equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      throw new Error("切面失败，请稍后再试。");
    }
  }
  const destination = join(mockupJobDir(job.id), "assets");
  assertPrintFacePath(job, destination, true);
  mkdirSync(destination, { recursive: true });
  // Each rename is atomic. Interrupted publication is rerendered from the same frozen source.
  for (const face of files) renameSync(join(assets, `panel_${face}.png`), join(destination, `panel_${face}.png`));
}

function claimPrintFaceRepair(job: MockupJob): void {
  const request = job.print_faces_request!;
  request.status = "running";
  request.started_at = nowIso();
  saveMockup(job);
  live.blender = job.id;
  void executePrintFaceRepair(job, request.id).finally(() => {
    const fresh = readMockupFromDisk(job.id);
    // A missing/corrupt record cannot prove publication or worker exit. Keep the slot fenced.
    if (fresh?.print_faces_request?.id === request.id && fresh.print_faces_request.status !== "running") {
      if (live.blender === job.id) live.blender = null;
      tryStart();
    }
  }).catch(error => console.warn(`jobs ${job.id}: problem=print_faces cause=${error instanceof Error ? error.message : "unknown"} fix=保留持久状态等待恢复`));
}

async function executePrintFaceRepair(job: MockupJob, requestId: string): Promise<void> {
  const root = join(mockupJobDir(job.id), `.print-faces-${requestId}`);
  const assets = join(root, "assets");
  try {
    if (printFaceSourceHash(job) !== job.print_faces_request!.source_sha256) throw new Error("底稿已变化，请重新补印刷面。");
    const source = printFaceRepairSource(job)!;
    mkdirSync(root, { recursive: false });
    // Orphan workers can only write their attempt directory, never the public assets.
    copyFileSync(source.artwork, join(root, "artwork.pdf"));
    copyFileSync(source.resolved, join(root, "resolved.json"));
    const run = hooks.runPrintFaceRepair || runPrintFaceRepair;
    const result = await run({ jobDir: source.jobDir, artwork: join(root, "artwork.pdf"), resolved: join(root, "resolved.json"), assets,
      executionId: requestId, onSpawn: pid => {
        const fresh = readMockupFromDisk(job.id);
        if (!fresh || fresh.print_faces_request?.id !== requestId) throw new Error("补面请求已变化");
        fresh.print_faces_request.worker_pid = pid;
        saveMockup(fresh);
      } });
    if (result.timedOut) throw new Error("切面超时，请稍后再试。");
    if (result.code !== 0) throw new Error("切面失败，请稍后再试。");
    const fresh = readMockupFromDisk(job.id);
    if (!fresh || fresh.print_faces_request?.id !== requestId || fresh.print_faces_request.status !== "running") return;
    if (isGenerationManagedMockup(fresh) || structureConfirmationActive(job.id)
      || printFaceSourceHash(fresh) !== fresh.print_faces_request.source_sha256) throw new Error("底稿或版本已变化，请重新补印刷面。");
    publishPrintFaceRepair(fresh, assets);
    finishPrintFaceRepair(job.id, requestId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    const publicReasons = ["切面超时，请稍后再试。", "底稿已变化，请重新补印刷面。", "底稿或版本已变化，请重新补印刷面。",
      "这单没有可用底稿，无法补生成。请重新打样。", "切面路径超出打样目录。", "切面路径不能使用符号链接。"];
    finishPrintFaceRepair(job.id, requestId, publicReasons.includes(reason) ? reason : "切面失败，请稍后再试。");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function recoverPrintFaceRepairsOnBoot(): void {
  for (const job of loadAllMockups()) {
    const request = job.print_faces_request;
    if (request?.status !== "running") continue;
    if (!request.worker_pid) continue; // Spawn/persist gap: no PID is not proof that the worker exited.
    if (!clearPersistedWorker(request.worker_pid, { kind: "print_faces", id: job.id, executionId: request.id })) continue;
    // New identity fences callbacks and staging left by the interrupted attempt.
    request.id = randomBytes(16).toString("hex");
    request.status = "queued";
    delete request.worker_pid;
    delete request.started_at;
    saveMockup(job);
  }
}

/** Old clients get in-flight deduplication only; never overwrite root output files. */
export async function relightMockupStudio(id: string, viewer: Viewer, studioAdjustment?: unknown): Promise<RenderGenerationMutationEnqueueResult> {
  return withGenerationJobLock(id,() => {
    const job = readMockupFromDisk(id);
    if (!job) throw Object.assign(new Error("没有这单打样"),{status:404});
    assertCanManageMockup(job,viewer);
    const adjustment = canonicalizeStudioAdjustment(studioAdjustment ?? {});
    const inflight = job.render_mutation?.status === "queued" || job.render_mutation?.status === "running";
    if (!inflight && !generationAdaptersReady()) throw adaptersUnavailableError();
    const {live:source} = liveCurrentIdentity(job);
    if (inflight) {
      const request = job.render_generation_request;
      if (request?.mode === "legacy_relight" && request.source_generation_id === source
        && JSON.stringify(canonicalizeStudioAdjustment(request.studio_adjustment ?? {})) === JSON.stringify(adjustment)) {
        return publicMutationResult(job);
      }
      throw generationError("render_generation_busy","这单正在生成其他版本",409,"等当前动作结束","mutation_busy");
    }
    return admitRenderGenerationMutation({jobId:id,viewer,clientRequestId:`compat-${randomBytes(16).toString("hex")}`,
      mode:"legacy_relight",sourceGenerationId:source,expectedCurrentGenerationId:source,studioAdjustment:adjustment});
  });
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const MUTATION_ID_RE = /^m[a-f0-9]{16}$/;
/**
 * 每单最多保留的幂等事实（含在途）。覆盖成功/失败终态。
 * 满员 fail-closed：拒绝新 requestId，不 shift/驱逐旧记录，不扩建无界账本。
 * 已接受的 requestId 仍按原终态重放；同号异 payload 仍拒绝。
 */
export const RENDER_GENERATION_IDEMPOTENCY_LIMIT = 16 as const;
const ENQUEUE_INPUT_KEYS = new Set([
  "jobId",
  "viewer",
  "clientRequestId",
  "mode",
  "sourceGenerationId",
  "expectedCurrentGenerationId",
  "studioAdjustment",
]);
const generationCommitLocks = new Set<string>();

function generationError(code: string, message: string, status: number, fix: string, reason?: string): Error {
  const stableReason = reason ?? (code === "render_generation_stale" ? "current_changed"
    : code === "render_generation_busy" ? "mutation_busy"
    : code === "render_generation_unavailable" ? "runtime_quality_unwired"
    : status === 400 ? "payload_invalid" : "source_changed");
  return Object.assign(new Error(message), { status, code, problem: message, cause: code, fix, reason:stableReason });
}

function looksLikePath(value: string): boolean {
  return !value || isAbsolute(value) || /[\\/]/.test(value) || value.includes("..") || value.startsWith(".");
}

const SOURCE_OUTPUT_KEYS = ["white_a", "white_b", "glb"] as const;
const G0_IMPORT_PROFILE = "compat-legacy-v0";
const RENDER_PLAN_PROFILE_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function sha256Bytes(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function generationAdaptersReady(): boolean {
  if (getRenderGenerationRuntime()) return true;
  return (
    typeof hooks.qualityVerifier === "function"
    && (typeof hooks.prepareRenderGeneration === "function"
      || (typeof hooks.runRenderGeneration === "function" && typeof hooks.verifyRenderPlan === "function"))
  );
}

function adaptersUnavailableError(): Error {
  return generationError(
    "render_generation_unavailable",
    "渲染代际验证、执行或质量适配器尚未接线，不能排队",
    412,
    "缺真实 RF-02 验证适配器、staging 执行器和质量适配器时拒绝入队；不能用 JSON.parse、自报哈希或测试 hook 冒充生产完成",
    getRenderGenerationRuntime() ? "runtime_quality_unwired" : "production_registration_disabled",
  );
}

type FrozenStudioAdjustment = { product_light: number; background_light: number };
type FrozenRequestIdentity = {
  client_request_id: string;
  payload_sha256: string;
  mutation_id: string;
  mode: "legacy_relight" | "upgrade";
  source_generation_id: string;
  expected_current_generation_id: string;
  started_current_generation_id: string | null;
  studio_adjustment: FrozenStudioAdjustment | null;
  source_plan_sha256: string | null;
};
type FrozenVerifiedPlan = {
  identitySha256: string;
  bytes: Buffer;
  profile: string;
  verifier: string;
  sourcePath: string;
  sourceAssets?: RenderSourceOutputSnapshot[];
};
type ExecutionSnapshot = {
  mutationId: string;
  request: FrozenRequestIdentity;
  plan: FrozenVerifiedPlan;
  sourceOutputs: RenderSourceOutputSnapshot[];
  sourceGenerationId: string;
};

function freezeStudioAdjustment(
  value: { product_light: number; background_light: number } | undefined | null,
): FrozenStudioAdjustment | null {
  if (!value) return null;
  return { product_light: value.product_light, background_light: value.background_light };
}

function freezeRequestIdentity(request: RenderGenerationRequestRecord | undefined): FrozenRequestIdentity | null {
  if (
    !request
    || typeof request.client_request_id !== "string"
    || !request.client_request_id
    || typeof request.payload_sha256 !== "string"
    || !SHA256_HEX_RE.test(request.payload_sha256)
    || typeof request.mutation_id !== "string"
    || !request.mutation_id
    || (request.mode !== "legacy_relight" && request.mode !== "upgrade")
    || typeof request.source_generation_id !== "string"
    || !request.source_generation_id
    || typeof request.expected_current_generation_id !== "string"
    || !request.expected_current_generation_id
  ) {
    return null;
  }
  if (
    request.started_current_generation_id !== null
    && request.started_current_generation_id !== undefined
    && typeof request.started_current_generation_id !== "string"
  ) {
    return null;
  }
  let studio: FrozenStudioAdjustment | null = null;
  if (request.source_plan_sha256 !== undefined && !SHA256_HEX_RE.test(request.source_plan_sha256)) return null;
  if (request.worker_protocol && !request.source_plan_sha256) return null;
  if (request.studio_adjustment !== undefined && request.studio_adjustment !== null) {
    if (
      typeof request.studio_adjustment.product_light !== "number"
      || typeof request.studio_adjustment.background_light !== "number"
      || !Number.isFinite(request.studio_adjustment.product_light)
      || !Number.isFinite(request.studio_adjustment.background_light)
    ) {
      return null;
    }
    studio = freezeStudioAdjustment(request.studio_adjustment);
  }
  return {
    client_request_id: request.client_request_id,
    payload_sha256: request.payload_sha256,
    mutation_id: request.mutation_id,
    mode: request.mode,
    source_generation_id: request.source_generation_id,
    expected_current_generation_id: request.expected_current_generation_id,
    started_current_generation_id: request.started_current_generation_id ?? null,
    studio_adjustment: studio,
    source_plan_sha256: request.source_plan_sha256 ?? null,
  };
}

function requestIdentityEqual(a: FrozenRequestIdentity, b: FrozenRequestIdentity): boolean {
  const aLight = a.studio_adjustment;
  const bLight = b.studio_adjustment;
  return (
    a.client_request_id === b.client_request_id
    && a.payload_sha256 === b.payload_sha256
    && a.mutation_id === b.mutation_id
    && a.mode === b.mode
    && a.source_generation_id === b.source_generation_id
    && a.expected_current_generation_id === b.expected_current_generation_id
    && a.started_current_generation_id === b.started_current_generation_id
    && a.source_plan_sha256 === b.source_plan_sha256
    && Boolean(aLight) === Boolean(bLight)
    && aLight?.product_light === bLight?.product_light
    && aLight?.background_light === bLight?.background_light
  );
}

function acceptVerifiedPlan(job: MockupJob, mode: "legacy_relight" | "upgrade"): FrozenVerifiedPlan {
  const verifier = hooks.verifyRenderPlan;
  if (typeof verifier !== "function") throw adaptersUnavailableError();
  const raw = mockupRenderPlanBytes(job);
  if (!raw) {
    throw generationError(
      "render_generation_invalid",
      "缺少渲染合同，不能出新代",
      409,
      "需要磁盘上的 resolved_job，并由服务端验证适配器验收",
    );
  }
  let verified: VerifiedRenderPlanSnapshot;
  try {
    verified = verifier({
      jobId: job.id,
      jobRoot: mockupJobDir(job.id),
      mode,
      bytes: Buffer.from(raw.bytes),
      sourcePath: raw.path,
    });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code) throw err;
    throw generationError(
      "render_generation_invalid",
      "渲染合同未通过服务端验证",
      400,
      "不要把 JSON.parse 或自报哈希当作 RF-02 已验证",
    );
  }
  return checkVerifiedPlan(raw, verified);
}

function checkVerifiedPlan(raw: { bytes: Buffer; path: string }, verified: VerifiedRenderPlanSnapshot): FrozenVerifiedPlan {
  if (!verified || !Buffer.isBuffer(verified.bytes) || verified.bytes.length === 0) {
    throw generationError(
      "render_generation_invalid",
      "验证器没有返回合同字节",
      400,
      "验证适配器必须返回其验收的原始字节",
    );
  }
  if (!raw.bytes.equals(verified.bytes)) {
    throw generationError("render_generation_invalid", "验证器不得改写计划字节", 400, "只验收磁盘原件");
  }
  const hashed = sha256Bytes(raw.bytes);
  const claimed = typeof verified.identitySha256 === "string" ? verified.identitySha256.toLowerCase() : "";
  if (!SHA256_HEX_RE.test(claimed) || claimed !== hashed) {
    throw generationError("render_generation_invalid", "合同身份与字节不一致", 400, "不要自报哈希");
  }
  if (!verified.profile || !RENDER_PLAN_PROFILE_RE.test(verified.profile) || looksLikePath(verified.profile)) {
    throw generationError(
      "render_generation_invalid",
      "profile 必须来自受信验证结果",
      400,
      "不要使用客户端或硬编码冒充的 profile",
    );
  }
  if (!verified.verifier || typeof verified.verifier !== "string" || looksLikePath(verified.verifier)) {
    throw generationError(
      "render_generation_invalid",
      "验证器身份非法",
      400,
      "测试注入须具名；生产 RF-02 适配器未接线",
    );
  }
  return {
    identitySha256: hashed,
    bytes: Buffer.from(raw.bytes),
    profile: verified.profile,
    verifier: verified.verifier,
    sourcePath: raw.path,
    sourceAssets: verified.sourceAssets?.map(row => ({ ...row })),
  };
}

function snapshotSourceOutputs(job: MockupJob): RenderSourceOutputSnapshot[] {
  const rows: RenderSourceOutputSnapshot[] = [];
  for (const key of SOURCE_OUTPUT_KEYS) {
    const file = fileOf(job, key);
    if (!file?.path || !isMockupJobFile(job.id, file.path)) {
      throw generationError("render_generation_invalid", "缺少源代输出", 409, "源代至少要有两张产品 PNG 和 GLB");
    }
    const bytes = readFileSync(file.path);
    rows.push({
      key,
      path: file.path,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
    });
  }
  return rows;
}

function assertSourceOutputsFresh(job: MockupJob, snapshot: RenderSourceOutputSnapshot[]): void {
  for (const row of snapshot) {
    if (!isMockupJobFile(job.id, row.path)) {
      throw generationError("render_generation_invalid", "源代输出已变化，放弃本次提交", 409, "保留旧 current");
    }
    const diskBytes = readFileSync(row.path);
    if (sha256Bytes(diskBytes) !== row.sha256 || diskBytes.length !== row.bytes) {
      throw generationError("render_generation_invalid", "源代输出已变化，放弃本次提交", 409, "保留旧 current");
    }
    const live = fileOf(job, row.key);
    if (!live?.path || !isMockupJobFile(job.id, live.path)) {
      throw generationError("render_generation_invalid", "源代输出已变化，放弃本次提交", 409, "保留旧 current");
    }
    const liveBytes = live.path === row.path ? diskBytes : readFileSync(live.path);
    if (sha256Bytes(liveBytes) !== row.sha256) {
      throw generationError("render_generation_invalid", "源代输出已变化，放弃本次提交", 409, "保留旧 current");
    }
  }
}

function assertGenerationExecutable(
  job: MockupJob,
  mode: "legacy_relight" | "upgrade",
): { plan: FrozenVerifiedPlan; sourceOutputs: RenderSourceOutputSnapshot[] } {
  if (!generationAdaptersReady()) throw adaptersUnavailableError();
  return {
    plan: acceptVerifiedPlan(job, mode),
    sourceOutputs: snapshotSourceOutputs(job),
  };
}

function assertExecutionSnapshotFresh(job: MockupJob, snapshot: ExecutionSnapshot): void {
  if (job.status !== "done") {
    throw generationError("render_generation_invalid", "任务状态已变，放弃本次提交", 409, "保留旧 current");
  }
  const mutation = job.render_mutation;
  if (!mutation || mutation.id !== snapshot.mutationId || mutation.mode !== snapshot.request.mode) {
    throw generationError("render_generation_busy", "提交时 mutation 已变", 409, "保留旧 current");
  }
  if (mutation.status !== "running") {
    throw generationError("render_generation_invalid", "mutation 状态已变，放弃本次提交", 409, "保留旧 current");
  }
  const frozen = freezeRequestIdentity(job.render_generation_request);
  if (!frozen || frozen.mutation_id !== snapshot.mutationId || !requestIdentityEqual(frozen, snapshot.request)) {
    throw generationError(
      "render_generation_invalid",
      "请求身份已变，放弃本次提交",
      409,
      "保留旧 current，新代留作 orphan",
    );
  }
  const nowCurrent = job.current_render_generation_id || null;
  if (nowCurrent !== snapshot.request.started_current_generation_id) {
    throw generationError("render_generation_stale", "当前代已变化，放弃本次提交", 409, "保留旧 current，新代留作 orphan");
  }
  const raw = mockupRenderPlanBytes(job);
  const plan = snapshot.plan.sourceAssets
    ? (raw ? checkVerifiedPlan(raw, { ...snapshot.plan }) : null)
    : acceptVerifiedPlan(job, snapshot.request.mode);
  if (!plan) throw generationError("render_generation_invalid", "渲染计划缺失", 409, "保留当前代");
  if (plan.identitySha256 !== snapshot.plan.identitySha256 || plan.profile !== snapshot.plan.profile) {
    throw generationError(
      "render_generation_invalid",
      "渲染计划已变化，放弃本次提交",
      409,
      "保留旧 current，新代留作 orphan",
    );
  }
  if (!plan.bytes.equals(snapshot.plan.bytes)) {
    throw generationError(
      "render_generation_invalid",
      "渲染计划已变化，放弃本次提交",
      409,
      "保留旧 current，新代留作 orphan",
    );
  }
  assertSourceOutputsFresh(job, snapshot.sourceOutputs);
  if (snapshot.plan.sourceAssets) assertPlanAssetsFresh(job.id, snapshot.plan.sourceAssets);
}

function assertPlanAssetsFresh(id: string, rows: RenderSourceOutputSnapshot[]): void {
  const faces = ["front", "right", "back", "left", "top", "bottom"];
  if (!Array.isArray(rows) || rows.length !== 6 || faces.some(face => rows.filter(row => row.key === face).length !== 1)) {
    throw generationError("render_generation_invalid", "六面验证凭证缺失", 409, "重新验证源资产");
  }
  for (const row of rows) {
    if (!isMockupJobFile(id, row.path) || !SHA256_HEX_RE.test(row.sha256)) {
      throw generationError("render_generation_invalid", "六面验证凭证非法", 409, "保留当前代");
    }
    const st = lstatSync(row.path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size !== row.bytes
      || sha256Bytes(readFileSync(row.path)) !== row.sha256) {
      throw generationError("render_generation_stale", "六面资产已变化", 409, "重新验证源资产");
    }
  }
}

function bindExecutorResult(executed: RenderGenerationExecuteResult, snapshot: ExecutionSnapshot): void {
  if (
    !executed
    || executed.contract_sha256 !== snapshot.plan.identitySha256
    || executed.plan_identity_sha256 !== snapshot.plan.identitySha256
    || executed.source_generation_id !== snapshot.sourceGenerationId
    || !Array.isArray(executed.outputs)
  ) {
    throw generationError("render_generation_invalid", "执行器返回身份与快照不符", 400, "结果必须绑定已验证计划与源代");
  }
}

function cloneIdempotencyFacts(
  facts: RenderGenerationIdempotencyFact[] | undefined,
): RenderGenerationIdempotencyFact[] | undefined {
  if (!facts || !Array.isArray(facts)) return undefined;
  return facts.map((fact) => ({
    client_request_id: fact.client_request_id,
    payload_sha256: fact.payload_sha256,
    mutation: { ...fact.mutation },
  }));
}

function cloneMockup(job: MockupJob): MockupJob {
  return {
    ...job,
    files: (job.files || []).map((file) => ({ ...file })),
    render_mutation: job.render_mutation ? { ...job.render_mutation } : undefined,
    render_generation_request: job.render_generation_request
      ? {
          ...job.render_generation_request,
          studio_adjustment: job.render_generation_request.studio_adjustment
            ? { ...job.render_generation_request.studio_adjustment }
            : undefined,
        }
      : undefined,
    render_generation_idempotency: cloneIdempotencyFacts(job.render_generation_idempotency),
  };
}

function withGenerationJobLock<T>(id: string, fn: () => T): T {
  if (generationCommitLocks.has(id)) {
    throw generationError("render_generation_busy", "这单正在切换渲染代，请稍候", 409, "等当前提交结束后再试");
  }
  generationCommitLocks.add(id);
  try {
    return fn();
  } finally {
    generationCommitLocks.delete(id);
  }
}

function canonicalizeStudioAdjustment(
  value: unknown,
): { product_light: number; background_light: number } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw generationError("render_generation_invalid", "灯光调整非法", 400, "只传 product_light / background_light");
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== "product_light" && key !== "background_light") {
      throw generationError("render_generation_invalid", "不能指定内部渲染参数", 400, "不要传 profile、路径或输出文件名");
    }
  }
  const product = rec.product_light;
  const background = rec.background_light;
  if (product !== undefined && (typeof product !== "number" || !Number.isFinite(product))) {
    throw generationError("render_generation_invalid", "灯光调整非法", 400, "灯光必须是有限数字");
  }
  if (background !== undefined && (typeof background !== "number" || !Number.isFinite(background))) {
    throw generationError("render_generation_invalid", "灯光调整非法", 400, "灯光必须是有限数字");
  }
  return {
    product_light: product === undefined ? 1 : product,
    background_light: background === undefined ? 1 : background,
  };
}

function mutationPayloadSha(opts: {
  mode: "legacy_relight" | "upgrade";
  sourceGenerationId: string;
  studioAdjustment?: { product_light: number; background_light: number };
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: opts.mode,
        source_generation_id: opts.sourceGenerationId,
        studio_adjustment: opts.studioAdjustment || null,
      }),
    )
    .digest("hex");
}

function openJobGenerationStore(jobId: string, lifecycle?: import("./renderGenerationBudget.js").RenderLifecycle) {
  return openRenderGenerationStore({
    jobRoot: mockupJobDir(jobId),
    jobId,
    qualityVerifier: getRenderGenerationRuntime()?.archiveVerifier ?? hooks.qualityVerifier,
    lifecycle,
  });
}

function flushActivationAudit(job: MockupJob): boolean {
  if (!job.render_last_activation) return true;
  try {
    const store = openJobGenerationStore(job.id);
    if (store.hasActivation(job.render_last_activation)) return true;
    hooks.generationFailpoints?.beforeActivationAudit?.(job.id);
    store.appendActivation(job.render_last_activation);
    return true;
  } catch {
    console.warn(`jobs ${job.id}: problem=activation_audit cause=audit_pending fix=保留已提交 current，下一次写入前补记`);
    return false;
  }
}

function requireActivationAudit(job: MockupJob): void {
  if (!flushActivationAudit(job)) throw generationError("render_generation_busy","上次切换尚待记账",409,"先补记再切代","audit_pending");
  openJobGenerationStore(job.id).assertHistoryWritable();
}

function commitActivatedGeneration(next: MockupJob, fromId: string, actorId: string,
  mode: "activate" | "legacy_relight" | "upgrade", beforeCommit?: () => void): MockupJob {
  next.render_last_activation = {event_id:`a${randomBytes(16).toString("hex")}`,from_generation_id:fromId,
    generation_id:next.current_render_generation_id!,mode,at:nowIso(),actor_id:actorId};
  const committed = persistGenerationJob(next,beforeCommit);
  // The pointer has committed: audit failure must never enter the mutation failure/rollback path.
  flushActivationAudit(committed);
  return committed;
}

function legacyGenerationReadBusy(job: MockupJob): boolean {
  return job.status !== "done" || job.job_pid !== undefined || job.job_status === "running"
    || job.job_status === "queued" || relightStudioJobs.has(job.id) || printFaceRepairActive(job)
    || structureConfirmationActive(job.id);
}

/** HTTP read facade: no recovery, g0 creation, process probes or persistent writes. */
export function readRenderGenerationHistory(jobId: string, query: {cursor?: string; limit?: number} = {}) {
  const job = readMockupFromDisk(jobId);
  if (!job) throw Object.assign(new Error("没有这单打样"),{status:404});
  return openJobGenerationStore(jobId).listHistory({...query,currentGenerationId:job.current_render_generation_id ?? null});
}

export function openRenderGenerationFile(jobId: string, generationId: string, key: string) {
  const job = readMockupFromDisk(jobId);
  if (!job) throw Object.assign(new Error("没有这单打样"),{status:404});
  if (generationId.startsWith("legacy-current-")) {
    if (job.current_render_generation_id) throw generationError("render_generation_stale","当前代已变化",409,"刷新详情");
    if (legacyGenerationReadBusy(job)) throw generationError("render_generation_busy","旧图正在更新",409,"等原位出图结束");
  }
  return openJobGenerationStore(jobId).openFile(generationId,key);
}

/** Read-only availability/identity hint; authoritative RF-02 validation still runs at execution. */
function renderGenerationSourceAvailable(job: MockupJob): boolean {
  try {
    const raw = mockupRenderPlanBytes(job);
    if (!raw) return false;
    const plan: unknown = JSON.parse(raw.bytes.toString("utf8"));
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
    const assets = (plan as {assets?: unknown}).assets;
    if (!assets || typeof assets !== "object" || Array.isArray(assets)) return false;
    for (const face of ["front", "right", "back", "left", "top", "bottom"]) {
      const path = (assets as Record<string, unknown>)[face];
      if (typeof path !== "string" || !isAbsolute(path)
        || resolve(path) !== join(mockupJobDir(job.id), "assets", `panel_${face}.png`)) return false;
    }
    openJobGenerationStore(job.id).assertRerenderSourceFresh(job.current_render_generation_id);
    return true;
  } catch { return false; }
}

export function renderGenerationView(job: MockupJob, viewer: Viewer, canCreate: boolean) {
  const capability = (reason?: string) => reason ? {allowed:false,reason} : {allowed:true};
  let permission: string | undefined;
  try { if (!canCreate) throw new Error("read only"); assertCanManageMockup(job,viewer); }
  catch { permission = "permission_denied"; }
  const busy = job.render_generation_request?.worker_pid !== undefined ? "ownership_unconfirmed"
    : job.render_mutation?.status === "queued" || job.render_mutation?.status === "running"
      || legacyGenerationReadBusy(job) ? "mutation_busy" : undefined;
  let current = job.current_render_generation_id;
  let integrity: string | undefined;
  let historyCapacity: string | undefined;
  let auditPending: string | undefined;
  try {
    const store = openJobGenerationStore(job.id);
    try { if (job.render_last_activation && !store.hasActivation(job.render_last_activation)) auditPending = "audit_pending"; }
    catch { auditPending = "audit_pending"; }
    if (current) store.publicSummary(current,current);
    else if (!legacyGenerationReadBusy(job)) current = store.virtualLegacyCurrentId();
    else integrity = "mutation_busy";
    try { store.assertHistoryWritable(); } catch { historyCapacity = "history_capacity"; }
  } catch { integrity = "generation_corrupt"; }
  const registration = getRenderGenerationRuntime() ? undefined : "production_registration_disabled";
  const source = !permission && !busy && !auditPending && !registration && !integrity
    && !renderGenerationSourceAvailable(job) ? "source_changed" : undefined;
  const capacity = (job.render_generation_idempotency?.length ?? 0) >= RENDER_GENERATION_IDEMPOTENCY_LIMIT
    ? "idempotency_capacity" : undefined;
  return {
    current_render_generation_id:current,
    render_generation_capabilities: {
      history:capability(),
      activate:capability(permission || busy || auditPending || integrity || (!job.current_render_generation_id ? "generation_missing" : undefined) || historyCapacity),
      legacy_relight:capability(permission || busy || auditPending || registration || integrity || source || historyCapacity || capacity),
      upgrade:capability(permission || busy || "upgrade_unwired"),
    },
  };
}

function generationFailureMessage(err: unknown, fallback: string): string {
  if (isRenderGenerationError(err)) return err.problem;
  if (err && typeof err === "object" && "problem" in err && typeof (err as { problem: unknown }).problem === "string") {
    return (err as { problem: string }).problem;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function liveCurrentIdentity(job: MockupJob): { observed: string | null; live: string } {
  const observed = job.current_render_generation_id || null;
  if (observed) return { observed, live: observed };
  return { observed: null, live: openJobGenerationStore(job.id).virtualLegacyCurrentId() };
}

function assertSourceIsCurrent(sourceGenerationId: string, live: string, observed: string | null): void {
  if (sourceGenerationId === live) return;
  if (!observed) {
    throw generationError(
      "render_generation_stale",
      "源代已变化，请刷新后再试",
      409,
      "第一次变更只能引用当前虚拟代；排队后源被换掉则失败并保留旧图，不导入、不执行",
    );
  }
  throw generationError(
    "render_generation_invalid",
    "本切片只接受当前代作为源，不能排队历史源",
    409,
    "历史源尚未接线；入队即拒绝，不留假队列，也不能拿当前 files 冒充",
  );
}

function acceptedPayloadSha(frozen: FrozenRequestIdentity): string {
  return mutationPayloadSha({
    mode: frozen.mode,
    sourceGenerationId: frozen.source_generation_id,
    studioAdjustment: frozen.studio_adjustment || undefined,
  });
}

function wrapStoreIdentityError(err: unknown): never {
  if (isRenderGenerationError(err)) {
    throw generationError(err.code, err.problem, err.code === "render_generation_stale" ? 409 : 400, err.fix);
  }
  throw err;
}

/** 出队前从磁盘重核 expected current、source 与入队时已接受的身份。任何 g0/候选目录/执行器之前调用。 */
function assertAcceptedQueuedIdentity(job: MockupJob, mutationId: string): FrozenRequestIdentity {
  if (job.status !== "done") {
    throw generationError("render_generation_invalid", "任务状态已变，放弃本次排队", 409, "保留旧 current");
  }
  const mutation = job.render_mutation;
  if (!mutation || mutation.id !== mutationId) {
    throw generationError("render_generation_busy", "提交时 mutation 已变", 409, "保留旧 current");
  }
  if (mutation.status !== "queued" && mutation.status !== "running") {
    throw generationError("render_generation_invalid", "mutation 状态已变，放弃本次排队", 409, "保留旧 current");
  }
  const frozen = freezeRequestIdentity(job.render_generation_request);
  if (!frozen || frozen.mutation_id !== mutationId) {
    throw generationError("render_generation_invalid", "请求身份不完整，不能出新代", 409, "保留旧 current");
  }
  if (acceptedPayloadSha(frozen) !== frozen.payload_sha256) {
    throw generationError("render_generation_invalid", "请求身份已变，放弃本次排队", 409, "保留旧 current，不执行");
  }
  const fact = findIdempotencyFact(job, frozen.client_request_id);
  if (!fact || fact.payload_sha256 !== frozen.payload_sha256 || fact.mutation.id !== mutationId) {
    throw generationError("render_generation_invalid", "已接受的请求身份已变，放弃本次排队", 409, "保留旧 current，不执行");
  }
  let observed: string | null;
  let live: string;
  try {
    ({ observed, live } = liveCurrentIdentity(job));
  } catch (err) {
    wrapStoreIdentityError(err);
  }
  if (frozen.expected_current_generation_id !== live) {
    throw generationError(
      "render_generation_stale",
      "当前代已变化，放弃本次排队",
      409,
      "保留旧 current 与文件，不导入被换掉的源，不执行",
    );
  }
  if ((frozen.started_current_generation_id || null) !== observed) {
    throw generationError(
      "render_generation_stale",
      "当前代已变化，放弃本次排队",
      409,
      "保留旧 current 与文件，不导入被换掉的源，不执行",
    );
  }
  assertSourceIsCurrent(frozen.source_generation_id, live, observed);
  return frozen;
}

function jobHasGenerationArtifacts(job: MockupJob): boolean {
  if (job.current_render_generation_id || job.render_mutation || job.render_generation_request) return true;
  if (job.render_generation_idempotency && job.render_generation_idempotency.length > 0) return true;
  try {
    return existsSync(join(mockupJobDir(job.id), RENDER_GENERATION_DIR));
  } catch {
    return false;
  }
}

function findIdempotencyFact(job: MockupJob, clientRequestId: string): RenderGenerationIdempotencyFact | undefined {
  const facts = job.render_generation_idempotency || [];
  for (let i = facts.length - 1; i >= 0; i -= 1) {
    const fact = facts[i];
    if (fact && fact.client_request_id === clientRequestId) return fact;
  }
  const req = job.render_generation_request;
  if (!req || req.client_request_id !== clientRequestId) return undefined;
  const mutation =
    job.render_mutation && job.render_mutation.id === req.mutation_id
      ? job.render_mutation
      : { id: req.mutation_id, mode: req.mode, status: "failed" as const };
  return {
    client_request_id: req.client_request_id,
    payload_sha256: req.payload_sha256,
    mutation: { ...mutation },
  };
}

function idempotencyCapacityError(): Error {
  return generationError(
    "render_generation_invalid",
    "本单幂等账本已满，不能再接受新请求",
    409,
    "已接受的请求仍按原终态重放；满员后不能挤掉旧记录，也不扩建无界账本",
    "idempotency_capacity",
  );
}

function rememberIdempotencyFact(job: MockupJob, fact: RenderGenerationIdempotencyFact): void {
  const current = job.render_generation_idempotency || [];
  const exists = current.some((row) => row.client_request_id === fact.client_request_id);
  if (exists) {
    job.render_generation_idempotency = current.map((row) =>
      row.client_request_id === fact.client_request_id
        ? {
            client_request_id: fact.client_request_id,
            payload_sha256: fact.payload_sha256,
            mutation: { ...fact.mutation },
          }
        : row,
    );
    return;
  }
  if (current.length >= RENDER_GENERATION_IDEMPOTENCY_LIMIT) {
    throw idempotencyCapacityError();
  }
  job.render_generation_idempotency = [
    ...current,
    {
      client_request_id: fact.client_request_id,
      payload_sha256: fact.payload_sha256,
      mutation: { ...fact.mutation },
    },
  ];
}

function syncIdempotencyMutation(job: MockupJob): void {
  const req = job.render_generation_request;
  const mutation = job.render_mutation;
  if (!req || !mutation) return;
  rememberIdempotencyFact(job, {
    client_request_id: req.client_request_id,
    payload_sha256: req.payload_sha256,
    mutation,
  });
}

function publicMutationResultFromFact(
  job: MockupJob,
  fact: RenderGenerationIdempotencyFact,
): RenderGenerationMutationEnqueueResult {
  const mutation = publicRenderMutation({render_mutation:fact.mutation});
  if (!mutation) throw generationError("render_generation_invalid", "渲染代际记录无效", 409, "核验已有请求");
  return {
    mutation,
    current_render_generation_id: job.current_render_generation_id,
    has_render_generations: isGenerationManagedMockup(job),
    job_status: job.status,
  };
}

function publicMutationResult(job: MockupJob): RenderGenerationMutationEnqueueResult {
  const mutation = publicRenderMutation(job);
  if (!mutation) {
    throw generationError("render_generation_invalid", "没有渲染代际请求", 400, "重新提交服务端已公开的动作");
  }
  return {
    mutation,
    current_render_generation_id: job.current_render_generation_id,
    has_render_generations: isGenerationManagedMockup(job),
    job_status: job.status,
  };
}

function persistGenerationJob(next: MockupJob, checkpoint?: () => void): MockupJob {
  syncIdempotencyMutation(next);
  saveMockup(next, checkpoint);
  const saved = loadMockup(next.id);
  if (!saved) throw generationError("render_generation_invalid", "打样记录写完后读不到", 500, "检查任务目录后重试");
  return saved;
}

function failPersistedMutation(jobId: string, mutationId: string, message: string): void {
  const disk = readMockupFromDisk(jobId);
  if (!disk || disk.render_mutation?.id !== mutationId) return;
  if (disk.render_mutation.status === "succeeded" && disk.current_render_generation_id) return;
  const next = cloneMockup(disk);
  next.status = "done";
  next.job_status = "succeeded";
  next.render_mutation = {
    id: mutationId,
    mode: disk.render_mutation.mode,
    status: "failed",
    error: message,
  };
  try {
    persistGenerationJob(next);
  } catch (err) {
    console.error(
      `jobs ${jobId}: problem=generation_fail_persist cause=${err instanceof Error ? err.message : String(err)} fix=保留旧 current，不要切图`,
    );
  }
}

export function enqueueRenderGenerationMutation(
  input: RenderGenerationMutationEnqueueInput,
): RenderGenerationMutationEnqueueResult {
  return withGenerationJobLock(input?.jobId || "",() => admitRenderGenerationMutation(input));
}

function admitRenderGenerationMutation(input: RenderGenerationMutationEnqueueInput): RenderGenerationMutationEnqueueResult {
  if (!input || typeof input !== "object") {
    throw generationError("render_generation_invalid", "请求非法", 400, "只传服务端已公开的动作字段");
  }
  for (const key of Object.keys(input)) {
    if (!ENQUEUE_INPUT_KEYS.has(key)) {
      throw generationError("render_generation_invalid", "不能指定内部渲染参数", 400, "不要传 profile、路径或输出文件名");
    }
  }
  const jobId = String(input.jobId || "");
  const clientRequestId = String(input.clientRequestId || "");
  const sourceGenerationId = String(input.sourceGenerationId || "");
  const expectedCurrent = String(input.expectedCurrentGenerationId || "");
  const mode = input.mode;
  if (mode !== "legacy_relight" && mode !== "upgrade") {
    throw generationError("render_generation_invalid", "不支持的渲染动作", 400, "只用旧版重渲或升级新版");
  }
  if (!REQUEST_ID_RE.test(clientRequestId) || looksLikePath(clientRequestId)) {
    throw generationError("render_generation_invalid", "请求号非法", 400, "使用服务端可接受的 client_request_id");
  }
  if (looksLikePath(sourceGenerationId) || looksLikePath(expectedCurrent)) {
    throw generationError("render_generation_invalid", "代际 id 非法", 400, "只使用服务端公开的代际 id");
  }
  const studioAdjustment = canonicalizeStudioAdjustment(input.studioAdjustment);
  const job = loadMockup(jobId);
  if (!job) throw Object.assign(new Error("没有这单打样"), { status: 404 });
  assertCanManageMockup(job, input.viewer);
  if (job.status !== "done") {
    throw generationError("render_generation_invalid", "只有已出图的纸盒才能生成新代", 409, "等这单出图完成后再试");
  }
  const payloadSha = mutationPayloadSha({ mode, sourceGenerationId, studioAdjustment });
  {
    const disk = readMockupFromDisk(jobId);
    if (!disk) throw Object.assign(new Error("没有这单打样"), { status: 404 });
    assertCanManageMockup(disk,input.viewer);
    const replay = findIdempotencyFact(disk, clientRequestId);
    if (replay) {
      if (replay.payload_sha256 !== payloadSha) {
        throw generationError("render_generation_invalid", "同一请求号不能改内容", 409, "换新的 client_request_id 再提交","request_id_conflict");
      }
      return publicMutationResultFromFact(disk, replay);
    }
    if ((disk.render_generation_idempotency || []).length >= RENDER_GENERATION_IDEMPOTENCY_LIMIT) {
      throw idempotencyCapacityError();
    }
    if (disk.status !== "done") {
      throw generationError("render_generation_invalid", "只有已出图的纸盒才能生成新代", 409, "等这单出图完成后再试");
    }
    requireActivationAudit(disk);
    let observed: string | null;
    let live: string;
    try {
      ({ observed, live } = liveCurrentIdentity(disk));
    } catch (err) {
      wrapStoreIdentityError(err);
    }
    if (expectedCurrent !== live) {
      throw generationError("render_generation_stale", "当前代已变化，请刷新后再试", 409, "刷新详情后重新选择");
    }
    assertSourceIsCurrent(sourceGenerationId, live, observed);
    const inflight = disk.render_mutation?.status;
    if (inflight === "queued" || inflight === "running" || disk.render_generation_request?.worker_pid !== undefined || legacyGenerationReadBusy(disk)) {
      throw generationError("render_generation_busy", "这单正在生成或切换渲染代", 409, "等当前动作结束后再试",
        disk.render_generation_request?.worker_pid !== undefined ? "ownership_unconfirmed" : "mutation_busy");
    }
    let sourcePlanSha: string | undefined;
    if (input.mode === "upgrade") {
      throw generationError("render_generation_unavailable", "新版出图尚未接线", 412, "等待新版模式实施","upgrade_unwired");
    }
    if (getRenderGenerationRuntime()?.prepare || hooks.prepareRenderGeneration) {
      if (!generationAdaptersReady()) throw adaptersUnavailableError();
      const raw = mockupRenderPlanBytes(disk);
      if (!raw || !raw.bytes.length || raw.bytes.length > 8 * 1024 * 1024) {
        throw generationError("render_generation_invalid", "缺少有界渲染计划", 409, "重新打样");
      }
      sourcePlanSha = sha256Bytes(raw.bytes);
    } else {
      assertGenerationExecutable(disk, mode);
    }
    const mutationId = `m${randomBytes(8).toString("hex")}`;
    if (!MUTATION_ID_RE.test(mutationId)) {
      throw generationError("render_generation_invalid", "无法分配 mutation id", 500, "重试一次");
    }
    const request: RenderGenerationRequestRecord = {
      client_request_id: clientRequestId,
      payload_sha256: payloadSha,
      mutation_id: mutationId,
      mode,
      source_generation_id: sourceGenerationId,
      expected_current_generation_id: expectedCurrent,
      started_current_generation_id: observed,
      studio_adjustment: studioAdjustment,
      created_at: nowIso(),
      actor_id: input.viewer.id,
      worker_protocol: (getRenderGenerationRuntime()?.prepare || hooks.prepareRenderGeneration) ? "render-generation/1" : undefined,
      source_plan_sha256: sourcePlanSha,
    };
    const next = cloneMockup(disk);
    next.status = "done";
    next.job_status = "succeeded";
    next.render_generation_request = request;
    next.render_mutation = {
      id: mutationId,
      mode,
      status: "queued",
      stage: "排队出图",
    };
    persistGenerationJob(next);
    try {
      tryStart();
    } catch (err) {
      console.warn("generation tryStart failed:", err instanceof Error ? err.message : err);
    }
    const latest = loadMockup(jobId) || next;
    return publicMutationResult(latest);
  }
}

export function activateRenderGeneration(opts: {
  jobId: string;
  viewer: Viewer;
  generationId: string;
  expectedCurrentGenerationId: string;
}): MockupJob {
  const job = loadMockup(opts.jobId);
  if (!job) throw Object.assign(new Error("没有这单打样"), { status: 404 });
  assertCanManageMockup(job, opts.viewer);
  if (looksLikePath(opts.generationId) || looksLikePath(opts.expectedCurrentGenerationId)) {
    throw generationError("render_generation_invalid", "代际 id 非法", 400, "只使用服务端公开的代际 id");
  }
  return withGenerationJobLock(opts.jobId, () => {
    const disk = readMockupFromDisk(opts.jobId);
    if (!disk) throw Object.assign(new Error("没有这单打样"), { status: 404 });
    assertCanManageMockup(disk,opts.viewer);
    const inflight = disk.render_mutation?.status;
    if (inflight === "queued" || inflight === "running" || disk.render_generation_request?.worker_pid !== undefined || legacyGenerationReadBusy(disk)) {
      throw generationError("render_generation_busy", "这单正在生成或切换渲染代", 409, "等当前动作结束后再试",
        disk.render_generation_request?.worker_pid !== undefined ? "ownership_unconfirmed" : "mutation_busy");
    }
    if (!disk.current_render_generation_id) {
      throw generationError("render_generation_invalid", "还没有可激活的渲染代", 409, "等第一次生成提交后再切历史代");
    }
    const store = openJobGenerationStore(opts.jobId);
    let patch;
    try {
      patch = store.prepareActivationPatch({
        generationId: opts.generationId,
        observedCurrentGenerationId: disk.current_render_generation_id,
        expectedCurrentGenerationId: opts.expectedCurrentGenerationId,
      });
    } catch (err) {
      throw err;
    }
    if (opts.generationId === disk.current_render_generation_id) return disk;
    requireActivationAudit(disk);
    const next = applyRenderGenerationPatch(cloneMockup(disk), patch);
    next.status = "done";
    next.job_status = "succeeded";
    return commitActivatedGeneration(next,disk.current_render_generation_id,opts.viewer.id,"activate");
  });
}

function claimGenerationMutation(job: MockupJob): boolean {
  const disk = readMockupFromDisk(job.id) || job;
  if (disk.render_mutation?.status !== "queued" || disk.status !== "done") return true;
  if (!generationAdaptersReady()) return true;
  const mutationId = disk.render_mutation.id;
  try {
    assertAcceptedQueuedIdentity(disk, mutationId);
  } catch (err) {
    failPersistedMutation(
      disk.id,
      mutationId,
      generationFailureMessage(err, "当前代或源代已变化，放弃本次排队").slice(0, 80),
    );
    const latest = readMockupFromDisk(disk.id);
    return latest?.render_mutation?.status === "queued";
  }
  const next = cloneMockup(disk);
  next.status = "done";
  next.job_status = "succeeded";
  next.render_mutation = { ...disk.render_mutation, status: "running", stage: "导入原图" };
  persistGenerationJob(next);
  live.blender = job.id;
  void runGenerationMutation(job.id, mutationId);
  return true;
}

function candidateDirFor(jobId: string, mutationId: string): string {
  return join(mockupJobDir(jobId), RENDER_GENERATION_DIR, `.candidate-${mutationId}`);
}

function generationProcessObserver(jobId: string, mutationId: string): RenderBridgeObserver {
  return {
    context: { jobId, mutationId },
    onSpawn: (pid, executionId) => {
      const job = readMockupFromDisk(jobId);
      const request = job?.render_generation_request;
      if (!job || job.render_mutation?.status !== "running" || job.render_mutation.id !== mutationId
        || !request || request.mutation_id !== mutationId || request.worker_pid
        || !Number.isSafeInteger(pid) || pid <= 0 || !executionId.startsWith(`${jobId}:${mutationId}:`)
        || !/^[a-f0-9]{32}$/.test(executionId.slice(`${jobId}:${mutationId}:`.length))) {
        throw generationError("render_generation_stale", "执行身份已变", 409, "保留旧 current");
      }
      const next = cloneMockup(job);
      next.render_generation_request!.worker_pid = pid;
      next.render_generation_request!.worker_execution_id = executionId;
      next.render_generation_request!.worker_protocol = "render-generation/1";
      persistGenerationJob(next);
    },
    onClose: (pid, executionId) => {
      const job = readMockupFromDisk(jobId);
      const request = job?.render_generation_request;
      if (!job || !request || request.mutation_id !== mutationId
        || request.worker_pid !== pid || request.worker_execution_id !== executionId) return;
      const next = cloneMockup(job);
      delete next.render_generation_request!.worker_pid;
      delete next.render_generation_request!.worker_execution_id;
      persistGenerationJob(next);
    },
  };
}

async function prepareGenerationExecution(job: MockupJob, request: FrozenRequestIdentity) {
  const prepare = getRenderGenerationRuntime()?.prepare ?? hooks.prepareRenderGeneration;
  if (!prepare) return { ...assertGenerationExecutable(job, request.mode), execute: hooks.runRenderGeneration!, ownsCandidate: false };
  if (!generationAdaptersReady()) throw adaptersUnavailableError();
  const raw = mockupRenderPlanBytes(job);
  if (!raw) throw generationError("render_generation_invalid", "渲染计划缺失", 409, "重新验证");
  if (!request.source_plan_sha256 || sha256Bytes(raw.bytes) !== request.source_plan_sha256) {
    throw generationError("render_generation_stale", "排队期间渲染计划已变化", 409, "保留当前代，重新验证");
  }
  const sourceOutputs = snapshotSourceOutputs(job);
  const prepared = await prepare({ jobId: job.id, jobRoot: mockupJobDir(job.id), mode: request.mode,
    bytes: Buffer.from(raw.bytes), sourcePath: raw.path, mutationId: request.mutation_id,
    studioAdjustment: request.studio_adjustment ?? undefined,
    observer: generationProcessObserver(job.id, request.mutation_id) });
  try {
    const plan = checkVerifiedPlan(raw, prepared.plan);
    if (typeof prepared.execute !== "function" || !plan.sourceAssets) throw adaptersUnavailableError();
    assertPlanAssetsFresh(job.id, plan.sourceAssets);
    return { plan, sourceOutputs, execute: prepared.execute, ownsCandidate: true, lifecycle: prepared.lifecycle };
  } catch (error) {
    prepared.lifecycle?.release(!readMockupFromDisk(job.id)?.render_generation_request?.worker_pid);
    throw error;
  }
}

function mkdirCandidateExclusive(dir: string): void {
  try {
    if (lstatSync(dir)) {
      throw generationError("render_generation_invalid", "本次候选目录已存在", 409, "每个 mutation 独占新建候选目录");
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code !== "ENOENT") throw err;
  }
  mkdirSync(dir);
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw generationError("render_generation_invalid", "候选目录非法", 400, "不要用 symlink 当候选目录");
  }
}

function assertOutputInsideCandidate(candidateDir: string, jobRoot: string, path: string): string {
  const full = resolve(path);
  const candRel = relative(resolve(candidateDir), full);
  if (!candRel || candRel.startsWith("..") || isAbsolute(candRel)) {
    throw generationError("render_generation_invalid", "新输出必须写在本次候选目录内", 400, "不能把旧原位路径当安全适配器");
  }
  const jobRel = relative(resolve(jobRoot), full);
  if (!jobRel || jobRel.startsWith("..") || isAbsolute(jobRel)) {
    throw generationError("render_generation_invalid", "新输出越出任务目录", 400, "只使用任务目录内文件");
  }
  return full;
}

async function runGenerationMutation(id: string, mutationId: string): Promise<void> {
  let lifecycle: import("./renderGenerationBudget.js").RenderLifecycle | undefined;
  const release = (): void => {
    // A failed close-persistence callback must not silently free the shared slot.
    if (readMockupFromDisk(id)?.render_generation_request?.worker_pid) {
      lifecycle?.release(false);
      live.blender = id;
      return;
    }
    try { lifecycle?.release(true); }
    catch { console.warn(`jobs ${id}: problem=reservation_release cause=identity_unconfirmed fix=保留预留文件待核验，进程已确认退出`); }
    if (live.blender === id) live.blender = null;
    try {
      tryStart();
    } catch (err) {
      console.warn("generation release tryStart failed:", err instanceof Error ? err.message : err);
    }
  };
  try {
    const disk = readMockupFromDisk(id);
    const request = disk?.render_generation_request;
    if (!disk || disk.render_mutation?.id !== mutationId || !request || request.mutation_id !== mutationId) {
      release();
      return;
    }
    if (disk.status !== "done") {
      failPersistedMutation(id, mutationId, "任务状态已变，生成取消");
      release();
      return;
    }
    let frozenRequest: FrozenRequestIdentity;
    try {
      frozenRequest = assertAcceptedQueuedIdentity(disk, mutationId);
    } catch (err) {
      failPersistedMutation(
        id,
        mutationId,
        generationFailureMessage(err, "请求身份不完整，不能出新代").slice(0, 80),
      );
      release();
      return;
    }
    let executable;
    try {
      executable = await prepareGenerationExecution(disk, frozenRequest);
      lifecycle = "lifecycle" in executable ? executable.lifecycle : undefined;
      const latest = readMockupFromDisk(id);
      if (!latest) throw generationError("render_generation_stale", "任务已变化", 409, "保留旧 current");
      assertExecutionSnapshotFresh(latest, { mutationId, request: frozenRequest, plan: executable.plan,
        sourceOutputs: executable.sourceOutputs, sourceGenerationId: frozenRequest.source_generation_id });
    } catch (err) {
      failPersistedMutation(
        id,
        mutationId,
        generationFailureMessage(err, "渲染代际适配器尚未接线").slice(0, 80),
      );
      release();
      return;
    }
    const store = openJobGenerationStore(id, lifecycle);
    store.recoverOrphans();
    let sourceId = frozenRequest.source_generation_id;
    if (!disk.current_render_generation_id) {
      let g0Ready = false;
      try {
        store.publicSummary(G0_LEGACY_ORIGINAL_ID, null);
        g0Ready = true;
      } catch {
        g0Ready = false;
      }
      if (!g0Ready) {
        store.sealGeneration({
          mode: "legacy_import",
          contractSha256: executable.plan.identitySha256,
          contractBytes: executable.plan.bytes,
          profile: G0_IMPORT_PROFILE,
          observedCurrentGenerationId: null,
          expectedCurrentGenerationId: frozenRequest.expected_current_generation_id,
          actorLabel: disk.created_by || disk.owner,
        });
      }
      sourceId = G0_LEGACY_ORIGINAL_ID;
    }
    const snapshot: ExecutionSnapshot = {
      mutationId,
      request: frozenRequest,
      plan: executable.plan,
      sourceOutputs: executable.sourceOutputs,
      sourceGenerationId: sourceId,
    };
    const running = cloneMockup(readMockupFromDisk(id) || disk);
    if (running.render_mutation?.id !== mutationId) {
      release();
      return;
    }
    running.status = "done";
    running.job_status = "succeeded";
    running.render_mutation = { ...running.render_mutation, status: "running", stage: "出图" };
    persistGenerationJob(running);
    const jobRoot = mockupJobDir(id);
    const candidateDir = candidateDirFor(id, mutationId);
    if (!executable.ownsCandidate) mkdirCandidateExclusive(candidateDir);
    const executor = executable.execute;
    if (!executor) {
      failPersistedMutation(id, mutationId, "渲染代际执行器尚未接线");
      release();
      return;
    }
    const executeInput: RenderGenerationExecuteInput = {
      jobId: id,
      jobRoot,
      mutationId,
      mode: snapshot.request.mode,
      sourceGenerationId: snapshot.sourceGenerationId,
      candidateDir,
      plan: {
        identitySha256: snapshot.plan.identitySha256,
        bytes: Buffer.from(snapshot.plan.bytes),
        profile: snapshot.plan.profile,
        verifier: snapshot.plan.verifier,
      },
      sourceOutputs: snapshot.sourceOutputs.map((row) => ({ ...row })),
    };
    if (snapshot.request.studio_adjustment) {
      executeInput.studioAdjustment = { ...snapshot.request.studio_adjustment };
    }
    let executed: RenderGenerationExecuteResult;
    try {
      executed = await executor(executeInput);
    } catch (err) {
      failPersistedMutation(id, mutationId, err instanceof Error ? err.message.slice(0, 80) : "出图失败");
      release();
      return;
    }
    const still = readMockupFromDisk(id);
    if (!still || still.render_mutation?.id !== mutationId) {
      release();
      return;
    }
    try {
      assertExecutionSnapshotFresh(still, snapshot);
      bindExecutorResult(executed, snapshot);
      if (still.render_generation_request?.worker_pid || executed.runtimeQuality === "unwired") {
        throw generationError("render_generation_unavailable", "运行时质量门尚未接线", 412, "候选保留，不固化或切换 current");
      }
    } catch (err) {
      failPersistedMutation(id, mutationId, err instanceof Error ? err.message.slice(0, 80) : "执行快照已失效");
      release();
      return;
    }
    let sources: RenderGenerationSource[];
    try {
      sources = executed.outputs.map((row) => ({
        key: row.key,
        path: assertOutputInsideCandidate(candidateDir, jobRoot, row.path),
      }));
      if (!sources.some((row) => row.key === "white_a") || !sources.some((row) => row.key === "white_b") || !sources.some((row) => row.key === "glb")) {
        throw generationError("render_generation_invalid", "执行器缺少必需输出", 400, "至少写出两张产品 PNG 和 GLB");
      }
    } catch (err) {
      failPersistedMutation(id, mutationId, err instanceof Error ? err.message.slice(0, 80) : "输出非法");
      release();
      return;
    }
    let sealed;
    try {
      const sealingStore = executed.runtimeQuality === "verified"
        ? openRenderGenerationStore({jobRoot, jobId:id, lifecycle, qualityVerifier:executed.qualityVerifier}) : store;
      sealed = sealingStore.sealGeneration({
        mode: snapshot.request.mode,
        contractSha256: snapshot.plan.identitySha256,
        contractBytes: snapshot.plan.bytes,
        profile: snapshot.plan.profile,
        sources,
        observedCurrentGenerationId: snapshot.sourceGenerationId,
        expectedCurrentGenerationId: snapshot.sourceGenerationId,
        actorLabel: still.created_by || still.owner,
      });
    } catch (err) {
      const message = isRenderGenerationError(err) ? err.problem : err instanceof Error ? err.message : "固化失败";
      failPersistedMutation(id, mutationId, message.slice(0, 80));
      release();
      return;
    }
    try {
      hooks.generationFailpoints?.afterSealBeforePointer?.(id);
    } catch (err) {
      failPersistedMutation(id, mutationId, err instanceof Error ? err.message.slice(0, 80) : "提交前失败");
      release();
      return;
    }
    try {
      withGenerationJobLock(id, () => {
        const latest = readMockupFromDisk(id);
        if (!latest || latest.render_mutation?.id !== mutationId) {
          throw generationError("render_generation_busy", "提交时 mutation 已变", 409, "保留旧 current");
        }
        assertExecutionSnapshotFresh(latest, snapshot);
        requireActivationAudit(latest);
        const next = applyRenderGenerationPatch(cloneMockup(latest), sealed.prepareCommit());
        next.status = "done";
        next.job_status = "succeeded";
        next.render_mutation = {
          id: mutationId,
          mode: snapshot.request.mode,
          status: "succeeded",
          stage: "已提交",
        };
        lifecycle?.check("before_current");
        commitActivatedGeneration(next,snapshot.request.source_generation_id,
          latest.render_generation_request!.actor_id,snapshot.request.mode,lifecycle?.check);
      });
    } catch (err) {
      failPersistedMutation(id, mutationId, err instanceof Error ? err.message.slice(0, 80) : "提交失败");
    }
  } catch (err) {
    const message = isRenderGenerationError(err)
      ? err.problem
      : err instanceof Error
        ? err.message
        : "生成失败";
    failPersistedMutation(id, mutationId, message.slice(0, 80));
    console.error(
      `jobs ${id}: problem=generation_mutation cause=${isRenderGenerationError(err) ? err.cause : message} fix=保留旧 current，不切图`,
    );
  } finally {
    release();
  }
}

/**
 * 终态 failed 不能代替进程退出。running + 仍待核验的 worker_pid 占住共享 Blender 槽，
 * 直到 confirmGenerationWorkerSlotReleased 确认安全。tryStart 不得在此时领其他 Blender 工作。
 */
function occupyUnconfirmedGenerationBlenderFence(): void {
  if (live.blender) return;
  for (const job of loadAllMockups()) {
    const pid = job.render_generation_request?.worker_pid;
    if (
      job.status === "done" &&
      job.render_mutation &&
      typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      pid > 0
    ) {
      live.blender = job.id;
      return;
    }
  }
}

/**
 * 与 clearPersistedWorker 相同的 inspect → 仅 owned 才 kill → 再 inspect。
 * 旧协议 missing / other 沿用原恢复语义；新协议还必须确认独立组消失。
 * unknown：不 kill，不能当已退出。owned 终止失败或杀完仍 owned/unknown：保留围栏。
 */
function confirmGenerationWorkerSlotReleased(pid: number, expected: WorkerProcessIdentity): boolean {
  const inspect = hooks.inspectWorker || inspectWorkerProcess;
  const probe = (): WorkerProcessState => {
    try {
      return inspect(pid, expected);
    } catch {
      return "unknown";
    }
  };
  const groupReleased = (): boolean => {
    if (expected.kind !== "render_generation") return true;
    try { return (hooks.inspectGenerationGroup || inspectRenderGenerationGroup)(pid) === "missing"; }
    catch { return false; }
  };
  const before = probe();
  if (expected.kind === "render_generation" && expected.container === "windows-job-object/1") {
    // Never kill the persisted PID, including a still-owned supervisor: after
    // Node restart its control pipe EOF/own deadline stops it. Keep the fence
    // until it cannot create a new container AND the exact job is empty/gone.
    if (before !== "missing" && before !== "other") return false;
    try {
      return (hooks.recoverWindowsGeneration || recoverWindowsRenderGeneration)(expected.executionId,
        { pythonExecutable:PYTHON, packagingDir:PACKAGING, cancel:true }) === "missing";
    } catch { return false; }
  }
  if (before === "missing" || before === "other") {
    if (before === "other") {
      console.warn(
        `jobs ${expected.id}: problem=generation_worker cause=pid_reused_other fix=不杀无关进程，新协议仍须确认进程组消失`,
      );
    }
    return groupReleased();
  }
  if (before !== "owned") {
    console.warn(
      `jobs ${expected.id}: problem=generation_worker cause=${before} fix=不杀不明进程，保留共享槽围栏，不把失败当退出`,
    );
    return false;
  }
  try {
    if (expected.kind === "render_generation") {
      (hooks.killGenerationGroup || signalRenderGenerationGroup)(pid, true);
    } else {
      (hooks.killTree || killTree)(pid, true);
    }
  } catch {
    console.warn(
      `jobs ${expected.id}: problem=generation_worker cause=owned_pid_kill_failed fix=不盲重跑，保留共享槽围栏`,
    );
    return false;
  }
  const after = probe();
  if (after === "missing" || after === "other") return groupReleased();
  console.warn(
    `jobs ${expected.id}: problem=generation_worker cause=${after} fix=终止后仍无法确认退出，保留共享槽围栏`,
  );
  return false;
}

function recoverInterruptedMutation(job: MockupJob): void {
  const mutation = job.render_mutation;
  if (!mutation || (mutation.status !== "queued" && mutation.status !== "running"
    && !job.render_generation_request?.worker_pid)) return;
  if (mutation.status === "queued" && !job.render_generation_request?.worker_pid) {
    if (!generationAdaptersReady()) {
      failPersistedMutation(job.id, mutation.id, "渲染代际执行器尚未接线，不能保留假排队");
    }
    return;
  }
  const pid = job.render_generation_request?.worker_pid;
  if (!pid) {
    failPersistedMutation(job.id, mutation.id, "生成中断");
    return;
  }
  const executionId = job.render_generation_request?.worker_execution_id;
  if (job.render_generation_request?.worker_protocol !== undefined
    && (!["render-generation/1", "windows-job-object/1"].includes(job.render_generation_request.worker_protocol) || !executionId)) {
    live.blender = job.id;
    return;
  }
  if (executionId !== undefined && (typeof executionId !== "string"
    || !executionId.startsWith(`${job.id}:${mutation.id}:`)
    || !/^[a-f0-9]{32}$/.test(executionId.slice(`${job.id}:${mutation.id}:`.length)))) {
    live.blender = job.id;
    return; // Corrupt ownership evidence is unknown, never proof of an unrelated/gone worker.
  }
  const expected: WorkerProcessIdentity = executionId
    ? { kind: "render_generation", id: job.id, mutationId: mutation.id, executionId,
      container: job.render_generation_request?.worker_protocol === "windows-job-object/1" ? "windows-job-object/1" : undefined }
    : { kind: "mockup", id: job.id };
  if (!confirmGenerationWorkerSlotReleased(pid, expected)) {
    live.blender = job.id;
    return;
  }
  const next = cloneMockup(job);
  delete next.render_generation_request!.worker_pid;
  delete next.render_generation_request!.worker_execution_id;
  persistGenerationJob(next);
  failPersistedMutation(job.id, mutation.id, "生成中断");
}

function recoverRenderGenerationsOnBoot(): void {
  for (const job of loadAllMockups()) {
    if (!jobHasGenerationArtifacts(job)) continue;
    try {
      const store = openJobGenerationStore(job.id);
      store.recoverOrphans();
      flushActivationAudit(job);
    } catch (err) {
      console.error(
        `jobs ${job.id}: problem=generation_recover cause=${isRenderGenerationError(err) ? err.cause : err instanceof Error ? err.message : String(err)} fix=只补索引，不自动激活`,
      );
    }
    recoverInterruptedMutation(job);
    // The prior routine either confirmed all owned processes gone or retained
    // worker_pid. Never release credit from a mere failed mutation status.
    const recovered = readMockupFromDisk(job.id);
    if (recovered?.render_mutation && !recovered.render_generation_request?.worker_pid) {
      try { releaseRenderReservation(join(mockupJobDir(job.id), RENDER_GENERATION_DIR), recovered.render_mutation.id); }
      catch { console.warn(`jobs ${job.id}: problem=reservation_recovery cause=identity_unconfirmed fix=保留预留文件待核验`); }
    }
  }
}

export function reclaimOnBoot(): void {
  live.ocr = null;
  live.blender = null;
  live.illustrator = null;
  for (const task of loadTasksForRecovery()) reclaimTask(task);
  for (const job of loadAllMockups()) reclaimMockup(job);
  recoverPrintFaceRepairsOnBoot();
  recoverRenderGenerationsOnBoot();
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
  ensureIllustratorBusyPoll();
}

function illustratorSlotBusy(): boolean {
  const status = readIllustratorAgentStatus();
  return status.required === true && status.ready === true && status.state === "busy";
}

let illustratorBusyPoll: ReturnType<typeof setInterval> | undefined;
let illustratorBusyPollWasBusy = false;

function ensureIllustratorBusyPoll(): void {
  if (illustratorBusyPoll || process.env.VITEST === "1") return;
  illustratorBusyPoll = setInterval(() => {
    try {
      const busy = illustratorSlotBusy();
      if (illustratorBusyPollWasBusy && !busy && !live.illustrator) {
        for (const job of loadAllMockups()) {
          if (
            (job.job_status === "running" || job.job_status === "queued") &&
            needsIllustrator(job)
          ) {
            reclaimMockup(job);
          }
        }
        tryStart();
      }
      illustratorBusyPollWasBusy = busy;
    } catch {
      /* next tick */
    }
  }, 5_000);
}

export function tryStart(): void {
  if (!live.ocr) {
    const next = oldestOcrQueued();
    if (next) claimOcr(next);
  }
  if (!live.illustrator && !illustratorSlotBusy()) {
    const next = oldestAiQueued();
    if (next) claimAi(next);
  }
  if (!live.blender) {
    const interrupted = loadAllMockups().find(job => job.print_faces_request?.status === "running");
    if (interrupted) live.blender = interrupted.id;
  }
  if (!live.blender) occupyUnconfirmedGenerationBlenderFence();
  if (!live.blender) {
    for (;;) {
      if (live.blender) break;
      const next = oldestBlenderWaiter();
      if (!next) break;
      if (next.kind === "generation") {
        if (claimGenerationMutation(next.job) || live.blender) break;
        continue;
      }
      if (next.kind === "print_faces") claimPrintFaceRepair(next.job);
      else claimMockup(next.job);
      break;
    }
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

type BlenderWaiter = { kind: "pipeline" | "generation" | "print_faces"; job: MockupJob; at: string };

function oldestBlenderWaiter(): BlenderWaiter | undefined {
  const waiters: BlenderWaiter[] = [];
  const pipeline = oldestMockupQueued();
  if (pipeline) waiters.push({ kind: "pipeline", job: pipeline, at: pipeline.created_at });
  if (generationAdaptersReady()) {
    for (const job of loadAllMockups()) {
      if (job.status === "done" && job.render_mutation?.status === "queued") {
        waiters.push({
          kind: "generation",
          job,
          at: job.render_generation_request?.created_at || job.created_at,
        });
      }
    }
  }
  for (const job of loadAllMockups()) {
    if (job.status === "done" && job.print_faces_request?.status === "queued") {
      waiters.push({ kind: "print_faces", job, at: job.print_faces_request.created_at });
    }
  }
  waiters.sort((a, b) => a.at.localeCompare(b.at) || a.job.id.localeCompare(b.job.id));
  return waiters[0];
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
  if (structure) delete job.job_eta_s;
  else job.job_eta_s = 60;
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
        if (!match) return;
        const stage = match[1];
        const label = STAGE_LABEL[stage];
        if (!label) return;
        const current = loadMockup(id);
        if (!current || current.job_started_at !== startedAt) return;
        current.job_stage = stage;
        current.job_stage_label = label;
        if (stage.startsWith("illustrator_")) delete current.job_eta_s;
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
  const next = finishStructure(id, startedAt, result);
  if (next === "auto-confirm") await autoConfirmStructure(id, startedAt);
}

function finishStructure(id: string, startedAt: string, result: RunPythonResult): "auto-confirm" | "continue" {
  const job = loadMockup(id);
  if (!job || job.job_started_at !== startedAt) {
    tryStart();
    return "continue";
  }
  if (live.illustrator === id) live.illustrator = null;
  delete job.job_pid;
  job.job_finished_at = nowIso();
  if (result.timedOut) {
    markMockupFailed(job, "这一单结构识别超时，请稍后重试");
    return "continue";
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
      return "continue";
    }
    job.structure_status = control.structure_status;
    job.structure_code = String(control.code || "structure_review_required");
    job.structure_message = String(control.message || "包装结构需要人工确认。");
    job.structure_resolution_path = control.resolution_path;
    job.structure_sidecar_path = control.details?.structure_sidecar || undefined;
    job.structure_artwork_path = control.details?.artwork_pdf || undefined;
    job.structure_artwork_preview_path = control.details?.artwork_preview || undefined;
    job.structure_source_sha256 = control.details?.source_sha256 || undefined;
    job.job_error = undefined;
    delete job.job_finished_at;
    if (
      control.structure_status === "review_required"
      && job.structure_code === "structure_face_mapping_incomplete"
      && uniqueConfirmableAnchor(job)
    ) {
      job.status = "queued";
      job.job_status = "running";
      job.job_stage = "structure";
      job.job_stage_label = STAGE_LABEL.structure;
      saveMockup(job);
      live.illustrator = id;
      return "auto-confirm";
    }
    job.status = control.structure_status;
    job.job_status = "waiting_input";
    saveMockup(job);
    tryStart();
    return "continue";
  }
  if (result.code !== 0) {
    const failure = cliFailure(result.stderr);
    logCliFailure(`mockup ${job.id} structure`, failure);
    markMockupFailed(job, publicJobError(failure.error) || "结构识别中断");
    return "continue";
  }
  const payload = lastJson(result.stdout);
  const nextManifest = preparedManifest(payload);
  if (!isMockupJobFile(job.id, nextManifest)) {
    markMockupFailed(job, "结构识别没有返回可继续的作业清单");
    return "continue";
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
  return "continue";
}

async function autoConfirmStructure(id: string, startedAt: string): Promise<void> {
  const job = loadMockup(id);
  if (!job || job.job_started_at !== startedAt) {
    tryStart();
    return;
  }
  const anchor = uniqueConfirmableAnchor(job);
  if (!anchor) {
    tryStart();
    return;
  }
  try {
    beginStructureConfirmation(job);
  } catch {
    tryStart();
    return;
  }
  try {
    const files = prepareStructureConfirmation(job, { anchor });
    const confirm = hooks.confirmStructure || confirmPackagingStructure;
    const result = await confirm(files);
    const output = lastJson(result.stdout);
    const fresh = loadMockup(id);
    if (!fresh || fresh.job_started_at !== startedAt) {
      return;
    }
    if (
      result.timedOut
      || result.code !== 0
      || output?.ok !== true
      || typeof output.sidecar !== "string"
      || fresh.structure_status !== "review_required"
    ) {
      console.warn("auto confirm packaging structure skipped", {
        problem: "唯一可确认正面没有写成已批准结构",
        cause: typeof output?.code === "string" ? output.code : `worker_exit_${result.code}`,
        fix: "保留待选正面，由已登录账号点品名面",
      });
      holdUniqueFront(id, startedAt);
      return;
    }
    acceptStructureConfirmation(fresh, output.sidecar);
    stampAutoConfirmed(fresh, anchor);
  } catch (error) {
    console.warn("auto confirm packaging structure failed", {
      problem: "唯一可确认正面自动确认抛错",
      cause: error instanceof Error ? error.message : String(error),
      fix: "保留待选正面",
    });
    holdUniqueFront(id, startedAt);
  } finally {
    finishStructureConfirmation(id);
    if (live.illustrator === id) live.illustrator = null;
    try {
      tryStart();
    } catch (error) {
      console.warn("auto confirm packaging structure enqueue failed", {
        problem: "唯一正面已确认但没有排进 Blender",
        cause: error instanceof Error ? error.message : String(error),
        fix: "保留 queued，等下一单或开机回收再出图",
      });
    }
  }
}

function holdUniqueFront(id: string, startedAt: string): void {
  const job = loadMockup(id);
  if (!job || job.job_started_at !== startedAt || job.structure_status !== "review_required") return;
  job.status = "review_required";
  job.job_status = "waiting_input";
  job.job_stage = undefined;
  job.job_stage_label = undefined;
  job.job_eta_s = undefined;
  saveMockup(job);
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
  if (isGenerationManagedMockup(job)) {
    markMockupFailed(job, "已托管代际输出，不能用旧出图覆盖");
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
  if (illustratorSlotBusy() && (job.job_status === "running" || job.job_status === "queued") && needsIllustrator(job)) {
    return;
  }
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
