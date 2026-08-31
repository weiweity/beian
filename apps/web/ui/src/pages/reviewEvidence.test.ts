import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRevisionList,
  compactEvidence,
  issueEvidence,
  partitionReviewHits,
  reviewEvidence,
  withLocalNotes,
} from "./reviewEvidence.js";

describe("compactEvidence", () => {
  it("keeps short evidence directly readable", () => {
    assert.deepEqual(compactEvidence("净含量 30ml"), {
      summary: "净含量 30ml",
      full: "净含量 30ml",
      expandable: false,
    });
  });

  it("summarizes long clauses without discarding the full audit text", () => {
    const full = Array.from({ length: 30 }, (_, i) => `条款${i + 1}`).join("；");
    const result = compactEvidence(full, 48);
    assert.equal(result.expandable, true);
    assert.ok(result.summary.length <= 49);
    assert.equal(result.full, full);
  });

  it("keeps a long issue list concise while preserving every phrase", () => {
    const lines = Array.from({ length: 24 }, (_, i) => `缺少条款${i + 1}`);
    const result = issueEvidence(lines);
    assert.equal(result.expandable, true);
    assert.ok(result.summary.length <= 181);
    assert.equal(result.full, lines.join("\n"));
  });
});

describe("partitionReviewHits", () => {
  it("puts actionable doubts first and keeps original indices for canvas picking", () => {
    const result = partitionReviewHits([
      { id: "ok", field: "品牌", status: "一致" },
      { id: "missing", field: "英文品名", status: "缺失" },
      { id: "manual", field: "净含量", status: "一致", decision: "issue" },
    ]);

    assert.deepEqual(result.issues.map(({ hit, index }) => [hit.id, index]), [
      ["missing", 1],
      ["manual", 2],
    ]);
    assert.deepEqual(result.consistent.map(({ hit, index }) => [hit.id, index]), [["ok", 0]]);
  });

  it("treats concrete coverage misses as issues even when the coarse status says consistent", () => {
    const result = partitionReviewHits([
      {
        id: "coverage-miss",
        field: "英文品名",
        status: "一致",
        coverage: { hit: ["SEA GRAPE"], miss: ["CAPSULE MIST"], matched: 1, total: 2 },
      },
    ]);

    assert.deepEqual(result.issues.map(({ hit, index }) => [hit.id, index]), [["coverage-miss", 0]]);
    assert.equal(result.consistent.length, 0);
  });
});

describe("reviewEvidence", () => {
  it("separates missing phrases from observed OCR", () => {
    const evidence = reviewEvidence({
      field: "文案",
      status: "疑点",
      excel_value: "保湿亮泽",
      coverage: { hit: ["保湿"], miss: ["亮泽"], matched: 1, total: 2 },
    });
    assert.deepEqual(evidence.issues, ["亮泽"]);
    assert.match(evidence.observed.full, /保湿/);
    assert.doesNotMatch(evidence.observed.full, /亮泽/);
  });

  it("hides the word tally until 查看全部", () => {
    const evidence = reviewEvidence({
      field: "文案",
      status: "疑点",
      coverage: { hit: ["保湿"], miss: ["亮泽"], matched: 8, total: 36 },
    });
    assert.doesNotMatch(evidence.observed.summary, /36 个词里读到/);
    assert.match(evidence.observed.full, /36 个词里读到 8 个/);
    assert.equal(evidence.observed.expandable, true);
  });

  it("keeps concrete missing phrases in the copied revision list", () => {
    const result = buildRevisionList("海葡萄喷雾", [
      {
        id: "copy-issue",
        field: "文案",
        status: "疑点",
        decision: "issue",
        excel_value: "保湿亮泽",
        page: 1,
        coverage: { hit: ["保湿"], miss: ["亮泽"], matched: 1, total: 2 },
      },
    ]);

    assert.equal(result.count, 1);
    assert.match(result.text, /稿上：保湿/);
    assert.match(result.text, /没读到：亮泽/);
    assert.doesNotMatch(result.text, /score=|0\/5|覆盖偏低/);
  });

  it("does not copy accounting coverage talk", () => {
    const result = buildRevisionList("海葡萄喷雾", [
      {
        id: "copy-issue",
        field: "净含量",
        field_group: "净含量",
        status: "疑点",
        decision: "issue",
        excel_value: "30ml",
        evidence: "覆盖偏低 0/5 · best score=40",
        bboxes: [{ left: 1, top: 1, width: 10, height: 10 }],
      },
    ]);
    assert.doesNotMatch(result.text, /score=|0\/5|覆盖偏低/);
    assert.match(result.text, /30ml/);
  });

  it("copies the latest local note even before its server response returns", () => {
    const hits = withLocalNotes(
      [{ id: "copy-issue", field: "文案", decision: "issue", note: "旧备注" }],
      { "copy-issue": "刚输入的新备注" },
    );
    const result = buildRevisionList("海葡萄喷雾", hits);

    assert.match(result.text, /刚输入的新备注/);
    assert.doesNotMatch(result.text, /旧备注/);
  });
});
