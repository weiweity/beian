import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampStudioLight, glbExposure, stillsFilter } from "./mockupStudio.js";

describe("mockup studio light", () => {
  it("clamps stills brightness and maps GLB exposure from the same slider", () => {
    assert.equal(clampStudioLight(1), 1);
    assert.equal(clampStudioLight(0), 0.6);
    assert.equal(clampStudioLight(9), 1.4);
    assert.equal(clampStudioLight(Number.NaN), 1);
    assert.equal(stillsFilter(1), "contrast(1.12) brightness(1)");
    assert.equal(glbExposure(1), "0.9");
    assert.equal(glbExposure(1.4), "1.26");
    assert.equal(glbExposure(0.6), "0.54");
  });
});
