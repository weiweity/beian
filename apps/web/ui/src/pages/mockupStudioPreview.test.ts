import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadStudioPreview, loadStillImage, observeStudioFrame, peekSettled, planStudioExport,
  releaseStudioGeneration, studioAssetHref,
  studioDrawnUpgradeFailed, studioPreviewSummary, studioStillCacheHas,
  type StudioPreviewSources,
} from "./mockupStudio.js";

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
  assert.ok(frames[0], "product and ground cards must paint without waiting for set");
  assert.deepEqual([frames[0].product.src, frames[0].ground.src], ["pc", "gc"]);
  assert.equal(frames[0].set, null);
  assert.equal(frames[0].facts.set.fetch, "pending");
  const withSet = frames.find((frame) => frame.set?.src === "sc");
  assert.ok(withSet);
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
  await tick();
  const last = frames.at(-1)!;
  assert.equal(last.product.src, "pc");
  assert.equal(last.facts.product.upgradeFailed, true);
  assert.equal(last.facts.ground.upgradeFailed, true);
  assert.equal(studioDrawnUpgradeFailed(last.facts, "white", last.set), true);
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
  assert.ok(frames.length >= 1);
  assert.ok(frames.every((frame) => frame.product.src === "pc"));
  assert.ok(frames.every((frame) => frame.product.src !== "old-full"));
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

test("pending optional set does not block first paint or product/ground full upgrades", async () => {
  const pending = new Map<string, { resolve: (value: HTMLImageElement) => void; reject: (error: Error) => void }>();
  const wait = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => pending.set(url, { resolve, reject }));
  const frames: StudioPreviewSources[] = [];
  const cancel = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail, wait, wait);
  pending.get("pc")!.resolve(image("pc"));
  pending.get("gc")!.resolve(image("gc"));
  await tick();
  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0].product.src, frames[0].ground.src, frames[0].set], ["pc", "gc", null]);
  pending.get("p")!.resolve(image("p"));
  pending.get("g")!.resolve(image("g"));
  await tick();
  assert.equal(frames.at(-1)?.product.src, "p");
  assert.equal(frames.at(-1)?.ground.src, "g");
  assert.equal(frames.at(-1)?.set, null);
  pending.get("sc")!.resolve(image("sc"));
  await tick();
  assert.equal(frames.at(-1)?.set?.src, "sc");
  pending.get("s")!.resolve(image("s"));
  await tick();
  assert.equal(frames.at(-1)?.set?.src, "s");
  cancel();
});

test("set arriving first still waits for product and ground before publish", async () => {
  const pending = new Map<string, (value: HTMLImageElement) => void>();
  const wait = (url: string) => new Promise<HTMLImageElement>((resolve) => pending.set(url, resolve));
  const frames: StudioPreviewSources[] = [];
  loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail, wait, wait);
  pending.get("sc")!(image("sc"));
  await tick();
  pending.get("s")!(image("s"));
  await tick();
  assert.equal(frames.length, 0);
  pending.get("pc")!(image("pc"));
  pending.get("gc")!(image("gc"));
  await tick();
  assert.ok(frames.some((frame) => frame.set?.src === "s"));
});

test("late set after cancel does not publish or start a new full", async () => {
  const pending = new Map<string, { resolve: (value: HTMLImageElement) => void; reject: (error: Error) => void }>();
  const wait = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => pending.set(url, { resolve, reject }));
  let fulls = 0;
  const frames: StudioPreviewSources[] = [];
  const cancel = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail,
    async (url) => { fulls++; return wait(url); }, wait);
  pending.get("pc")!.resolve(image("pc"));
  pending.get("gc")!.resolve(image("gc"));
  await tick();
  cancel();
  pending.get("sc")!.resolve(image("sc"));
  await tick();
  assert.ok(frames.every((frame) => frame.set == null));
  assert.equal(fulls, 2, "only product and ground full upgrades may start before cancel");
});

