/**
 * F02 只读 Windows 服务探测：固定查询 beian-server-8787 与 cloudflared。
 * 不接受任意 shell 命令；不 Start/Stop/Restart。适配器在交给核心前映射 observed 词表。
 */
export const SERVICE_NAMES = Object.freeze(["beian-server-8787", "cloudflared"]);

const NUMERIC_STATUS = Object.freeze({
  1: "stopped",
  2: "start_pending",
  3: "stop_pending",
  4: "running",
  5: "continue_pending",
  6: "pause_pending",
  7: "paused",
});

const STRING_STATUS = Object.freeze({
  running: "running",
  stopped: "stopped",
  paused: "paused",
  missing: "missing",
  unknown: "unknown",
  startpending: "start_pending",
  start_pending: "start_pending",
  stoppending: "stop_pending",
  stop_pending: "stop_pending",
  continuepending: "continue_pending",
  continue_pending: "continue_pending",
  pausepending: "pause_pending",
  pause_pending: "pause_pending",
});


export function powershellExe(env = process.env) {
  const root = env.SystemRoot || "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

export function buildWindowsArgv(scriptPath) {
  if (!scriptPath || typeof scriptPath !== "string") {
    throw new Error("script_path_required");
  }
  return Object.freeze([
    powershellExe(),
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
  ]);
}

export function mapServiceObserved(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) return null;
    return NUMERIC_STATUS[raw] ?? null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^-?\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isInteger(n) ? NUMERIC_STATUS[n] ?? null : null;
    }
    const compact = trimmed.toLowerCase().replaceAll(" ", "");
    return STRING_STATUS[compact] ?? STRING_STATUS[compact.replaceAll("_", "")] ?? null;
  }
  return null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseServiceStdout(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { error: "non_json" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "bad_json" };
  }
  if (Array.isArray(parsed)) return { rows: parsed };
  if (isPlainObject(parsed)) return { rows: [parsed] };
  return { error: "non_json" };
}

function rowName(row) {
  if (!isPlainObject(row)) return null;
  const value = row.name ?? row.Name;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rowStatus(row) {
  if (!isPlainObject(row)) return null;
  if (!Object.prototype.hasOwnProperty.call(row, "status") && !Object.prototype.hasOwnProperty.call(row, "Status")) {
    return null;
  }
  const value = row.status ?? row.Status;
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

export function canonicalServiceName(name) {
  if (typeof name !== "string") return null;
  const lower = name.toLowerCase();
  return SERVICE_NAMES.find((item) => item.toLowerCase() === lower) ?? null;
}

export function serviceFactFromRow(row) {
  const name = rowName(row);
  const status = rowStatus(row);
  if (!name || status == null || status === "") {
    return { fact: { kind: "windows_service" }, reason: "incomplete_fields" };
  }
  if (typeof status === "string" && status.trim().toLowerCase() === "permission") {
    return { fact: { kind: "windows_service", sample_ok: false }, reason: "permission" };
  }
  const observed = mapServiceObserved(status);
  if (observed == null) {
    return { fact: { kind: "windows_service", sample_ok: true }, reason: "unrecognized_observed" };
  }
  return { fact: { kind: "windows_service", sample_ok: true, observed } };
}
