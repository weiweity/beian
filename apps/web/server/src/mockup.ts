import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DATA_DIR, PACKAGING } from "./config.js";
import { blenderBin } from "./settings.js";
import { canAccessOwner, isTid, replaceFile, type Viewer } from "./tasks.js";

export type MockupJob = {
  id: string;
  status: "queued" | "running" | "review_required" | "unsupported" | "done" | "failed";
  title?: string;
  error?: string;
  created_at: string;
  files: { key: string; path?: string; name: string }[];
  owner?: string;
  created_by?: string;
  source_path?: string;
  /** 仅服务端用于开始接口幂等恢复，不返回前端。 */
  source_receipt?: string;
  manifest_path?: string;
  job_kind?: "mockup";
  job_status?: "queued" | "running" | "waiting_input" | "succeeded" | "failed";
  job_stage?: string;
  job_stage_label?: string;
  job_eta_s?: number;
  job_error?: string;
  job_started_at?: string;
  job_finished_at?: string;
  job_pid?: number;
  notify_job_id?: string;
  notify_sent?: boolean;
  reclaim_count?: number;
  raster_png?: string;
  structure_engine?: "v2";
  structure_status?: "analyzing" | "review_required" | "unsupported" | "ready";
  structure_code?: string;
  structure_message?: string;
  /** 服务端恢复/确认结构使用，不返回前端。 */
  structure_resolution_path?: string;
  structure_sidecar_path?: string;
  structure_artwork_path?: string;
  structure_artwork_preview_path?: string;
  structure_source_sha256?: string;
  /** 服务端保留首次盘点结果，便于失败后重选；公开响应会去掉源稿哈希。 */
  structure_input_candidates?: StructureInputCandidates;
  /** 仅保存当前候选 ID，不接受图层名或客户端自造语义。 */
  structure_input_selection_ids?: string[];
  /** 首次选层前的原稿预览；重跑会隐藏所选结构线，不能覆盖这份核对依据。 */
  structure_input_preview_path?: string;
};

export type StructureInputLayerCandidate = {
  id: string;
  name: string;
  stroke_only_path_count: number;
};

type StructureInputPreviewPoint = [number, number, number, number, number, number];

export type StructureInputPreview = {
  schema: "illustrator-layer-preview/1";
  page_size_points: [number, number];
  layers: Array<{
    candidate_id: string;
    paths: Array<{ closed: boolean; points: StructureInputPreviewPoint[] }>;
    truncated: boolean;
  }>;
};

type StructureInputPreviewPlate = {
  id: string;
  name: string;
};

type StructureInputCandidates = {
  schema: "packaging-structure-input-candidates/2";
  source_sha256: string;
  proposal_layers: StructureInputLayerCandidate[];
  truncated: boolean;
  preview_plates?: StructureInputPreviewPlate[];
  preview?: StructureInputPreview;
};

export type StructurePreviewFace = {
  id: string;
  bounds_mm: [number, number, number, number];
  centroid_mm: [number, number];
  size_mm?: [number, number];
  points_mm?: Array<[number, number]>;
  rectangular: boolean;
};

export type StructureNetProposal = {
  schema: "box-net-proposal/3";
  id: string;
  face_ids: string[];
  body_face_ids: [string, string, string, string];
  cap_face_ids: [string, string];
  strip_axis: "x" | "y";
  bounds_mm?: [number, number, number, number];
  dimensions_mm?: { width: number; depth: number; height: number };
  valid_anchors?: Array<{
    front_face_id: string;
    quarter_turns: Array<0 | 1 | 2 | 3>;
    preferred_quarter_turns?: 0 | 1 | 2 | 3;
  }>;
  closure_assemblies: Array<{
    primary_face_id: string;
    side: -1 | 1;
    extent: "full" | "partial";
    closure_kind: "full" | "clearance" | "assembly";
    coverage_ratio: number;
    members: Array<{
      face_id: string;
      attached_body_face_id: string;
      extent: "full" | "partial";
      coverage_ratio: number;
    }>;
  }>;
};

export type StructureAnchorDecision = {
  proposal_id: string;
  front_face_id: string;
  quarter_turns: 0 | 1 | 2 | 3;
};

export type StructureConfirmationDecision = { anchor: StructureAnchorDecision };

const BOX_NET_PROPOSAL_SCHEMA = "box-net-proposal/3";
const STRUCTURE_INPUT_CANDIDATES_SCHEMA = "packaging-structure-input-candidates/2";
const STRUCTURE_INPUT_PREVIEW_SCHEMA = "illustrator-layer-preview/1";
const MAX_STRUCTURE_INPUT_CANDIDATES = 128;
const MAX_STRUCTURE_INPUT_SELECTIONS = 16;
const MAX_STRUCTURE_INPUT_PREVIEW_PATHS = 5_000;
const MAX_STRUCTURE_INPUT_PREVIEW_POINTS = 20_000;
const MAX_STRUCTURE_INPUT_PREVIEW_PATHS_PER_LAYER = 512;
const MAX_STRUCTURE_INPUT_PREVIEW_POINTS_PER_PATH = 256;
const MAX_STRUCTURE_INPUT_PREVIEW_RAW_LAYERS = MAX_STRUCTURE_INPUT_CANDIDATES * 2;
const MAX_STRUCTURE_RESOLUTION_BYTES = 25 * 1024 * 1024;
const MIN_ASSEMBLY_MEMBER_RATIO = 0.45;
const MAX_ASSEMBLY_MEMBER_RATIO = 0.55;
const MIN_ASSEMBLY_UNION_RATIO = 0.94;
const MAX_ASSEMBLY_MEMBER_SUM_RATIO = 1.02;

export function isStructureProposalId(value: string): boolean {
  return /^box-net-(?:\d{4}|[0-9a-f]{16})$/.test(value);
}

const STRUCTURE_CONFIRMATION_UNPROCESSABLE = new Set([
  "artwork_transform_invalid",
  "structure_confirmation_invalid",
  "structure_dimensions_ambiguous",
  "structure_face_dimensions_mismatch",
  "structure_face_mapping_incomplete",
  "structure_face_not_rectangular",
  "structure_fold_graph_invalid",
]);

export function structureConfirmationFailureStatus(code: string): 409 | 422 | 500 {
  if (code === "structure_confirmation_stale" || code === "structure_source_mismatch") return 409;
  if (STRUCTURE_CONFIRMATION_UNPROCESSABLE.has(code)) return 422;
  return 500;
}

const cache = new Map<string, MockupJob>();
const activeStructureConfirmations = new Set<string>();
export const MAX_MOCKUP_CACHE_ITEMS = 256;

