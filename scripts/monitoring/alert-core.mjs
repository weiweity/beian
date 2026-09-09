/**
 * F02 第一阶段：本地告警判断、去抖与重复抑制。
 *
 * 时间与采样事实由调用方注入；本模块不读真实时钟、不访问网络、不查 Windows 服务。
 * 公网 HTTP 失败不得断言 beian-server-8787 / cloudflared 已停。
 * 阈值默认只是本地候选。本地状态抑制不是端到端 exactly-once。
 */
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";

const ALERT_CORE_SCHEMA = "beian-alert-state-v1";
const ALERT_EVENT_SCHEMA = "beian-alert-event-v1";
const ALERT_CONFIG_SCHEMA = "beian-alert-config-v1";
export const ALERT_CORE_EXACTLY_ONCE = false;
export const ALERT_CORE_EXACTLY_ONCE_NOTE =
  "本地抑制不能声称端到端 exactly-once；崩溃在持久化之前、坏状态重置或乱序丢弃都可能重发或漏发。";
export const ATOMIC_WRITE_NOTE =
  "同目录临时文件 + rename；rename 失败保留旧文件，绝不 copyFile 覆盖或先删目标。不是断电耐久性证明。";

const SOURCE_IDS = Object.freeze([
  "beian-server-8787",
  "cloudflared",
  "http_health",
  "http_health.loopback",
  "http_health.public",
]);

const SOURCE_ID_SET = new Set(SOURCE_IDS);
const SERVICE_OK = new Set(["running"]);
const SERVICE_BAD = new Set(["stopped", "paused", "missing"]);
const SERVICE_UNKNOWN = new Set([
  "unknown",
  "start_pending",
  "stop_pending",
  "continue_pending",
  "pause_pending",
]);
const FACT_ALLOW = new Set([
  "kind",
  "sample_ok",
  "observed",
  "target",
  "http_status",
  "body_ok",
  "parse_ok",
  "version",
]);

export const LOCAL_CANDIDATE_DEFAULTS = Object.freeze({
  schema: ALERT_CONFIG_SCHEMA,
  production_default: false,
  local_candidate: true,
  fail_threshold: 3,
  recover_threshold: 2,
  unknown_breaks_streak: true,
  seen_ids_limit: 256,
  sources: Object.freeze(["beian-server-8787", "cloudflared", "http_health"]),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("threshold must be a positive integer");
  }
  return value;
}

export function normalizeConfig(input = {}) {
  if (input != null && !isPlainObject(input)) throw new Error("config must be an object");
  const fail_threshold = positiveInt(input.fail_threshold, LOCAL_CANDIDATE_DEFAULTS.fail_threshold);
  const recover_threshold = positiveInt(input.recover_threshold, LOCAL_CANDIDATE_DEFAULTS.recover_threshold);
  const seen_ids_limit = positiveInt(input.seen_ids_limit, LOCAL_CANDIDATE_DEFAULTS.seen_ids_limit);
  const unknown_breaks_streak =
    input.unknown_breaks_streak == null
      ? LOCAL_CANDIDATE_DEFAULTS.unknown_breaks_streak
      : Boolean(input.unknown_breaks_streak);
  const sources = Array.isArray(input.sources) && input.sources.length
    ? [...input.sources]
    : [...LOCAL_CANDIDATE_DEFAULTS.sources];
  for (const source of sources) {
    if (!SOURCE_ID_SET.has(source)) throw new Error(`unsupported source: ${source}`);
  }
  return {
    schema: ALERT_CONFIG_SCHEMA,
    production_default: false,
    local_candidate: input.local_candidate === false ? false : true,
    fail_threshold,
    recover_threshold,
    unknown_breaks_streak,
    seen_ids_limit,
    sources,
  };
}

export function emptyState() {
  return {
    schema: ALERT_CORE_SCHEMA,
    exactly_once: false,
    last_sampled_at: null,
    last_sequence: null,
    seen_ids: [],
    sources: {},
  };
}

