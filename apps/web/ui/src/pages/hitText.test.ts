import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { excelText, pdfText } from "./hitText.js";

describe("excelText", () => {
  it("prefers excel then excel_value", () => {
    assert.equal(excelText({ excel_value: "应印" }), "应印");
    assert.equal(excelText({ excel: "A", excel_value: "B" }), "A");
    assert.equal(excelText({ expected: "应印" }), "应印");
    assert.equal(excelText({ excel: "  ", excel_value: "真值" }), "真值");
    assert.equal(excelText({}), "—");
  });
});

describe("pdfText", () => {
  it("uses pdf or found first", () => {
    assert.equal(pdfText({ pdf: "稿上" }), "稿上");
    assert.equal(pdfText({ found: "OCR" }), "OCR");
    assert.equal(pdfText({ pdf: "稿上", coverage: { hit: ["别的"] } }), "稿上");
    assert.equal(pdfText({ pdf: "  ", found: "OCR" }), "OCR");
  });

  it("falls back to coverage hits then evidence", () => {
    assert.equal(pdfText({ coverage: { hit: ["净含量", "50ml"] } }), "净含量 50ml");
    assert.equal(pdfText({ evidence: "命中「保湿」" }), "命中「保湿」");
  });

  it("says 没读到 when OCR is empty", () => {
    assert.equal(pdfText({}), "没读到");
    assert.equal(pdfText({ coverage: { miss: ["香柠檬"] } }), "没读到");
  });
});
