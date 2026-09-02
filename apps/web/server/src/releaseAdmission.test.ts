import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createReleaseCoordinator,
  isReleaseProtectedRequest,
  releaseReadiness,
  RELEASE_CONTROL_PROTOCOL,
  RELEASE_DRAIN_MESSAGE,
} from "./releaseAdmission.js";

class FakeOutgoing extends EventEmitter {
  writableFinished = false;
  destroyed = false;

  finish(): void {
    this.writableFinished = true;
    this.emit("finish");
  }

  close(): void {
    this.destroyed = true;
    this.emit("close");
  }

  fail(): void {
    this.destroyed = true;
    this.emit("error", new Error("socket failed"));
  }
}

function businessRequest(path = "/api/tasks"): Request {
  return new Request(`http://127.0.0.1:8787${path}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("release drain blocks every business API request except health and its control endpoint", () => {
  for (const [method, path] of [
    ["POST", "/api/uploads"],
    ["POST", "/api/uploads/sessions"],
    ["PUT", "/api/uploads/sessions/abc/files/pdf"],
    ["POST", "/api/uploads/sessions/abc/complete"],
    ["POST", "/api/tasks/start"],
    ["POST", "/api/tasks/012345abcdef/rework"],
    ["POST", "/api/mockups/start"],
    ["POST", "/api/mockups/012345abcdef/retry"],
    ["POST", "/api/mockups/012345abcdef/structure/input"],
    ["POST", "/api/mockups/012345abcdef/structure"],
    ["POST", "/api/tasks/012345abcdef/complete"],
    ["DELETE", "/api/uploads/012345abcdef"],
    ["PATCH", "/api/settings"],
    ["GET", "/api/uploads"],
    ["GET", "/api/auth/feishu/login"],
    ["GET", "/api/auth/feishu/callback"],
    ["OPTIONS", "/api/tasks/start"],
    ["GET", "/reviewup"],
    ["GET", "/review/012345abcdef"],
    ["GET", "/mockup/new"],
  ]) {
    assert.equal(isReleaseProtectedRequest(method, path), true, `${method} ${path}`);
  }
  assert.equal(isReleaseProtectedRequest("HEAD", "/api/health"), false);
  assert.equal(isReleaseProtectedRequest("GET", "/api/health"), false);
  assert.equal(isReleaseProtectedRequest("POST", "/api/internal/release/drain"), false);
  assert.equal(isReleaseProtectedRequest("PUT", "/api/internal/release/drain"), false);
  assert.equal(isReleaseProtectedRequest("DELETE", "/api/internal/release/drain"), false);
  assert.equal(isReleaseProtectedRequest("GET", "/api/internal/release/identity"), false);
  assert.equal(isReleaseProtectedRequest("GET", "/favicon.ico"), false);
  assert.equal(isReleaseProtectedRequest("HEAD", "/brand/logo-mark.png"), false);
  assert.equal(isReleaseProtectedRequest("GET", "/assets/index.js"), false);
  assert.equal(isReleaseProtectedRequest("POST", "/assets/index.js"), true);
});

test("enter is atomic with request registration and leave reopens the gate", async () => {
  const token = "a".repeat(32);
  const lease = "lease".repeat(8);
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const coordinator = createReleaseCoordinator(token, { leaseMs: 5_000, now: () => now });
  const outgoing = new FakeOutgoing();
  const handler = deferred<Response>();
  let handlerStarted = false;
  const activeResponse = coordinator.handle(businessRequest(), { outgoing }, async () => {
    handlerStarted = true;
    return await handler.promise;
  });
  assert.equal(handlerStarted, true);

  const entered = coordinator.enter(token, lease);
  assert.equal(entered.state, "draining");
  assert.equal(entered.active, 1);
  assert.equal(entered.entered_at, "2026-08-28T00:00:00.000Z");
  assert.equal(entered.lease_id, lease);
  assert.equal(entered.mode, "lease");
  assert.equal(entered.expires_at, "2026-08-28T00:00:05.000Z");
  assert.equal(entered.requests?.[0]?.route_class, "tasks");
  assert.equal(entered.requests?.[0]?.handler_done, false);
  assert.equal(entered.requests?.[0]?.transport_done, false);

  let blockedHandlerCalled = false;
  const blocked = await coordinator.handle(businessRequest("/api/mockups"), { outgoing: new FakeOutgoing() }, () => {
    blockedHandlerCalled = true;
    return new Response("should not run");
  });
  assert.equal(blocked.status, 503);
  assert.deepEqual(await blocked.json(), { detail: RELEASE_DRAIN_MESSAGE });
  assert.equal(blockedHandlerCalled, false);

  outgoing.finish();
  assert.equal(coordinator.snapshot().requests?.[0]?.transport_done, true);
  assert.equal(coordinator.snapshot().active, 1);
  handler.resolve(new Response("ok"));
  await activeResponse;
  now += 1_000;
  assert.equal(coordinator.inspect(token, lease).active, 0);
  assert.equal(coordinator.snapshot().expires_at, "2026-08-28T00:00:06.000Z");
  assert.throws(() => coordinator.inspect(token, "other".repeat(6)), /not current/);
  assert.deepEqual(coordinator.leave(token, lease), { state: "open", active: 0 });

  const reopenedOutgoing = new FakeOutgoing();
  await coordinator.handle(businessRequest(), { outgoing: reopenedOutgoing }, () => new Response("open"));
  assert.equal(coordinator.snapshot().active, 1);
  reopenedOutgoing.finish();
  assert.equal(coordinator.snapshot().active, 0);
});

test("an abandoned drain lease expires and automatically reopens writes", async () => {
  const token = "d".repeat(32);
  const lease = "lease".repeat(8);
  let now = 1_000;
  const coordinator = createReleaseCoordinator(token, { leaseMs: 1_000, now: () => now });
  coordinator.enter(token, lease);
  const blocked = await coordinator.handle(businessRequest(), { outgoing: new FakeOutgoing() }, () => new Response("no"));
  assert.equal(blocked.status, 503);
  now = 2_000;
  assert.deepEqual(coordinator.snapshot(), { state: "open", active: 0 });
  const outgoing = new FakeOutgoing();
  await coordinator.handle(businessRequest(), { outgoing }, () => new Response("yes"));
  outgoing.finish();
  assert.equal(coordinator.snapshot().active, 0);
});

test("a fresh process inherits the persisted drain fence until its lease expires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beian-release-fence-"));
  const fencePath = join(dir, "runtime", "release-drain.json");
  const lease = "lease".repeat(8);
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const first = createReleaseCoordinator("e".repeat(32), {
    leaseMs: 5_000,
    now: () => now,
    fencePath,
  });
  first.enter("e".repeat(32), lease);
  assert.equal(existsSync(fencePath), true);

  const restarted = createReleaseCoordinator("f".repeat(32), {
    leaseMs: 5_000,
    now: () => now,
    fencePath,
  });
  assert.equal(restarted.snapshot().state, "draining");
  assert.equal((await restarted.handle(
    businessRequest(),
    { outgoing: new FakeOutgoing() },
    () => new Response("no"),
  )).status, 503);
  now += 5_000;
  assert.deepEqual(restarted.snapshot(), { state: "open", active: 0 });
  assert.equal(existsSync(fencePath), false);
});

test("a fresh process can atomically reopen the inherited lease with its new token", () => {
  const dir = mkdtempSync(join(tmpdir(), "beian-release-handoff-"));
  const fencePath = join(dir, "runtime", "release-drain.json");
  const lease = "handoff".repeat(5);
  const first = createReleaseCoordinator("g".repeat(32), { fencePath });
  first.enter("g".repeat(32), lease);

  const restarted = createReleaseCoordinator("h".repeat(32), { fencePath });
  assert.equal(restarted.snapshot().state, "draining");
  assert.deepEqual(restarted.leave("h".repeat(32), lease), { state: "open", active: 0 });
  assert.equal(existsSync(fencePath), false);
});

test("a promoted transaction fence survives time and process restart until explicitly reopened", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beian-release-transaction-"));
  const fencePath = join(dir, "runtime", "release-drain.json");
  const lease = "transaction".repeat(3);
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const first = createReleaseCoordinator("i".repeat(32), {
    leaseMs: 1_000,
    now: () => now,
    fencePath,
  });
  first.enter("i".repeat(32), lease);
  assert.deepEqual(first.promote("i".repeat(32), lease), {
    state: "draining",
    active: 0,
    entered_at: "2026-08-28T00:00:00.000Z",
    lease_id: lease,
    mode: "transaction",
  });
  const persisted = JSON.parse(readFileSync(fencePath, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.mode, "transaction");
  assert.equal("expires_at" in persisted, false);

  now += 86_400_000;
  assert.equal((await first.handle(
    businessRequest(),
    { outgoing: new FakeOutgoing() },
    () => new Response("no"),
  )).status, 503);
  const restarted = createReleaseCoordinator("j".repeat(32), {
    leaseMs: 1_000,
    now: () => now,
    fencePath,
  });
  assert.deepEqual(restarted.snapshot(), {
    state: "draining",
    active: 0,
    entered_at: "2026-08-28T00:00:00.000Z",
    lease_id: lease,
    mode: "transaction",
  });
  assert.equal((await restarted.handle(
    businessRequest(),
    { outgoing: new FakeOutgoing() },
    () => new Response("no"),
  )).status, 503);
  assert.deepEqual(restarted.leave("j".repeat(32), lease), { state: "open", active: 0 });
  assert.equal(existsSync(fencePath), false);
});

test("release readiness hides queue and agent details behind stable blocker codes", () => {
  assert.deepEqual(releaseReadiness({
    admission: { state: "draining", active: 1 },
    jobs: [{ running: 0, queued: 1 }, { running: 2, queued: 0 }],
    jobsUnknown: 1,
    uploads: { active: 0, waiting: 1 },
    notifications: { active: 1 },
    illustratorState: "busy",
  }), {
    ready: false,
    blocker_codes: [
      "requests_active",
      "jobs_active",
      "jobs_unknown",
      "uploads_active",
      "notifications_active",
      "illustrator_agent_blocked",
    ],
  });
  assert.deepEqual(releaseReadiness({
    admission: { state: "draining", active: 0 },
    jobs: [{ running: 0, queued: 0 }],
    uploads: { active: 0, waiting: 0 },
    notifications: { active: 0 },
    illustratorState: "idle",
  }), { ready: true, blocker_codes: [] });
});

test("request records require both handler and transport to settle", async () => {
  const coordinator = createReleaseCoordinator("s".repeat(32));

  const handlerFirst = new FakeOutgoing();
  await coordinator.handle(businessRequest(), { outgoing: handlerFirst }, () => new Response("ok"));
  assert.equal(coordinator.snapshot().active, 1);
  assert.equal(coordinator.snapshot().requests?.[0]?.handler_result, "fulfilled");
  assert.equal(coordinator.snapshot().requests?.[0]?.transport_done, false);
  handlerFirst.finish();
  handlerFirst.close();
  assert.equal(coordinator.snapshot().active, 0);

  const transportFirst = new FakeOutgoing();
  const pending = deferred<Response>();
  const response = coordinator.handle(businessRequest("/api/uploads"), { outgoing: transportFirst }, () => pending.promise);
  transportFirst.close();
  assert.equal(coordinator.snapshot().active, 1);
  assert.equal(coordinator.snapshot().requests?.[0]?.handler_done, false);
  assert.equal(coordinator.snapshot().requests?.[0]?.terminal_reason, "close");
  pending.resolve(new Response("done"));
  await response;
  assert.equal(coordinator.snapshot().active, 0);

  const failed = new FakeOutgoing();
  await assert.rejects(
    coordinator.handle(businessRequest(), { outgoing: failed }, () => {
      throw new Error("handler failed");
    }),
    /handler failed/,
  );
  assert.equal(coordinator.snapshot().requests?.[0]?.handler_result, "rejected");
  failed.fail();
  assert.equal(coordinator.snapshot().active, 0);
});

test("release control rejects a wrong token and writes a private runtime contract", () => {
  const token = "b".repeat(32);
  const coordinator = createReleaseCoordinator(token);
  assert.throws(() => coordinator.enter("c".repeat(32), "lease".repeat(8)), /denied/);
  const dir = mkdtempSync(join(tmpdir(), "beian-release-control-"));
  const path = join(dir, "runtime", "release-control.json");
  coordinator.controlFile(path, "0.20.0.0", 4321);
  const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(payload.protocol, RELEASE_CONTROL_PROTOCOL);
  assert.equal(payload.token, token);
  assert.equal(payload.instance_id, coordinator.instanceId);
  assert.equal(payload.version, "0.20.0.0");
  assert.equal(payload.pid, 4321);
  assert.equal(coordinator.identity(token), coordinator.instanceId);
  assert.throws(() => coordinator.identity("c".repeat(32)), /denied/);
});
