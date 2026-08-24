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
    assert.match(text, /刀线/);
    assert.doesNotMatch(text, /只接/);
    assert.doesNotMatch(text, /C:\\/);
    assert.doesNotMatch(text, /1498/);
  });

  it("explains a missing knife layer", () => {
    const text = mockupFailReason("稿里没有刀线或刀版层，也无法匹配已登记刀模。实际画板=[1, 1]");
    assert.match(text, /没有刀线/);
  });

  it("explains a knife layer that does not fold", () => {
    const text = mockupFailReason("刀线读不出结构（刀线没有连续的盒身面）。AI画板尺寸与模板不符");
    assert.match(text, /折不成盒面/);
    assert.doesNotMatch(text, /只接/);
  });

  it("explains a missing Node binary without failing the 3D job", () => {
    const text = mockupFailReason("Node不存在：");
    assert.match(text, /PPT/);
    assert.match(text, /白底/);
    assert.match(text, /PDF/);
    assert.doesNotMatch(text, /刀线/);
  });

  it("explains a missing presentation runtime the same way", () => {
    const text = mockupFailReason("本机没有演示文稿运行时");
    assert.match(text, /PPT/);
    assert.match(text, /PDF/);
    assert.doesNotMatch(text, /刀线/);
  });

  it("strips other Windows paths", () => {
    const text = mockupFailReason("Illustrator 超时，文件=C:\\supply\\data\\mockups\\a.ai");
    assert.doesNotMatch(text, /C:\\/);
    assert.match(text, /Illustrator/);
  });
});
