import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampDockBox,
  DOCK_DEFAULT_H,
  DOCK_DEFAULT_W,
  DOCK_MIN_H,
  DOCK_MIN_W,
  readDockBox,
  readDockOpen,
  readPinsOn,
  resizeDockCorner,
  writeDockBox,
  writeDockOpen,
  writePinsOn,
} from "./reviewDock.js";

describe("reviewDock", () => {
  it("defaults dock open and pins on", () => {
    assert.equal(readDockOpen(null), true);
    assert.equal(readPinsOn(null), true);
    assert.equal(readDockOpen({ getItem: () => "shut" }), false);
    assert.equal(readPinsOn({ getItem: () => "off" }), false);
  });

  it("persists open/shut and pin visibility", () => {
    const bag: Record<string, string> = {};
    const store = {
      getItem: (k: string) => bag[k] ?? null,
      setItem: (k: string, v: string) => {
        bag[k] = v;
      },
    };
    writeDockOpen(store, false);
    writePinsOn(store, false);
    assert.equal(readDockOpen(store), false);
    assert.equal(readPinsOn(store), false);
    writeDockOpen(store, true);
    writePinsOn(store, true);
    assert.equal(readDockOpen(store), true);
    assert.equal(readPinsOn(store), true);
  });

  it("clamps and persists dock size", () => {
    const bag: Record<string, string> = {};
    const store = {
      getItem: (k: string) => bag[k] ?? null,
      setItem: (k: string, v: string) => {
        bag[k] = v;
      },
    };
    assert.deepEqual(readDockBox(null), { w: DOCK_DEFAULT_W, h: DOCK_DEFAULT_H });
    writeDockBox(store, { w: 640, h: 400 });
    assert.deepEqual(readDockBox(store), { w: 640, h: 400 });
    const tight = clampDockBox({ w: 80, h: 9000 }, { w: 500, h: 400 });
    assert.equal(tight.w, DOCK_MIN_W);
    assert.equal(tight.h, 376);
    const grown = resizeDockCorner({ w: 400, h: 400 }, { dx: -80, dy: 40 }, { w: 900, h: 800 });
    assert.deepEqual(grown, { w: 480, h: 440 });
    assert.equal(clampDockBox({ w: Number.NaN, h: Number.NaN }, { w: 800, h: 600 }).w, DOCK_DEFAULT_W);
    assert.ok(DOCK_MIN_H > 0);
  });
});
