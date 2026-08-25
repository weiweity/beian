import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampScale, fittedPage, panBy, resetZoom, zoomAt, zoomCss, zoomToBox } from "./canvasZoom.js";

describe("clampScale", () => {
  it("stays between 1 and 6", () => {
    assert.equal(clampScale(0.2), 1);
    assert.equal(clampScale(9), 6);
    assert.equal(clampScale(2), 2);
    assert.equal(clampScale(Number.NaN), 1);
    assert.equal(clampScale(Number.POSITIVE_INFINITY), 1);
  });
});

describe("zoomAt", () => {
  it("zooms toward the cursor and keeps pan at 1x", () => {
    const z = zoomAt({ scale: 1, x: 0, y: 0 }, 2, 100, 50);
    assert.equal(z.scale, 2);
    assert.equal(z.x, -100);
    assert.equal(z.y, -50);
    assert.deepEqual(zoomAt({ scale: 2, x: -40, y: -10 }, 1, 100, 50), { scale: 1, x: -40, y: -10 });
  });
});

describe("zoomCss", () => {
  it("writes a CSS transform from pan and scale", () => {
    assert.equal(zoomCss({ scale: 2, x: -12, y: 8 }), "translate(-12px, 8px) scale(2)");
  });
});

describe("panBy", () => {
  it("shifts at 1x so a tall page can still be dragged", () => {
    assert.deepEqual(panBy({ scale: 1, x: 0, y: 0 }, 40, 10), { scale: 1, x: 40, y: 10 });
  });

  it("shifts when zoomed", () => {
    assert.deepEqual(panBy({ scale: 2, x: -10, y: -4 }, 6, 3), { scale: 2, x: -4, y: -1 });
  });
});

describe("zoomToBox", () => {
  it("centers the box in the view", () => {
    const z = zoomToBox(
      { left: 250, top: 250, width: 100, height: 100 },
      { width: 1000, height: 1000 },
      { width: 400, height: 400 },
      0.5,
    );
    assert.ok(z.scale > 1);
    const imgCx = 0.3 * 400;
    const imgCy = 0.3 * 400;
    assert.equal(Math.round(z.x + imgCx * z.scale), 200);
    assert.equal(Math.round(z.y + imgCy * z.scale), 200);
  });

  it("uses page aspect for a tall page", () => {
    const page = { width: 1000, height: 2000 };
    const view = { width: 400, height: 400 };
    const z = zoomToBox({ left: 50, top: 400, width: 100, height: 100 }, page, view, 0.5);
    assert.ok(Number.isFinite(z.x) && Number.isFinite(z.y));
    const laid = fittedPage(page, view);
    const imgCx = (100 / 1000) * laid.imgW;
    const imgCy = (450 / 2000) * laid.imgH;
    assert.equal(Math.round(z.x + laid.offsetX + imgCx * z.scale), 200);
    assert.equal(Math.round(z.y + laid.offsetY + imgCy * z.scale), 200);
  });

  it("parks a tall page on the right of the view", () => {
    const laid = fittedPage({ width: 1000, height: 2000 }, { width: 400, height: 400 });
    assert.equal(laid.imgW, 200);
    assert.equal(laid.imgH, 400);
    assert.equal(laid.offsetX, 200);
  });

  it("centers a box on a wide parked page", () => {
    const page = { width: 2000, height: 1000 };
    const view = { width: 400, height: 400 };
    const z = zoomToBox({ left: 400, top: 50, width: 100, height: 100 }, page, view, 0.5);
    const laid = fittedPage(page, view);
    const imgCx = (450 / 2000) * laid.imgW;
    const imgCy = (100 / 1000) * laid.imgH;
    assert.equal(Math.round(z.x + laid.offsetX + imgCx * z.scale), 200);
    assert.equal(Math.round(z.y + laid.offsetY + imgCy * z.scale), 200);
  });

  it("centers a wide page with no left offset", () => {
    const laid = fittedPage({ width: 2000, height: 1000 }, { width: 400, height: 400 });
    assert.equal(laid.imgW, 400);
    assert.equal(laid.imgH, 200);
    assert.equal(laid.offsetX, 0);
    assert.equal(laid.offsetY, 100);
  });

  it("returns zeros without real sizes", () => {
    assert.deepEqual(fittedPage({ width: 1, height: 2000 }, { width: 400, height: 400 }), {
      imgW: 0,
      imgH: 0,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it("does nothing without real sizes", () => {
    assert.deepEqual(
      zoomToBox({ left: 1, top: 1, width: 2, height: 2 }, { width: 1, height: 1 }, { width: 400, height: 400 }),
      resetZoom(),
    );
  });
});
