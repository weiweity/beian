import assert from "node:assert/strict";
import { dirname, win32 } from "node:path";
import { describe, it } from "node:test";
import { stripLoopbackProxy, UI_BRAND, UI_PUBLIC } from "./config.js";

describe("stripLoopbackProxy", () => {
  it("drops clash on 127.0.0.1 and keeps remote proxy", () => {
    const env: NodeJS.ProcessEnv = {
      https_proxy: "http://127.0.0.1:7897",
      HTTP_PROXY: "http://corp.example:8080",
    };
    const removed = stripLoopbackProxy(env);
    assert.deepEqual(removed, ["https_proxy"]);
    assert.equal(env.https_proxy, undefined);
    assert.equal(env.HTTP_PROXY, "http://corp.example:8080");
  });
});

describe("UI_PUBLIC", () => {
  it("is the parent of UI_BRAND so serveStatic can join /brand/…", () => {
    assert.equal(UI_PUBLIC, dirname(UI_BRAND));
  });

  it("does not rely on POSIX /brand strip (no-op on Windows paths)", () => {
    const brand = win32.join("C:\\repo\\apps\\web", "ui/public/brand");
    assert.equal(brand.replace(/\/brand$/, ""), brand);
    assert.equal(
      win32.join(win32.dirname(brand), "/brand/logo-mark.png"),
      "C:\\repo\\apps\\web\\ui\\public\\brand\\logo-mark.png",
    );
    assert.match(win32.join(brand, "/brand/logo-mark.png"), /brand\\brand\\/);
  });
});
