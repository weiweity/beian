import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR, PACKAGING } from "./config.js";
import { blenderBin } from "./settings.js";
import { runPackaging } from "./workers.js";

export type MockupJob = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  error?: string;
  created_at: string;
  files: { key: string; path: string; name: string }[];
};

const jobs = new Map<string, MockupJob>();
let busy = false;

function mockupRoot() {
  const d = join(DATA_DIR, "mockups");
  mkdirSync(d, { recursive: true });
  return d;
}

function findBlender(): string | null {
  const env = blenderBin() || process.env.BLENDER_EXECUTABLE;
  if (env && existsSync(env)) return env;
  try {
    const out = execFileSync("which", ["blender"], { encoding: "utf8" }).trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

export function getJob(id: string): MockupJob | undefined {
  return jobs.get(id);
}

export function listJobs(): MockupJob[] {
  return [...jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** JSON for the webpage: keep key/name, drop disk paths. */
export function publicMockup(job: MockupJob) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    created_at: job.created_at,
    files: job.files.map((f) => ({ key: f.key, name: f.name })),
  };
}

export async function startMockup(opts: {
  id: string;
  sourcePath: string;
  displayName: string;
}): Promise<MockupJob> {
  if (busy) {
    throw Object.assign(new Error("打样台一次只能跑一单"), { status: 409 });
  }
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
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const job: MockupJob = {
    id: opts.id,
    status: "queued",
    created_at: new Date().toISOString(),
    files: [],
  };
  jobs.set(opts.id, job);
  busy = true;
  job.status = "running";
  try {
    const r = await runPackaging(manifestPath);
    if (r.code !== 0) {
      job.status = "failed";
      job.error = (r.stderr || r.stdout || "流水线失败").slice(0, 800);
    } else {
      job.status = "done";
      job.files = collectOutputs(outDir);
    }
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
  }
  return job;
}

function collectOutputs(root: string): MockupJob["files"] {
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

export function fileOf(job: MockupJob, key: string) {
  return job.files.find((f) => f.key === key);
}
