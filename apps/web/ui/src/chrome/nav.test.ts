import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatVersionLabel, SIDE_NAV } from "./nav.js";

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

  it("shows only a server-provided four-part release version", () => {
    assert.equal(formatVersionLabel("0.20.2.0"), "v0.20.2.0");
    assert.equal(formatVersionLabel(" 0.20.2.0 "), "v0.20.2.0");
    assert.equal(formatVersionLabel("0.20.2"), null);
    assert.equal(formatVersionLabel(undefined), null);
  });
});
