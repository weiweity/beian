import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeBrokenApi, shouldAutoRedirectToFeishu } from "./authGate.js";

describe("shouldAutoRedirectToFeishu", () => {
  it("does not redirect when already on a proxied /api path", () => {
    assert.equal(
      shouldAutoRedirectToFeishu({
        pathname: "/api/auth/feishu/login",
        loggedIn: false,
        authError: null,
        apiBroken: null,
      }),
      false,
    );
  });

  it("redirects from the app root when session is missing", () => {
    assert.equal(
      shouldAutoRedirectToFeishu({
        pathname: "/",
        loggedIn: false,
        authError: null,
        apiBroken: null,
      }),
      true,
    );
  });

  it("stays on the result page when api is not JSON", () => {
    assert.equal(
      shouldAutoRedirectToFeishu({
        pathname: "/",
        loggedIn: false,
        authError: null,
        apiBroken: "本机开发页没有把 /api 转到审稿服务",
      }),
      false,
    );
  });
});

describe("describeBrokenApi", () => {
  it("flags html and empty 404 as a dead vite proxy", () => {
    assert.match(String(describeBrokenApi(200, "text/html")), /8787/);
    assert.match(String(describeBrokenApi(404, "")), /8787/);
    assert.equal(describeBrokenApi(401, "application/json"), null);
  });
});
