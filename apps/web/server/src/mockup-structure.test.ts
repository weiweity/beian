import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-mockup-structure-");

const { DATA_DIR } = await import("./config.js");
const {
  acceptStructureConfirmation,
  beginStructureConfirmation,
  deleteMockup,
  finishStructureConfirmation,
  prepareStructureConfirmation,
  publicMockup,
  saveMockup,
} = await import("./mockup.js");

function reviewJob() {
  const id = "abc123abc123";
  const root = join(DATA_DIR, "mockups", id);
  mkdirSync(root, { recursive: true });
  const source = join(root, "source.ai");
  const resolution = join(root, "structure_resolution.json");
  const artwork = join(root, "artwork.pdf");
  const manifest = join(root, "manifest.json");
  writeFileSync(source, "source");
  writeFileSync(artwork, "%PDF");
  writeFileSync(
    resolution,
    JSON.stringify({
      topology: {
        face_proposal: [
          {
            id: "proposal-face-0001",
            bounds_mm: [0, 0, 30, 50],
            centroid_mm: [15, 25],
            size_mm: [30, 50],
            points_mm: [[0, 0], [30, 0], [30, 50], [0, 50]],
            rectangular: true,
            secret: "/never/expose",
          },
        ],
      },
    }),
  );
  writeFileSync(
    manifest,
    JSON.stringify({ output_root: root, products: [{ code: "abc123ab", source_ai: source }] }),
  );
  const job = {
    id,
    status: "review_required" as const,
    created_at: "2026-08-27T00:00:00.000Z",
    files: [],
    source_path: source,
    manifest_path: manifest,
    job_kind: "mockup" as const,
    job_status: "waiting_input" as const,
    structure_engine: "v2" as const,
    structure_status: "review_required" as const,
    structure_resolution_path: resolution,
    structure_artwork_path: artwork,
    structure_source_sha256: "a".repeat(64),
  };
  saveMockup(job);
  return { job, root };
}

describe("mockup structure confirmation persistence", () => {
  it("publishes only a bounded face preview, never local paths", () => {
    const { job } = reviewJob();
    const view = publicMockup(job);
    assert.deepEqual(view.structure_preview?.faces[0], {
      id: "proposal-face-0001",
      bounds_mm: [0, 0, 30, 50],
      centroid_mm: [15, 25],
      size_mm: [30, 50],
      points_mm: [[0, 0], [30, 0], [30, 50], [0, 50]],
      rectangular: true,
    });
    assert.equal(JSON.stringify(view).includes("/never/expose"), false);
    assert.equal(JSON.stringify(view).includes(DATA_DIR), false);
  });

  it("writes a decision contract and resumes from an approved sidecar", () => {
    const { job, root } = reviewJob();
    const faces = [
      { id: "a", role: "front" as const, quarter_turns: 0 as const },
      { id: "b", role: "right" as const, quarter_turns: 0 as const },
      { id: "c", role: "back" as const, quarter_turns: 0 as const },
      { id: "d", role: "left" as const, quarter_turns: 0 as const },
      { id: "e", role: "top" as const, quarter_turns: 0 as const },
      { id: "f", role: "bottom" as const, quarter_turns: 0 as const },
    ];
    const files = prepareStructureConfirmation(job, faces);
    const persistedFaces = [...faces].sort((left, right) =>
      left.role.localeCompare(right.role) || left.id.localeCompare(right.id),
    );
    assert.deepEqual(JSON.parse(readFileSync(files.decisions, "utf8")), { faces: persistedFaces });
    assert.match(basename(files.decisions), /^structure_decisions-[0-9a-f]{16}\.json$/);
    assert.match(basename(files.output), /^structure_approved-[0-9a-f]{16}\.json$/);
    assert.deepEqual(prepareStructureConfirmation(job, [...faces].reverse()), files);
    const changed = prepareStructureConfirmation(job, [
      { ...faces[0], quarter_turns: 1 as const },
      ...faces.slice(1),
    ]);
    assert.notEqual(changed.decisions, files.decisions);
    assert.notEqual(changed.output, files.output);
    writeFileSync(files.output, JSON.stringify({ schema: "packaging-structure/1" }));
    const resumed = acceptStructureConfirmation(job, files.output);
    assert.equal(resumed.structure_status, "ready");
    assert.equal(resumed.job_status, "queued");
    assert.equal(resumed.status, "queued");
    assert.ok(resumed.manifest_path?.endsWith("confirmed_manifest.json"));
    assert.equal(existsSync(resumed.manifest_path || ""), true);
    const manifest = JSON.parse(readFileSync(resumed.manifest_path || "", "utf8"));
    assert.equal(manifest.products[0].structure_sidecar, files.output);
    assert.equal(manifest.products[0].artwork_pdf, join(root, "artwork.pdf"));
  });

  it("blocks duplicate confirmation and deletion while the confirmation worker is active", () => {
    const { job } = reviewJob();
    beginStructureConfirmation(job);
    try {
      assert.throws(() => beginStructureConfirmation(job), /正在确认/);
      assert.throws(() => deleteMockup(job.id), /暂时不能删除/);
    } finally {
      finishStructureConfirmation(job.id);
    }
  });
});
