import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-uploads-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app, SERVER_HTTP_OPTIONS } = await import("./index.js");
const { issueSession } = await import("./auth.js");
const { setJobsTestHooks, resetJobsTestHooks } = await import("./jobs.js");
const {
  discardReceipt,
  MAX_PENDING_RECEIPTS_PER_OWNER,
  MAX_UPLOAD_BODY_BYTES,
  stageBuffers,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_SESSION_METADATA_BYTES,
} = await import("./uploads.js");

function authHeader(openId = "ou_upload_http", name = "魏炜", role: "admin" | "reviewer" = "admin") {
  const sess = issueSession(name, role, openId, "feishu");
  return { authorization: `Bearer ${sess.token}` };
}

describe("upload then start", () => {
  it("keeps the server request window longer than the 15-minute browser upload window", () => {
    assert.ok(SERVER_HTTP_OPTIONS.requestTimeout > 15 * 60 * 1000);
    assert.equal(SERVER_HTTP_OPTIONS.headersTimeout, 60_000);
  });

  it("completes the first resumable upload and removes a crash-left session after publishing its receipt", async () => {
    const owner = "ou_first_chunk_receipt";
    const source = Buffer.from("%PDF-1.7\nfirst-resumable-upload");
    const created = await app.request("/api/uploads/sessions", {
      method: "POST",
      headers: { ...authHeader(owner), "content-type": "application/json" },
      body: JSON.stringify({
        client_upload_id: "client-first-chunk-receipt",
        product_name: "首单花盒",
        pack_surface: "pouch",
        files: [{ field: "ai", name: "first.ai", bytes: source.length, last_modified: 1 }],
      }),
    });
    assert.equal(created.status, 200);
    const upload = (await created.json()) as { upload: { id: string } };
    const sessionDir = join(process.env.WB_DATA_DIR!, "uploads", "sessions", upload.upload.id);
    const backupDir = join(process.env.WB_DATA_DIR!, `completed-session-${upload.upload.id}`);

    const written = await app.request(`/api/uploads/sessions/${upload.upload.id}/files/ai`, {
      method: "PUT",
      headers: {
        ...authHeader(owner),
        "content-type": "application/octet-stream",
        "x-upload-offset": "0",
        "x-upload-sha256": createHash("sha256").update(source).digest("hex"),
      },
      body: Uint8Array.from(source).buffer,
    });
    assert.equal(written.status, 200);
    cpSync(sessionDir, backupDir, { recursive: true });

    const completed = await app.request(`/api/uploads/sessions/${upload.upload.id}/complete`, {
      method: "POST",
      headers: { ...authHeader(owner), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(completed.status, 200);
    assert.equal(((await completed.json()) as { upload: { phase: string } }).upload.phase, "ready");

    mkdirSync(join(process.env.WB_DATA_DIR!, "uploads", "sessions"), { recursive: true });
    cpSync(backupDir, sessionDir, { recursive: true });
    assert.equal(existsSync(sessionDir), true);
    const listed = await app.request("/api/uploads", { headers: authHeader(owner) });
    assert.equal(listed.status, 200);
    const rows = (await listed.json()) as Array<{ id: string; phase: string; pack_surface?: string }>;
    assert.deepEqual(rows.map((row) => [row.id, row.phase, row.pack_surface]), [
      [upload.upload.id, "ready", "pouch"],
    ]);
    assert.equal(existsSync(sessionDir), false);

    cpSync(backupDir, sessionDir, { recursive: true });
    assert.equal(existsSync(sessionDir), true);
    assert.equal(discardReceipt(upload.upload.id, owner), true);
    assert.equal(existsSync(sessionDir), false);
    const afterDiscard = await app.request("/api/uploads", { headers: authHeader(owner) });
    assert.deepEqual(await afterDiscard.json(), []);
    rmSync(backupDir, { recursive: true, force: true });
  });

  it("refuses start without a receipt", async () => {
    const res = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ product_name: "喷雾" }),
    });
    assert.equal(res.status, 400);
  });

  it("stages excel+pdf and idempotently returns the same task when start is retried", async () => {
    setJobsTestHooks({
      runCompare: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }),
    });
    const fd = new FormData();
    fd.append("excel", new File([Buffer.from("PK\x03\x04xxxx")], "a.xlsx"));
    fd.append("pdf", new File([Buffer.from("%PDF-1.4\n%")], "a.pdf"));
    const up = await app.request("/api/uploads", { method: "POST", headers: authHeader(), body: fd });
    assert.equal(up.status, 200);
    const staged = (await up.json()) as { receipt?: string };
    assert.ok(staged.receipt);
    const beforeStart = await app.request("/api/uploads", { headers: authHeader() });
    assert.equal(beforeStart.status, 200);
    const beforeRows = (await beforeStart.json()) as { id?: string }[];
    assert.equal(beforeRows.some((row) => row.id === staged.receipt), true);
    const start = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(start.status, 200);
    const task = (await start.json()) as { id?: string; owner?: string; created_by?: string; source_receipt?: string };
    assert.ok(task.id);
    assert.equal(task.owner, "ou_upload_http");
    assert.equal(task.created_by, "魏炜");
    assert.equal("source_receipt" in task, false);
    const afterStart = await app.request("/api/uploads", { headers: authHeader() });
    assert.equal(afterStart.status, 200);
    const afterRows = (await afterStart.json()) as { id?: string }[];
    assert.deepEqual(afterRows, []);
    const again = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(again.status, 200);
    const retried = (await again.json()) as { id?: string; source_receipt?: string };
    assert.equal(retried.id, task.id);
    assert.equal("source_receipt" in retried, false);
    const stranger = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader("ou_upload_http_other"), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(stranger.status, 400);
    resetJobsTestHooks();
  });

  it("lists only this open_id's unconsumed receipts with the public shape", async () => {
    const a = new FormData();
    a.append("client_upload_id", "client-list-a");
    a.append("file", new File([Buffer.from("%PDF-1.4\n%")], "a.ai"));
    const upA = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_list_a"), body: a });
    assert.equal(upA.status, 200);
    const receiptA = (await upA.json()) as { receipt: string };

    const b = new FormData();
    b.append("file", new File([Buffer.from("%PDF-1.4\n%")], "b.ai"));
    const upB = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_list_b"), body: b });
    assert.equal(upB.status, 200);
    const receiptB = (await upB.json()) as { receipt: string };

    const listed = await app.request("/api/uploads", { headers: authHeader("ou_list_a") });
    assert.equal(listed.status, 200);
    const rows = (await listed.json()) as {
      id: string;
      files: { field: string; name: string; bytes: number }[];
      bytes: number;
      created_at: string;
      kind: string;
    }[];
    assert.deepEqual(rows.map((row) => row.id), [receiptA.receipt]);
    assert.equal(rows.some((row) => row.id === receiptB.receipt), false);
    assert.deepEqual(Object.keys(rows[0] || {}).sort(), [
      "bytes",
      "client_upload_id",
      "created_at",
      "files",
      "id",
      "kind",
      "phase",
      "received",
    ]);
    assert.equal(rows[0]?.kind, "mockup");
    assert.equal((rows[0] as { client_upload_id?: string })?.client_upload_id, "client-list-a");
    assert.equal(rows[0]?.bytes, rows[0]?.files.reduce((sum, file) => sum + file.bytes, 0));
    assert.deepEqual(Object.keys(rows[0]?.files[0] || {}).sort(), ["bytes", "field", "name", "received"]);
  });

  it("resumes idempotent chunks and exposes a partial upload until the receipt is ready", async () => {
    const owner = "ou_chunk_resume";
    const source = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(UPLOAD_CHUNK_BYTES + 11 - Buffer.byteLength("%PDF-1.7\n"), 65),
    ]);
    const create = () =>
      app.request("/api/uploads/sessions", {
        method: "POST",
        headers: { ...authHeader(owner), "content-type": "application/json" },
        body: JSON.stringify({
          client_upload_id: "client-chunk-resume",
          product_name: "胶原棒花盒",
          files: [{ field: "ai", name: "box.ai", bytes: source.length, last_modified: 1234 }],
        }),
      });
    const created = await create();
    assert.equal(created.status, 200);
    const first = (await created.json()) as { upload: { id: string; phase: string; received: number } };
    assert.equal(first.upload.phase, "paused");
    assert.equal(first.upload.received, 0);

    const put = (offset: number, chunk: Buffer) => {
      const body = Uint8Array.from(chunk).buffer;
      return app.request(`/api/uploads/sessions/${first.upload.id}/files/ai`, {
        method: "PUT",
        headers: {
          ...authHeader(owner),
          "content-type": "application/octet-stream",
          "x-upload-offset": String(offset),
          "x-upload-sha256": createHash("sha256").update(chunk).digest("hex"),
        },
        body,
      });
    };
    const firstChunk = source.subarray(0, UPLOAD_CHUNK_BYTES);
    const tailChunk = source.subarray(UPLOAD_CHUNK_BYTES);
    const written = await put(0, firstChunk);
    assert.equal(written.status, 200);
    assert.equal(((await written.json()) as { upload: { received: number } }).upload.received, firstChunk.length);
    const duplicate = await put(0, firstChunk);
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as { upload: { received: number } }).upload.received, firstChunk.length);
    const tail = await put(firstChunk.length, tailChunk);
    assert.equal(tail.status, 200);
    assert.equal(((await tail.json()) as { upload: { received: number } }).upload.received, source.length);

    const partial = await app.request("/api/uploads", { headers: authHeader(owner) });
    const partialRows = (await partial.json()) as Array<{ id: string; phase: string; product_name?: string }>;
    assert.deepEqual(partialRows.map((row) => [row.id, row.phase, row.product_name]), [
      [first.upload.id, "paused", "胶原棒花盒"],
    ]);

    const complete = await app.request(`/api/uploads/sessions/${first.upload.id}/complete`, {
      method: "POST",
      headers: { ...authHeader(owner), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(complete.status, 200);
    const ready = (await complete.json()) as { upload: { id: string; phase: string; received: number } };
    assert.equal(ready.upload.id, first.upload.id);
    assert.equal(ready.upload.phase, "ready");
    assert.equal(ready.upload.received, source.length);

    const retriedCreate = await create();
    assert.equal(retriedCreate.status, 200);
    assert.equal(((await retriedCreate.json()) as { upload: { id: string; phase: string } }).upload.phase, "ready");
    assert.equal(discardReceipt(first.upload.id, owner), true);
  });

  it("rejects mismatched resume metadata and keeps partial sessions owner-scoped", async () => {
    const owner = "ou_chunk_metadata";
    const create = (bytes: number, openId = owner, productName = "旧品名", packSurface = "carton") =>
      app.request("/api/uploads/sessions", {
        method: "POST",
        headers: { ...authHeader(openId), "content-type": "application/json" },
        body: JSON.stringify({
          client_upload_id: "client-chunk-metadata",
          product_name: productName,
          pack_surface: packSurface,
          files: [{ field: "ai", name: "box.ai", bytes, last_modified: 1234 }],
        }),
      });

    const created = await create(32);
    assert.equal(created.status, 200);
    const upload = (await created.json()) as { upload: { id: string } };

    const renamed = await create(32, owner, "新膜袋", "pouch");
    assert.equal(renamed.status, 200);
    const renamedUpload = (await renamed.json()) as {
      upload: { id: string; product_name?: string; pack_surface?: string };
    };
    assert.deepEqual(
      [renamedUpload.upload.id, renamedUpload.upload.product_name, renamedUpload.upload.pack_surface],
      [upload.upload.id, "新膜袋", "pouch"],
    );

    const mismatched = await create(33);
    assert.equal(mismatched.status, 409);
    assert.deepEqual(await mismatched.json(), {
      detail: "这次上传选择的文件与服务器记录不一致，请放弃后重新选择",
    });

    const foreignList = await app.request("/api/uploads", { headers: authHeader("ou_chunk_metadata_other") });
    assert.deepEqual(await foreignList.json(), []);
    const foreignChunk = Buffer.from("%PDF-1.7\nforeign");
    const denied = await app.request(`/api/uploads/sessions/${upload.upload.id}/files/ai`, {
      method: "PUT",
      headers: {
        ...authHeader("ou_chunk_metadata_other"),
        "content-type": "application/octet-stream",
        "x-upload-offset": "0",
        "x-upload-sha256": createHash("sha256").update(foreignChunk).digest("hex"),
      },
      body: Uint8Array.from(foreignChunk).buffer,
    });
    assert.equal(denied.status, 404);

    const removed = await app.request(`/api/uploads/${upload.upload.id}`, {
      method: "DELETE",
      headers: authHeader(owner),
    });
    assert.deepEqual(await removed.json(), { ok: true });
  });

  it("bounds upload-session metadata before parsing JSON", async () => {
    const res = await app.request("/api/uploads/sessions", {
      method: "POST",
      headers: { ...authHeader("ou_chunk_metadata_limit"), "content-type": "application/json" },
      body: JSON.stringify({ product_name: "x".repeat(UPLOAD_SESSION_METADATA_BYTES + 1) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { detail: "上传文件信息过大" });
  });

  it("reserves two resumable upload channels across chunk gaps and rejects the third", async () => {
    const owner = "ou_chunk_slots";
    const createdIds: string[] = [];
    const create = async (client: string) => {
      const response = await app.request("/api/uploads/sessions", {
        method: "POST",
        headers: { ...authHeader(owner), "content-type": "application/json" },
        body: JSON.stringify({
          client_upload_id: client,
          files: [{ field: "ai", name: `${client}.ai`, bytes: 2, last_modified: 1 }],
        }),
      });
      if (response.status === 200) {
        const body = (await response.clone().json()) as { upload: { id: string } };
        createdIds.push(body.upload.id);
      }
      return response;
    };

    try {
      const first = await create("client-slot-first");
      const second = await create("client-slot-second");
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);

      const retryFirst = await create("client-slot-first");
      assert.equal(retryFirst.status, 200);
      assert.equal(((await retryFirst.json()) as { upload: { id: string } }).upload.id, createdIds[0]);

      const overflow = await create("client-slot-third");
      assert.equal(overflow.status, 429);
      assert.deepEqual(await overflow.json(), { detail: "同时最多上传 2 份，请等其中一份完成后再试" });

      const released = await app.request(`/api/uploads/${createdIds[0]}`, {
        method: "DELETE",
        headers: authHeader(owner),
      });
      assert.equal(released.status, 200);
      const afterRelease = await create("client-slot-third");
      assert.equal(afterRelease.status, 200);
    } finally {
      for (const id of new Set(createdIds)) {
        await app.request(`/api/uploads/${id}`, { method: "DELETE", headers: authHeader(owner) });
      }
    }
  });

  it("requires a paused resumable session to reacquire a channel before writing", async () => {
    const owner = "ou_chunk_reacquire";
    const createdIds: string[] = [];
    const create = async (client: string) => {
      const response = await app.request("/api/uploads/sessions", {
        method: "POST",
        headers: { ...authHeader(owner), "content-type": "application/json" },
        body: JSON.stringify({
          client_upload_id: client,
          files: [{ field: "ai", name: `${client}.ai`, bytes: 2, last_modified: 1 }],
        }),
      });
      const body = (await response.json()) as { upload?: { id: string } };
      if (body.upload?.id) createdIds.push(body.upload.id);
      assert.equal(response.status, 200);
      return body.upload!.id;
    };

    try {
      const pausedId = await create("client-reacquire-paused");
      const pausedPath = join(
        process.env.WB_DATA_DIR!,
        "uploads",
        "sessions",
        pausedId,
        "session.json",
      );
      const paused = JSON.parse(readFileSync(pausedPath, "utf8")) as Record<string, unknown>;
      writeFileSync(
        pausedPath,
        JSON.stringify({ ...paused, updated_at: new Date(Date.now() - 3 * 60 * 1000).toISOString() }),
      );

      await create("client-reacquire-first");
      await create("client-reacquire-second");
      const chunk = Buffer.from("x");
      const response = await app.request(`/api/uploads/sessions/${pausedId}/files/ai`, {
        method: "PUT",
        headers: {
          ...authHeader(owner),
          "content-type": "application/octet-stream",
          "x-upload-offset": "0",
          "x-upload-sha256": createHash("sha256").update(chunk).digest("hex"),
        },
        body: Uint8Array.from(chunk).buffer,
      });
      assert.equal(response.status, 429);
      assert.deepEqual(await response.json(), { detail: "同时最多上传 2 份，请等其中一份完成后再试" });
    } finally {
      for (const id of new Set(createdIds)) {
        await app.request(`/api/uploads/${id}`, { method: "DELETE", headers: authHeader(owner) });
      }
    }
  });

  it("rejects corrupt or out-of-order chunks, then completes idempotently", async () => {
    const owner = "ou_chunk_validation";
    const source = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(23, 65)]);
    const created = await app.request("/api/uploads/sessions", {
      method: "POST",
      headers: { ...authHeader(owner), "content-type": "application/json" },
      body: JSON.stringify({
        client_upload_id: "client-chunk-validation",
        files: [{ field: "ai", name: "box.ai", bytes: source.length, last_modified: 5678 }],
      }),
    });
    assert.equal(created.status, 200);
    const upload = (await created.json()) as { upload: { id: string } };
    const completePath = `/api/uploads/sessions/${upload.upload.id}/complete`;
    const chunkPath = `/api/uploads/sessions/${upload.upload.id}/files/ai`;

    const sessionPath = join(
      process.env.WB_DATA_DIR!,
      "uploads",
      "sessions",
      upload.upload.id,
      "session.json",
    );
    const session = JSON.parse(readFileSync(sessionPath, "utf8")) as Record<string, unknown>;
    writeFileSync(sessionPath, JSON.stringify({ ...session, created_at: "2020-01-01T00:00:00.000Z" }));

    const premature = await app.request(completePath, {
      method: "POST",
      headers: { ...authHeader(owner), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(premature.status, 409);
    assert.deepEqual(await premature.json(), { detail: "文件还没有传完" });

    const corruptHash = await app.request(chunkPath, {
      method: "PUT",
      headers: {
        ...authHeader(owner),
        "content-type": "application/octet-stream",
        "x-upload-offset": "0",
        "x-upload-sha256": "0".repeat(64),
      },
      body: Uint8Array.from(source).buffer,
    });
    assert.equal(corruptHash.status, 409);
    assert.deepEqual(await corruptHash.json(), { detail: "上传分片校验失败，请重试" });

    const outOfOrder = await app.request(chunkPath, {
      method: "PUT",
      headers: {
        ...authHeader(owner),
        "content-type": "application/octet-stream",
        "x-upload-offset": "1",
        "x-upload-sha256": createHash("sha256").update(source).digest("hex"),
      },
      body: Uint8Array.from(source).buffer,
    });
    assert.equal(outOfOrder.status, 409);
    assert.deepEqual(await outOfOrder.json(), { detail: "服务器已收到 0 字节，请从该位置继续" });

    const written = await app.request(chunkPath, {
      method: "PUT",
      headers: {
        ...authHeader(owner),
        "content-type": "application/octet-stream",
        "x-upload-offset": "0",
        "x-upload-sha256": createHash("sha256").update(source).digest("hex"),
      },
      body: Uint8Array.from(source).buffer,
    });
    assert.equal(written.status, 200);

    const changed = Buffer.from(source);
    changed[changed.length - 1] = 66;
    const conflictingRetry = await app.request(chunkPath, {
      method: "PUT",
      headers: {
        ...authHeader(owner),
        "content-type": "application/octet-stream",
        "x-upload-offset": "0",
        "x-upload-sha256": createHash("sha256").update(changed).digest("hex"),
      },
      body: Uint8Array.from(changed).buffer,
    });
    assert.equal(conflictingRetry.status, 409);
    assert.deepEqual(await conflictingRetry.json(), {
      detail: "重新选择的文件与已上传内容不一致，请重新开始",
    });

    const completed = await app.request(completePath, {
      method: "POST",
      headers: { ...authHeader(owner), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(completed.status, 200);
    const completedBody = (await completed.json()) as { upload: { created_at: string } };
    assert.notEqual(completedBody.upload.created_at, "2020-01-01T00:00:00.000Z");
    const retried = await app.request(completePath, {
      method: "POST",
      headers: { ...authHeader(owner), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(retried.status, 200);
    assert.equal(((await retried.json()) as { upload: { phase: string } }).upload.phase, "ready");
    assert.equal(discardReceipt(upload.upload.id, owner), true);
  });

  it("lets only the receipt owner discard a staged upload", async () => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("%PDF-1.4\n%")], "discard.ai"));
    const up = await app.request("/api/uploads", {
      method: "POST",
      headers: authHeader("ou_discard_http"),
      body: fd,
    });
    const staged = (await up.json()) as { receipt: string };

    const denied = await app.request(`/api/uploads/${staged.receipt}`, {
      method: "DELETE",
      headers: authHeader("ou_discard_other"),
    });
    assert.equal(denied.status, 200);
    assert.deepEqual(await denied.json(), { ok: true, already_deleted: true });

    const stillOwned = await app.request("/api/uploads", { headers: authHeader("ou_discard_http") });
    assert.equal(((await stillOwned.json()) as { id: string }[]).some((row) => row.id === staged.receipt), true);

    const removed = await app.request(`/api/uploads/${staged.receipt}`, {
      method: "DELETE",
      headers: authHeader("ou_discard_http"),
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true });
    const repeated = await app.request(`/api/uploads/${staged.receipt}`, {
      method: "DELETE",
      headers: authHeader("ou_discard_http"),
    });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), { ok: true, already_deleted: true });
    const listed = await app.request("/api/uploads", { headers: authHeader("ou_discard_http") });
    assert.deepEqual(await listed.json(), []);
  });

  it("分片请求间隙仍在 health 保持发版租约，删除会话后立即释放", async () => {
    const owner = "ou_release_lease";
    const before = await app.request("/api/health", { headers: { host: "127.0.0.1:8787" } });
    const beforeWaiting = ((await before.json()) as { uploads: { waiting: number } }).uploads.waiting;
    const created = await app.request("/api/uploads/sessions", {
      method: "POST",
      headers: { ...authHeader(owner), "content-type": "application/json" },
      body: JSON.stringify({
        client_upload_id: "client-release-lease",
        files: [{ field: "ai", name: "lease.ai", bytes: 32, last_modified: 1234 }],
      }),
    });
    assert.equal(created.status, 200);
    const upload = (await created.json()) as { upload: { id: string } };

    const held = await app.request("/api/health", { headers: { host: "127.0.0.1:8787" } });
    assert.equal(((await held.json()) as { uploads: { waiting: number } }).uploads.waiting, beforeWaiting + 1);

    const removed = await app.request(`/api/uploads/${upload.upload.id}`, {
      method: "DELETE",
      headers: authHeader(owner),
    });
    assert.deepEqual(await removed.json(), { ok: true });
    const released = await app.request("/api/health", { headers: { host: "127.0.0.1:8787" } });
    assert.equal(((await released.json()) as { uploads: { waiting: number } }).uploads.waiting, beforeWaiting);
  });

  it("rejects an oversized multipart body before parsing it", async () => {
    const boundary = "beian-over-limit";
    const res = await app.request("/api/uploads", {
      method: "POST",
      headers: {
        ...authHeader("ou_over_limit"),
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(MAX_UPLOAD_BODY_BYTES + 1),
      },
      body: `--${boundary}--\r\n`,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { detail: "上传总量超过 100 MB" });
  });

  it("returns an actionable 400 for a truncated multipart upload", async () => {
    const boundary = "beian-truncated";
    const res = await app.request("/api/uploads", {
      method: "POST",
      headers: {
        ...authHeader("ou_truncated"),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="pdf"; filename="broken.pdf"',
        "Content-Type: application/pdf",
        "",
        "%PDF-1.4 without closing boundary",
      ].join("\r\n"),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { detail: "上传中断，请重新上传" });
  });

  it("returns the pending-receipt quota as a 429 instead of a server error", async () => {
    const owner = "ou_http_quota";
    const held = Array.from({ length: MAX_PENDING_RECEIPTS_PER_OWNER }, (_, index) =>
      stageBuffers(owner, [{ field: "ai", name: `held-${index}.ai`, buf: Buffer.from("%PDF") }]),
    );
    try {
      const form = new FormData();
      form.append("file", new File([Buffer.from("%PDF")], "next.ai"));
      const res = await app.request("/api/uploads", { method: "POST", headers: authHeader(owner), body: form });
      assert.equal(res.status, 429);
      assert.deepEqual(await res.json(), {
        detail: `待开工上传最多保留 ${MAX_PENDING_RECEIPTS_PER_OWNER} 单，请先开始已有上传`,
      });
    } finally {
      for (const rec of held) discardReceipt(rec.id, owner);
    }
  });

  it("lazily removes expired receipt JSON and files while listing", async () => {
    const rec = stageBuffers("ou_http_expired", [{
      field: "ai",
      name: "expired.ai",
      buf: Buffer.from("%PDF"),
    }]);
    const root = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    const jsonPath = join(root, `${rec.id}.json`);
    const filesPath = join(root, rec.id);
    writeFileSync(jsonPath, JSON.stringify({ ...rec, created_at: "2020-01-01T00:00:00.000Z" }));

    const listed = await app.request("/api/uploads", { headers: authHeader("ou_http_expired") });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), []);
    assert.equal(existsSync(jsonPath), false);
    assert.equal(existsSync(filesPath), false);
  });

  it("does not let another Feishu account with the same display name start from this receipt", async () => {
    const fd = new FormData();
    fd.append("excel", new File([Buffer.from("PK\x03\x04xxxx")], "a.xlsx"));
    fd.append("pdf", new File([Buffer.from("%PDF-1.4\n%")], "a.pdf"));
    const up = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_a"), body: fd });
    assert.equal(up.status, 200);
    const staged = (await up.json()) as { receipt?: string };
    const start = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader("ou_b", "魏炜"), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(start.status, 400);
  });

  it("keeps the receipt when start is missing the product name", async () => {
    const fd = new FormData();
    fd.append("excel", new File([Buffer.from("PK\x03\x04xxxx")], "a.xlsx"));
    fd.append("pdf", new File([Buffer.from("%PDF-1.4\n%")], "a.pdf"));
    const up = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_empty_name"), body: fd });
    const staged = (await up.json()) as { receipt?: string };
    const start = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader("ou_empty_name"), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "" }),
    });
    assert.equal(start.status, 400);
    setJobsTestHooks({
      runCompare: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }),
    });
    try {
      const retry = await app.request("/api/tasks/start", {
        method: "POST",
        headers: { ...authHeader("ou_empty_name"), "content-type": "application/json" },
        body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
      });
      assert.equal(retry.status, 200);
    } finally {
      resetJobsTestHooks();
    }
  });

  it("does not start compare from an ai receipt", async () => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("%PDF-1.4\n%")], "box.ai"));
    const up = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_ai_only"), body: fd });
    const staged = (await up.json()) as { receipt?: string };
    const start = await app.request("/api/tasks/start", {
      method: "POST",
      headers: { ...authHeader("ou_ai_only"), "content-type": "application/json" },
      body: JSON.stringify({ receipt: staged.receipt, product_name: "喷雾" }),
    });
    assert.equal(start.status, 400);
  });

  it("does not let another Feishu account with the same display name read this task", async () => {
    setJobsTestHooks({
      runCompare: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }),
    });
    try {
      const fd = new FormData();
      fd.append("excel", new File([Buffer.from("PK\x03\x04xxxx")], "a.xlsx"));
      fd.append("pdf", new File([Buffer.from("%PDF-1.4\n%")], "a.pdf"));
      const up = await app.request("/api/uploads", { method: "POST", headers: authHeader("ou_same_a", "同名"), body: fd });
      const staged = (await up.json()) as { receipt?: string };
      const start = await app.request("/api/tasks/start", {
        method: "POST",
        headers: { ...authHeader("ou_same_a", "同名"), "content-type": "application/json" },
        body: JSON.stringify({ receipt: staged.receipt, product_name: "同名隔离" }),
      });
      assert.equal(start.status, 200);
      const task = (await start.json()) as { id?: string };
      const denied = await app.request(`/api/tasks/${task.id}`, {
        headers: authHeader("ou_same_b", "同名", "reviewer"),
      });
      assert.equal(denied.status, 403);
    } finally {
      resetJobsTestHooks();
    }
  });
});
