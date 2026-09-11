/**
 * F02 本地循环协调器：采样 → 核心判断 → 持久交接 → 投递。
 *
 * 时间、定时器、采样器和队列可注入。默认无 transport、无探测 URL，不访问生产、不发送消息。
 * 核心状态与待交接事件写在本模块自己的 runner.json；不读取或改写 delivery 私有状态文件。
 * 不能先落盘核心、后丢失事件：有事件时先写 pending，再 enqueueFromReplay，成功后再清空 pending。
 * 不是端到端 exactly-once，也不是断电耐久或 Windows 实机证明。
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  closeSync,
  constants as fsConstants,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  ATOMIC_WRITE_NOTE,
  atomicWriteFile,
  createAlertEngine,
  emptyState,
  normalizeConfig,
  parseState,
  renderDraft,
} from "../alert-core.mjs";
import { createDeliveryQueue } from "../delivery/delivery-core.mjs";
import { createProbe } from "../probes/collect.mjs";

export { createFakeClock } from "../delivery/delivery-core.mjs";

const RUNNER_SCHEMA = "beian-monitor-runner-v1";
const RUNNER_LOCK_SCHEMA = "beian-monitor-runner-lock-v1";
const RUNNER_CONFIG_SCHEMA = "beian-monitor-runner-config-v1";
const ALERT_EVENT_SCHEMA = "beian-alert-event-v1";
const FORBIDDEN_KEY = /^(token|secret|password|webhook|authorization|credential|raw_response|open_id|app_secret)$/i;

export const RUNNER_EXACTLY_ONCE = false;
export const RUNNER_EXACTLY_ONCE_NOTE =
  "协调器不能声称端到端 exactly-once。交接前崩溃可能推迟检测；入队后确认前崩溃会按原 event.id 再交接，由投递层去重。进程崩溃模拟不是断电耐久。";
const RUNNER_SINGLE_INSTANCE_NOTE =
  "同一 stateDir 只允许一个协调器持锁。重复 start 会失败；不会静默并写。崩溃留下的锁在 pid 已死后才允许接管。";

export const LOCAL_RUNNER_DEFAULTS = Object.freeze({
  schema: RUNNER_CONFIG_SCHEMA,
  production_default: false,
  local_candidate: true,
  interval_ms: 30_000,
  first_delay_ms: 0,
  probe_timeout_ms: 8000,
});

export class RunnerStateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RunnerStateError";
    this.details = details;
  }
}

export class RunnerLockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RunnerLockError";
    this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function positiveInt(value, fallback, name) {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInt(value, fallback, name) {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be >= 0`);
  }
  return value;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function assertNoForbiddenKeys(value, path = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertNoForbiddenKeys(entry, `${path}[${i}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new RunnerStateError(`forbidden key ${key}`, { path, key, reason: "forbidden_key" });
    }
    assertNoForbiddenKeys(value[key], path ? `${path}.${key}` : key);
  }
}

function validIso(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function emptyPending() {
  return {
    cycle_seq: null,
    sampled_at: null,
    sample_id: null,
    events: [],
    drafts: [],
  };
}

export function emptyRunnerState() {
  return {
    schema: RUNNER_SCHEMA,
    exactly_once: false,
    sequence: 0,
    last_cycle_at: null,
    instance_id: null,
    core: emptyState(),
    pending: emptyPending(),
  };
}

function validEvent(event) {
  if (!isPlainObject(event)) return false;
  if (event.schema !== ALERT_EVENT_SCHEMA) return false;
  if (typeof event.id !== "string" || !event.id) return false;
  if (event.type !== "fault" && event.type !== "recovery") return false;
  if (typeof event.source !== "string" || !event.source) return false;
  if (!validIso(event.at)) return false;
  if (event.incident_id != null && typeof event.incident_id !== "string") return false;
  return true;
}

function validDraft(draft) {
  if (!isPlainObject(draft)) return false;
  if (typeof draft.event_id !== "string" || !draft.event_id) return false;
  if (typeof draft.title !== "string" || !draft.title) return false;
  if (typeof draft.body !== "string" || !draft.body) return false;
  return true;
}

function validPending(value) {
  if (!isPlainObject(value)) return false;
  if (value.cycle_seq != null && (!Number.isInteger(value.cycle_seq) || value.cycle_seq < 1)) return false;
  if (value.sampled_at != null && !validIso(value.sampled_at)) return false;
  if (value.sample_id != null && typeof value.sample_id !== "string") return false;
  if (!Array.isArray(value.events) || !value.events.every(validEvent)) return false;
  if (!Array.isArray(value.drafts) || !value.drafts.every(validDraft)) return false;
  return true;
}

function coreFromObject(core) {
  const loaded = parseState(JSON.stringify(core ?? {}));
  if (loaded.invalid) {
    return { ok: false, reason: loaded.reason, core: null };
  }
  return { ok: true, reason: loaded.missing ? "missing_core" : "ok", core: loaded.state };
}

export function parseRunnerState(text) {
  if (text == null) return { ok: false, reason: "missing", state: null };
  if (text === "") return { ok: false, reason: "empty", state: null };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json", state: null };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "not_object", state: null };
  try {
    assertNoForbiddenKeys(parsed);
  } catch (err) {
    return { ok: false, reason: err.details?.reason || "forbidden_key", state: null };
  }
  if (parsed.schema !== RUNNER_SCHEMA) return { ok: false, reason: "unsupported_schema", state: null };
  if (parsed.exactly_once === true) return { ok: false, reason: "claims_exactly_once", state: null };
  if (parsed.sequence != null && (!Number.isInteger(parsed.sequence) || parsed.sequence < 0)) {
    return { ok: false, reason: "sequence", state: null };
  }
  if (parsed.last_cycle_at != null && !validIso(parsed.last_cycle_at)) {
    return { ok: false, reason: "last_cycle_at", state: null };
  }
  if (parsed.instance_id != null && typeof parsed.instance_id !== "string") {
    return { ok: false, reason: "instance_id", state: null };
  }
  const coreLoaded = coreFromObject(parsed.core);
  if (!coreLoaded.ok) return { ok: false, reason: `core:${coreLoaded.reason}`, state: null };
  if (!validPending(parsed.pending ?? emptyPending())) {
    return { ok: false, reason: "pending", state: null };
  }
  return {
    ok: true,
    reason: "ok",
    state: {
      schema: RUNNER_SCHEMA,
      exactly_once: false,
      sequence: parsed.sequence ?? 0,
      last_cycle_at: parsed.last_cycle_at ?? null,
      instance_id: parsed.instance_id ?? null,
      core: coreLoaded.core,
      pending: {
        cycle_seq: parsed.pending?.cycle_seq ?? null,
        sampled_at: parsed.pending?.sampled_at ?? null,
        sample_id: parsed.pending?.sample_id ?? null,
        events: cloneJson(parsed.pending?.events || []),
        drafts: cloneJson(parsed.pending?.drafts || []),
      },
    },
  };
}

export function serializeRunnerState(state) {
  const payload = {
    schema: RUNNER_SCHEMA,
    exactly_once: false,
    sequence: state.sequence,
    last_cycle_at: state.last_cycle_at,
    instance_id: state.instance_id,
    core: {
      schema: state.core.schema,
      exactly_once: false,
      last_sampled_at: state.core.last_sampled_at ?? null,
      last_sequence: state.core.last_sequence ?? null,
      seen_ids: [...(state.core.seen_ids || [])],
      sources: cloneJson(state.core.sources || {}),
    },
    pending: {
      cycle_seq: state.pending.cycle_seq,
      sampled_at: state.pending.sampled_at,
      sample_id: state.pending.sample_id,
      events: cloneJson(state.pending.events || []),
      drafts: cloneJson(state.pending.drafts || []),
    },
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function normalizeRunnerConfig(input = {}) {
  if (input != null && !isPlainObject(input)) throw new Error("config must be an object");
  return {
    schema: RUNNER_CONFIG_SCHEMA,
    production_default: false,
    local_candidate: input.local_candidate === false ? false : true,
    interval_ms: positiveInt(input.interval_ms, LOCAL_RUNNER_DEFAULTS.interval_ms, "interval_ms"),
    first_delay_ms: nonNegativeInt(input.first_delay_ms, LOCAL_RUNNER_DEFAULTS.first_delay_ms, "first_delay_ms"),
    probe_timeout_ms: positiveInt(
      input.probe_timeout_ms,
      LOCAL_RUNNER_DEFAULTS.probe_timeout_ms,
      "probe_timeout_ms",
    ),
    fail_threshold: input.fail_threshold,
    recover_threshold: input.recover_threshold,
    unknown_breaks_streak: input.unknown_breaks_streak,
    seen_ids_limit: input.seen_ids_limit,
    sources: input.sources,
  };
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

export function createPidFileLock(options = {}) {
  const lockPath = options.lockPath;
  if (!lockPath || typeof lockPath !== "string" || !isAbsolute(lockPath)) {
    throw new Error("lockPath must be an absolute path");
  }
  const pid = Number.isInteger(options.pid) ? options.pid : process.pid;
  const instanceId = options.instanceId || randomBytes(8).toString("hex");
  const isAlive = typeof options.isAlive === "function" ? options.isAlive : defaultIsAlive;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const readFile = options.readFile || ((path) => readFileSync(path, "utf8"));
  const fileExists = options.exists || existsSync;
  const unlink = options.unlink || unlinkSync;
  let held = false;

  function readLock() {
    if (!fileExists(lockPath)) return null;
    let parsed;
    try {
      parsed = JSON.parse(readFile(lockPath));
    } catch {
      throw new RunnerLockError("lock file is invalid and was not reset", {
        reason: "lock_invalid",
        path: lockPath,
      });
    }
    if (!isPlainObject(parsed) || parsed.schema !== RUNNER_LOCK_SCHEMA
      || !Number.isInteger(parsed.pid) || parsed.pid <= 0
      || typeof parsed.instance_id !== "string" || !parsed.instance_id) {
      throw new RunnerLockError("lock file is invalid and was not reset", {
        reason: "lock_invalid",
        path: lockPath,
      });
    }
    return parsed;
  }

  function writeExclusive(payload) {
    const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY;
    const fd = openSync(lockPath, flags, 0o644);
    try {
      writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
  }

  function acquireUnderGuard() {
    const payload = {
      schema: RUNNER_LOCK_SCHEMA,
      pid,
      instance_id: instanceId,
      acquired_at: iso(now()),
    };
    try {
      writeExclusive(payload);
      held = true;
      return { ok: true, pid, instance_id: instanceId, stale: false };
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
    }
    const existing = readLock();
    if (!existing) {
      writeExclusive(payload);
      held = true;
      return { ok: true, pid, instance_id: instanceId, stale: false };
    }
    if (isAlive(existing.pid)) {
      return {
        ok: false,
        reason: "already_running",
        pid: existing.pid,
        instance_id: existing.instance_id,
      };
    }
    try {
      unlink(lockPath);
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    try {
      writeExclusive(payload);
    } catch (err) {
      if (err && err.code === "EEXIST") {
        const raced = readLock();
        return {
          ok: false,
          reason: "already_running",
          pid: raced?.pid ?? null,
          instance_id: raced?.instance_id ?? null,
        };
      }
      throw err;
    }
    held = true;
    return { ok: true, pid, instance_id: instanceId, stale: true };
  }

  function tryAcquire() {
    // Serialize stale-owner checks and removal. A crashed guard is fail-closed;
    // it must not be auto-reclaimed with another check/unlink race.
    const guardPath = `${lockPath}.acquire`;
    let fd;
    try {
      fd = openSync(guardPath, "wx", 0o600);
    } catch (err) {
      if (err?.code === "EEXIST") return { ok: false, reason: "acquisition_in_progress" };
      throw err;
    }
    try {
      return acquireUnderGuard();
    } finally {
      closeSync(fd);
      unlinkSync(guardPath);
    }
  }

  function release() {
    if (!held) return;
    const current = readLock();
    if (current && (current.pid !== pid || current.instance_id !== instanceId)) {
      throw new RunnerLockError("lock ownership changed; refusing to remove another owner");
    }
    try {
      unlink(lockPath);
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    held = false;
  }

  return { tryAcquire, release, pid, instanceId, lockPath };
}

export function createManualScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async runNext() {
      const first = timers.entries().next();
      if (first.done) return false;
      const [id, timer] = first.value;
      timers.delete(id);
      await timer.fn();
      return true;
    },
    get pending() {
      return timers.size;
    },
  };
}

export function createFixtureSampler(samples) {
  if (!Array.isArray(samples) || !samples.length) throw new Error("samples must be a non-empty array");
  let index = 0;
  const calls = [];
  return {
    calls,
    async collectSample(options = {}) {
      if (options.signal?.aborted) {
        const err = new Error("cancelled");
        err.reason = "cancelled";
        throw err;
      }
      calls.push({
        sequence: options.sequence ?? null,
        id: options.id ?? null,
        loopbackUrl: options.loopbackUrl ?? null,
        publicUrl: options.publicUrl ?? null,
      });
      const template = samples[Math.min(index, samples.length - 1)];
      index += 1;
      const sample = cloneJson(template);
      if (Number.isInteger(options.sequence)) sample.sequence = options.sequence;
      if (options.id) sample.id = String(options.id);
      return { sample, reasons: {}, platform_claim: "mock" };
    },
  };
}

function replayFromPending(pending) {
  const events = cloneJson(pending.events || []);
  const drafts = pending.drafts?.length
    ? cloneJson(pending.drafts)
    : events.map((event) => renderDraft(event));
  return { events, drafts };
}

function pendingEventIds(pending) {
  return (pending?.events || []).map((event) => event.id);
}

export function createLocalMonitor(options = {}) {
  if (!options || !isPlainObject(options)) throw new Error("options must be an object");
  const stateDir = options.stateDir;
  if (!stateDir || typeof stateDir !== "string" || !isAbsolute(stateDir)) {
    throw new Error("stateDir must be an absolute path");
  }
  const statePath = options.statePath || join(stateDir, "runner.json");
  const lockPath = options.lockPath || join(stateDir, "runner.lock");
  const deliveryStatePath = options.deliveryStatePath || join(stateDir, "delivery.json");
  for (const [name, value] of [
    ["statePath", statePath],
    ["lockPath", lockPath],
    ["deliveryStatePath", deliveryStatePath],
  ]) {
    if (!value || typeof value !== "string" || !isAbsolute(value)) {
      throw new Error(`${name} must be an absolute path`);
    }
  }
  if (options.loopbackUrl || options.publicUrl) {
    throw new Error("probe URLs must be passed as probe.loopbackUrl / probe.publicUrl; defaults stay empty");
  }

  const runnerConfig = normalizeRunnerConfig(options.config);
  const alertConfig = normalizeConfig({
    fail_threshold: runnerConfig.fail_threshold,
    recover_threshold: runnerConfig.recover_threshold,
    unknown_breaks_streak: runnerConfig.unknown_breaks_streak,
    seen_ids_limit: runnerConfig.seen_ids_limit,
    sources: runnerConfig.sources,
    local_candidate: runnerConfig.local_candidate,
  });
  const clock = options.clock && typeof options.clock.now === "function"
    ? options.clock
    : { now: () => Date.now() };
  const scheduler = options.scheduler || {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const probe = isPlainObject(options.probe) ? options.probe : {};
  if (probe.loopbackUrl == null && probe.publicUrl == null) {
    // 默认不带探测 URL，避免环回/公网访问。
  }
  const sampler = options.sampler || createProbe({
    now: () => new Date(clock.now()),
    httpGet: options.httpGet,
    exec: options.exec,
    platform: options.platform,
  });
  if (typeof sampler.collectSample !== "function") {
    throw new Error("sampler.collectSample must be a function");
  }
  const transport = options.transport == null ? null : options.transport;
  const writeFile = options.writeFile || atomicWriteFile;
  const readFile = options.readFile || ((path) => readFileSync(path, "utf8"));
  const fileExists = options.exists || existsSync;
  const writeHooks = options.writeHooks || {};
  const hooks = options.hooks || {};
  const instanceId = options.instanceId || randomBytes(8).toString("hex");
  const lock = options.lock && typeof options.lock.tryAcquire === "function"
    ? options.lock
    : createPidFileLock({
      lockPath,
      pid: options.pid,
      instanceId,
      isAlive: options.isAlive,
      now: () => clock.now(),
      readFile,
      exists: fileExists,
      unlink: options.unlink,
    });

  let state = emptyRunnerState();
  if (fileExists(statePath)) {
    const loaded = parseRunnerState(readFile(statePath));
    if (!loaded.ok) {
      throw new RunnerStateError(
        `runner state refused (${loaded.reason}); file was not reset`,
        { reason: loaded.reason, path: statePath },
      );
    }
    state = loaded.state;
  }
  state.instance_id = state.instance_id || instanceId;

  function reloadState() {
    if (!fileExists(statePath)) {
      state = emptyRunnerState();
    } else {
      const loaded = parseRunnerState(readFile(statePath));
      if (!loaded.ok) throw new RunnerStateError(`runner state refused (${loaded.reason}); file was not reset`);
      state = loaded.state;
    }
    state.instance_id = instanceId;
  }

  let queue = options.queue || null;
  let started = false;
  let stopping = false;
  let lockHeld = false;
  let timerHandle = null;
  let cycleBusy = false;
  let cyclePromise = null;
  let recoveryPromise = null;
  let stopPromise = null;
  let phase = "idle";
  let sampleAbort = null;
  let lastError = null;
  let lastTick = null;
  let lastHandoff = null;

  function snapshot() {
    return {
      schema: RUNNER_SCHEMA,
      exactly_once: false,
      production_default: false,
      notify: false,
      production_send: false,
      config: { ...runnerConfig },
      alert_config: { ...alertConfig },
      sequence: state.sequence,
      last_cycle_at: state.last_cycle_at,
      instance_id: state.instance_id,
      phase,
      started,
      stopping,
      lock_held: lockHeld,
      pending_event_ids: pendingEventIds(state.pending),
      pending: cloneJson(state.pending),
      core: cloneJson(state.core),
      last_error: lastError ? String(lastError.message || lastError) : null,
      last_tick: lastTick,
      last_handoff: lastHandoff,
      limitations: [
        RUNNER_EXACTLY_ONCE_NOTE,
        RUNNER_SINGLE_INSTANCE_NOTE,
        ATOMIC_WRITE_NOTE,
        "默认无 transport、无探测 URL；不读密钥，不发送真实消息。",
        "坏损状态文件会拒绝操作，不会静默清空后继续。",
        "本地 JSON 原子写不是断电耐久性或 Windows 实机证明。",
      ],
    };
  }

  function persist(next) {
    writeFile(statePath, serializeRunnerState(next), writeHooks);
    state = next;
  }

  function cancelTimer() {
    if (timerHandle != null && typeof scheduler.clearTimeout === "function") {
      scheduler.clearTimeout(timerHandle);
    }
    timerHandle = null;
  }

  function scheduleNext(delayMs) {
    if (stopping) return;
    cancelTimer();
    timerHandle = scheduler.setTimeout(() => onTimer(), delayMs);
  }

  async function callHook(name, payload) {
    if (typeof hooks[name] === "function") await hooks[name](payload);
  }

  function ensureQueue() {
    if (queue) return queue;
    if (typeof options.createQueue === "function") {
      queue = options.createQueue({
        statePath: deliveryStatePath,
        clock,
        transport,
      });
    } else {
      queue = createDeliveryQueue({
        statePath: deliveryStatePath,
        clock,
        transport,
      });
    }
    if (!queue || typeof queue.enqueueFromReplay !== "function" || typeof queue.tick !== "function") {
      throw new Error("queue must provide enqueueFromReplay and tick");
    }
    return queue;
  }

  async function drainPending() {
    if (!state.pending.events.length) return { drained: false };
    phase = "enqueue";
    await callHook("beforeEnqueue", { pending: cloneJson(state.pending) });
    const replay = replayFromPending(state.pending);
    const enqueued = ensureQueue().enqueueFromReplay(replay);
    lastHandoff = {
      added: enqueued?.added || [],
      duplicates: enqueued?.duplicates || [],
      event_ids: replay.events.map((event) => event.id),
    };
    await callHook("afterEnqueue", { enqueued });
    phase = "ack";
    await callHook("beforeAck", { enqueued });
    const next = cloneJson(state);
    next.pending = emptyPending();
    persist(next);
    await callHook("afterAck", {});
    phase = "idle";
    return { drained: true, enqueued };
  }

  async function recover() {
    mkdirSync(stateDir, { recursive: true });
    ensureQueue();
    await drainPending();
    phase = "tick";
    lastTick = await ensureQueue().tick();
    phase = "idle";
  }

  async function runCycle() {
    if (!lockHeld) throw new Error("runner_not_started");
    if (stopping) return { skipped: "stopping", phase };
    if (recoveryPromise) return { skipped: "recovering", phase };
    if (cycleBusy) return { skipped: "overlap", phase };
    cycleBusy = true;
    cyclePromise = (async () => {
      try {
        await drainPending();
        if (stopping) return { skipped: "stopping", phase: "idle" };

        phase = "sampling";
        const sequence = state.sequence + 1;
        const sampleId = `cycle-${sequence}`;
        const ac = new AbortController();
        sampleAbort = ac;
        await callHook("beforeSample", { sequence, sampleId });
        let collected;
        try {
          collected = await sampler.collectSample({
            signal: ac.signal,
            sequence,
            id: sampleId,
            timeoutMs: runnerConfig.probe_timeout_ms,
            loopbackUrl: probe.loopbackUrl,
            publicUrl: probe.publicUrl,
          });
        } catch (err) {
          if (stopping || ac.signal.aborted || err?.reason === "cancelled") {
            return { skipped: "cancelled", phase: "sampling" };
          }
          lastError = err;
          return { skipped: "sample_failed", error: String(err.message || err) };
        } finally {
          sampleAbort = null;
        }
        if (stopping) return { skipped: "stopping", phase: "sampling" };

        phase = "ingest";
        const sample = collected?.sample;
        const engine = createAlertEngine({ state: state.core, config: alertConfig });
        const ingested = engine.ingest(sample);
        const nextCore = engine.snapshot();
        const events = ingested.events || [];
        const drafts = events.map((event) => renderDraft(event));
        const next = cloneJson(state);
        next.sequence = sequence;
        next.last_cycle_at = iso(clock.now());
        next.core = nextCore;
        next.pending = events.length
          ? {
            cycle_seq: sequence,
            sampled_at: sample?.sampled_at ?? null,
            sample_id: sample?.id ?? sampleId,
            events,
            drafts,
          }
          : emptyPending();

        phase = "handoff";
        await callHook("beforeHandoffPersist", { events, sequence });
        persist(next);
        await callHook("afterHandoffPersist", { events, sequence, pending: cloneJson(state.pending) });

        if (events.length) {
          await drainPending();
        } else {
          lastHandoff = { added: [], duplicates: [], event_ids: [] };
        }
        phase = "tick";
        lastTick = await ensureQueue().tick();
        phase = "idle";
        return {
          skipped: null,
          sequence,
          events: events.map((event) => ({ id: event.id, type: event.type, source: event.source })),
          classifications: ingested.classifications,
          tick: lastTick,
          handoff: lastHandoff,
        };
      } finally {
        if (phase !== "idle" && !stopping) phase = "idle";
        cycleBusy = false;
        cyclePromise = null;
      }
    })();
    return cyclePromise;
  }

  async function onTimer() {
    timerHandle = null;
    if (stopping) return;
    try {
      await runCycle();
    } catch (err) {
      lastError = err;
    }
    if (!stopping) scheduleNext(runnerConfig.interval_ms);
  }

  async function start(startOptions = {}) {
    if (started) {
      throw new RunnerLockError("runner already started in this instance", { reason: "already_started" });
    }
    mkdirSync(stateDir, { recursive: true });
    const acquired = lock.tryAcquire();
    if (!acquired || acquired.ok === false) {
      throw new RunnerLockError(
        `runner already running (pid ${acquired?.pid ?? "?"}); refusing to share state`,
        { reason: acquired?.reason || "already_running", pid: acquired?.pid, path: lockPath },
      );
    }
    lockHeld = true;
    started = true;
    stopping = false;
    stopPromise = null;
    phase = "idle";
    try {
      // Constructors can predate another owner's final write. Read only after ownership.
      reloadState();
      if (!options.queue) queue = null;
      recoveryPromise = recover();
      await recoveryPromise;
      recoveryPromise = null;
      if (startOptions.schedule !== false && !stopping) {
        scheduleNext(runnerConfig.first_delay_ms);
      }
      return snapshot();
    } catch (err) {
      recoveryPromise = null;
      cancelTimer();
      lock.release();
      lockHeld = false;
      started = false;
      throw err;
    }
  }

  async function stop({ timeoutMs = 1000 } = {}) {
    positiveInt(timeoutMs, 1000, "timeoutMs");
    stopping = true;
    cancelTimer();
    const abortedSample = Boolean(sampleAbort);
    if (sampleAbort) sampleAbort.abort();
    const inFlight = phase;
    if (!stopPromise) {
      const pending = [cyclePromise, recoveryPromise].filter(Boolean);
      stopPromise = Promise.allSettled(pending).then(() => {
        if (lockHeld) {
          lock.release();
          lockHeld = false;
        }
        started = false;
        phase = "idle";
      });
    }
    let timer;
    try {
      await Promise.race([
        stopPromise,
        new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return {
      status: lockHeld ? "stopping" : "stopped",
      lock_held: lockHeld,
      sample_aborted: abortedSample,
      in_flight: inFlight,
      pending_event_ids: pendingEventIds(state.pending),
      last_error: lastError ? String(lastError.message || lastError) : null,
    };
  }

  return {
    config: runnerConfig,
    stateDir,
    statePath,
    lockPath,
    deliveryStatePath,
    exactly_once: RUNNER_EXACTLY_ONCE,
    start,
    stop,
    runCycle,
    snapshot,
    deliverySnapshot() {
      if (!queue) throw new Error("runner_not_started");
      return queue.snapshot();
    },
  };
}
