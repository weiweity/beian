import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { atomicWriteFile } from "../alert-core.mjs";
import {
  DeliveryStateError,
  createDeliveryQueue,
  createFakeClock,
  parseDeliveryState,
} from "./delivery-core.mjs";
import { createFakeTransport } from "./fake-transport.mjs";

function at(seconds) {
  return new Date(Date.parse("2026-09-09T00:00:00.000Z") + seconds * 1000).toISOString();
}

function ev(type, source, seconds, extra = {}) {
  const stamped = at(seconds);
  return {
    schema: "beian-alert-event-v1",
    id: extra.id ?? `${type}:${source}:${stamped}`,
    type,
    source,
    at: stamped,
    consecutive: extra.consecutive ?? 3,
    class: type === "fault" ? "bad" : "ok",
    reason: extra.reason ?? "test",
    incident_id: extra.incident_id ?? `${type}:${source}:${stamped}`,
    facts: extra.facts ?? { observed: "stopped" },
    sample_classes: extra.sample_classes ?? {},
    local_candidate: true,
    exactly_once: false,
    notify: false,
  };
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "beian-delivery-async-"));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeQueue(opts = {}) {
  const dir = opts.dir || tmpDir();
  const statePath = opts.statePath || join(dir, "delivery.json");
  const clock = opts.clock || createFakeClock();
  const transport = opts.noTransport ? null : (opts.transport || createFakeTransport());
  const queue = createDeliveryQueue({
    statePath,
    clock,
    transport,
    config: opts.config,
    writeFile: opts.writeFile,
    writeHooks: opts.writeHooks,
  });
  return { dir, statePath, clock, transport, queue };
}

function item(queue, eventId) {
  return queue.snapshot().items.find((row) => row.event_id === eventId);
}

describe("promise transport", () => {
  it("freezes a rejected send as unknown without an automatic retry", async () => {
    const transport = createFakeTransport([() => Promise.reject(new Error("fake rejected"))]);
    const { queue, clock } = makeQueue({ transport });
    const event = ev("fault", "cloudflared", 1);
    queue.enqueueEvents([event]);
    await queue.tick();
    assert.equal(item(queue, event.id).status, "unknown");
    assert.equal(item(queue, event.id).last_outcome.code, "transport_threw");
    clock.advance(10000);
    await queue.tick();
    assert.equal(transport.calls.length, 1);
  });

  it("retries an asynchronously confirmed failure only after backoff", async () => {
    const transport = createFakeTransport([
      () => Promise.resolve({ outcome: "failed", retryable: true }),
      () => Promise.resolve({ outcome: "confirmed" }),
    ]);
    const { queue, clock } = makeQueue({ transport, config: { backoff_ms: 1000 } });
    const event = ev("fault", "cloudflared", 1);
    queue.enqueueEvents([event]);
    await queue.tick();
    assert.equal(item(queue, event.id).status, "retry_wait");
    clock.advance(999);
    await queue.tick();
    assert.equal(transport.calls.length, 1);
    clock.advance(1);
    await queue.tick();
    assert.equal(item(queue, event.id).status, "confirmed");
    assert.deepEqual(transport.calls.map(call => call.attempt), [1, 2]);
  });

  it("confirms a thenable send and exposes deadline plus AbortSignal", async () => {
    const transport = createFakeTransport([
      (_payload, ctx) => {
        assert.equal(typeof ctx.deadline_at, "number");
        assert.equal(ctx.signal instanceof AbortSignal, true);
        assert.equal(ctx.signal.aborted, false);
        assert.equal(ctx.deadline_at, ctx.now + 5000);
        return Promise.resolve({ outcome: "confirmed", code: "fake_ok" });
      },
    ]);
    const { queue } = makeQueue({ transport });
    const event = ev("fault", "beian-server-8787", 1);
    queue.enqueueEvents([event]);
    const tick = queue.tick();
    assert.equal(typeof tick.then, "function");
    const result = await tick;
    assert.equal(result.attempted.length, 1);
    assert.equal(result.attempted[0].status, "confirmed");
    assert.equal(item(queue, event.id).status, "confirmed");
    assert.equal(transport.calls[0].signal instanceof AbortSignal, true);
  });

  it("times out independently and ignores a late confirmed result", async () => {
    const pending = deferred();
    let seenSignal = null;
    const transport = createFakeTransport([
      (_payload, ctx) => {
        seenSignal = ctx.signal;
        return pending.promise;
      },
    ]);
    const { queue, clock } = makeQueue({ transport, config: { timeout_ms: 1000 } });
    const event = ev("fault", "cloudflared", 2);
    queue.enqueueEvents([event]);
    const tick = queue.tick();
    clock.advance(1000);
    const result = await tick;
    assert.equal(result.attempted[0].status, "unknown");
    assert.equal(result.attempted[0].code, "timeout");
    assert.equal(item(queue, event.id).status, "unknown");
    assert.equal(item(queue, event.id).last_outcome.code, "timeout");
    assert.equal(seenSignal.aborted, true);
    pending.resolve({ outcome: "confirmed", code: "fake_ok" });
    await flush();
    assert.equal(item(queue, event.id).status, "unknown");
    assert.equal(item(queue, event.id).last_outcome.code, "timeout");
    assert.equal((await queue.tick()).attempted.length, 0);
  });

  it("does not let a late success overwrite retryUnknown of a later attempt", async () => {
    const first = deferred();
    const transport = createFakeTransport([
      () => first.promise,
      { outcome: "confirmed", code: "fake_ok" },
    ]);
    const { queue, clock } = makeQueue({ transport, config: { timeout_ms: 1000 } });
    const event = ev("fault", "http_health.public", 3);
    queue.enqueueEvents([event]);
    const timedOut = queue.tick();
    clock.advance(1000);
    await timedOut;
    assert.equal(item(queue, event.id).status, "unknown");
    queue.retryUnknown(event.id);
    first.resolve({ outcome: "confirmed", code: "fake_ok" });
    await flush();
    assert.equal(item(queue, event.id).status, "retry_wait");
    const second = await queue.tick();
    assert.equal(second.attempted.length, 1);
    assert.equal(second.attempted[0].status, "confirmed");
    assert.equal(item(queue, event.id).attempt, 2);
    assert.equal(item(queue, event.id).status, "confirmed");
  });
});

