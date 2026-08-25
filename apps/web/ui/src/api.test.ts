import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { API_DOWN_LOCAL, API_DOWN_PUBLIC } from "./apiHint.js";
import { ApiError, brokenApiMessage } from "./api.js";
import { UPLOAD_TOO_LARGE } from "./uploadLimit.js";

describe("brokenApiMessage", () => {
  it("uses the flag, not 8787/JSON in the copy", () => {
    const html = new ApiError(403, API_DOWN_PUBLIC, true);
    assert.equal(brokenApiMessage(html, "www.jianghua.site"), API_DOWN_PUBLIC);
    const json404 = new ApiError(404, "没有这张审核单", false);
    assert.equal(brokenApiMessage(json404, "www.jianghua.site"), null);
  });

  it("treats Vite JSON 502 copy as broken even without the flag", () => {
    const vite = new ApiError(502, API_DOWN_LOCAL, true);
    assert.equal(brokenApiMessage(vite, "127.0.0.1:5173"), API_DOWN_LOCAL);
  });

  it("maps a network failure to the host-aware HTML copy", () => {
    assert.equal(brokenApiMessage(new TypeError("Failed to fetch"), "www.jianghua.site"), API_DOWN_PUBLIC);
    assert.match(String(brokenApiMessage(new TypeError("Failed to fetch"), "127.0.0.1:5173")), /8787/);
  });

  it("does not treat a 413 as a dead review service", () => {
    const err = new ApiError(413, UPLOAD_TOO_LARGE, false);
    assert.equal(brokenApiMessage(err, "www.jianghua.site"), null);
  });
});
