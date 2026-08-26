import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { rasterAiFile } from "./aiRaster.js";
import { makeTestTempDir } from "./testTemp.js";

describe("rasterAiFile fake COM", () => {
  it("prints last-line JSON and writes a png", async () => {
    const dir = makeTestTempDir("beian-ai-");
    const r = await rasterAiFile({ source: join(dir, "art.ai"), outDir: dir });
    assert.equal(r.ok, true);
    assert.ok(r.png);
    assert.match(r.message, /假 COM|PNG/);
  });

  it("fail.ai returns Chinese failure", async () => {
    const dir = makeTestTempDir("beian-ai-");
    const r = await rasterAiFile({ source: join(dir, "x.fail.ai"), outDir: dir });
    assert.equal(r.ok, false);
    assert.match(r.message, /COM|打不开/);
  });
});
