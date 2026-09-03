import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-mockup-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { DATA_DIR } = await import("./config.js");
const { publicMockup, saveMockup } = await import("./mockup.js");
const {
  ILLUSTRATOR_AGENT_HEARTBEAT,
  ILLUSTRATOR_AGENT_PIPE,
  ILLUSTRATOR_AGENT_PROTOCOL,
  ILLUSTRATOR_AGENT_RELEASE_VERSION,
  ILLUSTRATOR_AGENT_SCRIPT_SHA256,
} = await import("./illustratorAgent.js");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function stageAi(token: string, name = "art.ai"): Promise<string> {
  const fd = new FormData();
  fd.set("file", new File([Buffer.from("%PDF-1.4\n")], name, { type: "application/postscript" }));
  const res = await app.request("/api/uploads", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { receipt?: string };
  assert.ok(body.receipt);
  return body.receipt;
}

function startMockup(token: string, receipt: string) {
  return app.request("/api/mockups/start", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ receipt, title: "打样" }),
  });
}

function pendingWorkerStop() {
  let release: (value: { code: number; stdout: string; stderr: string; timedOut: boolean }) => void = () => {};
  const promise = new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    release = resolve;
  });
  return {
    wait: () => promise,
    stop: () => release({ code: 1, stdout: "", stderr: "test stop", timedOut: false }),
  };
}

function seedOwnedFile(id: string, key: string, name: string, buf: Buffer, owner = "籽烨") {
  const dir = join(DATA_DIR, "mockups", id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, buf);
  saveMockup({
    id,
    status: "done",
    created_at: "2026-08-20T00:00:04Z",
    files: [{ key, path, name }],
    owner,
    job_kind: "mockup",
    job_status: "succeeded",
  });
}

function seedStructurePreviewJob(id: string, owner: string) {
  const dir = join(DATA_DIR, "mockups", id);
  mkdirSync(dir, { recursive: true });
  const resolution = join(dir, "structure_resolution.json");
  const sourceHash = "d".repeat(64);
  writeFileSync(resolution, JSON.stringify({
    structure: {
      structure_hash: `sha256:${"e".repeat(64)}`,
      source: { page_size: [210, 297], sha256: sourceHash },
    },
    topology: {
      face_proposal: [{
        id: "proposal-face-0001",
        bounds_mm: [0, 0, 30, 50],
        centroid_mm: [15, 25],
        rectangular: true,
      }],
      net_proposals: [],
    },
  }));
  saveMockup({
    id,
    status: "review_required",
    created_at: "2026-08-20T00:00:01Z",
    files: [],
    owner,
    job_kind: "mockup",
    job_status: "waiting_input",
    structure_engine: "v2",
    structure_status: "review_required",
    structure_resolution_path: resolution,
    structure_source_sha256: sourceHash,
  });
}

function seedStructureInputJob(id: string, owner: string) {
  const dir = join(DATA_DIR, "mockups", id);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "source.ai");
  const resolution = join(dir, "structure_resolution.json");
  const manifest = join(dir, "manifest.json");
  const artworkPreview = join(dir, "structure_preview.png");
  const sourceHash = "7".repeat(64);
  const names = ["结构线", "折线"];
  const candidateIds = names.map((name) => `proposal-layer-${createHash("sha256")
    .update(`${sourceHash}\0${name}`)
    .digest("hex")
    .slice(0, 16)}`);
  writeFileSync(source, "%PDF-1.4\n");
  writeFileSync(artworkPreview, PNG_MAGIC);
  writeFileSync(resolution, JSON.stringify({
    structure: { source: { sha256: sourceHash } },
    input_candidates: {
      schema: "packaging-structure-input-candidates/2",
      source_sha256: sourceHash,
      proposal_layers: names.map((name, index) => ({
        id: candidateIds[index],
        name,
        stroke_only_path_count: index === 0 ? 36 : 12,
      })),
      truncated: false,
    },
  }));
  writeFileSync(manifest, JSON.stringify({
    output_root: dir,
    products: [{ code: id.slice(0, 8), source_ai: source, structure_engine: "v2" }],
  }));
  saveMockup({
    id,
    status: "review_required",
    created_at: "2026-09-01T00:00:00Z",
    files: [],
    owner,
    source_path: source,
    manifest_path: manifest,
    job_kind: "mockup",
    job_status: "waiting_input",
    structure_engine: "v2",
    structure_status: "review_required",
    structure_code: "structure_semantics_missing",
    structure_resolution_path: resolution,
    structure_artwork_preview_path: artworkPreview,
    structure_source_sha256: sourceHash,
  });
  return { artworkPreview, candidateId: candidateIds[0], candidateIds, dir };
}

function uniqueNetResolution(sourceHash: string) {
  const faces = Array.from({ length: 7 }, (_, index) => ({
    id: `proposal-face-${String(index + 1).padStart(4, "0")}`,
    bounds_mm: [index * 30, 0, index * 30 + 30, 50],
    centroid_mm: [index * 30 + 15, 25],
    size_mm: [30, 50],
    points_mm: [
      [index * 30, 0],
      [index * 30 + 30, 0],
      [index * 30 + 30, 50],
      [index * 30, 50],
    ],
    rectangular: true,
  }));
  const structureHash = `sha256:${"b".repeat(64)}`;
  return {
    structure: { structure_hash: structureHash, source: { page_size: [210, 297], sha256: sourceHash } },
    topology: {
      face_proposal: faces,
      net_proposals: [{
        schema: "box-net-proposal/3",
        structure_hash: structureHash,
        id: "box-net-0123456789abcdef",
        face_ids: faces.map((face) => face.id),
        body_face_ids: faces.slice(0, 4).map((face) => face.id),
        cap_face_ids: [faces[4].id, faces[6].id],
        strip_axis: "x",
        bounds_mm: [0, 0, 180, 50],
        dimensions_mm: { width: 30, depth: 20, height: 50 },
        valid_anchors: [{
          front_face_id: faces[1].id,
          quarter_turns: [0, 2],
          preferred_quarter_turns: 0,
        }],
        closure_assemblies: [
          {
            primary_face_id: faces[4].id,
            side: -1,
            extent: "full",
            closure_kind: "assembly",
            coverage_ratio: 1,
            members: [
              {
                face_id: faces[4].id,
                attached_body_face_id: faces[0].id,
                extent: "partial",
                coverage_ratio: 0.5,
              },
              {
                face_id: faces[5].id,
                attached_body_face_id: faces[2].id,
                extent: "partial",
                coverage_ratio: 0.5,
              },
            ],
          },
          {
            primary_face_id: faces[6].id,
            side: 1,
            extent: "full",
            closure_kind: "full",
            coverage_ratio: 1,
            members: [{
              face_id: faces[6].id,
              attached_body_face_id: faces[0].id,
              extent: "full",
              coverage_ratio: 1,
            }],
          },
        ],
      }],
    },
  };
}

