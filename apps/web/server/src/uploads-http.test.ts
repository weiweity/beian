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

function authHeader(openId = "ou_upload_http", name = "魏炜") {
  const sess = issueSession(name, "admin", openId, "feishu");
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
    const again = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(again.status, 400);
    resetJobsTestHooks();
  });

  it("does not let another Feishu account start from this receipt", async () => {
    const fd = new FormData();
    fd.append("excel", new File([Buffer.from("PK\x03\x04xxxx")], "a.xlsx"));
    fd.append("pdf", new File([Buffer.from("%PDF-1.4\n%")], "a.pdf"));
    const up = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_a"), body: fd });
    assert.equal(up.status, 200);
    const staged = (await up.json()) as { receipt?: string };
    const start = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader("ou_b", "刘籽烨"), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(start.status, 400);
  });
});
