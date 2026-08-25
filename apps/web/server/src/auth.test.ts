import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-auth-"));
process.env.FEISHU_APP_ID = "cli_test_app";
process.env.FEISHU_APP_SECRET = "test-secret";

const auth = await import("./auth.js");

describe("feishu authorize", () => {
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

  it("display login stays on loopback only", () => {
    assert.equal(auth.displayLoginAllowed("www.jianghua.site"), false);
    assert.equal(auth.displayLoginAllowed("localhost:8787"), true);
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

  it("whitelist miss throws 403 without needing live feishu", () => {
    try {
      auth.sessionFromFeishu("ou_stranger_xxxx", "路人");
      assert.fail("should throw");
    } catch (e) {
      const err = e as Error & { status?: number };
      assert.equal(err.status, 403);
      assert.match(err.message, /白名单/);
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

  it("uses Feishu nickname in session display and keeps avatar", () => {
    const sess = auth.sessionFromFeishu(
      "ou_tianyuan_xxxx",
      "魏炜",
      "tenant_shenmei",
      "tenant_shenmei",
      { provision: true, nickname: "天元", avatar_url: "https://img.example/a.png" },
    );
    assert.equal(sess.display_name, "天元（魏炜）");
    assert.equal(sess.avatar_url, "https://img.example/a.png");
    assert.equal(sess.role, "admin");
  });

  it("promotes 魏炜 to admin even if users.json still says reviewer", () => {
    const dir = process.env.WB_DATA_DIR as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify({
        users: [{ name: "魏炜", role: "reviewer", open_id: "ou_weiwei_old" }],
      }) + "\n",
    );
    const sess = auth.sessionFromFeishu("ou_weiwei_old", "魏炜", "tenant_shenmei", "tenant_shenmei");
    assert.equal(sess.role, "admin");
    const again = auth.getSession(sess.token);
    assert.equal(again?.role, "admin");
  });

  it("syncs 魏炜 admin onto an already-issued reviewer session", () => {
    const issued = auth.issueSession("天元（魏炜）", "reviewer", "ou_weiwei_sync", "feishu");
    const dir = process.env.WB_DATA_DIR as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify({
        users: [{ name: "魏炜", role: "reviewer", open_id: "ou_weiwei_sync" }],
      }) + "\n",
    );
    const sess = auth.getSession(issued.token);
    assert.equal(sess?.role, "admin");
  });

  it("does not grant admin by Feishu display name", () => {
    const dir = process.env.WB_DATA_DIR as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify({
        users: [{ name: "管理员", role: "admin", open_id: "", note: "可备份/管理" }],
      }) + "\n",
    );
    const sess = auth.sessionFromFeishu(
      "ou_named_admin_xx",
      "管理员",
      "tenant_shenmei",
      "tenant_shenmei",
      { provision: true },
    );
    assert.equal(sess.role, "reviewer");
    assert.equal(sess.open_id, "ou_named_admin_xx");
  });

  it("isWeiWei matches legal or nickname 魏炜 only", () => {
    assert.equal(auth.isWeiWei("魏炜", "天元"), true);
    assert.equal(auth.isWeiWei("刘籽烨", "天元"), false);
    assert.equal(auth.isWeiWei("管理员", ""), false);
    assert.equal(auth.isWeiWei("伸美品牌", "魏炜"), true);
  });
});
