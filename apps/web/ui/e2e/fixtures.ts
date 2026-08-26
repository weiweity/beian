import {
  expect,
  test as base,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

export type SyntheticHit = {
  id: string;
  field: string;
  status: string;
  excel?: string;
  pdf?: string;
  page?: number;
  decision?: string;
  note?: string;
  bboxes?: Array<Record<string, unknown>>;
};

export type SyntheticTask = {
  id: string;
  title: string;
  product_name?: string;
  type: string;
  status: string;
  created_at?: string;
  owner?: string;
  board?: "comparing" | "failed" | "review" | "done";
  job_kind?: string;
  job_status?: string;
  job_stage_label?: string;
  queue_ahead?: number;
  hits?: SyntheticHit[];
  pages?: Array<{ url: string; name?: string; page: number; width: number; height: number }>;
  conclusion?: string;
};

export type SyntheticMockup = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  title: string;
  created_at?: string;
  owner?: string;
  job_status?: string;
  queue_ahead?: number;
  files: Array<{ key: string; name: string }>;
};

export type SyntheticReceipt = {
  id: string;
  files: Array<{ field: string; name: string; bytes: number }>;
  bytes: number;
  created_at: string;
  client_upload_id?: string;
  kind: "compare" | "mockup";
};

export type ApiCall = {
  method: string;
  path: string;
  body?: unknown;
};

export type SyntheticApi = {
  tasks: SyntheticTask[];
  mockups: SyntheticMockup[];
  receipts: SyntheticReceipt[];
  calls: ApiCall[];
  failDeletes: Set<string>;
  loseNextUploadResponse: boolean;
  unhandled: string[];
};

const FIXED_TIME = "2026-08-26T08:00:00.000Z";
const REVIEW_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='800'%3E%3Crect width='600' height='800' fill='%23fff'/%3E%3Ctext x='40' y='80' font-size='28'%3EE2E SYNTHETIC%3C/text%3E%3C/svg%3E";

export function completedTask(id: string, title: string): SyntheticTask {
  return {
    id,
    title,
    product_name: title,
    type: "pack",
    status: "completed",
    board: "done",
    created_at: FIXED_TIME,
    owner: "籽烨",
  };
}

export function runningTask(id: string, title: string): SyntheticTask {
  return {
    id,
    title,
    product_name: title,
    type: "pack",
    status: "comparing",
    board: "comparing",
    job_kind: "compare",
    job_status: "running",
    job_stage_label: "认字",
    created_at: FIXED_TIME,
    owner: "籽烨",
  };
}

export function completedMockup(id: string, title: string): SyntheticMockup {
  return {
    id,
    title,
    status: "done",
    created_at: FIXED_TIME,
    owner: "魏炜",
    files: [{ key: "front_right", name: `${title}.png` }],
  };
}

export function reviewTask(id = "e5969b58cd47"): SyntheticTask {
  return {
    id,
    title: "合成核对单",
    product_name: "合成核对单",
    type: "pack",
    status: "in_review",
    board: "review",
    created_at: FIXED_TIME,
    owner: "籽烨",
    pages: [{ url: REVIEW_IMAGE, name: "synthetic-page.svg", page: 1, width: 600, height: 800 }],
    hits: [
      {
        id: "hit_name",
        field: "中文品名",
        status: "待人工确认",
        excel: "合成核对单",
        pdf: "合成核对",
        page: 1,
        decision: "pending",
        bboxes: [{ page: 1, x0: 40, y0: 50, x1: 260, y1: 95, kind: "miss" }],
      },
    ],
  };
}

function requestBody(request: Request): unknown {
  if (!(request.headers()["content-type"] || "").includes("application/json")) return undefined;
  try {
    return request.postDataJSON();
  } catch {
    return undefined;
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function multipartFiles(request: Request) {
  const body = request.postDataBuffer()?.toString("utf8") || "";
  const files = [...body.matchAll(/name="(excel|pdf|file|ai)"; filename="([^"]+)"/g)].map((match) => ({
    field: match[1] === "file" ? "ai" : match[1],
    name: match[2],
    bytes: Math.max(1, Buffer.byteLength(match[2], "utf8")),
  }));
  const clientUploadId = body.match(/name="client_upload_id"\r?\n\r?\n([^\r\n]+)/)?.[1];
  return { files, clientUploadId };
}

