import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SIDE_NAV } from "./nav.js";

describe("SIDE_NAV", () => {
  it("locks 审稿台 → 打样台 → 历史记录 → 设置", () => {
    assert.deepEqual(
      SIDE_NAV.map((item) => item.key),
      ["review", "mockup", "history", "settings"],
    );
    assert.deepEqual(
      SIDE_NAV.map((item) => item.label),
      ["审稿台", "打样台", "历史记录", "设置"],
    );
    assert.equal(SIDE_NAV.at(-1)?.key, "settings");
  });
});
