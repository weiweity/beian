import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-scan-http-"));
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSession } = await import("./auth.js");

describe("scan http", () => {
  it("rejects unauthenticated scan", async () => {
    const res = await app.request("/api/settings/scan", { method: "POST" });
    assert.equal(res.status, 401);
  });

  it("rejects reviewer scan with 403", async () => {
    const sess = issueSession("审稿", "reviewer", "ou_scan_http", "feishu");
    const res = await app.request("/api/settings/scan", {
      method: "POST",
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /管理员/);
  });

  it("admin scan returns hits array and does not spawn", async () => {
    const sess = issueSession("管理员", "admin", "", "display");
    const res = await app.request("/api/settings/scan", {
      method: "POST",
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hits: unknown[]; roots: unknown[]; timedOut: boolean };
    assert.ok(Array.isArray(body.hits));
    assert.ok(Array.isArray(body.roots));
    assert.equal(typeof body.timedOut, "boolean");
  });
});