export async function installHeldUploadTransport(
  page: Page,
  state: SyntheticApi,
): Promise<() => Promise<void>> {
  await page.addInitScript(() => {
    type HeldReceipt = {
      receipt: string;
      client_upload_id?: string;
      files: Array<{ field: string; name: string; bytes: number }>;
    };
    type ReleaseWindow = Window & { __releaseE2EUpload?: () => HeldReceipt };
    class HeldUploadRequest {
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      status = 0;
      statusText = "";
      responseText = "";
      timeout = 0;
      withCredentials = false;
      onabort: ((event: ProgressEvent) => void) | null = null;
      onerror: ((event: ProgressEvent) => void) | null = null;
      onload: ((event: ProgressEvent) => void) | null = null;
      ontimeout: ((event: ProgressEvent) => void) | null = null;
      private aborted = false;

      open() {
        /* 只替代 E2E 页面的上传 XHR；其余 API 使用 fetch。 */
      }

      getResponseHeader(name: string) {
        return name.toLowerCase() === "content-type" ? "application/json" : null;
      }

      send(body: Document | XMLHttpRequestBodyInit | null) {
        const files: Array<{ field: string; name: string; bytes: number }> = [];
        let clientUploadId: string | undefined;
        let total = 0;
        if (body instanceof FormData) {
          for (const [field, value] of body.entries()) {
            if (value instanceof File) {
              files.push({ field, name: value.name, bytes: value.size });
              total += value.size;
            } else if (field === "client_upload_id") {
              clientUploadId = String(value);
            }
          }
        }
        queueMicrotask(() => {
          if (this.aborted) return;
          this.upload.onprogress?.(
            new ProgressEvent("progress", { lengthComputable: true, loaded: total, total }),
          );
        });
        (window as ReleaseWindow).__releaseE2EUpload = () => {
          if (this.aborted) throw new Error("合成上传已经中止");
          const receipt = { receipt: "aeeeeeeeeeee", client_upload_id: clientUploadId, files };
          this.status = 200;
          this.statusText = "OK";
          this.responseText = JSON.stringify(receipt);
          this.onload?.(new ProgressEvent("load"));
          return receipt;
        };
      }

      abort() {
        this.aborted = true;
        this.onabort?.(new ProgressEvent("abort"));
      }
    }
    window.XMLHttpRequest = HeldUploadRequest as unknown as typeof XMLHttpRequest;
  });
  return async () => {
    const receipt = await page.evaluate(() => {
      const target = window as Window & {
        __releaseE2EUpload?: () => {
          receipt: string;
          client_upload_id?: string;
          files: Array<{ field: string; name: string; bytes: number }>;
        };
      };
      if (!target.__releaseE2EUpload) throw new Error("合成上传还没有进入服务器确认阶段");
      const result = target.__releaseE2EUpload();
      delete target.__releaseE2EUpload;
      return result;
    });
    state.receipts.push({
      id: receipt.receipt,
      client_upload_id: receipt.client_upload_id,
      files: receipt.files,
      bytes: receipt.files.reduce((sum, file) => sum + file.bytes, 0),
      created_at: FIXED_TIME,
      kind: "compare",
    });
  };
}

