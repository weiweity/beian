import { API_DOWN_LOCAL } from "./apiHint";
import { describeBrokenApi } from "./authGate";
import { UPLOAD_TOO_LARGE } from "./uploadLimit";

function apiHost(): string {
  return typeof window === "undefined" ? "" : window.location.host;
}

export class ApiError extends Error {
  status: number;
  brokenApi: boolean;
  code: string | null;
  reason: string | null;
  constructor(status: number, message: string, brokenApi = false, code: string | null = null, reason: string | null = null) {
    super(message);
    this.status = status;
    this.brokenApi = brokenApi;
    this.code = code;
    this.reason = reason;
  }
}

export const UPLOAD_RECEIPT_EXPIRED_CODE = "upload_receipt_expired";

export function isUploadReceiptExpired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && err.code === UPLOAD_RECEIPT_EXPIRED_CODE;
}

/** 开机探测：HTML / 空体 / 本机 Vite JSON 502 才点亮拒绝页。不要扫文案里有没有 8787。 */
export function brokenApiMessage(err: unknown, host = ""): string | null {
  if (err instanceof ApiError) return err.brokenApi ? err.message : null;
  return describeBrokenApi(0, "text/html", host);
}

export const GET_TIMEOUT_MS = 15_000;
// 旧 multipart 仍是一条长连接；分片会话使用更短的单步上限，超时后进入“继续上传”。
export const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
export const RESUMABLE_STEP_TIMEOUT_MS = 20_000;
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

type RequestOptions = RequestInit & { timeoutMs?: number };

function isGet(opts: RequestInit): boolean {
  return String(opts.method || "GET").toUpperCase() === "GET";
}

export function transientApiFailure(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 0 || err.status === 429 || [502, 503, 504, 524].includes(err.status);
  }
  return err instanceof TypeError || (err instanceof DOMException && err.name === "AbortError");
}

async function fetchJson<T>(path: string, opts: RequestOptions): Promise<T> {
  const { timeoutMs, ...requestInit } = opts;
  const headers = new Headers(requestInit.headers);
  if (!(requestInit.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const getRequest = isGet(requestInit);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(requestInit.signal?.reason);
  if (requestInit.signal) requestInit.signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs ?? (getRequest ? GET_TIMEOUT_MS : UPLOAD_TIMEOUT_MS));
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...requestInit,
      signal: controller.signal,
      headers,
    });
  } catch (err) {
    if (timedOut) {
      throw new ApiError(0, getRequest ? "审稿服务响应超时，请稍后重试。" : "上传请求响应超时，正在重试。", true);
    }
    if (err instanceof TypeError) {
      const hint = describeBrokenApi(0, "text/html", apiHost()) || "审稿服务没回上。刷新后再试。";
      throw new ApiError(0, hint, true);
    }
    throw err;
  } finally {
    globalThis.clearTimeout(timeout);
    if (requestInit.signal) requestInit.signal.removeEventListener("abort", abortFromCaller);
  }
  const ct = res.headers.get("content-type") || "";
  if (res.status === 413) {
    throw new ApiError(413, UPLOAD_TOO_LARGE, false);
  }
  const hint = describeBrokenApi(res.status, ct, apiHost());
  if (!res.ok) {
    let detail = res.statusText;
    let code: string | null = null;
    let reason: string | null = null;
    try {
      if (ct.includes("application/json")) {
        const body = (await res.json()) as { detail?: unknown; code?: unknown; reason?:unknown; message?:unknown };
        if (typeof body.detail === "string") detail = body.detail;
        else if (body.detail) detail = JSON.stringify(body.detail);
        else if (typeof body.message === "string") detail = body.message;
        if (typeof body.code === "string") code = body.code;
        if (typeof body.reason === "string") reason = body.reason;
      }
    } catch {
      /* keep statusText */
    }
    const message = hint || detail || (res.status >= 500 ? "审稿服务暂时不可用，请稍后重试。" : "请求失败");
    throw new ApiError(res.status, message, Boolean(hint) || message === API_DOWN_LOCAL, code,reason);
  }
  if (!ct.includes("application/json")) {
    throw new ApiError(res.status || 502, hint || "接口没有返回 JSON", true);
  }
  return (await res.json()) as T;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
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
  files: { field: string; name: string; bytes: number; received: number; last_modified?: number }[];
  bytes: number;
  received: number;
  created_at: string;
  client_upload_id?: string;
  product_name?: string;
  pack_surface?: string;
  kind: "compare" | "mockup";
  phase: "ready" | "paused";
};

