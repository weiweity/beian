import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampDockBox,
  clampDockPlace,
  DOCK_DEFAULT_H,
  DOCK_DEFAULT_W,
  DOCK_MIN_H,
  DOCK_MIN_W,
  readBoxesOn,
  readDockBox,
  readDockOpen,
  readDockPlace,
  readPinsOn,
  resizeDockCorner,
  resizeDockHandle,
  skipPackSheetField,
  writeBoxesOn,
  writeDockBox,
  writeDockOpen,
  writeDockPlace,
  writePinsOn,
} from "./reviewDock.js";

describe("reviewDock", () => {
  it("defaults dock open and pins on", () => {
    assert.equal(readDockOpen(null), true);
    assert.equal(readPinsOn(null), true);
    assert.equal(readBoxesOn(null), true);
    assert.equal(readDockPlace(null).top, 8);
    assert.equal(readDockOpen({ getItem: () => "shut" }), false);
    assert.equal(readPinsOn({ getItem: () => "off" }), false);
    assert.equal(readBoxesOn({ getItem: () => "off" }), false);
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
    writeBoxesOn(store, false);
    writeDockPlace(store, { top: 24, right: 40 });
    assert.equal(readDockOpen(store), false);
    assert.equal(readPinsOn(store), false);
    assert.equal(readBoxesOn(store), false);
    assert.deepEqual(readDockPlace(store), { top: 24, right: 40 });
    writeDockOpen(store, true);
    writePinsOn(store, true);
    writeBoxesOn(store, true);
    assert.equal(readDockOpen(store), true);
    assert.equal(readPinsOn(store), true);
    assert.equal(readBoxesOn(store), true);
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
    const se = resizeDockHandle(
      { w: 400, h: 400 },
      { top: 20, right: 80 },
      { dx: 40, dy: 20 },
      { w: 1200, h: 900 },
      "se",
    );
    assert.equal(se.box.w, 440);
    assert.equal(se.box.h, 420);
    assert.equal(se.place.right, 40);
    const parked = clampDockPlace({ top: 9000, right: -4 }, { w: 800, h: 600 }, { w: 400, h: 300 });
    assert.equal(parked.top, 292);
    assert.equal(parked.right, 8);
  });

  it("skips pack-sheet fields", () => {
    assert.equal(skipPackSheetField("工艺说明"), true);
    assert.equal(skipPackSheetField("颜色要求"), true);
    assert.equal(skipPackSheetField("版本号"), true);
    assert.equal(skipPackSheetField("中文品名"), false);
  });
});
