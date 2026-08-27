import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  prepareReviewMedia,
  prepareReviewMediaAfterFailure,
  type ReviewImageProbe,
} from "./reviewMedia.js";

function probe(
  result: "ok" | "fail",
  natural = { width: 2400, height: 1600 },
): ReviewImageProbe {
  return {
    src: "",
    decoding: "auto",
    complete: result === "ok",
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    decode: () => result === "ok" ? Promise.resolve() : Promise.reject(new Error("decode failed")),
    onload: null,
    onerror: null,
  };
}

describe("prepareReviewMedia", () => {
  it("decodes the SVG before exposing it to the review canvas", async () => {
    const created: ReviewImageProbe[] = [];
    const media = await prepareReviewMedia(
      { url: "/api/tasks/1/review.svg", raster_url: "/api/tasks/1/page.png", width: 5600, height: 3200 },
      {
        createProbe: () => {
          const next = probe("ok");
          created.push(next);
          return next;
        },
      },
    );

    assert.equal(media.source, "svg");
    assert.equal(media.url, "/api/tasks/1/review.svg");
    assert.deepEqual([media.width, media.height], [5600, 3200]);
    assert.equal(created[0]?.decoding, "sync");
  });

  it("falls back to the high-resolution raster when SVG decoding fails", async () => {
    const attempts = [probe("fail"), probe("ok", { width: 6000, height: 4000 })];
    const media = await prepareReviewMedia(
      { url: "/review.svg", raster_url: "/page.png" },
      { createProbe: () => attempts.shift() as ReviewImageProbe },
    );

    assert.equal(media.source, "raster");
    assert.equal(media.url, "/page.png");
    assert.deepEqual([media.width, media.height], [6000, 4000]);
  });

  it("uses a raster-only review page without inventing an SVG candidate", async () => {
    let created = 0;
    const media = await prepareReviewMedia(
      { raster_url: "/page.png" },
      {
        createProbe: () => {
          created += 1;
          return probe("ok", { width: 5000, height: 3000 });
        },
      },
    );

    assert.equal(created, 1);
    assert.equal(media.source, "raster");
    assert.equal(media.url, "/page.png");
  });

  it("deduplicates identical SVG and raster URLs", async () => {
    let created = 0;
    await assert.rejects(
      prepareReviewMedia(
        { url: "/same", raster_url: "/same" },
        {
          createProbe: () => {
            created += 1;
            return probe("fail");
          },
        },
      ),
      /高清核对图加载失败/,
    );
    assert.equal(created, 1);
  });

  it("falls back when a decoded candidate still has no valid dimensions", async () => {
    const attempts = [probe("ok", { width: 0, height: 0 }), probe("ok", { width: 4200, height: 2800 })];
    const media = await prepareReviewMedia(
      { url: "/review.svg", raster_url: "/page.png" },
      { createProbe: () => attempts.shift() as ReviewImageProbe },
    );

    assert.equal(media.source, "raster");
    assert.deepEqual([media.width, media.height], [4200, 2800]);
  });

  it("arms load handlers before assigning src when decode is unavailable", async () => {
    let srcValue = "";
    let handlerWasReady = false;
    const legacyProbe: ReviewImageProbe = {
      get src() {
        return srcValue;
      },
      set src(value: string) {
        srcValue = value;
        handlerWasReady = typeof legacyProbe.onload === "function";
        queueMicrotask(() => legacyProbe.onload?.());
      },
      decoding: "auto",
      complete: false,
      naturalWidth: 3200,
      naturalHeight: 1800,
      onload: null,
      onerror: null,
    };

    const media = await prepareReviewMedia(
      { url: "/review.svg", width: 3200, height: 1800 },
      { createProbe: () => legacyProbe },
    );

    assert.equal(handlerWasReady, true);
    assert.equal(media.url, "/review.svg");
  });

  it("accepts an already-cached legacy image", async () => {
    const cached = probe("ok", { width: 3200, height: 1800 });
    delete cached.decode;

    const media = await prepareReviewMedia(
      { url: "/cached.svg" },
      { createProbe: () => cached },
    );

    assert.equal(media.url, "/cached.svg");
    assert.deepEqual([media.width, media.height], [3200, 1800]);
  });

  it("falls back after a legacy image fires onerror", async () => {
    let attempt = 0;
    const media = await prepareReviewMedia(
      { url: "/broken.svg", raster_url: "/page.png" },
      {
        createProbe: () => {
          attempt += 1;
          if (attempt > 1) return probe("ok", { width: 4800, height: 3200 });
          const legacy = probe("fail");
          delete legacy.decode;
          Object.defineProperty(legacy, "src", {
            get: () => "",
            set: () => queueMicrotask(() => legacy.onerror?.()),
          });
          return legacy;
        },
      },
    );

    assert.equal(media.source, "raster");
    assert.equal(attempt, 2);
  });

  it("fails clearly when neither review surface can be decoded", async () => {
    await assert.rejects(
      prepareReviewMedia(
        { url: "/review.svg", raster_url: "/page.png" },
        { createProbe: () => probe("fail") },
      ),
      /高清核对图加载失败/,
    );
  });

  it("skips the failed display URL and predecodes the raster fallback", async () => {
    const media = await prepareReviewMediaAfterFailure(
      { url: "/review.svg", raster_url: "/page.png" },
      "/review.svg",
      { createProbe: () => probe("ok", { width: 5200, height: 3400 }) },
    );

    assert.equal(media.source, "raster");
    assert.equal(media.url, "/page.png");
  });

  it("cancels stale media work before probing another page", async () => {
    const controller = new AbortController();
    controller.abort();
    let created = 0;

    await assert.rejects(
      prepareReviewMedia(
        { url: "/review.svg", raster_url: "/page.png" },
        {
          signal: controller.signal,
          createProbe: () => {
            created += 1;
            return probe("ok");
          },
        },
      ),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(created, 0);
  });

  it("times out a stalled decode instead of waiting forever", async () => {
    const stalled = probe("ok");
    stalled.decode = () => new Promise<void>(() => undefined);

    await assert.rejects(
      prepareReviewMedia(
        { url: "/stalled.svg" },
        { createProbe: () => stalled, timeoutMs: 0 },
      ),
      /高清核对图加载失败/,
    );
    assert.equal(stalled.src, "");
  });
});
