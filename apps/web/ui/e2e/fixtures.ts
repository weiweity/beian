import {
  expect,
  test as base,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

type SyntheticHit = {
  id: string;
  field: string;
  status: string;
  excel?: string;
  pdf?: string;
  page?: number;
  decision?: string;
  note?: string;
  evidence?: string;
  coverage?: { hit?: string[]; miss?: string[]; matched?: number; total?: number };
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
  pages?: Array<{
    url: string;
    raster_url?: string;
    name?: string;
    page: number;
    width: number;
    height: number;
  }>;
  conclusion?: string;
};

export type SyntheticMockup = {
  id: string;
  status: "queued" | "running" | "review_required" | "unsupported" | "done" | "failed";
  title: string;
  created_at?: string;
  owner?: string;
  job_status?: string;
  job_stage?: string;
  job_stage_label?: string;
  queue_ahead?: number;
  structure_status?: "analyzing" | "review_required" | "unsupported" | "ready";
  structure_code?: string;
  structure_message?: string;
  structure_preview?: {
    page_size_mm?: [number, number];
    image_url?: string;
    net_proposals: Array<{
      id: string;
      face_ids: string[];
      body_face_ids: [string, string, string, string];
      cap_face_ids: [string, string];
      strip_axis: "x" | "y";
      bounds_mm?: [number, number, number, number];
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
  files: Array<{ key: string; name: string }>;
};

type SyntheticReceipt = {
  id: string;
  files: Array<{ field: string; name: string; bytes: number }>;
  bytes: number;
  created_at: string;
  client_upload_id?: string;
  product_name?: string;
  pack_surface?: string;
  kind: "compare" | "mockup";
};

type SyntheticUploadSession = {
  id: string;
  files: Array<{ field: string; name: string; bytes: number; received: number; last_modified?: number }>;
  bytes: number;
  created_at: string;
  client_upload_id: string;
  product_name?: string;
  pack_surface?: string;
  kind: "compare" | "mockup";
};

type ApiCall = {
  method: string;
  path: string;
  body?: unknown;
};

export type SyntheticApi = {
  tasks: SyntheticTask[];
  mockups: SyntheticMockup[];
  receipts: SyntheticReceipt[];
  uploads: SyntheticUploadSession[];
  calls: ApiCall[];
  failDeletes: Set<string>;
  loseNextUploadResponse: boolean;
  holdNextUploadComplete: boolean;
  releaseHeldUpload?: () => void;
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
        evidence: "OCR 没读全，需要人眼确认",
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
  state.holdNextUploadComplete = true;
  return async () => {
    for (let i = 0; i < 100 && !state.releaseHeldUpload; i += 1) await page.waitForTimeout(10);
    const release = state.releaseHeldUpload;
    if (!release) throw new Error("合成上传还没有进入服务器确认阶段");
    state.releaseHeldUpload = undefined;
    release();
  };
}

function readyUpload(receipt: SyntheticReceipt) {
  return {
    ...receipt,
    files: receipt.files.map((file) => ({ ...file, received: file.bytes })),
    received: receipt.bytes,
    phase: "ready" as const,
  };
}

function pausedUpload(upload: SyntheticUploadSession) {
  return {
    ...upload,
    received: upload.files.reduce((sum, file) => sum + file.received, 0),
    phase: "paused" as const,
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
        return json(route, { ok: true, version: "0.0.0.0", jobs: {} });
      }
      if (method === "POST" && path === "/api/auth/logout") return json(route, { ok: true });

      if (method === "GET" && path === "/api/uploads") {
        return json(route, [...state.receipts.map(readyUpload), ...state.uploads.map(pausedUpload)]);
      }
      if (method === "POST" && path === "/api/uploads/sessions") {
        const data = (body || {}) as {
          client_upload_id?: string;
          product_name?: string;
          pack_surface?: string;
          files?: Array<{ field: string; name: string; bytes: number; last_modified?: number }>;
        };
        const completed = state.receipts.find((item) => item.client_upload_id === data.client_upload_id);
        if (completed) return json(route, { upload: readyUpload(completed) });
        const existing = state.uploads.find((item) => item.client_upload_id === data.client_upload_id);
        if (existing) return json(route, { upload: pausedUpload(existing) });
        const files = (data.files || []).map((file) => ({ ...file, received: 0 }));
        if (!data.client_upload_id || !files.length) return json(route, { detail: "合成上传格式错误" }, 400);
        const kind = files.some((file) => file.field === "excel" || file.field === "pdf") ? "compare" : "mockup";
        const id = `${kind === "compare" ? "a" : "b"}${(++receiptSequence).toString(16).padStart(11, "0")}`;
        const upload: SyntheticUploadSession = {
          id,
          files,
          bytes: files.reduce((sum, file) => sum + file.bytes, 0),
          created_at: FIXED_TIME,
          client_upload_id: data.client_upload_id,
          product_name: data.product_name,
          pack_surface: data.pack_surface,
          kind,
        };
        state.uploads.push(upload);
        return json(route, { upload: pausedUpload(upload) });
      }
      const chunkPath = path.match(/^\/api\/uploads\/sessions\/([0-9a-f]{12})\/files\/(excel|pdf|ai)$/);
      if (method === "PUT" && chunkPath) {
        const upload = state.uploads.find((item) => item.id === chunkPath[1]);
        const file = upload?.files.find((item) => item.field === chunkPath[2]);
        if (!upload || !file) return json(route, { detail: "合成上传会话不存在" }, 404);
        const offset = Number(request.headers()["x-upload-offset"] || 0);
        const bytes = request.postDataBuffer()?.byteLength || 0;
        if (offset === file.received) file.received = Math.min(file.bytes, file.received + bytes);
        return json(route, { upload: pausedUpload(upload) });
      }
      const completePath = path.match(/^\/api\/uploads\/sessions\/([0-9a-f]{12})\/complete$/);
      if (method === "POST" && completePath) {
        if (state.holdNextUploadComplete) {
          state.holdNextUploadComplete = false;
          await new Promise<void>((resolve) => {
            state.releaseHeldUpload = resolve;
          });
          state.releaseHeldUpload = undefined;
        }
        const already = state.receipts.find((item) => item.id === completePath[1]);
        if (already) return json(route, { upload: readyUpload(already) });
        const upload = state.uploads.find((item) => item.id === completePath[1]);
        if (!upload) return json(route, { detail: "合成上传会话不存在" }, 404);
        if (upload.files.some((file) => file.received !== file.bytes)) {
          return json(route, { detail: "合成文件还没有传完" }, 409);
        }
        const receipt: SyntheticReceipt = {
          id: upload.id,
          files: upload.files.map(({ field, name, bytes }) => ({ field, name, bytes })),
          bytes: upload.bytes,
          created_at: upload.created_at,
          client_upload_id: upload.client_upload_id,
          product_name: upload.product_name,
          pack_surface: upload.pack_surface,
          kind: upload.kind,
        };
        state.uploads = state.uploads.filter((item) => item.id !== upload.id);
        state.receipts.push(receipt);
        if (state.loseNextUploadResponse) {
          state.loseNextUploadResponse = false;
          return route.abort("connectionreset");
        }
        return json(route, { upload: readyUpload(receipt) });
      }
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
        const before = state.receipts.length + state.uploads.length;
        state.receipts = state.receipts.filter((item) => item.id !== receiptDelete[1]);
        state.uploads = state.uploads.filter((item) => item.id !== receiptDelete[1]);
        const removed = state.receipts.length + state.uploads.length < before;
        return json(route, { ok: true, ...(removed ? {} : { already_deleted: true }) });
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
      const structurePath = path.match(/^\/api\/mockups\/([0-9a-f]{12})\/structure$/);
      if (structurePath && method === "POST") {
        const mockup = state.mockups.find((item) => item.id === structurePath[1]);
        if (!mockup) return json(route, { detail: "合成打样不存在" }, 404);
        const data = (body || {}) as { anchor?: Record<string, unknown> };
        const proposalId = typeof data.anchor?.proposal_id === "string" ? data.anchor.proposal_id : "";
        const frontFaceId = typeof data.anchor?.front_face_id === "string" ? data.anchor.front_face_id : "";
        const quarterTurns = data.anchor?.quarter_turns;
        const proposal = mockup.structure_preview?.net_proposals.find((item) => item.id === proposalId);
        if (
          !proposal
          || !proposal.body_face_ids.includes(frontFaceId)
          || !Number.isInteger(quarterTurns)
          || Number(quarterTurns) < 0
          || Number(quarterTurns) > 3
        ) {
          return json(route, { detail: "合成结构锚点不完整" }, 400);
        }
        mockup.status = "queued";
        mockup.job_status = "queued";
        mockup.structure_status = "ready";
        mockup.structure_preview = undefined;
        return json(route, mockup);
      }
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
      uploads: [],
      calls: [],
      failDeletes: new Set(),
      loseNextUploadResponse: false,
      holdNextUploadComplete: false,
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
