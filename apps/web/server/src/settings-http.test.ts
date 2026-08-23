import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-settings-http-"));
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSession } = await import("./auth.js");

describe("settings http", () => {
  it("reviewer cannot write blender path", async () => {
    const sess = issueSession("审稿", "reviewer", "ou_set_http", "feishu");
    const res = await app.request("/api/settings", {
      method: "POST",
      headers: { authorization: `Bearer ${sess.token}`, "content-type": "application/json" },
      body: JSON.stringify({ BLENDER_EXECUTABLE: "C:\\\\Program Files\\\\Blender\\\\blender.exe" }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /管理员/);
  });

  it("viewer cannot send lark test", async () => {
    const sess = issueSession("只看", "viewer", "ou_viewer_lark", "feishu");
    const res = await app.request("/api/settings/probe", {
      method: "POST",
      headers: { authorization: `Bearer ${sess.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "lark_send" }),
    });
    assert.equal(res.status, 403);
  });

  it("display login cannot send lark test without open_id", async () => {
    const sess = issueSession("管理员", "admin", "", "display");
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
