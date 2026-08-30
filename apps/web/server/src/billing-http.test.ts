import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-bill-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { resetBillingCache, resetBillingHooksForTest, setBillingHooksForTest } = await import("./billing.js");

describe("billing http", () => {
  it("rejects unauthenticated billing read", async () => {
    const res = await app.request("/api/settings/billing");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /未登录/);
  });

  it("rejects unauthenticated force refresh", async () => {
    const res = await app.request("/api/settings/billing/refresh", { method: "POST" });
    assert.equal(res.status, 401);
  });

  it("hydrates snapshot for a logged-in reviewer without hitting live vendors", async () => {
    const sess = issueSessionForTest("审稿", "reviewer", "ou_bill_http_xx");
    setBillingHooksForTest({
      bceJson: async () => ({ ok: false, status: 0, data: null, error: "test-skip" }),
      fetch: async () => new Response("skip", { status: 500 }),
    });
    resetBillingCache();
    try {
      const res = await app.request("/api/settings/billing", {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ledger_window?: number;
        ledger_label?: string;
        vendors?: unknown[];
      };
      assert.equal(body.ledger_window, 300);
      assert.match(String(body.ledger_label || ""), /本机任务调用记录/);
      assert.ok(Array.isArray(body.vendors));
    } finally {
      resetBillingCache();
      resetBillingHooksForTest();
    }
  });
});
