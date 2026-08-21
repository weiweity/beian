import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR, PACKAGING } from "./config.js";
import { blenderBin } from "./settings.js";
import { isTid, replaceFile } from "./tasks.js";

export type MockupJob = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  error?: string;
  created_at: string;
  files: { key: string; path?: string; name: string }[];
  owner?: string;
  source_path?: string;
  manifest_path?: string;
  job_kind?: "mockup";
  job_status?: "queued" | "running" | "succeeded" | "failed";
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
};

const cache = new Map<string, MockupJob>();

function mockupRoot() {
  const d = join(DATA_DIR, "mockups");
  mkdirSync(d, { recursive: true });
  return d;
}

function jobPath(id: string) {
  return join(mockupRoot(), id, "job.json");
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
  cache.set(job.id, job);
}

export function loadMockup(id: string): MockupJob | undefined {
  if (!isTid(id)) return undefined;
  const hit = cache.get(id);
  if (hit) return hit;
  const p = jobPath(id);
  if (!existsSync(p)) return undefined;
  try {
    const job = JSON.parse(readFileSync(p, "utf8")) as MockupJob;
    cache.set(id, job);
    return job;
  } catch {
    return undefined;
  }
}

export function getJob(id: string): MockupJob | undefined {
  return loadMockup(id);
}

export function mockupOwner(job: MockupJob): string {
  return String(job.owner || "");
}

export function assertCanAccessMockup(job: MockupJob, viewer: { name: string; admin: boolean }): void {
  if (viewer.admin) return;
  const owner = mockupOwner(job);
  if (owner && owner !== viewer.name) {
    throw Object.assign(new Error("没有权限"), { status: 403 });
  }
}

export function listJobsFor(viewer: { name: string; admin: boolean }): MockupJob[] {
  return listJobs().filter((job) => {
    if (viewer.admin) return true;
    const owner = mockupOwner(job);
    return !owner || owner === viewer.name;
  });
}

export function loadAllMockups(): MockupJob[] {
  const root = mockupRoot();
  const out: MockupJob[] = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const job = loadMockup(name.name);
    if (job) out.push(job);
  }
  return out;
}

export function listJobs(): MockupJob[] {
  return loadAllMockups().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function publicMockup(job: MockupJob) {
  return {
    id: job.id,
    status: job.status,
    error: job.error || job.job_error,
    created_at: job.created_at,
    owner: job.owner,
    files: (job.files || []).map((f) => ({ key: f.key, name: f.name })),
    job_kind: job.job_kind || "mockup",
    job_status: job.job_status,
    job_stage: job.job_stage,
    job_stage_label: job.job_stage_label,
    job_eta_s: job.job_eta_s,
    job_error: job.job_error,
    job_started_at: job.job_started_at,
    job_finished_at: job.job_finished_at,
  };
}

export function collectOutputs(root: string): MockupJob["files"] {
  const found: MockupJob["files"] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (/\.(glb|png|pptx)$/i.test(name.name)) {
        let key = "other";
        if (name.name.endsWith(".glb")) key = "glb";
        else if (name.name.endsWith(".pptx")) key = "ppt";
        else if (name.name.includes("front_right")) key = "white_a";
        else if (name.name.includes("back_left")) key = "white_b";
        else if (name.name.endsWith(".png") && key === "other") {
          key = found.some((f) => f.key === "white_a") ? "white_b" : "white_a";
        }
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

export function fileOf(job: MockupJob, key: string) {
  const f = job.files.find((x) => x.key === key);
  if (!f) return undefined;
  if (f.path && existsSync(f.path) && underJobDir(job.id, f.path)) return f;
  const dir = join(mockupRoot(), job.id);
  const guess = join(dir, basename(f.name || "file"));
  if (existsSync(guess) && underJobDir(job.id, guess)) return { ...f, path: guess };
  return undefined;
}

export function assertBlenderReady(): string {
  const blender = findBlender();
  if (!blender) {
    throw Object.assign(
      new Error("本机找不到 Blender 可执行文件。请安装 Blender 或设置 BLENDER_EXECUTABLE。"),
      { status: 412 },
    );
  }
  const template = join(PACKAGING, "templates/flower_box_47_5x47_5x177_5.json");
  if (!existsSync(template)) {
    throw Object.assign(new Error("缺少花盒模板"), { status: 412 });
  }
  return blender;
}

export function queueMockup(opts: {
  id: string;
  sourcePath: string;
  displayName: string;
}): MockupJob {
  const blender = assertBlenderReady();
  const template = join(PACKAGING, "templates/flower_box_47_5x47_5x177_5.json");
  const outDir = join(mockupRoot(), opts.id);
  mkdirSync(outDir, { recursive: true });
  const manifest = {
    pipeline_name: "审稿室打样",
    output_root: outDir,
    workers: 1,
    blender_executable: blender,
    illustrator: { enabled: false },
    generate_ppt: true,
    products: [
      {
        code: opts.id.slice(0, 8),
        slug: "pack",
        display_name: opts.displayName.slice(0, 40),
        source_ai: opts.sourcePath,
        template,
      },
    ],
  };
  const manifestPath = join(outDir, "manifest.json");
  replaceFile(manifestPath, JSON.stringify(manifest, null, 2));
  const job: MockupJob = {
    id: opts.id,
    status: "queued",
    created_at: new Date().toISOString(),
    files: [],
    owner: opts.displayName,
    source_path: opts.sourcePath,
    manifest_path: manifestPath,
    job_kind: "mockup",
    job_status: "queued",
  };
  saveMockup(job);
  return job;
}
