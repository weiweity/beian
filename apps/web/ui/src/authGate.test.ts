import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authFailureAction, describeBrokenApi, shouldAutoRedirectToFeishu } from "./authGate.js";

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

  it("does not redirect when already logged in", () => {
    assert.equal(
      shouldAutoRedirectToFeishu({
        pathname: "/",
        loggedIn: true,
        authError: null,
        apiBroken: null,
      }),
      false,
    );
  });

  it("does not redirect when Feishu already returned an error", () => {
    assert.equal(
      shouldAutoRedirectToFeishu({
        pathname: "/",
        loggedIn: false,
        authError: "只允许伸美公司的飞书号进入。",
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

describe("authFailureAction", () => {
  it("sends Feishu auth errors back to Feishu, not localhost", () => {
    assert.deepEqual(
      authFailureAction({ authError: "只允许伸美公司的飞书号进入。", apiBroken: null }),
      { href: "/api/auth/feishu/login", label: "重新飞书授权" },
    );
  });

  it("only points at :8787 when the API proxy is broken", () => {
    assert.deepEqual(
      authFailureAction({
        authError: null,
        apiBroken: "本机开发页没有把 /api 转到审稿服务",
      }),
      { href: "http://127.0.0.1:8787/", label: "打开本机审稿服务" },
    );
  });

  it("still returns to Feishu when both authError and apiBroken are set", () => {
    assert.deepEqual(
      authFailureAction({
        authError: "只允许伸美公司的飞书号进入。",
        apiBroken: "本机开发页没有把 /api 转到审稿服务",
      }),
      { href: "/api/auth/feishu/login", label: "重新飞书授权" },
    );
  });
});

describe("describeBrokenApi", () => {
  it("flags html and empty 404 as a dead vite proxy", () => {
    assert.match(String(describeBrokenApi(200, "text/html")), /8787/);
    assert.match(String(describeBrokenApi(404, "")), /8787/);
    assert.equal(describeBrokenApi(401, "application/json"), null);
  });

  it("does not treat a JSON 404 as a dead vite proxy", () => {
    assert.equal(describeBrokenApi(404, "application/json"), null);
    assert.equal(describeBrokenApi(404, "application/json; charset=utf-8"), null);
  });
});
