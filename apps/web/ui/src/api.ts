import { API_DOWN_LOCAL } from "./apiHint";
import { describeBrokenApi } from "./authGate";
import { UPLOAD_TOO_LARGE } from "./uploadLimit";

function apiHost(): string {
  return typeof window === "undefined" ? "" : window.location.host;
}

export class ApiError extends Error {
  status: number;
  brokenApi: boolean;
  constructor(status: number, message: string, brokenApi = false) {
    super(message);
    this.status = status;
    this.brokenApi = brokenApi;
  }
}

/** 开机探测：HTML / 空体 / 本机 Vite JSON 502 才点亮拒绝页。不要扫文案里有没有 8787。 */
export function brokenApiMessage(err: unknown, host = ""): string | null {
  if (err instanceof ApiError) return err.brokenApi ? err.message : null;
  return describeBrokenApi(0, "text/html", host);
}

export const GET_TIMEOUT_MS = 15_000;
const GET_RETRY_BASE_MS = 5_000;
const GET_RETRY_MAX_MS = 60_000;
type PendingGet = { epoch: number; promise: Promise<unknown> };
const pendingGets = new Map<string, PendingGet>();
const failedGets = new Map<string, { failures: number; retryAt: number; error: unknown }>();
let getEpoch = 0;

/** 写成功后废弃写前的轮询与退避；旧 GET 会转接到当前代次，不把旧列表交给页面。 */
function invalidateGetCache(): void {
  getEpoch += 1;
  pendingGets.clear();
  failedGets.clear();
}

function isGet(opts: RequestInit): boolean {
  return String(opts.method || "GET").toUpperCase() === "GET";
}

export function transientApiFailure(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 0 || err.status === 429 || [502, 503, 504, 524].includes(err.status);
  }
  return err instanceof TypeError || (err instanceof DOMException && err.name === "AbortError");
}

async function fetchJson<T>(path: string, opts: RequestInit): Promise<T> {
  const headers = new Headers(opts.headers);
  if (!(opts.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const controller = isGet(opts) ? new AbortController() : null;
  let timedOut = false;
  const abortFromCaller = () => controller?.abort(opts.signal?.reason);
  if (controller && opts.signal) opts.signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = controller
    ? globalThis.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, GET_TIMEOUT_MS)
    : undefined;
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...opts,
      signal: controller?.signal || opts.signal,
      headers,
    });
  } catch (err) {
    if (timedOut) throw new ApiError(0, "审稿服务响应超时，请稍后重试。", true);
    if (err instanceof TypeError) {
      const hint = describeBrokenApi(0, "text/html", apiHost()) || "审稿服务没回上。刷新后再试。";
      throw new ApiError(0, hint, true);
    }
    throw err;
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    if (controller && opts.signal) opts.signal.removeEventListener("abort", abortFromCaller);
  }
  const ct = res.headers.get("content-type") || "";
  if (res.status === 413) {
    throw new ApiError(413, UPLOAD_TOO_LARGE, false);
  }
  const hint = describeBrokenApi(res.status, ct, apiHost());
  if (!res.ok) {
    let detail = res.statusText;
    try {
      if (ct.includes("application/json")) {
        const body = (await res.json()) as { detail?: unknown };
        if (typeof body.detail === "string") detail = body.detail;
        else if (body.detail) detail = JSON.stringify(body.detail);
      }
    } catch {
      /* keep statusText */
    }
    const message = hint || detail || (res.status >= 500 ? "审稿服务暂时不可用，请稍后重试。" : "请求失败");
    throw new ApiError(res.status, message, Boolean(hint) || message === API_DOWN_LOCAL);
  }
  if (!ct.includes("application/json")) {
    throw new ApiError(res.status || 502, hint || "接口没有返回 JSON", true);
  }
  return (await res.json()) as T;
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  if (!isGet(opts)) {
    const body = await fetchJson<T>(path, opts);
    invalidateGetCache();
    return body;
  }

  const epoch = getEpoch;
  const failed = failedGets.get(path);
  if (failed && failed.retryAt > Date.now()) throw failed.error;
  const pending = pendingGets.get(path);
  if (pending && pending.epoch === epoch) return pending.promise as Promise<T>;

  let next!: Promise<T>;
  next = fetchJson<T>(path, opts)
    .then((body) => {
      if (epoch !== getEpoch) return request<T>(path, opts);
      failedGets.delete(path);
      return body;
    })
    .catch((err) => {
      if (epoch !== getEpoch) return request<T>(path, opts);
      if (transientApiFailure(err)) {
        const failures = (failedGets.get(path)?.failures || 0) + 1;
        const retryDelay = Math.min(GET_RETRY_BASE_MS * 2 ** (failures - 1), GET_RETRY_MAX_MS);
        failedGets.set(path, { failures, retryAt: Date.now() + retryDelay, error: err });
      }
      throw err;
    })
    .finally(() => {
      if (pendingGets.get(path)?.promise === next) pendingGets.delete(path);
    });
  pendingGets.set(path, { epoch, promise: next });
  return next;
}

export type UploadReceipt = {
  receipt: string;
  client_upload_id?: string;
  files: { field: string; name: string; bytes: number }[];
};

