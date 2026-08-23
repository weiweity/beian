import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { afterEach, describe, it, mock } from "node:test";
import { httpsJson } from "./outbound.js";

type ReqOpts = {
  hostname?: string;
  method?: string;
  agent?: unknown;
};

function mockHttpsJson(status: number, json: unknown): ReqOpts[] {
  const seen: ReqOpts[] = [];
  mock.method(https, "request", (opts: ReqOpts, cb?: (res: EventEmitter) => void) => {
    seen.push(opts);
    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
      end: () => void;
      destroy: () => void;
    };
    req.write = () => true;
    req.destroy = () => {
      req.emit("error", new Error("destroyed"));
    };
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = status;
      cb?.(res);
      queueMicrotask(() => {
        res.emit("data", Buffer.from(JSON.stringify(json)));
        res.emit("end");
      });
    };
    return req;
  });
  return seen;
}

describe("httpsJson", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
  });

  it("posts JSON without inheriting HTTP_PROXY", async () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:9";
    process.env.https_proxy = "http://127.0.0.1:9";
    const seen = mockHttpsJson(400, { error: "invalid request", code: 95004 });
    const res = await httpsJson("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error?: string }).error, "invalid request");
    assert.equal(seen[0]?.hostname, "open.feishu.cn");
    assert.equal(seen[0]?.method, "POST");
    assert.equal("agent" in (seen[0] || {}), false);
  });
});
