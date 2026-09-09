/**
 * F02 只读 HTTP health 探测。URL 必须由调用方显式给出；无默认公网/杭州地址。
 * 原始 URL、凭据、响应正文不进入公开 facts。
 */
const VERSION_RE = /^\d+(?:\.\d+){1,3}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const FORBIDDEN_HEADERS = Object.freeze([
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "authorization",
  "cookie",
  "x-beian-release-token",
  "x-beian-release-lease",
]);

const MAX_BODY_CHARS = 65_536;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function assertProbeUrl(url, target) {
  if (target !== "loopback" && target !== "public") throw new Error("invalid_target");
  if (typeof url !== "string" || !url.trim()) throw new Error("invalid_url");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid_url");
  if (parsed.username || parsed.password) throw new Error("credentials_in_url");
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host);
  if (target === "loopback" && !loopback) throw new Error("public_as_loopback");
  if (target === "public" && loopback) throw new Error("loopback_as_public");
  return parsed;
}

export function loopbackHeaders() {
  return { accept: "application/json" };
}

function hasForbiddenHeader(headers) {
  if (!headers || typeof headers !== "object") return false;
  return Object.keys(headers).some((key) => FORBIDDEN_HEADERS.includes(key.toLowerCase()));
}

function hasLiveStatus(body) {
  if (!isPlainObject(body) || !isPlainObject(body.jobs) || !isPlainObject(body.uploads)) return false;
  for (const key of ["ocr", "blender", "illustrator"]) {
    const row = body.jobs[key];
    if (!isPlainObject(row) || !isFiniteNumber(row.running) || !isFiniteNumber(row.queued)) return false;
  }
  if (!isFiniteNumber(body.uploads.active) || !isFiniteNumber(body.uploads.waiting)) return false;
  return typeof body.feishu_notify === "boolean";
}

function explicitUnhealthy(target, body) {
  if (body.ok === false) return true;
  if (Object.prototype.hasOwnProperty.call(body, "runtime") && body.runtime !== "typescript") return true;
  if (target === "public") {
    const visibility = body.jobs?.illustrator?.visibility;
    if (visibility != null && visibility !== "authenticated") return true;
  }
  return false;
}

function contractComplete(target, body) {
  if (body.ok !== true) return false;
  if (body.runtime !== "typescript") return false;
  if (typeof body.version !== "string" || !VERSION_RE.test(body.version)) return false;
  if (target === "public") return body.jobs?.illustrator?.visibility === "authenticated";
  return hasLiveStatus(body);
}

function buildHttpFact(target, fields = {}) {
  const fact = { kind: "http", target };
  if (typeof fields.sample_ok === "boolean") fact.sample_ok = fields.sample_ok;
  if (Number.isInteger(fields.http_status) && fields.http_status >= 1) fact.http_status = fields.http_status;
  if (typeof fields.parse_ok === "boolean") fact.parse_ok = fields.parse_ok;
  if (typeof fields.body_ok === "boolean") fact.body_ok = fields.body_ok;
  if (typeof fields.version === "string" && VERSION_RE.test(fields.version)) fact.version = fields.version;
  return fact;
}

function parseHealthObject(text) {
  if (typeof text !== "string") return { error: "non_json" };
  if (!text.trim()) return { error: "non_json" };
  if (text.length > MAX_BODY_CHARS) return { error: "non_json" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "bad_json" };
  }
  if (!isPlainObject(parsed)) return { error: "non_json" };
  return { body: parsed };
}

function httpFactFromResponse(target, response) {
  if (target !== "loopback" && target !== "public") throw new Error("invalid_target");
  if (!response || response.sample_ok === false) {
    return { fact: buildHttpFact(target, { sample_ok: false }), reason: response?.reason || "sample_failed" };
  }
  const status = response.status;
  if (!Number.isInteger(status) || status < 1) {
    return { fact: buildHttpFact(target, { sample_ok: false }), reason: "sample_failed" };
  }
  if (status !== 200) {
    return {
      fact: buildHttpFact(target, { sample_ok: true, http_status: status, parse_ok: true, body_ok: false }),
    };
  }
  const parsed = parseHealthObject(response.bodyText);
  if (parsed.error) {
    return {
      fact: buildHttpFact(target, { sample_ok: true, http_status: 200, parse_ok: false }),
      reason: parsed.error,
    };
  }
  const version = typeof parsed.body.version === "string" && VERSION_RE.test(parsed.body.version)
    ? parsed.body.version
    : undefined;
  if (explicitUnhealthy(target, parsed.body)) {
    return {
      fact: buildHttpFact(target, { sample_ok: true, http_status: 200, parse_ok: true, body_ok: false, version }),
    };
  }
  if (contractComplete(target, parsed.body)) {
    return {
      fact: buildHttpFact(target, { sample_ok: true, http_status: 200, parse_ok: true, body_ok: true, version }),
    };
  }
  return {
    fact: buildHttpFact(target, { sample_ok: true, http_status: 200, parse_ok: true, version }),
    reason: "incomplete_fields",
  };
}

function classifyHttpError(err, signal) {
  if (signal?.aborted) return "cancelled";
  if (["timeout", "cancelled", "network", "body_too_large"].includes(err?.reason)) return err.reason;
  if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) return "timeout";
  return "network";
}

async function readBoundedBody(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "", completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { completed = true; return text + decoder.decode(); }
      bytes += value.byteLength;
      if (bytes > 65_536) throw Object.assign(new Error("body_too_large"), { reason: "body_too_large" });
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function defaultHttpGet(url, { headers = {}, timeoutMs = 8000, signal, redirect = "error" } = {}) {
  if (hasForbiddenHeader(headers)) throw new Error("forbidden_header");
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      const err = new Error("cancelled");
      err.reason = "cancelled";
      throw err;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      redirect,
      signal: ac.signal,
    });
    // An error status is already a complete health observation; do not wait for its body.
    if (res.status !== 200) {
      if (res.body) void res.body.cancel().catch(() => {});
      return { status: res.status, bodyText: "" };
    }
    const bodyText = await readBoundedBody(res);
    return { status: res.status, bodyText };
  } catch (err) {
    const reason = signal?.aborted && !timedOut ? "cancelled" : timedOut ? "timeout" : classifyHttpError(err, signal);
    const wrapped = new Error(reason);
    wrapped.reason = reason;
    throw wrapped;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export async function probeHttpHealth({ target, url, httpGet, timeoutMs, signal }) {
  assertProbeUrl(url, target);
  const headers = loopbackHeaders();
  try {
    const response = await httpGet(url, { headers, timeoutMs, signal, redirect: "error" });
    return httpFactFromResponse(target, { sample_ok: true, status: response.status, bodyText: response.bodyText });
  } catch (err) {
    const reason = classifyHttpError(err, signal);
    return { fact: buildHttpFact(target, { sample_ok: false }), reason };
  }
}