export type UploadProgress = {
  pct: number;
  loaded: number;
  total: number;
  phase?: "uploading" | "retrying" | "confirming";
  retryAttempt?: number;
  uploadId?: string;
};

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
      let code: string | null = null;
      try {
        if (ct.includes("application/json") && xhr.responseText) {
          const body = JSON.parse(xhr.responseText) as T & { detail?: unknown; code?: unknown };
          if (xhr.status >= 200 && xhr.status < 300) {
            succeed(body);
            return;
          }
          if (typeof body.detail === "string") detail = body.detail;
          if (typeof body.code === "string") code = body.code;
        }
      } catch {
        /* keep statusText */
      }
      const hint = describeBrokenApi(xhr.status, ct, apiHost());
      fail(new ApiError(xhr.status, hint || detail, Boolean(hint), code));
    };
    xhr.onerror = () => fail(new ApiError(0, "上传中断。请检查网络后重新上传。", true));
    xhr.ontimeout = () => fail(new ApiError(0, "上传超时。请检查网络后重新上传。", false));
    xhr.send(fd);
  });
}

export class UploadPausedError extends ApiError {
  uploadId?: string;
  constructor(message: string, uploadId?: string) {
    super(0, message, false);
    this.uploadId = uploadId;
  }
}

const RESUMABLE_CHUNK_BYTES = 1024 * 1024;
const RESUMABLE_RETRIES = 3;

type UploadSessionResponse = { upload: PendingUploadReceipt };

function uploadStep<T>(path: string, opts: RequestInit): Promise<T> {
  return request<T>(path, { ...opts, timeoutMs: RESUMABLE_STEP_TIMEOUT_MS });
}

function abortError(): ApiError {
  return new ApiError(0, "上传已停止", false);
}

function transientUploadFailure(err: unknown): boolean {
  // 429 是明确的并发或暂存容量拒绝；立即把服务端原因交给用户，不冒充断网。
  return !(err instanceof ApiError && err.status === 429) && transientApiFailure(err);
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, ms);
    const abort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function retryUploadCall<T>(
  run: () => Promise<T>,
  onRetry: (attempt: number) => void,
  signal?: AbortSignal,
  uploadId?: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RESUMABLE_RETRIES; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      return await run();
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw abortError();
      if (!transientUploadFailure(err)) throw err;
      if (attempt >= RESUMABLE_RETRIES) break;
      onRetry(attempt + 1);
      await waitForRetry(Math.min(1000 * 2 ** attempt, 8000), signal);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "网络连接中断";
  const message = uploadId
    ? `上传已暂停，服务器已保存收到的部分。网络恢复后点“继续上传”。${detail ? `（${detail}）` : ""}`
    : `暂时无法确认服务器是否收到这次上传，正在按上传标识查找。${detail ? `（${detail}）` : ""}`;
  throw new UploadPausedError(message, uploadId);
}

type SelectedUploadFile = { field: "excel" | "pdf" | "ai"; file: File };

function resumableForm(fd: FormData): {
  clientUploadId: string;
  productName: string;
  packSurface: string;
  files: SelectedUploadFile[];
} {
  const clientUploadId = String(fd.get("client_upload_id") || "");
  const productName = String(fd.get("product_name") || "");
  const packSurface = String(fd.get("pack_surface") || "");
  const files: SelectedUploadFile[] = [];
  for (const [formField, uploadField] of [
    ["excel", "excel"],
    ["pdf", "pdf"],
    ["file", "ai"],
  ] as const) {
    const value = fd.get(formField);
    if (value instanceof File) files.push({ field: uploadField, file: value });
  }
  return { clientUploadId, productName, packSurface, files };
}

