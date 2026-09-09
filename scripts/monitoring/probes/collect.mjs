/**
 * F02 只读单次采样：把 Windows 服务与显式 HTTP health 收成 alert-core 可接受的 sample。
 * 不读生产配置，无常驻调度器，不发送消息。生产路径不导入 alert-core。
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  SERVICE_NAMES,
  buildWindowsArgv,
  canonicalServiceName,
  parseServiceStdout,
  serviceFactFromRow,
} from "./windows-service.mjs";
import {
  assertProbeUrl,
  defaultHttpGet,
  probeHttpHealth,
} from "./http-health.mjs";

export { mapServiceObserved, buildWindowsArgv, powershellExe, parseServiceStdout } from "./windows-service.mjs";

export const DEFAULT_TIMEOUT_MS = 8000;
export const GET_SERVICES_PS1 = fileURLToPath(new URL("./get-services.ps1", import.meta.url));

const FAILED_SERVICE = Object.freeze({ kind: "windows_service", sample_ok: false });

function isoNow(now) {
  const value = now();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  throw new Error("invalid_now");
}

function failedPair(reason) {
  const reasons = {};
  const facts = {};
  for (const name of SERVICE_NAMES) {
    facts[name] = { ...FAILED_SERVICE };
    reasons[name] = reason;
  }
  return { facts, reasons };
}

function defaultExec(argv, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("cancelled"), { reason: "cancelled" }));
      return;
    }
    let child;
    const onAbort = () => { child?.kill(); };
    const [file, ...args] = argv;
    child = execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          const wrapped = new Error("cancelled");
          wrapped.reason = "cancelled";
          reject(wrapped);
          return;
        }
        if (err && err.killed) {
          const wrapped = new Error("timeout");
          wrapped.reason = "timeout";
          reject(wrapped);
          return;
        }
        if (err && err.code === "ENOENT") {
          const wrapped = new Error("missing_executable");
          wrapped.reason = "missing_executable";
          reject(wrapped);
          return;
        }
        resolve({
          stdout: stdout || "",
          stderr: typeof stderr === "string" ? stderr : "",
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        });
      },
    );
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function factsFromStdout(stdout) {
  const parsed = parseServiceStdout(stdout);
  if (parsed.error) {
    return failedPair(parsed.error);
  }
  const byName = new Map();
  for (const row of parsed.rows) {
    const canonical = canonicalServiceName(row?.name ?? row?.Name);
    if (!canonical || byName.has(canonical)) continue;
    byName.set(canonical, serviceFactFromRow(row));
  }
  const facts = {};
  const reasons = {};
  for (const name of SERVICE_NAMES) {
    const row = byName.get(name);
    if (!row) {
      facts[name] = { kind: "windows_service" };
      reasons[name] = "incomplete_fields";
      continue;
    }
    facts[name] = row.fact;
    if (row.reason) reasons[name] = row.reason;
  }
  return { facts, reasons };
}

async function collectServices({ exec, platform, timeoutMs, signal, injectedExec }) {
  if (!injectedExec && platform !== "win32") {
    return failedPair("platform_not_windows");
  }
  const argv = buildWindowsArgv(GET_SERVICES_PS1);
  try {
    const result = await exec(argv, { timeoutMs, signal });
    if (result?.code !== 0) return failedPair("command_failed");
    return factsFromStdout(result?.stdout);
  } catch (err) {
    const reason = signal?.aborted
      ? "cancelled"
      : ["timeout", "cancelled", "permission", "missing_executable"].includes(err?.reason)
        ? err.reason
        : "sample_failed";
    return failedPair(reason);
  }
}

export function createProbe(deps = {}) {
  const now = deps.now ?? (() => new Date());
  const injectedExec = typeof deps.exec === "function";
  const exec = injectedExec ? deps.exec : defaultExec;
  const httpGet = typeof deps.httpGet === "function" ? deps.httpGet : defaultHttpGet;
  const platform = deps.platform ?? process.platform;
  const platform_claim = injectedExec ? "mock" : platform === "win32" ? "windows" : "not_windows";

  async function collectSample(options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid_timeout");
    if (options.loopbackUrl) assertProbeUrl(options.loopbackUrl, "loopback");
    if (options.publicUrl) assertProbeUrl(options.publicUrl, "public");

    const sampled_at = isoNow(now);
    const serviceTask = collectServices({
      exec,
      platform,
      timeoutMs,
      signal: options.signal,
      injectedExec,
    });

    const httpTasks = [];
    if (options.loopbackUrl) {
      httpTasks.push(
        probeHttpHealth({
          target: "loopback",
          url: options.loopbackUrl,
          httpGet,
          timeoutMs,
          signal: options.signal,
        }).then((row) => ["loopback", row]),
      );
    }
    if (options.publicUrl) {
      httpTasks.push(
        probeHttpHealth({
          target: "public",
          url: options.publicUrl,
          httpGet,
          timeoutMs,
          signal: options.signal,
        }).then((row) => ["public", row]),
      );
    }

    const [services, httpRows] = await Promise.all([serviceTask, Promise.all(httpTasks)]);
    const facts = { ...services.facts };
    const reasons = { ...services.reasons };
    if (httpRows.length) {
      const http_health = {};
      for (const [arm, row] of httpRows) {
        http_health[arm] = row.fact;
        if (row.reason) reasons[`http_health.${arm}`] = row.reason;
      }
      facts.http_health = http_health;
    }

    const sample = { sampled_at, facts };
    if (options.id != null && String(options.id).trim()) sample.id = String(options.id);
    if (Number.isInteger(options.sequence)) sample.sequence = options.sequence;
    return { sample, reasons, platform_claim };
  }

  return { collectSample, platform_claim };
}

export async function collectSample(options = {}) {
  const { now, httpGet, exec, platform, ...rest } = options;
  return createProbe({ now, httpGet, exec, platform }).collectSample(rest);
}
