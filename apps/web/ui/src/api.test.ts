import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { API_DOWN_LOCAL, API_DOWN_PUBLIC } from "./apiHint.js";
import {
  ApiError,
  RESUMABLE_STEP_TIMEOUT_MS,
  UploadPausedError,
  UPLOAD_TIMEOUT_MS,
  api,
  brokenApiMessage,
  isUploadReceiptExpired,
  transientApiFailure,
  UPLOAD_RECEIPT_EXPIRED_CODE,
  uploadResumable,
  uploadWithProgress,
} from "./api.js";
import { UPLOAD_TOO_LARGE } from "./uploadLimit.js";

describe("brokenApiMessage", () => {
  it("uses the flag, not 8787/JSON in the copy", () => {
    const html = new ApiError(403, API_DOWN_PUBLIC, true);
    assert.equal(brokenApiMessage(html, "www.jianghua.site"), API_DOWN_PUBLIC);
    const json404 = new ApiError(404, "没有这张审核单", false);
    assert.equal(brokenApiMessage(json404, "www.jianghua.site"), null);
  });

  it("treats Vite JSON 502 copy as broken even without the flag", () => {
    const vite = new ApiError(502, API_DOWN_LOCAL, true);
    assert.equal(brokenApiMessage(vite, "127.0.0.1:5173"), API_DOWN_LOCAL);
  });

  it("maps a network failure to the host-aware HTML copy", () => {
    assert.equal(brokenApiMessage(new TypeError("Failed to fetch"), "www.jianghua.site"), API_DOWN_PUBLIC);
    assert.match(String(brokenApiMessage(new TypeError("Failed to fetch"), "127.0.0.1:5173")), /8787/);
  });

  it("does not treat a 413 as a dead review service", () => {
    const err = new ApiError(413, UPLOAD_TOO_LARGE, false);
    assert.equal(brokenApiMessage(err, "www.jianghua.site"), null);
  });
});

