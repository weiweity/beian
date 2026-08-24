import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readDockOpen, readPinsOn, writeDockOpen, writePinsOn } from "./reviewDock.js";

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
});
