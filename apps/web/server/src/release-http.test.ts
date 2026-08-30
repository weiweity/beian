import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { makeTestTempDir } from "./testTemp.js";
import { createReleaseCoordinator } from "./releaseAdmission.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-release-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const REPO_VERSION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../VERSION"),
  "utf8",
).trim();

const { releaseFetch, SERVER_HTTP_OPTIONS } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { DATA_DIR } = await import("./config.js");
const { saveMockup } = await import("./mockup.js");
const {
  RELEASE_CONTROL_PROTOCOL,
  RELEASE_CONTROL_TEST_TOKEN,
  RELEASE_DRAIN_MESSAGE,
} = await import("./releaseAdmission.js");

let server: Server | undefined;
let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server = serve({
      fetch: releaseFetch,
      hostname: "127.0.0.1",
      port: 0,
      serverOptions: SERVER_HTTP_OPTIONS,
    }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    }) as Server;
    server.once("error", reject);
  });
});

after(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => err ? reject(err) : resolve());
  });
});

const app = {
  request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${baseUrl}${path}`, init);
  },
};

function rawGet(path: string, headers: Record<string, string>): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${baseUrl}${path}`, { headers }, resolve);
    request.once("error", reject);
    request.end();
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for release lifecycle");
    await delay(10);
  }
}

function authHeader() {
  const sess = issueSessionForTest("刘籽烨", "reviewer", "ou_release_http");
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
    const fileBytes = 8 * 1024 * 1024;
    writeFileSync(path, Buffer.alloc(fileBytes, 7));
    saveMockup({
      id,
      status: "done",
      created_at: "2026-08-28T00:00:00.000Z",
      files: [{ key: "glb", path, name: "box.glb" }],
      owner: "刘籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const download = await rawGet(`/api/mockups/${id}/files/glb`, authHeader());
    download.pause();
    assert.equal(download.statusCode, 200);

    const entered = await app.request("/api/internal/release/drain", {
      method: "POST",
      headers: controlHeaders(),
    });
    const enteredBody = (await entered.json()) as { active: number; ready: boolean; blocker_codes: string[] };
    assert.equal(enteredBody.active, 1);
    assert.equal(enteredBody.ready, false);
    assert.ok(enteredBody.blocker_codes.includes("requests_active"));
    let received = 0;
    const completed = new Promise<void>((resolve, reject) => {
      download.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
      });
      download.once("end", resolve);
      download.once("error", reject);
    });
    download.resume();
    await completed;
    assert.equal(received, fileBytes);

    const inspected = await app.request("/api/internal/release/drain", { headers: controlHeaders() });
    const inspectedBody = (await inspected.json()) as { active: number; ready: boolean };
    assert.equal(inspectedBody.active, 0);
    assert.equal(inspectedBody.ready, true);
    await app.request("/api/internal/release/drain", { method: "DELETE", headers: controlHeaders() });
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not leak an aborted gzip request when the socket closes before Hono consumes the body", async () => {
    const coordinator = createReleaseCoordinator("z".repeat(32));
    const delayedApp = new Hono();
    delayedApp.use(compress());
    let signalRouteStarted!: () => void;
    let releaseRoute!: () => void;
    const routeStarted = new Promise<void>((resolve) => {
      signalRouteStarted = resolve;
    });
    const routeGate = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    delayedApp.get("/api/tasks", async (c) => {
      signalRouteStarted();
      await routeGate;
      return c.text("压缩响应".repeat(64 * 1024));
    });

    let abortServer!: Server;
    let abortUrl = "";
    await new Promise<void>((resolve, reject) => {
      abortServer = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request, bindings) => coordinator.handle(
          request,
          bindings,
          (nextRequest) => delayedApp.fetch(nextRequest),
        ),
      }, (info) => {
        abortUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      }) as Server;
      abortServer.once("error", reject);
    });

    const client = httpRequest(`${abortUrl}/api/tasks`, { headers: { "accept-encoding": "gzip" } });
    client.on("error", () => { /* expected after deliberate disconnect */ });
    client.end();
    try {
      await routeStarted;
      client.destroy();
      await waitFor(() => coordinator.snapshot().requests?.[0]?.transport_done === true);
      assert.equal(coordinator.snapshot().active, 1);
      assert.equal(coordinator.snapshot().requests?.[0]?.handler_done, false);
      assert.equal(coordinator.snapshot().requests?.[0]?.terminal_reason, "close");

      releaseRoute();
      await waitFor(() => coordinator.snapshot().active === 0);
      assert.deepEqual(coordinator.snapshot(), { state: "open", active: 0 });
    } finally {
      releaseRoute();
      abortServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        abortServer.close((err) => err ? reject(err) : resolve());
      });
    }
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
    assert.equal(enteredBody.version, REPO_VERSION);
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
