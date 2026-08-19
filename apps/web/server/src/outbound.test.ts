import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { httpsJson } from "./outbound.js";

describe("httpsJson", () => {
  it("reaches Feishu without the local proxy", async () => {
    const res = await httpsJson("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.ok(res.status === 400 || res.status === 200);
    const body = res.json as { error?: string; code?: number };
    assert.ok(body.error || body.code != null);
  });
});
