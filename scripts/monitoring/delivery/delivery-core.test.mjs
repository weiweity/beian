import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { atomicWriteFile } from "../alert-core.mjs";
import {
  DELIVERY_EXACTLY_ONCE,
  DELIVERY_EXACTLY_ONCE_NOTE,
  DeliveryStateError,
  LOCAL_DELIVERY_DEFAULTS,
  createDeliveryQueue,
  createFakeClock,
  emptyDeliveryState,
  parseDeliveryState,
  serializeDeliveryState,
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
  return mkdtempSync(join(tmpdir(), "beian-delivery-"));
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

describe("delivery config", () => {
  it("tags defaults as local candidates and refuses exactly-once claims", () => {
    assert.equal(LOCAL_DELIVERY_DEFAULTS.production_default, false);
    assert.equal(LOCAL_DELIVERY_DEFAULTS.local_candidate, true);
    assert.equal(DELIVERY_EXACTLY_ONCE, false);
    assert.match(DELIVERY_EXACTLY_ONCE_NOTE, /exactly-once/);
  });
});

describe("enqueue identity", () => {
  it("uses event.id as the stable key and ignores a second enqueue", () => {
    const { queue } = makeQueue();
    const event = ev("fault", "beian-server-8787", 60);
    const first = queue.enqueueEvents([event]);
    const second = queue.enqueueEvents([event]);
    assert.equal(first.added.length, 1);
    assert.equal(second.added.length, 0);
    assert.equal(second.duplicates[0].event_id, event.id);
    assert.equal(queue.snapshot().items.length, 1);
    assert.equal(queue.snapshot().items[0].event_id, event.id);
  });

  it("keeps fault and recovery as separate records for the same source", () => {
    const { queue } = makeQueue();
    const fault = ev("fault", "cloudflared", 60);
    const recovery = ev("recovery", "cloudflared", 120, { incident_id: fault.id });
    queue.enqueueEvents([fault, recovery]);
    const items = queue.snapshot().items;
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((row) => row.type), ["fault", "recovery"]);
    assert.notEqual(items[0].event_id, items[1].event_id);
  });

  it("persists only redacted draft fields and not transport secrets", () => {
    const { queue, statePath } = makeQueue();
    queue.enqueueEvents([ev("fault", "http_health.public", 90)], [{
      event_id: ev("fault", "http_health.public", 90).id,
      title: "【备案本地告警草稿】故障：http_health.public",
      body: "未发送。",
      redacted: true,
      channel: "unconfigured",
      recipients: "unconfigured",
      sent: false,
      token: "must-not-persist",
    }]);
    const raw = readFileSync(statePath, "utf8");
    assert.doesNotMatch(raw, /must-not-persist|webhook|app_secret|open_id|raw_response/i);
    assert.doesNotMatch(raw, /"channel"/);
    assert.equal(queue.snapshot().items[0].draft.redacted, true);
  });
});

