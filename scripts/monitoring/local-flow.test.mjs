import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createProbe } from "./probes/collect.mjs";
import { replaySamples } from "./alert-core.mjs";
import { createDeliveryQueue, createFakeClock } from "./delivery/delivery-core.mjs";
import { createFakeTransport } from "./delivery/fake-transport.mjs";

async function observations(statuses) {
  const samples = [];
  for (const [index, status] of statuses.entries()) {
    const result = await createProbe({
      now: () => new Date(Date.UTC(2026, 8, 9, 0, 0, index)),
      exec: async () => ({ code: 0, stdout: JSON.stringify([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ]) }),
      httpGet: async () => {
        if (status === null) throw { reason: "timeout" };
        return { status, bodyText: JSON.stringify({
          ok: true, runtime: "typescript", version: "0.24.0.0",
          jobs: { illustrator: { visibility: "authenticated" } },
        }) };
      },
    }).collectSample({ id: `s${index}`, publicUrl: "https://example.test/api/health" });
    samples.push(result.sample);
  }
  return replaySamples(samples, { config: { fail_threshold: 2, recover_threshold: 2 } });
}

function stateFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "beian-monitor-flow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "delivery.json");
}

it("probe to alert to delivery preserves source, retry order and restart dedup", async (t) => {
  const replay = await observations([200, 502, 502, 502, 200, 200]);
  assert.deepEqual(replay.events.map(({ source, type }) => ({ source, type })), [
    { source: "http_health.public", type: "fault" },
    { source: "http_health.public", type: "recovery" },
  ]);
  const statePath = stateFile(t);
  const clock = createFakeClock();
  const transport = createFakeTransport([
    { outcome: "failed", retryable: true, code: "busy" },
    { outcome: "confirmed" }, { outcome: "confirmed" },
  ]);
  const queue = createDeliveryQueue({ statePath, clock, transport });
  queue.enqueueFromReplay(replay);
  await queue.tick();
  assert.deepEqual(transport.calls.map(({ type }) => type), ["fault"]);
  clock.advance(1000);
  await queue.tick();
  assert.deepEqual(transport.calls.map(({ type }) => type), ["fault", "fault", "recovery"]);
  const restarted = createDeliveryQueue({ statePath, clock, transport });
  assert.equal(restarted.enqueueFromReplay(replay).added.length, 0);
  assert.equal(restarted.tick().attempted.length, 0);
  assert.doesNotMatch(JSON.stringify(restarted.snapshot().items), /example\.test/);
});

it("composed default has no sender even when a fault is queued", async (t) => {
  const replay = await observations([502, 502]);
  const queue = createDeliveryQueue({ statePath: stateFile(t) });
  queue.enqueueFromReplay(replay);
  assert.equal(queue.tick().skipped, "no_transport");
  assert.equal(queue.snapshot().items[0].status, "queued");
});

it("sampling timeout remains unknown and never invents a stopped-service delivery", async (t) => {
  const replay = await observations([null, null, null]);
  const transport = createFakeTransport();
  const queue = createDeliveryQueue({ statePath: stateFile(t), transport });
  queue.enqueueFromReplay(replay);
  await queue.tick();
  assert.equal(replay.events.length, 0);
  assert.equal(transport.calls.length, 0);
});