async function installSyntheticApi(page: Page, state: SyntheticApi) {
  let receiptSequence = 0;
  let taskSequence = 0;
  let mockupSequence = 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = requestBody(request);
    state.calls.push({ method, path, ...(body === undefined ? {} : { body }) });

    try {
      if (method === "GET" && path === "/api/auth/me") {
        return json(route, {
          logged_in: true,
          display_name: "E2E（合成用户）",
          avatar_url: null,
          open_id: "ou_e2e_synthetic",
          role: "admin",
          perms: ["read", "create", "delete"],
        });
      }
      if (method === "GET" && (path === "/api/status" || path === "/api/health")) {
        return json(route, { ok: true, version: "e2e", jobs: {} });
      }
      if (method === "POST" && path === "/api/auth/logout") return json(route, { ok: true });

      if (method === "GET" && path === "/api/uploads") return json(route, state.receipts);
      if (method === "POST" && path === "/api/uploads") {
        const parsed = multipartFiles(request);
        if (!parsed.files.length) {
          state.unhandled.push("POST /api/uploads 没解析出合成文件");
          return json(route, { detail: "合成上传格式错误" }, 400);
        }
        const kind = parsed.files.some((file) => file.field === "excel" || file.field === "pdf")
          ? "compare"
          : "mockup";
        const id = `${kind === "compare" ? "a" : "b"}${(++receiptSequence).toString(16).padStart(11, "0")}`;
        const receipt: SyntheticReceipt = {
          id,
          files: parsed.files,
          bytes: parsed.files.reduce((sum, file) => sum + file.bytes, 0),
          created_at: FIXED_TIME,
          client_upload_id: parsed.clientUploadId,
          kind,
        };
        state.receipts.push(receipt);
        if (state.loseNextUploadResponse) {
          state.loseNextUploadResponse = false;
          return route.abort("connectionreset");
        }
        return json(route, {
          receipt: receipt.id,
          client_upload_id: receipt.client_upload_id,
          files: receipt.files,
        });
      }
      const receiptDelete = path.match(/^\/api\/uploads\/([0-9a-f]{12})$/);
      if (method === "DELETE" && receiptDelete) {
        const before = state.receipts.length;
        state.receipts = state.receipts.filter((item) => item.id !== receiptDelete[1]);
        return json(route, { ok: state.receipts.length < before });
      }

      if (method === "POST" && path === "/api/tasks/start") {
        const data = (body || {}) as Record<string, unknown>;
        const receiptId = String(data.receipt || "");
        const receipt = state.receipts.find((item) => item.id === receiptId);
        if (!receipt || receipt.kind !== "compare") {
          return json(route, { detail: "合成审稿回执不存在" }, 409);
        }
        const name = String(data.product_name || data.title || "合成审稿");
        state.receipts = state.receipts.filter((item) => item.id !== receiptId);
        const task: SyntheticTask = {
          id: `c${(++taskSequence).toString(16).padStart(11, "0")}`,
          title: name,
          product_name: name,
          type: "pack",
          status: "comparing",
          board: "comparing",
          job_kind: "compare",
          job_status: "queued",
          queue_ahead: 0,
          created_at: FIXED_TIME,
          owner: "E2E（合成用户）",
        };
        state.tasks.push(task);
        return json(route, task);
      }
      if (method === "POST" && path === "/api/mockups/start") {
        const data = (body || {}) as Record<string, unknown>;
        const receiptId = String(data.receipt || "");
        const receipt = state.receipts.find((item) => item.id === receiptId);
        if (!receipt || receipt.kind !== "mockup") {
          return json(route, { detail: "合成打样回执不存在" }, 409);
        }
        const name = String(data.product_name || data.title || "合成打样");
        state.receipts = state.receipts.filter((item) => item.id !== receiptId);
        const mockup: SyntheticMockup = {
          id: `d${(++mockupSequence).toString(16).padStart(11, "0")}`,
          title: name,
          status: "queued",
          job_status: "queued",
          queue_ahead: 0,
          created_at: FIXED_TIME,
          owner: "E2E（合成用户）",
          files: (receipt?.files || []).map((file) => ({ key: file.field, name: file.name })),
        };
        state.mockups.push(mockup);
        return json(route, mockup);
      }

      const decision = path.match(/^\/api\/tasks\/([0-9a-f]{12})\/decision$/);
      if (method === "POST" && decision) {
        const task = state.tasks.find((item) => item.id === decision[1]);
        if (!task) return json(route, { detail: "合成任务不存在" }, 404);
        const data = (body || {}) as Record<string, unknown>;
        task.hits = (task.hits || []).map((hit) =>
          hit.id === data.hit_id
            ? { ...hit, decision: String(data.decision || "pending"), note: String(data.note || "") }
            : hit,
        );
        return json(route, task);
      }
      const complete = path.match(/^\/api\/tasks\/([0-9a-f]{12})\/complete$/);
      if (method === "POST" && complete) {
        const task = state.tasks.find((item) => item.id === complete[1]);
        if (!task) return json(route, { detail: "合成任务不存在" }, 404);
        const data = (body || {}) as Record<string, unknown>;
        task.status = "completed";
        task.board = "done";
        task.conclusion = String(data.conclusion || "");
        return json(route, task);
      }

      const taskPath = path.match(/^\/api\/tasks\/([0-9a-f]{12})$/);
      if (taskPath && method === "DELETE") {
        const key = `task:${taskPath[1]}`;
        if (state.failDeletes.has(key)) return json(route, { detail: "合成删除失败" }, 500);
        const before = state.tasks.length;
        state.tasks = state.tasks.filter((item) => item.id !== taskPath[1]);
        return json(route, { ok: state.tasks.length < before });
      }
      if (taskPath && method === "GET") {
        const task = state.tasks.find((item) => item.id === taskPath[1]);
        return task ? json(route, task) : json(route, { detail: "合成任务不存在" }, 404);
      }
      if (method === "GET" && path === "/api/tasks") {
        const query = (url.searchParams.get("q") || "").toLowerCase();
        return json(
          route,
          query
            ? state.tasks.filter((task) => `${task.product_name || ""} ${task.title}`.toLowerCase().includes(query))
            : state.tasks,
        );
      }

      const mockupPath = path.match(/^\/api\/mockups\/([0-9a-f]{12})$/);
      if (mockupPath && method === "DELETE") {
        const key = `mockup:${mockupPath[1]}`;
        if (state.failDeletes.has(key)) return json(route, { detail: "合成删除失败" }, 500);
        const before = state.mockups.length;
        state.mockups = state.mockups.filter((item) => item.id !== mockupPath[1]);
        return json(route, { ok: state.mockups.length < before });
      }
      if (mockupPath && method === "GET") {
        const mockup = state.mockups.find((item) => item.id === mockupPath[1]);
        return mockup ? json(route, mockup) : json(route, { detail: "合成打样不存在" }, 404);
      }
      if (method === "GET" && path === "/api/mockups") return json(route, state.mockups);

      state.unhandled.push(`${method} ${path}`);
      return json(route, { detail: `未模拟：${method} ${path}` }, 404);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      state.unhandled.push(`${method} ${path}：${message}`);
      return json(route, { detail: "合成接口异常" }, 500);
    }
  });
}

export const test = base.extend<{ syntheticApi: SyntheticApi }>({
  syntheticApi: [async ({ page }, use) => {
    const state: SyntheticApi = {
      tasks: [],
      mockups: [],
      receipts: [],
      calls: [],
      failDeletes: new Set(),
      loseNextUploadResponse: false,
      unhandled: [],
    };
    await installSyntheticApi(page, state);
    await use(state);
  }, { auto: true }],
});

test.afterEach(async ({ syntheticApi }) => {
  expect(syntheticApi.unhandled).toEqual([]);
});

export { expect };
