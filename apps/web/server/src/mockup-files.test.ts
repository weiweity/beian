import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-mockup-files-");

const { collectOutputs, fileOf, isWhiteFile, mockupFileBrokenMessage, publicMockup, publicMockupSummary, saveMockup } = await import("./mockup.js");

describe("collectOutputs", () => {
  it("keeps front/back white renders and ignores ai-raster and ppt qa pngs", () => {
    const root = makeTestTempDir("beian-pack-out-");
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
    const root = makeTestTempDir("beian-pack-other-");
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
    const root = makeTestTempDir("beian-pack-case-");
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
    const root = makeTestTempDir("beian-pack-pdf-white-");
    writeFileSync(join(root, "foo_front_right.pdf"), "%PDF");
    writeFileSync(join(root, "box.glb"), "glb");
    const files = collectOutputs(root);
    assert.deepEqual(files.map((f) => f.key).sort(), ["glb"]);
  });

  it("collects exact panel_*.png print faces as read keys and ignores other pngs", () => {
    const root = makeTestTempDir("beian-pack-read-");
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "panel_front.png"), "front");
    writeFileSync(join(root, "assets", "panel_back.png"), "back");
    writeFileSync(join(root, "preview.png"), "nope");
    writeFileSync(join(root, "ai-raster.png"), "nope");
    writeFileSync(join(root, "26H06A_x_front_right_white.png"), "white");
    const files = collectOutputs(root);
    assert.deepEqual(
      files.map((f) => f.key).sort(),
      ["read_back", "read_front", "white_a"],
    );
    assert.equal(files.find((f) => f.key === "read_front")?.name, "panel_front.png");
    assert.equal(
      files.some((f) => f.key.startsWith("read_") && /front_right|ai-raster|preview/.test(f.name)),
      false,
    );
  });

  it("collects all six print faces and ignores near-miss panel names", () => {
    const root = makeTestTempDir("beian-pack-read-six-");
    mkdirSync(join(root, "assets"));
    for (const face of ["front", "back", "right", "left", "top", "bottom"]) {
      writeFileSync(join(root, "assets", `panel_${face}.png`), face);
    }
    writeFileSync(join(root, "assets", "panel_front_print.png"), "nope");
    writeFileSync(join(root, "assets", "panel-front.png"), "nope");
    writeFileSync(join(root, "assets", "panel_mystery.png"), "nope");
    writeFileSync(join(root, "assets", "front.png"), "nope");
    const files = collectOutputs(root);
    assert.deepEqual(
      files.map((f) => f.key).sort(),
      ["read_back", "read_bottom", "read_front", "read_left", "read_right", "read_top"],
    );
    assert.equal(files.find((f) => f.key === "read_front")?.name.toLowerCase(), "panel_front.png");
    assert.equal(
      files.some((f) => /print|mystery|panel-front|^front\.png$/i.test(f.name)),
      false,
    );
  });

  it("rejects a leftover raster labeled as a print face", () => {
    assert.equal(isWhiteFile("read_front", "panel_front.png"), true);
    assert.equal(isWhiteFile("read_front", "PANEL_FRONT.PNG"), true);
    assert.equal(isWhiteFile("read_front", "ai-raster.png"), false);
    assert.equal(isWhiteFile("read_front", "26H06A_x_front_right_white.png"), false);
    assert.equal(isWhiteFile("read_back", "panel_front.png"), false);
    assert.equal(mockupFileBrokenMessage("read_front"), "这张印刷面图坏了，不是 PNG。重新打样后才能读字。");
    assert.match(mockupFileBrokenMessage("white_a"), /白底图坏了/);
  });

  it("exposes on-disk panel pngs for old jobs that never listed read keys", () => {
    const id = "cafebabeface";
    const dir = join(process.env.WB_DATA_DIR || "", "mockups", id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "box.glb"), "glb");
    writeFileSync(join(dir, "26H06A_x_front_right_white.png"), "white-a");
    writeFileSync(join(dir, "26H06A_x_back_left_white.png"), "white-b");
    writeFileSync(join(dir, "assets", "panel_front.png"), "front");
    writeFileSync(join(dir, "assets", "panel_back.png"), "back");
    const listed = [
      { key: "glb", path: join(dir, "box.glb"), name: "box.glb" },
      { key: "white_a", path: join(dir, "26H06A_x_front_right_white.png"), name: "26H06A_x_front_right_white.png" },
      { key: "white_b", path: join(dir, "26H06A_x_back_left_white.png"), name: "26H06A_x_back_left_white.png" },
    ];
    saveMockup({
      id,
      status: "done",
      created_at: "2026-09-02T00:00:00Z",
      files: listed,
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const job = {
      id,
      status: "done" as const,
      created_at: "2026-09-02T00:00:00Z",
      files: listed,
    };
    assert.equal(fileOf(job, "read_front")?.name, "panel_front.png");
    assert.equal(fileOf(job, "read_back")?.path?.endsWith("panel_back.png"), true);
    assert.equal(fileOf(job, "white_a")?.name.includes("front_right"), true);
    assert.equal(fileOf(job, "white_b")?.name.includes("back_left"), true);
    const view = publicMockup(job);
    assert.deepEqual(
      view.files.map((f) => f.key).sort(),
      ["glb", "read_back", "read_front", "white_a", "white_b"],
    );
    assert.equal(
      view.files.every((f) => !("path" in f) && !JSON.stringify(f).includes(dir)),
      true,
    );
    assert.equal(
      publicMockupSummary(job).files.some((f) => String(f.key).startsWith("read_")),
      false,
    );
  });

  it("still finds assets/panel pngs when the listed read path is gone", () => {
    const id = "deadreadface01";
    const dir = join(process.env.WB_DATA_DIR || "", "mockups", id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "panel_front.png"), "front");
    const job = {
      id,
      status: "done" as const,
      created_at: "2026-09-02T00:00:00Z",
      files: [{ key: "read_front", path: join(dir, "gone", "panel_front.png"), name: "panel_front.png" }],
    };
    assert.match(fileOf(job, "read_front")?.path || "", /assets[/\\]panel_front\.png$/);
  });

  it("does not let nested or root panel pngs become read keys", () => {
    const root = makeTestTempDir("beian-pack-read-decoy-");
    mkdirSync(join(root, "assets"));
    mkdirSync(join(root, "scratch"));
    writeFileSync(join(root, "assets", "panel_front.png"), "real");
    writeFileSync(join(root, "scratch", "panel_front.png"), "decoy");
    writeFileSync(join(root, "panel_back.png"), "root-decoy");
    writeFileSync(join(root, "scratch", "panel_top.png"), "nested-only");
    const files = collectOutputs(root);
    assert.deepEqual(files.map((f) => f.key).sort(), ["read_front"]);
    assert.match(files.find((f) => f.key === "read_front")?.path || "", /assets[/\\]panel_front\.png$/);
  });

  it("serves assets/panel even when listed path is a nested decoy or job-root file", () => {
    const id = "decoyreadface1";
    const dir = join(process.env.WB_DATA_DIR || "", "mockups", id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    mkdirSync(join(dir, "scratch"), { recursive: true });
    writeFileSync(join(dir, "assets", "panel_front.png"), "real");
    writeFileSync(join(dir, "scratch", "panel_front.png"), "decoy");
    writeFileSync(join(dir, "panel_front.png"), "root-decoy");
    writeFileSync(join(dir, "assets", "panel_back.png"), "back");
    const job = {
      id,
      status: "done" as const,
      created_at: "2026-09-02T00:00:00Z",
      files: [
        { key: "read_front", path: join(dir, "scratch", "panel_front.png"), name: "panel_front.png" },
        { key: "read_back", path: join(dir, "panel_back.png"), name: "panel_back.png" },
      ],
    };
    assert.match(fileOf(job, "read_front")?.path || "", /assets[/\\]panel_front\.png$/);
    assert.match(fileOf(job, "read_back")?.path || "", /assets[/\\]panel_back\.png$/);
    assert.equal(fileOf(job, "read_front")?.path?.includes("scratch"), false);
  });
});
