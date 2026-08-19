import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
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
});
