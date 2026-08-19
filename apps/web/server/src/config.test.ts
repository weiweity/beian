import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripLoopbackProxy } from "./config.js";

describe("stripLoopbackProxy", () => {
  it("drops clash on 127.0.0.1 and keeps remote proxy", () => {
    const env: NodeJS.ProcessEnv = {
      https_proxy: "http://127.0.0.1:7897",
      HTTP_PROXY: "http://corp.example:8080",
    };
    const removed = stripLoopbackProxy(env);
    assert.deepEqual(removed, ["https_proxy"]);
    assert.equal(env.https_proxy, undefined);
    assert.equal(env.HTTP_PROXY, "http://corp.example:8080");
  });
});
