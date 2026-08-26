import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-mockup-cache-");

const {
  MAX_MOCKUP_CACHE_ITEMS,
  mockupCacheSize,
  resetMockupCache,
  saveMockup,
} = await import("./mockup.js");

describe("mockup metadata cache", () => {
  it("keeps historical job metadata in a bounded LRU", () => {
    resetMockupCache();
    for (let index = 0; index < MAX_MOCKUP_CACHE_ITEMS + 12; index += 1) {
      saveMockup({
        id: index.toString(16).padStart(12, "0"),
        status: "done",
        title: `打样 ${index}`,
        created_at: new Date(1_700_000_000_000 + index).toISOString(),
        owner: "ou_cache",
        files: [],
      });
    }
    assert.equal(mockupCacheSize(), MAX_MOCKUP_CACHE_ITEMS);
  });
});