function rememberMockup(job: MockupJob): void {
  cache.delete(job.id);
  cache.set(job.id, job);
  while (cache.size > MAX_MOCKUP_CACHE_ITEMS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function mockupCacheSize(): number {
  return cache.size;
}

export function resetMockupCache(): void {
  cache.clear();
  activeStructureConfirmations.clear();
}

export function beginStructureConfirmation(job: MockupJob): void {
  if (activeStructureConfirmations.has(job.id)) {
    throw Object.assign(new Error("这单结构正在确认，请稍候"), { status: 409 });
  }
  activeStructureConfirmations.add(job.id);
}

export function finishStructureConfirmation(jobId: string): void {
  activeStructureConfirmations.delete(jobId);
}

function mockupRoot(create = true) {
  const d = join(DATA_DIR, "mockups");
  if (create) mkdirSync(d, { recursive: true });
  return d;
}

function jobPath(id: string, create = true) {
  return join(mockupRoot(create), id, "job.json");
}

export function findBlender(): string | null {
  const env = blenderBin() || process.env.BLENDER_EXECUTABLE;
  if (env && existsSync(env)) return env;
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(finder, ["blender"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

export function saveMockup(job: MockupJob): void {
  const dir = join(mockupRoot(), job.id);
  mkdirSync(dir, { recursive: true });
  replaceFile(jobPath(job.id), JSON.stringify(job, null, 2));
  rememberMockup(job);
}

export function loadMockup(id: string): MockupJob | undefined {
  if (!isTid(id)) return undefined;
  const p = jobPath(id, false);
  if (!existsSync(p)) {
    cache.delete(id);
    return undefined;
  }
  const hit = cache.get(id);
  if (hit) {
    rememberMockup(hit);
    return hit;
  }
  try {
    const job = JSON.parse(readFileSync(p, "utf8")) as MockupJob;
    rememberMockup(job);
    return job;
  } catch {
    cache.delete(id);
    return undefined;
  }
}

export function getJob(id: string): MockupJob | undefined {
  return loadMockup(id);
}

export function mockupOwner(job: MockupJob): string {
  return String(job.owner || "");
}

/** 写操作仍服从对象所有权；团队共享读取不经过这里。 */
export function assertCanManageMockup(job: MockupJob, viewer: Viewer): void {
  if (!canAccessOwner(mockupOwner(job), viewer)) {
    throw Object.assign(new Error("没有权限"), { status: 403 });
  }
}

/** 回执属于具体账号；管理员权限也不能跨账号命中别人的幂等键。 */
export function findMockupBySourceReceipt(receiptId: string, owner: string): MockupJob | undefined {
  if (!isTid(receiptId) || !owner) return undefined;
  return loadAllMockups().find(
    (job) => job.source_receipt === receiptId && mockupOwner(job) === owner,
  );
}

export function loadAllMockups(): MockupJob[] {
  return mockupStoreSnapshot().jobs;
}

const MOCKUP_STATUSES = new Set(["queued", "running", "review_required", "unsupported", "done", "failed"]);
const MOCKUP_JOB_STATUSES = new Set(["queued", "running", "waiting_input", "succeeded", "failed"]);

/** Keep corrupt or contradictory durable state out of release counters. */
function hasValidMockupJobState(job: MockupJob): boolean {
  if (!MOCKUP_STATUSES.has(job.status)) return false;
  const hasKind = job.job_kind !== undefined;
  const hasJobStatus = job.job_status !== undefined;
  const hasPid = job.job_pid !== undefined;
  if (hasKind !== hasJobStatus) return false;
  if (!hasKind) return !hasPid && (job.status === "done" || job.status === "failed");
  if (job.job_kind !== "mockup" || !MOCKUP_JOB_STATUSES.has(String(job.job_status))) return false;
  if (hasPid && (!Number.isSafeInteger(job.job_pid) || Number(job.job_pid) <= 0 || job.job_status !== "running")) {
    return false;
  }
  if (job.job_status === "queued") return job.status === "queued";
  if (job.job_status === "running") return job.status === "running";
  if (job.job_status === "waiting_input") {
    return job.status === "review_required" || job.status === "unsupported";
  }
  if (job.job_status === "succeeded") return job.status === "done";
  return job.status === "failed";
}

/**
 * 发版闸门必须直接核对磁盘，不能让内存 cache 掩盖半写或损坏的 job.json。
 * 业务列表仍只返回可解析记录；不可读数量由 jobs 模块变成 jobs_unknown。
 */
export function mockupStoreSnapshot(): { jobs: MockupJob[]; unreadable: number } {
  const root = mockupRoot();
  const out: MockupJob[] = [];
  let unreadable = 0;
  if (!existsSync(root)) return { jobs: out, unreadable };
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const path = jobPath(name.name, false);
    try {
      const job = JSON.parse(readFileSync(path, "utf8")) as MockupJob;
      if (
        !job
        || typeof job !== "object"
        || Array.isArray(job)
        || !isTid(job.id)
        || job.id !== name.name
        || !hasValidMockupJobState(job)
      ) {
        throw new Error("invalid mockup record");
      }
      rememberMockup(job);
      out.push(job);
    } catch {
      cache.delete(name.name);
      unreadable += 1;
    }
  }
  return { jobs: out, unreadable };
}

export function listJobs(): MockupJob[] {
  return loadAllMockups().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

const PUBLIC_MOCKUP_ERROR_FALLBACK = "打样失败，请让管理员在本机检查详细原因";

/**
 * 打样列表现在是团队共享读取边界；旧任务可能持久化过 worker 原文。
 * 在序列化时再次脱敏，避免绝对路径和客户稿件名随历史记录扩散。
 */
function publicMockupError(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return undefined;
  if (/https?:\/\/|file:\/\/|Bearer\s+|access_token|client_secret|api[_-]?key|authorization|cookie/i.test(raw)) {
    return PUBLIC_MOCKUP_ERROR_FALLBACK;
  }
  const safe = raw
    .replace(/[A-Za-z]:\\[^\s,，。;；"'）)\r\n]*/g, "本机稿件")
    .replace(/\\\\[^\s,，。;；"'）)\r\n]*/g, "本机稿件")
    .replace(/(^|[\s=:：("'（])\/[^\s,，。;；"'）)\r\n]*/g, "$1本机稿件")
    .replace(/[^\s/\\:："'（）()]+\.(?:ai|pdf|png|glb|json|blend|pptx)(?=$|[\s,，。;；:："'）)])/giu, "稿件文件")
    .trim();
  return (safe || PUBLIC_MOCKUP_ERROR_FALLBACK).slice(0, 80);
}

function publicMockupSummaryFields(job: MockupJob) {
  const legacyError = publicMockupError(job.error);
  const jobError = publicMockupError(job.job_error);
  return {
    id: job.id,
    status: job.status,
    title: job.title || "",
    error: legacyError || jobError,
    created_at: job.created_at,
    owner: job.created_by || job.owner,
    files: (job.files || []).map((f) => ({ key: f.key, name: f.name })),
    job_kind: job.job_kind || "mockup",
    job_status: job.job_status,
    job_stage: job.job_stage,
    job_stage_label: job.job_stage_label,
    job_eta_s: job.job_eta_s,
    job_error: jobError,
    job_started_at: job.job_started_at,
    job_finished_at: job.job_finished_at,
    structure_engine: job.structure_engine,
    structure_status: job.structure_status,
    structure_code: job.structure_code,
    structure_message: job.structure_message,
  };
}

export function publicMockupSummary(job: MockupJob) {
  return publicMockupSummaryFields(job);
}

export type PublicMockupView = {
  /** Admin structure desk. Reviewer/viewer never receive layer candidates. */
  structureDesk?: boolean;
};

export function publicMockup(job: MockupJob, view: PublicMockupView = {}) {
  const resolution = readStructureResolution(job);
  return {
    ...publicMockupSummaryFields(job),
    files: visibleMockupFiles(job),
    can_repair_print_faces: canRepairPrintFaces(job),
    structure_preview: structurePreviewFromResolution(job, resolution),
    structure_input: view.structureDesk === false
      ? undefined
      : publicStructureInput(job, resolution),
  };
}

export function uniquePublishedNetId(job: MockupJob): string | null {
  const preview = structurePreviewFromResolution(job, readStructureResolution(job));
  if (!preview || preview.net_proposals.length !== 1) return null;
  return preview.net_proposals[0].id;
}

export function uniqueConfirmableAnchor(job: MockupJob): StructureAnchorDecision | null {
  const preview = structurePreviewFromResolution(job, readStructureResolution(job));
  if (!preview || preview.net_proposals.length !== 1) return null;
  const proposal = preview.net_proposals[0];
  const anchors = proposal.valid_anchors || [];
  if (anchors.length !== 1) return null;
  const preferred = anchors[0].preferred_quarter_turns;
  if (preferred === undefined || !anchors[0].quarter_turns.includes(preferred)) return null;
  return {
    proposal_id: proposal.id,
    front_face_id: anchors[0].front_face_id,
    quarter_turns: preferred,
  };
}

export function stampAutoConfirmed(job: MockupJob, anchor: StructureAnchorDecision): void {
  const path = job.structure_resolution_path;
  if (!path || !existsSync(path) || !underJobDir(job.id, path)) return;
  try {
    const resolution = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    resolution.auto_confirmed = {
      proposal_id: anchor.proposal_id,
      front_face_id: anchor.front_face_id,
      quarter_turns: anchor.quarter_turns,
    };
    replaceFile(path, `${JSON.stringify(resolution, null, 2)}\n`);
  } catch {
    // Desk logs still have structure_code; missing auto_confirmed is recoverable.
  }
}

type StructureResolution = {
  topology?: { face_proposal?: unknown[]; net_proposals?: unknown[] };
  structure?: {
    structure_hash?: unknown;
    source?: { page_size?: unknown; sha256?: unknown };
  };
  input_candidates?: unknown;
};

function readStructureResolution(job: MockupJob): StructureResolution | undefined {
  const path = job.structure_resolution_path;
  if (!path || !existsSync(path) || !underJobDir(job.id, path)) return undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_STRUCTURE_RESOLUTION_BYTES) return undefined;
    const contents = readFileSync(path);
    if (contents.byteLength > MAX_STRUCTURE_RESOLUTION_BYTES) return undefined;
    const resolution = JSON.parse(contents.toString("utf8"));
    return resolution && typeof resolution === "object" && !Array.isArray(resolution)
      ? resolution as StructureResolution
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalSourceHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function normalizeStructureInputPreview(
  value: unknown,
  candidateIds: Set<string>,
): StructureInputPreview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const size = finiteNumbers(input.page_size_points, 2);
  const rawLayers = input.layers;
  if (
    input.schema !== STRUCTURE_INPUT_PREVIEW_SCHEMA
    || !size
    || size.some((number) => number < 1 || number > 1_000_000)
    || !Array.isArray(rawLayers)
    || rawLayers.length < 1
    || rawLayers.length > MAX_STRUCTURE_INPUT_PREVIEW_RAW_LAYERS
  ) return undefined;
  const layers: StructureInputPreview["layers"] = [];
  const seen = new Set<string>();
  let proposalPathCount = 0;
  let proposalPointCount = 0;
  let platePathCount = 0;
  let platePointCount = 0;
  for (const rawLayer of rawLayers) {
    if (!rawLayer || typeof rawLayer !== "object" || Array.isArray(rawLayer)) return undefined;
    const layer = rawLayer as Record<string, unknown>;
    const candidateId = typeof layer.candidate_id === "string" ? layer.candidate_id : "";
    const rawPaths = layer.paths;
    if (!candidateIds.has(candidateId) || seen.has(candidateId)) continue;
    if (
      typeof layer.truncated !== "boolean"
      || !Array.isArray(rawPaths)
      || rawPaths.length < 1
      || rawPaths.length > MAX_STRUCTURE_INPUT_PREVIEW_PATHS_PER_LAYER
    ) return undefined;
    const paths: StructureInputPreview["layers"][number]["paths"] = [];
    for (const rawPath of rawPaths) {
      if (!rawPath || typeof rawPath !== "object" || Array.isArray(rawPath)) return undefined;
      const path = rawPath as Record<string, unknown>;
      const rawPoints = path.points;
      if (
        typeof path.closed !== "boolean"
        || !Array.isArray(rawPoints)
        || rawPoints.length < 2
        || rawPoints.length > MAX_STRUCTURE_INPUT_PREVIEW_POINTS_PER_PATH
      ) return undefined;
      const points: StructureInputPreviewPoint[] = [];
      for (const rawPoint of rawPoints) {
        const point = finiteNumbers(rawPoint, 6);
        if (!point || point.some((number) => Math.abs(number) > 10_000_000)) return undefined;
        points.push(point as StructureInputPreviewPoint);
      }
      if (candidateId.startsWith("preview-plate-")) {
        platePathCount += 1;
        platePointCount += points.length;
        if (
          platePathCount > MAX_STRUCTURE_INPUT_PREVIEW_PATHS
          || platePointCount > MAX_STRUCTURE_INPUT_PREVIEW_POINTS
        ) return undefined;
      } else {
        proposalPathCount += 1;
        proposalPointCount += points.length;
        if (
          proposalPathCount > MAX_STRUCTURE_INPUT_PREVIEW_PATHS
          || proposalPointCount > MAX_STRUCTURE_INPUT_PREVIEW_POINTS
        ) return undefined;
      }
      paths.push({ closed: path.closed, points });
    }
    seen.add(candidateId);
    layers.push({ candidate_id: candidateId, paths, truncated: layer.truncated });
  }
  if (!layers.length) return undefined;
  return {
    schema: STRUCTURE_INPUT_PREVIEW_SCHEMA,
    page_size_points: size as [number, number],
    layers,
  };
}

function normalizeStructureInputCandidates(
  value: unknown,
  expectedSourceHash: string,
): StructureInputCandidates | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const sourceHash = canonicalSourceHash(input.source_sha256);
  const rawLayers = input.proposal_layers;
  if (
    input.schema !== STRUCTURE_INPUT_CANDIDATES_SCHEMA
    || !sourceHash
    || sourceHash !== expectedSourceHash
    || !Array.isArray(rawLayers)
    || rawLayers.length < 1
    || rawLayers.length > MAX_STRUCTURE_INPUT_CANDIDATES
    || typeof input.truncated !== "boolean"
  ) return undefined;
  const layers: StructureInputLayerCandidate[] = [];
  const ids = new Set<string>();
  const displayNames = new Set<string>();
  for (const raw of rawLayers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const candidate = raw as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id : "";
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const displayName = name.trim();
    const count = candidate.stroke_only_path_count;
    const expectedId = displayName
      ? `proposal-layer-${createHash("sha256").update(`${sourceHash}\0${name}`).digest("hex").slice(0, 16)}`
      : "";
    if (
      id !== expectedId
      || !displayName
      || name.length > 160
      || ids.has(id)
      || displayNames.has(displayName)
      || typeof count !== "number"
      || !Number.isSafeInteger(count)
      || count < 1
      || count > 1_000_000
    ) return undefined;
    ids.add(id);
    displayNames.add(displayName);
    layers.push({ id, name, stroke_only_path_count: count });
  }
  const plates = normalizePreviewPlates(input.preview_plates, sourceHash, ids, displayNames);
  const previewIds = new Set([...ids, ...plates.map((plate) => plate.id)]);
  const preview = normalizeStructureInputPreview(input.preview, previewIds);
  return {
    schema: STRUCTURE_INPUT_CANDIDATES_SCHEMA,
    source_sha256: sourceHash,
    proposal_layers: layers,
    truncated: input.truncated,
    ...(plates.length ? { preview_plates: plates } : {}),
    ...(preview ? { preview } : {}),
  };
}

function normalizePreviewPlates(
  value: unknown,
  sourceHash: string,
  takenIds: Set<string>,
  takenNames: Set<string>,
): StructureInputPreviewPlate[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STRUCTURE_INPUT_CANDIDATES) {
    return [];
  }
  const plates: StructureInputPreviewPlate[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const plate = raw as Record<string, unknown>;
    const id = typeof plate.id === "string" ? plate.id : "";
    const name = typeof plate.name === "string" ? plate.name : "";
    const displayName = name.trim();
    const expectedId = displayName
      ? `preview-plate-${createHash("sha256").update(`${sourceHash}\0${name}`).digest("hex").slice(0, 16)}`
      : "";
    if (
      id !== expectedId
      || !displayName
      || name.length > 160
      || ids.has(id)
      || names.has(displayName)
      || takenIds.has(id)
      || takenNames.has(displayName)
    ) continue;
    ids.add(id);
    names.add(displayName);
    plates.push({ id, name });
  }
  return plates;
}

function loadStructureInputCandidates(
  job: MockupJob,
  resolution: StructureResolution | undefined,
): StructureInputCandidates | undefined {
  const expectedSourceHash = canonicalSourceHash(job.structure_source_sha256);
  if (!expectedSourceHash) return undefined;
  const stored = normalizeStructureInputCandidates(job.structure_input_candidates, expectedSourceHash);
  if (stored) return stored;
  if (canonicalSourceHash(resolution?.structure?.source?.sha256) !== expectedSourceHash) return undefined;
  return normalizeStructureInputCandidates(resolution?.input_candidates, expectedSourceHash);
}

function publicStructureInput(job: MockupJob, resolution: StructureResolution | undefined): {
  schema: "packaging-structure-input-candidates/2";
  proposal_layers: StructureInputLayerCandidate[];
  selected_ids: string[];
  truncated: boolean;
  image_url?: string;
  preview_plates?: StructureInputPreviewPlate[];
  preview?: StructureInputPreview;
} | undefined {
  if (job.structure_status !== "review_required") return undefined;
  const candidates = loadStructureInputCandidates(job, resolution);
  if (!candidates) return undefined;
  const candidateIds = new Set(candidates.proposal_layers.map((candidate) => candidate.id));
  const selected = new Set(
    Array.isArray(job.structure_input_selection_ids)
      ? job.structure_input_selection_ids.filter((id) => candidateIds.has(id))
      : [],
  );
  const preview = job.structure_input_preview_path || job.structure_artwork_preview_path;
  return {
    schema: STRUCTURE_INPUT_CANDIDATES_SCHEMA,
    proposal_layers: candidates.proposal_layers,
    selected_ids: candidates.proposal_layers
      .map((candidate) => candidate.id)
      .filter((id) => selected.has(id)),
    truncated: candidates.truncated,
    ...(candidates.preview_plates?.length ? { preview_plates: candidates.preview_plates } : {}),
    ...(candidates.preview ? { preview: candidates.preview } : {}),
    ...(preview && existsSync(preview) && underJobDir(job.id, preview)
      ? { image_url: `/api/mockups/${job.id}/structure-input-preview` }
      : {}),
  };
}

export function prepareStructureInputSelection(
  job: MockupJob,
  candidateIds: unknown,
): { job: MockupJob; changed: boolean } {
  if (job.structure_status !== "review_required" || job.job_status !== "waiting_input") {
    throw Object.assign(new Error("这单当前没有待选择的包装结构层"), { status: 409 });
  }
  if (
    !Array.isArray(candidateIds)
    || candidateIds.length < 1
    || candidateIds.length > MAX_STRUCTURE_INPUT_SELECTIONS
    || candidateIds.some((id) => typeof id !== "string" || !/^proposal-layer-[0-9a-f]{16}$/.test(id))
    || new Set(candidateIds).size !== candidateIds.length
  ) {
    throw Object.assign(new Error("请选择 1–16 个当前稿件列出的结构图层"), { status: 400 });
  }
  const candidates = loadStructureInputCandidates(job, readStructureResolution(job));
  if (!candidates) {
    throw Object.assign(new Error("结构层候选已失效，请刷新或重新识别"), { status: 409 });
  }
  const requested = new Set(candidateIds as string[]);
  const selected = candidates.proposal_layers.filter((candidate) => requested.has(candidate.id));
  if (selected.length !== requested.size) {
    throw Object.assign(new Error("结构层候选已变化，请刷新后重新选择"), { status: 400 });
  }
  const normalizedIds = selected.map((candidate) => candidate.id);
  if (
    Array.isArray(job.structure_input_selection_ids)
    && job.structure_input_selection_ids.length === normalizedIds.length
    && job.structure_input_selection_ids.every((id, index) => id === normalizedIds[index])
  ) {
    return { job, changed: false };
  }
  const source = job.source_path;
  const manifestPath = job.manifest_path;
  if (
    !source
    || !existsSync(source)
    || !underJobDir(job.id, source)
    || !manifestPath
    || !existsSync(manifestPath)
    || !underJobDir(job.id, manifestPath)
  ) {
    throw Object.assign(new Error("打样任务文件已变化，请重新上传"), { status: 409 });
  }
  let manifest: { products?: Array<Record<string, unknown>> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    throw Object.assign(new Error("打样任务清单已损坏，请重新上传"), { status: 409 });
  }
  if (!Array.isArray(manifest.products) || manifest.products.length !== 1) {
    throw Object.assign(new Error("打样任务清单已变化，请重新上传"), { status: 409 });
  }
  const product = manifest.products[0];
  if (typeof product.source_ai !== "string" || resolve(product.source_ai) !== resolve(source)) {
    throw Object.assign(new Error("打样源稿已变化，请重新上传"), { status: 409 });
  }
  const nextProduct: Record<string, unknown> = {
    ...product,
    structure_engine: "v2",
    proposal_layers: selected.map((candidate) => candidate.name),
    proposal_source_sha256: candidates.source_sha256,
  };
  delete nextProduct.structure_sidecar;
  delete nextProduct.artwork_pdf;
  manifest.products[0] = nextProduct;
  const selectionId = createHash("sha256")
    .update(`${candidates.source_sha256}\0${normalizedIds.join("\0")}`)
    .digest("hex")
    .slice(0, 16);
  const selectedManifest = join(mockupRoot(), job.id, `structure-input-${selectionId}.json`);
  replaceFile(selectedManifest, JSON.stringify(manifest, null, 2));

  const nextJob: MockupJob = {
    ...job,
    structure_input_candidates: candidates,
    structure_input_selection_ids: normalizedIds,
    manifest_path: selectedManifest,
    structure_status: "analyzing",
    status: "queued",
    job_status: "queued",
    reclaim_count: 0,
  };
  if (
    !job.structure_input_preview_path
    && job.structure_artwork_preview_path
    && existsSync(job.structure_artwork_preview_path)
    && underJobDir(job.id, job.structure_artwork_preview_path)
  ) {
    const inputPreview = join(mockupRoot(), job.id, "structure-input-preview.png");
    copyFileSync(job.structure_artwork_preview_path, inputPreview);
    nextJob.structure_input_preview_path = inputPreview;
  }
  delete nextJob.structure_code;
  delete nextJob.structure_message;
  delete nextJob.structure_resolution_path;
  delete nextJob.structure_sidecar_path;
  delete nextJob.structure_artwork_path;
  delete nextJob.structure_artwork_preview_path;
  delete nextJob.job_stage;
  delete nextJob.job_stage_label;
  delete nextJob.job_eta_s;
  delete nextJob.job_error;
  delete nextJob.error;
  delete nextJob.job_finished_at;
  saveMockup(nextJob);
  return { job: nextJob, changed: true };
}

function finiteNumbers(value: unknown, count: number): number[] | null {
  if (!Array.isArray(value) || value.length !== count) return null;
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    numbers.push(item);
  }
  return numbers;
}

function finitePointPairs(value: unknown): Array<[number, number]> | undefined {
  if (!Array.isArray(value) || value.length < 3 || value.length > 128) return undefined;
  const points: Array<[number, number]> = [];
  for (const raw of value) {
    const point = finiteNumbers(raw, 2);
    if (!point) return undefined;
    points.push([point[0], point[1]]);
  }
  return points;
}

function positiveDimensions(value: unknown): StructureNetProposal["dimensions_mm"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const width = Number(raw.width);
  const depth = Number(raw.depth);
  const height = Number(raw.height);
  if (![width, depth, height].every((item) => Number.isFinite(item) && item > 0)) return undefined;
  return { width, depth, height };
}

export function loadStructurePreview(job: MockupJob): {
  faces: StructurePreviewFace[];
  net_proposals: StructureNetProposal[];
  page_size_mm?: [number, number];
  image_url?: string;
} | undefined {
  return structurePreviewFromResolution(job, readStructureResolution(job));
}

function structurePreviewFromResolution(
  job: MockupJob,
  resolution: StructureResolution | undefined,
): {
  faces: StructurePreviewFace[];
  net_proposals: StructureNetProposal[];
  page_size_mm?: [number, number];
  image_url?: string;
} | undefined {
  if (!resolution) return undefined;
  try {
    const currentStructureHash = typeof resolution.structure?.structure_hash === "string"
      && /^sha256:[0-9a-f]{64}$/.test(resolution.structure.structure_hash)
      ? resolution.structure.structure_hash
      : null;
    const resolutionSourceHash = typeof resolution.structure?.source?.sha256 === "string"
      && /^[0-9a-f]{64}$/.test(resolution.structure.source.sha256)
      ? resolution.structure.source.sha256
      : null;
    const jobSourceHash = typeof job.structure_source_sha256 === "string"
      && /^[0-9a-f]{64}$/.test(job.structure_source_sha256)
      ? job.structure_source_sha256
      : null;
    const sourceMatchesJob = resolutionSourceHash !== null
      && jobSourceHash !== null
      && resolutionSourceHash === jobSourceHash;
    const raw = resolution.topology?.face_proposal;
    if (!Array.isArray(raw) || raw.length > 1000) return undefined;
    const faces: StructurePreviewFace[] = [];
    for (const value of raw) {
      if (!value || typeof value !== "object") continue;
      const face = value as Record<string, unknown>;
      const id = typeof face.id === "string" ? face.id : "";
      const bounds = finiteNumbers(face.bounds_mm, 4);
      const centroid = finiteNumbers(face.centroid_mm, 2);
      const size = finiteNumbers(face.size_mm, 2);
      const points = finitePointPairs(face.points_mm);
      if (!id || !bounds || !centroid) continue;
      faces.push({
        id,
        bounds_mm: bounds as StructurePreviewFace["bounds_mm"],
        centroid_mm: centroid as StructurePreviewFace["centroid_mm"],
        rectangular: face.rectangular === true,
        ...(size ? { size_mm: size as [number, number] } : {}),
        ...(points ? { points_mm: points } : {}),
      });
    }
    if (!faces.length) return undefined;
    const faceIds = new Set(faces.map((face) => face.id));
    const polygonFaceIds = new Set(
      faces.filter((face) => Boolean(face.points_mm)).map((face) => face.id),
    );
    const netProposals: StructureNetProposal[] = [];
    const rawNets = resolution.topology?.net_proposals;
    if (Array.isArray(rawNets) && rawNets.length <= 24) {
      for (const value of rawNets) {
        if (!value || typeof value !== "object") continue;
        const net = value as Record<string, unknown>;
        const id = typeof net.id === "string" ? net.id : "";
        const faceIdsRaw = Array.isArray(net.face_ids) ? net.face_ids.map(String) : [];
        const bodyIds = Array.isArray(net.body_face_ids) ? net.body_face_ids.map(String) : [];
        const capIds = Array.isArray(net.cap_face_ids) ? net.cap_face_ids.map(String) : [];
        const stripAxis = net.strip_axis === "x" || net.strip_axis === "y" ? net.strip_axis : null;
        const bounds = finiteNumbers(net.bounds_mm, 4);
        if (
          net.schema !== BOX_NET_PROPOSAL_SCHEMA ||
          !isStructureProposalId(id) ||
          !currentStructureHash ||
          !sourceMatchesJob ||
          net.structure_hash !== currentStructureHash ||
          faceIdsRaw.length < 6 ||
          faceIdsRaw.length > 8 ||
          new Set(faceIdsRaw).size !== faceIdsRaw.length ||
          bodyIds.length !== 4 ||
          new Set(bodyIds).size !== 4 ||
          capIds.length !== 2 ||
          new Set(capIds).size !== 2 ||
          new Set([...bodyIds, ...capIds]).size !== 6 ||
          !stripAxis ||
          bodyIds.some((faceId) => !faceIdsRaw.includes(faceId)) ||
          capIds.some((faceId) => !faceIdsRaw.includes(faceId)) ||
          faceIdsRaw.some((faceId) => !faceIds.has(faceId)) ||
          faceIdsRaw.some((faceId) => !polygonFaceIds.has(faceId))
        ) {
          continue;
        }
        const dimensions = positiveDimensions(net.dimensions_mm);
        const rawAnchors = Array.isArray(net.valid_anchors) ? net.valid_anchors : null;
        if (net.dimensions_mm !== undefined && !dimensions) continue;
        if (!rawAnchors || !rawAnchors.length || rawAnchors.length > 4) continue;
        const validAnchors: NonNullable<StructureNetProposal["valid_anchors"]> = [];
        for (const rawAnchor of rawAnchors) {
          if (!rawAnchor || typeof rawAnchor !== "object" || Array.isArray(rawAnchor)) continue;
          const anchor = rawAnchor as Record<string, unknown>;
          const frontFaceId = typeof anchor.front_face_id === "string" ? anchor.front_face_id : "";
          const rawTurns = Array.isArray(anchor.quarter_turns) ? anchor.quarter_turns : [];
          const turns = rawTurns.filter((turn): turn is number => (
            typeof turn === "number" && Number.isInteger(turn) && turn >= 0 && turn <= 3
          ));
          const preferred = anchor.preferred_quarter_turns;
          if (
            !bodyIds.includes(frontFaceId)
            || !turns.length
            || turns.length !== rawTurns.length
            || new Set(turns).size !== turns.length
            || typeof preferred !== "number"
            || !Number.isInteger(preferred)
            || !turns.includes(preferred)
          ) continue;
          validAnchors.push({
            front_face_id: frontFaceId,
            quarter_turns: turns as Array<0 | 1 | 2 | 3>,
            preferred_quarter_turns: preferred as 0 | 1 | 2 | 3,
          });
        }
        if (
          validAnchors.length !== rawAnchors.length
          || new Set(validAnchors.map((anchor) => anchor.front_face_id)).size !== validAnchors.length
        ) continue;
        const rawClosures = Array.isArray(net.closure_assemblies) ? net.closure_assemblies : undefined;
        if (!rawClosures || rawClosures.length !== 2) continue;
        const closures: NonNullable<StructureNetProposal["closure_assemblies"]> = [];
        const closureMemberIds = new Set<string>();
        const closureSides = new Set<number>();
        for (const rawClosure of rawClosures) {
          if (!rawClosure || typeof rawClosure !== "object" || Array.isArray(rawClosure)) continue;
          const closure = rawClosure as Record<string, unknown>;
          const primaryFaceId = typeof closure.primary_face_id === "string" ? closure.primary_face_id : "";
          const side = closure.side === -1 || closure.side === 1 ? closure.side : null;
          const extent = closure.extent === "full" || closure.extent === "partial" ? closure.extent : null;
          const closureKind = closure.closure_kind === "full"
            || closure.closure_kind === "clearance"
            || closure.closure_kind === "assembly"
            ? closure.closure_kind
            : null;
          const ratio = closure.coverage_ratio;
          const rawMembers = Array.isArray(closure.members) ? closure.members : null;
          const expectedMembers = closureKind === "assembly" ? 2 : 1;
          if (
            !capIds.includes(primaryFaceId)
            || side === null
            || closureSides.has(side)
            || !extent
            || !closureKind
            || typeof ratio !== "number"
            || !Number.isFinite(ratio)
            || ratio <= 0
            || ratio > 1
            || !rawMembers
            || rawMembers.length !== expectedMembers
            || (closureKind === "full" && Math.abs(ratio - 1) > 1e-6)
            || (closureKind === "assembly" && ratio < MIN_ASSEMBLY_UNION_RATIO)
          ) continue;
          const members: NonNullable<StructureNetProposal["closure_assemblies"]>[number]["members"] = [];
          for (const rawMember of rawMembers) {
            if (!rawMember || typeof rawMember !== "object" || Array.isArray(rawMember)) continue;
            const member = rawMember as Record<string, unknown>;
            const faceId = typeof member.face_id === "string" ? member.face_id : "";
            const bodyId = typeof member.attached_body_face_id === "string" ? member.attached_body_face_id : "";
            const memberExtent = member.extent === "full" || member.extent === "partial" ? member.extent : null;
            const memberRatio = member.coverage_ratio;
            if (
              !faceIdsRaw.includes(faceId)
              || bodyIds.includes(faceId)
              || closureMemberIds.has(faceId)
              || !bodyIds.includes(bodyId)
              || !memberExtent
              || typeof memberRatio !== "number"
              || !Number.isFinite(memberRatio)
              || memberRatio <= 0
              || memberRatio > 1
              || (closureKind === "assembly" && (
                memberExtent !== "partial"
                || memberRatio < MIN_ASSEMBLY_MEMBER_RATIO
                || memberRatio > MAX_ASSEMBLY_MEMBER_RATIO
              ))
            ) continue;
            closureMemberIds.add(faceId);
            members.push({
              face_id: faceId,
              attached_body_face_id: bodyId,
              extent: memberExtent,
              coverage_ratio: memberRatio,
            });
          }
          if (members.length !== expectedMembers || !members.some((member) => member.face_id === primaryFaceId)) continue;
          if (closureKind === "assembly") {
            const attachmentIndexes = members.map((member) => bodyIds.indexOf(member.attached_body_face_id));
            const declaredMemberCoverage = members.reduce((total, member) => total + member.coverage_ratio, 0);
            if (
              attachmentIndexes.length !== 2
              || Math.abs(attachmentIndexes[0] - attachmentIndexes[1]) !== 2
              || ratio > Math.min(1, declaredMemberCoverage) + 1e-6
              || declaredMemberCoverage > MAX_ASSEMBLY_MEMBER_SUM_RATIO + 1e-6
            ) continue;
          } else if (Math.abs(members[0].coverage_ratio - ratio) > 1e-6) {
            continue;
          }
          closureSides.add(side);
          closures.push({
            primary_face_id: primaryFaceId,
            side,
            extent,
            closure_kind: closureKind,
            coverage_ratio: ratio,
            members,
          });
        }
        if (
          closures.length !== 2
          || closureSides.size !== 2
          || new Set([...bodyIds, ...closureMemberIds]).size !== faceIdsRaw.length
          || faceIdsRaw.some((faceId) => !bodyIds.includes(faceId) && !closureMemberIds.has(faceId))
        ) continue;
        netProposals.push({
          schema: BOX_NET_PROPOSAL_SCHEMA,
          id,
          face_ids: faceIdsRaw,
          body_face_ids: bodyIds as StructureNetProposal["body_face_ids"],
          cap_face_ids: capIds as StructureNetProposal["cap_face_ids"],
          strip_axis: stripAxis,
          ...(bounds ? { bounds_mm: bounds as StructureNetProposal["bounds_mm"] } : {}),
          ...(dimensions ? { dimensions_mm: dimensions } : {}),
          ...(validAnchors.length ? { valid_anchors: validAnchors } : {}),
          closure_assemblies: closures,
        });
      }
    }
    const pageSize = finiteNumbers(resolution.structure?.source?.page_size, 2);
    const previewPath = job.structure_artwork_preview_path;
    const hasPreview = Boolean(
      previewPath &&
      existsSync(previewPath) &&
      underJobDir(job.id, previewPath),
    );
    return {
      faces,
      net_proposals: netProposals,
      ...(pageSize && pageSize.every((value) => value > 0)
        ? { page_size_mm: pageSize as [number, number] }
        : {}),
      ...(hasPreview ? { image_url: `/api/mockups/${job.id}/structure-preview` } : {}),
    };
  } catch {
    return undefined;
  }
}

export function prepareStructureConfirmation(
  job: MockupJob,
  decision: StructureConfirmationDecision,
): { source: string; resolution: string; decisions: string; output: string } {
  const required = {
    source: job.source_path,
    resolution: job.structure_resolution_path,
    artwork: job.structure_artwork_path,
  };
  for (const [label, path] of Object.entries(required)) {
    if (!path || !existsSync(path) || !underJobDir(job.id, path)) {
      throw Object.assign(new Error(`结构确认缺少${label}文件，请重新识别`), { status: 409 });
    }
  }
  const root = join(mockupRoot(), job.id);
  const normalizedDecision: StructureConfirmationDecision = {
    anchor: {
      proposal_id: decision.anchor.proposal_id,
      front_face_id: decision.anchor.front_face_id,
      quarter_turns: decision.anchor.quarter_turns,
    },
  };
  const decisionsPayload = JSON.stringify(normalizedDecision, null, 2);
  const decisionId = createHash("sha256").update(decisionsPayload).digest("hex").slice(0, 16);
  const decisions = join(root, `structure_decisions-${decisionId}.json`);
  const output = join(root, `structure_approved-${decisionId}.json`);
  replaceFile(decisions, decisionsPayload);
  return {
    source: required.source as string,
    resolution: required.resolution as string,
    decisions,
    output,
  };
}

export function acceptStructureConfirmation(job: MockupJob, approvedSidecar: string): MockupJob {
  const artwork = job.structure_artwork_path;
  const manifestPath = job.manifest_path;
  if (
    !approvedSidecar ||
    !existsSync(approvedSidecar) ||
    !underJobDir(job.id, approvedSidecar) ||
    !artwork ||
    !existsSync(artwork) ||
    !underJobDir(job.id, artwork) ||
    !manifestPath ||
    !existsSync(manifestPath) ||
    !underJobDir(job.id, manifestPath)
  ) {
    throw Object.assign(new Error("结构确认结果不完整，请重新识别"), { status: 409 });
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    products?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(manifest.products) || manifest.products.length !== 1) {
    throw Object.assign(new Error("打样任务清单已变化，请重新识别"), { status: 409 });
  }
  manifest.products[0] = {
    ...manifest.products[0],
    structure_engine: "v2",
    structure_sidecar: approvedSidecar,
    artwork_pdf: artwork,
  };
  const confirmedManifest = join(mockupRoot(), job.id, "confirmed_manifest.json");
  replaceFile(confirmedManifest, JSON.stringify(manifest, null, 2));
  job.manifest_path = confirmedManifest;
  job.structure_sidecar_path = approvedSidecar;
  job.structure_status = "ready";
  job.structure_code = undefined;
  job.structure_message = undefined;
  job.status = "queued";
  job.job_status = "queued";
  job.job_stage = undefined;
  job.job_stage_label = undefined;
  job.job_eta_s = undefined;
  job.job_error = undefined;
  job.reclaim_count = 0;
  delete job.job_finished_at;
  delete job.notify_job_id;
  job.notify_sent = false;
  saveMockup(job);
  return job;
}

const READ_PANEL_NAME = /^panel_(front|back|right|left|top|bottom)\.png$/;
const REQUIRED_PRINT_FACES = ["front", "back", "left", "right"] as const;
const RESOLVED_PACKAGING_SCHEMA = "resolved-packaging-job/3";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngMagicAtPath(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(8);
    const n = readSync(fd, buf, 0, 8, 0);
    return n >= 8 && buf.equals(PNG_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function hasResolvedPackagingJob(path: string): boolean {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const resolved = data.schema === RESOLVED_PACKAGING_SCHEMA ? data : data.resolved;
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return false;
    const payload = resolved as Record<string, unknown>;
    return payload.schema === RESOLVED_PACKAGING_SCHEMA && Boolean(payload.faces) && typeof payload.faces === "object";
  } catch {
    return false;
  }
}

export function requiredPrintFacesReady(jobId: string): boolean {
  if (!isTid(jobId)) return false;
  for (const face of REQUIRED_PRINT_FACES) {
    const path = join(mockupRoot(false), jobId, "assets", `panel_${face}.png`);
    if (!existsSync(path) || !underJobDir(jobId, path) || !pngMagicAtPath(path)) return false;
  }
  return true;
}

export type PrintFaceRepairSource = {
  jobDir: string;
  artwork: string;
  resolved: string;
  assets: string;
};

export function printFaceRepairSource(job: MockupJob): PrintFaceRepairSource | null {
  if (job.structure_engine !== "v2") return null;
  const artwork = job.structure_artwork_path;
  const resolved = job.structure_resolution_path;
  if (!isMockupJobFile(job.id, artwork) || !isMockupJobFile(job.id, resolved)) return null;
  if (!hasResolvedPackagingJob(resolved)) return null;
  const jobDir = join(mockupRoot(false), job.id);
  return { jobDir, artwork, resolved, assets: join(jobDir, "assets") };
}

function canRepairPrintFaces(job: MockupJob): boolean {
  return job.status === "done" && !requiredPrintFacesReady(job.id) && printFaceRepairSource(job) !== null;
}

function readKeyForPanelName(name: string): string | undefined {
  const match = basename(name).toLowerCase().match(READ_PANEL_NAME);
  return match ? `read_${match[1]}` : undefined;
}

function stillKeyFromName(lower: string): string {
  const card = lower.includes("_card.png");
  const set = lower.includes("_set");
  const ground = !set && lower.includes("_ground");
  let base = "";
  if (lower.endsWith(".png") && lower.includes("front_right")) {
    base = set ? "white_a_set" : ground ? "white_a_ground" : "white_a";
  } else if (lower.endsWith(".png") && lower.includes("back_left")) {
    base = set ? "white_b_set" : ground ? "white_b_ground" : "white_b";
  }
  if (!base) return "";
  return card ? `${base}_card` : base;
}

const STILL_FILE_KEYS = new Set([
  "white_a",
  "white_b",
  "white_a_ground",
  "white_b_ground",
  "white_a_set",
  "white_b_set",
  "white_a_card",
  "white_b_card",
  "white_a_ground_card",
  "white_b_ground_card",
  "white_a_set_card",
  "white_b_set_card",
]);

export function isWhiteFile(key: string, name: string): boolean {
  const lower = name.toLowerCase();
  if (STILL_FILE_KEYS.has(key)) {
    return stillKeyFromName(lower) === key;
  }
  if (key.startsWith("read_")) return readKeyForPanelName(name) === key;
  return true;
}

export function mockupFileBrokenMessage(key: string): string {
  if (key.startsWith("read_")) return "这张印刷面图坏了，不是 PNG。重新打样后才能读字。";
  return "这张白底图坏了，不是 PNG。回到打样台重新打。";
}

export function collectOutputs(root: string): MockupJob["files"] {
  const found: MockupJob["files"] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) {
        if (!name.name.startsWith(".")) walk(p);
      } else if (/\.(glb|png|pptx|pdf)$/i.test(name.name)) {
        const lower = name.name.toLowerCase();
        let key = "";
        if (lower.endsWith(".glb")) key = "glb";
        else if (lower.endsWith(".pptx")) key = "ppt";
        else if (lower.endsWith(".pdf") && lower.includes("white_sheet")) key = "sheet";
        else key = stillKeyFromName(lower);
        if (!key && lower.endsWith(".png")) {
          const readKey = readKeyForPanelName(name.name);
          if (!readKey) continue;
          const rel = relative(root, p).replace(/\\/g, "/").toLowerCase();
          if (rel !== `assets/${basename(p).toLowerCase()}`) continue;
          key = readKey;
        }
        if (!key) continue;
        if (found.some((f) => f.key === key)) continue;
        found.push({ key, path: p, name: basename(p) });
      }
    }
  };
  walk(root);
  return found;
}

function underJobDir(jobId: string, p: string): boolean {
  const root = resolve(mockupRoot(), jobId);
  const full = resolve(p);
  const rel = relative(root, full);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function liveReadPanelFiles(jobId: string): MockupJob["files"] {
  const files: MockupJob["files"] = [];
  for (const face of ["front", "back", "right", "left", "top", "bottom"] as const) {
    const name = `panel_${face}.png`;
    const path = join(mockupRoot(false), jobId, "assets", name);
    if (existsSync(path) && underJobDir(jobId, path)) {
      files.push({ key: `read_${face}`, path, name });
    }
  }
  return files;
}

function visibleMockupFiles(job: MockupJob): { key: string; name: string }[] {
  const byKey = new Map<string, { key: string; name: string }>();
  for (const file of job.files || []) {
    if (!file.key || !file.name) continue;
    byKey.set(file.key, { key: file.key, name: file.name });
  }
  for (const file of liveReadPanelFiles(job.id)) {
    if (!byKey.has(file.key)) byKey.set(file.key, { key: file.key, name: file.name });
  }
  return [...byKey.values()];
}

export function isMockupJobFile(jobId: string, path: string | null | undefined): path is string {
  return Boolean(path && existsSync(path) && underJobDir(jobId, path));
}

export function fileOf(job: MockupJob, key: string) {
  if (key.startsWith("read_")) {
    const live = liveReadPanelFiles(job.id).find((item) => item.key === key);
    if (live?.path && existsSync(live.path) && underJobDir(job.id, live.path)) return live;
    return undefined;
  }
  const listed = job.files.find((x) => x.key === key);
  if (!listed) return undefined;
  if (listed.path && existsSync(listed.path) && underJobDir(job.id, listed.path)) return listed;
  const guess = join(mockupRoot(false), job.id, basename(listed.name || "file"));
  if (existsSync(guess) && underJobDir(job.id, guess)) return { ...listed, path: guess };
  return undefined;
}

function templatesDir(): string {
  return join(PACKAGING, "templates");
}

function isSmokeTemplate(name: string): boolean {
  return /smoke/i.test(name);
}

export function productionTemplatePaths(): string[] {
  const dir = templatesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !isSmokeTemplate(name))
    .sort()
    .map((name) => join(dir, name));
}

export function defaultTemplatePath(): string {
  const all = productionTemplatePaths();
  const preferred = all.find((p) => basename(p) === "flower_box_47_5x47_5x177_5.json");
  const hit = preferred || all[0];
  if (!hit || !existsSync(hit)) {
    throw Object.assign(new Error("缺少花盒模板"), { status: 412 });
  }
  return hit;
}

export function assertBlenderReady(): string {
  const blender = findBlender();
  if (!blender) {
    throw Object.assign(
      new Error("本机找不到 Blender 可执行文件。请安装 Blender 或设置 BLENDER_EXECUTABLE。"),
      { status: 412 },
    );
  }
  defaultTemplatePath();
  return blender;
}

/** Product/ground stills anywhere except assets/. Leaves assets/panel_*.png. */
export function unlinkSameGenerationStills(jobId: string): void {
  const root = join(mockupRoot(false), jobId);
  if (!existsSync(root)) return;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "assets" || entry.name.startsWith(".")) continue;
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!stillKeyFromName(entry.name.toLowerCase())) continue;
      try {
        unlinkSync(path);
      } catch {
        /* leftover check below fails the retry instead of mixing generations */
      }
    }
  };
  walk(root);
  const leftover = collectOutputs(root).some((file) => Boolean(stillKeyFromName((file.name || "").toLowerCase())));
  if (leftover) {
    throw Object.assign(new Error("旧成片删不掉，请稍后再试"), { status: 409 });
  }
}

/**
 * 打样中 / 打样失败用机上已有稿再排。不重传。进行中的 PID 由 jobs 杀掉。
 * 结构已 ready 的单跳过 Illustrator，从 Blender 再跑。
 */
export function resetMockupForRetry(job: MockupJob): MockupJob {
  if (activeStructureConfirmations.has(job.id)) {
    throw Object.assign(new Error("结构正在确认，暂时不能重试"), { status: 409 });
  }
  if (job.status === "done") {
    throw Object.assign(new Error("已经出图，不用重试"), { status: 409 });
  }
  if (job.status === "review_required") {
    throw Object.assign(new Error("先确认结构再打样"), { status: 409 });
  }
  if (job.status === "unsupported") {
    throw Object.assign(new Error("当前结构还不支持，不能重试"), { status: 409 });
  }
  if (job.status !== "queued" && job.status !== "running" && job.status !== "failed") {
    throw Object.assign(new Error("这单当前不能重试"), { status: 409 });
  }
  if (!isMockupJobFile(job.id, job.source_path)) {
    throw Object.assign(new Error("稿件不在了，请重新上传"), { status: 409 });
  }
  unlinkSameGenerationStills(job.id);
  const resultPath = join(mockupRoot(false), job.id, "pipeline_result.json");
  if (existsSync(resultPath)) {
    try {
      unlinkSync(resultPath);
    } catch {
      /* 删不掉时下一次仍可能命中旧缓存，不要假装已经强制重跑 */
    }
  }
  job.status = "queued";
  job.job_kind = "mockup";
  job.job_status = "queued";
  job.error = undefined;
  job.job_error = undefined;
  job.job_stage = undefined;
  job.job_stage_label = undefined;
  job.job_eta_s = undefined;
  delete job.job_started_at;
  delete job.job_finished_at;
  delete job.job_pid;
  delete job.notify_job_id;
  job.notify_sent = false;
  job.reclaim_count = 0;
  if (job.structure_engine === "v2" && job.structure_status !== "ready") {
    job.structure_status = "analyzing";
  }
  saveMockup(job);
  return job;
}

export function deleteMockup(id: string): void {
  const job = loadMockup(id);
  if (!job) throw Object.assign(new Error("没有这单打样"), { status: 404 });
  if (activeStructureConfirmations.has(id)) {
    throw Object.assign(new Error("结构正在确认，暂时不能删除"), { status: 409 });
  }
  if (
    job.status === "queued" ||
    job.status === "running" ||
    job.job_status === "queued" ||
    job.job_status === "running"
  ) {
    throw Object.assign(new Error("打样还在跑，不能删。等结束或失败后再删。"), { status: 409 });
  }
  rmSync(join(mockupRoot(false), job.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  cache.delete(job.id);
}

export function queueMockup(opts: {
  id: string;
  sourcePath: string;
  sourceReceipt?: string;
  ownerId: string;
  displayName: string;
  illustratorExecutable: string;
  title?: string;
}): MockupJob {
  const blender = assertBlenderReady();
  const template = defaultTemplatePath();
  const outDir = join(mockupRoot(), opts.id);
  mkdirSync(outDir, { recursive: true });
  const product = {
    code: opts.id.slice(0, 8),
    slug: "pack",
    display_name: (opts.title || opts.displayName).slice(0, 40),
    source_ai: opts.sourcePath,
    template,
    structure_engine: "v2" as const,
  };
  const manifest = {
    pipeline_name: "审稿室打样",
    output_root: outDir,
    workers: 1,
    blender_executable: blender,
    illustrator: { enabled: true, application: opts.illustratorExecutable },
    generate_ppt: true,
    products: [product],
  };
  const manifestPath = join(outDir, "manifest.json");
  replaceFile(manifestPath, JSON.stringify(manifest, null, 2));
  const job: MockupJob = {
    id: opts.id,
    status: "queued",
    title: (opts.title || "").trim().slice(0, 80),
    created_at: new Date().toISOString(),
    files: [],
    owner: opts.ownerId,
    created_by: opts.displayName,
    source_path: opts.sourcePath,
    source_receipt: opts.sourceReceipt,
    manifest_path: manifestPath,
    job_kind: "mockup",
    job_status: "queued",
    structure_engine: "v2",
    structure_status: "analyzing",
  };
  saveMockup(job);
  return job;
}
