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

export type WorkerProcessIdentity = {
  kind: "compare" | "rework" | "mockup";
  id: string;
};

export type WorkerProcessState = "owned" | "missing" | "other" | "unknown";

export const WORKER_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const WORKER_LINE_REST_LIMIT_CHARS = 64 * 1024;

class ByteTail {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  append(value: unknown): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    if (chunk.length >= WORKER_OUTPUT_LIMIT_BYTES) {
      this.chunks.length = 0;
      this.chunks.push(Buffer.from(chunk.subarray(chunk.length - WORKER_OUTPUT_LIMIT_BYTES)));
      this.bytes = WORKER_OUTPUT_LIMIT_BYTES;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > WORKER_OUTPUT_LIMIT_BYTES) {
      const first = this.chunks[0];
      const trim = this.bytes - WORKER_OUTPUT_LIMIT_BYTES;
      if (trim >= first.length) {
        this.chunks.shift();
        this.bytes -= first.length;
        continue;
      }
      this.chunks[0] = Buffer.from(first.subarray(trim));
      this.bytes -= trim;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processPresence(pid: number): "alive" | "missing" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "missing";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code || "") : "";
    return code === "ESRCH" ? "missing" : "unknown";
  }
}

function commandTokens(commandLine: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(commandLine))) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens.filter(Boolean);
}

/** Persisted PIDs are only hints. A command must prove both the worker kind and exact task id. */
export function workerCommandMatches(commandLine: string, expected: WorkerProcessIdentity): boolean {
  const tokens = commandTokens(commandLine);
  if (expected.kind === "mockup") {
    const pipeline = tokens.findIndex((token) => /(^|[\\/])pipeline\.py$/i.test(token));
    if (pipeline < 0) return false;
    const manifest = String(tokens[pipeline + 1] || "").replace(/\\/g, "/");
    return manifest.split("/").some((part) => part === expected.id);
  }
  const module = tokens.findIndex((token, index) => token === "app.cli" && tokens[index - 1] === "-m");
  if (module < 0 || tokens[module + 1] !== expected.kind) return false;
  const tidFlag = tokens.indexOf("--tid", module + 2);
  return tidFlag >= 0 && tokens[tidFlag + 1] === expected.id;
}

function processCommandLine(pid: number): string {
  if (process.platform === "win32") {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop`,
      "if ($null -eq $p) { exit 3 }",
      "[Console]::Out.Write($p.CommandLine)",
    ].join("; ");
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    });
  }
  return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
}

/** Query failures are unknown, never ownership. Callers may only kill the explicit owned state. */
export function inspectWorkerProcess(pid: number, expected: WorkerProcessIdentity): WorkerProcessState {
  const before = processPresence(pid);
  if (before === "missing") return "missing";
  try {
    const commandLine = processCommandLine(pid).trim();
    if (!commandLine) return processPresence(pid) === "missing" ? "missing" : "unknown";
    return workerCommandMatches(commandLine, expected) ? "owned" : "other";
  } catch {
    return processPresence(pid) === "missing" ? "missing" : "unknown";
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
  return keep.length > WORKER_LINE_REST_LIMIT_CHARS ? keep.slice(-WORKER_LINE_REST_LIMIT_CHARS) : keep;
}

export function runPython(opts: RunPythonOpts): Promise<RunPythonResult> {
  const cwd = opts.cwd ?? PYTHON_APP;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), opts.args, {
      cwd,
      env: { ...process.env, PYTHONPATH: PYTHON_APP, WB_DATA_DIR: DATA_DIR, PYTHONUTF8: "1" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid && opts.onSpawn) opts.onSpawn(pid);
    const stdout = new ByteTail();
    const stderr = new ByteTail();
    let stderrRest = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout: stdout.text(), stderr: stderr.text(), timedOut, pid });
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
      stdout.append(d);
    });
    child.stderr?.on("data", (d) => {
      const chunk = String(d);
      stderr.append(d);
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
