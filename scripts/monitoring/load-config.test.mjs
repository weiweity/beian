import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LOCAL_CANDIDATE_DEFAULTS, replaySamples } from "./alert-core.mjs";
import {
  EXAMPLE_CONFIG_PATH,
  MONITOR_CONFIG_SCHEMA,
  MonitoringConfigError,
  loadMonitoringConfig,
} from "./config/load-config.mjs";
import { LOCAL_DELIVERY_DEFAULTS, createDeliveryQueue, createFakeClock, normalizeDeliveryConfig } from "./delivery/delivery-core.mjs";
import { createFakeTransport } from "./delivery/fake-transport.mjs";
import {
  LOCAL_RUNNER_DEFAULTS,
  createFixtureSampler,
  createLocalMonitor,
  createManualScheduler,
  normalizeRunnerConfig,
} from "./runner/runner-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function tmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "beian-monitor-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(t, payload, name = "local.json") {
  const dir = tmpDir(t);
  const path = join(dir, name);
  writeFileSync(path, typeof payload === "string" ? payload : `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

function validPolicy(overrides = {}) {
  return {
    schema: MONITOR_CONFIG_SCHEMA,
    production_default: false,
    local_candidate: true,
    alert: {
      fail_threshold: 3,
      recover_threshold: 2,
      unknown_breaks_streak: true,
      seen_ids_limit: 256,
    },
    runner: {
      interval_ms: 30000,
      first_delay_ms: 0,
      probe_timeout_ms: 8000,
    },
    delivery: {
      max_attempts: 3,
      backoff_ms: 1000,
      timeout_ms: 5000,
    },
    ...overrides,
  };
}

function loadFixture(name) {
  return JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
}

function assertThrowsCode(fn, code, field) {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (err) {
    assert.equal(err instanceof MonitoringConfigError, true);
    assert.equal(err.code, code);
    if (field !== undefined) assert.equal(err.field, field);
  }
}

describe("loadMonitoringConfig", () => {
  it("loads the synthetic example and matches existing module defaults", () => {
    const loaded = loadMonitoringConfig(EXAMPLE_CONFIG_PATH);
    assert.equal(loaded.schema, MONITOR_CONFIG_SCHEMA);
    assert.equal(loaded.notify, false);
    assert.equal(loaded.production_send, false);
    assert.equal(loaded.production_default, false);
    assert.deepEqual(loaded.alert, {
      schema: LOCAL_CANDIDATE_DEFAULTS.schema,
      production_default: false,
      local_candidate: true,
      fail_threshold: 3,
      recover_threshold: 2,
      unknown_breaks_streak: true,
      seen_ids_limit: 256,
      sources: [...LOCAL_CANDIDATE_DEFAULTS.sources],
    });
    assert.equal(loaded.runner.interval_ms, LOCAL_RUNNER_DEFAULTS.interval_ms);
    assert.equal(loaded.runner.probe_timeout_ms, LOCAL_RUNNER_DEFAULTS.probe_timeout_ms);
    assert.equal(loaded.runner.first_delay_ms, LOCAL_RUNNER_DEFAULTS.first_delay_ms);
    assert.deepEqual(loaded.delivery, normalizeDeliveryConfig());
    assert.deepEqual(loaded.runner, normalizeRunnerConfig({
      fail_threshold: 3,
      recover_threshold: 2,
      unknown_breaks_streak: true,
      seen_ids_limit: 256,
      sources: [...LOCAL_CANDIDATE_DEFAULTS.sources],
      local_candidate: true,
    }));
    assert.equal(JSON.stringify(loaded).includes("token"), false);
    assert.equal(JSON.stringify(loaded).includes("webhook"), false);
  });

  it("fills omitted policy sections from existing defaults", (t) => {
    const loaded = loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      alert: { fail_threshold: 1 },
    }));
    assert.equal(loaded.alert.fail_threshold, 1);
    assert.equal(loaded.alert.recover_threshold, LOCAL_CANDIDATE_DEFAULTS.recover_threshold);
    assert.equal(loaded.runner.fail_threshold, 1);
    assert.equal(loaded.runner.interval_ms, LOCAL_RUNNER_DEFAULTS.interval_ms);
    assert.equal(loaded.delivery.max_attempts, LOCAL_DELIVERY_DEFAULTS.max_attempts);
  });

  it("does not read environment variables or sibling secret files", (t) => {
    const dir = tmpDir(t);
    const path = join(dir, "policy.json");
    writeFileSync(path, `${JSON.stringify({ schema: MONITOR_CONFIG_SCHEMA })}\n`);
    writeFileSync(join(dir, ".env"), "FEISHU_APP_SECRET=do-not-read\n");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ token: "do-not-read" }));
    const previous = process.env.BEIAN_MONITOR_FAIL_THRESHOLD;
    process.env.BEIAN_MONITOR_FAIL_THRESHOLD = "1";
    process.env.FEISHU_APP_SECRET = "do-not-read";
    try {
      const loaded = loadMonitoringConfig(path);
      assert.equal(loaded.alert.fail_threshold, LOCAL_CANDIDATE_DEFAULTS.fail_threshold);
    } finally {
      if (previous === undefined) delete process.env.BEIAN_MONITOR_FAIL_THRESHOLD;
      else process.env.BEIAN_MONITOR_FAIL_THRESHOLD = previous;
      delete process.env.FEISHU_APP_SECRET;
    }
  });

  it("rejects a missing file instead of running defaults", (t) => {
    const path = join(tmpDir(t), "missing.json");
    assertThrowsCode(() => loadMonitoringConfig(path), "missing_file", "path");
  });

  it("rejects a relative path and a directory", (t) => {
    assertThrowsCode(() => loadMonitoringConfig("local.example.json"), "path_not_absolute", "path");
    assertThrowsCode(() => loadMonitoringConfig(tmpDir(t)), "not_a_file", "path");
  });

  it("rejects invalid JSON without echoing the file text", (t) => {
    const secret = "super-secret-value-xyz";
    const path = writeConfig(t, `{ "token": "${secret}"`);
    try {
      loadMonitoringConfig(path);
      assert.fail("expected invalid JSON");
    } catch (err) {
      assert.equal(err instanceof MonitoringConfigError, true);
      assert.equal(err.code, "invalid_json");
      assert.equal(err.message.includes(secret), false);
      assert.equal(JSON.stringify(err.details).includes(secret), false);
    }
  });

  it("rejects a JSON array or non-object", (t) => {
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, "[]")), "not_object", null);
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, "true")), "not_object", null);
  });

  it("rejects unsupported or missing schema", (t) => {
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {})), "missing_schema", "schema");
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: "beian-alert-config-v1",
    })), "unsupported_schema", "schema");
  });

  it("rejects unknown fields", (t) => {
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      extra: 1,
    })), "unknown_field", "extra");
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      alert: { fail_threshold: 3, window_ms: 5 },
    })), "unknown_field", "alert.window_ms");
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      runner: { interval_ms: 1000, fail_threshold: 1 },
    })), "unknown_field", "runner.fail_threshold");
  });

  it("rejects forbidden fields without echoing secret values", (t) => {
    const secret = "super-secret-value-xyz";
    const cases = [
      [{ schema: MONITOR_CONFIG_SCHEMA, token: secret }, "token"],
      [{ schema: MONITOR_CONFIG_SCHEMA, delivery: { webhook: secret } }, "delivery.webhook"],
      [{ schema: MONITOR_CONFIG_SCHEMA, transport: { send: true } }, "transport"],
      [{ schema: MONITOR_CONFIG_SCHEMA, notify: true }, "notify"],
      [{ schema: MONITOR_CONFIG_SCHEMA, loopbackUrl: "http://127.0.0.1:8787/api/health" }, "loopbackUrl"],
      [{ schema: MONITOR_CONFIG_SCHEMA, channel: "feishu", recipients: ["user-1"] }, "channel"],
      [{ schema: MONITOR_CONFIG_SCHEMA, exec: "Get-Service" }, "exec"],
    ];
    for (const [payload, field] of cases) {
      try {
        loadMonitoringConfig(writeConfig(t, payload));
        assert.fail(`expected forbidden ${field}`);
      } catch (err) {
        assert.equal(err instanceof MonitoringConfigError, true);
        assert.equal(err.code, "forbidden_field");
        assert.equal(err.field, field);
        assert.equal(err.message.includes(secret), false);
        assert.equal(JSON.stringify(err).includes(secret), false);
      }
    }
  });

  it("rejects production_default true instead of coercing it", (t) => {
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      production_default: true,
    })), "production_enabled", "production_default");
  });

  it("rejects wrong types and illegal ranges without falling back to defaults", (t) => {
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      alert: { fail_threshold: "3" },
    })), "invalid_type", "alert.fail_threshold");
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      alert: { unknown_breaks_streak: "true" },
    })), "invalid_type", "alert.unknown_breaks_streak");
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      delivery: { max_attempts: 0 },
    })), "invalid_range", "delivery");
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      runner: { first_delay_ms: -1 },
    })), "invalid_range", "runner");
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      alert: { fail_threshold: 1.5 },
    })), "invalid_range", "alert");
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      alert: null,
    })), "invalid_type", "alert");
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      alert: { fail_threshold: null },
    })), "invalid_type", "alert.fail_threshold");
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA,
      delivery: { max_attempts: null },
    })), "invalid_type", "delivery.max_attempts");
  });
});

describe("config loader coverage audit", () => {
  it("rejects absent and non-string explicit paths", () => {
    for (const path of [undefined, null, ""]) {
      assertThrowsCode(() => loadMonitoringConfig(path), "missing_path", "path");
    }
    for (const path of [42, false, {}, []]) {
      assertThrowsCode(() => loadMonitoringConfig(path), "invalid_type", "path");
    }
    const error = new MonitoringConfigError("synthetic validation error");
    assert.equal(error.name, "MonitoringConfigError");
    assert.deepEqual(error.details, { code: "invalid_config", field: null });
  });

  it("reports non-ENOENT stat failures without exposing the path", (t) => {
    const path = join(writeConfig(t, { schema: MONITOR_CONFIG_SCHEMA }), "child.json");
    assert.throws(() => loadMonitoringConfig(path), (error) => {
      assert.equal(error.code, "unreadable");
      assert.equal(error.field, "path");
      assert.equal(error.message.includes(path), false);
      return error instanceof MonitoringConfigError;
    });
  });

  it("sanitizes a read failure after the file passed stat", (t) => {
    const path = writeConfig(t, { schema: MONITOR_CONFIG_SCHEMA });
    const mocked = t.mock.method(fs, "readFileSync", () => {
      throw new Error("synthetic unreadable body marker");
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => loadMonitoringConfig(path), (error) => {
        assert.equal(error.code, "unreadable");
        assert.deepEqual(error.details, { code: "unreadable", field: "path" });
        assert.equal(error.message.includes("body marker"), false);
        return error instanceof MonitoringConfigError;
      });
      assert.equal(mocked.mock.callCount(), 1);
      assert.deepEqual(mocked.mock.calls[0].arguments, [path, "utf8"]);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(loadMonitoringConfig(path).schema, MONITOR_CONFIG_SCHEMA);
  });

  it("rejects null roots, invalid schemas and non-object policy sections", (t) => {
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, "null")), "not_object", null);
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, { schema: null })), "missing_schema", "schema");
    for (const schema of [false, 1, [], {}]) {
      assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, { schema })), "unsupported_schema", "schema");
    }
    for (const section of ["alert", "runner", "delivery"]) {
      for (const value of [null, [], false, "policy", 1]) {
        assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
          schema: MONITOR_CONFIG_SCHEMA, [section]: value,
        })), "invalid_type", section);
      }
    }
  });

  it("strips comments and rejects non-string comments at every allowed level", (t) => {
    const loaded = loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA, _comment: "top synthetic note",
      alert: { _comment: "alert note" }, runner: { _comment: "runner note" },
      delivery: { _comment: "delivery note" },
    }));
    for (const value of [loaded, loaded.alert, loaded.runner, loaded.delivery]) {
      assert.equal(Object.hasOwn(value, "_comment"), false);
    }
    for (const section of [null, "alert", "runner", "delivery"]) {
      const payload = { schema: MONITOR_CONFIG_SCHEMA };
      if (section) payload[section] = { _comment: {} };
      else payload._comment = {};
      assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, payload)), "invalid_type",
        section ? `${section}._comment` : "_comment");
    }
  });

  it("checks boolean types and preserves explicit false across all policies", (t) => {
    for (const field of ["production_default", "local_candidate"]) {
      for (const value of [null, "false", 0, []]) {
        assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
          schema: MONITOR_CONFIG_SCHEMA, [field]: value,
        })), "invalid_type", field);
      }
    }
    const loaded = loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA, local_candidate: false,
      alert: { unknown_breaks_streak: false },
    }));
    for (const policy of [loaded, loaded.alert, loaded.runner, loaded.delivery]) {
      assert.equal(policy.local_candidate, false);
      assert.equal(policy.production_default, false);
    }
    assert.equal(loaded.alert.unknown_breaks_streak, false);
    assert.equal(loaded.runner.unknown_breaks_streak, false);
    assert.equal(Object.isFrozen(loaded), true);
  });

  it("validates every numeric policy field including nonfinite JSON numbers", (t) => {
    const fields = {
      alert: ["fail_threshold", "recover_threshold", "seen_ids_limit"],
      runner: ["interval_ms", "first_delay_ms", "probe_timeout_ms"],
      delivery: ["max_attempts", "backoff_ms", "timeout_ms"],
    };
    for (const [section, keys] of Object.entries(fields)) {
      for (const key of keys) {
        for (const value of [null, "1", false]) {
          assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
            schema: MONITOR_CONFIG_SCHEMA, [section]: { [key]: value },
          })), "invalid_type", `${section}.${key}`);
        }
        const overflow = `{"schema":"${MONITOR_CONFIG_SCHEMA}","${section}":{"${key}":1e400}}`;
        assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, overflow)), "invalid_type", `${section}.${key}`);
        for (const value of [-1, 1.5, ...(key === "first_delay_ms" ? [] : [0])]) {
          assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
            schema: MONITOR_CONFIG_SCHEMA, [section]: { [key]: value },
          })), "invalid_range", section);
        }
      }
    }
  });

  it("validates sources and sanitizes the normalizer rejection", (t) => {
    for (const sources of [null, "cloudflared", {}, [null], [1], [""]]) {
      assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
        schema: MONITOR_CONFIG_SCHEMA, alert: { sources },
      })), "invalid_type", "alert.sources");
    }
    const path = writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA, alert: { sources: ["synthetic-unknown-source"] },
    });
    assert.throws(() => loadMonitoringConfig(path), (error) => {
      assert.equal(error.code, "invalid_range");
      assert.equal(error.field, "alert");
      assert.equal(error.message.includes("synthetic-unknown-source"), false);
      assert.equal(JSON.stringify(error).includes("synthetic-unknown-source"), false);
      return error instanceof MonitoringConfigError;
    });
    assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, {
      schema: MONITOR_CONFIG_SCHEMA, alert: { sources: [] },
    })), "invalid_range", "alert.sources");
    const defaults = loadMonitoringConfig(writeConfig(t, { schema: MONITOR_CONFIG_SCHEMA }));
    assert.deepEqual(defaults.alert.sources, [...LOCAL_CANDIDATE_DEFAULTS.sources]);
    assert.deepEqual(defaults.runner.sources, [...LOCAL_CANDIDATE_DEFAULTS.sources]);
    for (const sources of [["cloudflared"], ["http_health.loopback", "http_health.public"]]) {
      const loaded = loadMonitoringConfig(writeConfig(t, {
        schema: MONITOR_CONFIG_SCHEMA, alert: { sources },
      }));
      assert.deepEqual(loaded.alert.sources, sources);
      assert.deepEqual(loaded.runner.sources, sources);
    }
  });

  it("rejects forbidden key casing and unknown fields in every section", (t) => {
    for (const section of [null, "alert", "runner", "delivery"]) {
      for (const [key, code] of [["ToKeN", "forbidden_field"], ["CrEaTeQuEuE", "forbidden_field"],
        ["extra", "unknown_field"], ["constructor", "unknown_field"], ["__proto__", "unknown_field"]]) {
        const payload = { schema: MONITOR_CONFIG_SCHEMA,
          ...(section ? { [section]: { [key]: "synthetic" } } : { [key]: "synthetic" }) };
        assertThrowsCode(() => loadMonitoringConfig(writeConfig(t, payload)), code,
          section ? `${section}.${key}` : key);
      }
    }
  });

  it("keeps exported normalizers compatible with defaults and rejects invalid inputs", () => {
    for (const normalize of [normalizeRunnerConfig, normalizeDeliveryConfig]) {
      for (const input of [[], false, "policy", 1]) {
        assert.throws(() => normalize(input), /config must be an object/);
      }
      assert.equal(normalize().production_default, false);
      assert.equal(normalize({ local_candidate: false }).local_candidate, false);
    }
    assert.deepEqual(normalizeDeliveryConfig({ max_attempts: null }), normalizeDeliveryConfig());
    assert.deepEqual(normalizeRunnerConfig({ first_delay_ms: null }), normalizeRunnerConfig());
  });

  it("uses configured delays and probe timeout only after explicit runner start", async (t) => {
    const loaded = loadMonitoringConfig(writeConfig(t, validPolicy({
      runner: { interval_ms: 19, first_delay_ms: 7, probe_timeout_ms: 11 },
    })));
    const dir = tmpDir(t);
    const delays = [];
    const scheduler = createManualScheduler();
    const schedule = scheduler.setTimeout.bind(scheduler);
    scheduler.setTimeout = (fn, ms) => { delays.push(ms); return schedule(fn, ms); };
    const fixtureSampler = createFixtureSampler(loadFixture("down.json").samples);
    const calls = [];
    const runner = createLocalMonitor({
      stateDir: dir, clock: createFakeClock(), scheduler, config: loaded.runner,
      sampler: { collectSample(options) { calls.push(options); return fixtureSampler.collectSample(options); } },
    });
    t.after(() => runner.stop());
    assert.equal(runner.snapshot().started, false);
    assert.equal(scheduler.pending, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(readdirSync(dir), []);
    await runner.start();
    assert.deepEqual(delays, [7]);
    await scheduler.runNext();
    assert.deepEqual(delays, [7, 19]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].timeoutMs, 11);
    assert.equal(calls[0].loopbackUrl, undefined);
    assert.equal(calls[0].publicUrl, undefined);
    await runner.stop();
    assert.equal(scheduler.pending, 0);
  });

  it("enforces loaded retry backoff, attempt cap and delivery deadline", async (t) => {
    const loaded = loadMonitoringConfig(writeConfig(t, validPolicy({
      alert: { fail_threshold: 1, sources: ["beian-server-8787"] },
      delivery: { max_attempts: 2, backoff_ms: 7, timeout_ms: 11 },
    })));
    const replay = replaySamples(loadFixture("down.json").samples, { config: loaded.alert });
    assert.equal(replay.events.length, 1);
    const clock = createFakeClock();
    const start = clock.now();
    const transport = createFakeTransport(() => ({ outcome: "failed", retryable: true }));
    const queue = createDeliveryQueue({ statePath: join(tmpDir(t), "delivery.json"), clock, transport, config: loaded.delivery });
    queue.enqueueFromReplay(replay);
    await queue.tick();
    assert.equal(queue.snapshot().items[0].status, "retry_wait");
    assert.equal(Date.parse(queue.snapshot().items[0].next_attempt_at), start + 7);
    assert.equal(transport.calls[0].deadline_at, start + 11);
    clock.advance(6);
    assert.equal((await queue.tick()).attempted.length, 0);
    clock.advance(1);
    await queue.tick();
    assert.equal(queue.snapshot().items[0].status, "failed");
    assert.equal(queue.snapshot().items[0].attempt, 2);
    clock.advance(100);
    assert.equal((await queue.tick()).attempted.length, 0);
    assert.equal(transport.calls.length, 2);
  });

  it("enforces loaded async timeout and keeps a late success unknown", async (t) => {
    const loaded = loadMonitoringConfig(writeConfig(t, validPolicy({
      alert: { fail_threshold: 1, sources: ["beian-server-8787"] },
      delivery: { timeout_ms: 11 },
    })));
    let resolveSend;
    const pending = new Promise((resolve) => { resolveSend = resolve; });
    const transport = createFakeTransport(() => pending);
    const clock = createFakeClock();
    const queue = createDeliveryQueue({ statePath: join(tmpDir(t), "delivery.json"), clock, transport, config: loaded.delivery });
    queue.enqueueFromReplay(replaySamples(loadFixture("down.json").samples, { config: loaded.alert }));
    const tick = queue.tick();
    clock.advance(10);
    assert.equal(queue.snapshot().items[0].status, "sending");
    clock.advance(1);
    await tick;
    assert.equal(queue.snapshot().items[0].last_outcome.code, "timeout");
    assert.equal(transport.calls[0].signal.aborted, true);
    resolveSend({ outcome: "confirmed" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queue.snapshot().items[0].status, "unknown");
    assert.equal((await queue.tick()).attempted.length, 0);
  });
});

describe("loaded config through existing constructors", () => {
  it("feeds recovery fixture events to fake transport and does not send without a sender", async (t) => {
    const loaded = loadMonitoringConfig(writeConfig(t, validPolicy({
      alert: { fail_threshold: 3, recover_threshold: 2 },
      delivery: { max_attempts: 3, backoff_ms: 1000, timeout_ms: 5000 },
    })));
    const fixture = loadFixture("recovery.json");
    const replay = replaySamples(fixture.samples, { config: loaded.alert });
    assert.deepEqual(replay.events.map(({ type, source }) => ({ type, source })), [
      { type: "fault", source: "beian-server-8787" },
      { type: "recovery", source: "beian-server-8787" },
    ]);

    const queued = createDeliveryQueue({
      statePath: join(tmpDir(t), "delivery.json"),
      clock: createFakeClock(),
      config: loaded.delivery,
    });
    queued.enqueueFromReplay(replay);
    assert.equal(queued.tick().skipped, "no_transport");
    assert.equal(queued.snapshot().items[0].status, "queued");
    assert.equal(queued.snapshot().items[0].max_attempts, loaded.delivery.max_attempts);

    const transport = createFakeTransport();
    const sent = createDeliveryQueue({
      statePath: join(tmpDir(t), "delivery-sent.json"),
      clock: createFakeClock(),
      transport,
      config: loaded.delivery,
    });
    sent.enqueueFromReplay(replay);
    await sent.tick();
    assert.deepEqual(transport.calls.map(({ type }) => type), ["fault", "recovery"]);
    assert.equal(sent.snapshot().config.max_attempts, 3);
  });

  it("passes runner policy into createLocalMonitor with fixture sampler and fake transport", async (t) => {
    const loaded = loadMonitoringConfig(writeConfig(t, validPolicy({
      alert: { fail_threshold: 1, recover_threshold: 1 },
      runner: { interval_ms: 1000, first_delay_ms: 0, probe_timeout_ms: 8000 },
      delivery: { max_attempts: 2, backoff_ms: 1000, timeout_ms: 5000 },
    })));
    const fixture = loadFixture("down.json");
    const dir = tmpDir(t);
    const transport = createFakeTransport();
    const runner = createLocalMonitor({
      stateDir: dir,
      clock: createFakeClock(),
      scheduler: createManualScheduler(),
      sampler: createFixtureSampler(fixture.samples),
      transport,
      config: loaded.runner,
      createQueue: ({ statePath, clock, transport: nextTransport }) => createDeliveryQueue({
        statePath,
        clock,
        transport: nextTransport,
        config: loaded.delivery,
      }),
    });
    await runner.start({ schedule: false });
    const events = [];
    for (let i = 0; i < fixture.samples.length; i += 1) {
      const cycle = await runner.runCycle();
      events.push(...(cycle.events || []));
    }
    await runner.stop();
    assert.equal(runner.snapshot().config.fail_threshold, 1);
    assert.equal(runner.snapshot().config.interval_ms, 1000);
    assert.equal(events.some((event) => event.type === "fault" && event.source === "beian-server-8787"), true);
    assert.equal(transport.calls.length >= 1, true);
    assert.equal(runner.deliverySnapshot().items[0].max_attempts, 2);
    assert.equal(runner.snapshot().notify, false);
    assert.equal(runner.snapshot().production_send, false);
  });

  it("never sends when the loaded config is used without a transport", async (t) => {
    const loaded = loadMonitoringConfig(EXAMPLE_CONFIG_PATH);
    const fixture = loadFixture("down.json");
    const runner = createLocalMonitor({
      stateDir: tmpDir(t),
      clock: createFakeClock(),
      scheduler: createManualScheduler(),
      sampler: createFixtureSampler(fixture.samples),
      config: loaded.runner,
    });
    await runner.start({ schedule: false });
    for (let i = 0; i < fixture.samples.length; i += 1) {
      await runner.runCycle();
    }
    const stopped = await runner.stop();
    assert.equal(stopped.status, "stopped");
    assert.equal(runner.deliverySnapshot().items.some((item) => item.status === "confirmed"), false);
    assert.equal(runner.snapshot().notify, false);
  });
});
