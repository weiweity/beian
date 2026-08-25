import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-uploads-http-"));
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSession } = await import("./auth.js");
const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
const { MAX_UPLOAD_BODY_BYTES, stageBuffers } = await import("./uploads.js");

function authHeader(openId = "ou_upload_http", name = "魏炜", role: "admin" | "reviewer" = "admin") {
  const sess = issueSession(name, role, openId, "feishu");
  return { authorization: `Bearer ${sess.token}` };
}

describe("upload then start", () => {
  it("refuses start without a receipt", async () => {
    const res = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ product_name: "喷雾" }),
    });
    assert.equal(res.status, 400);
  });

  it("stages excel+pdf and idempotently returns the same task when start is retried", async () => {
    setJobsTestHooks({
      runCompare: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }),
    });
    const fd = new FormData();
    fd.append("excel", new File([Buffer.from("PK\x03\x04xxxx")], "a.xlsx"));
    fd.append("pdf", new File([Buffer.from("%PDF-1.4\n%")], "a.pdf"));
    const up = await app.request("/api/uploads", { method: "POST", headers: authHeader(), body: fd });
    assert.equal(up.status, 200);
    const staged = (await up.json()) as { receipt?: string };
    assert.ok(staged.receipt);
    const beforeStart = await app.request("/api/uploads", { headers: authHeader() });
    assert.equal(beforeStart.status, 200);
    const beforeRows = (await beforeStart.json()) as { id?: string }[];
    assert.equal(beforeRows.some((row) => row.id === staged.receipt), true);
    const start = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(start.status, 200);
    const task = (await start.json()) as { id?: string; owner?: string; created_by?: string; source_receipt?: string };
    assert.ok(task.id);
    assert.equal(task.owner, "ou_upload_http");
    assert.equal(task.created_by, "魏炜");
    assert.equal("source_receipt" in task, false);
    const afterStart = await app.request("/api/uploads", { headers: authHeader() });
    assert.equal(afterStart.status, 200);
    const afterRows = (await afterStart.json()) as { id?: string }[];
    assert.deepEqual(afterRows, []);
    const again = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(again.status, 200);
    const retried = (await again.json()) as { id?: string; source_receipt?: string };
    assert.equal(retried.id, task.id);
    assert.equal("source_receipt" in retried, false);
    const stranger = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader("ou_upload_http_other"), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(stranger.status, 400);
    resetJobsTestHooks();
  });

  it("lists only this open_id's unconsumed receipts with the public shape", async () => {
    const a = new FormData();
    a.append("client_upload_id", "client-list-a");
    a.append("file", new File([Buffer.from("%PDF-1.4\n%")], "a.ai"));
    const upA = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_list_a"), body: a });
    assert.equal(upA.status, 200);
    const receiptA = (await upA.json()) as { receipt: string };

    const b = new FormData();
    b.append("file", new File([Buffer.from("%PDF-1.4\n%")], "b.ai"));
    const upB = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_list_b"), body: b });
    assert.equal(upB.status, 200);
    const receiptB = (await upB.json()) as { receipt: string };

    const listed = await app.request("/api/uploads", { headers: authHeader("ou_list_a") });
    assert.equal(listed.status, 200);
    const rows = (await listed.json()) as {
      id: string;
      files: { field: string; name: string; bytes: number }[];
      bytes: number;
      created_at: string;
      kind: string;
    }[];
    assert.deepEqual(rows.map((row) => row.id), [receiptA.receipt]);
    assert.equal(rows.some((row) => row.id === receiptB.receipt), false);
    assert.deepEqual(Object.keys(rows[0] || {}).sort(), [
      "bytes",
      "client_upload_id",
      "created_at",
      "files",
      "id",
      "kind",
    ]);
    assert.equal(rows[0]?.kind, "mockup");
    assert.equal((rows[0] as { client_upload_id?: string })?.client_upload_id, "client-list-a");
    assert.equal(rows[0]?.bytes, rows[0]?.files.reduce((sum, file) => sum + file.bytes, 0));
    assert.deepEqual(Object.keys(rows[0]?.files[0] || {}).sort(), ["bytes", "field", "name"]);
  });

  it("lets only the receipt owner discard a staged upload", async () => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("%PDF-1.4\n%")], "discard.ai"));
    const up = await app.request("/api/uploads", {
      method: "POST",
      headers: authHeader("ou_discard_http"),
      body: fd,
    });
    const staged = (await up.json()) as { receipt: string };

    const denied = await app.request(`/api/uploads/${staged.receipt}`, {
      method: "DELETE",
      headers: authHeader("ou_discard_other"),
    });
    assert.equal(denied.status, 200);
    assert.deepEqual(await denied.json(), { ok: false });

    const removed = await app.request(`/api/uploads/${staged.receipt}`, {
      method: "DELETE",
      headers: authHeader("ou_discard_http"),
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true });
    const listed = await app.request("/api/uploads", { headers: authHeader("ou_discard_http") });
    assert.deepEqual(await listed.json(), []);
  });

  it("rejects an oversized multipart body before parsing it", async () => {
    const boundary = "beian-over-limit";
    const res = await app.request("/api/uploads", {
      method: "POST",
      headers: {
        ...authHeader("ou_over_limit"),
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(MAX_UPLOAD_BODY_BYTES + 1),
      },
      body: `--${boundary}--\r\n`,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { detail: "上传总量超过 100 MB" });
  });

  it("lazily removes expired receipt JSON and files while listing", async () => {
    const rec = stageBuffers("ou_http_expired", [{
      field: "ai",
      name: "expired.ai",
      buf: Buffer.from("%PDF"),
    }]);
    const root = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    const jsonPath = join(root, `${rec.id}.json`);
    const filesPath = join(root, rec.id);
    writeFileSync(jsonPath, JSON.stringify({ ...rec, created_at: "2020-01-01T00:00:00.000Z" }));

    const listed = await app.request("/api/uploads", { headers: authHeader("ou_http_expired") });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), []);
    assert.equal(existsSync(jsonPath), false);
    assert.equal(existsSync(filesPath), false);
  });

  it("does not let another Feishu account with the same display name start from this receipt", async () => {
    const fd = new FormData();
    fd.append("excel", new File([Buffer.from("PK\x03\x04xxxx")], "a.xlsx"));
    fd.append("pdf", new File([Buffer.from("%PDF-1.4\n%")], "a.pdf"));
    const up = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_a"), body: fd });
    assert.equal(up.status, 200);
    const staged = (await up.json()) as { receipt?: string };
    const start = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader("ou_b", "魏炜"), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(start.status, 400);
  });

  it("keeps the receipt when start is missing the product name", async () => {
    const fd = new FormData();
    fd.append("excel", new File([Buffer.from("PK\x03\x04xxxx")], "a.xlsx"));
    fd.append("pdf", new File([Buffer.from("%PDF-1.4\n%")], "a.pdf"));
    const up = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_empty_name"), body: fd });
    const staged = (await up.json()) as { receipt?: string };
    const start = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader("ou_empty_name"), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "" }),
    });
    assert.equal(start.status, 400);
    setJobsTestHooks({
      runCompare: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }),
    });
    try {
      const retry = await app.request("/api/tasks/start", {
        method: "POST",
        headers: { ...authHeader("ou_empty_name"), "content-type": "application/json" },
        body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
      });
      assert.equal(retry.status, 200);
    } finally {
      resetJobsTestHooks();
    }
  });

  it("does not start compare from an ai receipt", async () => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("%PDF-1.4\n%")], "box.ai"));
    const up = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_ai_only"), body: fd });
    const staged = (await up.json()) as { receipt?: string };
    const start = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader("ou_ai_only"), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(start.status, 400);
  });

  it("does not let another Feishu account with the same display name read this task", async () => {
    setJobsTestHooks({
      runCompare: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }),
    });
    try {
      const fd = new FormData();
      fd.append("excel", new File([Buffer.from("PK\x03\x04xxxx")], "a.xlsx"));
      fd.append("pdf", new File([Buffer.from("%PDF-1.4\n%")], "a.pdf"));
      const up = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_same_a", "同名"), body: fd });
      const staged = (await up.json()) as { receipt?: string };
      const start = await app.request("/api/tasks/start", {
        method: "POST",
        headers: { ...authHeader("ou_same_a", "同名"), "content-type": "application/json" },
        body: JSON.stringify({ receipt: staged.receipt, product_name: "同名隔离" }),
      });
      assert.equal(start.status, 200);
      const task = (await start.json()) as { id?: string };
      const denied = await app.request(`/api/tasks/${task.id}`, {
        headers: authHeader("ou_same_b", "同名", "reviewer"),
      });
      assert.equal(denied.status, 403);
    } finally {
      resetJobsTestHooks();
    }
  });
});
