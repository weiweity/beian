import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanLocalApps } from "./scanLocal.js";

describe("scanLocalApps", () => {
  it("returns whitelist roots and never throws", () => {
    const r = scanLocalApps();
    assert.ok(Array.isArray(r.hits));
    assert.ok(Array.isArray(r.roots));
    assert.equal(typeof r.timedOut, "boolean");
    assert.ok(r.hits.every((h) => h.path && h.kind));
  });
});
