import { describeBrokenApi } from "./authGate";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
    throw new ApiError(res.status, describeBrokenApi(res.status, ct) || detail);
  }
  if (!ct.includes("application/json")) {
    throw new ApiError(res.status || 502, describeBrokenApi(res.status, ct) || "接口没有返回 JSON");
  }
  return (await res.json()) as T;
}

export type Me = {
  logged_in: boolean;
  display_name: string | null;
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
  board?: "comparing" | "review" | "done";
  error?: string;
  round?: number;
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
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  tasks: (q?: string) =>
    request<TaskSummary[]>(q ? `/api/tasks?q=${encodeURIComponent(q)}` : "/api/tasks"),
  task: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),
  uploadExcelPdf: (fd: FormData) =>
    request<TaskDetail>("/api/tasks/upload", { method: "POST", body: fd }),
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
  mockup: (id: string) => request<MockupJob>(`/api/mockups/${id}`),
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
  error?: string;
  files: { key: string; name: string }[];
};
