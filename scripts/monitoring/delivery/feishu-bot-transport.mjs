/**
 * F02 独立飞书 bot transport。
 *
 * 只把已脱敏的投递 payload 交给注入的 lark-cli 执行器。默认不允许真实发送。
 * 不读产品 settings / FEISHU_* / 环境变量，不选 webhook，不改 notify.ts。
 */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

const RECEIVE_ID = /^ou_[a-z0-9]+$/i;
const TEXT_LIMIT = 3500;
const IDEMPOTENCY_LIMIT = 50;

export const FEISHU_BOT_TRANSPORT_NOTE =
  "独立飞书 bot transport 必须显式注入 cli 路径、ou_ 接收人和 exec。默认 allowRealSend=false，不会 spawn lark-cli，也不会读取产品飞书设置。";

function clipText(text) {
  if (text.length <= TEXT_LIMIT) return text;
  return `${text.slice(0, TEXT_LIMIT - 10)}\n…(截断)`;
}

function payloadText(payload) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const text = [title, body].filter(Boolean).join("\n") || "beian monitor event";
  return clipText(text);
}

function parseEnvelope(stdout, stderr) {
  const raw = String(stdout || "").trim() || String(stderr || "").trim();
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function mapExecError(err) {
  const reason = err && typeof err === "object" ? err.reason : "";
  if (reason === "timeout" || reason === "cancelled") {
    return { outcome: "unknown", code: "timeout" };
  }
  if (reason === "missing_executable") {
    return { outcome: "failed", retryable: false, code: "rejected" };
  }
  return { outcome: "unknown", code: "lost_ack" };
}

function mapProcessResult(result) {
  if (result && result.authorized === false) {
    return { outcome: "failed", retryable: false, code: "rejected" };
  }
  const code = typeof result?.code === "number" ? result.code : 1;
  const envelope = parseEnvelope(result?.stdout, result?.stderr);
  if (code === 0 && envelope && envelope.ok === true) {
    return { outcome: "confirmed", code: "confirmed" };
  }
  if (code === 10) {
    return { outcome: "failed", retryable: false, code: "rejected" };
  }
  if (code === 0 && !envelope) {
    return { outcome: "unknown", code: "lost_ack" };
  }
  return { outcome: "failed", retryable: false, code: "rejected" };
}

export function buildFeishuBotArgv({ cliPath, receiveId, text, eventId }) {
  const argv = [
    cliPath,
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--user-id",
    receiveId,
    "--text",
    text,
    "--format",
    "json",
  ];
  if (typeof eventId === "string" && eventId.length > 0 && eventId.length <= IDEMPOTENCY_LIMIT) {
    argv.push("--idempotency-key", eventId);
  }
  return argv;
}

export function createLarkCliExec({ allowRealSend = false, spawnImpl = execFile } = {}) {
  return function exec(argv, { timeoutMs, signal } = {}) {
    if (allowRealSend !== true) {
      return Promise.resolve({
        code: 2,
        stdout: "",
        stderr: "real_send_not_authorized",
        authorized: false,
      });
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(Object.assign(new Error("cancelled"), { reason: "cancelled" }));
        return;
      }
      let child;
      const onAbort = () => { child?.kill(); };
      const [file, ...args] = argv;
      child = spawnImpl(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 },
        (err, stdout, stderr) => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(Object.assign(new Error("cancelled"), { reason: "cancelled" }));
            return;
          }
          if (err && err.killed) {
            reject(Object.assign(new Error("timeout"), { reason: "timeout" }));
            return;
          }
          if (err && err.code === "ENOENT") {
            reject(Object.assign(new Error("missing_executable"), { reason: "missing_executable" }));
            return;
          }
          resolve({
            stdout: stdout || "",
            stderr: typeof stderr === "string" ? stderr : "",
            code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          });
        },
      );
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  };
}

