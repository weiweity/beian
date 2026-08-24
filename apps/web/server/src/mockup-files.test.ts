import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-mockup-files-"));

const { collectOutputs, isWhiteFile } = await import("./mockup.js");

describe("collectOutputs", () => {
  it("keeps front/back white renders and ignores ai-raster and ppt qa pngs", () => {
    const root = mkdtempSync(join(tmpdir(), "beian-pack-out-"));
    mkdirSync(join(root, "qa"));
    writeFileSync(join(root, "ai-raster.png"), "nope");
    writeFileSync(join(root, "qa", "slide-01.png"), "nope");
    writeFileSync(join(root, "26H06A_x_front_right_white.png"), "ok");
    writeFileSync(join(root, "26H06A_x_back_left_white.png"), "ok");
    writeFileSync(join(root, "box.glb"), "glb");
    writeFileSync(join(root, "deck.pptx"), "ppt");
    writeFileSync(join(root, "knife.pdf"), "knife");
    writeFileSync(join(root, "26F23A_white_sheet.pdf"), "pdf");
    const files = collectOutputs(root);
    const keys = files.map((f) => f.key).sort();
    assert.deepEqual(keys, ["glb", "ppt", "sheet", "white_a", "white_b"].sort());
    assert.match(files.find((f) => f.key === "sheet")?.name || "", /white_sheet/);
    assert.equal(files.find((f) => f.key === "white_a")?.name.includes("front_right"), true);
    assert.doesNotMatch(files.map((f) => f.name).join(" "), /ai-raster|slide-01/);
  });

  it("does not promote leftover pngs to white_a/white_b", () => {
    const root = mkdtempSync(join(tmpdir(), "beian-pack-other-"));
    writeFileSync(join(root, "preview.png"), "nope");
    writeFileSync(join(root, "box.glb"), "glb");
    const files = collectOutputs(root);
    assert.deepEqual(
      files.map((f) => f.key).sort(),
      ["glb"],
    );
  });

  it("returns empty when pack output dir is missing", () => {
    assert.deepEqual(collectOutputs(join(tmpdir(), "beian-pack-missing-nope")), []);
  });

  it("rejects leftover job.json keys that are not front/back renders", () => {
    assert.equal(isWhiteFile("white_a", "ai-raster.png"), false);
    assert.equal(isWhiteFile("white_b", "qa/slide-01.png"), false);
    assert.equal(isWhiteFile("white_a", "26H06A_front_right_white.png"), true);
    assert.equal(isWhiteFile("glb", "box.glb"), true);
  });

  it("matches white renders case-insensitively and keeps the first key", () => {
    const root = mkdtempSync(join(tmpdir(), "beian-pack-case-"));
    writeFileSync(join(root, "BOX_FRONT_RIGHT_WHITE.PNG"), "ok");
    writeFileSync(join(root, "BOX.GLB"), "glb");
    writeFileSync(join(root, "extra_front_right.png"), "dup");
    const files = collectOutputs(root);
    assert.deepEqual(
      files.map((f) => f.key).sort(),
      ["glb", "white_a"],
    );
    assert.equal(files.find((f) => f.key === "white_a")?.name, "BOX_FRONT_RIGHT_WHITE.PNG");
  });

  it("does not treat a pdf named front_right as a white render", () => {
    const root = mkdtempSync(join(tmpdir(), "beian-pack-pdf-white-"));
    writeFileSync(join(root, "foo_front_right.pdf"), "%PDF");
    writeFileSync(join(root, "box.glb"), "glb");
    const files = collectOutputs(root);
    assert.deepEqual(files.map((f) => f.key).sort(), ["glb"]);
  });
});
