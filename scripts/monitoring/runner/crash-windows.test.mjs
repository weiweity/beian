import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { atomicWriteFile, replaySamples } from "../alert-core.mjs";
import { createFakeTransport } from "../delivery/fake-transport.mjs";
import {
  createFakeClock,
  createFixtureSampler,
  createLocalMonitor,
  createManualScheduler,
  emptyRunnerState,
  parseRunnerState,
  serializeRunnerState,
} from "./runner-core.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "beian-runner-crash-"));
}

function stoppedFacts() {
  return {
    "beian-server-8787": { kind: "windows_service", sample_ok: true, observed: "stopped" },
    cloudflared: { kind: "windows_service", sample_ok: true, observed: "running" },
  };
}

function sampleAt(seconds, id = "s1") {
  return {
    id,
    sampled_at: new Date(Date.parse("2026-09-09T00:00:00.000Z") + seconds * 1000).toISOString(),
    facts: stoppedFacts(),
  };
}

function makeRunner(opts = {}) {
  const dir = opts.dir || tmpDir();
  const clock = opts.clock || createFakeClock();
  const scheduler = opts.scheduler || createManualScheduler();
  const sampler = opts.sampler || createFixtureSampler(opts.samples || [sampleAt(0), sampleAt(1, "s2")]);
  const transport = opts.transport || createFakeTransport();
  const runner = createLocalMonitor({
    stateDir: dir,
    clock,
    scheduler,
    sampler,
    transport,
    queue: opts.queue,
    writeFile: opts.writeFile,
    writeHooks: opts.writeHooks,
    hooks: opts.hooks,
    pid: opts.pid,
    isAlive: opts.isAlive,
    config: {
      fail_threshold: 1,
      recover_threshold: 1,
      interval_ms: 1000,
      first_delay_ms: 0,
      ...opts.config,
    },
  });
  return { dir, clock, scheduler, sampler, transport, runner };
}

async function restartFrom(dir, opts = {}) {
  const next = makeRunner({ dir, ...opts });
  await next.runner.start({ schedule: false });
  return next;
}

