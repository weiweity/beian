import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  forgetMockupHandoff,
  forgetReviewHandoff,
  mockupHandoffFor,
  rememberMockupHandoff,
  rememberReviewHandoff,
  resetJobHandoffsForTest,
  reviewHandoffFor,
} from "./jobHandoff.js";

afterEach(resetJobHandoffsForTest);

describe("job handoff", () => {
  it("hands the queued review snapshot to the matching route only", () => {
    const task = { id: "111122223333", title: "测试", type: "compare", status: "queued" };
    rememberReviewHandoff(task);

    assert.equal(reviewHandoffFor("ffffffffffff"), null);
    assert.equal(reviewHandoffFor(task.id), task);
    forgetReviewHandoff(task.id);
    assert.equal(reviewHandoffFor(task.id), null);
  });

  it("keeps review and mockup handoffs independent", () => {
    const task = { id: "111122223333", title: "审核", type: "compare", status: "queued" };
    const job = { id: "aaaabbbbcccc", status: "queued" as const, files: [] };
    rememberReviewHandoff(task);
    rememberMockupHandoff(job);

    assert.equal(reviewHandoffFor(task.id), task);
    assert.equal(mockupHandoffFor(job.id), job);
    forgetMockupHandoff(job.id);
    assert.equal(reviewHandoffFor(task.id), task);
  });
});
