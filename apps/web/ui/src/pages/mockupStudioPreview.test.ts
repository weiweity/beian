import assert from "node:assert/strict";
import { test } from "node:test";
import { loadStudioPreview, loadStillImage, observeStudioFrame, studioAssetHref, type StudioPreviewSources } from "./mockupStudio.js";

const image = (src: string) => ({ src, naturalWidth: 3000, naturalHeight: 3600 }) as HTMLImageElement;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const urls = { product: { full: "p", card: "pc" }, ground: { full: "g", card: "gc" }, set: { full: "s", card: "sc" } };

test("asset URLs retain legacy behavior and encode a generation shared by cards, originals and downloads", () => {
  assert.equal(studioAssetHref("job", "white_a"), "/api/mockups/job/files/white_a");
  assert.equal(studioAssetHref("job", "white_a", "", true), "/api/mockups/job/files/white_a?download=1");
  for (const key of ["white_a", "white_a_card", "white_a_ground", "white_a_set"]) {
    const url = new URL(studioAssetHref("job", key, "2026-09-05T12:00:00+08:00", true), "https://synthetic.invalid");
    assert.equal(url.searchParams.get("generation"), "2026-09-05T12:00:00+08:00");
    assert.equal(url.searchParams.get("download"), "1");
  }
});

test("same-job relight cannot replace new cards with old cached full images", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
  let current = "old";
  class FakeImage {
    src = "";
    generation = current;
    naturalWidth = 3000;
    naturalHeight = 3600;
    async decode() {}
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
  try {
    for (const generation of ["old", "new"]) {
      current = generation;
      const source = (key: string) => ({ full: studioAssetHref("relight-regression", key, generation), card: studioAssetHref("relight-regression", `${key}_card`, generation) });
      const published: string[] = [];
      const cancel = loadStudioPreview({ product: source("white_a"), ground: source("white_a_ground"), set: null },
        (s) => published.push((s.product as unknown as FakeImage).generation), assert.fail,
        loadStillImage, async () => new FakeImage() as unknown as HTMLImageElement);
      await tick(); await tick(); cancel();
      assert.ok(published.length >= 2, "card and full must both publish");
      assert.ok(published.every((value) => value === generation), JSON.stringify(published));
      const downloaded = await loadStillImage(source("white_a").full);
      assert.equal((downloaded as unknown as FakeImage).generation, generation);
    }
    const evicted = await loadStillImage(studioAssetHref("relight-regression", "white_a", "old"));
    assert.equal((evicted as unknown as FakeImage).generation, "new", "old decoded generation is no longer retained in cache");
  } finally {
    if (original) Object.defineProperty(globalThis, "Image", original);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});

test("preview publishes cards first, then upgrades each full source without resizing", async () => {
  const pending = new Map<string, (value: HTMLImageElement) => void>();
  const frames: StudioPreviewSources[] = [];
  const cancel = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail,
    (url) => new Promise((resolve) => pending.set(url, resolve)), async (url) => image(url));
  await tick();
  assert.deepEqual([frames[0].product.src, frames[0].ground.src, frames[0].set?.src], ["pc", "gc", "sc"]);
  pending.get("p")!(image("p"));
  pending.get("s")!(image("s"));
  await tick();
  assert.equal(frames.at(-1)?.product.naturalWidth, 3000);
  assert.equal(frames.at(-1)?.ground.src, "gc");
  assert.equal(frames.at(-1)?.set?.src, "s");
  pending.get("g")!(image("g"));
  await tick();
  assert.equal(frames.at(-1)?.ground.src, "g");
  assert.equal(frames[0].product.src, "pc", "published snapshots are immutable");
  cancel();
});

test("an evicted request failure cannot erase a newer request for the same generation", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  class FakeImage {
    src = "";
    decode() { return new Promise<void>((resolve, reject) => pending.push({ resolve, reject })); }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
  try {
    const oldUrl = studioAssetHref("cache-rejection-race", "white_a", "old");
    const oldRequest = loadStillImage(oldUrl);
    const oldFailure = assert.rejects(oldRequest, /late decode failure/);
    const newerGeneration = loadStillImage(studioAssetHref("cache-rejection-race", "white_a", "new"));
    const retriedOld = loadStillImage(oldUrl);
    assert.notEqual(retriedOld, oldRequest);
    pending[0].reject(new Error("late decode failure"));
    await oldFailure;
    assert.equal(loadStillImage(oldUrl), retriedOld, "late failure must retain the replacement promise");
    assert.equal(pending.length, 3, "cache hit must not start another decode");
    pending[1].resolve(); pending[2].resolve();
    await Promise.all([newerGeneration, retriedOld]);
  } finally {
    if (original) Object.defineProperty(globalThis, "Image", original);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});

test("failed full upgrades retain usable cards without reporting a broken preview", async () => {
  const frames: StudioPreviewSources[] = [];
  loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail,
    async () => { throw new Error("full unavailable"); }, async (url) => image(url));
  await tick();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].product.src, "pc");
});

