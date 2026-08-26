import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enterElementFullscreen,
  exitElementFullscreen,
  fullscreenFailureMessage,
  isElementFullscreen,
  pingViewerAfterFullscreen,
} from "./mockupFullscreen.js";

describe("glb fullscreen", () => {
  it("keeps fullscreen failures in concise Chinese", () => {
    assert.equal(fullscreenFailureMessage(), "全屏打不开");
    assert.equal(fullscreenFailureMessage(new Error("request rejected")), "全屏打不开");
  });

  it("treats the frame as fullscreen only when it is the fullscreen element", () => {
    const el = { id: "glb" } as unknown as HTMLElement;
    const other = { id: "other" } as unknown as HTMLElement;
    assert.equal(isElementFullscreen(el, { fullscreenElement: el }), true);
    assert.equal(isElementFullscreen(el, { fullscreenElement: null }), false);
    assert.equal(isElementFullscreen(el, { fullscreenElement: other }), false);
    assert.equal(isElementFullscreen(el, { fullscreenElement: null, webkitFullscreenElement: el }), true);
    assert.equal(isElementFullscreen(el, { fullscreenElement: null, webkitFullscreenElement: other }), false);
    assert.equal(isElementFullscreen(null, { fullscreenElement: el }), false);
    assert.equal(isElementFullscreen(el), false);
  });

  it("reframes the viewer when updateFraming exists", () => {
    let framed = 0;
    pingViewerAfterFullscreen(
      { querySelector: () => ({ updateFraming: () => { framed += 1; } }) },
      { dispatchEvent: () => true, requestAnimationFrame: undefined },
    );
    assert.equal(framed, 1);
  });

  it("still resizes when the viewer has no updateFraming", () => {
    let resized = 0;
    pingViewerAfterFullscreen(
      { querySelector: () => ({}) },
      { dispatchEvent: () => { resized += 1; return true; }, requestAnimationFrame: undefined },
    );
    assert.equal(resized, 1);
  });

  it("pings again on animation frames so fullscreen can finish laying out", () => {
    let framed = 0;
    pingViewerAfterFullscreen(
      { querySelector: () => ({ updateFraming: () => { framed += 1; } }) },
      {
        dispatchEvent: () => true,
        requestAnimationFrame: (cb) => {
          cb(0);
          return 1;
        },
      },
    );
    assert.equal(framed, 1);
  });

  it("enters via requestFullscreen and falls back to webkit", async () => {
    let std = 0;
    let webkit = 0;
    await enterElementFullscreen({ requestFullscreen: async () => { std += 1; } } as unknown as HTMLElement);
    await enterElementFullscreen({ webkitRequestFullscreen: () => { webkit += 1; } } as unknown as HTMLElement);
    await assert.rejects(() => enterElementFullscreen({} as unknown as HTMLElement));
    assert.equal(std, 1);
    assert.equal(webkit, 1);
  });

  it("exits via exitFullscreen, webkit, or no-ops when nothing is fullscreen", async () => {
    let std = 0;
    let webkit = 0;
    await exitElementFullscreen({
      fullscreenElement: { id: "glb" } as unknown as Element,
      exitFullscreen: async () => { std += 1; },
    });
    await exitElementFullscreen({
      fullscreenElement: { id: "glb" } as unknown as Element,
      webkitExitFullscreen: () => { webkit += 1; },
    });
    await exitElementFullscreen({
      fullscreenElement: null,
      webkitExitFullscreen: () => { webkit += 1; },
    });
    await exitElementFullscreen();
    assert.equal(std, 1);
    assert.equal(webkit, 2);
  });
});
