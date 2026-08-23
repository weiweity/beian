import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, stemFromFilename } from "./stemName.js";

describe("stemFromFilename", () => {
  it("strips pdf and wrapping brackets", () => {
    assert.equal(stemFromFilename("【达肤妍海葡萄油萃微珠保湿喷雾】.pdf"), "达肤妍海葡萄油萃微珠保湿喷雾");
  });

  it("strips ai and leftover punctuation", () => {
    assert.equal(stemFromFilename("花盒-喷雾.ai"), "花盒 喷雾");
  });

  it("keeps a plain chinese stem", () => {
    assert.equal(stemFromFilename("保湿喷雾.xlsx"), "保湿喷雾");
  });

  it("returns empty for blank", () => {
    assert.equal(stemFromFilename("   "), "");
    assert.equal(stemFromFilename(""), "");
  });
});

describe("formatBytes", () => {
  it("uses KB and MB", () => {
    assert.equal(formatBytes(800), "800 B");
    assert.equal(formatBytes(2048), "2 KB");
    assert.equal(formatBytes(1024 * 1024), "1 MB");
  });
});
