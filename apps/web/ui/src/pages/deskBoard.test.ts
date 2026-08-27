import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PENDING_REVIEW, deskCardState, deskClock, deskShortId } from "./deskBoard.js";

describe("deskBoard", () => {
  it("keeps the pending-review copy as 待审核", () => {
    assert.equal(PENDING_REVIEW, "待审核");
  });

  it("shortens a 12-char task id for the card corner", () => {
    assert.equal(deskShortId("e5969b58cd47"), "e5969b58");
    assert.equal(deskShortId("abc"), "abc");
    assert.equal(deskShortId(""), "—");
  });

  it("formats work time as local clock", () => {
    assert.equal(deskClock(""), "—");
    assert.equal(deskClock(undefined), "—");
    const out = deskClock("2026-08-25T11:49:00.000Z");
    assert.match(out, /^2026-08-25 \d{2}:\d{2}$/);
  });

  it("keeps the real live stage in the compact state line", () => {
    assert.equal(
      deskCardState({
        id: "1",
        title: "产品",
        statusText: "对照中",
        statusColor: "processing",
        progress: 55,
        live: "认字 · 大约还要 40 秒",
      }),
      "55% · 认字",
    );
    assert.equal(
      deskCardState({
        id: "2",
        title: "产品",
        statusText: "正在对照",
        statusColor: "processing",
        live: "大约还要 40 秒",
      }),
      "正在对照 · 大约还要 40 秒",
    );
  });
});
