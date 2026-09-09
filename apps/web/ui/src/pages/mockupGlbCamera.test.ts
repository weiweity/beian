import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_GLB_VIEW, glbCameraDistances } from "./mockupGlbCamera";

it("uses box bounds rather than the room sphere and adapts to live field of view", () => {
  const sphere = Math.hypot(.0475, .0475, .1775) / 2;
  const narrow = glbCameraDistances(sphere, 30, DEFAULT_GLB_VIEW.zoom);
  const wide = glbCameraDistances(sphere, 35.6, DEFAULT_GLB_VIEW.zoom);
  assert.ok(wide.radius < narrow.radius);
  assert.ok(wide.radius > wide.min);
  assert.ok(wide.radius < .6);
  assert.equal(wide.max / wide.base, 1.55);
});
it("clamps zoom to explicit box limits", () => {
  const close = glbCameraDistances(.1, 30, .001);
  const far = glbCameraDistances(.1, 30, 20);
  assert.equal(close.radius, close.min);
  assert.equal(far.radius, far.max);
});
it("rejects invalid bounds or camera inputs before writing attributes", () => {
  for (const args of [[0,30,1],[-1,30,1],[NaN,30,1],[1,0,1],[1,180,1],[1,NaN,1],[1,30,Infinity]]) {
    assert.throws(() => glbCameraDistances(args[0], args[1], args[2]), /invalid/);
  }
});

it("keeps the farthest camera within the display floor even for a narrow FOV", () => {
  const result = glbCameraDistances(.1, 5, 100);
  assert.ok(result.radius <= 1);
});
