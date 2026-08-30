import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const { createDisplaySession, issueSessionForTest, loadSessions, sessionFromFeishu } = await import("./auth.js");
const { COOKIE } = await import("./config.js");

const dataDir = process.env.WB_DATA_DIR as string;
const usersPath = join(dataDir, "users.json");

function writeUsers(users: unknown[]): void {
  writeFileSync(usersPath, JSON.stringify({ users }) + "\n");
}

describe("GET / spa gate", () => {
  it("returns the real viewer permission set instead of exposing delete actions", async () => {
    const sess = issueSessionForTest("只看", "viewer", "ou_spa_viewer");
    const res = await app.request("/api/auth/me", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { perms?: string[] };
    assert.deepEqual(body.perms, ["read", "export"]);
  });

  it("restores and revalidates a real Feishu session through the HTTP boundary", async () => {
    const row = { name: "真实会话", role: "reviewer", open_id: "ou_real_http_session" };
    writeUsers([row]);
    const issued = sessionFromFeishu(row.open_id, row.name, "tenant_shenmei", "tenant_shenmei");
    loadSessions();

    const first = await app.request("/api/auth/me", {
      headers: { host: "www.jianghua.site", authorization: `Bearer ${issued.token}` },
    });
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { role?: string }).role, "reviewer");

    writeUsers([{ ...row, role: "viewer" }]);
    const downgraded = await app.request("/api/auth/me", {
      headers: { host: "www.jianghua.site", authorization: `Bearer ${issued.token}` },
    });
    assert.equal(downgraded.status, 200);
    assert.equal(((await downgraded.json()) as { role?: string }).role, "viewer");

    writeUsers([{ ...row, role: "viewer", disabled: true }]);
    const disabled = await app.request("/api/auth/me", {
      headers: { host: "www.jianghua.site", authorization: `Bearer ${issued.token}` },
    });
    assert.deepEqual(await disabled.json(), {
      logged_in: false,
      display_name: null,
      avatar_url: null,
      role: null,
      perms: [],
    });
  });

  it("revokes a real session through logout even when users.json is corrupt", async () => {
    const row = { name: "HTTP 退出", role: "reviewer", open_id: "ou_http_logout" };
    writeUsers([row]);
    const issued = sessionFromFeishu(row.open_id, row.name, "tenant_shenmei", "tenant_shenmei");
    writeFileSync(usersPath, "{broken");

    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { host: "www.jianghua.site", authorization: `Bearer ${issued.token}` },
    });
    assert.equal(logout.status, 200);
    writeUsers([row]);

    const me = await app.request("/api/auth/me", {
      headers: { host: "www.jianghua.site", authorization: `Bearer ${issued.token}` },
    });
    assert.equal(((await me.json()) as { logged_in?: boolean }).logged_in, false);
    const persisted = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf8")) as Record<string, unknown>;
    assert.equal(issued.token in persisted, false);
  });

  it("rejects a legacy display session at the public HTTP boundary", async () => {
    const previousPublic = process.env.WB_PUBLIC;
    process.env.WB_PUBLIC = "0";
    writeUsers([{ name: "旧显示名", role: "admin" }]);
    const issued = createDisplaySession("旧显示名", "127.0.0.1:8787");
    process.env.WB_PUBLIC = "1";
    try {
      const me = await app.request("/api/auth/me", {
        headers: { host: "www.jianghua.site", authorization: `Bearer ${issued.token}` },
      });
      assert.equal(((await me.json()) as { logged_in?: boolean }).logged_in, false);
    } finally {
      if (previousPublic === undefined) delete process.env.WB_PUBLIC;
      else process.env.WB_PUBLIC = previousPublic;
    }
  });

  it("applies the Host boundary to SPA cookies and accepts bracketed IPv6 loopback", async () => {
    const previousPublic = process.env.WB_PUBLIC;
    const previousDisplay = process.env.WB_DEV_DISPLAY_LOGIN;
    process.env.WB_PUBLIC = "0";
    process.env.WB_DEV_DISPLAY_LOGIN = "1";
    writeUsers([{ name: "本机显示名", role: "reviewer" }]);
    try {
      const remote = createDisplaySession("本机显示名", "127.0.0.1:8787");
      const rejected = await app.request("/reviewup", {
        headers: { host: "www.jianghua.site", cookie: `${COOKIE}=${remote.token}` },
      });
      assert.equal(rejected.status, 302);
      assert.match(rejected.headers.get("location") || "", /\/api\/auth\/feishu\/login/);

      const local = createDisplaySession("本机显示名", "[::1]:8787");
      const accepted = await app.request("/reviewup", {
        headers: { host: "[::1]:8787", cookie: `${COOKIE}=${local.token}` },
      });
      assert.equal(accepted.status, 200);
    } finally {
      if (previousPublic === undefined) delete process.env.WB_PUBLIC;
      else process.env.WB_PUBLIC = previousPublic;
      if (previousDisplay === undefined) delete process.env.WB_DEV_DISPLAY_LOGIN;
      else process.env.WB_DEV_DISPLAY_LOGIN = previousDisplay;
    }
  });

  it("returns the declared 503 when the display account directory is unreadable", async () => {
    const previousPublic = process.env.WB_PUBLIC;
    process.env.WB_PUBLIC = "0";
    writeFileSync(usersPath, "{broken");
    try {
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { host: "127.0.0.1:8787", "content-type": "application/json" },
        body: JSON.stringify({ display_name: "管理员" }),
      });
      assert.equal(res.status, 503);
      assert.match(await res.text(), /账号目录不可读/);
    } finally {
      if (previousPublic === undefined) delete process.env.WB_PUBLIC;
      else process.env.WB_PUBLIC = previousPublic;
    }
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
    const sess = issueSessionForTest("刘籽烨", "reviewer", "ou_spa_http");
    const res = await app.request("/reviewup", {
      headers: { host: "www.jianghua.site", cookie: `${COOKIE}=${sess.token}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /no-cache/);
  });

  it("keeps desk paths on the same SPA gate", async () => {
    const sess = issueSessionForTest("刘籽烨", "reviewer", "ou_spa_desk");
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
