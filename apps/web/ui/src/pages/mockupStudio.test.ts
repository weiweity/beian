import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BACKDROP_DEFAULT,
  backdropFrameClass,
  blobFromStudioStill,
  canvasFilterSupported,
  clampStudioLight,
  composeStudioStill,
  containRect,
  glbExposure,
  glbBackdrop,
  jobHasGround,
  jobHasReviewCard,
  jobHasSet,
  stillSetKey,
  loadStillImage,
  parseBackdropPreset,
  readBackdropPreset,
  reviewCardKey,
  stillsFilter,
  studioBackdrop,
  usesContactShadow,
  STUDIO_GROUND_FILL,
  STUDIO_LIGHT_DEFAULT,
  highlightLut,
  protectStudioHighlights,
} from "./mockupStudio.js";

describe("mockup studio light", () => {
  it("protects bright channels without changing alpha or clipping subwhite to white", () => {
    const lut = highlightLut(1.4);
    assert.equal(lut[0], 0);
    assert.equal(lut[255], 255);
    for (let i = 1; i < 255; i++) {
      assert.ok(lut[i] >= i);
      assert.ok(lut[i] >= lut[i - 1]);
      assert.ok(lut[i] < 255);
    }
    const pixels = new Uint8ClampedArray([218, 240, 254, 127, 0, 32, 200, 0]);
    protectStudioHighlights(pixels, 1.4);
    assert.deepEqual([...pixels], [lut[218], lut[240], lut[254], 127, 0, lut[32], lut[200], 0]);
    for (const light of [1, 0.6, NaN]) assert.deepEqual([...highlightLut(light)], Array.from({ length: 256 }, (_, i) => i));
  });
  it("clamps product brightness and maps GLB exposure from the product slider", () => {
    assert.equal(clampStudioLight(1), 1);
    assert.equal(clampStudioLight(0), 0.6);
    assert.equal(clampStudioLight(9), 1.4);
    assert.equal(clampStudioLight(Number.NaN), 1);
    assert.equal(stillsFilter(1), "contrast(1.04) brightness(1)");
    assert.equal(glbExposure(1), "1.1");
    assert.equal(glbExposure(1.4), "1.54");
    assert.equal(glbExposure(0.6), "0.66");
  });

  it("keeps the GLB wall and table distinct and follows background light", () => {
    assert.match(glbBackdrop(1, "white_set"), /^linear-gradient/);
    assert.ok(glbBackdrop(1, "white_set").includes("rgb(238, 238, 236)"));
    assert.ok(glbBackdrop(1, "white_set").includes(STUDIO_GROUND_FILL));
    assert.notEqual(glbBackdrop(0.6, "white_set"), glbBackdrop(1, "white_set"));
    assert.equal(glbBackdrop(NaN, "white_set"), glbBackdrop(1, "white_set"));
    for (const preset of ["white", "silver"] as const) {
      assert.equal(glbBackdrop(1, preset), studioBackdrop(1, preset));
    }
    assert.equal(glbExposure(NaN), "1.1");
    assert.equal(glbExposure(99), "1.54");
  });

  it("maps background light to a packshot cyc that stays below paper white at default", () => {
    assert.equal(studioBackdrop(1), "rgb(238, 238, 238)");
    assert.equal(studioBackdrop(1.4), "rgb(255, 255, 255)");
    assert.equal(studioBackdrop(0.6), "rgb(143, 143, 143)");
    assert.equal(studioBackdrop(Number.NaN), "rgb(238, 238, 238)");
  });

  it("maps silver and white-set fills without leaving the compositor", () => {
    assert.equal(studioBackdrop(1, "silver"), "rgb(196, 201, 208)");
    assert.equal(studioBackdrop(1, "white_set"), STUDIO_GROUND_FILL);
    assert.equal(studioBackdrop(0.6, "white_set"), "rgb(137, 137, 139)");
    assert.equal(usesContactShadow("white_set"), true);
    assert.equal(usesContactShadow("white"), false);
    assert.equal(usesContactShadow("silver"), false);
    assert.equal(parseBackdropPreset("silver"), "silver");
    assert.equal(parseBackdropPreset("nope"), BACKDROP_DEFAULT);
    assert.equal(readBackdropPreset(), BACKDROP_DEFAULT);
    assert.equal(backdropFrameClass("silver"), "is-backdrop-silver");
    assert.equal(backdropFrameClass("white_set"), "is-backdrop-white-set");
    assert.equal(backdropFrameClass("white"), "is-backdrop-white");
  });
});