describe("crash window matrix", () => {
  it("W1 crash before handoff persist keeps previous core and can re-emit the same event.id", async () => {
    const dir = tmpDir();
    const first = makeRunner({
      dir,
      writeFile() {
        throw new Error("crash_before_handoff");
      },
    });
    await first.runner.start({ schedule: false });
    await assert.rejects(() => first.runner.runCycle(), /crash_before_handoff/);
    assert.equal(first.runner.snapshot().core.last_sampled_at, null);
    assert.equal(first.runner.snapshot().pending_event_ids.length, 0);
    assert.equal(readdirSync(dir).includes("runner.json"), false);
    await first.runner.stop();

    const restarted = await restartFrom(dir, {
      sampler: createFixtureSampler([sampleAt(0), sampleAt(1, "s2")]),
    });
    const cycle = await restarted.runner.runCycle();
    assert.equal(cycle.events[0].id, "fault:beian-server-8787:2026-09-09T00:00:00.000Z");
    assert.equal(restarted.runner.deliverySnapshot().items.length, 1);
    await restarted.runner.stop();
  });

  it("W2 crash after handoff persist and before enqueue recovers the original event.id", async () => {
    const dir = tmpDir();
    const first = makeRunner({
      dir,
      hooks: {
        async afterHandoffPersist() {
          throw new Error("crash_after_handoff");
        },
      },
    });
    await first.runner.start({ schedule: false });
    await assert.rejects(() => first.runner.runCycle(), /crash_after_handoff/);
    const pendingId = first.runner.snapshot().pending_event_ids[0];
    assert.equal(pendingId, "fault:beian-server-8787:2026-09-09T00:00:00.000Z");
    assert.ok(first.runner.snapshot().core.sources["beian-server-8787"]);
    assert.equal(parseRunnerState(readFileSync(join(dir, "runner.json"), "utf8")).state.pending.events[0].id, pendingId);
    await first.runner.stop();

    const restarted = await restartFrom(dir);
    assert.equal(restarted.runner.snapshot().pending_event_ids.length, 0);
    assert.deepEqual(
      restarted.runner.deliverySnapshot().items.map((item) => item.event_id),
      [pendingId],
    );
    assert.equal(restarted.sampler.calls.length, 0);
    await restarted.runner.stop();
  });

  it("W3 crash after enqueue and before ack re-handoffs the same event.id without a second delivery record", async () => {
    const dir = tmpDir();
    const first = makeRunner({
      dir,
      hooks: {
        async afterEnqueue() {
          throw new Error("crash_after_enqueue");
        },
      },
    });
    await first.runner.start({ schedule: false });
    await assert.rejects(() => first.runner.runCycle(), /crash_after_enqueue/);
    assert.equal(first.runner.snapshot().pending_event_ids.length, 1);
    assert.equal(first.runner.deliverySnapshot().items.length, 1);
    await first.runner.stop();

    const restarted = await restartFrom(dir);
    const items = restarted.runner.deliverySnapshot().items;
    assert.equal(items.length, 1);
    assert.equal(items[0].event_id, "fault:beian-server-8787:2026-09-09T00:00:00.000Z");
    assert.equal(items[0].status, "confirmed");
    assert.equal(restarted.runner.snapshot().pending_event_ids.length, 0);
    assert.equal(restarted.runner.snapshot().last_handoff.duplicates.length, 1);
    await restarted.runner.stop();
  });

  it("W4 handoff write failure keeps the previous file and does not advance core", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "runner.json"), serializeRunnerState(emptyRunnerState()));
    const first = makeRunner({
      dir,
      writeFile(dest, contents, hooks) {
        return atomicWriteFile(dest, contents, {
          ...hooks,
          rename() {
            throw Object.assign(new Error("denied"), { code: "EPERM" });
          },
        });
      },
    });
    await first.runner.start({ schedule: false });
    await assert.rejects(() => first.runner.runCycle(), /denied/);
    const loaded = parseRunnerState(readFileSync(join(dir, "runner.json"), "utf8"));
    assert.equal(loaded.state.sequence, 0);
    assert.equal(loaded.state.pending.events.length, 0);
    assert.equal(first.runner.snapshot().core.last_sampled_at, null);
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
    await first.runner.stop();
  });

  it("W5 ack write failure keeps pending so restart can finish the handoff", async () => {
    const dir = tmpDir();
    let writes = 0;
    const first = makeRunner({
      dir,
      writeFile(dest, contents, hooks) {
        writes += 1;
        const parsed = JSON.parse(contents);
        if (writes >= 2 && parsed.pending.events.length === 0) {
          throw new Error("ack_fail");
        }
        return atomicWriteFile(dest, contents, hooks);
      },
    });
    await first.runner.start({ schedule: false });
    await assert.rejects(() => first.runner.runCycle(), /ack_fail/);
    const disk = parseRunnerState(readFileSync(join(dir, "runner.json"), "utf8"));
    assert.equal(disk.state.pending.events.length, 1);
    assert.equal(first.runner.deliverySnapshot().items.length, 1);
    await first.runner.stop();

    const restarted = await restartFrom(dir);
    assert.equal(restarted.runner.snapshot().pending_event_ids.length, 0);
    assert.equal(restarted.runner.deliverySnapshot().items.length, 1);
    await restarted.runner.stop();
  });

  it("W6 planted pending is recovered on start without sampling again", async () => {
    const dir = tmpDir();
    const replay = replaySamples([sampleAt(0)], { config: { fail_threshold: 1, recover_threshold: 1 } });
    const planted = emptyRunnerState();
    planted.sequence = 4;
    planted.core = replay.state;
    planted.pending = {
      cycle_seq: 4,
      sampled_at: replay.events[0].at,
      sample_id: "planted",
      events: replay.events,
      drafts: replay.drafts,
    };
    writeFileSync(join(dir, "runner.json"), serializeRunnerState(planted));
    const sampler = createFixtureSampler([sampleAt(9, "should-not-run")]);
    const { runner } = makeRunner({ dir, sampler });
    await runner.start({ schedule: false });
    assert.equal(sampler.calls.length, 0);
    assert.equal(runner.snapshot().pending_event_ids.length, 0);
    assert.equal(runner.deliverySnapshot().items[0].event_id, replay.events[0].id);
    await runner.stop();
  });
});
