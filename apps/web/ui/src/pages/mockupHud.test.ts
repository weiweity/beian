import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HUD_MS, downloadHudLine, missingPptHud } from "./mockupHud.js";

describe("mockup download hud", () => {
  it("names the file being saved and does not block copy", () => {
    assert.equal(downloadHudLine("白底"), "正在下载白底");
    assert.equal(downloadHudLine("PPT"), "正在下载PPT");
    assert.equal(downloadHudLine("GLB"), "正在下载GLB");
    assert.equal(downloadHudLine("PDF"), "正在下载PDF");
    assert.equal(missingPptHud(), "PPT 没写成，白底仍可下");
    assert.equal(HUD_MS, 2200);
  });
});
