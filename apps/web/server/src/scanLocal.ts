import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { PYTHON_APP } from "./config.js";

export type ScanKind = "blender" | "illustrator" | "python";
export type ScanHit = { kind: ScanKind; label: string; path: string };

const SCAN_MS = 8_000;
const MAX_HITS = 24;

function dirs(): string[] {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    return [
      "C:\\Program Files\\Blender Foundation",
      "C:\\Program Files\\Adobe",
      "C:\\Program Files (x86)\\Adobe",
      local ? join(local, "Programs") : "",
      PYTHON_APP,
    ].filter(Boolean);
  }
  return ["/Applications", "/usr/local/bin", "/opt/homebrew/bin", PYTHON_APP];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function classify(name: string, full: string): ScanHit | null {
  const n = name.toLowerCase();
  if (n === "blender" || n === "blender.exe") {
    const parent = basename(full.replace(/[\\/][^\\/]+$/, "") || "");
    return { kind: "blender", label: parent.includes("Blender") ? parent : "Blender", path: full };
  }
  if (n === "illustrator" || n === "illustrator.exe") {
    const parent = full.match(/Adobe Illustrator [^\\/]+/i)?.[0] || "Illustrator";
    return { kind: "illustrator", label: parent, path: full };
  }
  if (n === "python" || n === "python.exe" || n === "python3") {
    if (/[/\\]\.venv[/\\]/.test(full)) {
      return { kind: "python", label: "对照 .venv", path: full };
    }
  }
  return null;
}

function walk(root: string, depth: number, deadline: number, out: ScanHit[]): void {
  if (Date.now() > deadline || out.length >= MAX_HITS || depth < 0) return;
  if (!isDir(root)) return;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (Date.now() > deadline || out.length >= MAX_HITS) return;
    if (name === "." || name === ".." || name === "node_modules") continue;
    const full = join(root, name);
    if (isFile(full)) {
      const hit = classify(name, full);
      if (hit && !out.some((h) => h.path === hit.path)) out.push(hit);
      continue;
    }
    walk(full, depth - 1, deadline, out);
  }
}

function pathHits(): ScanHit[] {
  const names =
    process.platform === "win32" ? ["blender.exe", "blender", "illustrator.exe"] : ["blender"];
  const finder = process.platform === "win32" ? "where" : "which";
  const hits: ScanHit[] = [];
  for (const name of names) {
    try {
      const out = execFileSync(finder, [name], { encoding: "utf8", timeout: 3000 });
      for (const line of out.split(/\r?\n/)) {
        const full = line.trim();
        if (!full || !isFile(full)) continue;
        const hit = classify(basename(full), full);
        if (hit && !hits.some((h) => h.path === hit.path)) hits.push(hit);
      }
    } catch {
      /* not on PATH */
    }
  }
  return hits;
}

/** 白名单目录浅扫，再补 PATH。不执行找到的文件。 */
export function scanLocalApps(now = Date.now()): { hits: ScanHit[]; timedOut: boolean; roots: string[] } {
  const roots = dirs().filter((d) => existsSync(d));
  const hits: ScanHit[] = pathHits();
  const deadline = now + SCAN_MS;
  for (const root of roots) {
    walk(root, 4, deadline, hits);
    if (Date.now() > deadline) break;
  }
  return { hits, timedOut: Date.now() > deadline, roots };
}