describe("ordering and retry", () => {
  it("does not send a later recovery while an earlier fault is retrying", () => {
    const transport = createFakeTransport([
      { outcome: "failed", retryable: true, code: "busy" },
      { outcome: "confirmed" },
      { outcome: "confirmed" },
    ]);
    const { queue, clock } = makeQueue({ transport, config: { backoff_ms: 1000, max_attempts: 3 } });
    const fault = ev("fault", "beian-server-8787", 10);
    const recovery = ev("recovery", "beian-server-8787", 40, { incident_id: fault.id });
    queue.enqueueEvents([fault, recovery]);
    const first = queue.tick();
    assert.equal(first.attempted.length, 1);
    assert.equal(first.attempted[0].event_id, fault.id);
    assert.equal(queue.snapshot().items.find((row) => row.event_id === fault.id).status, "retry_wait");
    assert.equal(queue.snapshot().items.find((row) => row.event_id === recovery.id).status, "queued");
    assert.equal(transport.calls.length, 1);
    clock.advance(1000);
    const second = queue.tick();
    assert.deepEqual(second.attempted.map((row) => row.event_id), [fault.id, recovery.id]);
    assert.deepEqual(transport.calls.map((row) => row.type), ["fault", "fault", "recovery"]);
    assert.ok(queue.snapshot().items.every((row) => row.status === "confirmed"));
  });

  it("marks non-retryable confirmed failure as failed without retry", () => {
    const transport = createFakeTransport([{ outcome: "failed", retryable: false, code: "rejected" }]);
    const { queue } = makeQueue({ transport });
    queue.enqueueEvents([ev("fault", "cloudflared", 2)]);
    queue.tick();
    assert.equal(queue.snapshot().items[0].status, "failed");
    assert.equal(queue.tick().attempted.length, 0);
    assert.equal(transport.calls.length, 1);
  });

  it("retries confirmed failures with backoff then fails permanently", () => {
    const transport = createFakeTransport([
      { outcome: "failed", retryable: true, code: "busy" },
      { outcome: "failed", retryable: true, code: "busy" },
      { outcome: "failed", retryable: true, code: "busy" },
    ]);
    const { queue, clock } = makeQueue({ transport, config: { max_attempts: 3, backoff_ms: 100 } });
    queue.enqueueEvents([ev("fault", "cloudflared", 1)]);
    queue.tick();
    clock.advance(99);
    assert.equal(queue.tick().attempted.length, 0);
    clock.advance(1);
    queue.tick();
    clock.advance(200);
    queue.tick();
    const item = queue.snapshot().items[0];
    assert.equal(item.status, "failed");
    assert.equal(item.attempt, 3);
    assert.equal(item.last_outcome.kind, "failed");
    assert.equal(transport.calls.length, 3);
  });

  it("treats timeout and thrown send as unknown and does not auto-retry", () => {
    const timeoutTransport = createFakeTransport([{ outcome: "timeout", code: "timeout" }]);
    const { queue } = makeQueue({ transport: timeoutTransport });
    queue.enqueueEvents([ev("fault", "beian-server-8787", 5)]);
    queue.tick();
    assert.equal(queue.snapshot().items[0].status, "unknown");
    assert.equal(queue.snapshot().items[0].last_outcome.kind, "unknown");
    assert.equal(queue.tick().attempted.length, 0);

    const throwTransport = createFakeTransport([() => { throw new Error("socket reset"); }]);
    const thrown = makeQueue({ transport: throwTransport });
    thrown.queue.enqueueEvents([ev("fault", "cloudflared", 8)]);
    thrown.queue.tick();
    assert.equal(thrown.queue.snapshot().items[0].status, "unknown");
    assert.equal(throwTransport.calls.length, 1);
    assert.equal(thrown.queue.tick().attempted.length, 0);
  });

  it("does not auto-retry unknown; explicit retryUnknown may duplicate", () => {
    const transport = createFakeTransport([
      { outcome: "unknown", code: "lost_ack" },
      { outcome: "confirmed" },
    ]);
    const { queue } = makeQueue({ transport });
    const event = ev("fault", "http_health.public", 3);
    queue.enqueueEvents([event]);
    queue.tick();
    assert.equal(queue.snapshot().items[0].status, "unknown");
    assert.equal(queue.tick().attempted.length, 0);
    const retried = queue.retryUnknown(event.id);
    assert.equal(retried.reason, "may_duplicate");
    queue.tick();
    assert.equal(transport.calls.length, 2);
    assert.equal(queue.snapshot().items[0].status, "confirmed");
  });

  it("cancels queued items as cancelled, and inflight as unknown", () => {
    const { queue } = makeQueue();
    const queued = ev("fault", "beian-server-8787", 1);
    queue.enqueueEvents([queued]);
    assert.equal(queue.cancel(queued.id).status, "cancelled");
    assert.equal(queue.snapshot().items[0].status, "cancelled");

    let queueRef;
    const transport = createFakeTransport([(payload) => {
      const result = queueRef.cancel(payload.event_id);
      assert.equal(result.status, "unknown");
      return { outcome: "confirmed" };
    }]);
    const inflight = makeQueue({ transport });
    queueRef = inflight.queue;
    const event = ev("recovery", "beian-server-8787", 2);
    inflight.queue.enqueueEvents([event]);
    inflight.queue.tick();
    assert.equal(inflight.queue.snapshot().items[0].status, "unknown");
  });
});