export type PendingUploadReceipt = {
  id: string;
  files: { field: string; name: string; bytes: number }[];
  bytes: number;
  created_at: string;
  client_upload_id?: string;
  kind: "compare" | "mockup";
};

export type UploadProgress = { pct: number; loaded: number; total: number };

// 100 MB 在慢链路上传输可能超过五分钟；超时覆盖传输和服务端落盘确认。
export const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

export function uploadWithProgress<T>(
  path: string,
  fd: FormData,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<T> {
  if (typeof XMLHttpRequest === "undefined") {
    return request<T>(path, { method: "POST", body: fd, signal });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let abortListener: (() => void) | undefined;
    const cleanup = () => {
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    };
    const fail = (err: ApiError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (body: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      invalidateGetCache();
      resolve(body);
    };
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (ev) => {
      if (!onProgress || !ev.lengthComputable || ev.total <= 0) return;
      onProgress({
        pct: Math.max(0, Math.min(100, Math.round((ev.loaded / ev.total) * 100))),
        loaded: ev.loaded,
        total: ev.total,
      });
    };
    if (signal) {
      if (signal.aborted) {
        fail(new ApiError(0, "上传已停止", false));
        return;
      }
      abortListener = () => xhr.abort();
      signal.addEventListener("abort", abortListener, { once: true });
    }
    xhr.onabort = () => fail(new ApiError(0, "上传已停止", false));
    xhr.onload = () => {
      const ct = xhr.getResponseHeader("content-type") || "";
      if (xhr.status === 413) {
        fail(new ApiError(413, UPLOAD_TOO_LARGE, false));
        return;
      }
      let detail = xhr.statusText;
      try {
        if (ct.includes("application/json") && xhr.responseText) {
          const body = JSON.parse(xhr.responseText) as T & { detail?: unknown };
          if (xhr.status >= 200 && xhr.status < 300) {
            succeed(body);
            return;
          }
          if (typeof body.detail === "string") detail = body.detail;
        }
      } catch {
        /* keep statusText */
      }
      const hint = describeBrokenApi(xhr.status, ct, apiHost());
      fail(new ApiError(xhr.status, hint || detail, Boolean(hint)));
    };
    xhr.onerror = () => fail(new ApiError(0, "上传中断。请检查网络后重新上传。", true));
    xhr.ontimeout = () => fail(new ApiError(0, "上传超时。请检查网络后重新上传。", false));
    xhr.send(fd);
  });
}

export type Me = {
  logged_in: boolean;
  display_name: string | null;
  avatar_url?: string | null;
  role: string | null;
  open_id?: string;
  perms: string[];
};

export type HealthView = {
  ok?: boolean;
  jobs?: unknown;
  feishu_notify?: boolean;
  version?: string;
  runtime?: string;
};

export type TaskSummary = {
  id: string;
  title: string;
  product_name?: string;
  type: string;
  status: string;
  created_at?: string;
  summary?: unknown;
  owner?: string;
  completed_by?: string;
  board?: "comparing" | "failed" | "review" | "done";
  error?: string;
  round?: number;
  job_kind?: string;
  job_status?: string;
  job_stage?: string;
  job_stage_label?: string;
  job_eta_s?: number;
  job_error?: string;
  job_started_at?: string;
  job_finished_at?: string;
  queue_ahead?: number;
};

export type FieldHit = {
  id?: string;
  field?: string;
  status?: string;
  excel?: string;
  excel_value?: string;
  pdf?: string;
  expected?: string;
  found?: string;
  page?: number | string;
  note?: string;
  decision?: string;
  bboxes?: Array<Record<string, unknown>>;
  coverage?: { miss?: string[]; hit?: string[]; ratio?: number; matched?: number; total?: number };
  evidence?: string;
  sequence_diff?: { only_in_excel?: string[] };
};

export type TaskPage = {
  url?: string;
  name?: string;
  page?: number;
  width?: number;
  height?: number;
};

export type TaskDetail = TaskSummary & {
  hits?: FieldHit[];
  hits_v2?: FieldHit[];
  disclaimer?: string;
  pack_surface?: string;
  pages?: TaskPage[];
  pages_v2?: TaskPage[];
  round?: number;
  rework_check?: Array<{
    field?: string;
    v1_status?: string;
    v2_status?: string;
    expected_text?: string;
    observed_text?: string;
    page?: number | string;
  }>;
  conclusion?: string;
  complete_kind?: string;
};

export type Decision = "confirm" | "issue" | "ignore" | "pending";

export const api = {
  me: () => request<Me>("/api/auth/me"),
  health: () => request<HealthView>("/api/health"),
  status: () => request<HealthView>("/api/status"),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  tasks: (q?: string) =>
    request<TaskSummary[]>(q ? `/api/tasks?q=${encodeURIComponent(q)}` : "/api/tasks"),
  task: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),
  uploads: () => request<PendingUploadReceipt[]>("/api/uploads"),
  discardUpload: (id: string) => request<{ ok: boolean }>(`/api/uploads/${id}`, { method: "DELETE" }),
  stageUpload: (fd: FormData, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal) =>
    uploadWithProgress<UploadReceipt>("/api/uploads", fd, onProgress, signal),
  startTask: (body: { receipt: string; product_name: string; title?: string; pack_surface?: string }) =>
    request<TaskDetail>("/api/tasks/start", { method: "POST", body: JSON.stringify(body) }),
  startMockup: (body: { receipt: string; title?: string; product_name?: string }) =>
    request<MockupJob>("/api/mockups/start", { method: "POST", body: JSON.stringify(body) }),
  confirmMockupStructure: (
    id: string,
    faces: Array<{
      id: string;
      role: "front" | "right" | "back" | "left" | "top" | "bottom";
      quarter_turns: 0 | 1 | 2 | 3;
    }>,
  ) =>
    request<MockupJob>(`/api/mockups/${id}/structure`, {
      method: "POST",
      body: JSON.stringify({ faces }),
    }),
  decide: (id: string, body: { hit_id: string; decision: Decision; note?: string }) =>
    request<TaskDetail>(`/api/tasks/${id}/decision`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  complete: (id: string, body: { conclusion: string }) =>
    request<TaskDetail>(`/api/tasks/${id}/complete`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  rework: (id: string, fd: FormData) =>
    request<TaskDetail>(`/api/tasks/${id}/rework`, { method: "POST", body: fd }),
  mockups: () => request<MockupJob[]>("/api/mockups"),
  mockup: (id: string) => request<MockupJob>(`/api/mockups/${id}`),
  deleteTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
  deleteMockup: (id: string) => request<{ ok: boolean }>(`/api/mockups/${id}`, { method: "DELETE" }),
  settings: () => request<SettingsView>("/api/settings"),
  saveSettings: (values: Record<string, string>) =>
    request<SettingsView & { restart?: boolean }>("/api/settings", {
      method: "POST",
      body: JSON.stringify({ values }),
    }),
  probe: (id: string) => request<ProbeResult>("/api/settings/probe", {
    method: "POST",
    body: JSON.stringify({ id }),
  }),
  scanLocal: () =>
    request<{ hits: { kind: string; label: string; path: string }[]; timedOut: boolean; roots: string[]; message: string }>(
      "/api/settings/scan",
      { method: "POST", body: JSON.stringify({}) },
    ),
  billing: () => request<BillingView>("/api/settings/billing"),
  refreshBilling: () =>
    request<BillingView>("/api/settings/billing/refresh", { method: "POST", body: JSON.stringify({}) }),
};

export type SettingFieldView = {
  key: string;
  label: string;
  kind: "text" | "secret" | "toggle" | "path";
  help: string;
  restart: boolean;
  adminOnly?: boolean;
  set: boolean;
  last4: string;
  value: string;
};

export type SettingsView = {
  groups: { title: string; fields: SettingFieldView[] }[];
  probes: { id: string; label: string }[];
  derived?: { redirect_uri?: string; tenant_key_filled?: boolean; python?: string };
  health?: Record<string, { ok: boolean; title: string; detail: string }>;
};

export type BillRow = {
  month?: string;
  service?: string;
  product?: string;
  cash?: number;
  origin?: number;
  amount?: string;
  unit?: string;
};

export type VendorBill = {
  vendor: string;
  label: string;
  ok: boolean;
  status?: "ok" | "fail" | "partial" | "skip";
  message: string;
  balance?: number | string;
  balance_ok?: boolean;
  bills_ok?: boolean;
  bills_truncated?: boolean;
  bills_total?: number;
  fetched_at?: string;
  remains?: {
    remains_time?: number;
    usage_percent?: number;
    model_count?: number;
    window_start?: string;
    window_end?: string;
  };
  bills: BillRow[];
};

export type LedgerEvent = {
  at: string;
  vendor: string;
  kind: string;
  units: number;
  task_id?: string;
  actor?: string;
  note?: string;
  charge_status?: "unknown";
  attempt?: "ok" | "failed";
};

export type BillingView = {
  vendors: VendorBill[];
  cached_at: string | null;
  ledger: LedgerEvent[];
  ledger_window?: number;
  ledger_label?: string;
  totals: Record<string, { count: number; units: number }>;
};

export type ProbeResult = { id: string; ok: boolean; message: string };

export type MockupJob = {
  id: string;
  status: "queued" | "running" | "review_required" | "unsupported" | "done" | "failed";
  title?: string;
  error?: string;
  created_at?: string;
  owner?: string;
  files: { key: string; name: string }[];
  job_kind?: string;
  job_status?: string;
  job_stage?: string;
  job_stage_label?: string;
  job_eta_s?: number;
  job_error?: string;
  job_started_at?: string;
  job_finished_at?: string;
  queue_ahead?: number;
  structure_engine?: "v2";
  structure_status?: "analyzing" | "review_required" | "unsupported" | "ready";
  structure_code?: string;
  structure_message?: string;
  structure_preview?: {
    faces: Array<{
      id: string;
      bounds_mm: [number, number, number, number];
      centroid_mm: [number, number];
      size_mm?: [number, number];
      points_mm?: Array<[number, number]>;
      rectangular: boolean;
    }>;
  };
};
