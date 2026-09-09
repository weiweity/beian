import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GLB_ENVIRONMENT, glbViewerExposure } from "./mockupGlbLighting.js";

describe("GLB studio lighting", () => {
  it("keeps invalid and out-of-range slider values finite and bounded", () => {
    for (const value of [NaN, Infinity, -Infinity]) assert.equal(glbViewerExposure(value), "0.7");
    assert.equal(glbViewerExposure(-2), glbViewerExposure(0.6));
    assert.equal(glbViewerExposure(3), glbViewerExposure(1.4));
    assert.ok(Number(glbViewerExposure(0.6)) < Number(glbViewerExposure(1)));
    assert.ok(Number(glbViewerExposure(1)) < Number(glbViewerExposure(1.4)));
  });
  it("ships a complete achromatic HDR with directional illumination rather than a color cast", () => {
    const data = readFileSync(new URL(GLB_ENVIRONMENT));
    const header = Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 256 +X 512\n");
    assert.ok(data.subarray(0, header.length).equals(header));
    assert.equal(data.length, header.length + 512 * 256 * 4);
    const intensities: number[] = [];
    for (let i = header.length; i < data.length; i += 4) {
      assert.equal(data[i], data[i + 1]);
      assert.equal(data[i], data[i + 2]);
      intensities.push(data[i] * 2 ** (data[i + 3] - 136));
    }
    assert.ok(intensities.reduce((a, b) => Math.min(a, b)) > 0, "ambient fill must not leave black directions");
    assert.ok(intensities.reduce((a, b) => Math.max(a, b)) > intensities.reduce((a, b) => Math.min(a, b)) * 10, "softboxes must remain directional");
  });
});

it("keeps room radiance stable across product exposure including bright-background extremes", async () => {
  const { glbRoomEmission } = await import("./mockupGlbLighting.js");
  for (const background of [.6, 1, 1.4]) {
    const values = [.6, 1, 1.4].map(product => {
      const {factor,strength} = glbRoomEmission([238,238,236],background,product);
      assert.ok(factor.every(v => v >= 0 && v <= 1));
      return factor.map(v => v * strength * Number(glbViewerExposure(product)));
    });
    values.slice(1).forEach(rgb => rgb.forEach((value,i) => assert.ok(Math.abs(value-values[0][i]) < 1e-12)));
  }
});
