import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileMatchesAccept } from "./fileAccept.js";

function fake(name: string, type = ""): File {
  return new File(["x"], name, type ? { type } : undefined);
}

describe("fileMatchesAccept", () => {
  it("allows empty accept", () => {
    assert.equal(fileMatchesAccept(fake("a.pdf"), ""), true);
  });

  it("matches extension", () => {
    assert.equal(fileMatchesAccept(fake("box.AI"), ".ai"), true);
    assert.equal(fileMatchesAccept(fake("box.pdf"), ".ai"), false);
    assert.equal(fileMatchesAccept(fake("a.xlsx"), ".xlsx"), true);
  });

  it("matches comma list", () => {
    assert.equal(fileMatchesAccept(fake("a.pdf"), ".pdf,.ai"), true);
    assert.equal(fileMatchesAccept(fake("a.ai"), ".pdf,.ai"), true);
    assert.equal(fileMatchesAccept(fake("a.png"), ".pdf,.ai"), false);
  });

  it("matches mime wildcard and exact type", () => {
    assert.equal(fileMatchesAccept(fake("x.bin", "image/png"), "image/*"), true);
    assert.equal(fileMatchesAccept(fake("x.bin", "audio/mpeg"), "image/*"), false);
    assert.equal(fileMatchesAccept(fake("x.bin", "application/pdf"), "application/pdf"), true);
  });
});
