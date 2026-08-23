import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-spa-http-"));
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";
process.env.WB_PUBLIC = "1";
process.env.FEISHU_APP_ID = "cli_test_app";
process.env.FEISHU_APP_SECRET = "test-secret";

const { app } = await import("./index.js");
const { issueSession } = await import("./auth.js");
const { COOKIE } = await import("./config.js");

describe("GET / spa gate", () => {
  it("sends anonymous public visitors to Feishu before the JS bundle", async () => {
    const res = await app.request("/", { headers: { host: "www.jianghua.site" } });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") || "", /\/api\/auth\/feishu\/login/);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
  });

  it("still shows the Feishu error page", async () => {
    const res = await app.request("/?feishu_error=denied", { headers: { host: "www.jianghua.site" } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /打开审稿台|root/);
  });

  it("serves the app when wb_session is valid", async () => {
    const sess = issueSession("刘籽烨", "reviewer", "ou_spa_http", "feishu");
    const res = await app.request("/", {
      headers: { host: "www.jianghua.site", cookie: `${COOKIE}=${sess.token}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /no-cache/);
  });

  it("does not redirect when Feishu is not configured", async () => {
    const id = process.env.FEISHU_APP_ID;
    const secret = process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    try {
      const res = await app.request("/", { headers: { host: "www.jianghua.site" } });
      assert.equal(res.status, 200);
    } finally {
      if (id) process.env.FEISHU_APP_ID = id;
      if (secret) process.env.FEISHU_APP_SECRET = secret;
    }
  });

  it("keeps display-login HTML on loopback when not public", async () => {
    const prev = process.env.WB_PUBLIC;
    delete process.env.WB_PUBLIC;
    try {
      const res = await app.request("/", { headers: { host: "127.0.0.1:8787" } });
      assert.equal(res.status, 200);
    } finally {
      if (prev === undefined) delete process.env.WB_PUBLIC;
      else process.env.WB_PUBLIC = prev;
    }
  });
});
