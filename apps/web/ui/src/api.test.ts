import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { API_DOWN_LOCAL, API_DOWN_PUBLIC } from "./apiHint.js";
import { ApiError, UPLOAD_TIMEOUT_MS, api, brokenApiMessage, uploadWithProgress } from "./api.js";
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
