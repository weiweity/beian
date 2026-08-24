import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const srcPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../workers/packaging/ppt/build_product_ppt.mjs",
);
const src = readFileSync(srcPath, "utf8");

describe("build_product_ppt contract", () => {
  it("builds one slide with front and back white renders", () => {
    assert.equal([...src.matchAll(/presentation\.slides\.add\(\)/g)].length, 1);
    assert.match(src, /"front-right-render"/);
    assert.match(src, /"back-left-render"/);
    assert.match(src, /"front-caption"/);
    assert.match(src, /"back-caption"/);
    assert.doesNotMatch(src, /const detail = presentation\.slides\.add/);
    assert.doesNotMatch(src, /"page-number"/);
    assert.doesNotMatch(src, /达肤妍男士\\n/);
    assert.match(src, /height: 40/);
    assert.match(src, /height: 540/);
  });
});