describe("cancel vs async send", () => {
  for (const outcome of ["confirmed", "timeout"]) {
    it(`preserves ${outcome} settlement when cancellation cannot persist`, async () => {
      const pending = deferred();
      const transport = createFakeTransport([() => pending.promise]);
      let failWrite = false;
      const { queue, clock } = makeQueue({
        transport,
        config: { timeout_ms: 1000 },
        writeFile(...args) {
          if (failWrite) throw new Error("cancel disk failure");
          return atomicWriteFile(...args);
        },
      });
      const event = ev("fault", "beian-server-8787", 4);
      const recovery = ev("recovery", "beian-server-8787", 5);
      queue.enqueueEvents([event, recovery]);
      const tick = queue.tick();
      failWrite = true;
      assert.throws(() => queue.cancel(event.id), /cancel disk failure/);
      failWrite = false;
      await flush();
      if (outcome === "confirmed") pending.resolve({ outcome: "confirmed" });
      else clock.advance(1000);
      await tick;
      await flush();
      assert.equal(item(queue, event.id).status, outcome === "confirmed" ? "confirmed" : "unknown");
      if (outcome === "timeout") {
        assert.equal(item(queue, event.id).last_outcome.code, "timeout");
        pending.resolve({ outcome: "confirmed" });
        await flush();
        await queue.tick();
      }
      assert.equal(item(queue, recovery.id).status, "confirmed");
    });
  }

  it("cancels queued items before send as cancelled", () => {
    const { queue } = makeQueue();
    const event = ev("fault", "beian-server-8787", 4);
    queue.enqueueEvents([event]);
    assert.equal(queue.cancel(event.id).status, "cancelled");
    assert.equal(item(queue, event.id).status, "cancelled");
    assert.equal(queue.tick().attempted.length, 0);
  });

  it("marks cancel after send starts as unknown and ignores late confirmed", async () => {
    const pending = deferred();
    let seenSignal = null;
    const transport = createFakeTransport([
      (_payload, ctx) => {
        seenSignal = ctx.signal;
        return pending.promise;
      },
    ]);
    const { queue } = makeQueue({ transport });
    const event = ev("recovery", "beian-server-8787", 5);
    queue.enqueueEvents([event]);
    const tick = queue.tick();
    const cancelled = queue.cancel(event.id);
    assert.equal(cancelled.status, "unknown");
    assert.equal(cancelled.reason, "inflight_unknown");
    assert.equal(seenSignal.aborted, true);
    const result = await tick;
    assert.equal(result.attempted[0].status, "unknown");
    pending.resolve({ outcome: "confirmed", code: "fake_ok" });
    await flush();
    assert.equal(item(queue, event.id).status, "unknown");
    assert.equal(item(queue, event.id).last_outcome.code, "cancelled_after_send_issued");
  });
});

