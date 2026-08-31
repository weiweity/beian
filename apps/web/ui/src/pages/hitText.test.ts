import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coverageTally, doubtLines, excelText, isImageOnlyField, pdfText, spokenAsk, spokenLines } from "./hitText.js";

describe("doubtLines", () => {
  it("does not put score= coverage talk in the issue column", () => {
    const lines = doubtLines({
      status: "疑点",
      evidence: "覆盖偏低 0/5 · best score=40",
      field_group: "净含量",
      excel_value: "30ml",
      bboxes: [{ left: 1, top: 1, width: 10, height: 10 }],
    });
    assert.ok(lines.length);
    assert.doesNotMatch(lines.join(" "), /score=|0\/5|覆盖偏低/);
    assert.match(lines.join(" "), /30ml/);
  });

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

  it("treats pending human confirmation as an issue when evidence explains it", () => {
    assert.deepEqual(
      doubtLines({ status: "待人工确认", evidence: "OCR 没读全，需要人眼确认" }),
      ["OCR 没读全，需要人眼确认"],
    );
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

  it("keeps misses out of OCR text because the issue column owns them", () => {
    assert.equal(pdfText({ coverage: { miss: ["香柠檬"] } }), "没读到");
  });

  it("shows hits without duplicating issue phrases", () => {
    const hit = { coverage: { hit: ["积雪草"], miss: ["烟酰胺", "水"], matched: 8, total: 36 } };
    assert.match(pdfText(hit), /积雪草/);
    assert.doesNotMatch(pdfText(hit), /烟酰胺|未在稿上读到|36 个词里读到/);
    assert.equal(coverageTally(hit), "36 个词里读到 8 个");
  });

  it("does not leak score= or 0/5 into the OCR column", () => {
    assert.equal(pdfText({ evidence: "覆盖偏低 0/5 · best score=40" }), "没读到");
  });

  it("still exposes a zero tally under 查看全部", () => {
    const hit = { coverage: { hit: [], matched: 0, total: 36 } };
    assert.equal(coverageTally(hit), "36 个词里读到 0 个");
  });

  it("explains image-only brand fields", () => {
    assert.match(pdfText({}, "中文品名"), /是图/);
    assert.match(pdfText({}, "品牌logo"), /是图/);
    assert.equal(pdfText({}, "成分"), "没读到");
    assert.equal(isImageOnlyField("中文品名"), true);
    assert.equal(isImageOnlyField("成分"), false);
  });

  it("keeps image note concise and leaves misses to doubtLines", () => {
    const text = pdfText({ coverage: { miss: ["香柠檬"] } }, "中文品名");
    assert.match(text, /是图/);
    assert.doesNotMatch(text, /香柠檬/);
  });
});

describe("spokenAsk", () => {
  it("uses three spoken lines for mixed net and barcode", () => {
    const ask = spokenAsk({
      status: "疑点",
      field: "净含量&条形码",
      field_group: "净含量&条形码",
      excel_value: "30ml",
      bboxes: [{ left: 1, top: 1, width: 10, height: 10 }],
    });
    assert.ok(ask);
    assert.match(ask.lead, /毫升/);
    assert.match(ask.ask, /条码/);
    assert.doesNotMatch(`${ask.lead}${ask.because}${ask.ask}`, /score=|0\/5/);
  });

  it("asks a person to look at the whole face when the box is missing", () => {
    const ask = spokenAsk({ status: "疑点", excel_value: "海葡萄", bboxes: [] }, "文案", false);
    assert.ok(ask);
    assert.match(ask.lead, /没在图上圈到/);
    assert.match(ask.ask, /整面/);
  });

  it("keeps legal smallprint as a doubt, not a miss", () => {
    const lines = spokenLines({
      status: "疑点",
      doubt_bucket: "ocr_smallprint",
      excel_value: "本产品采用的材料来自良好管理的森林",
      bboxes: [{ left: 1, top: 1, width: 8, height: 8 }],
    });
    assert.match(lines.join(" "), /法规小字/);
    assert.doesNotMatch(lines.join(" "), /漏印/);
  });

  it("keeps graphic type as a look-again doubt, not a miss", () => {
    const lines = spokenLines({
      status: "疑点",
      doubt_bucket: "ocr_graphic",
      excel_value: "09",
      bboxes: [{ left: 1, top: 1, width: 8, height: 8 }],
    });
    assert.match(lines.join(" "), /图形字|竖排/);
    assert.doesNotMatch(lines.join(" "), /漏印/);
  });

  it("tells the reviewer the pin may sit on the code, not the guide sentence", () => {
    const ask = spokenAsk({
      status: "疑点",
      field: "二维码",
      field_group: "二维码",
      excel_value: "扫码关注微信工作号",
      bboxes: [{ left: 12, top: 14, width: 100, height: 24 }],
    });
    assert.ok(ask);
    assert.match(`${ask.lead}${ask.because}${ask.ask}`, /引导语|码/);
    assert.doesNotMatch(`${ask.lead}${ask.because}${ask.ask}`, /score=/);
  });
});
