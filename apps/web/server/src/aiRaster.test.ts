import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isPdfCompatibleAi, rasterAiFile } from "./aiRaster.js";
import { makeTestTempDir } from "./testTemp.js";

describe("rasterAiFile fake COM", () => {
  it("recognizes only PDF-compatible Illustrator files", () => {
    const dir = makeTestTempDir("beian-ai-");
    const pdfAi = join(dir, "pdf-compatible.ai");
    const nativeAi = join(dir, "native.ai");
    writeFileSync(pdfAi, "%PDF-1.7\n");
    writeFileSync(nativeAi, "%!PS-Adobe-3.0\n");
    assert.equal(isPdfCompatibleAi(pdfAi), true);
    assert.equal(isPdfCompatibleAi(nativeAi), false);
    assert.equal(isPdfCompatibleAi(join(dir, "missing.ai")), false);
  });

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
