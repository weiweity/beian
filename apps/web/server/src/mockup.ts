import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR, PACKAGING } from "./config.js";
import { blenderBin } from "./settings.js";
import { isTid, replaceFile } from "./tasks.js";

export type MockupJob = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  title?: string;
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

export function resetMockupCache(): void {
  cache.clear();
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
  cache.set(job.id, job);
}

export function loadMockup(id: string): MockupJob | undefined {
  if (!isTid(id)) return undefined;
  const p = jobPath(id, false);
  if (!existsSync(p)) {
    cache.delete(id);
    return undefined;
  }
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const job = JSON.parse(readFileSync(p, "utf8")) as MockupJob;
    cache.set(id, job);
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
    title: job.title || "",
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
  if (
    job.status === "queued" ||
    job.status === "running" ||
    job.job_status === "queued" ||
    job.job_status === "running"
  ) {
    throw Object.assign(new Error("打样还在跑，不能删。等结束或失败后再删。"), { status: 409 });
  }
  cache.delete(job.id);
  rmSync(join(mockupRoot(false), job.id), { recursive: true, force: true });
}

export function queueMockup(opts: {
  id: string;
  sourcePath: string;
  displayName: string;
  title?: string;
}): MockupJob {
  const blender = assertBlenderReady();
  const template = defaultTemplatePath();
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
        display_name: (opts.title || opts.displayName).slice(0, 40),
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
    title: (opts.title || "").trim().slice(0, 80),
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
