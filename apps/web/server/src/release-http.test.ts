import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-release-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSession } = await import("./auth.js");
const { DATA_DIR } = await import("./config.js");
const { saveMockup } = await import("./mockup.js");
const { saveTask } = await import("./tasks.js");
const {
  RELEASE_CONTROL_PROTOCOL,
  RELEASE_CONTROL_TEST_TOKEN,
  RELEASE_DRAIN_MESSAGE,
} = await import("./releaseAdmission.js");

function authHeader() {
  const sess = issueSession("刘籽烨", "reviewer", "ou_release_http", "feishu");
  return { authorization: `Bearer ${sess.token}` };
}

function controlHeaders(token = RELEASE_CONTROL_TEST_TOKEN) {
  return {
    "x-beian-release-token": token,
    "x-beian-release-lease": "release-http-test-lease-00000001",
  };
}

describe("release drain http", () => {
  it("keeps a protected file download active until the response body is consumed", async () => {
    const id = "dd44dd44dd44";
    const dir = join(DATA_DIR, "mockups", id);
    const path = join(dir, "box.glb");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, Buffer.alloc(128 * 1024, 7));
    saveMockup({
      id,
      status: "done",
      created_at: "2026-08-28T00:00:00.000Z",
      files: [{ key: "glb", path, name: "box.glb" }],
      owner: "刘籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const download = await app.request(`/api/mockups/${id}/files/glb`, {
      headers: authHeader(),
    });
    assert.equal(download.status, 200);

    const entered = await app.request("/api/internal/release/drain", {
      method: "POST",
      headers: controlHeaders(),
    });
    const enteredBody = (await entered.json()) as { active: number; ready: boolean; blocker_codes: string[] };
    assert.equal(enteredBody.active, 1);
    assert.equal(enteredBody.ready, false);
    assert.ok(enteredBody.blocker_codes.includes("requests_active"));
    assert.equal((await download.arrayBuffer()).byteLength, 128 * 1024);

    const inspected = await app.request("/api/internal/release/drain", { headers: controlHeaders() });
    const inspectedBody = (await inspected.json()) as { active: number; ready: boolean };
    assert.equal(inspectedBody.active, 0);
    assert.equal(inspectedBody.ready, true);
    await app.request("/api/internal/release/drain", { method: "DELETE", headers: controlHeaders() });
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a protected gzip response active until the client cancels the final stream", async () => {
    const ids = Array.from({ length: 24 }, (_, index) => (0xabc000 + index).toString(16).padStart(12, "0"));
    for (const id of ids) {
      saveTask({
        id,
        title: `压缩响应-${id}-${"长内容".repeat(2_048)}`,
        product_name: `压缩响应-${id}`,
        type: "excel_pdf",
        status: "completed",
        owner: "ou_release_http",
        job_kind: "compare",
        job_status: "succeeded",
      });
    }
    const response = await app.request("/api/tasks", {
      headers: { ...authHeader(), "accept-encoding": "gzip" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "gzip");
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.equal(first.done, false);

    const entered = await app.request("/api/internal/release/drain", {
      method: "POST",
      headers: controlHeaders(),
    });
    const enteredBody = (await entered.json()) as { active: number; ready: boolean; blocker_codes: string[] };
    assert.equal(enteredBody.active, 1);
    assert.equal(enteredBody.ready, false);
    assert.ok(enteredBody.blocker_codes.includes("requests_active"));

    await reader.cancel("test client cancellation");
    const inspected = await app.request("/api/internal/release/drain", { headers: controlHeaders() });
    assert.equal(((await inspected.json()) as { active: number }).active, 0);
    await app.request("/api/internal/release/drain", { method: "DELETE", headers: controlHeaders() });
    for (const id of ids) rmSync(join(DATA_DIR, "tasks", `${id}.json`), { force: true });
  });

  it("blocks release when a persisted job record is unreadable", async () => {
    const tasksDir = join(DATA_DIR, "tasks");
    const broken = join(tasksDir, "ee55ee55ee55.json");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(broken, "{half-written", "utf8");
    const entered = await app.request("/api/internal/release/drain", {
      method: "POST",
      headers: controlHeaders(),
    });
    const body = (await entered.json()) as { ready: boolean; blocker_codes: string[] };
    assert.equal(body.ready, false);
    assert.ok(body.blocker_codes.includes("jobs_unknown"));
    rmSync(broken, { force: true });
    const inspected = await app.request("/api/internal/release/drain", { headers: controlHeaders() });
    assert.equal(((await inspected.json()) as { ready: boolean }).ready, true);
    await app.request("/api/internal/release/drain", { method: "DELETE", headers: controlHeaders() });
  });

  it("authenticates control, blocks business APIs with 503, and keeps health available", async () => {
    const missing = await app.request("/api/internal/release/drain", { method: "POST" });
    assert.equal(missing.status, 403);
    const wrong = await app.request("/api/internal/release/drain", {
      method: "POST",
      headers: controlHeaders("x".repeat(35)),
    });
    assert.equal(wrong.status, 403);

    const entered = await app.request("/api/internal/release/drain", {
      method: "POST",
      headers: controlHeaders(),
    });
    assert.equal(entered.status, 200);
    const enteredBody = (await entered.json()) as Record<string, unknown>;
    assert.equal(enteredBody.ok, true);
    assert.equal(enteredBody.protocol, RELEASE_CONTROL_PROTOCOL);
    assert.match(String(enteredBody.instance_id), /^[A-Za-z0-9_-]{32,128}$/);
    assert.equal(enteredBody.version, "0.20.2.0");
    assert.equal(enteredBody.state, "draining");
    assert.equal(enteredBody.active, 0);
    assert.equal(enteredBody.ready, true);
    assert.deepEqual(enteredBody.blocker_codes, []);
    assert.equal(enteredBody.lease_id, controlHeaders()["x-beian-release-lease"]);
    assert.equal(enteredBody.mode, "lease");
    assert.equal(typeof enteredBody.expires_at, "string");
    assert.equal(typeof enteredBody.pid, "number");

    const identityDenied = await app.request("/api/internal/release/identity");
    assert.equal(identityDenied.status, 403);
    const identity = await app.request("/api/internal/release/identity", {
      headers: { "x-beian-release-token": RELEASE_CONTROL_TEST_TOKEN },
    });
    assert.equal(identity.status, 200);
    const identityBody = (await identity.json()) as Record<string, unknown>;
    assert.equal(identityBody.protocol, RELEASE_CONTROL_PROTOCOL);
    assert.equal(identityBody.instance_id, enteredBody.instance_id);
    assert.equal(identityBody.pid, enteredBody.pid);
    assert.equal(identityBody.version, enteredBody.version);

    for (const [method, path] of [
      ["POST", "/api/uploads/sessions"],
      ["POST", "/api/tasks/012345abcdef/complete"],
      ["DELETE", "/api/uploads/012345abcdef"],
      ["PATCH", "/api/settings"],
      ["GET", "/api/uploads"],
      ["GET", "/api/auth/feishu/login"],
      ["GET", "/reviewup"],
    ]) {
      const blocked = await app.request(path, {
        method,
        headers: { ...authHeader(), "content-type": "application/json" },
        body: method === "DELETE" || method === "GET" ? undefined : JSON.stringify({}),
      });
      assert.equal(blocked.status, 503, `${method} ${path}`);
      assert.deepEqual(await blocked.json(), { detail: RELEASE_DRAIN_MESSAGE });
    }

    const health = await app.request("/api/health");
    assert.equal(health.status, 200);
    const favicon = await app.request("/favicon.ico");
    assert.equal(favicon.status, 200);

    const inspected = await app.request("/api/internal/release/drain", {
      headers: controlHeaders(),
    });
    assert.equal(inspected.status, 200);
    assert.equal(((await inspected.json()) as { active: number }).active, 0);

    const promoted = await app.request("/api/internal/release/drain", {
      method: "PUT",
      headers: controlHeaders(),
    });
    assert.equal(promoted.status, 200);
    const promotedBody = (await promoted.json()) as Record<string, unknown>;
    assert.equal(promotedBody.state, "draining");
    assert.equal(promotedBody.mode, "transaction");
    assert.equal(promotedBody.expires_at, undefined);

    const left = await app.request("/api/internal/release/drain", {
      method: "DELETE",
      headers: controlHeaders(),
    });
    assert.equal(left.status, 200);
    assert.equal(((await left.json()) as { state: string }).state, "open");

    const reopened = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(reopened.status, 400);
    assert.deepEqual(await reopened.json(), { detail: "品名必填" });
  });

  it("returns active to zero after a protected downstream error", async () => {
    const broken = await app.request("/api/uploads/sessions", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: "{broken",
    });
    assert.equal(broken.status, 500);
    await broken.json();

    const entered = await app.request("/api/internal/release/drain", {
      method: "POST",
      headers: controlHeaders(),
    });
    assert.equal(entered.status, 200);
    assert.equal(((await entered.json()) as { active: number }).active, 0);
    const left = await app.request("/api/internal/release/drain", {
      method: "DELETE",
      headers: controlHeaders(),
    });
    assert.equal(left.status, 200);
  });
});
