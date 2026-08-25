import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authFailureAction,
  describeBrokenApi,
  feishuLoginHref,
  isLocalDevHost,
  shouldAutoRedirectToFeishu,
} from "./authGate.js";

describe("feishuLoginHref", () => {
  it("keeps root login without next", () => {
    assert.equal(feishuLoginHref("/"), "/api/auth/feishu/login");
    assert.equal(feishuLoginHref("/reviewup"), "/api/auth/feishu/login");
    assert.equal(feishuLoginHref("/api/auth/feishu/login"), "/api/auth/feishu/login");
    assert.equal(feishuLoginHref("https://evil.example/"), "/api/auth/feishu/login");
  });

  it("passes a desk path as next", () => {
    assert.equal(
      feishuLoginHref("/mockup/aabbccddeeff"),
      "/api/auth/feishu/login?next=%2Fmockup%2Faabbccddeeff",
    );
    assert.equal(
      feishuLoginHref("/review/aabbccddeeff/"),
      "/api/auth/feishu/login?next=%2Freview%2Faabbccddeeff",
    );
    assert.equal(
      feishuLoginHref("/reviewup/new"),
      "/api/auth/feishu/login?next=%2Freviewup%2Fnew",
    );
    assert.equal(feishuLoginHref("/foo"), "/api/auth/feishu/login");
  });
});

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
        host: "127.0.0.1:5173",
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

  it("does not send a public visitor to localhost", () => {
    assert.deepEqual(
      authFailureAction({
        authError: null,
        apiBroken: "审稿服务没回上。刷新后再试。",
        host: "www.jianghua.site",
        pathname: "/mockup",
      }),
      { href: "/mockup", label: "刷新后再试" },
    );
    assert.deepEqual(
      authFailureAction({
        authError: null,
        apiBroken: "审稿服务没回上。刷新后再试。",
        host: "www.jianghua.site",
        pathname: "//evil",
      }),
      { href: "/reviewup", label: "刷新后再试" },
    );
  });
});

describe("isLocalDevHost", () => {
  it("treats loopback and Vite as local, public hosts as not", () => {
    assert.equal(isLocalDevHost("localhost:5173"), true);
    assert.equal(isLocalDevHost("127.0.0.1:8787"), true);
    assert.equal(isLocalDevHost("192.168.1.8:5173"), true);
    assert.equal(isLocalDevHost("[::1]:8787"), true);
    assert.equal(isLocalDevHost(""), true);
    assert.equal(isLocalDevHost("www.jianghua.site"), false);
    assert.equal(isLocalDevHost("notlocalhost.com"), false);
    assert.equal(isLocalDevHost("127.0.0.1.sslip.io"), false);
  });
});

describe("describeBrokenApi", () => {
  it("flags html and empty 404 as a dead vite proxy", () => {
    assert.match(String(describeBrokenApi(200, "text/html")), /8787/);
    assert.match(String(describeBrokenApi(404, "")), /8787/);
    assert.equal(describeBrokenApi(401, "application/json"), null);
    assert.match(String(describeBrokenApi(502, "text/html", "127.0.0.1:5173")), /不要只用 Vite/);
  });

  it("does not treat a JSON 404 as a dead vite proxy", () => {
    assert.equal(describeBrokenApi(404, "application/json"), null);
    assert.equal(describeBrokenApi(404, "application/json; charset=utf-8"), null);
  });

  it("does not tell a public visitor to open Vite", () => {
    const line = String(describeBrokenApi(403, "text/html", "www.jianghua.site"));
    assert.match(line, /审稿服务没回上/);
    assert.doesNotMatch(line, /5173/);
    assert.doesNotMatch(line, /dev:ui/);
  });

  it("leaves non-html bodies to the JSON/detail path", () => {
    assert.equal(describeBrokenApi(502, "text/plain"), null);
  });

  it("does not treat a Cloudflare 413 HTML page as a dead API", () => {
    assert.equal(describeBrokenApi(413, "text/html", "www.jianghua.site"), null);
  });
});
