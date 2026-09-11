import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createFakeTransport } from "../delivery/fake-transport.mjs";
import {
  LOCAL_RUNNER_DEFAULTS,
  RUNNER_EXACTLY_ONCE,
  RunnerLockError,
  RunnerStateError,
  createFakeClock,
  createFixtureSampler,
  createLocalMonitor,
  createManualScheduler,
  emptyRunnerState,
  parseRunnerState,
  serializeRunnerState,
} from "./runner-core.mjs";
import { runExample } from "./example.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "beian-runner-"));
}

function stoppedFacts() {
  return {
    "beian-server-8787": { kind: "windows_service", sample_ok: true, observed: "stopped" },
    cloudflared: { kind: "windows_service", sample_ok: true, observed: "running" },
  };
}

function runningFacts() {
  return {
    "beian-server-8787": { kind: "windows_service", sample_ok: true, observed: "running" },
    cloudflared: { kind: "windows_service", sample_ok: true, observed: "running" },
  };
}

function sampleAt(seconds, facts, id) {
  return {
    id,
    sampled_at: new Date(Date.parse("2026-09-09T00:00:00.000Z") + seconds * 1000).toISOString(),
    facts,
  };
}

function makeRunner(opts = {}) {
  const dir = opts.dir || tmpDir();
  const clock = opts.clock || createFakeClock();
  const scheduler = opts.scheduler || createManualScheduler();
  const samples = opts.samples || [
    sampleAt(0, stoppedFacts(), "s1"),
    sampleAt(1, stoppedFacts(), "s2"),
    sampleAt(2, runningFacts(), "s3"),
    sampleAt(3, runningFacts(), "s4"),
  ];
  const sampler = opts.useDefaultSampler
    ? undefined
    : (opts.sampler || createFixtureSampler(samples));
  const transport = opts.noTransport ? null : (opts.transport || createFakeTransport());
  const runner = createLocalMonitor({
    stateDir: dir,
    clock,
    scheduler,
    ...(sampler ? { sampler } : {}),
    transport,
    queue: opts.queue,
    createQueue: opts.createQueue,
    writeFile: opts.writeFile,
    writeHooks: opts.writeHooks,
    hooks: opts.hooks,
    lock: opts.lock,
    pid: opts.pid,
    isAlive: opts.isAlive,
    probe: opts.probe,
    httpGet: opts.httpGet,
    exec: opts.exec,
    platform: opts.platform,
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

describe("runner config", () => {
  it("tags defaults as local candidates and refuses exactly-once claims", () => {
    assert.equal(LOCAL_RUNNER_DEFAULTS.production_default, false);
    assert.equal(LOCAL_RUNNER_DEFAULTS.local_candidate, true);
    assert.equal(RUNNER_EXACTLY_ONCE, false);
    assert.equal(LOCAL_RUNNER_DEFAULTS.interval_ms, 30_000);
  });
});

describe("sample to delivery loop", () => {
  it("handoffs a fault then a recovery without overlapping samples", async () => {
    const { runner, sampler, transport } = makeRunner();
    await runner.start({ schedule: false });
    const first = await runner.runCycle();
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].type, "fault");
    assert.equal(first.events[0].source, "beian-server-8787");
    const second = await runner.runCycle();
    assert.equal(second.events.length, 0);
    const third = await runner.runCycle();
    assert.equal(third.events[0].type, "recovery");
    const items = runner.deliverySnapshot().items;
    assert.deepEqual(items.map((item) => item.type), ["fault", "recovery"]);
    assert.equal(items.every((item) => item.status === "confirmed"), true);
    assert.deepEqual(transport.calls.map((call) => call.type), ["fault", "recovery"]);
    assert.equal(sampler.calls.length, 3);
    assert.equal(sampler.calls.every((call) => call.publicUrl == null && call.loopbackUrl == null), true);
    await runner.stop();
  });

  it("does not start a second sample while one is in flight", async () => {
    let release;
    const sampler = {
      calls: 0,
      async collectSample() {
        this.calls += 1;
        await new Promise((resolve) => { release = resolve; });
        return { sample: sampleAt(0, stoppedFacts(), "hang") };
      },
    };
    const { runner } = makeRunner({ sampler });
    await runner.start({ schedule: false });
    const first = runner.runCycle();
    while (sampler.calls === 0) await new Promise((resolve) => setImmediate(resolve));
    const overlapped = await runner.runCycle();
    assert.equal(overlapped.skipped, "overlap");
    assert.equal(sampler.calls, 1);
    release();
    const result = await first;
    assert.equal(result.events[0].type, "fault");
    await runner.stop();
  });

  it("awaits queue.tick even when it returns a Promise", async () => {
    let hangTick = false;
    let releaseTick;
    let tickStarted;
    const started = new Promise((resolve) => { tickStarted = resolve; });
    const queue = {
      enqueueFromReplay(replay) {
        return { added: replay.events.map((event) => ({ event_id: event.id })), duplicates: [] };
      },
      async tick() {
        if (!hangTick) return { attempted: [], skipped: "no_transport" };
        tickStarted();
        await new Promise((resolve) => { releaseTick = resolve; });
        return { attempted: [{ event_id: "async" }], skipped: null };
      },
      snapshot() {
        return { items: [] };
      },
    };
    const { runner } = makeRunner({ queue });
    await runner.start({ schedule: false });
    hangTick = true;
    const cycle = runner.runCycle();
    await started;
    assert.equal(runner.snapshot().phase, "tick");
    releaseTick();
    const result = await cycle;
    assert.equal(result.tick.attempted[0].event_id, "async");
    await runner.stop();
  });

  it("keeps events queued when no transport is configured", async () => {
    const { runner } = makeRunner({ noTransport: true });
    await runner.start({ schedule: false });
    await runner.runCycle();
    assert.equal(runner.deliverySnapshot().items[0].status, "queued");
    assert.equal(runner.snapshot().last_tick.skipped, "no_transport");
    await runner.stop();
  });

  it("does not call httpGet when probe URLs stay unset", async () => {
    let httpCalls = 0;
    const { runner } = makeRunner({
      useDefaultSampler: true,
      httpGet: async () => {
        httpCalls += 1;
        throw new Error("network should not run");
      },
      platform: "darwin",
    });
    await runner.start({ schedule: false });
    const result = await runner.runCycle();
    assert.equal(httpCalls, 0);
    assert.equal(result.events.length, 0);
    await runner.stop();
  });
});

describe("bounded stop", () => {
  it("aborts an in-flight sample and does not ingest it", async () => {
    let inSample;
    const started = new Promise((resolve) => { inSample = resolve; });
    const sampler = {
      async collectSample({ signal }) {
        await new Promise((_, reject) => {
          const fail = () => {
            const err = new Error("cancelled");
            err.reason = "cancelled";
            reject(err);
          };
          if (signal?.aborted) {
            fail();
            return;
          }
          signal.addEventListener("abort", fail, { once: true });
          inSample();
        });
      },
    };
    const { runner, scheduler } = makeRunner({ sampler });
    await runner.start({ schedule: false });
    const cycle = runner.runCycle();
    await started;
    const stopped = await runner.stop();
    const result = await cycle;
    assert.equal(stopped.sample_aborted, true);
    assert.equal(stopped.in_flight, "sampling");
    assert.equal(result.skipped, "cancelled");
    assert.equal(runner.snapshot().core.last_sampled_at, null);
    assert.equal(runner.snapshot().pending_event_ids.length, 0);
    assert.equal(scheduler.pending, 0);
  });

  it("lets a finished sample complete handoff before exiting", async () => {
    let inHandoff;
    const reached = new Promise((resolve) => { inHandoff = resolve; });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    const { runner } = makeRunner({
      hooks: {
        async afterHandoffPersist() {
          inHandoff();
          await gate;
        },
      },
    });
    await runner.start({ schedule: false });
    const cycle = runner.runCycle();
    await reached;
    const stopping = runner.stop();
    resume();
    const [result, stopped] = await Promise.all([cycle, stopping]);
    assert.equal(result.events[0].type, "fault");
    assert.equal(stopped.sample_aborted, false);
    assert.equal(runner.snapshot().pending_event_ids.length, 0);
    assert.equal(runner.deliverySnapshot().items[0].status, "confirmed");
  });

  it("does not schedule a new sample after stop", async () => {
    const { runner, scheduler, sampler } = makeRunner();
    await runner.start();
    await scheduler.runNext();
    assert.equal(sampler.calls.length, 1);
    await runner.stop();
    assert.equal(scheduler.pending, 0);
    assert.equal(sampler.calls.length, 1);
  });
});

describe("single instance", () => {
  it("refuses a second start against the same stateDir while the first is alive", async () => {
    const dir = tmpDir();
    const first = makeRunner({ dir, pid: 111, isAlive: (pid) => pid === 111 });
    await first.runner.start({ schedule: false });
    const second = makeRunner({ dir, pid: 222, isAlive: (pid) => pid === 111 || pid === 222 });
    await assert.rejects(() => second.runner.start({ schedule: false }), RunnerLockError);
    await first.runner.runCycle();
    assert.equal(first.runner.deliverySnapshot().items.length, 1);
    await first.runner.stop();
  });

  it("takes over a stale lock after the previous pid is dead and recovers pending", async () => {
    const dir = tmpDir();
    const first = makeRunner({
      dir,
      pid: 111,
      isAlive: (pid) => pid === 111,
      hooks: {
        async afterHandoffPersist() {
          throw new Error("crash_after_handoff");
        },
      },
    });
    await first.runner.start({ schedule: false });
    await assert.rejects(() => first.runner.runCycle(), /crash_after_handoff/);
    await first.runner.stop();
    const restarted = makeRunner({ dir, pid: 222, isAlive: (pid) => pid === 222 });
    await restarted.runner.start({ schedule: false });
    assert.equal(restarted.runner.snapshot().pending_event_ids.length, 0);
    assert.equal(restarted.runner.deliverySnapshot().items[0].type, "fault");
    await restarted.runner.stop();
  });

  it("refuses start twice on the same instance", async () => {
    const { runner } = makeRunner();
    await runner.start({ schedule: false });
    await assert.rejects(() => runner.start({ schedule: false }), /already started/);
    await runner.stop();
  });
});

describe("bad state", () => {
  it("refuses a corrupt runner file and does not reset it", () => {
    const dir = tmpDir();
    const path = join(dir, "runner.json");
    writeFileSync(path, "{not-json");
    assert.throws(
      () => createLocalMonitor({
        stateDir: dir,
        sampler: createFixtureSampler([sampleAt(0, stoppedFacts(), "x")]),
        scheduler: createManualScheduler(),
        clock: createFakeClock(),
      }),
      RunnerStateError,
    );
    assert.equal(readFileSync(path, "utf8"), "{not-json");
  });

  it("refuses a file that claims exactly-once", () => {
    const dir = tmpDir();
    const path = join(dir, "runner.json");
    const payload = emptyRunnerState();
    payload.exactly_once = true;
    writeFileSync(path, `${JSON.stringify(payload)}\n`);
    assert.throws(
      () => createLocalMonitor({
        stateDir: dir,
        sampler: createFixtureSampler([sampleAt(0, stoppedFacts(), "x")]),
        scheduler: createManualScheduler(),
        clock: createFakeClock(),
      }),
      /claims_exactly_once/,
    );
    assert.match(readFileSync(path, "utf8"), /"exactly_once":\s*true/);
    assert.equal(parseRunnerState(readFileSync(path, "utf8")).ok, false);
  });
});

describe("example", () => {
  it("replays the down fixture through fake transport without sending real messages", async () => {
    const result = await runExample();
    assert.equal(result.notify, false);
    assert.equal(result.production_send, false);
    assert.equal(result.exactly_once, false);
    assert.equal(result.sampler_calls, 3);
    assert.equal(result.delivery.length, 1);
    assert.equal(result.delivery[0].type, "fault");
    assert.equal(result.delivery[0].source, "beian-server-8787");
    assert.equal(result.delivery[0].status, "confirmed");
    assert.equal(result.transport_calls, 1);
    assert.equal(serializeRunnerState(emptyRunnerState()).includes("beian-monitor-runner-v1"), true);
  });
});
