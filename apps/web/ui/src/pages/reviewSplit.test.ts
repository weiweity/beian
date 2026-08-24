import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_RIGHT, MIN_LEFT, MIN_RIGHT, clampRight, readSplit, writeSplit } from "./reviewSplit.js";

describe("clampRight", () => {
  it("keeps the 400px DESIGN default when the desk is wide", () => {
    assert.equal(clampRight(DEFAULT_RIGHT, 1200), 400);
  });

  it("never shrinks the notes below 280 or the canvas below 240", () => {
    assert.equal(clampRight(100, 900), MIN_RIGHT);
    assert.equal(clampRight(800, 600), 600 - MIN_LEFT);
  });
});

describe("readSplit", () => {
  it("falls back to default when storage is empty or junk", () => {
    assert.equal(readSplit(null, 1000), DEFAULT_RIGHT);
    assert.equal(readSplit({ getItem: () => "nope" }, 1000), DEFAULT_RIGHT);
    assert.equal(readSplit({ getItem: () => "360" }, 1000), 360);
  });
});

describe("writeSplit", () => {
  it("persists the width and ignores quota errors", () => {
    const bag: Record<string, string> = {};
    writeSplit({ setItem: (k, v) => { bag[k] = v; } }, 360);
    assert.equal(bag.wb_review_split, "360");
    writeSplit({ setItem: () => { throw new Error("quota"); } }, 400);
  });
});