function emptySourceState() {
  return {
    class: "unknown",
    consecutive_ok: 0,
    consecutive_bad: 0,
    consecutive_unknown: 0,
    incident: null,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceOrder(left, right) {
  const ia = SOURCE_IDS.indexOf(left);
  const ib = SOURCE_IDS.indexOf(right);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 100 : ia) - (ib === -1 ? 100 : ib);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function expandFacts(facts) {
  if (facts == null) return {};
  if (!isPlainObject(facts)) throw new Error("facts must be an object");
  const out = {};
  for (const [key, value] of Object.entries(facts)) {
    if (
      key === "http_health"
      && isPlainObject(value)
      && !value.kind
      && (isPlainObject(value.loopback) || isPlainObject(value.public))
    ) {
      if (isPlainObject(value.loopback)) out["http_health.loopback"] = value.loopback;
      if (isPlainObject(value.public)) out["http_health.public"] = value.public;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function publicFact(fact) {
  if (!isPlainObject(fact)) return {};
  const out = {};
  for (const key of FACT_ALLOW) {
    const value = fact[key];
    if (["sample_ok", "body_ok", "parse_ok"].includes(key) && typeof value === "boolean") out[key] = value;
    else if (key === "http_status" && Number.isInteger(value)) out[key] = value;
    else if (key === "target" && ["public", "loopback"].includes(value)) out[key] = value;
    else if (key === "kind" && ["http", "windows_service"].includes(value)) out[key] = value;
    else if (key === "observed" && [...SERVICE_OK, ...SERVICE_BAD, ...SERVICE_UNKNOWN].includes(value)) out[key] = value;
    else if (key === "version" && typeof value === "string" && /^\d+(?:\.\d+){1,3}$/.test(value)) out[key] = value;
  }
  return out;
}

function normalizeObserved(value) {
  return String(value || "").trim().toLowerCase().replaceAll(" ", "_");
}

export function classifyFact(sourceId, fact) {
  if (!SOURCE_ID_SET.has(sourceId)) {
    return { class: "unknown", reason: "unrecognized_source" };
  }
  if (!isPlainObject(fact)) {
    return { class: "unknown", reason: "fact_missing" };
  }
  if (fact.sample_ok === false) {
    return { class: "unknown", reason: "sample_failed" };
  }

  if (sourceId === "beian-server-8787" || sourceId === "cloudflared") {
    if (fact.kind && fact.kind !== "windows_service") {
      return { class: "unknown", reason: "kind_mismatch" };
    }
    if (fact.sample_ok !== true) return { class: "unknown", reason: "sample_incomplete" };
    const observed = normalizeObserved(fact.observed);
    if (SERVICE_OK.has(observed)) return { class: "ok", reason: "service_running" };
    if (SERVICE_BAD.has(observed)) return { class: "bad", reason: `service_${observed}` };
    if (SERVICE_UNKNOWN.has(observed) || !observed) return { class: "unknown", reason: "service_unknown" };
    return { class: "unknown", reason: "service_unrecognized" };
  }

  if (fact.kind && fact.kind !== "http") {
    return { class: "unknown", reason: "kind_mismatch" };
  }
  if (fact.sample_ok !== true) return { class: "unknown", reason: "sample_incomplete" };
  if (fact.parse_ok === false) return { class: "unknown", reason: "parse_failed" };
  const status = fact.http_status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 1) {
    return { class: "unknown", reason: "http_status_missing" };
  }
  if (status !== 200) return { class: "bad", reason: "http_status" };
  if (fact.body_ok === true) return { class: "ok", reason: "http_ok" };
  if (fact.body_ok === false) return { class: "bad", reason: "body_not_ok" };
  return { class: "unknown", reason: "body_ok_missing" };
}

function sampleKey(sample, facts) {
  if (sample.id != null && String(sample.id).trim()) return `id:${String(sample.id)}`;
  const canon = JSON.stringify(
    Object.keys(facts).sort().map((key) => [key, publicFact(facts[key])]),
  );
  return `auto:${sample.sampled_at}:${canon}`;
}

function validIncident(value) {
  if (value == null) return true;
  if (!isPlainObject(value)) return false;
  if (value.status !== "open" && value.status !== "closed") return false;
  if (typeof value.id !== "string" || !value.id) return false;
  if (typeof value.opened_at !== "string" || !value.opened_at) return false;
  if (value.last_event_id != null && typeof value.last_event_id !== "string") return false;
  if (value.closed_at != null && typeof value.closed_at !== "string") return false;
  return true;
}

function validSourceState(value) {
  if (!isPlainObject(value)) return false;
  if (!["ok", "bad", "unknown"].includes(value.class)) return false;
  for (const key of ["consecutive_ok", "consecutive_bad", "consecutive_unknown"]) {
    if (!Number.isInteger(value[key]) || value[key] < 0) return false;
  }
  return validIncident(value.incident);
}

export function parseState(text) {
  if (text == null || text === "") {
    return { state: emptyState(), missing: true, invalid: false, reason: "missing" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: emptyState(), missing: false, invalid: true, reason: "invalid_json" };
  }
  if (!isPlainObject(parsed)) {
    return { state: emptyState(), missing: false, invalid: true, reason: "not_object" };
  }
  if (parsed.schema !== ALERT_CORE_SCHEMA) {
    return { state: emptyState(), missing: false, invalid: true, reason: "unsupported_schema" };
  }
  if (parsed.exactly_once === true) {
    return { state: emptyState(), missing: false, invalid: true, reason: "claims_exactly_once" };
  }
  if (parsed.last_sampled_at != null && typeof parsed.last_sampled_at !== "string") {
    return { state: emptyState(), missing: false, invalid: true, reason: "last_sampled_at" };
  }
  if (parsed.last_sequence != null && !Number.isInteger(parsed.last_sequence)) {
    return { state: emptyState(), missing: false, invalid: true, reason: "last_sequence" };
  }
  if (!Array.isArray(parsed.seen_ids) || parsed.seen_ids.some((id) => typeof id !== "string")) {
    return { state: emptyState(), missing: false, invalid: true, reason: "seen_ids" };
  }
  if (!isPlainObject(parsed.sources)) {
    return { state: emptyState(), missing: false, invalid: true, reason: "sources" };
  }
  for (const [source, src] of Object.entries(parsed.sources)) {
    if (!SOURCE_ID_SET.has(source) || !validSourceState(src)) {
      return { state: emptyState(), missing: false, invalid: true, reason: "source_state" };
    }
  }
  return {
    state: {
      schema: ALERT_CORE_SCHEMA,
      exactly_once: false,
      last_sampled_at: parsed.last_sampled_at ?? null,
      last_sequence: parsed.last_sequence ?? null,
      seen_ids: [...parsed.seen_ids],
      sources: cloneJson(parsed.sources),
    },
    missing: false,
    invalid: false,
    reason: "ok",
  };
}

export function serializeState(state) {
  const payload = {
    schema: ALERT_CORE_SCHEMA,
    exactly_once: false,
    last_sampled_at: state.last_sampled_at ?? null,
    last_sequence: state.last_sequence ?? null,
    seen_ids: [...(state.seen_ids || [])],
    sources: cloneJson(state.sources || {}),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function writeAllSync(fd, buf) {
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset);
  }
}

function unlinkIfExists(path) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
}

export function atomicWriteFile(dest, contents, hooks = {}) {
  if (typeof contents !== "string") throw new Error("contents must be a string");
  if (!dest || typeof dest !== "string" || !isAbsolute(dest)) {
    throw new Error("dest must be an absolute path");
  }
  const dir = dirname(dest);
  const pid = hooks.pid ?? process.pid;
  const now = hooks.now ?? Date.now();
  const nonce = hooks.nonce ?? randomBytes(4).toString("hex");
  const tmp = join(dir, `.${basename(dest)}.${pid}.${now}.${nonce}.tmp`);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY;
  const fd = openSync(tmp, flags, 0o644);
  try {
    try {
      writeAllSync(fd, Buffer.from(contents, "utf8"));
      (hooks.fsync || fsyncSync)(fd);
    } finally {
      closeSync(fd);
    }
    (hooks.rename || renameSync)(tmp, dest);
  } catch (err) {
    unlinkIfExists(tmp);
    throw err;
  }
}

function rememberId(state, key, limit) {
  if (state.seen_ids.includes(key)) return;
  state.seen_ids.push(key);
  if (state.seen_ids.length > limit) {
    state.seen_ids.splice(0, state.seen_ids.length - limit);
  }
}

function isOutOfOrder(sample, state) {
  if (Number.isInteger(sample.sequence) && Number.isInteger(state.last_sequence)) {
    return sample.sequence <= state.last_sequence;
  }
  if (state.last_sampled_at) {
    return Date.parse(sample.sampled_at) < Date.parse(state.last_sampled_at);
  }
  return false;
}

function applyClassification(sourceId, src, classification, sample, config, sampleClasses) {
  const next = src;
  next.class = classification.class;
  if (classification.class === "ok") {
    next.consecutive_ok += 1;
    next.consecutive_bad = 0;
    next.consecutive_unknown = 0;
    if (next.incident?.status === "open" && next.consecutive_ok >= config.recover_threshold) {
      const event = makeEvent({
        type: "recovery",
        source: sourceId,
        sample,
        consecutive: next.consecutive_ok,
        classification,
        incidentId: next.incident.id,
        sampleClasses,
        config,
      });
      next.incident = {
        ...next.incident,
        status: "closed",
        closed_at: sample.sampled_at,
        last_event_id: event.id,
      };
      return [event];
    }
    return [];
  }
  if (classification.class === "bad") {
    next.consecutive_bad += 1;
    next.consecutive_ok = 0;
    next.consecutive_unknown = 0;
    if (next.incident?.status !== "open" && next.consecutive_bad >= config.fail_threshold) {
      const event = makeEvent({
        type: "fault",
        source: sourceId,
        sample,
        consecutive: next.consecutive_bad,
        classification,
        incidentId: null,
        sampleClasses,
        config,
      });
      next.incident = {
        id: event.id,
        status: "open",
        opened_at: sample.sampled_at,
        closed_at: null,
        last_event_id: event.id,
      };
      return [event];
    }
    return [];
  }
  next.consecutive_unknown += 1;
  if (config.unknown_breaks_streak) {
    next.consecutive_ok = 0;
    next.consecutive_bad = 0;
  }
  return [];
}

function makeEvent({ type, source, sample, consecutive, classification, incidentId, sampleClasses, config }) {
  const id = `${type}:${source}:${sample.sampled_at}`;
  return {
    schema: ALERT_EVENT_SCHEMA,
    id,
    type,
    source,
    at: sample.sampled_at,
    consecutive,
    class: classification.class,
    reason: classification.reason,
    incident_id: type === "fault" ? id : incidentId,
    facts: publicFact((expandFacts(sample.facts || {})[source]) || {}),
    sample_classes: sampleClasses,
    local_candidate: config.local_candidate,
    exactly_once: false,
    notify: false,
  };
}

export function renderDraft(event) {
  const kind = event.type === "fault" ? "故障" : "恢复";
  const companions = Object.entries(event.sample_classes || {})
    .filter(([source]) => source !== event.source)
    .map(([source, cls]) => `${source}=${cls}`)
    .join("，");
  const httpNote = event.source.startsWith("http_health")
    ? "公网或环回 HTTP 结果只代表该探测本身，不能用来断言 beian-server-8787 或 cloudflared 已停。"
    : "进程状态只来自该来源自己的采样，不由公网 HTTP 失败推断。";
  const factBits = [];
  const facts = event.facts || {};
  if (facts.kind) factBits.push(`kind=${facts.kind}`);
  if (facts.observed) factBits.push(`observed=${facts.observed}`);
  if (facts.target) factBits.push(`target=${facts.target}`);
  if (facts.http_status != null) factBits.push(`http_status=${facts.http_status}`);
  if (facts.body_ok != null) factBits.push(`body_ok=${facts.body_ok}`);
  if (facts.sample_ok != null) factBits.push(`sample_ok=${facts.sample_ok}`);
  const title = `【备案本地告警草稿】${kind}：${event.source}`;
  const body = [
    title,
    `采样时间：${event.at}`,
    `连续${event.type === "fault" ? "异常" : "正常"}：${event.consecutive}`,
    `分类：${event.class}（${event.reason}）`,
    factBits.length ? `观察：${factBits.join(" ")}` : "观察：无",
    companions ? `同采样其他来源：${companions}` : "同采样其他来源：无",
    httpNote,
    "未发送。接收人与渠道未配置，留作后续部署。",
    ALERT_CORE_EXACTLY_ONCE_NOTE,
    event.local_candidate ? "阈值与规则为本地候选，不是生产默认。" : "阈值来自显式配置。",
  ].join("\n");
  return {
    event_id: event.id,
    type: event.type,
    source: event.source,
    title,
    body,
    redacted: true,
    channel: "unconfigured",
    recipients: "unconfigured",
    sent: false,
  };
}

function normalizeSample(sample) {
  if (!isPlainObject(sample)) return { error: "sample_not_object" };
  if (typeof sample.sampled_at !== "string" || Number.isNaN(Date.parse(sample.sampled_at))) {
    return { error: "sampled_at_invalid" };
  }
  if (sample.sequence != null && !Number.isInteger(sample.sequence)) {
    return { error: "sequence_invalid" };
  }
  if (sample.facts == null) return { error: "facts_missing" };
  try {
    const facts = expandFacts(sample.facts);
    return { sample: { ...sample, facts }, facts };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "facts_invalid" };
  }
}

export function createAlertEngine(options = {}) {
  const config = normalizeConfig(options.config);
  const loaded = options.stateText != null
    ? parseState(options.stateText)
    : options.state
      ? { state: cloneJson(options.state), missing: false, invalid: false, reason: "ok" }
      : { state: emptyState(), missing: true, invalid: false, reason: "missing" };
  const state = loaded.state;
  const warnings = [];
  if (loaded.invalid) {
    warnings.push({ code: "state_invalid", reason: loaded.reason });
  }

  return {
    config,
    warnings: () => [...warnings],
    snapshot() {
      return cloneJson(state);
    },
    ingest(rawSample) {
      const normalized = normalizeSample(rawSample);
      if (normalized.error) {
        return {
          events: [],
          skipped: [{ reason: normalized.error }],
          classifications: {},
        };
      }
      const { sample, facts } = normalized;
      const keys = Object.keys(facts);
      if (!keys.length) {
        return { events: [], skipped: [{ reason: "empty_facts", id: sample.id ?? null }], classifications: {} };
      }
      const key = sampleKey(sample, facts);
      if (state.seen_ids.includes(key)) {
        return {
          events: [],
          skipped: [{ reason: "duplicate", id: sample.id ?? null, key }],
          classifications: {},
        };
      }
      if (isOutOfOrder(sample, state)) {
        rememberId(state, key, config.seen_ids_limit);
        return {
          events: [],
          skipped: [{ reason: "out_of_order", id: sample.id ?? null, sampled_at: sample.sampled_at }],
          classifications: {},
        };
      }

      const classifications = {};
      const ordered = [...keys].sort(sourceOrder);
      for (const sourceId of ordered) {
        if (!SOURCE_ID_SET.has(sourceId)) {
          warnings.push({ code: "unrecognized_source", source: sourceId });
          continue;
        }
        classifications[sourceId] = classifyFact(sourceId, facts[sourceId]);
      }

      const events = [];
      for (const sourceId of ordered) {
        if (!classifications[sourceId]) continue;
        if (!state.sources[sourceId]) state.sources[sourceId] = emptySourceState();
        events.push(
          ...applyClassification(
            sourceId,
            state.sources[sourceId],
            classifications[sourceId],
            sample,
            config,
            Object.fromEntries(Object.entries(classifications).map(([id, row]) => [id, row.class])),
          ),
        );
      }

      rememberId(state, key, config.seen_ids_limit);
      state.last_sampled_at = sample.sampled_at;
      if (Number.isInteger(sample.sequence)) state.last_sequence = sample.sequence;
      return { events, skipped: [], classifications };
    },
  };
}

export function replaySamples(samples, options = {}) {
  const engine = createAlertEngine(options);
  const events = [];
  const skipped = [];
  if (!Array.isArray(samples)) {
    return {
      events: [],
      drafts: [],
      skipped: [{ reason: "samples_not_array" }],
      warnings: engine.warnings(),
      state: engine.snapshot(),
      config: engine.config,
      exactly_once: false,
      notify: false,
    };
  }
  for (const sample of samples) {
    const result = engine.ingest(sample);
    events.push(...result.events);
    skipped.push(...result.skipped);
  }
  return {
    events,
    drafts: events.map((event) => renderDraft(event)),
    skipped,
    warnings: engine.warnings(),
    state: engine.snapshot(),
    config: engine.config,
    exactly_once: false,
    notify: false,
    limitations: [
      ALERT_CORE_EXACTLY_ONCE_NOTE,
      ATOMIC_WRITE_NOTE,
      "未接真实通知渠道，未注册计划任务或服务，未改生产健康路由。",
      "未做生产检测或 Windows 部署验证。",
    ],
  };
}
