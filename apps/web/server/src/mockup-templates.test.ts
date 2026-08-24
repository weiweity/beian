import assert from "node:assert/strict";
import { basename } from "node:path";
import { describe, it } from "node:test";
import { defaultTemplatePath, productionTemplatePaths } from "./mockup.js";

describe("production templates", () => {
  it("lists registered dies and skips smoke", () => {
    const all = productionTemplatePaths();
    assert.ok(all.some((p) => basename(p) === "flower_box_47_5x47_5x177_5.json"));
    assert.equal(
      all.some((p) => /smoke/i.test(basename(p))),
      false,
    );
    assert.equal(basename(defaultTemplatePath()), "flower_box_47_5x47_5x177_5.json");
  });
});
