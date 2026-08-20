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
const { publicMockup, saveMockup } = await import("./mockup.js");

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

describe("mockup get", () => {
  it("GET another owner's mockup is 403", async () => {
    saveMockup({
      id: "aaaaaaaaaaaa",
      status: "done",
      created_at: "2026-08-20T00:00:00Z",
      files: [{ key: "glb", path: "/secret/box.glb", name: "box.glb" }],
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const sess = issueSession("路人", "reviewer", "ou_mockup_acl_xx", "feishu");
    const res = await app.request("/api/mockups/aaaaaaaaaaaa", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 403);
    const list = await app.request("/api/mockups", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { id?: string }[];
    assert.equal(body.some((j) => j.id === "aaaaaaaaaaaa"), false);
  });

  it("GET another owner's mockup file is 403", async () => {
    saveMockup({
      id: "bbbbbbbbbbbb",
      status: "done",
      created_at: "2026-08-20T00:00:01Z",
      files: [{ key: "glb", path: "/secret/box.glb", name: "box.glb" }],
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const sess = issueSession("路人", "reviewer", "ou_mockup_file_acl", "feishu");
    const res = await app.request("/api/mockups/bbbbbbbbbbbb/files/glb", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 403);
  });

  it("GET missing mockup is 404", async () => {
    const sess = issueSession("审稿", "reviewer", "ou_mockup_get_xx", "feishu");
    const res = await app.request("/api/mockups/ffffffffffff", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 404);
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
