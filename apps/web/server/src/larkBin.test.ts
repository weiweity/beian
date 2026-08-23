import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { whichLark } from "./larkBin.js";

describe("whichLark", () => {
  it("returns a string or null and does not throw", () => {
    const bin = whichLark();
    assert.ok(bin === null || (typeof bin === "string" && bin.length > 0));
  });
});
