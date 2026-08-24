import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mockupFailReason, mockupFailTag } from "./mockupError.js";

describe("mockupFailTag", () => {
  it("stays a short board label", () => {
    assert.equal(mockupFailTag(), "打样中断");
  });
});

describe("mockupFailReason", () => {
  it("explains artboard mismatch without a Windows path", () => {
    const raw =
      "AI画板尺寸与模板不符：实际=[1498.67, 1446.0]，模板=[2833.5, 1507.67]，文件=C:\\supply\\data\\mockups\\x.ai";
    const text = mockupFailReason(raw);
    assert.match(text, /花盒/);
    assert.doesNotMatch(text, /C:\\/);
    assert.doesNotMatch(text, /1498/);
  });

  it("strips other Windows paths", () => {
    const text = mockupFailReason("Illustrator 超时，文件=C:\\supply\\data\\mockups\\a.ai");
    assert.doesNotMatch(text, /C:\\/);
    assert.match(text, /Illustrator/);
  });
});
