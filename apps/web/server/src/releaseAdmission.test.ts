import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createReleaseAdmission,
  holdReleaseUntilResponseSettles,
  isReleaseProtectedRequest,
  releaseReadiness,
  RELEASE_CONTROL_PROTOCOL,
} from "./releaseAdmission.js";

test("release drain blocks every business API request except health and its control endpoint", () => {
  for (const [method, path] of [
    ["POST", "/api/uploads"],
    ["POST", "/api/uploads/sessions"],
    ["PUT", "/api/uploads/sessions/abc/files/pdf"],
    ["POST", "/api/uploads/sessions/abc/complete"],
    ["POST", "/api/tasks/start"],
    ["POST", "/api/tasks/012345abcdef/rework"],
    ["POST", "/api/mockups/start"],
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

test("enter is atomic with active admissions and leave reopens the gate", () => {
  const token = "a".repeat(32);
  const lease = "lease".repeat(8);
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const admission = createReleaseAdmission(token, { leaseMs: 5_000, now: () => now });
  const release = admission.acquire();
  assert.ok(release);
  assert.deepEqual(admission.enter(token, lease), {
    state: "draining",
    active: 1,
    entered_at: "2026-08-28T00:00:00.000Z",
    lease_id: lease,
    mode: "lease",
    expires_at: "2026-08-28T00:00:05.000Z",
  });
  assert.equal(admission.acquire(), null);
  release();
  release();
  now += 1_000;
  assert.equal(admission.inspect(token, lease).active, 0);
  assert.equal(admission.snapshot().expires_at, "2026-08-28T00:00:06.000Z");
  assert.throws(() => admission.inspect(token, "other".repeat(6)), /not current/);
  assert.deepEqual(admission.leave(token, lease), { state: "open", active: 0 });
  assert.ok(admission.acquire());
});

test("an abandoned drain lease expires and automatically reopens writes", () => {
  const token = "d".repeat(32);
  const lease = "lease".repeat(8);
  let now = 1_000;
  const admission = createReleaseAdmission(token, { leaseMs: 1_000, now: () => now });
  admission.enter(token, lease);
  assert.equal(admission.acquire(), null);
  now = 2_000;
  assert.deepEqual(admission.snapshot(), { state: "open", active: 0 });
  const release = admission.acquire();
  assert.ok(release);
  release?.();
});

test("a fresh process inherits the persisted drain fence until its lease expires", () => {
  const dir = mkdtempSync(join(tmpdir(), "beian-release-fence-"));
  const fencePath = join(dir, "runtime", "release-drain.json");
  const lease = "lease".repeat(8);
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const first = createReleaseAdmission("e".repeat(32), {
    leaseMs: 5_000,
    now: () => now,
    fencePath,
  });
  first.enter("e".repeat(32), lease);
  assert.equal(existsSync(fencePath), true);

  const restarted = createReleaseAdmission("f".repeat(32), {
    leaseMs: 5_000,
    now: () => now,
    fencePath,
  });
  assert.equal(restarted.snapshot().state, "draining");
  assert.equal(restarted.acquire(), null);
  now += 5_000;
  assert.deepEqual(restarted.snapshot(), { state: "open", active: 0 });
  assert.equal(existsSync(fencePath), false);
});

test("a fresh process can atomically reopen the inherited lease with its new token", () => {
  const dir = mkdtempSync(join(tmpdir(), "beian-release-handoff-"));
  const fencePath = join(dir, "runtime", "release-drain.json");
  const lease = "handoff".repeat(5);
  const first = createReleaseAdmission("g".repeat(32), { fencePath });
  first.enter("g".repeat(32), lease);

  const restarted = createReleaseAdmission("h".repeat(32), { fencePath });
  assert.equal(restarted.snapshot().state, "draining");
  assert.deepEqual(restarted.leave("h".repeat(32), lease), { state: "open", active: 0 });
  assert.equal(existsSync(fencePath), false);
});

test("a promoted transaction fence survives time and process restart until explicitly reopened", () => {
  const dir = mkdtempSync(join(tmpdir(), "beian-release-transaction-"));
  const fencePath = join(dir, "runtime", "release-drain.json");
  const lease = "transaction".repeat(3);
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const first = createReleaseAdmission("i".repeat(32), {
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
  assert.equal(first.acquire(), null);
  const restarted = createReleaseAdmission("j".repeat(32), {
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
  assert.equal(restarted.acquire(), null);
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

test("a protected response holds admission until its stream closes or is cancelled", async () => {
  const token = "s".repeat(32);
  const lease = "stream".repeat(6);
  const admission = createReleaseAdmission(token);
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
  });
  const release = admission.acquire();
  assert.ok(release);
  const response = holdReleaseUntilResponseSettles(new Response(source), release);
  assert.equal(admission.enter(token, lease).active, 1);
  const reader = response.body?.getReader();
  assert.ok(reader);
  sourceController?.enqueue(new Uint8Array([1, 2, 3]));
  assert.deepEqual(await reader.read(), { done: false, value: new Uint8Array([1, 2, 3]) });
  assert.equal(admission.inspect(token, lease).active, 1);
  sourceController?.close();
  assert.equal((await reader.read()).done, true);
  assert.equal(admission.inspect(token, lease).active, 0);
  admission.leave(token, lease);

  const cancelAdmission = createReleaseAdmission("t".repeat(32));
  const cancelRelease = cancelAdmission.acquire();
  assert.ok(cancelRelease);
  const cancelled = holdReleaseUntilResponseSettles(
    new Response(new ReadableStream<Uint8Array>({ start() { /* wait for cancel */ } })),
    cancelRelease,
  );
  const cancelLease = "cancel".repeat(6);
  assert.equal(cancelAdmission.enter("t".repeat(32), cancelLease).active, 1);
  await cancelled.body?.cancel("client disconnected");
  assert.equal(cancelAdmission.inspect("t".repeat(32), cancelLease).active, 0);
  cancelAdmission.leave("t".repeat(32), cancelLease);
});

test("release control rejects a wrong token and writes a private runtime contract", () => {
  const token = "b".repeat(32);
  const admission = createReleaseAdmission(token);
  assert.throws(() => admission.enter("c".repeat(32), "lease".repeat(8)), /denied/);
  const dir = mkdtempSync(join(tmpdir(), "beian-release-control-"));
  const path = join(dir, "runtime", "release-control.json");
  admission.controlFile(path, "0.20.0.0", 4321);
  const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(payload.protocol, RELEASE_CONTROL_PROTOCOL);
  assert.equal(payload.token, token);
  assert.equal(payload.instance_id, admission.instanceId);
  assert.equal(payload.version, "0.20.0.0");
  assert.equal(payload.pid, 4321);
  assert.equal(admission.identity(token), admission.instanceId);
  assert.throws(() => admission.identity("c".repeat(32)), /denied/);
});
