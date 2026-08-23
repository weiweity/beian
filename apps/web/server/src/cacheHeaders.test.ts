import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASSET_CACHE, BRAND_CACHE, HTML_CACHE, REDIRECT_CACHE, cacheHeaderFor } from "./cacheHeaders.js";

describe("cacheHeaderFor", () => {
  it("does not cache the HTML shell", () => {
    assert.equal(cacheHeaderFor("/"), HTML_CACHE);
    assert.equal(cacheHeaderFor("/index.html"), HTML_CACHE);
  });

  it("immutably caches hashed Vite assets", () => {
    assert.equal(cacheHeaderFor("/assets/index-Bm28QgmE.js"), ASSET_CACHE);
    assert.equal(cacheHeaderFor("/assets/index-Dd6Gnde5.css?v=1"), ASSET_CACHE);
  });

  it("caches brand files for a day", () => {
    assert.equal(cacheHeaderFor("/brand/logo-mark.png"), BRAND_CACHE);
  });

  it("leaves unknown paths alone", () => {
    assert.equal(cacheHeaderFor("/api/health"), undefined);
  });

  it("keeps HTML private and 302s unstoreable", () => {
    assert.match(HTML_CACHE, /private/);
    assert.match(HTML_CACHE, /no-cache/);
    assert.equal(REDIRECT_CACHE, "private, no-store");
    assert.equal(cacheHeaderFor("/redirect"), undefined);
  });
});
