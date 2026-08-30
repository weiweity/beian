import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-auth-");
process.env.FEISHU_APP_ID = "cli_test_app";
process.env.FEISHU_APP_SECRET = "test-secret";

const auth = await import("./auth.js");

describe("feishu authorize", () => {
  it("prunes expired sessions from memory and disk when issuing a new session", (t) => {
    let at = Date.now();
    t.mock.method(Date, "now", () => at);
    const expired = auth.issueSessionForTest("旧会话", "reviewer", "ou_expired_session");

    at += 7 * 24 * 3600 * 1000;
    const fresh = auth.issueSessionForTest("新会话", "reviewer", "ou_fresh_session");
    const persisted = JSON.parse(
      readFileSync(join(process.env.WB_DATA_DIR as string, "sessions.json"), "utf8"),
    ) as Record<string, unknown>;

    assert.equal(auth.getSession(expired.token), null);
    assert.equal(auth.getSession(fresh.token)?.display_name, "新会话");
    assert.equal(expired.token in persisted, false);
    assert.equal(fresh.token in persisted, true);
  });

  it("getSession directly removes an expired session from memory and disk", (t) => {
    let at = Date.now();
    t.mock.method(Date, "now", () => at);
    const expired = auth.issueSessionForTest("直接过期", "reviewer", "ou_direct_expiry");

    at = expired.expires_at * 1000;
    assert.equal(auth.getSession(expired.token), null);
    const persisted = JSON.parse(
      readFileSync(join(process.env.WB_DATA_DIR as string, "sessions.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(expired.token in persisted, false);

    // 时间回拨后仍取不到，证明不是每次临时判断过期，而是已经从内存删除。
    at = expired.created_at * 1000;
    assert.equal(auth.getSession(expired.token), null);
  });

  it("omits contact user.base scope and includes PKCE S256", () => {
    const { state, challenge } = auth.beginOAuth();
    const url = auth.authorizeUrl("https://www.jianghua.site/api/auth/feishu/callback", state, challenge);
    assert.match(url, /^https:\/\/accounts\.feishu\.cn\/open-apis\/authen\/v1\/authorize\?/);
    assert.equal(url.includes("contact:user.base"), false);
    assert.equal(url.includes("scope="), false);
    assert.match(url, /response_type=code/);
    assert.match(url, /code_challenge_method=S256/);
    assert.match(url, /code_challenge=/);
    assert.ok(state.length > 8);
    assert.ok(challenge.length > 8);
    assert.ok(auth.consumeOAuthState(state));
  });

  it("consumes state once and returns verifier", () => {
    const { state, challenge } = auth.beginOAuth();
    const expected = createHash("sha256");
    const verifier = auth.consumeOAuthState(state);
    assert.ok(verifier);
    expected.update(verifier);
    assert.equal(expected.digest("base64url"), challenge);
    assert.equal(auth.consumeOAuthState(state), null);
  });

  it("unknown state is null", () => {
    assert.equal(auth.consumeOAuthState("nope"), null);
  });

  it("sanitizeNext only allows same-origin relative paths", () => {
    assert.equal(auth.sanitizeNext("/?tab=settings&group=开工板"), "/?tab=settings&group=开工板");
    assert.equal(auth.sanitizeNext("https://evil.example/"), "/");
    assert.equal(auth.sanitizeNext("//evil.example"), "/");
    assert.equal(auth.sanitizeNext("ok"), "/");
    assert.equal(auth.sanitizeNext("/api/tasks"), "/");
    assert.equal(auth.sanitizeNext("/review/aabbccddeeff"), "/review/aabbccddeeff");
    assert.equal(auth.sanitizeNext("/reviewup/new"), "/reviewup/new");
    assert.equal(auth.sanitizeNext("/\r\nLocation: https://evil.example"), "/");
  });

  it("beginOAuth stores next and consumeOAuth returns it once", () => {
    const { state } = auth.beginOAuth("/?tab=settings&group=开工板");
    const row = auth.consumeOAuth(state);
    assert.ok(row);
    assert.equal(row.next, "/?tab=settings&group=开工板");
    assert.equal(auth.consumeOAuth(state), null);
  });

  it("caps pending OAuth states at 1024 and admits a new login after expiry", (t) => {
    let at = Date.now();
    t.mock.method(Date, "now", () => at);
    try {
      for (let i = 0; i < auth.OAUTH_STATE_LIMIT; i++) auth.beginOAuth(`/review/${i}`);
      assert.throws(
        () => auth.beginOAuth("/reviewup"),
        (err: unknown) => {
          const e = err as Error & { status?: number };
          assert.equal(e.status, 429);
          assert.match(e.message, /登录请求太多/);
          return true;
        },
      );

      at += 600_001;
      const fresh = auth.beginOAuth("/reviewup");
      assert.ok(auth.consumeOAuthState(fresh.state));
    } finally {
      // 即使断言失败，也把本测试创建的临时 state 清掉，避免污染后续用例。
      at += 600_001;
      auth.consumeOAuthState("cleanup");
    }
  });

  it("rejects a state at its exact expiry boundary", (t) => {
    let at = Date.now();
    t.mock.method(Date, "now", () => at);
    const { state } = auth.beginOAuth("/reviewup");
    at += 600_000;
    assert.equal(auth.consumeOAuthState(state), null);
  });

  it("display login stays on loopback only", () => {
    assert.equal(auth.displayLoginAllowed("www.jianghua.site"), false);
    assert.equal(auth.displayLoginAllowed("localhost:8787"), true);
    assert.equal(auth.displayLoginAllowed("[::1]:8787"), true);
    assert.equal(auth.displayLoginAllowed("[::1]not-a-port"), false);
  });

  it("rejects other Feishu tenants when 伸美 tenant_key is set", () => {
    process.env.FEISHU_TENANT_KEY = "tenant_shenmei";
    try {
      auth.sessionFromFeishu("ou_stranger_xxxx", "路人", "tenant_other", "tenant_shenmei");
      assert.fail("should throw");
    } catch (e) {
      const err = e as Error & { status?: number };
      assert.equal(err.status, 403);
      assert.match(err.message, /伸美/);
    } finally {
      delete process.env.FEISHU_TENANT_KEY;
    }
  });

  it("maps proxy cert fetch failed to Chinese", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "SELF_SIGNED_CERT_IN_CHAIN", message: "self-signed certificate in certificate chain" },
    });
    assert.match(auth.describeOutboundError(err), /直连/);
  });

  it("missing account throws 403 without needing live feishu", () => {
    try {
      auth.sessionFromFeishu("ou_stranger_xxxx", "路人");
      assert.fail("should throw");
    } catch (e) {
      const err = e as Error & { status?: number };
      assert.equal(err.status, 403);
      assert.match(err.message, /账号目录/);
    }
  });

  it("picks configured tenant before api or user", () => {
    assert.equal(auth.pickAllowedTenant("cfg", "api", "user"), "cfg");
    assert.equal(auth.pickAllowedTenant("", "api", "user"), "api");
    assert.equal(auth.pickAllowedTenant("", "", "user"), "user");
    assert.equal(auth.pickAllowedTenant("  ", "  ", ""), "");
  });

  it("provisions 伸美 user when tenant matches and allow-list is empty", () => {
    const sess = auth.sessionFromFeishu(
      "ou_brand_account_xxxx",
      "伸美品牌",
      "tenant_shenmei",
      "tenant_shenmei",
      { provision: true },
    );
    assert.equal(sess.display_name, "伸美品牌");
    assert.equal(sess.role, "reviewer");
    assert.equal(sess.open_id, "ou_brand_account_xxxx");
  });

  it("formats 花名（真名） and keeps a single name bare", () => {
    assert.equal(auth.formatAccountLabel("魏炜", "天元"), "天元（魏炜）");
    assert.equal(auth.formatAccountLabel("天元", ""), "天元");
    assert.equal(auth.formatAccountLabel("天元", "天元"), "天元");
    assert.equal(auth.formatAccountLabel("", ""), "飞书用户");
  });

  it("uses Feishu nickname in session display, keeps avatar, and never promotes by name", () => {
    const sess = auth.sessionFromFeishu(
      "ou_tianyuan_xxxx",
      "魏炜",
      "tenant_shenmei",
      "tenant_shenmei",
      { provision: true, nickname: "天元", avatar_url: "https://img.example/a.png" },
    );
    assert.equal(sess.display_name, "天元（魏炜）");
    assert.equal(sess.avatar_url, "https://img.example/a.png");
    assert.equal(sess.role, "reviewer");
  });

  it("takes admin only from the exact open_id account binding", () => {
    const dir = process.env.WB_DATA_DIR as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify({
        users: [
          { name: "魏炜", role: "admin", open_id: "ou_weiwei_explicit" },
          { name: "魏炜", role: "reviewer", open_id: "ou_same_name_reviewer" },
        ],
      }) + "\n",
    );
    const admin = auth.sessionFromFeishu(
      "ou_weiwei_explicit",
      "任意飞书姓名",
      "tenant_shenmei",
      "tenant_shenmei",
    );
    const reviewer = auth.sessionFromFeishu(
      "ou_same_name_reviewer",
      "魏炜",
      "tenant_shenmei",
      "tenant_shenmei",
    );
    assert.equal(admin.role, "admin");
    assert.equal(reviewer.role, "reviewer");
  });

  it("syncs an account role change onto an already-issued Feishu session", () => {
    const dir = process.env.WB_DATA_DIR as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify({
        users: [{ name: "审核员", role: "reviewer", open_id: "ou_role_sync" }],
      }) + "\n",
    );
    const issued = auth.sessionFromFeishu("ou_role_sync", "审核员", "tenant_shenmei", "tenant_shenmei");
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify({
        users: [{ name: "审核员", role: "viewer", open_id: "ou_role_sync" }],
      }) + "\n",
    );
    const sess = auth.getSession(issued.token);
    assert.equal(sess?.role, "viewer");
  });

  it("revokes a Feishu session immediately when its account is removed", () => {
    const dir = process.env.WB_DATA_DIR as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify({
        users: [{ name: "待移除", role: "reviewer", open_id: "ou_removed_now" }],
      }) + "\n",
    );
    const issued = auth.sessionFromFeishu(
      "ou_removed_now",
      "待移除",
      "tenant_shenmei",
      "tenant_shenmei",
    );
    writeFileSync(join(dir, "users.json"), JSON.stringify({ users: [] }) + "\n");

    assert.equal(auth.getSession(issued.token), null);
    const persisted = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as Record<string, unknown>;
    assert.equal(issued.token in persisted, false);
  });

  it("revokes a Feishu session when the account is disabled", () => {
    const dir = process.env.WB_DATA_DIR as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify({
        users: [{ name: "停用账号", role: "reviewer", open_id: "ou_disabled_now" }],
      }) + "\n",
    );
    const issued = auth.sessionFromFeishu(
      "ou_disabled_now",
      "停用账号",
      "tenant_shenmei",
      "tenant_shenmei",
    );
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify({
        users: [{ name: "停用账号", role: "reviewer", open_id: "ou_disabled_now", disabled: true }],
      }) + "\n",
    );
    assert.equal(auth.getSession(issued.token), null);
  });

  it("fails closed when an open_id is duplicated", () => {
    const dir = process.env.WB_DATA_DIR as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify({
        users: [
          { name: "配置甲", role: "admin", open_id: "ou_duplicate" },
          { name: "配置乙", role: "reviewer", open_id: "ou_duplicate" },
        ],
      }) + "\n",
    );
    assert.throws(
      () => auth.sessionFromFeishu("ou_duplicate", "配置甲", "tenant_shenmei", "tenant_shenmei"),
      /重复 open_id/,
    );
  });

  it("rejects inherited object-property names as account roles", () => {
    const dir = process.env.WB_DATA_DIR as string;
    const usersPath = join(dir, "users.json");
    for (const [index, role] of ["toString", "constructor", "__proto__"].entries()) {
      const openId = `ou_invalid_role_${index}`;
      writeFileSync(
        usersPath,
        JSON.stringify({ users: [{ name: `非法角色${index}`, role, open_id: openId }] }) + "\n",
      );
      assert.throws(
        () => auth.sessionFromFeishu(openId, `非法角色${index}`, "tenant_shenmei", "tenant_shenmei"),
        (error: unknown) => {
          assert.ok(error instanceof auth.AuthBoundaryError);
          assert.equal(error.status, 503);
          assert.match(error.message, /角色配置无效/);
          return true;
        },
      );
    }
  });

  it("drops an inherited object-property role from persisted sessions", () => {
    const dir = process.env.WB_DATA_DIR as string;
    const token = "persisted-invalid-role";
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify({
        [token]: {
          token,
          display_name: "非法持久会话",
          role: "constructor",
          open_id: "ou_invalid_persisted_role",
          source: "feishu",
          avatar_url: "",
          created_at: Date.now() / 1000,
          expires_at: Date.now() / 1000 + 3600,
        },
      }),
    );
    auth.loadSessions();
    assert.equal(auth.getSession(token), null);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")), {});
  });

  it("drops every malformed persisted session identity field", () => {
    const dir = process.env.WB_DATA_DIR as string;
    const sessionsPath = join(dir, "sessions.json");
    const now = Date.now() / 1000;
    const valid = {
      token: "persisted-shape",
      display_name: "持久会话",
      role: "reviewer",
      open_id: "ou_persisted_shape",
      source: "feishu",
      avatar_url: "",
      created_at: now,
      expires_at: now + 3600,
    };
    const malformed: Array<[string, Record<string, unknown>]> = [
      ["token 与键不一致", { token: "different-token" }],
      ["来源非法", { source: "test" }],
      ["显示名不是字符串", { display_name: 42 }],
      ["open_id 不是字符串", { open_id: null }],
      ["头像不是字符串", { avatar_url: 42 }],
      ["创建时间不是数字", { created_at: String(now) }],
      ["过期时间不是数字", { expires_at: String(now + 3600) }],
    ];

    for (const [label, patch] of malformed) {
      writeFileSync(sessionsPath, JSON.stringify({ [valid.token]: { ...valid, ...patch } }));
      auth.loadSessions();
      assert.equal(auth.getSession(valid.token), null, label);
      assert.deepEqual(JSON.parse(readFileSync(sessionsPath, "utf8")), {}, label);
    }
  });

  it("maps only safe authorization failures to the Feishu forbidden result", () => {
    assert.equal(auth.loginFailureCode(new auth.AuthBoundaryError("账号已停用", 403)), "forbidden");
    assert.equal(auth.loginFailureCode(new auth.AuthBoundaryError("目录损坏", 503)), "failed");
    assert.equal(auth.loginFailureCode(new Error("上游超时")), "failed");
  });

  it("fails closed on an unreadable directory without erasing a recoverable session", () => {
    const dir = process.env.WB_DATA_DIR as string;
    const usersPath = join(dir, "users.json");
    const row = { name: "可恢复账号", role: "reviewer", open_id: "ou_directory_repair" };
    mkdirSync(dir, { recursive: true });
    writeFileSync(usersPath, JSON.stringify({ users: [row] }) + "\n");
    const issued = auth.sessionFromFeishu(
      "ou_directory_repair",
      "可恢复账号",
      "tenant_shenmei",
      "tenant_shenmei",
    );

    writeFileSync(usersPath, "{broken");
    assert.equal(auth.getSession(issued.token), null);
    const persisted = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as Record<string, unknown>;
    assert.equal(issued.token in persisted, true);

    writeFileSync(usersPath, JSON.stringify({ users: [row] }) + "\n");
    assert.equal(auth.getSession(issued.token)?.role, "reviewer");
  });

  it("logout revokes a token even while the account directory is unreadable", () => {
    const dir = process.env.WB_DATA_DIR as string;
    const usersPath = join(dir, "users.json");
    const row = { name: "退出账号", role: "reviewer", open_id: "ou_logout_broken_directory" };
    writeFileSync(usersPath, JSON.stringify({ users: [row] }) + "\n");
    const issued = auth.sessionFromFeishu(
      row.open_id,
      row.name,
      "tenant_shenmei",
      "tenant_shenmei",
    );

    writeFileSync(usersPath, "{broken");
    auth.logout(`Bearer ${issued.token}`);
    writeFileSync(usersPath, JSON.stringify({ users: [row] }) + "\n");

    assert.equal(auth.getSession(issued.token), null);
    const persisted = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as Record<string, unknown>;
    assert.equal(issued.token in persisted, false);
  });

  it("removes persisted display sessions when public mode is enabled", () => {
    const dir = process.env.WB_DATA_DIR as string;
    const usersPath = join(dir, "users.json");
    const previousPublic = process.env.WB_PUBLIC;
    process.env.WB_PUBLIC = "0";
    writeFileSync(
      usersPath,
      JSON.stringify({ users: [{ name: "旧本机会话", role: "admin" }] }) + "\n",
    );
    const issued = auth.createDisplaySession("旧本机会话", "127.0.0.1:8787");
    process.env.WB_PUBLIC = "1";
    try {
      auth.loadSessions();
      assert.equal(auth.getSession(issued.token, "127.0.0.1:8787"), null);
      const persisted = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as Record<string, unknown>;
      assert.equal(issued.token in persisted, false);
    } finally {
      if (previousPublic === undefined) delete process.env.WB_PUBLIC;
      else process.env.WB_PUBLIC = previousPublic;
    }
  });

  it("removes persisted display sessions when display login is disabled", () => {
    const dir = process.env.WB_DATA_DIR as string;
    const usersPath = join(dir, "users.json");
    const previousPublic = process.env.WB_PUBLIC;
    const previousDisplay = process.env.WB_DEV_DISPLAY_LOGIN;
    process.env.WB_PUBLIC = "0";
    process.env.WB_DEV_DISPLAY_LOGIN = "1";
    writeFileSync(
      usersPath,
      JSON.stringify({ users: [{ name: "关闭显示名", role: "reviewer" }] }) + "\n",
    );
    const issued = auth.createDisplaySession("关闭显示名", "127.0.0.1:8787");
    process.env.WB_DEV_DISPLAY_LOGIN = "0";
    try {
      auth.loadSessions();
      assert.equal(auth.getSession(issued.token, "127.0.0.1:8787"), null);
      const persisted = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as Record<string, unknown>;
      assert.equal(issued.token in persisted, false);
    } finally {
      if (previousPublic === undefined) delete process.env.WB_PUBLIC;
      else process.env.WB_PUBLIC = previousPublic;
      if (previousDisplay === undefined) delete process.env.WB_DEV_DISPLAY_LOGIN;
      else process.env.WB_DEV_DISPLAY_LOGIN = previousDisplay;
    }
  });

  it("revokes a display session when it is presented on a non-loopback host", () => {
    const dir = process.env.WB_DATA_DIR as string;
    const usersPath = join(dir, "users.json");
    const previousPublic = process.env.WB_PUBLIC;
    process.env.WB_PUBLIC = "0";
    try {
      writeFileSync(
        usersPath,
        JSON.stringify({ users: [{ name: "仅限本机", role: "reviewer" }] }) + "\n",
      );
      const issued = auth.createDisplaySession("仅限本机", "127.0.0.1:8787");
      assert.equal(auth.getSession(issued.token, "www.jianghua.site"), null);
    } finally {
      if (previousPublic === undefined) delete process.env.WB_PUBLIC;
      else process.env.WB_PUBLIC = previousPublic;
    }
  });

  it("revokes a loopback display session when its local account is disabled", () => {
    const dir = process.env.WB_DATA_DIR as string;
    const usersPath = join(dir, "users.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      usersPath,
      JSON.stringify({ users: [{ name: "本机账号", role: "admin" }] }) + "\n",
    );
    const issued = auth.createDisplaySession("本机账号", "127.0.0.1:8787");
    writeFileSync(
      usersPath,
      JSON.stringify({ users: [{ name: "本机账号", role: "admin", disabled: true }] }) + "\n",
    );
    assert.equal(auth.getSession(issued.token), null);
  });

  it("uses display-name-specific account errors", () => {
    const dir = process.env.WB_DATA_DIR as string;
    const usersPath = join(dir, "users.json");
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          { name: "重名", role: "admin" },
          { name: "重名", role: "reviewer" },
        ],
      }) + "\n",
    );
    assert.throws(
      () => auth.createDisplaySession("重名", "127.0.0.1:8787"),
      (error: unknown) => {
        assert.ok(error instanceof auth.AuthBoundaryError);
        assert.equal(error.status, 503);
        assert.match(error.message, /重复显示名/);
        assert.doesNotMatch(error.message, /open_id/);
        return true;
      },
    );
  });

  it("never restores test fixture sessions from disk", () => {
    const issued = auth.issueSessionForTest("测试账号", "admin", "ou_test_fixture");
    auth.loadSessions();
    assert.equal(auth.getSession(issued.token), null);
  });
});
