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

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  if (!(opts.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, {
    credentials: "same-origin",
    ...opts,
    headers,
  });
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
    const message = hint || detail;
    throw new ApiError(res.status, message, Boolean(hint) || message === API_DOWN_LOCAL);
  }
  if (!ct.includes("application/json")) {
    throw new ApiError(res.status || 502, hint || "接口没有返回 JSON", true);
  }
  return (await res.json()) as T;
}

export type UploadReceipt = {
  receipt: string;
  files: { field: string; name: string; bytes: number }[];
};

function uploadWithProgress<T>(path: string, fd: FormData, onProgress?: (pct: number) => void): Promise<T> {
  if (typeof XMLHttpRequest === "undefined") {
    return request<T>(path, { method: "POST", body: fd });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (ev) => {
      if (!onProgress || !ev.lengthComputable || ev.total <= 0) return;
      onProgress(Math.max(0, Math.min(100, Math.round((ev.loaded / ev.total) * 100))));
    };
    xhr.onload = () => {
      const ct = xhr.getResponseHeader("content-type") || "";
      if (xhr.status === 413) {
        reject(new ApiError(413, UPLOAD_TOO_LARGE, false));
        return;
      }
      let detail = xhr.statusText;
      try {
        if (ct.includes("application/json") && xhr.responseText) {
          const body = JSON.parse(xhr.responseText) as T & { detail?: unknown };
          if (xhr.status >= 200 && xhr.status < 300) {
            onProgress?.(100);
            resolve(body);
            return;
          }
          if (typeof body.detail === "string") detail = body.detail;
        }
      } catch {
        /* keep statusText */
      }
      const hint = describeBrokenApi(xhr.status, ct, apiHost());
      reject(new ApiError(xhr.status, hint || detail, Boolean(hint)));
    };
    xhr.onerror = () => reject(new ApiError(0, "上传中断", true));
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

export type AuthMethods = {
  feishu: boolean;
  display_login: boolean;
  login_url: string;
  public_base: string;
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
  methods: () => request<AuthMethods>("/api/auth/methods"),
  health: () => request<HealthView>("/api/health"),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  tasks: (q?: string) =>
    request<TaskSummary[]>(q ? `/api/tasks?q=${encodeURIComponent(q)}` : "/api/tasks"),
  task: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),
  uploadExcelPdf: (fd: FormData) =>
    request<TaskDetail>("/api/tasks/upload", { method: "POST", body: fd }),
  stageUpload: (fd: FormData, onProgress?: (pct: number) => void) =>
    uploadWithProgress<UploadReceipt>("/api/uploads", fd, onProgress),
  startTask: (body: { receipt: string; product_name: string; title?: string; pack_surface?: string }) =>
    request<TaskDetail>("/api/tasks/start", { method: "POST", body: JSON.stringify(body) }),
  startMockup: (body: { receipt: string; title?: string; product_name?: string }) =>
    request<MockupJob>("/api/mockups/start", { method: "POST", body: JSON.stringify(body) }),
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
  createMockup: (fd: FormData) => request<MockupJob>("/api/mockups", { method: "POST", body: fd }),
  mockups: () => request<MockupJob[]>("/api/mockups"),
  mockup: (id: string) => request<MockupJob>(`/api/mockups/${id}`),
  deleteTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
  deleteMockup: (id: string) => request<{ ok: boolean }>(`/api/mockups/${id}`, { method: "DELETE" }),
  loginDisplay: (display_name: string) =>
    request<{ token?: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ display_name }),
    }),
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
  status: "queued" | "running" | "done" | "failed";
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
};
