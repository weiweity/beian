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

function previewFaceIds(): string[] {
  return Array.from({ length: 6 }, (_, index) => `proposal-face-${String(index + 1).padStart(4, "0")}`);
}

function reviewJob() {
  const id = "abc123abc123";
  const root = join(DATA_DIR, "mockups", id);
  mkdirSync(root, { recursive: true });
  const source = join(root, "source.ai");
  const resolution = join(root, "structure_resolution.json");
  const artwork = join(root, "artwork.pdf");
  const artworkPreview = join(root, "structure_preview.png");
  const manifest = join(root, "manifest.json");
  writeFileSync(source, "source");
  writeFileSync(artwork, "%PDF");
  writeFileSync(artworkPreview, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const previewFaces = Array.from({ length: 6 }, (_, index) => ({
    id: `proposal-face-${String(index + 1).padStart(4, "0")}`,
    bounds_mm: [index * 30, 0, index * 30 + 30, 50],
    centroid_mm: [index * 30 + 15, 25],
    size_mm: [30, 50],
    points_mm: [[index * 30, 0], [index * 30 + 30, 0], [index * 30 + 30, 50], [index * 30, 50]],
    rectangular: true,
    secret: "/never/expose",
  }));
  writeFileSync(
    resolution,
    JSON.stringify({
      structure: { source: { page_size: [210, 297] } },
      topology: {
        face_proposal: previewFaces,
        net_proposals: [{
          id: "box-net-0001",
          face_ids: previewFaces.map((face) => face.id),
          body_face_ids: previewFaces.slice(0, 4).map((face) => face.id),
          cap_face_ids: previewFaces.slice(4).map((face) => face.id),
          strip_axis: "x",
          bounds_mm: [0, 0, 180, 50],
          secret: "/never/expose-net",
        }],
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
    structure_artwork_preview_path: artworkPreview,
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
    assert.deepEqual(view.structure_preview?.net_proposals, [{
      id: "box-net-0001",
      face_ids: previewFaceIds(),
      body_face_ids: previewFaceIds().slice(0, 4),
      cap_face_ids: previewFaceIds().slice(4),
      strip_axis: "x",
      bounds_mm: [0, 0, 180, 50],
    }]);
    assert.deepEqual(view.structure_preview?.page_size_mm, [210, 297]);
    assert.equal(view.structure_preview?.image_url, `/api/mockups/${job.id}/structure-preview`);
  });

  it("drops malformed or unbounded whole-net proposals instead of exposing raw guesses", () => {
    const { job } = reviewJob();
    const resolutionPath = job.structure_resolution_path || "";
    const resolution = JSON.parse(readFileSync(resolutionPath, "utf8"));
    const valid = resolution.topology.net_proposals[0];
    resolution.topology.net_proposals = [
      valid,
      { ...valid, id: "raw-rectangle-1" },
    ];
    writeFileSync(resolutionPath, JSON.stringify(resolution));
    assert.deepEqual(
      publicMockup(job).structure_preview?.net_proposals.map((proposal) => proposal.id),
      ["box-net-0001"],
    );
    assert.equal(JSON.stringify(publicMockup(job)).includes("/never/expose-net"), false);

    resolution.topology.net_proposals = [
      { ...valid, id: "raw-rectangle-1" },
      { ...valid, face_ids: [...valid.face_ids.slice(0, 5), valid.face_ids[0]] },
      { ...valid, body_face_ids: valid.body_face_ids.slice(0, 3) },
      { ...valid, cap_face_ids: [valid.cap_face_ids[0], valid.body_face_ids[0]] },
      { ...valid, strip_axis: "diagonal" },
      { ...valid, face_ids: [...valid.face_ids.slice(0, 5), "missing-face"] },
    ];
    writeFileSync(resolutionPath, JSON.stringify(resolution));

    assert.deepEqual(publicMockup(job).structure_preview?.net_proposals, []);

    resolution.topology.net_proposals = Array.from({ length: 25 }, (_, index) => ({
      ...valid,
      id: `box-net-${String(index + 1).padStart(4, "0")}`,
    }));
    writeFileSync(resolutionPath, JSON.stringify(resolution));
    assert.deepEqual(publicMockup(job).structure_preview?.net_proposals, []);

    delete resolution.topology.net_proposals;
    writeFileSync(resolutionPath, JSON.stringify(resolution));
    assert.deepEqual(publicMockup(job).structure_preview?.net_proposals, []);
  });

  it("writes a decision contract and resumes from an approved sidecar", () => {
    const { job, root } = reviewJob();
    const anchor = {
      proposal_id: "box-net-0001",
      front_face_id: "proposal-face-0002",
      quarter_turns: 0 as const,
    };
    const files = prepareStructureConfirmation(job, { anchor });
    assert.deepEqual(JSON.parse(readFileSync(files.decisions, "utf8")), { anchor });
    assert.match(basename(files.decisions), /^structure_decisions-[0-9a-f]{16}\.json$/);
    assert.match(basename(files.output), /^structure_approved-[0-9a-f]{16}\.json$/);
    assert.deepEqual(prepareStructureConfirmation(job, { anchor: { ...anchor } }), files);
    const changed = prepareStructureConfirmation(job, {
      anchor: { ...anchor, quarter_turns: 1 as const },
    });
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
