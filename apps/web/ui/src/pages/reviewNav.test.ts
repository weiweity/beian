import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  firstPendingIssueIndex,
  issueOrdinal,
  pageIndexForHit,
  reviewProgress,
} from "./reviewNav.js";

const hits = [
  { id: "f0", field: "品牌", status: "一致", page: 1, decision: "confirm" },
  { id: "f1", field: "中文品名", status: "疑点", page: 2 },
  { id: "f2", field: "净含量", status: "疑点", page: 2, decision: "pending" },
  { id: "f3", field: "文案", status: "缺失", page: 1 },
];

describe("reviewNav", () => {
  it("finds the first pending issue and its page", () => {
    assert.equal(firstPendingIssueIndex(hits), 1);
    assert.equal(pageIndexForHit([{ page: 1 }, { page: 2 }], hits[1]), 1);
    assert.equal(pageIndexForHit([{ page: 1 }], { page: 9 }), null);
  });

  it("numbers pins by doubt order, not Excel row", () => {
    assert.equal(issueOrdinal(hits, 1), 1);
    assert.equal(issueOrdinal(hits, 2), 2);
    assert.equal(issueOrdinal(hits, 3), 3);
    assert.equal(issueOrdinal(hits, 0), 0);
  });

  it("counts remaining issues excluding the current row on this page", () => {
    const progress = reviewProgress(hits, 2, 1);
    assert.equal(progress.jobPending, 3);
    assert.equal(progress.pageLeft, 1);
  });

  it("skips decided issues and returns null when none are pending", () => {
    const rows = [
      { id: "a", status: "疑点", decision: "confirm", page: 1 },
      { id: "b", status: "疑点", decision: "issue", page: 1 },
      { id: "c", status: "缺失", decision: "ignore", page: 2 },
      { id: "d", status: "疑点", page: 2 },
    ];
    assert.equal(firstPendingIssueIndex(rows), 3);
    assert.equal(reviewProgress(rows, 2, 3).jobPending, 1);
    assert.equal(firstPendingIssueIndex(rows.slice(0, 3)), null);
    assert.equal(firstPendingIssueIndex([]), null);
  });
});