describe("persistence windows", () => {
  it("refuses a corrupt state file and does not reset it", () => {
    const dir = tmpDir();
    const statePath = join(dir, "delivery.json");
    writeFileSync(statePath, "{not-json");
    assert.throws(
      () => createDeliveryQueue({ statePath, clock: createFakeClock(), transport: createFakeTransport() }),
      DeliveryStateError,
    );
    assert.equal(readFileSync(statePath, "utf8"), "{not-json");
  });

  it("refuses a file that claims exactly-once", () => {
    const dir = tmpDir();
    const statePath = join(dir, "delivery.json");
    const payload = emptyDeliveryState();
    payload.exactly_once = true;
    writeFileSync(statePath, `${JSON.stringify(payload)}\n`);
    assert.throws(
      () => createDeliveryQueue({ statePath, clock: createFakeClock(), transport: createFakeTransport() }),
      /claims_exactly_once/,
    );
    assert.match(readFileSync(statePath, "utf8"), /"exactly_once":\s*true/);
  });

  it("keeps the old file when enqueue persist fails", () => {
    const dir = tmpDir();
    const statePath = join(dir, "delivery.json");
    writeFileSync(statePath, serializeDeliveryState(emptyDeliveryState()));
    const queue = createDeliveryQueue({
      statePath,
      clock: createFakeClock(),
      transport: createFakeTransport(),
      writeFile: (dest, contents, hooks) => atomicWriteFile(dest, contents, {
        ...hooks,
        rename() {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        },
      }),
    });
    assert.throws(() => queue.enqueueEvents([ev("fault", "cloudflared", 1)]));
    assert.equal(queue.snapshot().items.length, 0);
    assert.deepEqual(parseDeliveryState(readFileSync(statePath, "utf8")).state.items, []);
    assert.deepEqual(readdirSync(dir), ["delivery.json"]);
  });

  it("does not call transport when the sending persist fails", () => {
    const transport = createFakeTransport();
    let writes = 0;
    const { queue } = makeQueue({
      transport,
      writeFile(dest, contents, hooks) {
        writes += 1;
        if (writes >= 2) throw new Error("disk failure");
        return atomicWriteFile(dest, contents, hooks);
      },
    });
    queue.enqueueEvents([ev("fault", "beian-server-8787", 4)]);
    assert.throws(() => queue.tick(), /disk failure/);
    assert.equal(transport.calls.length, 0);
    assert.equal(queue.snapshot().items[0].status, "queued");
  });

  it("reload of sending after a post-send persist failure becomes unknown, not a silent resend", () => {
    const dir = tmpDir();
    const statePath = join(dir, "delivery.json");
    const clock = createFakeClock();
    const transport = createFakeTransport();
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
    queue.enqueueEvents([ev("fault", "beian-server-8787", 6)]);
    assert.throws(() => queue.tick(), /disk failure/);
    assert.equal(transport.calls.length, 1);
    assert.equal(parseDeliveryState(readFileSync(statePath, "utf8")).state.items[0].status, "sending");

    const restarted = createDeliveryQueue({
      statePath,
      clock,
      transport: createFakeTransport(),
    });
    const item = restarted.snapshot().items[0];
    assert.equal(item.status, "unknown");
    assert.equal(item.last_outcome.code, "restart_while_sending");
    assert.equal(restarted.tick().attempted.length, 0);
    assert.equal(parseDeliveryState(readFileSync(statePath, "utf8")).state.items[0].status, "unknown");
  });

  it("reloads retry_wait after restart without duplicating the record", () => {
    const dir = tmpDir();
    const statePath = join(dir, "delivery.json");
    const clock = createFakeClock();
    const transport = createFakeTransport([{ outcome: "failed", retryable: true, code: "busy" }]);
    const first = createDeliveryQueue({
      statePath,
      clock,
      transport,
      config: { backoff_ms: 5000 },
    });
    const event = ev("fault", "cloudflared", 7);
    first.enqueueEvents([event]);
    first.tick();
    const second = createDeliveryQueue({
      statePath,
      clock,
      transport: createFakeTransport(),
    });
    assert.equal(second.snapshot().items.length, 1);
    assert.equal(second.snapshot().items[0].status, "retry_wait");
    assert.equal(second.enqueueEvents([event]).duplicates.length, 1);
    assert.equal(second.tick().attempted.length, 0);
  });
});

describe("default transport", () => {
  it("does not send when no transport is injected", () => {
    const { queue } = makeQueue({ noTransport: true });
    queue.enqueueEvents([ev("fault", "beian-server-8787", 9)]);
    const result = queue.tick();
    assert.equal(result.skipped, "no_transport");
    assert.equal(result.attempted.length, 0);
    assert.equal(queue.snapshot().items[0].status, "queued");
  });
});

it("does not persist arbitrary transport response codes and remains reloadable", () => {
  for (const outcome of ["confirmed", "failed", "unknown"]) {
    for (const code of ["private-response-marker", { raw_response: "private-response-marker" }]) {
      const { queue, statePath } = makeQueue({ transport: createFakeTransport([{ outcome, code }]) });
      queue.enqueueEvents([ev("fault", "cloudflared", 1)]);
      queue.tick();
      const raw = readFileSync(statePath, "utf8");
      assert.doesNotMatch(raw, /private-response-marker/);
      assert.equal(parseDeliveryState(raw).ok, true);
    }
  }
});

it("uses each persisted retry limit after restart with a different default", () => {
  for (const [original, next, expected] of [[2, 3, "failed"], [3, 1, "retry_wait"]]) {
    const statePath = join(tmpDir(), "retry.json");
    const clock = createFakeClock();
    const transport = createFakeTransport(() => ({outcome:"failed",retryable:true,code:"busy"}));
    const first = createDeliveryQueue({statePath,clock,transport,config:{max_attempts:original,backoff_ms:1}});
    first.enqueueEvents([ev("fault","cloudflared",1)]);
    first.tick(); clock.advance(10);
    const restarted = createDeliveryQueue({statePath,clock,transport,config:{max_attempts:next}});
    restarted.tick();
    const item = restarted.snapshot().items[0];
    assert.equal(item.max_attempts,original);
    assert.equal(item.attempt,2);
    assert.equal(item.status,expected);
  }
});