test("cancel then late card failure does not start full or refill stillLoads", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
  const cards: Array<{ reject: (error: Error) => void }> = [];
  class FakeImage {
    src = "";
    crossOrigin = "";
    async decode() { return new Promise<void>((_resolve, reject) => cards.push({ reject })); }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
  try {
    const job = "cancel-refill";
    const generation = "gen-old";
    const source = (key: string) => ({
      full: studioAssetHref(job, key, generation),
      card: studioAssetHref(job, `${key}_card`, generation),
    });
    let fulls = 0;
    const loadFull = async (url: string) => {
      fulls++;
      return loadStillImage(url);
    };
    const cancel = loadStudioPreview(
      { product: source("white_a"), ground: source("white_a_ground"), set: source("white_a_set") },
      () => assert.fail("must not publish after cancel"),
      () => assert.fail("must not fail after cancel"),
      loadFull,
    );
    cancel();
    releaseStudioGeneration(job, generation);
    for (const card of cards) card.reject(new Error("late card"));
    await tick();
    await tick();
    assert.equal(fulls, 0);
    assert.equal(studioStillCacheHas(source("white_a").full), false);
    assert.equal(studioStillCacheHas(source("white_a_ground").full), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "Image", original);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});

test("mandatory failure closes the preview so a late sibling does not start full", async () => {
  const pending = new Map<string, { resolve: (value: HTMLImageElement) => void; reject: (error: Error) => void }>();
  const wait = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => pending.set(url, { resolve, reject }));
  let fulls = 0;
  let failed = 0;
  loadStudioPreview(urls, () => assert.fail("incomplete composition"), () => failed++,
    async (url) => { fulls++; return wait(url); }, wait);
  pending.get("pc")!.reject(new Error("415"));
  await tick();
  pending.get("p")!.reject(new Error("missing product"));
  await tick();
  assert.equal(failed, 1);
  const fullsAfterProduct = fulls;
  pending.get("gc")!.reject(new Error("415"));
  await tick();
  assert.equal(fulls, fullsAfterProduct, "ground must not start full after the preview already failed");
});

test("failed full is requested again on a new preview of the same identity", async () => {
  let fulls = 0;
  const loadFull = async (url: string) => {
    fulls++;
    throw new Error(`full ${url}`);
  };
  const loadCard = async (url: string) => image(url);
  loadStudioPreview(urls, () => undefined, assert.fail, loadFull, loadCard);
  await tick();
  await tick();
  const first = fulls;
  assert.ok(first >= 3);
  loadStudioPreview(urls, () => undefined, assert.fail, loadFull, loadCard);
  await tick();
  await tick();
  assert.ok(fulls > first);
});

test("peekSettled reports fulfilled, rejected, and still-pending without swallowing the original promise", async () => {
  const pending = peekSettled(new Promise<string>(() => undefined));
  assert.equal((await pending).status, "pending");
  const ok = peekSettled(Promise.resolve("full"));
  assert.deepEqual(await ok, { status: "fulfilled", value: "full" });
  const boom = Promise.reject(new Error("404"));
  const result = await peekSettled(boom);
  assert.equal(result.status, "rejected");
  await assert.rejects(boom);
});

test("peekSettled attaches a handler before a later rejection so it is not unhandled", async () => {
  const stray: unknown[] = [];
  const onUnhandled = (error: unknown) => { stray.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    let rejectLater!: (error: Error) => void;
    const delayed = new Promise<string>((_, reject) => { rejectLater = reject; });
    assert.equal((await peekSettled(delayed)).status, "pending");
    rejectLater(new Error("late-fail"));
    await tick();
    await tick();
    assert.equal(stray.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("export plan keeps a shown set until full is ready and allows true fallback", () => {
  const setCard = image("sc");
  assert.deepEqual(planStudioExport("white", setCard, "pending"), { action: "compose", set: null });
  assert.deepEqual(planStudioExport("white_set", null, "pending"), { action: "compose", set: null });
  assert.deepEqual(planStudioExport("white_set", setCard, "pending"), { action: "defer-set-full" });
  assert.deepEqual(planStudioExport("white_set", setCard, "failed"), { action: "defer-set-full" });
  assert.deepEqual(planStudioExport("white_set", image("s"), "ready"), { action: "compose", set: "full" });
});

test("drawn-layer summary ignores unused set and records white_set fallback", () => {
  const cards = {
    product: { origin: "full" as const, fetch: "ready" as const },
    ground: { origin: "card" as const, fetch: "ready" as const },
    set: { origin: "card" as const, fetch: "ready" as const },
  };
  assert.deepEqual(studioPreviewSummary(cards, "white", image("s")), { source: "full", setFallback: false });
  assert.deepEqual(studioPreviewSummary(cards, "white_set", image("s")), { source: "mixed", setFallback: false });
  const noSet = { ...cards, set: { origin: "none" as const, fetch: "failed" as const } };
  assert.deepEqual(studioPreviewSummary(noSet, "white_set", null), { source: "mixed", setFallback: true });
  const allFull = {
    product: { origin: "full" as const, fetch: "ready" as const },
    ground: { origin: "full" as const, fetch: "ready" as const },
    set: { origin: "none" as const, fetch: "pending" as const },
  };
  assert.deepEqual(studioPreviewSummary(allFull, "white_set", null), { source: "full", setFallback: true });
  assert.equal(studioDrawnUpgradeFailed({
    product: { origin: "card", fetch: "ready", upgradeFailed: true },
    ground: { origin: "full", fetch: "ready" },
    set: { origin: "none", fetch: "failed", upgradeFailed: true },
  }, "white", null), true);
  assert.equal(studioDrawnUpgradeFailed({
    product: { origin: "full", fetch: "ready" },
    ground: { origin: "full", fetch: "ready" },
    set: { origin: "none", fetch: "failed", upgradeFailed: true },
  }, "white", null), false);
});