describe("mockup http", () => {
  it("rejects unauthenticated list", async () => {
    const res = await app.request("/api/mockups");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /未登录/);
  });

  it("returns an empty list for a logged-in reviewer", async () => {
    const sess = issueSessionForTest("审稿", "reviewer", "ou_mockup_list_xx");
    const res = await app.request("/api/mockups", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown[];
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });
});

describe("mockup get", () => {
  it("lets a reviewer read a legacy ownerless team mockup", async () => {
    saveMockup({
      id: "121212121212",
      status: "done",
      created_at: "2026-08-20T00:00:00Z",
      files: [],
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const reviewer = issueSessionForTest("路人", "reviewer", "ou_mockup_ownerless");
    const allowed = await app.request("/api/mockups/121212121212", {
      headers: { authorization: `Bearer ${reviewer.token}` },
    });
    assert.equal(allowed.status, 200);
  });

  it("lets every logged-in role read and list another owner's mockup without leaking worker paths", async () => {
    saveMockup({
      id: "aaaaaaaaaaaa",
      status: "done",
      created_at: "2026-08-20T00:00:00Z",
      files: [{ key: "glb", path: "/secret/box.glb", name: "box.glb" }],
      owner: "籽烨",
      error: String.raw`找不到AI文件：C:\supply\data\客户新品.ai`,
      job_error: "包装源文件不存在：/Users/operator/Desktop/客户新品.ai",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    for (const [index, role] of (["admin", "reviewer", "viewer"] as const).entries()) {
      const sess = issueSessionForTest("路人", role, `ou_mockup_acl_${index}`);
      const res = await app.request("/api/mockups/aaaaaaaaaaaa", {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      assert.equal(res.status, 200);
      const detailText = await res.text();
      assert.doesNotMatch(detailText, /C:\\|\/Users\/|客户新品\.ai/);

      const list = await app.request("/api/mockups", {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      assert.equal(list.status, 200);
      const listText = await list.text();
      assert.match(listText, /aaaaaaaaaaaa/);
      assert.doesNotMatch(listText, /C:\\|\/Users\/|客户新品\.ai/);
    }
  });

  it("keeps structure previews out of the list while returning them from the detail endpoint", async () => {
    const id = "abababababab";
    seedStructurePreviewJob(id, "ou_preview_summary_owner");
    for (const [index, role] of (["admin", "reviewer", "viewer"] as const).entries()) {
      const sess = issueSessionForTest("路人", role, `ou_preview_summary_reader_${index}`);
      const list = await app.request("/api/mockups", {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      assert.equal(list.status, 200);
      const rows = (await list.json()) as Array<Record<string, unknown>>;
      const row = rows.find((item) => item.id === id);
      assert.ok(row);
      assert.equal(Object.hasOwn(row, "structure_preview"), false);

      const detail = await app.request(`/api/mockups/${id}`, {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      assert.equal(detail.status, 200);
      const body = (await detail.json()) as Record<string, unknown>;
      assert.equal(Object.hasOwn(body, "structure_preview"), true);
      assert.deepEqual(body.structure_preview, {
        faces: [{
          id: "proposal-face-0001",
          bounds_mm: [0, 0, 30, 50],
          centroid_mm: [15, 25],
          rectangular: true,
        }],
        net_proposals: [],
        page_size_mm: [210, 297],
      });
    }
  });

  it("lets every logged-in role read another owner's mockup result file", async () => {
    seedOwnedFile("bbbbbbbbbbbb", "glb", "box.glb", Buffer.from("glTF"), "ou_mockup_file_owner");
    for (const [index, role] of (["admin", "reviewer", "viewer"] as const).entries()) {
      const sess = issueSessionForTest("路人", role, `ou_mockup_file_acl_${index}`);
      const res = await app.request("/api/mockups/bbbbbbbbbbbb/files/glb", {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      assert.equal(res.status, 200);
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "glTF");
    }
  });

  it("GET mockup id that is not a tid is 400", async () => {
    const sess = issueSessionForTest("审稿", "reviewer", "ou_mockup_bad_id");
    const res = await app.request("/api/mockups/..%2fsecret", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 400);
  });

  it("GET missing mockup is 404", async () => {
    const sess = issueSessionForTest("审稿", "reviewer", "ou_mockup_get_xx");
    const res = await app.request("/api/mockups/ffffffffffff", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 404);
  });

  it("owner can delete a mockup; stranger cannot", async () => {
    saveMockup({
      id: "dddddddddddd",
      status: "failed",
      title: "喷雾",
      created_at: "2026-08-20T00:00:02Z",
      files: [],
      owner: "魏炜",
      job_kind: "mockup",
      job_status: "failed",
    });
    const stranger = issueSessionForTest("路人", "reviewer", "ou_mockup_del_no");
    const denied = await app.request("/api/mockups/dddddddddddd", {
      method: "DELETE",
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(denied.status, 403);
    const owner = issueSessionForTest("魏炜", "admin", "ou_mockup_del_ok");
    const ok = await app.request("/api/mockups/dddddddddddd", {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(ok.status, 200);
    const retried = await app.request("/api/mockups/dddddddddddd", {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(retried.status, 200);
    assert.equal(((await retried.json()) as { already_deleted?: boolean }).already_deleted, true);
    const gone = await app.request("/api/mockups/dddddddddddd", {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(gone.status, 404);
  });

  it("refuses to delete a running mockup", async () => {
    saveMockup({
      id: "eeeeeeeeeeee",
      status: "running",
      title: "跑着",
      created_at: "2026-08-20T00:00:03Z",
      files: [],
      owner: "魏炜",
      job_kind: "mockup",
      job_status: "running",
    });
    const owner = issueSessionForTest("魏炜", "admin", "ou_mockup_del_run");
    const res = await app.request("/api/mockups/eeeeeeeeeeee", {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(res.status, 409);
  });
});

describe("mockup structure artwork preview", () => {
  it("serves the preview to another logged-in worker without granting confirmation", async () => {
    const id = "facefeed0001";
    const dir = join(DATA_DIR, "mockups", id);
    mkdirSync(dir, { recursive: true });
    const preview = join(dir, "structure_preview.png");
    writeFileSync(preview, PNG_MAGIC);
    saveMockup({
      id,
      status: "review_required",
      created_at: "2026-08-27T00:00:00Z",
      files: [],
      owner: "ou_preview_owner",
      job_kind: "mockup",
      job_status: "waiting_input",
      structure_engine: "v2",
      structure_status: "review_required",
      structure_artwork_preview_path: preview,
    });
    const owner = issueSessionForTest("管理员", "admin", "ou_preview_owner");
    const own = await app.request(`/api/mockups/${id}/structure-preview`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("content-type"), "image/png");
    assert.equal(own.headers.get("cache-control"), "private, no-cache");
    assert.match(own.headers.get("etag") || "", /^W\/"/);
    assert.deepEqual(Buffer.from(await own.arrayBuffer()), PNG_MAGIC);
    const cached = await app.request(`/api/mockups/${id}/structure-preview`, {
      headers: { authorization: `Bearer ${owner.token}`, "if-none-match": own.headers.get("etag") || "" },
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get("etag"), own.headers.get("etag"));

    const stranger = issueSessionForTest("其他审核员", "reviewer", "ou_preview_other");
    const shared = await app.request(`/api/mockups/${id}/structure-preview`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(shared.status, 200);
    assert.deepEqual(Buffer.from(await shared.arrayBuffer()), PNG_MAGIC);
  });

  it("keeps the pre-selection artwork available after a selected layer is hidden", async () => {
    const id = "facefeed0002";
    const dir = join(DATA_DIR, "mockups", id);
    mkdirSync(dir, { recursive: true });
    const currentPreview = join(dir, "structure_preview.png");
    const inputPreview = join(dir, "structure-input-preview.png");
    const currentBytes = Buffer.concat([PNG_MAGIC, Buffer.from("current")]);
    const inputBytes = Buffer.concat([PNG_MAGIC, Buffer.from("before-selection")]);
    writeFileSync(currentPreview, currentBytes);
    writeFileSync(inputPreview, inputBytes);
    saveMockup({
      id,
      status: "review_required",
      created_at: "2026-09-01T00:00:00Z",
      files: [],
      owner: "ou_input_preview_owner",
      job_kind: "mockup",
      job_status: "waiting_input",
      structure_engine: "v2",
      structure_status: "review_required",
      structure_artwork_preview_path: currentPreview,
      structure_input_preview_path: inputPreview,
    });
    const viewer = issueSessionForTest("审核员", "reviewer", "ou_input_preview_viewer");
    const response = await app.request(`/api/mockups/${id}/structure-input-preview`, {
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("etag") || "", /^W\/"/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), inputBytes);
    const cached = await app.request(`/api/mockups/${id}/structure-input-preview`, {
      headers: { authorization: `Bearer ${viewer.token}`, "if-none-match": response.headers.get("etag") || "" },
    });
    assert.equal(cached.status, 304);
  });
});

describe("publicMockup", () => {
  it("drops disk paths from files", () => {
    const out = publicMockup({
      id: "m1",
      status: "done",
      created_at: "2026-08-20T00:00:00Z",
      files: [{ key: "glb", path: "/secret/data/mockups/m1/box.glb", name: "box.glb" }],
      structure_status: "review_required",
      structure_code: "structure_face_mapping_incomplete",
      structure_message: "请选择完整盒型的正面和朝向。",
      structure_resolution_path: "/secret/data/mockups/m1/structure_resolution.json",
      structure_sidecar_path: "/secret/data/mockups/m1/structure.json",
      structure_artwork_path: "/secret/data/mockups/m1/artwork.pdf",
    });
    assert.equal(out.id, "m1");
    assert.deepEqual(out.files, [{ key: "glb", name: "box.glb" }]);
    assert.equal(JSON.stringify(out).includes("/secret/"), false);
    assert.equal("path" in out.files[0], false);
    assert.equal(out.structure_status, "review_required");
    assert.equal(JSON.stringify(out).includes("structure_resolution.json"), false);
  });
});

describe("mockup structure input http", () => {
  it("inlines sanitized layer preview on GET detail and keeps it off the list", async () => {
    const id = "abababababa1";
    const { candidateIds } = seedStructureInputJob(id, "ou_preview_get");
    const resolutionPath = join(DATA_DIR, "mockups", id, "structure_resolution.json");
    const resolution = JSON.parse(readFileSync(resolutionPath, "utf8"));
    resolution.input_candidates.preview = {
      schema: "illustrator-layer-preview/1",
      page_size_points: [160, 90],
      layers: [{
        candidate_id: candidateIds[0],
        paths: [{
          closed: false,
          points: [[10, 20, 10, 20, 10, 20], [40, 60, 40, 60, 40, 60]],
        }],
        truncated: false,
      }],
    };
    writeFileSync(resolutionPath, JSON.stringify(resolution));

    const reviewer = issueSessionForTest("路人", "reviewer", "ou_preview_get");
    const hidden = await app.request(`/api/mockups/${id}`, {
      headers: { authorization: `Bearer ${reviewer.token}` },
    });
    assert.equal(hidden.status, 200);
    const hiddenBody = (await hidden.json()) as { structure_input?: unknown };
    assert.equal(hiddenBody.structure_input, undefined);

    const sess = issueSessionForTest("管理员", "admin", "ou_preview_get_admin");
    const detail = await app.request(`/api/mockups/${id}`, {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as {
      structure_input?: { preview?: { schema?: string; layers?: unknown[] } };
    };
    assert.equal(body.structure_input?.preview?.schema, "illustrator-layer-preview/1");
    assert.equal(body.structure_input?.preview?.layers?.length, 1);

    const list = await app.request("/api/mockups", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    const rows = (await list.json()) as Array<Record<string, unknown>>;
    const row = rows.find((item) => item.id === id);
    assert.ok(row);
    assert.equal(Object.hasOwn(row, "structure_input"), false);
  });

  it("bounds the small selection body before parsing JSON", async () => {
    const admin = issueSessionForTest("管理员", "admin", "ou_structure_input_limit");
    const oversized = JSON.stringify({
      candidate_ids: ["proposal-layer-0000000000000000"],
      padding: "x".repeat(16 * 1024),
    });
    const response = await app.request("/api/mockups/feed3000feed/structure/input", {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: oversized,
    });

    assert.equal(response.status, 413);
    assert.equal(
      ((await response.json()) as { code?: string }).code,
      "packaging_structure_selection_too_large",
    );
  });

  it("does not expose local paths when preparing the selection fails", async () => {
    const id = "feed4000feed";
    const { artworkPreview, candidateId } = seedStructureInputJob(id, "ou_structure_input_error_owner");
    rmSync(artworkPreview);
    mkdirSync(artworkPreview);
    const admin = issueSessionForTest("管理员", "admin", "ou_structure_input_error_admin");
    const response = await app.request(`/api/mockups/${id}/structure/input`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ candidate_ids: [candidateId] }),
    });
    const body = (await response.json()) as { code?: string; detail?: string };

    assert.equal(response.status, 500);
    assert.equal(body.code, "packaging_structure_selection_failed");
    assert.equal(JSON.stringify(body).includes(DATA_DIR), false);
    assert.equal(JSON.stringify(body).includes(artworkPreview), false);
  });

  it("lets an admin submit current candidate ids and resumes the same job", async () => {
    const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
    const id = "feed1000feed";
    const ownerId = "ou_structure_input_owner";
    const { candidateId, dir } = seedStructureInputJob(id, ownerId);
    const denied = await app.request(`/api/mockups/${id}/structure/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidate_ids: [candidateId] }),
    });
    assert.equal(denied.status, 401);

    const reviewer = issueSessionForTest("审稿", "reviewer", "ou_structure_input_reviewer");
    const reviewerDenied = await app.request(`/api/mockups/${id}/structure/input`, {
      method: "POST",
      headers: { authorization: `Bearer ${reviewer.token}`, "content-type": "application/json" },
      body: JSON.stringify({ candidate_ids: [candidateId] }),
    });
    assert.equal(reviewerDenied.status, 403);

    const admin = issueSessionForTest("管理员", "admin", "ou_structure_input_admin");
    const forged = await app.request(`/api/mockups/${id}/structure/input`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ candidate_ids: ["proposal-layer-0000000000000000"] }),
    });
    assert.equal(forged.status, 400);
    assert.equal(
      ((await forged.json()) as { code?: string }).code,
      "packaging_structure_selection_invalid",
    );

    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    setJobsTestHooks({
      runStructure: async () => {
        await runGate;
        return { code: 1, stdout: "", stderr: "synthetic stop", timedOut: false };
      },
    });
    try {
      const selected = await app.request(`/api/mockups/${id}/structure/input`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
        body: JSON.stringify({ candidate_ids: [candidateId] }),
      });
      assert.equal(selected.status, 200);
      const body = (await selected.json()) as {
        id?: string;
        status?: string;
        job_status?: string;
        structure_status?: string;
      };
      assert.equal(body.id, id);
      assert.equal(body.status, "running");
      assert.equal(body.job_status, "running");
      assert.equal(body.structure_status, "analyzing");

      const files = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as { manifest_path?: string };
      const manifest = JSON.parse(readFileSync(files.manifest_path || "", "utf8"));
      assert.deepEqual(manifest.products[0].proposal_layers, ["结构线"]);
      assert.equal(manifest.products[0].proposal_source_sha256, "7".repeat(64));

      const responseLostRetry = await app.request(`/api/mockups/${id}/structure/input`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
        body: JSON.stringify({ candidate_ids: [candidateId] }),
      });
      assert.equal(responseLostRetry.status, 200);
    } finally {
      releaseRun();
      await new Promise<void>((resolve) => setImmediate(resolve));
      resetJobsTestHooks();
    }
  });

  it("rechecks the current job after a slow request body instead of applying a stale selection", async () => {
    const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
    const id = "feed2000feed";
    const { candidateIds } = seedStructureInputJob(id, "ou_structure_input_race_owner");
    const admin = issueSessionForTest("管理员", "admin", "ou_structure_input_race_admin");
    let releaseBody!: () => void;
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ candidate_ids: [candidateIds[1]] })));
          controller.close();
        };
      },
    });
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    setJobsTestHooks({
      runStructure: async () => {
        await runGate;
        return { code: 1, stdout: "", stderr: "synthetic stop", timedOut: false };
      },
    });
    try {
      const slowRequest = app.request(new Request(
        `http://localhost/api/mockups/${id}/structure/input`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
          body: slowBody,
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      ));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const selected = await app.request(`/api/mockups/${id}/structure/input`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
        body: JSON.stringify({ candidate_ids: [candidateIds[0]] }),
      });
      assert.equal(selected.status, 200);

      releaseBody();
      const stale = await slowRequest;
      assert.equal(stale.status, 409);
      assert.equal(
        ((await stale.json()) as { code?: string }).code,
        "packaging_structure_selection_stale",
      );
    } finally {
      releaseRun();
      await new Promise<void>((resolve) => setImmediate(resolve));
      resetJobsTestHooks();
    }
  });
});

describe("mockup structure confirmation http", () => {
  it("rejects an anonymous structure confirmation before touching the job", async () => {
    const id = "faceac100001";
    saveMockup({
      id,
      status: "review_required",
      created_at: "2026-08-27T00:00:00Z",
      files: [],
      owner: "ou_structure_owner",
      job_kind: "mockup",
      job_status: "waiting_input",
      structure_engine: "v2",
      structure_status: "review_required",
    });
    const res = await app.request(`/api/mockups/${id}/structure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anchor: { proposal_id: "box-net-0001", front_face_id: "proposal-face-0001", quarter_turns: 0 },
      }),
    });
    assert.equal(res.status, 401);
  });

  it("rejects every malformed structure anchor before invoking the worker", async () => {
    const id = "faceba000002";
    saveMockup({
      id,
      status: "review_required",
      created_at: "2026-08-27T00:00:01Z",
      files: [],
      owner: "ou_structure_admin",
      job_kind: "mockup",
      job_status: "waiting_input",
      structure_engine: "v2",
      structure_status: "review_required",
    });
    const admin = issueSessionForTest("魏炜", "admin", "ou_structure_admin");
    const invalidBodies = [
      {},
      { faces: Array.from({ length: 6 }, (_, index) => ({ id: `face-${index}`, role: "front", quarter_turns: 0 })) },
      { anchor: { proposal_id: "raw-rectangle-10", front_face_id: "proposal-face-0001", quarter_turns: 0 } },
      { anchor: { proposal_id: "box-net-0001", front_face_id: "", quarter_turns: 0 } },
      { anchor: { proposal_id: "box-net-0001", front_face_id: "../escape", quarter_turns: 0 } },
      { anchor: { proposal_id: "box-net-0001", front_face_id: "proposal-face-0001", quarter_turns: true } },
      { anchor: { proposal_id: "box-net-0001", front_face_id: "proposal-face-0001", quarter_turns: "1" } },
      { anchor: { proposal_id: "box-net-0001", front_face_id: "proposal-face-0001", quarter_turns: 4 } },
    ];
    for (const invalidBody of invalidBodies) {
      const res = await app.request(`/api/mockups/${id}/structure`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
        body: JSON.stringify(invalidBody),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { detail?: string };
      assert.match(String(body.detail || ""), /完整盒型.*正面|完整盒型、正面或方向/);
    }
  });

  it("serializes confirmation at the HTTP boundary and releases the lock after worker failure", async () => {
    const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
    const {
      setConfirmPackagingStructureTestHook,
      resetConfirmPackagingStructureTestHook,
    } = await import("./workers.js");
    const id = "facecc000003";
    const ownerId = "ou_structure_serial";
    const dir = join(DATA_DIR, "mockups", id);
    mkdirSync(dir, { recursive: true });
    const source = join(dir, "source.ai");
    const resolution = join(dir, "structure_resolution.json");
    const artwork = join(dir, "artwork.pdf");
    const manifest = join(dir, "manifest.json");
    writeFileSync(source, "%PDF-1.4\n");
    writeFileSync(resolution, "{}");
    writeFileSync(artwork, "%PDF-1.4\n");
    writeFileSync(manifest, JSON.stringify({ products: [{}] }));
    saveMockup({
      id,
      status: "review_required",
      created_at: "2026-08-27T00:00:02Z",
      files: [],
      owner: ownerId,
      job_kind: "mockup",
      job_status: "waiting_input",
      structure_engine: "v2",
      structure_status: "review_required",
      source_path: source,
      manifest_path: manifest,
      structure_resolution_path: resolution,
      structure_artwork_path: artwork,
    });
    const admin = issueSessionForTest("魏炜", "admin", ownerId);
    const request = () => app.request(`/api/mockups/${id}/structure`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        anchor: { proposal_id: "box-net-0123456789abcdef", front_face_id: "proposal-face-0001", quarter_turns: 0 },
      }),
    });
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    setJobsTestHooks({
      runPack: async () => ({ code: 1, stdout: "", stderr: "synthetic stop", timedOut: false }),
    });
    setConfirmPackagingStructureTestHook(async (options) => {
      calls += 1;
      if (calls === 1) {
        await firstGate;
        return {
          code: 1,
          stdout: "",
          stderr: '{"code":"structure_fold_graph_invalid","message":"盒型不能闭合"}',
          timedOut: false,
        };
      }
      if (calls === 2) {
        return {
          code: 1,
          stdout: "",
          stderr: '{"code":"structure_confirmation_stale","message":"完整盒型已失效，请重新识别"}',
          timedOut: false,
        };
      }
      if (calls === 3) {
        return {
          code: 1,
          stdout: "",
          stderr: '{"code":"structure_source_mismatch","message":"源稿已变化，请重新识别结构"}',
          timedOut: false,
        };
      }
      if (calls === 4) {
        return {
          code: 1,
          stdout: "",
          stderr: "synthetic worker crash without result json",
          timedOut: false,
        };
      }
      writeFileSync(options.output, "{}");
      return {
        code: 0,
        stdout: `${JSON.stringify({ ok: true, sidecar: options.output })}\n`,
        stderr: "",
        timedOut: false,
      };
    });
    try {
      const firstPending = request();
      while (calls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const overlapping = await request();
      assert.equal(overlapping.status, 409);
      assert.match(String(((await overlapping.json()) as { detail?: string }).detail || ""), /正在确认/);
      assert.equal(calls, 1);

      releaseFirst();
      const failed = await firstPending;
      assert.equal(failed.status, 422);
      assert.equal(
        ((await failed.json()) as { code?: string }).code,
        "structure_fold_graph_invalid",
      );
      assert.equal(calls, 1);

      const staleFailure = await request();
      assert.equal(staleFailure.status, 409);
      assert.equal(
        ((await staleFailure.json()) as { code?: string }).code,
        "structure_confirmation_stale",
      );
      assert.equal(calls, 2);

      const sourceMismatch = await request();
      assert.equal(sourceMismatch.status, 409);
      assert.equal(
        ((await sourceMismatch.json()) as { code?: string }).code,
        "structure_source_mismatch",
      );
      assert.equal(calls, 3);

      const operationalFailure = await request();
      assert.equal(operationalFailure.status, 500);
      assert.equal(
        ((await operationalFailure.json()) as { code?: string }).code,
        "worker_exit_1",
      );
      assert.equal(calls, 4);

      const retried = await request();
      assert.equal(retried.status, 200);
      assert.equal(calls, 5);

      const responseLostRetry = await request();
      assert.equal(responseLostRetry.status, 200);
      assert.equal(calls, 5);
      assert.equal(((await responseLostRetry.json()) as { structure_status?: string }).structure_status, "ready");
    } finally {
      releaseFirst();
      resetConfirmPackagingStructureTestHook();
      resetJobsTestHooks();
    }
  });

  it("lets an admin rotate the front on a finished mockup without re-running Illustrator", async () => {
    const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
    const {
      setConfirmPackagingStructureTestHook,
      resetConfirmPackagingStructureTestHook,
    } = await import("./workers.js");
    const id = "facedd000004";
    const ownerId = "ou_structure_rotate";
    const dir = join(DATA_DIR, "mockups", id);
    mkdirSync(dir, { recursive: true });
    const source = join(dir, "source.ai");
    const resolution = join(dir, "structure_resolution.json");
    const artwork = join(dir, "artwork.pdf");
    const manifest = join(dir, "manifest.json");
    const sourceHash = "a".repeat(64);
    writeFileSync(source, "%PDF-1.4\n");
    writeFileSync(resolution, JSON.stringify(uniqueNetResolution(sourceHash)));
    writeFileSync(artwork, "%PDF-1.4\n");
    writeFileSync(manifest, JSON.stringify({ products: [{}] }));
    saveMockup({
      id,
      status: "done",
      created_at: "2026-09-02T00:00:03Z",
      files: [],
      owner: ownerId,
      job_kind: "mockup",
      job_status: "succeeded",
      structure_engine: "v2",
      structure_status: "ready",
      source_path: source,
      manifest_path: manifest,
      structure_resolution_path: resolution,
      structure_artwork_path: artwork,
      structure_source_sha256: sourceHash,
    });
    let structureCalls = 0;
    let packCalls = 0;
    let confirmCalls = 0;
    setJobsTestHooks({
      runStructure: async () => {
        structureCalls += 1;
        return { code: 1, stdout: "", stderr: "should not re-identify", timedOut: false };
      },
      runPack: async () => {
        packCalls += 1;
        return { code: 1, stdout: "", stderr: "synthetic blender stop", timedOut: false };
      },
    });
    setConfirmPackagingStructureTestHook(async (options) => {
      confirmCalls += 1;
      writeFileSync(options.output, "{}");
      return {
        code: 0,
        stdout: `${JSON.stringify({ ok: true, sidecar: options.output })}\n`,
        stderr: "",
        timedOut: false,
      };
    });
    try {
      const reviewer = issueSessionForTest("审稿", "reviewer", ownerId);
      const denied = await app.request(`/api/mockups/${id}/structure`, {
        method: "POST",
        headers: { authorization: `Bearer ${reviewer.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          anchor: { proposal_id: "box-net-0123456789abcdef", front_face_id: "proposal-face-0002", quarter_turns: 1 },
        }),
      });
      assert.equal(denied.status, 200);
      assert.equal(confirmCalls, 0);

      const admin = issueSessionForTest("魏炜", "admin", ownerId);
      const rotated = await app.request(`/api/mockups/${id}/structure`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          anchor: { proposal_id: "box-net-0123456789abcdef", front_face_id: "proposal-face-0002", quarter_turns: 1 },
        }),
      });
      assert.equal(rotated.status, 200);
      assert.equal(confirmCalls, 1);
      assert.equal(structureCalls, 0);
      const body = (await rotated.json()) as { structure_status?: string; status?: string };
      assert.equal(body.structure_status, "ready");
      assert.ok(body.status === "queued" || body.status === "running" || body.status === "done");
      for (let index = 0; index < 50 && packCalls === 0; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(packCalls, 1);
    } finally {
      resetConfirmPackagingStructureTestHook();
      resetJobsTestHooks();
    }
  });
});

describe("mockup post", { concurrency: false }, () => {
  it("routes every new web mockup through V2 without a legacy fallback", async () => {
    const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    setJobsTestHooks({
      runStructure: async () => ({
        code: 1,
        stdout: "",
        stderr: '{"error":"test stop"}',
        timedOut: false,
      }),
    });
    try {
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_v2_only");
      const receipt = await stageAi(sess.token);
      const res = await startMockup(sess.token, receipt);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { id?: string; structure_engine?: string };
      assert.ok(body.id);
      assert.equal(body.structure_engine, "v2");
      const manifest = JSON.parse(
        readFileSync(join(DATA_DIR, "mockups", body.id, "manifest.json"), "utf8"),
      ) as {
        illustrator?: { enabled?: boolean; application?: string };
        products?: Array<{ structure_engine?: string }>;
      };
      assert.deepEqual(manifest.illustrator, {
        enabled: true,
        application: process.execPath,
      });
      assert.equal(manifest.products?.[0]?.structure_engine, "v2");
    } finally {
      resetJobsTestHooks();
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });

  it("returns 412 without enqueueing when Blender is missing", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevPath = process.env.PATH;
    delete process.env.BLENDER_EXECUTABLE;
    process.env.PATH = "/tmp/beian-no-blender-bin";
    try {
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_post_412");
      const receipt = await stageAi(sess.token);
      const res = await startMockup(sess.token, receipt);
      assert.equal(res.status, 412);
      const body = (await res.json()) as { detail?: string };
      assert.match(String(body.detail || ""), /Blender/);
    } finally {
      process.env.PATH = prevPath;
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
    }
  });

  it("returns 412 when Illustrator is missing for .ai", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    delete process.env.ILLUSTRATOR_EXECUTABLE;
    try {
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_post_ai412");
      const receipt = await stageAi(sess.token);
      const res = await startMockup(sess.token, receipt);
      assert.equal(res.status, 412);
      const body = (await res.json()) as { detail?: string };
      assert.match(String(body.detail || ""), /Illustrator/);
    } finally {
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });

  it("keeps the receipt when the Windows Session 1 Illustrator agent is offline", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    try {
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_agent_offline");
      const receipt = await stageAi(sess.token);
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });

      const res = await startMockup(sess.token, receipt);
      assert.equal(res.status, 412);
      const body = (await res.json()) as { detail?: string };
      assert.match(String(body.detail || ""), /桌面代理未在线/);

      const pending = await app.request("/api/uploads", {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      assert.equal(pending.status, 200);
      const rows = (await pending.json()) as { id?: string; phase?: string }[];
      assert.equal(rows.some((row) => row.id === receipt && row.phase === "ready"), true);
    } finally {
      if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });

  it("returns a diagnostic 412 and keeps the receipt when the Windows agent heartbeat is stale", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    mkdirSync(join(DATA_DIR, "runtime"), { recursive: true });
    writeFileSync(ILLUSTRATOR_AGENT_HEARTBEAT, JSON.stringify({
      protocol: ILLUSTRATOR_AGENT_PROTOCOL,
      pid: 24068,
      session_id: 1,
      user: "HANGZHOU\\Administrator",
      user_sid: "S-1-5-21-1000-500",
      pipe: ILLUSTRATOR_AGENT_PIPE,
      state: "idle",
      updated_at: new Date(Date.now() - 30_001).toISOString(),
      last_code: "illustrator_unavailable",
      script_sha256: ILLUSTRATOR_AGENT_SCRIPT_SHA256,
      release_version: ILLUSTRATOR_AGENT_RELEASE_VERSION,
    }));
    try {
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_agent_stale");
      const receipt = await stageAi(sess.token, "stale-agent.ai");
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });

      const res = await startMockup(sess.token, receipt);
      assert.equal(res.status, 412);
      const body = (await res.json()) as { detail?: string };
      assert.match(String(body.detail || ""), /心跳已停止/);

      const pending = await app.request("/api/uploads", {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      assert.equal(pending.status, 200);
      const rows = (await pending.json()) as { id?: string; phase?: string }[];
      assert.equal(rows.some((row) => row.id === receipt && row.phase === "ready"), true);
    } finally {
      rmSync(ILLUSTRATOR_AGENT_HEARTBEAT, { force: true });
      if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });

  it("refuses start without a receipt", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    try {
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_noreceipt");
      const res = await startMockup(sess.token, "");
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code?: string; detail?: string };
      assert.equal(body.code, "upload_receipt_expired");
      assert.match(String(body.detail || ""), /上传已过期/);
    } finally {
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });

  it("does not start mockup from an excel+pdf receipt", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    try {
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_wrongkind");
      const fd = new FormData();
      fd.append("excel", new File([Buffer.from("PK\x03\x04xxxx")], "a.xlsx"));
      fd.append("pdf", new File([Buffer.from("%PDF-1.4\n%")], "a.pdf"));
      const up = await app.request("/api/uploads", {
        method: "POST",
        headers: { authorization: `Bearer ${sess.token}` },
        body: fd,
      });
      const staged = (await up.json()) as { receipt?: string };
      const res = await startMockup(sess.token, String(staged.receipt || ""));
      assert.equal(res.status, 400);
    } finally {
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });

  it("uses team read access instead of display-name ownership for mockups", async () => {
    const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    const occupied = pendingWorkerStop();
    setJobsTestHooks({
      runStructure: occupied.wait,
      runPack: occupied.wait,
    });
    try {
      const owner = issueSessionForTest("同名", "reviewer", "ou_mock_same_a");
      const receipt = await stageAi(owner.token);
      const start = await startMockup(owner.token, receipt);
      assert.equal(start.status, 200);
      const job = (await start.json()) as { id?: string };
      const other = issueSessionForTest("同名", "reviewer", "ou_mock_same_b");
      const shared = await app.request(`/api/mockups/${job.id}`, {
        headers: { authorization: `Bearer ${other.token}` },
      });
      assert.equal(shared.status, 200);
      const list = await app.request("/api/mockups", {
        headers: { authorization: `Bearer ${other.token}` },
      });
      const rows = (await list.json()) as { id?: string }[];
      assert.equal(rows.some((j) => j.id === job.id), true);
    } finally {
      occupied.stop();
      await new Promise<void>((resolve) => setImmediate(resolve));
      resetJobsTestHooks();
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });

  it("rejects a post with no file", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    try {
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_post_nofile");
      const fd = new FormData();
      fd.set("note", "no-file");
      const res = await app.request("/api/uploads", {
        method: "POST",
        headers: { authorization: `Bearer ${sess.token}` },
        body: fd,
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { detail?: string };
      assert.match(String(body.detail || ""), /没有文件/);
    } finally {
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });

  it("rejects PDF", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    try {
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_post_pdf");
      const fd = new FormData();
      fd.set("file", new File([Buffer.from("%PDF-1.4\n")], "art.pdf", { type: "application/pdf" }));
      const res = await app.request("/api/uploads", {
        method: "POST",
        headers: { authorization: `Bearer ${sess.token}` },
        body: fd,
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { detail?: string };
      assert.match(String(body.detail || ""), /\.ai/);
    } finally {
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });

  it("returns queued or running before the pack worker finishes", async () => {
    const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    const occupied = pendingWorkerStop();
    setJobsTestHooks({
      runStructure: occupied.wait,
      runPack: occupied.wait,
    });
    try {
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_post_ok");
      const receipt = await stageAi(sess.token);
      const started = Date.now();
      const res = await startMockup(sess.token, receipt);
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      assert.ok(elapsed < 2000, `mockup POST waited ${elapsed}ms`);
      const body = (await res.json()) as {
        id?: string;
        status?: string;
        job_status?: string;
        job_pid?: number;
      };
      assert.ok(body.job_status === "queued" || body.job_status === "running");
      assert.ok(body.status === "queued" || body.status === "running");
      assert.equal("job_pid" in body, false);
      assert.ok(body.id);
      const manifest = JSON.parse(
        readFileSync(join(DATA_DIR, "mockups", body.id, "manifest.json"), "utf8"),
      ) as { illustrator?: { enabled?: boolean; application?: string } };
      assert.deepEqual(manifest.illustrator, {
        enabled: true,
        application: process.execPath,
      });

      // The upload receipt is the idempotency token. Even two near-simultaneous
      // start requests must converge on one mockup rather than turning the
      // second click into a misleading "upload expired" failure.
      const concurrentReceipt = await stageAi(sess.token, "concurrent.ai");
      const [firstConcurrent, secondConcurrent] = await Promise.all([
        startMockup(sess.token, concurrentReceipt),
        startMockup(sess.token, concurrentReceipt),
      ]);
      assert.equal(firstConcurrent.status, 200);
      assert.equal(secondConcurrent.status, 200);
      const firstConcurrentBody = (await firstConcurrent.json()) as { id?: string };
      const secondConcurrentBody = (await secondConcurrent.json()) as { id?: string };
      assert.ok(firstConcurrentBody.id);
      assert.equal(secondConcurrentBody.id, firstConcurrentBody.id);

      // 服务端若已建单但响应丢了，重试同一回执应命中原单；恢复不再依赖此刻的本机工具探测。
      delete process.env.BLENDER_EXECUTABLE;
      delete process.env.ILLUSTRATOR_EXECUTABLE;
      const retry = await startMockup(sess.token, receipt);
      assert.equal(retry.status, 200);
      const retried = (await retry.json()) as { id?: string; source_receipt?: string };
      assert.equal(retried.id, (body as { id?: string }).id);
      assert.equal("source_receipt" in retried, false);
    } finally {
      occupied.stop();
      await new Promise<void>((resolve) => setImmediate(resolve));
      resetJobsTestHooks();
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });
});

describe("mockup file bytes", () => {
  it("rejects a white png that is not a PNG", async () => {
    seedOwnedFile("aa11aa11aa11", "white_a", "front_right_white.png", Buffer.from("not-png!!"));
    seedOwnedFile("aa11aa11aa12", "white_a", "short.png", Buffer.from("short"));
    const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_png_bad");
    const bad = await app.request("/api/mockups/aa11aa11aa11/files/white_a", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(bad.status, 415);
    const body = (await bad.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /不是 PNG/);
    const short = await app.request("/api/mockups/aa11aa11aa12/files/white_a", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(short.status, 415);
  });

  it("serves a real white png inline with UTF-8 filename", async () => {
    seedOwnedFile("bb22bb22bb22", "white_a", "白底正面_front_right.png", PNG_MAGIC);
    const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_png_ok");
    const res = await app.request("/api/mockups/bb22bb22bb22/files/white_a", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "private, no-cache");
    assert.match(res.headers.get("etag") || "", /^W\/"/);
    const disp = res.headers.get("content-disposition") || "";
    assert.match(disp, /^inline;/);
    assert.match(disp, /filename="_____front_right.png"/);
    assert.match(disp, /filename\*=UTF-8''%E7%99%BD%E5%BA%95%E6%AD%A3%E9%9D%A2_front_right\.png/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50);
    const again = await app.request("/api/mockups/bb22bb22bb22/files/white_a", {
      headers: { authorization: `Bearer ${sess.token}`, "if-none-match": res.headers.get("etag") || "" },
    });
    assert.equal(again.status, 304);
  });

  it("serves glb inline and ppt as attachment", async () => {
    seedOwnedFile("cc33cc33cc33", "glb", 'box"side.glb', Buffer.from("glTF"));
    seedOwnedFile("dd44dd44dd44", "ppt", "deck.pptx", Buffer.from("PK"));
    const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_disp");
    const glb = await app.request("/api/mockups/cc33cc33cc33/files/glb", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(glb.status, 200);
    assert.equal(glb.headers.get("content-type"), "model/gltf-binary");
    assert.match(glb.headers.get("content-disposition") || "", /^inline;/);
    assert.match(glb.headers.get("content-disposition") || "", /filename="boxside.glb"/);
    const ppt = await app.request("/api/mockups/dd44dd44dd44/files/ppt", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(ppt.status, 200);
    assert.match(ppt.headers.get("content-type") || "", /presentationml/);
    assert.match(ppt.headers.get("content-disposition") || "", /^attachment;/);
  });

  it("serves the sheet pdf as application/pdf", async () => {
    seedOwnedFile("aa77aa77aa77", "sheet", "26F23A_white_sheet.pdf", Buffer.from("%PDF-1.4"));
    const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_pdf");
    const res = await app.request("/api/mockups/aa77aa77aa77/files/sheet?download=1", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition") || "", /^attachment;/);
  });

  it("refuses leftover ai-raster labeled as white_a even if it is a PNG", async () => {
    seedOwnedFile("ff66ff66ff66", "white_a", "ai-raster.png", PNG_MAGIC);
    const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_old_white");
    const res = await app.request("/api/mockups/ff66ff66ff66/files/white_a", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 415);
  });

  it("forces attachment when download=1 so preview URLs stay inline", async () => {
    seedOwnedFile("ee55ee55ee55", "white_a", "front_right_white.png", PNG_MAGIC);
    const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_dl");
    const preview = await app.request("/api/mockups/ee55ee55ee55/files/white_a", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.match(preview.headers.get("content-disposition") || "", /^inline;/);
    const dl = await app.request("/api/mockups/ee55ee55ee55/files/white_a?download=1", {
      headers: {
        authorization: `Bearer ${sess.token}`,
        "if-none-match": preview.headers.get("etag") || "",
      },
    });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("cache-control"), "private, no-store");
    assert.match(dl.headers.get("content-disposition") || "", /^attachment;/);
    assert.ok((await dl.arrayBuffer()).byteLength > 0);
  });

  it("serves an on-disk panel png as read_front even when job.files omitted it", async () => {
    const id = "ab12ab12ab12";
    const dir = join(DATA_DIR, "mockups", id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "panel_front.png"), PNG_MAGIC);
    writeFileSync(join(dir, "box.glb"), Buffer.from("glTF"));
    writeFileSync(join(dir, "26H06A_x_front_right_white.png"), PNG_MAGIC);
    writeFileSync(join(dir, "26H06A_x_back_left_white.png"), PNG_MAGIC);
    saveMockup({
      id,
      status: "done",
      created_at: "2026-09-02T00:00:04Z",
      files: [
        { key: "glb", path: join(dir, "box.glb"), name: "box.glb" },
        { key: "white_a", path: join(dir, "26H06A_x_front_right_white.png"), name: "26H06A_x_front_right_white.png" },
        { key: "white_b", path: join(dir, "26H06A_x_back_left_white.png"), name: "26H06A_x_back_left_white.png" },
      ],
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_read_face");
    const listed = await app.request(`/api/mockups/${id}`, {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { files?: Array<{ key: string; name: string }> };
    assert.equal(body.files?.some((f) => f.key === "read_front" && f.name === "panel_front.png"), true);
    assert.equal(body.files?.some((f) => f.key === "white_a" && f.name.includes("front_right")), true);
    assert.equal(body.files?.some((f) => f.key === "white_b" && f.name.includes("back_left")), true);
    const res = await app.request(`/api/mockups/${id}/files/read_front`, {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("content-disposition") || "", /^inline;/);
  });

  it("rejects a leftover raster labeled as read_front", async () => {
    seedOwnedFile("cd34cd34cd34", "read_front", "ai-raster.png", PNG_MAGIC);
    const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_read_bad");
    const res = await app.request("/api/mockups/cd34cd34cd34/files/read_front", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 404);
  });

  it("rejects a panel png that is not a PNG with the print-face message", async () => {
    const id = "ee12ee12ee12";
    const dir = join(DATA_DIR, "mockups", id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "panel_front.png"), Buffer.from("not-png!!"));
    saveMockup({
      id,
      status: "done",
      created_at: "2026-09-02T00:00:04Z",
      files: [{ key: "read_front", path: join(dir, "assets", "panel_front.png"), name: "panel_front.png" }],
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_read_magic");
    const res = await app.request(`/api/mockups/${id}/files/read_front`, {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 415);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /印刷面图坏了/);
    assert.doesNotMatch(String(body.detail || ""), /白底图坏了/);
  });

  it("keeps print-face preview inline and only attaches on download=1", async () => {
    const id = "ab56ab56ab56";
    const dir = join(DATA_DIR, "mockups", id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "panel_front.png"), PNG_MAGIC);
    saveMockup({
      id,
      status: "done",
      created_at: "2026-09-02T00:00:04Z",
      files: [{ key: "read_front", path: join(dir, "assets", "panel_front.png"), name: "panel_front.png" }],
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_read_dl");
    const preview = await app.request("/api/mockups/ab56ab56ab56/files/read_front", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-disposition") || "", /^inline;/);
    const dl = await app.request("/api/mockups/ab56ab56ab56/files/read_front?download=1", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), "image/png");
    assert.match(dl.headers.get("content-disposition") || "", /^attachment;/);
  });
});

describe("mockup retry http", { concurrency: false }, () => {
  it("requeues a failed job that still has the source on disk", async () => {
    const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
    setJobsTestHooks({
      runPack: async () => ({ code: 1, stdout: "", stderr: "stop", timedOut: false }),
    });
    try {
      const id = "aa11bb22cc99";
      const dir = join(DATA_DIR, "mockups", id);
      mkdirSync(dir, { recursive: true });
      const source = join(dir, "art.ai");
      writeFileSync(source, "%PDF-1.4\n");
      saveMockup({
        id,
        status: "failed",
        title: "喷雾",
        created_at: "2026-08-20T00:00:02Z",
        files: [],
        owner: "ou_mockup_retry_ok",
        source_path: source,
        job_kind: "mockup",
        job_status: "failed",
        job_error: "打样中断",
        error: "打样中断",
        structure_engine: "v2",
        structure_status: "ready",
      });
      const sess = issueSessionForTest("籽烨", "reviewer", "ou_mockup_retry_ok");
      const res = await app.request(`/api/mockups/${id}/retry`, {
        method: "POST",
        headers: { authorization: `Bearer ${sess.token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status?: string; structure_status?: string };
      assert.ok(body.status === "queued" || body.status === "running");
      assert.equal(body.structure_status, "ready");
    } finally {
      resetJobsTestHooks();
    }
  });

  it("refuses another account and already-done jobs", async () => {
    saveMockup({
      id: "bb22cc33dd44",
      status: "done",
      created_at: "2026-08-20T00:00:03Z",
      files: [],
      owner: "ou_mockup_retry_done",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const owner = issueSessionForTest("籽烨", "reviewer", "ou_mockup_retry_done");
    const done = await app.request("/api/mockups/bb22cc33dd44/retry", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(done.status, 409);
    saveMockup({
      id: "cc33dd44ee55",
      status: "failed",
      created_at: "2026-08-20T00:00:04Z",
      files: [],
      owner: "ou_mockup_retry_own",
      job_kind: "mockup",
      job_status: "failed",
    });
    const stranger = issueSessionForTest("路人", "reviewer", "ou_mockup_retry_no");
    const denied = await app.request("/api/mockups/cc33dd44ee55/retry", {
      method: "POST",
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(denied.status, 403);
    const anon = await app.request("/api/mockups/cc33dd44ee55/retry", { method: "POST" });
    assert.equal(anon.status, 401);
    const viewer = issueSessionForTest("只看", "viewer", "ou_mockup_retry_view");
    const forbidden = await app.request("/api/mockups/cc33dd44ee55/retry", {
      method: "POST",
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    assert.equal(forbidden.status, 403);
  });
});
