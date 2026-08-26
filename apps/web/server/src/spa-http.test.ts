import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-spa-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";
process.env.WB_PUBLIC = "1";
process.env.FEISHU_APP_ID = "cli_test_app";
process.env.FEISHU_APP_SECRET = "test-secret";

const { app } = await import("./index.js");
const { issueSession } = await import("./auth.js");
const { COOKIE } = await import("./config.js");

describe("GET / spa gate", () => {
  it("returns the real viewer permission set instead of exposing delete actions", async () => {
    const sess = issueSession("只看", "viewer", "ou_spa_viewer", "feishu");
    const res = await app.request("/api/auth/me", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { perms?: string[] };
    assert.deepEqual(body.perms, ["read", "export"]);
  });

  it("sends the old review desk root to /reviewup", async () => {
    const res = await app.request("/", { headers: { host: "www.jianghua.site" } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/reviewup");
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    const neu = await app.request("/new", { headers: { host: "www.jianghua.site" } });
    assert.equal(neu.status, 302);
    assert.equal(neu.headers.get("location"), "/reviewup/new");
    const bare = await app.request("/review", { headers: { host: "www.jianghua.site" } });
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get("location"), "/reviewup");
  });

  it("sends anonymous public visitors on /reviewup to Feishu before the JS bundle", async () => {
    const res = await app.request("/reviewup", { headers: { host: "www.jianghua.site" } });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") || "", /\/api\/auth\/feishu\/login/);
    assert.doesNotMatch(res.headers.get("location") || "", /next=/);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
  });

  it("still shows the Feishu error page after following the old-root redirect", async () => {
    const hop = await app.request("/?feishu_error=denied", { headers: { host: "www.jianghua.site" } });
    assert.equal(hop.status, 302);
    assert.equal(hop.headers.get("location"), "/reviewup?feishu_error=denied");
    const res = await app.request("/reviewup?feishu_error=denied", { headers: { host: "www.jianghua.site" } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /打开审稿台|root/);
  });

  it("serves the app when wb_session is valid", async () => {
    const sess = issueSession("刘籽烨", "reviewer", "ou_spa_http", "feishu");
    const res = await app.request("/reviewup", {
      headers: { host: "www.jianghua.site", cookie: `${COOKIE}=${sess.token}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /no-cache/);
  });

  it("keeps desk paths on the same SPA gate", async () => {
    const sess = issueSession("刘籽烨", "reviewer", "ou_spa_desk", "feishu");
    for (const path of [
      "/reviewup",
      "/reviewup/new",
      "/settings",
      "/history",
      "/mockup",
      "/mockup/new",
      "/mockup/aabbccddeeff",
      "/review/aabbccddeeff",
    ]) {
      const res = await app.request(path, {
        headers: { host: "www.jianghua.site", cookie: `${COOKIE}=${sess.token}` },
      });
      assert.equal(res.status, 200, path);
    }
  });

  it("sends anonymous visitors on a desk path to Feishu with next", async () => {
    const res = await app.request("/review/aabbccddeeff", { headers: { host: "www.jianghua.site" } });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") || "", /\/api\/auth\/feishu\/login\?next=/);
    assert.match(res.headers.get("location") || "", /review%2Faabbccddeeff/);
    const mock = await app.request("/mockup/aabbccddeeff", { headers: { host: "www.jianghua.site" } });
    assert.equal(mock.status, 302);
    assert.match(mock.headers.get("location") || "", /mockup%2Faabbccddeeff/);
    const work = await app.request("/reviewup/new", { headers: { host: "www.jianghua.site" } });
    assert.equal(work.status, 302);
    assert.match(work.headers.get("location") || "", /reviewup%2Fnew/);
  });

  it("does not redirect when Feishu is not configured", async () => {
    const id = process.env.FEISHU_APP_ID;
    const secret = process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    try {
      const res = await app.request("/reviewup", { headers: { host: "www.jianghua.site" } });
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
      const res = await app.request("/reviewup", { headers: { host: "127.0.0.1:8787" } });
      assert.equal(res.status, 200);
    } finally {
      if (prev === undefined) delete process.env.WB_PUBLIC;
      else process.env.WB_PUBLIC = prev;
    }
  });
});
