/**
 * F02 第二阶段：渠道无关的本地通知投递。
 *
 * 只读消费 alert-core 事件/草稿；不判断告警、不选渠道、不读产品通知开关或密钥。
 * 默认没有 transport；发送必须注入 transport.send。单写者 JSON 状态。
 * 不是端到端 exactly-once，也不是断电耐久或 Windows 实机证明。
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  ATOMIC_WRITE_NOTE,
  atomicWriteFile,
  renderDraft,
} from "../alert-core.mjs";

const DELIVERY_SCHEMA = "beian-delivery-state-v1";
const ALERT_EVENT_SCHEMA = "beian-alert-event-v1";
export const DELIVERY_EXACTLY_ONCE = false;
export const DELIVERY_EXACTLY_ONCE_NOTE =
  "投递层不能声称端到端 exactly-once。同一 event.id 只保留一条记录（去重），但结果不明时 transport 可能已送达；自动重试只针对确认失败。重启时仍为 sending 的记录记为 unknown，不自动再发。";

const DELIVERY_STATUSES = Object.freeze([
  "queued",
  "sending",
  "retry_wait",
  "confirmed",
  "failed",
  "unknown",
  "cancelled",
]);

const TERMINAL = new Set(["confirmed", "failed", "unknown", "cancelled"]);
const ACTIVE = new Set(["queued", "retry_wait"]);
const STATUS_SET = new Set(DELIVERY_STATUSES);
const ITEM_KEYS = new Set([
  "event_id",
  "type",
  "source",
  "at",
  "incident_id",
  "enqueue_seq",
  "status",
  "attempt",
  "max_attempts",
  "next_attempt_at",
  "enqueued_at",
  "updated_at",
  "send_issued",
  "draft",
  "last_outcome",
]);
const FORBIDDEN_KEY = /^(token|secret|password|webhook|authorization|credential|raw_response|open_id|app_secret)$/i;

export const LOCAL_DELIVERY_DEFAULTS = Object.freeze({
  schema: "beian-delivery-config-v1",
  production_default: false,
  local_candidate: true,
  max_attempts: 3,
  backoff_ms: 1000,
  timeout_ms: 5000,
});

export class DeliveryStateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DeliveryStateError";
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

function normalizeDeliveryConfig(input = {}) {
  if (input != null && !isPlainObject(input)) throw new Error("config must be an object");
  return {
    schema: LOCAL_DELIVERY_DEFAULTS.schema,
    production_default: false,
    local_candidate: input.local_candidate === false ? false : true,
    max_attempts: positiveInt(input.max_attempts, LOCAL_DELIVERY_DEFAULTS.max_attempts, "max_attempts"),
    backoff_ms: positiveInt(input.backoff_ms, LOCAL_DELIVERY_DEFAULTS.backoff_ms, "backoff_ms"),
    timeout_ms: positiveInt(input.timeout_ms, LOCAL_DELIVERY_DEFAULTS.timeout_ms, "timeout_ms"),
  };
}

export function emptyDeliveryState() {
  return {
    schema: DELIVERY_SCHEMA,
    exactly_once: false,
    next_seq: 1,
    items: [],
  };
}

export function createFakeClock(startMs = Date.parse("2026-09-09T00:00:00.000Z")) {
  if (!Number.isFinite(startMs)) throw new Error("startMs must be a number");
  let now = startMs;
  let nextTimerId = 1;
  const timers = new Map();
  function fireDue() {
    let fired;
    do {
      fired = false;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id);
          fired = true;
          timer.fn();
        }
      }
    } while (fired);
  }
  return {
    now: () => now,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error("advance ms must be >= 0");
      now += ms;
      fireDue();
      return now;
    },
    setTimeout(fn, ms) {
      if (typeof fn !== "function") throw new Error("setTimeout fn must be a function");
      const delay = Number(ms);
      if (!Number.isFinite(delay) || delay < 0) throw new Error("setTimeout ms must be >= 0");
      const id = nextTimerId++;
      timers.set(id, { due: now + delay, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
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
      throw new DeliveryStateError(`forbidden key ${key}`, { path, key });
    }
    assertNoForbiddenKeys(value[key], path ? `${path}.${key}` : key);
  }
}

function validIso(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function validDraft(draft) {
  if (!isPlainObject(draft)) return false;
  if (typeof draft.title !== "string" || !draft.title) return false;
  if (typeof draft.body !== "string" || !draft.body) return false;
  if (draft.redacted !== true) return false;
  const keys = Object.keys(draft);
  return keys.every((key) => ["title", "body", "redacted"].includes(key));
}

function validOutcome(value) {
  if (value == null) return true;
  if (!isPlainObject(value)) return false;
  if (!["confirmed", "failed", "unknown"].includes(value.kind)) return false;
  if (typeof value.code !== "string" || !value.code) return false;
  if (!validIso(value.at)) return false;
  if (value.retryable != null && typeof value.retryable !== "boolean") return false;
  return Object.keys(value).every((key) => ["kind", "code", "at", "retryable"].includes(key));
}

function validItem(item) {
  if (!isPlainObject(item)) return "not_object";
  for (const key of Object.keys(item)) {
    if (!ITEM_KEYS.has(key)) return `unexpected_key:${key}`;
  }
  if (typeof item.event_id !== "string" || !item.event_id) return "event_id";
  if (item.type !== "fault" && item.type !== "recovery") return "type";
  if (typeof item.source !== "string" || !item.source) return "source";
  if (!validIso(item.at)) return "at";
  if (item.incident_id != null && typeof item.incident_id !== "string") return "incident_id";
  if (!Number.isInteger(item.enqueue_seq) || item.enqueue_seq < 1) return "enqueue_seq";
  if (!STATUS_SET.has(item.status)) return "status";
  if (!Number.isInteger(item.attempt) || item.attempt < 0) return "attempt";
  if (!Number.isInteger(item.max_attempts) || item.max_attempts < 1) return "max_attempts";
  if (item.next_attempt_at != null && !validIso(item.next_attempt_at)) return "next_attempt_at";
  if (!validIso(item.enqueued_at) || !validIso(item.updated_at)) return "timestamps";
  if (typeof item.send_issued !== "boolean") return "send_issued";
  if (!validDraft(item.draft)) return "draft";
  if (!validOutcome(item.last_outcome)) return "last_outcome";
  return null;
}

export function parseDeliveryState(text) {
  if (text == null) {
    return { ok: false, reason: "missing", state: null };
  }
  if (text === "") {
    return { ok: false, reason: "empty", state: null };
  }
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
    return { ok: false, reason: "forbidden_key", state: null, error: err };
  }
  if (parsed.schema !== DELIVERY_SCHEMA) {
    return { ok: false, reason: "unsupported_schema", state: null };
  }
  if (parsed.exactly_once === true) {
    return { ok: false, reason: "claims_exactly_once", state: null };
  }
  if (!Number.isInteger(parsed.next_seq) || parsed.next_seq < 1) {
    return { ok: false, reason: "next_seq", state: null };
  }
  if (!Array.isArray(parsed.items)) return { ok: false, reason: "items", state: null };
  const seen = new Set();
  const items = [];
  for (const item of parsed.items) {
    const why = validItem(item);
    if (why) return { ok: false, reason: `item:${why}`, state: null };
    if (seen.has(item.event_id)) return { ok: false, reason: "duplicate_event_id", state: null };
    seen.add(item.event_id);
    items.push({
      event_id: item.event_id,
      type: item.type,
      source: item.source,
      at: item.at,
      incident_id: item.incident_id ?? null,
      enqueue_seq: item.enqueue_seq,
      status: item.status,
      attempt: item.attempt,
      max_attempts: item.max_attempts,
      next_attempt_at: item.next_attempt_at ?? null,
      enqueued_at: item.enqueued_at,
      updated_at: item.updated_at,
      send_issued: item.send_issued,
      draft: {
        title: item.draft.title,
        body: item.draft.body,
        redacted: true,
      },
      last_outcome: item.last_outcome == null ? null : { ...item.last_outcome },
    });
  }
  return {
    ok: true,
    reason: "ok",
    state: {
      schema: DELIVERY_SCHEMA,
      exactly_once: false,
      next_seq: parsed.next_seq,
      items,
    },
  };
}

export function serializeDeliveryState(state) {
  const payload = {
    schema: DELIVERY_SCHEMA,
    exactly_once: false,
    next_seq: state.next_seq,
    items: state.items.map((item) => ({
      event_id: item.event_id,
      type: item.type,
      source: item.source,
      at: item.at,
      incident_id: item.incident_id ?? null,
      enqueue_seq: item.enqueue_seq,
      status: item.status,
      attempt: item.attempt,
      max_attempts: item.max_attempts,
      next_attempt_at: item.next_attempt_at ?? null,
      enqueued_at: item.enqueued_at,
      updated_at: item.updated_at,
      send_issued: Boolean(item.send_issued),
      draft: {
        title: item.draft.title,
        body: item.draft.body,
        redacted: true,
      },
      last_outcome: item.last_outcome == null ? null : {
        kind: item.last_outcome.kind,
        code: item.last_outcome.code,
        at: item.last_outcome.at,
        ...(item.last_outcome.retryable != null ? { retryable: item.last_outcome.retryable } : {}),
      },
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function requireEvent(event) {
  if (!isPlainObject(event)) throw new Error("event must be an object");
  if (event.schema !== ALERT_EVENT_SCHEMA) throw new Error("event.schema must be beian-alert-event-v1");
  if (typeof event.id !== "string" || !event.id) throw new Error("event.id is required");
  if (event.type !== "fault" && event.type !== "recovery") throw new Error("event.type must be fault or recovery");
  if (typeof event.source !== "string" || !event.source) throw new Error("event.source is required");
  if (!validIso(event.at)) throw new Error("event.at must be an ISO timestamp");
  if (event.incident_id != null && typeof event.incident_id !== "string") {
    throw new Error("event.incident_id must be a string when present");
  }
}

function redactDraft(event, draft) {
  const source = draft && isPlainObject(draft) ? draft : renderDraft(event);
  if (typeof source.title !== "string" || typeof source.body !== "string") {
    throw new Error("draft title/body must be strings");
  }
  return {
    title: source.title,
    body: source.body,
    redacted: true,
  };
}

function compareItems(left, right) {
  const ta = Date.parse(left.at);
  const tb = Date.parse(right.at);
  if (ta !== tb) return ta - tb;
  if (left.enqueue_seq !== right.enqueue_seq) return left.enqueue_seq - right.enqueue_seq;
  return left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0;
}

function payloadOf(item) {
  return {
    event_id: item.event_id,
    type: item.type,
    source: item.source,
    at: item.at,
    incident_id: item.incident_id,
    title: item.draft.title,
    body: item.draft.body,
  };
}

const OUTCOME_CODES = new Set(["confirmed", "failed", "unknown", "timeout", "busy", "rejected", "lost_ack", "fake_ok"]);

function outcomeCode(code, fallback) {
  return OUTCOME_CODES.has(code) ? code : fallback;
}

function normalizeSendResult(raw) {
  if (!isPlainObject(raw) || typeof raw.outcome !== "string") {
    return { outcome: "unknown", code: "unrecognized_result" };
  }
  if (raw.outcome === "confirmed") return { outcome: "confirmed", code: outcomeCode(raw.code, "confirmed") };
  if (raw.outcome === "failed") {
    return {
      outcome: "failed",
      code: outcomeCode(raw.code, "failed"),
      retryable: raw.retryable === true,
    };
  }
  if (raw.outcome === "unknown" || raw.outcome === "timeout") {
    return {
      outcome: "unknown",
      code: outcomeCode(raw.code, raw.outcome),
    };
  }
  return { outcome: "unknown", code: "unrecognized_result" };
}

function backoffDelay(config, attempt) {
  const exp = Math.max(0, attempt - 1);
  return config.backoff_ms * (2 ** exp);
}

function isThenable(value) {
  return Boolean(value) && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

function timerHost(clock) {
  if (clock && typeof clock.setTimeout === "function" && typeof clock.clearTimeout === "function") {
    return clock;
  }
  return globalThis;
}

function waitTimeout(clock, ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }
    if (!Number.isFinite(ms) || ms <= 0) {
      resolve("timeout");
      return;
    }
    const host = timerHost(clock);
    const id = host.setTimeout(() => resolve("timeout"), ms);
    const onAbort = () => {
      host.clearTimeout(id);
      resolve("aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function findById(state, eventId) {
  return state.items.find((item) => item.event_id === eventId) || null;
}

function sourceHead(state, source) {
  const rows = state.items.filter((item) => item.source === source && (ACTIVE.has(item.status) || item.status === "sending"));
  if (!rows.length) return null;
  rows.sort(compareItems);
  return rows[0];
}

export function createDeliveryQueue(options = {}) {
  if (!options || !isPlainObject(options)) throw new Error("options must be an object");
  const statePath = options.statePath;
  if (!statePath || typeof statePath !== "string" || !isAbsolute(statePath)) {
    throw new Error("statePath must be an absolute path");
  }
  const config = normalizeDeliveryConfig(options.config);
  const clock = options.clock && typeof options.clock.now === "function"
    ? options.clock
    : { now: () => Date.now() };
  const transport = options.transport == null ? null : options.transport;
  if (transport != null && (typeof transport !== "object" || typeof transport.send !== "function")) {
    throw new Error("transport.send must be a function when transport is provided");
  }
  const writeFile = options.writeFile || atomicWriteFile;
  const readFile = options.readFile || ((path) => readFileSync(path, "utf8"));
  const fileExists = options.exists || existsSync;
  const writeHooks = options.writeHooks || {};

  let state = emptyDeliveryState();
  if (fileExists(statePath)) {
    const loaded = parseDeliveryState(readFile(statePath));
    if (!loaded.ok) {
      throw new DeliveryStateError(
        `delivery state refused (${loaded.reason}); file was not reset`,
        { reason: loaded.reason, path: statePath },
      );
    }
    state = loaded.state;
  }

  function persist() {
    writeFile(statePath, serializeDeliveryState(state), writeHooks);
  }

  function recoverSendingOnLoad() {
    const nowIso = iso(clock.now());
    let changed = false;
    for (const item of state.items) {
      if (item.status !== "sending") continue;
      item.status = "unknown";
      item.next_attempt_at = null;
      item.updated_at = nowIso;
      item.last_outcome = {
        kind: "unknown",
        code: "restart_while_sending",
        at: nowIso,
        retryable: false,
      };
      changed = true;
    }
    if (changed) persist();
  }

  recoverSendingOnLoad();

  const inflight = new Map();

  function mutate(fn) {
    const previous = cloneJson(state);
    try {
      const result = fn();
      persist();
      return result;
    } catch (err) {
      state = previous;
      throw err;
    }
  }

  function sourceHasInflight(source) {
    for (const flight of inflight.values()) {
      if (flight.source === source) return true;
    }
    return false;
  }

  function pickDue(now) {
    const due = [];
    const sources = [...new Set(state.items.map((item) => item.source))];
    for (const source of sources) {
      if (sourceHasInflight(source)) continue;
      const head = sourceHead(state, source);
      if (!head) continue;
      if (!ACTIVE.has(head.status)) continue;
      if (head.next_attempt_at && Date.parse(head.next_attempt_at) > now) continue;
      due.push(head);
    }
    due.sort(compareItems);
    return due;
  }

  function pickNext(now) {
    return pickDue(now)[0] || null;
  }

  function applyResult(item, result, now) {
    const nowIso = iso(now);
    item.updated_at = nowIso;
    if (item.status !== "sending") {
      return item.status;
    }
    item.last_outcome = {
      kind: result.outcome,
      code: result.code,
      at: nowIso,
      retryable: result.outcome === "failed" ? Boolean(result.retryable) : false,
    };
    if (result.outcome === "confirmed") {
      item.status = "confirmed";
      item.next_attempt_at = null;
      return item.status;
    }
    if (result.outcome === "unknown") {
      item.status = "unknown";
      item.next_attempt_at = null;
      return item.status;
    }
    if (result.outcome === "failed" && result.retryable && item.attempt < item.max_attempts) {
      item.status = "retry_wait";
      item.next_attempt_at = iso(now + backoffDelay(config, item.attempt));
      return item.status;
    }
    item.status = "failed";
    item.next_attempt_at = null;
    return item.status;
  }

  function persistAfterSend(item, result, now, persistCode = "persist_after_send_failed") {
    const previous = cloneJson(state);
    const live = findById(state, item.event_id) || item;
    applyResult(live, result, now);
    try {
      persist();
    } catch (err) {
      state = previous;
      const frozen = findById(state, item.event_id);
      if (frozen && frozen.status === "sending") {
        frozen.status = "unknown";
        frozen.next_attempt_at = null;
        frozen.updated_at = iso(clock.now());
        frozen.last_outcome = {
          kind: "unknown",
          code: persistCode,
          at: frozen.updated_at,
          retryable: false,
        };
      }
      throw err;
    }
    const current = findById(state, item.event_id);
    return {
      event_id: item.event_id,
      status: current ? current.status : live.status,
      outcome: result.outcome,
      code: result.code,
    };
  }

  function applySettled(eventId, attempt, result, now) {
    const live = findById(state, eventId);
    if (!live) return null;
    if (live.attempt !== attempt || live.status !== "sending") {
      return {
        event_id: eventId,
        status: live.status,
        outcome: result.outcome,
        code: result.code,
        ignored: true,
      };
    }
    return persistAfterSend(live, result, now);
  }

  function decidedReport(eventId, result) {
    const live = findById(state, eventId);
    return {
      event_id: eventId,
      status: live ? live.status : "unknown",
      outcome: result.outcome,
      code: live?.last_outcome?.code || result.code,
    };
  }

  function clearFlight(eventId, flight) {
    if (inflight.get(eventId) === flight) inflight.delete(eventId);
  }

  function attemptOne(item) {
    const startedAt = clock.now();
    mutate(() => {
      item.status = "sending";
      item.send_issued = true;
      item.attempt += 1;
      item.updated_at = iso(startedAt);
    });

    const deadline_at = startedAt + config.timeout_ms;
    const sendController = new AbortController();
    const flight = {
      event_id: item.event_id,
      source: item.source,
      attempt: item.attempt,
      controller: sendController,
      notify: null,
    };
    flight.cancelP = new Promise((resolve) => {
      flight.notify = () => resolve({ kind: "cancel" });
    });
    inflight.set(item.event_id, flight);

    const ctx = {
      now: startedAt,
      deadline_at,
      attempt: item.attempt,
      event_id: item.event_id,
      signal: sendController.signal,
    };

    let raw;
    try {
      raw = transport.send(payloadOf(item), ctx);
    } catch {
      clearFlight(item.event_id, flight);
      return persistAfterSend(item, { outcome: "unknown", code: "transport_threw" }, clock.now());
    }

    if (!isThenable(raw)) {
      const after = clock.now();
      const live = findById(state, item.event_id);
      if (!live || live.status !== "sending") {
        clearFlight(item.event_id, flight);
        return decidedReport(item.event_id, { outcome: "unknown", code: "cancelled_after_send_issued" });
      }
      if (after >= deadline_at) {
        sendController.abort();
        clearFlight(item.event_id, flight);
        return persistAfterSend(item, { outcome: "unknown", code: "timeout" }, after);
      }
      clearFlight(item.event_id, flight);
      return persistAfterSend(item, normalizeSendResult(raw), after);
    }

    return settleAsync(item.event_id, flight, raw, deadline_at);
  }

  async function settleAsync(eventId, flight, rawPromise, deadline_at) {
    const timeoutCtl = new AbortController();
    const remaining = deadline_at - clock.now();
    const sendP = Promise.resolve(rawPromise).then(
      (raw) => ({ kind: "send", raw }),
      () => ({ kind: "throw" }),
    );
    sendP.finally(() => clearFlight(eventId, flight));
    const timeoutP = waitTimeout(clock, remaining, timeoutCtl.signal).then((reason) => ({ kind: reason }));

    let winner;
    try {
      winner = await Promise.race([sendP, timeoutP, flight.cancelP]);
    } finally {
      timeoutCtl.abort();
    }

    if (winner.kind === "timeout") {
      flight.controller.abort();
      // A failed timeout write does not mean the transport has settled.
      // sendP.finally owns cleanup so later events from this source stay blocked.
      const reported = applySettled(eventId, flight.attempt, { outcome: "unknown", code: "timeout" }, clock.now());
      return reported || decidedReport(eventId, { outcome: "unknown", code: "timeout" });
    }

    if (winner.kind === "cancel" || winner.kind === "aborted") {
      flight.controller.abort();
      return decidedReport(eventId, { outcome: "unknown", code: "cancelled_after_send_issued" });
    }

    if (winner.kind === "throw") {
      clearFlight(eventId, flight);
      return applySettled(eventId, flight.attempt, { outcome: "unknown", code: "transport_threw" }, clock.now())
        || decidedReport(eventId, { outcome: "unknown", code: "transport_threw" });
    }

    const after = clock.now();
    if (after >= deadline_at) {
      flight.controller.abort();
      try {
        const reported = applySettled(eventId, flight.attempt, { outcome: "unknown", code: "timeout" }, after);
        return reported || decidedReport(eventId, { outcome: "unknown", code: "timeout" });
      } catch (err) {
        clearFlight(eventId, flight);
        throw err;
      }
    }

    clearFlight(eventId, flight);
    return applySettled(eventId, flight.attempt, normalizeSendResult(winner.raw), after)
      || decidedReport(eventId, normalizeSendResult(winner.raw));
  }

  return {
    config,
    statePath,
    exactly_once: DELIVERY_EXACTLY_ONCE,
    enqueueEvents(events, drafts = []) {
      if (!Array.isArray(events)) throw new Error("events must be an array");
      if (drafts != null && !Array.isArray(drafts)) throw new Error("drafts must be an array");
      const draftById = new Map((drafts || []).map((draft) => [draft.event_id, draft]));
      const nowIso = iso(clock.now());
      return mutate(() => {
        const added = [];
        const duplicates = [];
        for (const event of events) {
          requireEvent(event);
          const existing = findById(state, event.id);
          if (existing) {
            duplicates.push({ event_id: event.id, status: existing.status });
            continue;
          }
          const item = {
            event_id: event.id,
            type: event.type,
            source: event.source,
            at: event.at,
            incident_id: event.incident_id ?? null,
            enqueue_seq: state.next_seq,
            status: "queued",
            attempt: 0,
            max_attempts: config.max_attempts,
            next_attempt_at: nowIso,
            enqueued_at: nowIso,
            updated_at: nowIso,
            send_issued: false,
            draft: redactDraft(event, draftById.get(event.id)),
            last_outcome: null,
          };
          state.next_seq += 1;
          state.items.push(item);
          added.push({ event_id: item.event_id, type: item.type, source: item.source });
        }
        return { added, duplicates, exactly_once: false };
      });
    },
    enqueueFromReplay(result) {
      if (!result || !Array.isArray(result.events)) throw new Error("replay result.events is required");
      return this.enqueueEvents(result.events, result.drafts || []);
    },
    tick() {
      if (!transport) {
        const due = [];
        const now = clock.now();
        const item = pickNext(now);
        if (item) due.push(item.event_id);
        return {
          attempted: [],
          skipped: "no_transport",
          due,
          exactly_once: false,
        };
      }

      const attempted = [];
      const collectBlocked = () => {
        const blocked = [];
        const seen = new Set();
        for (const row of state.items) {
          if (!ACTIVE.has(row.status)) continue;
          let blockedBy = null;
          const head = sourceHead(state, row.source);
          if (head && head.event_id !== row.event_id) blockedBy = head.event_id;
          if (!blockedBy) {
            for (const [id, flight] of inflight) {
              if (flight.source === row.source && id !== row.event_id) {
                blockedBy = id;
                break;
              }
            }
          }
          if (!blockedBy || seen.has(`${row.event_id}:${blockedBy}`)) continue;
          seen.add(`${row.event_id}:${blockedBy}`);
          blocked.push({ event_id: row.event_id, blocked_by: blockedBy });
        }
        return blocked;
      };
      const finish = () => ({
        attempted,
        blocked: collectBlocked(),
        skipped: null,
        exactly_once: false,
      });

      const runBatch = () => {
        const due = pickDue(clock.now());
        if (!due.length) return null;
        const batch = [];
        for (const item of due) {
          try {
            batch.push(attemptOne(item));
          } catch (err) {
            if (!batch.some(isThenable)) throw err;
            batch.push(Promise.reject(err));
            break;
          }
        }
        return batch;
      };

      const settleBatch = async (batch) => {
        // Do not report the tick finished while a sibling can still persist a result.
        const results = await Promise.allSettled(batch);
        const failed = results.find(row => row.status === "rejected");
        if (failed) throw failed.reason;
        return results.map(row => row.value);
      };
      const drainAsync = async (batch) => {
        attempted.push(...await settleBatch(batch));
        let guard = state.items.length + 2;
        while (guard-- > 0) {
          const next = runBatch();
          if (!next) break;
          attempted.push(...await settleBatch(next));
        }
        return finish();
      };

      let guard = state.items.length + 2;
      while (guard-- > 0) {
        const batch = runBatch();
        if (!batch) return finish();
        if (batch.some(isThenable)) return drainAsync(batch);
        attempted.push(...batch);
      }
      return finish();
    },
    cancel(eventId) {
      if (typeof eventId !== "string" || !eventId) throw new Error("eventId is required");
      const result = mutate(() => {
        const item = findById(state, eventId);
        if (!item) return { ok: false, reason: "not_found" };
        if (item.status === "cancelled") return { ok: true, status: "cancelled", reason: "already_cancelled" };
        if (TERMINAL.has(item.status) && item.status !== "unknown") {
          return { ok: false, status: item.status, reason: "already_terminal" };
        }
        const nowIso = iso(clock.now());
        if (item.status === "sending" || item.send_issued) {
          item.status = "unknown";
          item.next_attempt_at = null;
          item.updated_at = nowIso;
          item.last_outcome = {
            kind: "unknown",
            code: "cancelled_after_send_issued",
            at: nowIso,
            retryable: false,
          };
          return { ok: true, status: "unknown", reason: "inflight_unknown" };
        }
        item.status = "cancelled";
        item.next_attempt_at = null;
        item.updated_at = nowIso;
        item.last_outcome = {
          kind: "failed",
          code: "cancelled",
          at: nowIso,
          retryable: false,
        };
        return { ok: true, status: "cancelled", reason: "cancelled_before_send" };
      });
      // Abort/notification cannot be rolled back if the cancellation write fails.
      if (result.reason === "inflight_unknown") {
        const flight = inflight.get(eventId);
        if (flight) {
          flight.controller.abort();
          if (typeof flight.notify === "function") flight.notify();
        }
      }
      return result;
    },
    retryUnknown(eventId) {
      if (typeof eventId !== "string" || !eventId) throw new Error("eventId is required");
      return mutate(() => {
        const item = findById(state, eventId);
        if (!item) return { ok: false, reason: "not_found" };
        if (item.status !== "unknown") {
          return { ok: false, status: item.status, reason: "not_unknown" };
        }
        const nowIso = iso(clock.now());
        item.status = "retry_wait";
        item.next_attempt_at = nowIso;
        item.updated_at = nowIso;
        item.send_issued = false;
        item.last_outcome = {
          kind: "unknown",
          code: "explicit_retry_unknown_may_duplicate",
          at: nowIso,
          retryable: true,
        };
        return { ok: true, status: "retry_wait", reason: "may_duplicate" };
      });
    },
    snapshot() {
      return {
        schema: DELIVERY_SCHEMA,
        exactly_once: false,
        config: { ...config },
        items: cloneJson(state.items).sort(compareItems),
        limitations: [
          DELIVERY_EXACTLY_ONCE_NOTE,
          ATOMIC_WRITE_NOTE,
          "默认无 transport，不会发送真实消息，也不会读取产品飞书开关或密钥。",
          "坏损状态文件会拒绝操作，不会静默清空后重发。",
          "本地 JSON 原子写不是断电耐久性或 Windows 实机证明。",
          "Promise transport 由队列用截止时间与 AbortSignal 竞速；超时或取消后迟到成功不能覆盖已确定状态。同步 send 卡住时仍无法强杀。",
          "同来源在未决发送 Promise 结束前不会启动后一条，避免异步完成把故障/恢复颠倒。不同来源可在同一次 tick 并行发出。",
        ],
      };
    },
  };
}
