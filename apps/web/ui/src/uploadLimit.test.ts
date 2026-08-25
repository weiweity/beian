import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PUBLIC_UPLOAD_BYTES, bytesTooLarge } from "./uploadLimit.js";

describe("bytesTooLarge", () => {
  it("lets a 40MB pair through", () => {
    assert.equal(bytesTooLarge(20 * 1024 * 1024, 20 * 1024 * 1024), false);
  });

  it("blocks Excel+PDF that together exceed 100MB", () => {
    assert.equal(bytesTooLarge(60 * 1024 * 1024, 50 * 1024 * 1024), true);
    assert.equal(bytesTooLarge(PUBLIC_UPLOAD_BYTES), false);
    assert.equal(bytesTooLarge(PUBLIC_UPLOAD_BYTES + 1), true);
  });
});