export function createFeishuBotTransport(options = {}) {
  const cliPath = options.cliPath;
  const receiveId = options.receiveId;
  const identity = options.identity == null ? "bot" : options.identity;
  const exec = options.exec;
  if (typeof cliPath !== "string" || !isAbsolute(cliPath)) {
    throw new Error("cliPath must be an absolute path");
  }
  if (typeof receiveId !== "string" || !RECEIVE_ID.test(receiveId)) {
    throw new Error("receiveId must be an explicit ou_ open_id");
  }
  if (identity !== "bot") {
    throw new Error("feishu bot transport only accepts identity=bot");
  }
  if (typeof exec !== "function") {
    throw new Error("exec must be injected; there is no default sender");
  }
  const calls = [];
  return {
    channel: "feishu_bot",
    identity: "bot",
    calls,
    send(payload, ctx = {}) {
      if (!payload || typeof payload !== "object") {
        throw new Error("payload must be an object");
      }
      const text = payloadText(payload);
      const argv = buildFeishuBotArgv({
        cliPath,
        receiveId,
        text,
        eventId: payload.event_id,
      });
      const entry = {
        event_id: payload.event_id,
        type: payload.type,
        source: payload.source,
        attempt: ctx.attempt ?? null,
        argv_head: argv.slice(0, 6),
        result: null,
      };
      calls.push(entry);
      const timeoutMs = typeof ctx.deadline_at === "number" && typeof ctx.now === "number"
        ? Math.max(1, ctx.deadline_at - ctx.now)
        : undefined;
      try {
        const raw = exec(argv, { timeoutMs, signal: ctx.signal });
        if (raw && typeof raw.then === "function") {
          return Promise.resolve(raw).then(
            (result) => {
              const mapped = mapProcessResult(result);
              entry.result = mapped;
              return mapped;
            },
            (err) => {
              const mapped = mapExecError(err);
              entry.result = mapped;
              return mapped;
            },
          );
        }
        const mapped = mapProcessResult(raw);
        entry.result = mapped;
        return mapped;
      } catch (err) {
        const mapped = mapExecError(err);
        entry.result = mapped;
        return mapped;
      }
    },
  };
}

export function createFeishuHttpTransport(options = {}) {
  const receiveId = options.receiveId;
  const appId = options.appId;
  const appSecret = options.appSecret;
  const postJson = options.postJson;
  if (typeof receiveId !== "string" || !RECEIVE_ID.test(receiveId)) {
    throw new Error("receiveId must be an explicit ou_ open_id");
  }
  if (typeof appId !== "string" || appId.length < 4) {
    throw new Error("appId must be explicit");
  }
  if (typeof appSecret !== "string" || appSecret.length < 4) {
    throw new Error("appSecret must be explicit");
  }
  if (typeof postJson !== "function") {
    throw new Error("postJson must be injected; there is no default HTTP client");
  }
  const calls = [];
  return {
    channel: "feishu_bot_http",
    identity: "bot",
    calls,
    async send(payload, ctx = {}) {
      if (!payload || typeof payload !== "object") {
        throw new Error("payload must be an object");
      }
      const text = payloadText(payload);
      const entry = {
        event_id: payload.event_id,
        type: payload.type,
        source: payload.source,
        attempt: ctx.attempt ?? null,
        result: null,
      };
      calls.push(entry);
      try {
        const tokenRes = await postJson("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
          body: { app_id: appId, app_secret: appSecret },
          signal: ctx.signal,
        });
        const tokenJson = tokenRes && typeof tokenRes === "object" ? tokenRes.json : null;
        const token = tokenJson && typeof tokenJson.tenant_access_token === "string"
          ? tokenJson.tenant_access_token
          : "";
        if (!token) {
          const mapped = { outcome: "failed", retryable: false, code: "rejected" };
          entry.result = mapped;
          return mapped;
        }
        const sent = await postJson("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
          headers: { Authorization: "Bearer redacted" },
          body: {
            receive_id: receiveId,
            msg_type: "text",
            content: JSON.stringify({ text }),
          },
          signal: ctx.signal,
          accessToken: token,
        });
        const json = sent && typeof sent === "object" ? sent.json : null;
        const ok = sent && sent.status >= 200 && sent.status < 300 && json && (json.code === 0 || json.ok === true);
        const mapped = ok
          ? { outcome: "confirmed", code: "confirmed" }
          : { outcome: "failed", retryable: false, code: "rejected" };
        entry.result = mapped;
        return mapped;
      } catch (err) {
        const mapped = mapExecError(err);
        entry.result = mapped;
        return mapped;
      }
    },
  };
}
