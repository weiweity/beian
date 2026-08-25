import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampDockBox,
  clampDockPlace,
  dockCanvasInset,
  dockVisual,
  DOCK_DEFAULT_H,
  DOCK_DEFAULT_W,
  DOCK_MIN_H,
  DOCK_MIN_W,
  DOCK_SHUT_H,
  DOCK_SHUT_W,
  readBoxesOn,
  readDockBox,
  readDockOpen,
  readDockPlace,
  readPinsOn,
  resizeDockCorner,
  rectsOverlap,
  resizeDockHandle,
  sidebarDockPlace,
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
    assert.equal(readDockPlace(null).top, 104);
    assert.equal(readDockPlace(null).right, 2400 - DOCK_DEFAULT_W - 20);
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
    assert.deepEqual(readDockPlace(store), { top: 104, right: 40 });
    writeDockPlace(store, { top: 120, right: 40 });
    assert.deepEqual(readDockPlace(store), { top: 120, right: 40 });
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
    const lifted = clampDockPlace({ top: 8, right: 8 }, { w: 1200, h: 900 }, { w: 400, h: 300 });
    assert.equal(lifted.top, 104);
    const north = resizeDockHandle(
      { w: 400, h: 400 },
      { top: 80, right: 40 },
      { dx: 0, dy: -20 },
      { w: 1200, h: 900 },
      "n",
    );
    assert.equal(north.box.h, 420);
    assert.equal(north.place.top, 104);
    const east = resizeDockHandle(
      { w: 400, h: 400 },
      { top: 80, right: 40 },
      { dx: 30, dy: 0 },
      { w: 1200, h: 900 },
      "e",
    );
    assert.equal(east.box.w, 430);
    assert.equal(east.place.right, 10);
  });

  it("resizes the remaining six handles and floors a short room to 8", () => {
    const room = { w: 1200, h: 900 };
    const start = { w: 400, h: 400 };
    const place = { top: 80, right: 40 };
    const south = resizeDockHandle(start, place, { dx: 0, dy: 30 }, room, "s");
    assert.equal(south.box.h, 430);
    assert.equal(south.place.top, 104);
    assert.equal(south.place.right, 40);
    const west = resizeDockHandle(start, place, { dx: -20, dy: 0 }, room, "w");
    assert.equal(west.box.w, 420);
    assert.equal(west.place.right, 40);
    const nw = resizeDockHandle(start, place, { dx: 20, dy: 20 }, room, "nw");
    assert.equal(nw.box.w, 380);
    assert.equal(nw.box.h, 380);
    assert.equal(nw.place.top, 104);
    assert.equal(nw.place.right, 40);
    const ne = resizeDockHandle(start, place, { dx: 20, dy: 20 }, room, "ne");
    assert.equal(ne.box.w, 420);
    assert.equal(ne.box.h, 380);
    assert.equal(ne.place.top, 104);
    assert.equal(ne.place.right, 20);
    const sw = resizeDockHandle(start, place, { dx: -40, dy: 20 }, room);
    assert.equal(sw.box.w, 440);
    assert.equal(sw.box.h, 420);
    const short = clampDockPlace({ top: 4, right: 8 }, { w: 400, h: 300 }, { w: 320, h: 280 });
    assert.equal(short.top, 12);
    const nanTop = clampDockPlace({ top: Number.NaN, right: 8 }, room, { w: 400, h: 300 });
    assert.equal(nanTop.top, 104);
    assert.equal(readDockPlace({ getItem: () => "{" }).top, 104);
    const overSide = clampDockPlace({ top: 80, right: 2000 }, { w: 1200, h: 800 }, { w: 400, h: 300 });
    assert.equal(overSide.right, 792);
    assert.equal(overSide.top, 104);
  });

  it("parks the open dock on the left sidebar and keeps left when shutting", () => {
    const room = { w: 1400, h: 900 };
    const box = { w: 560, h: 520 };
    const parked = sidebarDockPlace(room, box, 20);
    assert.equal(parked.top, 104);
    assert.equal(parked.right, 1400 - 560 - 20);
    const shut = dockVisual(false, box, parked, room);
    assert.equal(shut.box.w, DOCK_SHUT_W);
    assert.equal(shut.box.h, DOCK_SHUT_H);
    const openLeft = room.w - parked.right - box.w;
    const shutLeft = room.w - shut.place.right - shut.box.w;
    assert.equal(shutLeft, openLeft);
    const shown = dockVisual(true, box, parked, room);
    assert.deepEqual(shown, { box, place: parked });
  });

  it("measures dock overlap without requiring the canvas to pad", () => {
    const canvas = { left: 280, top: 104, width: 1000, height: 700 };
    const dock = { left: 20, top: 104, width: 400, height: 520 };
    const inset = dockCanvasInset(canvas, dock);
    assert.equal(inset.left, 140);
    assert.equal(inset.right, 0);
    const tools = { left: canvas.left + inset.left + 12, top: canvas.top + 12, width: 360, height: 40 };
    assert.equal(rectsOverlap(tools, dock), false);
    const sign = { left: 1100, top: 16, width: 160, height: 44 };
    const parked = { left: 20, top: 104, width: 400, height: 520 };
    assert.equal(rectsOverlap(sign, parked), false);
    const rightDock = { left: 900, top: 104, width: 400, height: 400 };
    const rightInset = dockCanvasInset(canvas, rightDock);
    assert.equal(rightInset.right, 380);
    assert.equal(rightInset.left, 0);
    const clear = dockCanvasInset(canvas, { left: 0, top: 0, width: 10, height: 10 });
    assert.deepEqual(clear, { left: 0, top: 0, right: 0, bottom: 0 });
    assert.equal(rectsOverlap({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 10, height: 10 }), false);
    assert.equal(rectsOverlap({ left: 0, top: 0, width: 10, height: 10 }, { left: 9, top: 0, width: 10, height: 10 }), true);
  });

  it("skips pack-sheet fields", () => {
    assert.equal(skipPackSheetField("工艺说明"), true);
    assert.equal(skipPackSheetField("颜色要求"), true);
    assert.equal(skipPackSheetField("版本号"), true);
    assert.equal(skipPackSheetField("中文品名"), false);
    assert.equal(skipPackSheetField("执行标准版本号"), false);
    assert.equal(skipPackSheetField(""), false);
  });
});
