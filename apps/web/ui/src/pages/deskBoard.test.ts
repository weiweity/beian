import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PENDING_REVIEW, deskClock, deskShortId } from "./deskBoard.js";

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
});
