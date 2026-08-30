import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampDockBox,
  clampDockPlace,
  dockVisual,
  DOCK_DEFAULT_H,
  DOCK_DEFAULT_W,
  DOCK_MIN_H,
  DOCK_MIN_W,
  DOCK_SHUT_H,
  DOCK_SHUT_W,
  readBoxesOn,
  readDockBox,
  readPinsOn,
  readStoredDockPlace,
  resizeDockHandle,
  sidebarDockPlace,
  skipPackSheetField,
  writeBoxesOn,
  writeDockBox,
  writeDockPlace,
  writePinsOn,
} from "./reviewDock.js";

describe("reviewDock", () => {
  it("defaults markers on and leaves placement unset on first visit", () => {
    assert.equal(readPinsOn(null), true);
    assert.equal(readBoxesOn(null), true);
    assert.equal(readStoredDockPlace(null), null);
    assert.equal(readPinsOn({ getItem: () => "off" }), false);
    assert.equal(readBoxesOn({ getItem: () => "off" }), false);
  });

  it("persists marker visibility and the top-left placement", () => {
    const bag: Record<string, string> = {};
    const store = {
      getItem: (key: string) => bag[key] ?? null,
      setItem: (key: string, value: string) => {
        bag[key] = value;
      },
    };
    writePinsOn(store, false);
    writeBoxesOn(store, false);
    writeDockPlace(store, { top: 24, left: 40 });
    assert.deepEqual(readStoredDockPlace(store), { top: 24, left: 40 });
    assert.equal(readPinsOn(store), false);
    assert.equal(readBoxesOn(store), false);
    writePinsOn(store, true);
    writeBoxesOn(store, true);
    assert.equal(readPinsOn(store), true);
    assert.equal(readBoxesOn(store), true);
  });

  it("distinguishes a first visit and rejects the former right-offset schema", () => {
    assert.equal(readStoredDockPlace(null), null);
    assert.equal(readStoredDockPlace({ getItem: () => null }), null);
    assert.equal(readStoredDockPlace({ getItem: () => "{" }), null);
    assert.equal(readStoredDockPlace({ getItem: () => '{"top":"bad","left":20}' }), null);
    assert.equal(readStoredDockPlace({ getItem: () => '{"top":180,"right":64}' }), null);
    assert.deepEqual(readStoredDockPlace({ getItem: () => '{"top":180,"left":64}' }), {
      top: 180,
      left: 64,
    });
  });

  it("clamps and persists the expanded size to the viewport", () => {
    const bag: Record<string, string> = {};
    const store = {
      getItem: (key: string) => bag[key] ?? null,
      setItem: (key: string, value: string) => {
        bag[key] = value;
      },
    };
    assert.deepEqual(readDockBox(null), { w: DOCK_DEFAULT_W, h: DOCK_DEFAULT_H });
    writeDockBox(store, { w: 640, h: 400 });
    assert.deepEqual(readDockBox(store), { w: 640, h: 400 });
    const tight = clampDockBox({ w: 80, h: 9000 }, { w: 500, h: 400 });
    assert.deepEqual(tight, { w: DOCK_MIN_W, h: 384 });
    assert.equal(clampDockBox({ w: Number.NaN, h: Number.NaN }, { w: 1200, h: 600 }).w, DOCK_DEFAULT_W);
    assert.ok(DOCK_MIN_H > 0);
  });

  it("resizes all edges while preserving the opposite edge", () => {
    const room = { w: 1200, h: 900 };
    const start = { w: 400, h: 400 };
    const place = { top: 80, left: 40 };
    const south = resizeDockHandle(start, place, { dx: 0, dy: 30 }, room, "s");
    assert.deepEqual(south, { box: { w: 400, h: 430 }, place });
    const east = resizeDockHandle(start, place, { dx: 30, dy: 0 }, room, "e");
    assert.equal(east.box.w, 430);
    assert.equal(east.place.left, 40);
    const west = resizeDockHandle(start, place, { dx: -20, dy: 0 }, room, "w");
    assert.equal(west.box.w, 420);
    assert.equal(west.place.left, 20);
    const north = resizeDockHandle(start, place, { dx: 0, dy: -20 }, room, "n");
    assert.equal(north.box.h, 420);
    assert.equal(north.place.top, 60);
    const nw = resizeDockHandle(start, place, { dx: 20, dy: 20 }, room, "nw");
    assert.deepEqual(nw, { box: { w: 380, h: 380 }, place: { top: 100, left: 60 } });
    const ne = resizeDockHandle(start, place, { dx: 20, dy: 20 }, room, "ne");
    assert.deepEqual(ne, { box: { w: 420, h: 380 }, place: { top: 100, left: 40 } });
    const sw = resizeDockHandle(start, place, { dx: -40, dy: 20 }, room, "sw");
    assert.equal(sw.box.w, 440);
    assert.equal(sw.box.h, 420);
    assert.equal(sw.place.left, 8);
  });

  it("clamps the visible box, including a collapsed dock at the bottom", () => {
    const parked = clampDockPlace({ top: 9000, left: -4 }, { w: 800, h: 600 }, { w: 400, h: 300 });
    assert.deepEqual(parked, { top: 292, left: 8 });
    const nanTop = clampDockPlace(
      { top: Number.NaN, left: 8 },
      { w: 1200, h: 900 },
      { w: 400, h: 300 },
    );
    assert.equal(nanTop.top, 104);
    const overSide = clampDockPlace({ top: 80, left: 2000 }, { w: 1200, h: 800 }, { w: 400, h: 300 });
    assert.deepEqual(overSide, { top: 80, left: 792 });

    const room = { w: 1400, h: 900 };
    const box = { w: 560, h: 520 };
    const shutAtBottom = dockVisual(false, box, { top: 9000, left: 20 }, room);
    assert.deepEqual(shutAtBottom.box, { w: DOCK_SHUT_W, h: DOCK_SHUT_H });
    assert.equal(shutAtBottom.place.top, 844);
    assert.equal(shutAtBottom.place.left, 20);
    const reopened = dockVisual(true, box, shutAtBottom.place, room);
    assert.equal(reopened.place.top, 372);
    assert.equal(reopened.place.left, 20);
  });

  it("parks on the sidebar and preserves the top-left anchor when shutting", () => {
    const room = { w: 1400, h: 900 };
    const box = { w: 560, h: 520 };
    const parked = sidebarDockPlace(room, box, 20);
    assert.deepEqual(parked, { top: 104, left: 20 });
    const shut = dockVisual(false, box, parked, room);
    assert.equal(shut.box.w, DOCK_SHUT_W);
    assert.equal(shut.box.h, DOCK_SHUT_H);
    assert.deepEqual(shut.place, parked);
    assert.deepEqual(dockVisual(true, box, parked, room), { box, place: parked });
  });

  it("skips only pack-sheet metadata fields", () => {
    assert.equal(skipPackSheetField("工艺说明"), true);
    assert.equal(skipPackSheetField("颜色要求"), true);
    assert.equal(skipPackSheetField("版本号"), true);
    assert.equal(skipPackSheetField("更新内容：调整净含量"), true);
    assert.equal(skipPackSheetField("中文品名"), false);
    assert.equal(skipPackSheetField("备案版本号"), false);
    assert.equal(skipPackSheetField("执行标准版本号"), false);
    assert.equal(skipPackSheetField(""), false);
  });
});