describe("duplicate tick", () => {
  it("does not start a second send while the first promise is in flight", async () => {
    const pending = deferred();
    const transport = createFakeTransport([() => pending.promise]);
    const { queue } = makeQueue({ transport });
    const event = ev("fault", "cloudflared", 6);
    queue.enqueueEvents([event]);
    const first = queue.tick();
    const second = queue.tick();
    assert.equal(typeof first.then, "function");
    assert.equal(second.then, undefined);
    assert.equal(second.attempted.length, 0);
    assert.equal(transport.calls.length, 1);
    assert.equal(item(queue, event.id).status, "sending");
    pending.resolve({ outcome: "confirmed" });
    await first;
    assert.equal(item(queue, event.id).status, "confirmed");
    assert.equal(transport.calls.length, 1);
  });
});

describe("source ordering with inflight promises", () => {
  it("keeps source blocked when timeout persistence fails before transport settles", async () => {
    const pending = deferred();
    const transport = createFakeTransport([() => pending.promise]);
    let failWrite = false;
    const { queue, clock } = makeQueue({
      transport,
      config: { timeout_ms: 1000 },
      writeFile(...args) {
        if (failWrite) throw new Error("timeout disk failure");
        return atomicWriteFile(...args);
      },
    });
    const fault = ev("fault", "beian-server-8787", 10);
    const recovery = ev("recovery", "beian-server-8787", 40);
    queue.enqueueEvents([fault, recovery]);
    const tick = queue.tick();
    failWrite = true;
    clock.advance(1000);
    await assert.rejects(tick, /timeout disk failure/);
    failWrite = false;
    assert.equal(item(queue, fault.id).status, "unknown");
    const blocked = await queue.tick();
    assert.equal(blocked.attempted.length, 0);
    assert.equal(transport.calls.length, 1);
    assert.equal(item(queue, recovery.id).status, "queued");
    pending.resolve({ outcome: "confirmed" });
    await flush();
    await queue.tick();
    assert.equal(item(queue, fault.id).status, "unknown");
    assert.equal(item(queue, recovery.id).status, "confirmed");
  });

  it("does not send same-source recovery while a timed-out fault promise is still open", async () => {
    const pending = deferred();
    const transport = createFakeTransport([
      () => pending.promise,
      { outcome: "confirmed" },
    ]);
    const { queue, clock } = makeQueue({ transport, config: { timeout_ms: 1000 } });
    const fault = ev("fault", "beian-server-8787", 10);
    const recovery = ev("recovery", "beian-server-8787", 40, { incident_id: fault.id });
    queue.enqueueEvents([fault, recovery]);
    const first = queue.tick();
    clock.advance(1000);
    const timedOut = await first;
    assert.equal(timedOut.attempted.length, 1);
    assert.equal(timedOut.attempted[0].event_id, fault.id);
    assert.equal(item(queue, fault.id).status, "unknown");
    assert.equal(item(queue, recovery.id).status, "queued");
    assert.equal(transport.calls.length, 1);
    const blocked = await queue.tick();
    assert.equal(blocked.attempted.length, 0);
    assert.equal(blocked.blocked[0].event_id, recovery.id);
    assert.equal(blocked.blocked[0].blocked_by, fault.id);
    pending.resolve({ outcome: "confirmed" });
    await flush();
    assert.equal(item(queue, fault.id).status, "unknown");
    const next = await queue.tick();
    assert.deepEqual(next.attempted.map((row) => row.event_id), [recovery.id]);
    assert.equal(item(queue, recovery.id).status, "confirmed");
    assert.deepEqual(transport.calls.map((row) => row.type), ["fault", "recovery"]);
  });

  it("starts different sources in the same tick without waiting on each other", async () => {
    const server = deferred();
    const tunnel = deferred();
    const transport = createFakeTransport((payload) => {
      if (payload.source === "beian-server-8787") return server.promise;
      if (payload.source === "cloudflared") return tunnel.promise;
      return { outcome: "confirmed" };
    });
    const { queue } = makeQueue({ transport });
    const a = ev("fault", "beian-server-8787", 1);
    const b = ev("fault", "cloudflared", 2);
    queue.enqueueEvents([a, b]);
    const tick = queue.tick();
    assert.equal(transport.calls.length, 2);
    assert.deepEqual(transport.calls.map((row) => row.source).sort(), [
      "beian-server-8787",
      "cloudflared",
    ]);
    assert.equal(item(queue, a.id).status, "sending");
    assert.equal(item(queue, b.id).status, "sending");
    server.resolve({ outcome: "confirmed" });
    tunnel.resolve({ outcome: "failed", retryable: false, code: "rejected" });
    const result = await tick;
    assert.equal(result.attempted.length, 2);
    assert.equal(item(queue, a.id).status, "confirmed");
    assert.equal(item(queue, b.id).status, "failed");
  });
});

