import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldShowTaskBoard } from "./tasksBoard.js";

describe("shouldShowTaskBoard", () => {
  it("hides the three empty columns on first visit and while loading", () => {
    assert.equal(shouldShowTaskBoard(0, ""), false);
  });

  it("shows the board once there is a row", () => {
    assert.equal(shouldShowTaskBoard(1, ""), true);
  });

  it("keeps the board after a search even if zero hits", () => {
    assert.equal(shouldShowTaskBoard(0, "软糖"), true);
  });
});
