import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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

  it("stages excel+pdf then starts compare without enqueueing on a fake receipt twice", async () => {
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
    const start = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(start.status, 200);
    const task = (await start.json()) as { owner?: string; created_by?: string };
    assert.equal(task.owner, "ou_upload_http");
    assert.equal(task.created_by, "魏炜");
    const again = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(again.status, 400);
    resetJobsTestHooks();
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