test("missing cards fall back to full; optional set failure does not hide product", async () => {
  const frames: StudioPreviewSources[] = [];
  loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail,
    async (url) => { if (url === "s") throw new Error("missing set"); return image(url); },
    async () => { throw new Error("415"); });
  await tick();
  assert.equal(frames.at(-1)?.product.src, "p");
  assert.equal(frames.at(-1)?.set, null);
});

test("missing mandatory ground reports failure and never publishes an incomplete composition", async () => {
  let failed = 0;
  loadStudioPreview(urls, () => assert.fail("must not publish"), () => failed++,
    async () => { throw new Error("missing"); }, async () => { throw new Error("415"); });
  await tick();
  assert.equal(failed, 1);
});

test("cancellation suppresses late initial results and late errors", async () => {
  for (const reject of [false, true]) {
    let finish!: () => void;
    const waiting = new Promise<HTMLImageElement>((resolve, fail) => {
      finish = () => reject ? fail(new Error("late")) : resolve(image("late"));
    });
    const cancel = loadStudioPreview({ product: { full: "p" }, ground: { full: "g" }, set: null },
      () => assert.fail("late publication"), () => assert.fail("late error"), () => waiting);
    cancel(); finish(); await tick();
  }
});

test("cancellation after card publication prevents old full images replacing a new job", async () => {
  const frames: StudioPreviewSources[] = [];
  let finish!: (image: HTMLImageElement) => void;
  const waiting = new Promise<HTMLImageElement>((resolve) => { finish = resolve; });
  const cancel = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail,
    () => waiting, async (url) => image(url));
  await tick(); cancel(); finish(image("old-full")); await tick();
  assert.equal(frames.length, 1);
});

test("frame observer coalesces resize, handles DPR and zero sizes, and removes listeners", () => {
  const original = Object.getOwnPropertyDescriptors(globalThis);
  let resize!: () => void;
  let changed!: () => void;
  let queued: (() => void) | undefined;
  let disconnected = false;
  let mediaListeners = 0;
  const windowFake = { devicePixelRatio: 1, addEventListener: (_: string, cb: () => void) => { resize = cb; },
    removeEventListener: () => {}, matchMedia: () => ({ addEventListener: (_: string, cb: () => void) => { changed = cb; mediaListeners++; }, removeEventListener: () => { mediaListeners--; } }) };
  Object.assign(globalThis, { window: windowFake,
    requestAnimationFrame: (cb: () => void) => { queued = cb; return 1; }, cancelAnimationFrame: () => { queued = undefined; },
    ResizeObserver: class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect() { disconnected = true; } },
  });
  try {
    const frame = { clientWidth: 342, clientHeight: 411 };
    const sizes: number[][] = [];
    const stop = observeStudioFrame(frame as HTMLElement, (w, h) => sizes.push([w, h]));
    const flush = () => { const cb = queued; queued = undefined; cb?.(); };
    flush();
    frame.clientWidth = 502; frame.clientHeight = 603;
    resize(); resize(); flush();
    windowFake.devicePixelRatio = 2; changed(); flush();
    resize(); flush();
    frame.clientWidth = 0; resize(); flush();
    assert.deepEqual(sizes, [[342, 411], [502, 603], [1004, 1206]]);
    resize(); stop(); flush();
    assert.equal(disconnected, true);
    assert.equal(mediaListeners, 0);
    assert.equal(sizes.length, 3);
  } finally {
    for (const key of ["window", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"]) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("frame observation still measures window resizes without ResizeObserver and uses DPR one fallback", () => {
  const keys = ["window", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"];
  const original = Object.getOwnPropertyDescriptors(globalThis);
  let onResize!: () => void;
  let queued: (() => void) | undefined;
  let removed = false;
  Object.assign(globalThis, {
    ResizeObserver: undefined,
    window: { devicePixelRatio: 0,
      addEventListener: (_: string, callback: () => void) => { onResize = callback; },
      removeEventListener: (_: string, callback: () => void) => { removed = callback === onResize; },
      matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    },
    requestAnimationFrame: (callback: () => void) => { queued = callback; return 1; },
    cancelAnimationFrame: () => { queued = undefined; },
  });
  try {
    const frame = { clientWidth: 100, clientHeight: 120 };
    const sizes: number[][] = [];
    const stop = observeStudioFrame(frame as HTMLElement, (w, h) => sizes.push([w, h]));
    const flush = () => { const callback = queued; queued = undefined; callback?.(); };
    flush();
    frame.clientWidth = 200; onResize(); flush();
    assert.deepEqual(sizes, [[100, 120], [200, 120]]);
    stop(); onResize();
    assert.equal(removed, true);
    assert.equal(queued, undefined, "stopped observers must not schedule more work");
  } finally {
    for (const key of keys) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
