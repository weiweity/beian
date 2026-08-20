import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-mockup-http-"));
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSession } = await import("./auth.js");
const { publicMockup } = await import("./mockup.js");

describe("mockup http", () => {
  it("rejects unauthenticated list", async () => {
    const res = await app.request("/api/mockups");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /未登录/);
  });

  it("returns an empty list for a logged-in reviewer", async () => {
    const sess = issueSession("审稿", "reviewer", "ou_mockup_list_xx", "feishu");
    const res = await app.request("/api/mockups", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown[];
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });
});

describe("publicMockup", () => {
  it("drops disk paths from files", () => {
    const out = publicMockup({
      id: "m1",
      status: "done",
      created_at: "2026-08-20T00:00:00Z",
      files: [{ key: "glb", path: "/secret/data/mockups/m1/box.glb", name: "box.glb" }],
    });
    assert.equal(out.id, "m1");
    assert.deepEqual(out.files, [{ key: "glb", name: "box.glb" }]);
    assert.equal(JSON.stringify(out).includes("/secret/"), false);
    assert.equal("path" in out.files[0], false);
  });
});
