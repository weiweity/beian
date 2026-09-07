import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HUD_MS, FULL_UPGRADE_NOTICE, allowFullUpgradeNotice, downloadHudLine, missingPptHud } from "./mockupHud.js";

describe("mockup download hud", () => {
  it("names the file being saved and does not block copy", () => {
    assert.equal(downloadHudLine("白底"), "正在下载白底");
    assert.equal(downloadHudLine("PPT"), "正在下载PPT");
    assert.equal(downloadHudLine("GLB"), "正在下载GLB");
    assert.equal(downloadHudLine("PDF"), "正在下载PDF");
    assert.equal(downloadHudLine("印刷面"), "正在下载印刷面");
    assert.equal(missingPptHud(), "PPT 没写成，白底仍可下");
    assert.equal(FULL_UPGRADE_NOTICE, "高清图暂时未加载，重新打开此单可重试");
    assert.equal(HUD_MS, 2200);
    assert.equal(allowFullUpgradeNotice("", "g1", "auto"), true);
    assert.equal(allowFullUpgradeNotice("g1", "g1", "auto"), false);
    assert.equal(allowFullUpgradeNotice("g1", "g1", "action"), true);
    assert.equal(allowFullUpgradeNotice("g1", "g2", "auto"), true);
  });
});
