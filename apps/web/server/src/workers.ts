import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { DATA_DIR, PACKAGING, PYTHON, PYTHON_APP } from "./config.js";
import { pythonBin } from "./settings.js";

export type RunPythonResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  pid?: number;
};

export type RunPythonOpts = {
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  onStderrLine?: (line: string) => void;
  onSpawn?: (pid: number) => void;
};

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killTree(pid: number, force = false): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    const args = force ? ["/T", "/F", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
    try {
      execFileSync("taskkill", args, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function pythonExecutable(): string {
  const configured = pythonBin();
  if (existsSync(configured)) return configured;
  if (existsSync(PYTHON)) return PYTHON;
  return "python3";
}

function feedLines(chunk: string, rest: string, onLine?: (line: string) => void): string {
  const text = rest + chunk;
  const parts = text.split(/\r?\n/);
  const keep = parts.pop() ?? "";
  if (onLine) {
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  }
  return keep;
}

export function runPython(opts: RunPythonOpts): Promise<RunPythonResult> {
  const cwd = opts.cwd ?? PYTHON_APP;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), opts.args, {
      cwd,
      env: { ...process.env, PYTHONPATH: PYTHON_APP, WB_DATA_DIR: DATA_DIR },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid && opts.onSpawn) opts.onSpawn(pid);
    let stdout = "";
    let stderr = "";
    let stderrRest = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, timedOut, pid });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) killTree(pid, false);
      setTimeout(() => {
        if (settled) return;
        if (pid) killTree(pid, true);
      }, 5_000);
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      const chunk = String(d);
      stderr += chunk;
      stderrRest = feedLines(chunk, stderrRest, opts.onStderrLine);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stderrRest.trim() && opts.onStderrLine) opts.onStderrLine(stderrRest.trim());
      finish(code ?? 1);
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
  onStderrLine?: (line: string) => void;
  onSpawn?: (pid: number) => void;
}): Promise<RunPythonResult> {
  return runPython({
    args: [
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
    ],
    timeoutMs: 180_000,
    onStderrLine: opts.onStderrLine,
    onSpawn: opts.onSpawn,
  });
}

export async function reworkTask(opts: {
  tid: string;
  pdf: string;
  actor: string;
  onStderrLine?: (line: string) => void;
  onSpawn?: (pid: number) => void;
}): Promise<RunPythonResult> {
  return runPython({
    args: [
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
    ],
    timeoutMs: 180_000,
    onStderrLine: opts.onStderrLine,
    onSpawn: opts.onSpawn,
  });
}

export async function runPackaging(
  manifestPath: string,
  hooks?: { onStderrLine?: (line: string) => void; onSpawn?: (pid: number) => void },
): Promise<RunPythonResult> {
  return runPython({
    args: ["pipeline.py", manifestPath, "--workers", "1"],
    cwd: PACKAGING,
    timeoutMs: 420_000,
    onStderrLine: hooks?.onStderrLine,
    onSpawn: hooks?.onSpawn,
  });
}