function fakeCtx() {
  const calls: unknown[][] = [];
  return {
    calls,
    fillStyle: "",
    filter: "none",
    globalCompositeOperation: "source-over",
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push(["fillRect", this.fillStyle, x, y, w, h]);
    },
    drawImage(img: { id: string }, x: number, y: number, w: number, h: number) {
      calls.push(["drawImage", img.id, x, y, w, h, this.filter, this.globalCompositeOperation]);
    },
    save() {
      calls.push(["save"]);
    },
    restore() {
      calls.push(["restore"]);
    },
  };
}

describe("composeStudioStill", () => {
  it("fails closed when the highlight scratch canvas has no context", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ getContext: () => null }) } });
    try {
      const ctx = fakeCtx();
      assert.throws(() => composeStudioStill(ctx as unknown as CanvasRenderingContext2D, 10, 12, { width: 10, height: 12 }, null,
        { productLight: 1.4, backgroundLight: 1, backdrop: "white" }), /不能进行高光保护调灯/);
      assert.equal(ctx.calls.at(-1)?.[0], "restore");
      assert.equal(ctx.calls.some((call) => call[0] === "drawImage"), false);
    } finally {
      if (original) Object.defineProperty(globalThis, "document", original);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("applies background highlight transfer before product contrast with correct set and ground blending", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    const drawn: Array<[string, string]> = [];
    const transferred: number[][] = [];
    const work = {
      filter: "none",
      drawImage(source: { id: string }) { drawn.push([source.id, this.filter]); },
      getImageData: () => ({ data: new Uint8ClampedArray([218, 240, 254, 127]) }),
      putImageData(pixels: { data: Uint8ClampedArray }) { transferred.push([...pixels.data]); },
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ id: "scratch", getContext: () => work }) } });
    try {
      const source = (id: string) => ({ id, width: 10, height: 12 });
      for (const hasSet of [false, true]) {
        const ctx = fakeCtx();
        composeStudioStill(ctx as unknown as CanvasRenderingContext2D, 10, 12, source("product"), source("ground"),
          { productLight: 1.4, backgroundLight: 1.4, backdrop: "white_set", set: hasSet ? source("set") : null, filterSupported: true });
        const images = ctx.calls.filter((call) => call[0] === "drawImage");
        assert.deepEqual(images.map((call) => call[7]), [hasSet ? "source-over" : "multiply", "source-over"]);
        assert.ok(images.every((call) => call[6] === "none"), "destination must not brighten transferred pixels a second time");
        assert.equal(ctx.calls.at(-1)?.[0], "restore");
      }
      assert.deepEqual(drawn, [["ground", "none"], ["product", "contrast(1.04)"], ["set", "none"], ["product", "contrast(1.04)"]]);
      const lut = highlightLut(1.4);
      assert.deepEqual(transferred, Array.from({ length: 4 }, () => [lut[218], lut[240], lut[254], 127]));
    } finally {
      if (original) Object.defineProperty(globalThis, "document", original);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("uses the highlight curve even without native filters and preserves alpha", () => {
    const old = Object.getOwnPropertyDescriptor(globalThis, "document");
    const pixels = new Uint8ClampedArray([218, 240, 254, 127]);
    let allocations = 0;
    const work = { filter: "none", drawImage() {}, getImageData: () => ({ data: pixels }), putImageData() {} };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement() { allocations++; return { width: 1, height: 1, getContext: () => work }; } } });
    try {
      const ctx = fakeCtx();
      for (let n = 0; n < 2; n++) composeStudioStill(ctx as unknown as CanvasRenderingContext2D, 1, 1, { width: 1, height: 1 }, null, { productLight: 1.4, backgroundLight: 1, filterSupported: false, backdrop: "white" });
      assert.equal(allocations, 1);
      assert.ok(pixels[0] > 218 && pixels[0] < 255);
      assert.equal(pixels[3], 127);
      assert.equal(work.filter, "none");
    } finally { if (old) Object.defineProperty(globalThis, "document", old); else Reflect.deleteProperty(globalThis, "document"); }
  });

  it("rejects unreadable pixels and restores compositor state rather than exporting clipped fallback", () => {
    const old = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement() { return { getContext: () => ({ drawImage() {}, getImageData() { throw new Error("tainted"); } }) }; } } });
    try {
      const ctx = fakeCtx();
      assert.throws(() => composeStudioStill(ctx as unknown as CanvasRenderingContext2D, 1, 1, { width: 1, height: 1 }, null, { productLight: 1.4, backgroundLight: 1 }), /tainted/);
      assert.equal(ctx.calls.at(-1)?.[0], "restore");
      assert.equal(ctx.calls.some(c => c[0] === "drawImage"), false);
    } finally { if (old) Object.defineProperty(globalThis, "document", old); else Reflect.deleteProperty(globalThis, "document"); }
  });

  it("contains 3000×3600 into a 3:4 dest without stretching", () => {
    assert.deepEqual(containRect(600, 800, 3000, 3600), { x: 0, y: 40, w: 600, h: 720 });
  });

  it("fills STUDIO_GROUND_FILL then multiplies ground then draws product", () => {
    const ctx = fakeCtx();
    const product = { id: "product", naturalWidth: 3000, naturalHeight: 3600 };
    const ground = { id: "ground", naturalWidth: 3000, naturalHeight: 3600 };
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      product,
      ground,
      { productLight: STUDIO_LIGHT_DEFAULT, backgroundLight: STUDIO_LIGHT_DEFAULT, filterSupported: true },
    );
    const kinds = ctx.calls.map((call) => call[0]);
    assert.equal(kinds.includes("fillRect"), true);
    const fill = ctx.calls.find((call) => call[0] === "fillRect");
    assert.equal(fill?.[1], STUDIO_GROUND_FILL);
    const images = ctx.calls.filter((call) => call[0] === "drawImage");
    assert.equal(images[0]?.[1], "ground");
    assert.equal(images[0]?.[7], "multiply");
    assert.equal(images[1]?.[1], "product");
    assert.deepEqual(images[0]?.slice(2, 6), [0, 40, 600, 720]);
    assert.deepEqual(images[1]?.slice(2, 6), [0, 40, 600, 720]);
  });

  it("does not modulate ground at default background light", () => {
    const ctx = fakeCtx();
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      { id: "product", naturalWidth: 3000, naturalHeight: 3600 },
      { id: "ground", naturalWidth: 3000, naturalHeight: 3600 },
      { productLight: 1, backgroundLight: 1, filterSupported: true },
    );
    const ground = ctx.calls.find((call) => call[0] === "drawImage" && call[1] === "ground");
    assert.equal(ground?.[6], "none");
  });

  it("still composites when filter is unavailable and does not throw", () => {
    const ctx = fakeCtx();
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      { id: "product", naturalWidth: 3000, naturalHeight: 3600 },
      { id: "ground", naturalWidth: 3000, naturalHeight: 3600 },
      { productLight: 0.8, backgroundLight: 0.6, filterSupported: false },
    );
    const images = ctx.calls.filter((call) => call[0] === "drawImage");
    assert.equal(images.length, 2);
    assert.equal(images[0]?.[6], "none");
    assert.equal(images[1]?.[6], "none");
  });

  it("detects grounded jobs from file keys", () => {
    assert.equal(jobHasGround(undefined), false);
    assert.equal(jobHasGround([]), false);
    assert.equal(jobHasGround([{ key: "white_a" }]), false);
    assert.equal(jobHasGround([{ key: "white_a" }, { key: "white_a_ground" }]), true);
    assert.equal(jobHasGround([{ key: "white_b_ground" }]), true);
    assert.equal(reviewCardKey("white_a"), "white_a_card");
    assert.equal(jobHasReviewCard([{ key: "white_a" }], "white_a"), false);
    assert.equal(jobHasReviewCard([{ key: "white_a" }, { key: "white_a_card" }], "white_a"), true);
    assert.equal(stillSetKey("white_a"), "white_a_set");
    assert.equal(stillSetKey("white_b"), "white_b_set");
    assert.equal(jobHasSet([{ key: "white_a" }], "white_a"), false);
    assert.equal(jobHasSet([{ key: "white_a_set" }], "white_a"), true);
    assert.equal(jobHasSet([{ key: "white_b_set" }], "white_b"), true);
  });

  it("draws set then product for white_set and skips ground multiply", () => {
    const ctx = fakeCtx();
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      { id: "product", naturalWidth: 3000, naturalHeight: 3600 },
      { id: "ground", naturalWidth: 3000, naturalHeight: 3600 },
      {
        productLight: STUDIO_LIGHT_DEFAULT,
        backgroundLight: STUDIO_LIGHT_DEFAULT,
        backdrop: "white_set",
        set: { id: "set", naturalWidth: 3000, naturalHeight: 3600 },
        filterSupported: true,
      },
    );
    const images = ctx.calls.filter((call) => call[0] === "drawImage");
    assert.equal(images.length, 2);
    assert.equal(images[0]?.[1], "set");
    assert.equal(images[0]?.[7], "source-over");
    assert.equal(images[1]?.[1], "product");
    assert.equal(images.some((call) => call[1] === "ground"), false);
    const fills = ctx.calls.filter((call) => call[0] === "fillRect");
    assert.equal(fills.length, 1);
    assert.equal(fills[0]?.[1], STUDIO_GROUND_FILL);
    assert.equal(
      fills.some((call) => String(call[1]).includes("rgba(40, 24, 56")),
      false,
    );
  });

  it("keeps CSS wall and ground when white_set has no set still", () => {
    const ctx = fakeCtx();
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      { id: "product", naturalWidth: 3000, naturalHeight: 3600 },
      { id: "ground", naturalWidth: 3000, naturalHeight: 3600 },
      {
        productLight: STUDIO_LIGHT_DEFAULT,
        backgroundLight: STUDIO_LIGHT_DEFAULT,
        backdrop: "white_set",
        filterSupported: true,
      },
    );
    const images = ctx.calls.filter((call) => call[0] === "drawImage");
    assert.equal(images[0]?.[1], "ground");
    assert.equal(images[0]?.[7], "multiply");
  });

  it("ignores set stills on silver", () => {
    const ctx = fakeCtx();
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      { id: "product", naturalWidth: 3000, naturalHeight: 3600 },
      { id: "ground", naturalWidth: 3000, naturalHeight: 3600 },
      {
        productLight: STUDIO_LIGHT_DEFAULT,
        backgroundLight: STUDIO_LIGHT_DEFAULT,
        backdrop: "silver",
        set: { id: "set", naturalWidth: 3000, naturalHeight: 3600 },
        filterSupported: true,
      },
    );
    const images = ctx.calls.filter((call) => call[0] === "drawImage");
    assert.equal(images.length, 1);
    assert.equal(images[0]?.[1], "product");
  });

  it("loadStillImage reuses the same in-flight request", async () => {
    const first = loadStillImage("/api/mockups/x/files/white_a");
    const second = loadStillImage("/api/mockups/x/files/white_a");
    assert.equal(first, second);
    await assert.rejects(first, /load/);
    const again = loadStillImage("/api/mockups/x/files/white_a");
    assert.notEqual(again, first);
    await assert.rejects(again, /load/);
  });

  it("returns dest box when source or dest size is zero", () => {
    assert.deepEqual(containRect(0, 800, 3000, 3600), { x: 0, y: 0, w: 0, h: 800 });
    assert.deepEqual(containRect(600, 800, 0, 3600), { x: 0, y: 0, w: 600, h: 800 });
    assert.deepEqual(containRect(800, 600, 3000, 3600), { x: 150, y: 0, w: 500, h: 600 });
  });

  it("applies brightness to ground when background light is not default", () => {
    const ctx = fakeCtx();
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      { id: "product", naturalWidth: 3000, naturalHeight: 3600 },
      { id: "ground", naturalWidth: 3000, naturalHeight: 3600 },
      { productLight: 1, backgroundLight: 0.6, filterSupported: true },
    );
    const images = ctx.calls.filter((call) => call[0] === "drawImage");
    assert.equal(images[0]?.[6], "brightness(0.6)");
    assert.equal(images[0]?.[7], "multiply");
    assert.equal(images[1]?.[6], stillsFilter(1));
  });

  it("white and silver skip the ground pass so catalog fills stay clean", () => {
    const ctx = fakeCtx();
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      { id: "product", naturalWidth: 3000, naturalHeight: 3600 },
      { id: "ground", naturalWidth: 3000, naturalHeight: 3600 },
      { productLight: 1, backgroundLight: 1, filterSupported: true, backdrop: "white" },
    );
    const images = ctx.calls.filter((call) => call[0] === "drawImage");
    assert.equal(images.length, 1);
    assert.equal(images[0]?.[1], "product");
    const fill = ctx.calls.find((call) => call[0] === "fillRect");
    assert.equal(fill?.[1], "rgb(238, 238, 238)");
  });

  it("silver fills a cool gray and does not multiply ground", () => {
    const ctx = fakeCtx();
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      { id: "product", naturalWidth: 3000, naturalHeight: 3600 },
      { id: "ground", naturalWidth: 3000, naturalHeight: 3600 },
      { productLight: 1, backgroundLight: 1, filterSupported: true, backdrop: "silver" },
    );
    assert.equal(ctx.calls.find((call) => call[0] === "fillRect")?.[1], "rgb(196, 201, 208)");
    assert.equal(ctx.calls.filter((call) => call[0] === "drawImage").length, 1);
  });

  it("white-set paints a wall above the table then multiplies ground", () => {
    const ctx = fakeCtx();
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      { id: "product", naturalWidth: 3000, naturalHeight: 3600 },
      { id: "ground", naturalWidth: 3000, naturalHeight: 3600 },
      { productLight: 1, backgroundLight: 1, filterSupported: true, backdrop: "white_set" },
    );
    const fills = ctx.calls.filter((call) => call[0] === "fillRect");
    assert.equal(fills[0]?.[1], STUDIO_GROUND_FILL);
    assert.ok(fills.length >= 2);
    const images = ctx.calls.filter((call) => call[0] === "drawImage");
    assert.equal(images[0]?.[1], "ground");
    assert.equal(images[0]?.[7], "multiply");
    assert.equal(images[1]?.[1], "product");
  });

  it("skips empty product or ground sources", () => {
    const ctx = fakeCtx();
    composeStudioStill(
      ctx as unknown as CanvasRenderingContext2D,
      600,
      800,
      null,
      { id: "ground", naturalWidth: 0, naturalHeight: 0 },
      { productLight: 1, backgroundLight: 1, filterSupported: true },
    );
    assert.equal(ctx.calls.filter((call) => call[0] === "drawImage").length, 0);
  });

  it("blobFromStudioStill throws before canvas when the product has no size", async () => {
    await assert.rejects(
      () => blobFromStudioStill({ naturalWidth: 0, naturalHeight: 0 }, null, { productLight: 1, backgroundLight: 1 }),
      /图还没加载完/,
    );
  });

  it("canvasFilterSupported is false without a document", () => {
    const ctx = fakeCtx();
    ctx.filter = "none";
    assert.equal(canvasFilterSupported(ctx as unknown as CanvasRenderingContext2D), false);
  });
});
