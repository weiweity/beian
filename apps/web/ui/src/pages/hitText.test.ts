import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { doubtLines, excelText, isImageOnlyField, pdfText } from "./hitText.js";

describe("doubtLines", () => {
  it("lists miss phrases and hides when consistent", () => {
    assert.deepEqual(doubtLines({ status: "一致", coverage: { hit: ["水"] } }), []);
    assert.deepEqual(doubtLines({ status: "疑点", coverage: { miss: ["烟酰胺", ""] } }), ["烟酰胺"]);
    assert.deepEqual(
      doubtLines({ status: "缺失", sequence_diff: { only_in_excel: ["香柠檬"] }, coverage: { miss: ["香柠檬"] } }),
      ["香柠檬"],
    );
    assert.deepEqual(doubtLines({ decision: "issue", evidence: "稿上少了净含量" }), ["稿上少了净含量"]);
    assert.deepEqual(doubtLines({ status: "疑点" }), []);
    assert.deepEqual(doubtLines({ status: "一致", sequence_diff: { only_in_excel: ["香柠檬"] } }), []);
    assert.deepEqual(doubtLines({ status: "疑点", sequence_diff: { only_in_excel: ["香柠檬"] } }), ["香柠檬"]);
    const long = "漏".repeat(140);
    assert.equal(doubtLines({ status: "缺失", evidence: long })[0]?.length, 120);
  });
});

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
  });

  it("lists coverage misses even when no hits", () => {
    assert.match(pdfText({ coverage: { miss: ["香柠檬"] } }), /未在稿上读到：香柠檬/);
  });

  it("lists coverage misses next to hits and the tally", () => {
    assert.match(
      pdfText({ coverage: { hit: ["积雪草"], miss: ["烟酰胺", "水"], matched: 8, total: 36 } }),
      /积雪草[\s\S]*稿上命中 8\/36 项[\s\S]*未在稿上读到：烟酰胺 水/,
    );
  });

  it("explains image-only brand fields", () => {
    assert.match(pdfText({}, "中文品名"), /是图/);
    assert.match(pdfText({}, "品牌logo"), /是图/);
    assert.equal(pdfText({}, "成分"), "没读到");
    assert.equal(isImageOnlyField("中文品名"), true);
    assert.equal(isImageOnlyField("成分"), false);
  });

  it("keeps image note and coverage misses together", () => {
    const text = pdfText({ coverage: { miss: ["香柠檬"] } }, "中文品名");
    assert.match(text, /是图/);
    assert.match(text, /未在稿上读到：香柠檬/);
  });
});
