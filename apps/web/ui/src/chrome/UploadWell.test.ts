import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldActivateUploadWell } from "./UploadWell.js";

describe("shouldActivateUploadWell", () => {
  it("accepts the native button activation keys", () => {
    assert.equal(shouldActivateUploadWell("Enter"), true);
    assert.equal(shouldActivateUploadWell(" "), true);
  });

  it("ignores navigation keys and every key while disabled", () => {
    assert.equal(shouldActivateUploadWell("Spacebar"), false);
    assert.equal(shouldActivateUploadWell("ArrowDown"), false);
    assert.equal(shouldActivateUploadWell("Enter", true), false);
    assert.equal(shouldActivateUploadWell(" ", true), false);
  });
});
