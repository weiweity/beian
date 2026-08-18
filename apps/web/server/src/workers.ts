import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { DATA_DIR, PACKAGING, PYTHON, PYTHON_APP } from "./config.js";
import { pythonBin } from "./settings.js";

export function runPython(args: string[], cwd = PYTHON_APP, timeoutMs = 180_000): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const configured = pythonBin();
    const bin = existsSync(configured) ? configured : existsSync(PYTHON) ? PYTHON : "python3";
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, PYTHONPATH: PYTHON_APP, WB_DATA_DIR: DATA_DIR },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error("worker 超时"), { status: 504 }));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function compareTask(opts: {
  tid: string;
  excel: string;
  pdf: string;
  productName: string;
  title: string;
  surface: string;
  actor: string;
}): Promise<void> {
  const r = await runPython([
    "-m",
    "app.cli",
    "compare",
    "--tid",
    opts.tid,
    "--excel",
    opts.excel,
    "--pdf",
    opts.pdf,
    "--product-name",
    opts.productName,
    "--title",
    opts.title,
    "--surface",
    opts.surface,
    "--actor",
    opts.actor,
    "--data-dir",
    DATA_DIR,
  ]);
  if (r.code !== 0) {
    throw Object.assign(new Error(r.stderr || r.stdout || "对照失败"), { status: 500 });
  }
}

export async function reworkTask(opts: { tid: string; pdf: string; actor: string }): Promise<void> {
  const r = await runPython([
    "-m",
    "app.cli",
    "rework",
    "--tid",
    opts.tid,
    "--pdf",
    opts.pdf,
    "--actor",
    opts.actor,
    "--data-dir",
    DATA_DIR,
  ]);
  if (r.code !== 0) {
    throw Object.assign(new Error(r.stderr || r.stdout || "对红失败"), { status: 500 });
  }
}

export async function runPackaging(manifestPath: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return runPython([manifestPath, "--workers", "1"], PACKAGING, 420_000);
}