describe("authenticated live status API", () => {
  it("uses /api/status instead of the public health endpoint", async () => {
    const original = globalThis.fetch;
    const calls: Array<{ input: string; credentials?: RequestCredentials }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), credentials: init?.credentials });
      return new Response(JSON.stringify({ ok: true, jobs: { ocr: { running: 1, queued: 0 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const body = await api.status();
      assert.equal(body.ok, true);
      assert.deepEqual(calls, [{ input: "/api/status", credentials: "same-origin" }]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("mockup start", () => {
  it("surfaces a 412 with exactly one POST and does not retry the write", async () => {
    const original = globalThis.fetch;
    const calls: Array<{ path: string; method: string }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        path: String(input),
        method: String(init?.method || "GET").toUpperCase(),
      });
      return new Response(JSON.stringify({
        detail: "Illustrator 桌面代理心跳已停止。杭州 Windows 可能已注销或代理异常退出，请管理员登录确认后重新打样。",
      }), {
        status: 412,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await assert.rejects(
        api.startMockup({ receipt: "112233445566", title: "打样" }),
        (err: unknown) => err instanceof ApiError && err.status === 412 && /心跳已停止/.test(err.message),
      );
      assert.deepEqual(calls, [{ path: "/api/mockups/start", method: "POST" }]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses the stable upload receipt code instead of matching translated copy", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      detail: "这段文案可以独立调整",
      code: UPLOAD_RECEIPT_EXPIRED_CODE,
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    try {
      await assert.rejects(
        api.startMockup({ receipt: "112233445566", title: "打样" }),
        (err: unknown) =>
          err instanceof ApiError &&
          err.code === UPLOAD_RECEIPT_EXPIRED_CODE &&
          isUploadReceiptExpired(err),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("resumable upload", () => {
  it("creates a session, sends one verified chunk, then waits for the ready receipt", async () => {
    const original = globalThis.fetch;
    const file = new File([Buffer.alloc(1024 * 1024, 65), Buffer.from("tail")], "box.ai", {
      type: "application/postscript",
      lastModified: 1234,
    });
    const fd = new FormData();
    fd.append("client_upload_id", "client-resumable-test");
    fd.append("product_name", "花盒");
    fd.append("file", file);
    const calls: Array<{ path: string; method: string; offset?: string; hash?: string }> = [];
    const upload = (phase: "paused" | "ready", received: number) => ({
      id: "112233445566",
      files: [{ field: "ai", name: file.name, bytes: file.size, received, last_modified: 1234 }],
      bytes: file.size,
      received,
      created_at: "2026-08-26T08:00:00.000Z",
      client_upload_id: "client-resumable-test",
      product_name: "花盒",
      kind: "mockup" as const,
      phase,
    });
    let received = 0;
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers);
      const path = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      calls.push({ path, method, offset: headers.get("x-upload-offset") || undefined, hash: headers.get("x-upload-sha256") || undefined });
      if (method === "PUT") received = Number(headers.get("x-upload-offset") || 0) + ((init?.body as ArrayBuffer)?.byteLength || 0);
      const body = path.endsWith("/complete") ? upload("ready", file.size) : upload("paused", received);
      return new Response(JSON.stringify({ upload: body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const phases: string[] = [];
      const receipt = await uploadResumable(fd, (progress) => phases.push(progress.phase || ""));
      assert.equal(receipt.receipt, "112233445566");
      assert.deepEqual(calls.map((call) => [call.method, call.path]), [
        ["POST", "/api/uploads/sessions"],
        ["PUT", "/api/uploads/sessions/112233445566/files/ai"],
        ["PUT", "/api/uploads/sessions/112233445566/files/ai"],
        ["POST", "/api/uploads/sessions/112233445566/complete"],
      ]);
      assert.equal(calls[1]?.offset, "0");
      assert.equal(calls[2]?.offset, String(1024 * 1024));
      assert.match(calls[1]?.hash || "", /^[a-f0-9]{64}$/);
      assert.match(calls[2]?.hash || "", /^[a-f0-9]{64}$/);
      assert.deepEqual(phases, ["uploading", "uploading", "confirming", "confirming"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("续传前重放并校验服务器已确认的前缀，再发送剩余字节", async () => {
    const original = globalThis.fetch;
    const file = new File(["old-tail"], "same.ai", { lastModified: 4321 });
    const fd = new FormData();
    fd.append("client_upload_id", "client-prefix-verify");
    fd.append("file", file);
    const calls: Array<{ method: string; offset?: string; body?: string }> = [];
    let received = 3;
    const upload = (phase: "paused" | "ready") => ({
      id: "223344556677",
      files: [{ field: "ai", name: file.name, bytes: file.size, received, last_modified: 4321 }],
      bytes: file.size,
      received,
      created_at: "2026-08-26T08:00:00.000Z",
      client_upload_id: "client-prefix-verify",
      kind: "mockup" as const,
      phase,
    });
    globalThis.fetch = (async (input, init) => {
      const method = String(init?.method || "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const buffer = init?.body instanceof ArrayBuffer ? Buffer.from(init.body) : undefined;
      const offset = headers.get("x-upload-offset") || undefined;
      calls.push({ method, offset, body: buffer?.toString("utf8") });
      if (method === "PUT" && offset === "3") received = file.size;
      const body = String(input).endsWith("/complete") ? upload("ready") : upload("paused");
      return new Response(JSON.stringify({ upload: body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await uploadResumable(fd);
      assert.deepEqual(
        calls.filter((call) => call.method === "PUT").map((call) => [call.offset, call.body]),
        [["0", "old"], ["3", "-tail"]],
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("并发页面推进服务端 offset 时仍逐块校验，不能跳过中间内容", async () => {
    const original = globalThis.fetch;
    const chunk = 1024 * 1024;
    const file = new File([Buffer.alloc(chunk * 4, 65)], "parallel.ai", { lastModified: 7654 });
    const fd = new FormData();
    fd.append("client_upload_id", "client-parallel-prefix");
    fd.append("file", file);
    const offsets: number[] = [];
    let received = chunk;
    const upload = (phase: "paused" | "ready") => ({
      id: "223344556688",
      files: [{ field: "ai", name: file.name, bytes: file.size, received, last_modified: 7654 }],
      bytes: file.size,
      received,
      created_at: "2026-08-26T08:00:00.000Z",
      client_upload_id: "client-parallel-prefix",
      kind: "mockup" as const,
      phase,
    });
    globalThis.fetch = (async (input, init) => {
      const method = String(init?.method || "GET").toUpperCase();
      if (method === "PUT") {
        const offset = Number(new Headers(init?.headers).get("x-upload-offset") || 0);
        offsets.push(offset);
        if (offset === chunk) received = chunk * 3;
        if (offset === chunk * 3) received = chunk * 4;
      }
      const body = String(input).endsWith("/complete") ? upload("ready") : upload("paused");
      return new Response(JSON.stringify({ upload: body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await uploadResumable(fd);
      assert.deepEqual(offsets, [0, chunk, chunk * 2, chunk * 3]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("续传前缀不一致时停止，不把另一份同名同大小文件拼进旧会话", async () => {
    const original = globalThis.fetch;
    const file = new File(["new-tail"], "same.ai", { lastModified: 4321 });
    const fd = new FormData();
    fd.append("client_upload_id", "client-prefix-mismatch");
    fd.append("file", file);
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      if (String(init?.method || "GET").toUpperCase() === "PUT") {
        return new Response(JSON.stringify({ detail: "重新选择的文件与已上传内容不一致，请重新开始" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        upload: {
          id: "334455667788",
          files: [{ field: "ai", name: file.name, bytes: file.size, received: 3, last_modified: 4321 }],
          bytes: file.size,
          received: 3,
          created_at: "2026-08-26T08:00:00.000Z",
          client_upload_id: "client-prefix-mismatch",
          kind: "mockup",
          phase: "paused",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await assert.rejects(
        uploadResumable(fd),
        (err: unknown) => err instanceof ApiError && err.status === 409 && /内容不一致/.test(err.message),
      );
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("surfaces a 429 upload-slot refusal immediately without retrying it as network loss", async () => {
    const original = globalThis.fetch;
    const fd = new FormData();
    fd.append("client_upload_id", "client-slot-refused");
    fd.append("file", new File(["ai"], "box.ai"));
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ detail: "同时最多上传 2 份，请等其中一份完成后再试" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await assert.rejects(
        uploadResumable(fd),
        (err: unknown) =>
          err instanceof ApiError &&
          err.status === 429 &&
          /同时最多上传 2 份/.test(err.message),
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("times out every stalled upload request instead of leaving the page pending forever", async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const fd = new FormData();
    fd.append("client_upload_id", "client-timeout-request");
    fd.append("file", new File(["ai"], "box.ai"));
    let calls = 0;
    const delays: number[] = [];
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
      delays.push(Number(delay || 0));
      if (typeof handler === "function") handler();
      return 1;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      assert.equal(init?.signal?.aborted, true);
      throw new DOMException("timed out", "AbortError");
    }) as typeof fetch;
    try {
      await assert.rejects(
        uploadResumable(fd),
        (err: unknown) =>
          err instanceof UploadPausedError &&
          !err.uploadId &&
          /无法确认服务器是否收到.*响应超时/.test(err.message),
      );
      assert.equal(calls, 4);
      assert.ok(delays.includes(RESUMABLE_STEP_TIMEOUT_MS));
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it("pauses with the server upload id when a PUT step keeps timing out", async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const file = new File(["ai"], "box.ai", { lastModified: 2468 });
    const fd = new FormData();
    fd.append("client_upload_id", "client-put-timeout");
    fd.append("file", file);
    let calls = 0;
    const upload = {
      id: "445566778899",
      files: [{ field: "ai", name: file.name, bytes: file.size, received: 0, last_modified: 2468 }],
      bytes: file.size,
      received: 0,
      created_at: "2026-08-26T08:00:00.000Z",
      client_upload_id: "client-put-timeout",
      kind: "mockup",
      phase: "paused",
    };
    globalThis.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 1;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ upload }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      assert.equal(String(init?.method), "PUT");
      assert.equal(init?.signal?.aborted, true);
      throw new DOMException("timed out", "AbortError");
    }) as typeof fetch;
    try {
      await assert.rejects(
        uploadResumable(fd),
        (err: unknown) =>
          err instanceof UploadPausedError &&
          err.uploadId === "445566778899" &&
          /服务器已保存收到的部分.*继续上传/.test(err.message),
      );
      assert.equal(calls, 5);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it("retries a lost complete response without retransmitting the file", async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const file = new File(["ai"], "box.ai", { lastModified: 1357 });
    const fd = new FormData();
    fd.append("client_upload_id", "client-complete-recovery");
    fd.append("file", file);
    let received = 0;
    let putCalls = 0;
    let completeCalls = 0;
    const upload = (phase: "paused" | "ready") => ({
      id: "556677889900",
      files: [{ field: "ai", name: file.name, bytes: file.size, received, last_modified: 1357 }],
      bytes: file.size,
      received,
      created_at: "2026-08-26T08:00:00.000Z",
      client_upload_id: "client-complete-recovery",
      kind: "mockup" as const,
      phase,
    });
    globalThis.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 1;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
    globalThis.fetch = (async (input, init) => {
      const path = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      if (method === "PUT") {
        putCalls += 1;
        received = file.size;
      }
      if (path.endsWith("/complete")) {
        completeCalls += 1;
        if (completeCalls === 1) throw new DOMException("response lost", "AbortError");
        return new Response(JSON.stringify({ upload: upload("ready") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ upload: upload("paused") }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const receipt = await uploadResumable(fd);
      assert.equal(receipt.receipt, "556677889900");
      assert.equal(putCalls, 1);
      assert.equal(completeCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it("aborts the active PUT request when the caller stops the upload", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const file = new File(["ai"], "box.ai", { lastModified: 9753 });
    const fd = new FormData();
    fd.append("client_upload_id", "client-active-abort");
    fd.append("file", file);
    let calls = 0;
    let putStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      putStarted = resolve;
    });
    const upload = {
      id: "667788990011",
      files: [{ field: "ai", name: file.name, bytes: file.size, received: 0, last_modified: 9753 }],
      bytes: file.size,
      received: 0,
      created_at: "2026-08-26T08:00:00.000Z",
      client_upload_id: "client-active-abort",
      kind: "mockup",
      phase: "paused",
    };
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ upload }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      putStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;
    try {
      const pending = uploadResumable(fd, undefined, controller.signal);
      await started;
      controller.abort();
      await assert.rejects(
        pending,
        (err: unknown) => err instanceof ApiError && err.message === "上传已停止",
      );
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GET polling protection", () => {
  it("coalesces overlapping polls for the same endpoint", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    let release!: () => void;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const first = api.tasks("coalesce-poll");
      const second = api.tasks("coalesce-poll");
      assert.equal(calls, 1);
      release();
      assert.deepEqual(await Promise.all([first, second]), [[], []]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("backs off after a 524 instead of firing another request on every interval", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("gateway timeout", { status: 524, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    try {
      await assert.rejects(api.tasks("backoff-524"), /审稿服务没回上|8787/);
      await assert.rejects(api.tasks("backoff-524"), /审稿服务没回上|8787/);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("retries after the cooldown and clears the failure state after recovery", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = 1_000_000;
    let calls = 0;
    Date.now = () => now;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("gateway timeout", { status: 524, headers: { "content-type": "text/html" } })
        : new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await assert.rejects(api.tasks("recover-after-524"), /审稿服务没回上|8787/);
      now += 5_001;
      assert.deepEqual(await api.tasks("recover-after-524"), []);
      assert.deepEqual(await api.tasks("recover-after-524"), []);
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("invalidates an older pending GET after a successful write", async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    let releaseOld!: () => void;
    let releaseFresh!: () => void;
    let getCalls = 0;
    globalThis.fetch = (async (_input, init) => {
      const method = String(init?.method || "GET").toUpperCase();
      calls.push(method);
      if (method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      getCalls += 1;
      if (getCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseOld = resolve;
        });
        return new Response(JSON.stringify([{ id: "stale" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      await new Promise<void>((resolve) => {
        releaseFresh = resolve;
      });
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const oldPoll = api.tasks("write-invalidation");
      await api.deleteTask("aaaaaaaaaaaa");
      const freshPoll = api.tasks("write-invalidation");
      releaseOld();
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseFresh();
      assert.deepEqual(await Promise.all([oldPoll, freshPoll]), [[], []]);
      assert.deepEqual(calls, ["GET", "DELETE", "GET"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("caps exponential backoff at 60 seconds and never caches a 400", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = 2_000_000;
    let timeoutCalls = 0;
    let badRequestCalls = 0;
    Date.now = () => now;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("non-transient-400")) {
        badRequestCalls += 1;
        return new Response(JSON.stringify({ detail: "bad request" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      timeoutCalls += 1;
      return new Response("gateway timeout", { status: 524, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    try {
      for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
        await assert.rejects(api.tasks("backoff-cap"), /审稿服务没回上|8787/);
        const callsAtFailure = timeoutCalls;
        await assert.rejects(api.tasks("backoff-cap"), /审稿服务没回上|8787/);
        assert.equal(timeoutCalls, callsAtFailure);
        now += delay;
      }
      await assert.rejects(api.tasks("backoff-cap"), /审稿服务没回上|8787/);
      assert.equal(timeoutCalls, 7);

      await assert.rejects(api.tasks("non-transient-400"), /bad request/);
      await assert.rejects(api.tasks("non-transient-400"), /bad request/);
      assert.equal(badRequestCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("recognizes network, overload and gateway timeout failures as transient", () => {
    for (const status of [0, 429, 502, 503, 504, 524]) {
      assert.equal(transientApiFailure(new ApiError(status, "temporary")), true);
    }
    assert.equal(transientApiFailure(new ApiError(400, "bad request")), false);
  });
});

class FakeUploadXhr {
  static latest: FakeUploadXhr;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  status = 0;
  statusText = "";
  responseText = "";
  timeout = 0;
  withCredentials = false;
  contentType = "application/json";
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  constructor() {
    FakeUploadXhr.latest = this;
  }

  open(_method: string, _path: string) {}
  send(_body: Document | XMLHttpRequestBodyInit | null) {}
  getResponseHeader(name: string) {
    return name.toLowerCase() === "content-type" ? this.contentType : null;
  }
  abort() {
    this.onabort?.();
  }
}

async function withFakeUploadXhr(run: () => Promise<void>) {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeUploadXhr as unknown as typeof XMLHttpRequest;
  try {
    await run();
  } finally {
    globalThis.XMLHttpRequest = original;
  }
}

describe("uploadWithProgress", () => {
  it("上报 100% 后仍等待服务器 JSON 回执", async () => {
    await withFakeUploadXhr(async () => {
      const progress: number[] = [];
      const pending = uploadWithProgress<{ receipt: string }>(
        "/api/uploads",
        new FormData(),
        (value) => progress.push(value.pct),
      );
      const xhr = FakeUploadXhr.latest;
      assert.equal(xhr.timeout, UPLOAD_TIMEOUT_MS);
      assert.equal(xhr.withCredentials, true);
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 } as ProgressEvent);
      assert.deepEqual(progress, [100]);

      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      assert.equal(settled, false);

      xhr.status = 200;
      xhr.responseText = JSON.stringify({ receipt: "aabbccddeeff" });
      xhr.onload?.();
      assert.deepEqual(await pending, { receipt: "aabbccddeeff" });
    });
  });

  it("超时和主动中止都返回中文失败", async () => {
    await withFakeUploadXhr(async () => {
      const timedOut = uploadWithProgress("/api/uploads", new FormData());
      FakeUploadXhr.latest.ontimeout?.();
      await assert.rejects(timedOut, /上传超时/);

      const controller = new AbortController();
      const aborted = uploadWithProgress("/api/uploads", new FormData(), undefined, controller.signal);
      controller.abort();
      await assert.rejects(aborted, /上传已停止/);
    });
  });

  it("保留 429/500 的服务端中文原因，且中止后的迟到回执不能翻转结果", async () => {
    await withFakeUploadXhr(async () => {
      const busy = uploadWithProgress("/api/uploads", new FormData());
      FakeUploadXhr.latest.status = 429;
      FakeUploadXhr.latest.responseText = JSON.stringify({ detail: "已有文件正在上传，请等它完成后再试" });
      FakeUploadXhr.latest.onload?.();
      await assert.rejects(
        busy,
        (err: unknown) => err instanceof ApiError && err.status === 429 && /已有文件/.test(err.message),
      );

      const failed = uploadWithProgress("/api/uploads", new FormData());
      FakeUploadXhr.latest.status = 500;
      FakeUploadXhr.latest.responseText = JSON.stringify({ detail: "服务器落盘失败，请重试" });
      FakeUploadXhr.latest.onload?.();
      await assert.rejects(
        failed,
        (err: unknown) => err instanceof ApiError && err.status === 500 && /落盘失败/.test(err.message),
      );

      const controller = new AbortController();
      const aborted = uploadWithProgress<{ receipt: string }>(
        "/api/uploads",
        new FormData(),
        undefined,
        controller.signal,
      );
      const late = FakeUploadXhr.latest;
      controller.abort();
      late.status = 200;
      late.responseText = JSON.stringify({ receipt: "late-response" });
      late.onload?.();
      await assert.rejects(aborted, /上传已停止/);
    });
  });
});
