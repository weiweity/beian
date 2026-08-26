import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { skipPackSheetField } from "./sheetSkip.js";

describe("sheetSkip", () => {
  it("skips only named process rows at the field prefix", () => {
    assert.equal(skipPackSheetField("工艺说明"), true);
    assert.equal(skipPackSheetField("颜色要求"), true);
    assert.equal(skipPackSheetField("版本号"), true);
    assert.equal(skipPackSheetField("更新内容：调整净含量"), true);
    assert.equal(skipPackSheetField("备案版本号"), false);
    assert.equal(skipPackSheetField("执行标准版本号"), false);
    assert.equal(skipPackSheetField("中文品名"), false);
  });
});
