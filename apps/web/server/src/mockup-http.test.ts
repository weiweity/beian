import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-mockup-http-"));
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSession } = await import("./auth.js");
const { publicMockup, saveMockup } = await import("./mockup.js");

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
});

describe("publicMockup", () => {
  it("drops disk paths from files", () => {
    const out = publicMockup({
      id: "m1",
      status: "done",
      created_at: "2026-08-20T00:00:00Z",
      files: [{ key: "glb", path: "/secret/data/mockups/m1/box.glb", name: "box.glb" }],
    });
    assert.equal(out.id, "m1");
    assert.deepEqual(out.files, [{ key: "glb", name: "box.glb" }]);
    assert.equal(JSON.stringify(out).includes("/secret/"), false);
    assert.equal("path" in out.files[0], false);
  });
});

describe("mockup post", { concurrency: false }, () => {
  it("returns 412 without enqueueing when Blender is missing", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevPath = process.env.PATH;
    delete process.env.BLENDER_EXECUTABLE;
    process.env.PATH = "/tmp/beian-no-blender-bin";
    try {
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_post_412", "feishu");
      const fd = new FormData();
      fd.set("file", new File([Buffer.from("%PDF-1.4\n")], "art.ai", { type: "application/postscript" }));
      const res = await app.request("/api/mockups", {
        method: "POST",
        headers: { authorization: `Bearer ${sess.token}` },
        body: fd,
      });
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
      const fd = new FormData();
      fd.set("file", new File([Buffer.from("%PDF-1.4\n")], "art.ai", { type: "application/postscript" }));
      const res = await app.request("/api/mockups", {
        method: "POST",
        headers: { authorization: `Bearer ${sess.token}` },
        body: fd,
      });
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

  it("rejects a post with no file", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    try {
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_post_nofile", "feishu");
      const fd = new FormData();
      fd.set("note", "no-file");
      const res = await app.request("/api/mockups", {
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

  it("rejects PDF", async () => {
    const prevBin = process.env.BLENDER_EXECUTABLE;
    const prevAi = process.env.ILLUSTRATOR_EXECUTABLE;
    process.env.BLENDER_EXECUTABLE = process.execPath;
    process.env.ILLUSTRATOR_EXECUTABLE = process.execPath;
    try {
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_post_pdf", "feishu");
      const fd = new FormData();
      fd.set("file", new File([Buffer.from("%PDF-1.4\n")], "art.pdf", { type: "application/pdf" }));
      const res = await app.request("/api/mockups", {
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
      runPack: () =>
        new Promise(() => {
          /* hang until process exit */
        }),
    });
    try {
      const sess = issueSession("籽烨", "reviewer", "ou_mockup_post_ok", "feishu");
      const fd = new FormData();
      fd.set("file", new File([Buffer.from("%PDF-1.4\n")], "art.ai", { type: "application/postscript" }));
      const started = Date.now();
      const res = await app.request("/api/mockups", {
        method: "POST",
        headers: { authorization: `Bearer ${sess.token}` },
        body: fd,
      });
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      assert.ok(elapsed < 2000, `mockup POST waited ${elapsed}ms`);
      const body = (await res.json()) as { status?: string; job_status?: string; job_pid?: number };
      assert.ok(body.job_status === "queued" || body.job_status === "running");
      assert.ok(body.status === "queued" || body.status === "running");
      assert.equal("job_pid" in body, false);
    } finally {
      resetJobsTestHooks();
      if (prevBin !== undefined) process.env.BLENDER_EXECUTABLE = prevBin;
      else delete process.env.BLENDER_EXECUTABLE;
      if (prevAi !== undefined) process.env.ILLUSTRATOR_EXECUTABLE = prevAi;
      else delete process.env.ILLUSTRATOR_EXECUTABLE;
    }
  });
});
