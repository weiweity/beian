/**
 * 本地 fake transport。不访问网络、不读密钥、不默认任何真实渠道。
 * 结果由测试或示例脚本注入：confirmed / failed / unknown；step 也可返回 Promise。
 */
function isThenable(value) {
  return Boolean(value) && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

export function createFakeTransport(script = []) {
  const calls = [];
  let index = 0;
  const run = typeof script === "function"
    ? script
    : (payload, ctx) => {
      if (!Array.isArray(script) || script.length === 0) {
        return { outcome: "confirmed", code: "fake_ok" };
      }
      const step = index < script.length ? script[index] : { outcome: "confirmed", code: "fake_ok" };
      index += 1;
      return typeof step === "function" ? step(payload, ctx) : step;
    };

  return {
    calls,
    send(payload, ctx = {}) {
      if (!payload || typeof payload !== "object") {
        throw new Error("payload must be an object");
      }
      const entry = {
        event_id: payload.event_id,
        type: payload.type,
        source: payload.source,
        at: payload.at,
        attempt: ctx.attempt ?? null,
        deadline_at: ctx.deadline_at ?? null,
        signal: ctx.signal ?? null,
        result: null,
      };
      calls.push(entry);
      try {
        const result = run(payload, ctx);
        if (isThenable(result)) {
          return Promise.resolve(result).then(
            (resolved) => {
              entry.result = resolved;
              return resolved;
            },
            (err) => {
              entry.result = { outcome: "unknown", code: "transport_threw" };
              throw err;
            },
          );
        }
        entry.result = result;
        return result;
      } catch (err) {
        entry.result = { outcome: "unknown", code: "transport_threw" };
        throw err;
      }
    },
  };
}
