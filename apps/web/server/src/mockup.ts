import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  id: string;
  face_ids: string[];
  body_face_ids: [string, string, string, string];
  cap_face_ids: [string, string];
  strip_axis: "x" | "y";
  bounds_mm?: [number, number, number, number];
  dimensions_mm?: { width: number; depth: number; height: number };
  valid_anchors?: Array<{ front_face_id: string; quarter_turns: Array<0 | 1 | 2 | 3> }>;
  closure_assemblies?: Array<{
    face_id: string;
    attached_body_face_id: string;
    side: -1 | 1;
    extent: "full" | "partial";
    coverage_ratio: number;
  }>;
};

export type StructureAnchorDecision = {
  proposal_id: string;
  front_face_id: string;
  quarter_turns: 0 | 1 | 2 | 3;
};

export type StructureConfirmationDecision = { anchor: StructureAnchorDecision };

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

export function assertCanAccessMockup(job: MockupJob, viewer: Viewer): void {
  if (!canAccessOwner(mockupOwner(job), viewer)) {
    throw Object.assign(new Error("没有权限"), { status: 403 });
  }
}

export function listJobsFor(viewer: Viewer): MockupJob[] {
  return listJobs().filter((job) => canAccessOwner(mockupOwner(job), viewer));
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

export function publicMockup(job: MockupJob) {
  return {
    id: job.id,
    status: job.status,
    title: job.title || "",
    error: job.error || job.job_error,
    created_at: job.created_at,
    owner: job.created_by || job.owner,
    files: (job.files || []).map((f) => ({ key: f.key, name: f.name })),
    job_kind: job.job_kind || "mockup",
    job_status: job.job_status,
    job_stage: job.job_stage,
    job_stage_label: job.job_stage_label,
    job_eta_s: job.job_eta_s,
    job_error: job.job_error,
    job_started_at: job.job_started_at,
    job_finished_at: job.job_finished_at,
    structure_engine: job.structure_engine,
    structure_status: job.structure_status,
    structure_code: job.structure_code,
    structure_message: job.structure_message,
    structure_preview: loadStructurePreview(job),
  };
}

function finiteNumbers(value: unknown, count: number): number[] | null {
  if (!Array.isArray(value) || value.length !== count) return null;
  const numbers = value.map(Number);
  return numbers.every(Number.isFinite) ? numbers : null;
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
  const path = job.structure_resolution_path;
  if (!path || !existsSync(path) || !underJobDir(job.id, path)) return undefined;
  try {
    const contents = readFileSync(path);
    if (contents.byteLength > 25 * 1024 * 1024) return undefined;
    const resolution = JSON.parse(contents.toString("utf8")) as {
      topology?: { face_proposal?: unknown[]; net_proposals?: unknown[] };
      structure?: { source?: { page_size?: unknown } };
    };
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
          !isStructureProposalId(id) ||
          faceIdsRaw.length !== 6 ||
          new Set(faceIdsRaw).size !== 6 ||
          bodyIds.length !== 4 ||
          new Set(bodyIds).size !== 4 ||
          capIds.length !== 2 ||
          new Set(capIds).size !== 2 ||
          new Set([...bodyIds, ...capIds]).size !== 6 ||
          !stripAxis ||
          bodyIds.some((faceId) => !faceIdsRaw.includes(faceId)) ||
          capIds.some((faceId) => !faceIdsRaw.includes(faceId)) ||
          faceIdsRaw.some((faceId) => !faceIds.has(faceId))
        ) {
          continue;
        }
        const dimensions = positiveDimensions(net.dimensions_mm);
        const rawAnchors = Array.isArray(net.valid_anchors) ? net.valid_anchors : undefined;
        if (net.dimensions_mm !== undefined && !dimensions) continue;
        if (net.valid_anchors !== undefined && !rawAnchors) continue;
        const validAnchors: NonNullable<StructureNetProposal["valid_anchors"]> = [];
        if (rawAnchors && rawAnchors.length <= 4) {
          for (const rawAnchor of rawAnchors) {
            if (!rawAnchor || typeof rawAnchor !== "object" || Array.isArray(rawAnchor)) continue;
            const anchor = rawAnchor as Record<string, unknown>;
            const frontFaceId = typeof anchor.front_face_id === "string" ? anchor.front_face_id : "";
            const turns = Array.isArray(anchor.quarter_turns)
              ? anchor.quarter_turns.map(Number).filter((turn) => Number.isInteger(turn) && turn >= 0 && turn <= 3)
              : [];
            if (!bodyIds.includes(frontFaceId) || !turns.length || new Set(turns).size !== turns.length) continue;
            validAnchors.push({
              front_face_id: frontFaceId,
              quarter_turns: turns as Array<0 | 1 | 2 | 3>,
            });
          }
        }
        if (rawAnchors && !validAnchors.length) continue;
        const rawClosures = Array.isArray(net.closure_assemblies) ? net.closure_assemblies : undefined;
        if (net.closure_assemblies !== undefined && !rawClosures) continue;
        const closures: NonNullable<StructureNetProposal["closure_assemblies"]> = [];
        if (rawClosures && rawClosures.length === 2) {
          for (const rawClosure of rawClosures) {
            if (!rawClosure || typeof rawClosure !== "object" || Array.isArray(rawClosure)) continue;
            const closure = rawClosure as Record<string, unknown>;
            const faceId = typeof closure.face_id === "string" ? closure.face_id : "";
            const bodyId = typeof closure.attached_body_face_id === "string" ? closure.attached_body_face_id : "";
            const side = closure.side === -1 || closure.side === 1 ? closure.side : null;
            const extent = closure.extent === "full" || closure.extent === "partial" ? closure.extent : null;
            const ratio = Number(closure.coverage_ratio);
            if (
              !capIds.includes(faceId)
              || !bodyIds.includes(bodyId)
              || side === null
              || !extent
              || !Number.isFinite(ratio)
              || ratio <= 0
              || ratio > 1
            ) continue;
            closures.push({
              face_id: faceId,
              attached_body_face_id: bodyId,
              side,
              extent,
              coverage_ratio: ratio,
            });
          }
        }
        if (rawClosures && closures.length !== 2) continue;
        netProposals.push({
          id,
          face_ids: faceIdsRaw,
          body_face_ids: bodyIds as StructureNetProposal["body_face_ids"],
          cap_face_ids: capIds as StructureNetProposal["cap_face_ids"],
          strip_axis: stripAxis,
          ...(bounds ? { bounds_mm: bounds as StructureNetProposal["bounds_mm"] } : {}),
          ...(dimensions ? { dimensions_mm: dimensions } : {}),
          ...(validAnchors.length ? { valid_anchors: validAnchors } : {}),
          ...(closures.length === 2 ? { closure_assemblies: closures } : {}),
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
  saveMockup(job);
  return job;
}

export function isWhiteFile(key: string, name: string): boolean {
  const lower = name.toLowerCase();
  if (key === "white_a") return lower.includes("front_right");
  if (key === "white_b") return lower.includes("back_left");
  return true;
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
        else if (lower.endsWith(".png") && lower.includes("front_right")) key = "white_a";
        else if (lower.endsWith(".png") && lower.includes("back_left")) key = "white_b";
        else continue;
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

export function isMockupJobFile(jobId: string, path: string | null | undefined): path is string {
  return Boolean(path && existsSync(path) && underJobDir(jobId, path));
}

export function fileOf(job: MockupJob, key: string) {
  const f = job.files.find((x) => x.key === key);
  if (!f) return undefined;
  if (f.path && existsSync(f.path) && underJobDir(job.id, f.path)) return f;
  const dir = join(mockupRoot(), job.id);
  const guess = join(dir, basename(f.name || "file"));
  if (existsSync(guess) && underJobDir(job.id, guess)) return { ...f, path: guess };
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
