import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-settings-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");

describe("settings http", () => {
  it("reviewer cannot change ordinary system settings", async () => {
    const sess = issueSessionForTest("审稿", "reviewer", "ou_set_ordinary");
    const res = await app.request("/api/settings", {
      method: "POST",
      headers: { authorization: `Bearer ${sess.token}`, "content-type": "application/json" },
      body: JSON.stringify({ values: { WB_PUBLIC: "true" } }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /系统配置.*管理员/);
  });

  it("reviewer cannot write blender path", async () => {
    const sess = issueSessionForTest("审稿", "reviewer", "ou_set_http");
    const res = await app.request("/api/settings", {
      method: "POST",
      headers: { authorization: `Bearer ${sess.token}`, "content-type": "application/json" },
      body: JSON.stringify({ BLENDER_EXECUTABLE: "C:\\\\Program Files\\\\Blender\\\\blender.exe" }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /管理员/);
  });

  it("admin can save system settings", async () => {
    const sess = issueSessionForTest("魏炜", "admin", "ou_set_admin");
    const res = await app.request("/api/settings", {
      method: "POST",
      headers: { authorization: `Bearer ${sess.token}`, "content-type": "application/json" },
      body: JSON.stringify({ values: { WB_MAX_UPLOAD_MB: "123" } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { groups?: Array<{ fields?: Array<{ key?: string; value?: string }> }> };
    const fields = body.groups?.flatMap((group) => group.fields || []) || [];
    assert.equal(fields.find((field) => field.key === "WB_MAX_UPLOAD_MB")?.value, "123");
  });

  it("viewer cannot send lark test", async () => {
    const sess = issueSessionForTest("只看", "viewer", "ou_viewer_lark");
    const res = await app.request("/api/settings/probe", {
      method: "POST",
      headers: { authorization: `Bearer ${sess.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "lark_send" }),
    });
    assert.equal(res.status, 403);
  });

  it("reviewer keeps the independent lark test action without open_id", async () => {
    const sess = issueSessionForTest("审稿", "reviewer", "");
    const res = await app.request("/api/settings/probe", {
      method: "POST",
      headers: { authorization: `Bearer ${sess.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "lark_send" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; ok: boolean; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.id, "lark");
    assert.match(body.message, /open_id/);
  });
});