describe("restart sending and persist failure", () => {
  it("reload of sending after async persist failure becomes unknown and does not resend", async () => {
    const dir = tmpDir();
    const statePath = join(dir, "delivery.json");
    const clock = createFakeClock();
    const transport = createFakeTransport([() => Promise.resolve({ outcome: "confirmed" })]);
    let writes = 0;
    const queue = createDeliveryQueue({
      statePath,
      clock,
      transport,
      writeFile(dest, contents, hooks) {
        writes += 1;
        if (writes >= 3) throw new Error("disk failure");
        return atomicWriteFile(dest, contents, hooks);
      },
    });
    queue.enqueueEvents([ev("fault", "beian-server-8787", 7)]);
    await assert.rejects(() => Promise.resolve(queue.tick()), /disk failure/);
    assert.equal(transport.calls.length, 1);
    assert.equal(parseDeliveryState(readFileSync(statePath, "utf8")).state.items[0].status, "sending");

    const restarted = createDeliveryQueue({
      statePath,
      clock,
      transport: createFakeTransport(),
    });
    assert.equal(restarted.snapshot().items[0].status, "unknown");
    assert.equal(restarted.snapshot().items[0].last_outcome.code, "restart_while_sending");
    assert.equal((await Promise.resolve(restarted.tick())).attempted.length, 0);
  });

  it("keeps persisted retry limit and still refuses a corrupt state file", () => {
    const dir = tmpDir();
    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, "{not-json");
    assert.throws(
      () => createDeliveryQueue({ statePath: badPath, clock: createFakeClock(), transport: createFakeTransport() }),
      DeliveryStateError,
    );
    assert.equal(readFileSync(badPath, "utf8"), "{not-json");
  });
});

it("an async tick waits for sibling completion before reporting a write failure", async () => {
  const second = deferred();
  const transport = createFakeTransport([() => Promise.resolve({outcome:"confirmed"}), () => second.promise]);
  const { queue } = makeQueue({ transport, writeFile(dest, contents, hooks) {
    const value = JSON.parse(contents);
    if (value.items.some(i => i.source === "cloudflared" && i.status === "confirmed")) throw new Error("disk failure");
    atomicWriteFile(dest, contents, hooks);
  }});
  queue.enqueueEvents([ev("fault","cloudflared",1),ev("fault","beian-server-8787",2)]);
  let settled = false;
  const tick = Promise.resolve(queue.tick()).finally(() => { settled = true; });
  const rejected = assert.rejects(tick, /disk failure/);
  await flush();
  assert.equal(settled, false);
  second.resolve({outcome:"confirmed"});
  await rejected;
  assert.equal(queue.snapshot().items.find(i => i.source === "beian-server-8787").status, "confirmed");
});