function uploadReceipt(upload: PendingUploadReceipt): UploadReceipt {
  return {
    receipt: upload.id,
    client_upload_id: upload.client_upload_id,
    files: upload.files.map(({ field, name, bytes }) => ({ field, name, bytes })),
  };
}

/**
 * 云盘式上传：每 1 MB 独立确认，断线后沿用 client_upload_id 与服务器 offset。
 * 分片与完成接口都幂等，因此“服务端写成、响应丢了”也只会重试当前一步。
 */
export async function uploadResumable(
  fd: FormData,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadReceipt> {
  const input = resumableForm(fd);
  const total = input.files.reduce((sum, item) => sum + item.file.size, 0);
  if (!input.clientUploadId || !input.files.length || total <= 0) throw new ApiError(400, "没有可上传的文件");

  let uploadId: string | undefined;
  let latestProgress = { loaded: 0, total, pct: 0 };
  const retryNotice = (attempt: number) =>
    onProgress?.({ ...latestProgress, phase: "retrying", retryAttempt: attempt, uploadId });
  const startBody = {
    client_upload_id: input.clientUploadId,
    product_name: input.productName,
    pack_surface: input.packSurface,
    files: input.files.map(({ field, file }) => ({
      field,
      name: file.name,
      bytes: file.size,
      last_modified: file.lastModified,
    })),
  };
  let session = (
    await retryUploadCall(
      () => uploadStep<UploadSessionResponse>("/api/uploads/sessions", {
        method: "POST",
        body: JSON.stringify(startBody),
        signal,
      }),
      retryNotice,
      signal,
    )
  ).upload;
  uploadId = session.id;
  if (session.phase === "ready") return uploadReceipt(session);

  let loaded = session.files.reduce((sum, file) => sum + file.received, 0);
  latestProgress = { loaded, total, pct: Math.round((loaded / total) * 100) };
  onProgress?.({ ...latestProgress, phase: "uploading", uploadId });

  for (const selected of input.files) {
    const serverFile = session.files.find((file) => file.field === selected.field);
    if (!serverFile) throw new ApiError(409, "服务器上传记录不完整，请重新开始");

    // 文件名、大小和修改时间都可能碰撞。续传前把服务器已确认的区段逐块重放，
    // 由服务端比较落盘内容的 SHA-256；任何一块不同都必须拒绝，不能拼成混合稿。
    let confirmedPrefix = serverFile.received;
    if (confirmedPrefix > selected.file.size) throw new ApiError(409, "服务器上传进度超过文件大小，请重新开始");
    let verified = 0;
    while (verified < confirmedPrefix) {
      const end = Math.min(verified + RESUMABLE_CHUNK_BYTES, confirmedPrefix);
      const buffer = await selected.file.slice(verified, end).arrayBuffer();
      const sha256 = await sha256Hex(buffer);
      const response = await retryUploadCall(
        () =>
          uploadStep<UploadSessionResponse>(
            `/api/uploads/sessions/${encodeURIComponent(uploadId!)}/files/${selected.field}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/octet-stream",
                "x-upload-offset": String(verified),
                "x-upload-sha256": sha256,
              },
              body: buffer,
              signal,
            },
          ),
        retryNotice,
        signal,
        uploadId,
      );
      session = response.upload;
      const checked = session.files.find((file) => file.field === selected.field);
      if (!checked || checked.received < end) throw new ApiError(409, "服务器没有确认续传文件校验");
      if (checked.received > selected.file.size) throw new ApiError(409, "服务器上传进度超过文件大小，请重新开始");
      verified = end;
      // 另一标签页可能推进了同一会话。只扩大“待校验前缀”，不能直接跳到它报告的 offset。
      confirmedPrefix = Math.max(confirmedPrefix, checked.received);
    }

    let offset = verified;
    while (offset < selected.file.size) {
      const end = Math.min(offset + RESUMABLE_CHUNK_BYTES, selected.file.size);
      const buffer = await selected.file.slice(offset, end).arrayBuffer();
      const sha256 = await sha256Hex(buffer);
      const response = await retryUploadCall(
        () =>
          uploadStep<UploadSessionResponse>(
            `/api/uploads/sessions/${encodeURIComponent(uploadId!)}/files/${selected.field}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/octet-stream",
                "x-upload-offset": String(offset),
                "x-upload-sha256": sha256,
              },
              body: buffer,
              signal,
            },
          ),
        retryNotice,
        signal,
        uploadId,
      );
      session = response.upload;
      const updated = session.files.find((file) => file.field === selected.field);
      if (!updated || updated.received < end) throw new ApiError(409, "服务器没有确认本次上传分片");
      if (updated.received > selected.file.size) throw new ApiError(409, "服务器上传进度超过文件大小，请重新开始");
      // 即便并发页面已把服务端推进得更远，本页也只前进到自己刚校验过的末端。
      offset = end;
      loaded = session.files.reduce((sum, file) => sum + file.received, 0);
      latestProgress = { loaded, total, pct: Math.min(100, Math.round((loaded / total) * 100)) };
      onProgress?.({ ...latestProgress, phase: loaded >= total ? "confirming" : "uploading", uploadId });
    }
  }

  latestProgress = { loaded: total, total, pct: 100 };
  onProgress?.({ ...latestProgress, phase: "confirming", uploadId });
  session = (
    await retryUploadCall(
      () =>
        uploadStep<UploadSessionResponse>(`/api/uploads/sessions/${encodeURIComponent(uploadId!)}/complete`, {
          method: "POST",
          body: JSON.stringify({}),
          signal,
        }),
      retryNotice,
      signal,
      uploadId,
    )
  ).upload;
  return uploadReceipt(session);
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
  uploads?: { active?: number; waiting?: number };
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
  qrcode_boxes?: Array<Record<string, unknown>>;
  bilingual_pair_id?: string;
  field_group?: string;
  doubt_bucket?: string;
  coverage?: {
    miss?: string[];
    hit?: string[];
    ratio?: number;
    matched?: number;
    total?: number;
    parts?: {
      net?: {
        coverage?: number;
        matched?: number;
        total?: number;
        hit_phrases?: string[];
        miss_phrases?: string[];
      };
      barcode?: {
        coverage?: number;
        matched?: number;
        total?: number;
        hit_phrases?: string[];
        miss_phrases?: string[];
        ignored_codes?: string[];
      };
    };
  };
  evidence?: string;
  sequence_diff?: { only_in_excel?: string[] };
};

