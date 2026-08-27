import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-mockup-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";
process.env.PACKAGING_STRUCTURE_V2_ENABLED = "true";

const { app } = await import("./index.js");
const { issueSession } = await import("./auth.js");
const { DATA_DIR } = await import("./config.js");
const { publicMockup, saveMockup } = await import("./mockup.js");

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

describe("mockup http", () => {
  it("rejects unauthenticated list", async () => {
    const res = await app.request("/api/mockups");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /未登录/);
  });

  it("returns an empty list for a logged-in reviewer", async () => {
    const sess = issueSession("审稿", "reviewer", "ou_mockup_list_xx", "feishu");
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
  it("GET mockup without owner is 403 for a reviewer", async () => {
    saveMockup({
      id: "121212121212",
      status: "done",
      created_at: "2026-08-20T00:00:00Z",
      files: [],
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const reviewer = issueSession("路人", "reviewer", "ou_mockup_ownerless", "feishu");
    const denied = await app.request("/api/mockups/121212121212", {
      headers: { authorization: `Bearer ${reviewer.token}` },
    });
    assert.equal(denied.status, 403);
    const admin = issueSession("管理员", "admin", "ou_mockup_ownerless_admin", "feishu");
    const allowed = await app.request("/api/mockups/121212121212", {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    assert.equal(allowed.status, 200);
  });

  it("GET another owner's mockup is 403", async () => {
    saveMockup({
      id: "aaaaaaaaaaaa",
      status: "done",
      created_at: "2026-08-20T00:00:00Z",
      files: [{ key: "glb", path: "/secret/box.glb", name: "box.glb" }],
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const sess = issueSession("路人", "reviewer", "ou_mockup_acl_xx", "feishu");
    const res = await app.request("/api/mockups/aaaaaaaaaaaa", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 403);
    const list = await app.request("/api/mockups", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { id?: string }[];
    assert.equal(body.some((j) => j.id === "aaaaaaaaaaaa"), false);
  });

  it("GET another owner's mockup file is 403", async () => {
    saveMockup({
      id: "bbbbbbbbbbbb",
      status: "done",
      created_at: "2026-08-20T00:00:01Z",
      files: [{ key: "glb", path: "/secret/box.glb", name: "box.glb" }],
      owner: "籽烨",
      job_kind: "mockup",
      job_status: "succeeded",
    });
    const sess = issueSession("路人", "reviewer", "ou_mockup_file_acl", "feishu");
    const res = await app.request("/api/mockups/bbbbbbbbbbbb/files/glb", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 403);
  });

  it("GET mockup id that is not a tid is 400", async () => {
    const sess = issueSession("审稿", "reviewer", "ou_mockup_bad_id", "feishu");
    const res = await app.request("/api/mockups/..%2fsecret", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 400);
  });

  it("GET missing mockup is 404", async () => {
    const sess = issueSession("审稿", "reviewer", "ou_mockup_get_xx", "feishu");
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
    const stranger = issueSession("路人", "reviewer", "ou_mockup_del_no", "feishu");
    const denied = await app.request("/api/mockups/dddddddddddd", {
      method: "DELETE",
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(denied.status, 403);
    const owner = issueSession("魏炜", "admin", "ou_mockup_del_ok", "feishu");
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
    const owner = issueSession("魏炜", "admin", "ou_mockup_del_run", "feishu");
    const res = await app.request("/api/mockups/eeeeeeeeeeee", {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(res.status, 409);
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
      structure_message: "请确认六个盒面。",
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

describe("mockup structure confirmation http", () => {
  it("requires an admin before accepting any face decisions", async () => {
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
    const reviewer = issueSession("审稿", "reviewer", "ou_structure_owner", "feishu");
    const res = await app.request(`/api/mockups/${id}/structure`, {
      method: "POST",
      headers: { authorization: `Bearer ${reviewer.token}`, "content-type": "application/json" },
      body: JSON.stringify({ faces: [] }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /管理员/);
  });

  it("rejects an incomplete six-face decision before invoking the worker", async () => {
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
    const admin = issueSession("魏炜", "admin", "ou_structure_admin", "feishu");
    const res = await app.request(`/api/mockups/${id}/structure`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ faces: [{ id: "one", role: "front", quarter_turns: 0 }] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /六个盒面/);
  });
});

describe("mockup post", { concurrency: false }, () => {
  it("keeps the production legacy path until the V2 rollout gate is explicitly enabled", async () => {
    const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    const prevGate = process.env.PACKAGING_STRUCTURE_V2_ENABLED;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    process.env.PACKAGING_STRUCTURE_V2_ENABLED = "false";
    setJobsTestHooks({
      runRaster: () =>
        new Promise(() => {
          /* keep the legacy Illustrator slot occupied */
        }),
    });
    try {
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_legacy_gate", "feishu");
      const receipt = await stageAi(sess.token);
      const res = await startMockup(sess.token, receipt);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { id?: string; structure_engine?: string };
      assert.ok(body.id);
      assert.equal(body.structure_engine, undefined);
      const manifest = JSON.parse(
        readFileSync(join(DATA_DIR, "mockups", body.id, "manifest.json"), "utf8"),
      ) as {
        illustrator?: { enabled?: boolean; application?: string };
        products?: Array<{ structure_engine?: string }>;
      };
      assert.deepEqual(manifest.illustrator, { enabled: false });
      assert.equal(manifest.products?.[0]?.structure_engine, undefined);
    } finally {
      resetJobsTestHooks();
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
      if (prevGate !== undefined) process.env.PACKAGING_STRUCTURE_V2_ENABLED = prevGate;
      else delete process.env.PACKAGING_STRUCTURE_V2_ENABLED;
    }
  });

  it("returns 412 without enqueueing when Blender is missing", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevPath = process.env.PATH;
    delete process.env.BLENDER_EXECUTABLE;
    process.env.PATH = "/tmp/beian-no-blender-bin";
    try {
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_post_412", "feishu");
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
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_post_ai412", "feishu");
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

  it("refuses start without a receipt", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    try {
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_noreceipt", "feishu");
      const res = await startMockup(sess.token, "");
      assert.equal(res.status, 400);
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
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_wrongkind", "feishu");
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

  it("does not let another Feishu account with the same display name read this mockup", async () => {
    const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    setJobsTestHooks({
      runStructure: () =>
        new Promise(() => {
          /* keep the V2 structure slot occupied */
        }),
      runPack: () =>
        new Promise(() => {
          /* hang */
        }),
    });
    try {
      const owner = issueSession("同名", "reviewer", "ou_mock_same_a", "feishu");
      const receipt = await stageAi(owner.token);
      const start = await startMockup(owner.token, receipt);
      assert.equal(start.status, 200);
      const job = (await start.json()) as { id?: string };
      const other = issueSession("同名", "reviewer", "ou_mock_same_b", "feishu");
      const denied = await app.request(`/api/mockups/${job.id}`, {
        headers: { authorization: `Bearer ${other.token}` },
      });
      assert.equal(denied.status, 403);
      const list = await app.request("/api/mockups", {
        headers: { authorization: `Bearer ${other.token}` },
      });
      const rows = (await list.json()) as { id?: string }[];
      assert.equal(rows.some((j) => j.id === job.id), false);
    } finally {
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
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_post_nofile", "feishu");
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
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_post_pdf", "feishu");
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
    setJobsTestHooks({
      runStructure: () =>
        new Promise(() => {
          /* keep the V2 structure slot occupied */
        }),
      runPack: () =>
        new Promise(() => {
          /* hang until process exit */
        }),
    });
    try {
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_post_ok", "feishu");
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

      // 服务端若已建单但响应丢了，重试同一回执应命中原单；恢复不再依赖此刻的本机工具探测。
      delete process.env.BLENDER_EXECUTABLE;
      delete process.env.ILLUSTRATOR_EXECUTABLE;
      const retry = await startMockup(sess.token, receipt);
      assert.equal(retry.status, 200);
      const retried = (await retry.json()) as { id?: string; source_receipt?: string };
      assert.equal(retried.id, (body as { id?: string }).id);
      assert.equal("source_receipt" in retried, false);
    } finally {
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
    const sess = issueSession("籽烨", "reviewer", "ou_mockup_png_bad", "feishu");
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
    const sess = issueSession("籽烨", "reviewer", "ou_mockup_png_ok", "feishu");
    const res = await app.request("/api/mockups/bb22bb22bb22/files/white_a", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const disp = res.headers.get("content-disposition") || "";
    assert.match(disp, /^inline;/);
    assert.match(disp, /filename="_____front_right.png"/);
    assert.match(disp, /filename\*=UTF-8''%E7%99%BD%E5%BA%95%E6%AD%A3%E9%9D%A2_front_right\.png/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50);
  });

  it("serves glb inline and ppt as attachment", async () => {
    seedOwnedFile("cc33cc33cc33", "glb", 'box"side.glb', Buffer.from("glTF"));
    seedOwnedFile("dd44dd44dd44", "ppt", "deck.pptx", Buffer.from("PK"));
    const sess = issueSession("籽烨", "reviewer", "ou_mockup_disp", "feishu");
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
    const sess = issueSession("籽烨", "reviewer", "ou_mockup_pdf", "feishu");
    const res = await app.request("/api/mockups/aa77aa77aa77/files/sheet?download=1", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition") || "", /^attachment;/);
  });

  it("refuses leftover ai-raster labeled as white_a even if it is a PNG", async () => {
    seedOwnedFile("ff66ff66ff66", "white_a", "ai-raster.png", PNG_MAGIC);
    const sess = issueSession("籽烨", "reviewer", "ou_mockup_old_white", "feishu");
    const res = await app.request("/api/mockups/ff66ff66ff66/files/white_a", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(res.status, 415);
  });

  it("forces attachment when download=1 so preview URLs stay inline", async () => {
    seedOwnedFile("ee55ee55ee55", "white_a", "front_right_white.png", PNG_MAGIC);
    const sess = issueSession("籽烨", "reviewer", "ou_mockup_dl", "feishu");
    const preview = await app.request("/api/mockups/ee55ee55ee55/files/white_a", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.match(preview.headers.get("content-disposition") || "", /^inline;/);
    const dl = await app.request("/api/mockups/ee55ee55ee55/files/white_a?download=1", {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition") || "", /^attachment;/);
  });
});
