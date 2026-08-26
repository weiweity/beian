import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskDetail } from "../api.js";
import { reviewHits, shouldUseReworkView } from "./reviewVersion.js";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "aabbccddeeff",
    title: "喷雾",
    product_name: "喷雾",
    type: "excel_pdf",
    status: "pending_review",
    created_at: "2026-08-26T08:00:00.000Z",
    owner: "刘籽烨",
    hits: [{ id: "v1", field: "品名", status: "疑点" }],
    ...overrides,
  } as TaskDetail;
}

describe("review version selection", () => {
  it("reopening a completed rework defaults to its v2 page and non-empty hits", () => {
    const current = task({
      pages_v2: [{ page: 1, name: "page_01.png", url: "/v2/page_01.png" }],
      hits_v2: [{ id: "v2", field: "品名", status: "一致" }],
    });
    assert.equal(shouldUseReworkView(current), true);
    assert.equal(reviewHits(current, true)[0]?.id, "v2");
  });

  it("v2 pages with an empty hits_v2 still show first-round fields", () => {
    const current = task({
      pages_v2: [{ page: 1, name: "page_01.png", url: "/v2/page_01.png" }],
      hits_v2: [],
    });
    assert.equal(shouldUseReworkView(current), true);
    assert.equal(reviewHits(current, true)[0]?.id, "v1");
  });
});