export type TaskPage = {
  url?: string;
  raster_url?: string;
  name?: string;
  review_name?: string;
  review_format?: "svg" | "png";
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
    uploadResumable(fd, onProgress, signal),
  startTask: (body: { receipt: string; product_name: string; title?: string; pack_surface?: string }) =>
    request<TaskDetail>("/api/tasks/start", { method: "POST", body: JSON.stringify(body) }),
  startMockup: (body: { receipt: string; title?: string; product_name?: string }) =>
    request<MockupJob>("/api/mockups/start", { method: "POST", body: JSON.stringify(body) }),
  retryMockup: (id: string) =>
    request<MockupJob>(`/api/mockups/${id}/retry`, { method: "POST" }),
  repairMockupPrintFaces: (id: string) =>
    request<MockupJob>(`/api/mockups/${id}/print-faces`, { method: "POST" }),
  createRenderGeneration: (id: string, body: RenderGenerationCreate) =>
    request<RenderGenerationCreated>(`/api/mockups/${id}/render-generations`, { method: "POST",body:JSON.stringify(body),timeoutMs:20_000 }),
  renderGenerations: (id:string,cursor?:string) =>
    request<RenderGenerationHistory>(`/api/mockups/${id}/render-generations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  activateRenderGeneration: (id:string,generation:string,expected:string) =>
    request<MockupJob>(`/api/mockups/${id}/render-generations/${encodeURIComponent(generation)}/activate`,
      {method:"POST",body:JSON.stringify({expected_current_generation_id:expected}),timeoutMs:20_000}),
  refreshMockup: (id:string) => {
    invalidateGetCache();
    return request<MockupJob>(`/api/mockups/${id}`);
  },
  selectMockupStructureInput: (id: string, candidateIds: string[]) =>
    request<MockupJob>(`/api/mockups/${id}/structure/input`, {
      method: "POST",
      body: JSON.stringify({ candidate_ids: candidateIds }),
    }),
  confirmMockupStructure: (
    id: string,
    anchor: {
      proposal_id: string;
      front_face_id: string;
      quarter_turns: 0 | 1 | 2 | 3;
    },
  ) =>
    request<MockupJob>(`/api/mockups/${id}/structure`, {
      method: "POST",
      body: JSON.stringify({ anchor }),
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

type RenderCapability = {allowed:boolean;reason?:string};
export type RenderMutation = {id:string;mode:"legacy_relight" | "upgrade";status:"queued" | "running" | "succeeded" | "failed";stage?:string;error?:string};
export type RenderGenerationCreate = {client_request_id:string;mode:"legacy_relight";source_generation_id:string;
  expected_current_generation_id:string;studio_adjustment:{product_light:number;background_light:number}};
export type RenderGenerationCreated = {mutation:RenderMutation;current_render_generation_id?:string;has_render_generations:boolean;job_status:MockupJob["status"]};
export type RenderGenerationRow = {generation_id:string;mode:"legacy_import" | "legacy_relight" | "upgrade";profile:string;
  created_at:string;actor_label?:string;quality_status:"unwired" | "runtime_verified" | "failed";current:boolean};
export type RenderGenerationHistory = {items:RenderGenerationRow[];next_cursor:string | null};

export type MockupJob = {
  id: string;
  status: "queued" | "running" | "review_required" | "unsupported" | "done" | "failed";
  title?: string;
  error?: string;
  created_at?: string;
  owner?: string;
  files: { key: string; name: string }[];
  can_repair_print_faces?: boolean;
  can_relight_studio?: boolean;
  current_render_generation_id?: string;
  render_mutation?: RenderMutation;
  has_render_generations?: boolean;
  render_generation_capabilities?: Record<"history" | "activate" | "legacy_relight" | "upgrade", RenderCapability>;
  studio_relit_by?: string;
  studio_relit_at?: string;
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
  structure_input?: {
    schema: "packaging-structure-input-candidates/2";
    proposal_layers: Array<{
      id: string;
      name: string;
      stroke_only_path_count: number;
    }>;
    selected_ids: string[];
    truncated: boolean;
    image_url?: string;
    preview_plates?: Array<{ id: string; name: string }>;
    preview?: {
      schema: "illustrator-layer-preview/1";
      page_size_points: [number, number];
      layers: Array<{
        candidate_id: string;
        paths: Array<{
          closed: boolean;
          points: Array<[number, number, number, number, number, number]>;
        }>;
        truncated: boolean;
      }>;
    };
  };
  structure_preview?: {
    page_size_mm?: [number, number];
    image_url?: string;
    net_proposals: Array<{
      schema: "box-net-proposal/3" | "pouch-net-proposal/1";
      id: string;
      face_ids: string[];
      body_face_ids: string[];
      cap_face_ids?: [string, string];
      strip_axis?: "x" | "y";
      packaging_family?: "pouch";
      bounds_mm?: [number, number, number, number];
      dimensions_mm?: { width: number; depth: number; height: number };
      valid_anchors?: Array<{
        front_face_id: string;
        quarter_turns: Array<0 | 1 | 2 | 3>;
        preferred_quarter_turns?: 0 | 1 | 2 | 3;
      }>;
      closure_assemblies?: Array<{
        primary_face_id: string;
        side: -1 | 1;
        extent: "full" | "partial";
        closure_kind: "full" | "clearance" | "assembly";
        coverage_ratio: number;
        members: Array<{
          face_id: string;
          attached_body_face_id: string;
          extent: "full" | "partial";
          coverage_ratio: number;
        }>;
      }>;
    }>;
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
