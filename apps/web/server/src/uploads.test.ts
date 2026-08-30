import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-uploads-");

const {
  claimReceipt,
  commitReceiptClaim,
  createUploadAdmission,
  discardReceipt,
  listReceipts,
  loadReceipt,
  magicOk,
  MAX_PENDING_RECEIPTS_PER_OWNER,
  MAX_PENDING_BYTES_GLOBAL,
  MAX_PENDING_BYTES_PER_OWNER,
  MAX_UPLOAD_FILES_BYTES,
  recoverReceiptClaims,
  receiptOwner,
  rollbackReceiptClaim,
  serializeReceiptStart,
  UPLOAD_CONCURRENCY,
  stageMultipart,
  stageBuffers,
  sweepReceipts,
  tooLarge,
  uploadTotalTooLarge,
} = await import("./uploads.js");

async function stageFormData(owner: string, form: FormData) {
  const request = new Request("http://beian.test/api/uploads", { method: "POST", body: form });
  assert.ok(request.body);
  return stageMultipart(
    owner,
    request.body as unknown as AsyncIterable<Uint8Array>,
    request.headers.get("content-type") || "",
  );
}

describe("uploads staging", () => {
  it("serializes overlapping starts for one receipt", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = serializeReceiptStart("face00000001", "ou_serial", async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = serializeReceiptStart("face00000001", "ou_serial", async () => {
      order.push("second:start");
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
  });

  it("releases the receipt start queue when the first start fails", async () => {
    const order: string[] = [];
    const first = serializeReceiptStart("face00000002", "ou_serial", async () => {
      order.push("first:start");
      throw new Error("first start failed");
    });
    const second = serializeReceiptStart("face00000002", "ou_serial", async () => {
      order.push("second:start");
      return "started";
    });

    await assert.rejects(first, /first start failed/);
    assert.equal(await second, "started");
    assert.deepEqual(order, ["first:start", "second:start"]);
  });

  it("rejects a pdf that is not a pdf", () => {
    assert.equal(magicOk("pdf", Buffer.from("not-pdf"), "a.pdf"), "不是有效的 PDF");
    assert.equal(magicOk("excel", Buffer.from("PK\x03\x04xx"), "a.xlsx"), null);
    assert.equal(magicOk("excel", Buffer.from("notzip"), "a.xlsx"), "Excel 必须是 .xlsx（ZIP 格式）");
  });

  it("stores a receipt then consumes it once", () => {
    const rec = stageBuffers("魏炜", [
      { field: "excel", name: "a.xlsx", buf: Buffer.from("PK\x03\x04hello") },
      { field: "pdf", name: "a.pdf", buf: Buffer.from("%PDF-1.4\n%") },
    ]);
    assert.ok(rec.id);
    assert.equal(rec.files.length, 2);
    const first = claimReceipt(rec.id, "魏炜");
    assert.ok(first);
    assert.equal(claimReceipt(rec.id, "魏炜"), null);
    assert.equal(commitReceiptClaim(first), true);
  });

  it("does not hand a receipt to another display name", () => {
    const rec = stageBuffers("魏炜", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    assert.equal(claimReceipt(rec.id, "刘籽烨"), null);
  });

  it("binds a receipt to open_id when the session has one", () => {
    assert.equal(receiptOwner({ open_id: "ou_weiwei", display_name: "魏炜" }), "ou_weiwei");
    assert.equal(receiptOwner({ open_id: "", display_name: "天元" }), "天元");
    const rec = stageBuffers("ou_weiwei", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    assert.equal(claimReceipt(rec.id, "魏炜"), null);
    const claim = claimReceipt(rec.id, "ou_weiwei");
    assert.ok(claim);
    assert.equal(commitReceiptClaim(claim), true);
  });

  it("tooLarge is false for tiny buffers", () => {
    assert.equal(tooLarge(12), false);
    assert.equal(tooLarge(201 * 1024 * 1024), true);
    assert.equal(uploadTotalTooLarge([MAX_UPLOAD_FILES_BYTES]), false);
    assert.equal(uploadTotalTooLarge([MAX_UPLOAD_FILES_BYTES, 1]), true);
  });

  it("ignores a receipt id that is not a tid", () => {
    const rec = stageBuffers("ou_weiwei", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    assert.equal(claimReceipt(`../tasks/${rec.id}`, "ou_weiwei"), null);
    assert.equal(claimReceipt("../../settings.json", "ou_weiwei"), null);
    assert.ok(loadReceipt(rec.id, "ou_weiwei"));
  });

  it("does not hand an empty-owner receipt to anyone", () => {
    const id = "cafebabeface";
    const dir = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    const stagedDir = join(dir, id);
    const stagedPath = join(stagedDir, "ai-box.ai");
    mkdirSync(dir, { recursive: true });
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(stagedPath, "%PDF");
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        id,
        owner: "",
        created_at: new Date().toISOString(),
        files: [{ field: "ai", name: "box.ai", path: stagedPath, bytes: 4 }],
      }),
    );
    assert.equal(loadReceipt(id, "ou_anyone"), null);
    assert.equal(claimReceipt(id, "ou_anyone"), null);
    assert.equal(existsSync(join(dir, `${id}.json`)), true);
    assert.equal(existsSync(stagedPath), true);
    rmSync(join(dir, `${id}.json`), { force: true });
    rmSync(stagedDir, { recursive: true, force: true });
  });

  it("treats an expired receipt as missing", () => {
    const rec = stageBuffers("ou_ttl", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    const path = join(process.env.WB_DATA_DIR!, "uploads", "receipts", `${rec.id}.json`);
    const dir = join(process.env.WB_DATA_DIR!, "uploads", "receipts", rec.id);
    writeFileSync(
      path,
      JSON.stringify({ ...rec, created_at: "2020-01-01T00:00:00.000Z" }),
    );
    assert.equal(existsSync(dir), true);
    assert.equal(loadReceipt(rec.id, "ou_ttl"), null);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(dir), false);
    assert.equal(claimReceipt(rec.id, "ou_ttl"), null);
  });

  it("lists only fresh receipts owned by this open_id with public file metadata", () => {
    const compare = stageBuffers("ou_list", [
      { field: "excel", name: "a.xlsx", buf: Buffer.from("PK\x03\x04hello") },
      { field: "pdf", name: "a.pdf", buf: Buffer.from("%PDF-1.4\n%") },
    ]);
    const mockup = stageBuffers("ou_list", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    const other = stageBuffers("ou_other", [{ field: "ai", name: "other.ai", buf: Buffer.from("%PDF") }]);

    const listed = listReceipts("ou_list");
    assert.deepEqual(new Set(listed.map((row) => row.id)), new Set([compare.id, mockup.id]));
    assert.equal(listed.some((row) => row.id === other.id), false);
    const compareRow = listed.find((row) => row.id === compare.id);
    assert.equal(compareRow?.kind, "compare");
    assert.equal(compareRow?.bytes, compare.files.reduce((sum, file) => sum + file.bytes, 0));
    assert.deepEqual(Object.keys(compareRow?.files[0] || {}).sort(), ["bytes", "field", "name", "received"]);
    assert.equal(compareRow?.phase, "ready");
    assert.equal(compareRow?.received, compareRow?.bytes);
    assert.equal(listed.find((row) => row.id === mockup.id)?.kind, "mockup");

    for (const [rec, owner] of [[compare, "ou_list"], [mockup, "ou_list"], [other, "ou_other"]] as const) {
      const claim = claimReceipt(rec.id, owner);
      assert.ok(claim);
      assert.equal(commitReceiptClaim(claim), true);
    }
  });

  it("keeps repeated uploads of the same file as independent receipts", () => {
    const part = { field: "ai", name: "same.ai", buf: Buffer.from("%PDF") };
    const first = stageBuffers("ou_repeat", [part]);
    const second = stageBuffers("ou_repeat", [part]);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.files[0]?.path, second.files[0]?.path);
    assert.equal(existsSync(first.files[0]?.path || ""), true);
    assert.equal(existsSync(second.files[0]?.path || ""), true);
    assert.deepEqual(new Set(listReceipts("ou_repeat").map((row) => row.id)), new Set([first.id, second.id]));
    for (const rec of [first, second]) {
      const claim = claimReceipt(rec.id, "ou_repeat");
      assert.ok(claim);
      assert.equal(commitReceiptClaim(claim), true);
    }
  });

  it("bounds how many unstarted receipts one account can retain", () => {
    const owner = "ou_quota";
    const held = Array.from({ length: MAX_PENDING_RECEIPTS_PER_OWNER }, (_, index) =>
      stageBuffers(owner, [{ field: "ai", name: `box-${index}.ai`, buf: Buffer.from("%PDF") }]),
    );
    assert.throws(
      () => stageBuffers(owner, [{ field: "ai", name: "one-too-many.ai", buf: Buffer.from("%PDF") }]),
      /待开工上传最多保留/,
    );
    for (const rec of held) assert.equal(discardReceipt(rec.id, owner), true);
  });

  it("bounds retained bytes per account and globally without loading staged files", () => {
    const root = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    mkdirSync(root, { recursive: true });
    const cases = [
      {
        id: "f10000000001",
        owner: "ou_owner_bytes",
        bytes: MAX_PENDING_BYTES_PER_OWNER,
        nextOwner: "ou_owner_bytes",
        error: /待开工上传总量超过 400 MB/,
      },
      {
        id: "f10000000002",
        owner: "ou_global_holder",
        bytes: MAX_PENDING_BYTES_GLOBAL,
        nextOwner: "ou_global_next",
        error: /上传暂存区繁忙/,
      },
    ] as const;

    for (const item of cases) {
      const json = join(root, `${item.id}.json`);
      writeFileSync(
        json,
        JSON.stringify({
          id: item.id,
          owner: item.owner,
          created_at: new Date().toISOString(),
          files: [{
            field: "ai",
            name: "held.ai",
            path: join(root, item.id, "ai-held.ai"),
            bytes: item.bytes,
          }],
        }),
      );
      try {
        assert.throws(
          () => stageBuffers(item.nextOwner, [{ field: "ai", name: "next.ai", buf: Buffer.from("%PDF") }]),
          item.error,
        );
      } finally {
        rmSync(json, { force: true });
      }
    }
  });

  it("admits two streaming uploads and rejects only the third with 429", async () => {
    const gate = createUploadAdmission(UPLOAD_CONCURRENCY);
    const entered: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = gate.run(async () => {
      entered.push("first");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const second = gate.run(async () => {
      entered.push("second");
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(
      gate.run(async () => {
        entered.push("overflow");
      }),
      (err: unknown) =>
        err instanceof Error && /同时最多上传 2 份/.test(err.message) && (err as Error & { status?: number }).status === 429,
    );
    assert.deepEqual(entered, ["first", "second"]);
    assert.deepEqual(gate.snapshot(), { active: 2, waiting: 0 });
    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);
    await gate.run(async () => {
      entered.push("third-after-release");
    });
    assert.deepEqual(entered, ["first", "second", "third-after-release"]);
    assert.deepEqual(gate.snapshot(), { active: 0, waiting: 0 });
  });

  it("rejects duplicate multipart file fields and removes partial streaming files", async () => {
    const root = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    mkdirSync(root, { recursive: true });
    const before = readdirSync(root).sort();
    const form = new FormData();
    form.append("pdf", new File([Buffer.from("%PDF-1.4\nfirst")], "first.pdf"));
    form.append("pdf", new File([Buffer.from("%PDF-1.4\nsecond")], "second.pdf"));

    await assert.rejects(stageFormData("ou_duplicate_stream", form), /同一文件栏只能上传一个文件/);
    assert.deepEqual(readdirSync(root).sort(), before);
  });

  it("rolls back staging when a later file fails validation", () => {
    const root = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    mkdirSync(root, { recursive: true });
    const before = readdirSync(root).sort();
    assert.throws(
      () => stageBuffers("ou_rollback", [
        { field: "excel", name: "a.xlsx", buf: Buffer.from("PK\x03\x04hello") },
        { field: "pdf", name: "broken.pdf", buf: Buffer.from("not-pdf") },
      ]),
      /不是有效的 PDF/,
    );
    assert.deepEqual(readdirSync(root).sort(), before);
  });

  it("rolls back its directory when writing a staged file fails", () => {
    const root = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    mkdirSync(root, { recursive: true });
    const before = readdirSync(root).sort();
    assert.throws(() => stageBuffers("ou_write_fail", [{
      field: "pdf",
      name: `${"x".repeat(5000)}.pdf`,
      buf: Buffer.from("%PDF-1.4\n%"),
    }]));
    assert.deepEqual(readdirSync(root).sort(), before);
  });

  it("keeps staged files while claimed and purges them only after commit", () => {
    const rec = stageBuffers("ou_purge", [
      { field: "excel", name: "a.xlsx", buf: Buffer.from("PK\x03\x04hello") },
      { field: "pdf", name: "a.pdf", buf: Buffer.from("%PDF-1.4\n%") },
    ]);
    const staged = rec.files[0]?.path || "";
    assert.ok(existsSync(staged));
    const claim = claimReceipt(rec.id, "ou_purge");
    assert.ok(claim);
    assert.ok(existsSync(staged));
    assert.equal(commitReceiptClaim(claim), true);
    assert.equal(existsSync(join(process.env.WB_DATA_DIR!, "uploads", "receipts", rec.id)), false);
  });

  it("rolls back a claimed receipt when task preparation fails before persistence", () => {
    const rec = stageBuffers("ou_restore", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    const claim = claimReceipt(rec.id, "ou_restore");
    assert.ok(claim);
    assert.equal(loadReceipt(rec.id, "ou_restore"), null);
    assert.equal(rollbackReceiptClaim(claim), true);
    assert.ok(loadReceipt(rec.id, "ou_restore"));
    assert.equal(discardReceipt(rec.id, "ou_restore"), true);
    assert.equal(existsSync(rec.files[0]?.path || ""), false);
  });

  it("recovers an uncommitted crash marker and finalizes a committed one on restart", () => {
    const rec = stageBuffers("ou_recover", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    const first = claimReceipt(rec.id, "ou_recover");
    assert.ok(first);
    assert.equal(existsSync(first.marker_path), true);
    assert.deepEqual(recoverReceiptClaims(() => false), { restored: 1, committed: 0, discarded: 0 });
    assert.ok(loadReceipt(rec.id, "ou_recover"));

    const second = claimReceipt(rec.id, "ou_recover");
    assert.ok(second);
    assert.deepEqual(
      recoverReceiptClaims((receipt) => receipt.id === rec.id && receipt.owner === "ou_recover"),
      { restored: 0, committed: 1, discarded: 0 },
    );
    assert.equal(existsSync(second.marker_path), false);
    assert.equal(existsSync(rec.files[0]?.path || ""), false);
  });

  it("finishes a durable discard marker on restart instead of restoring the receipt", () => {
    const rec = stageBuffers("ou_discard_recover", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    const claim = claimReceipt(rec.id, "ou_discard_recover");
    assert.ok(claim);
    const discardMarker = `${claim.marker_path}.discard`;
    renameSync(claim.marker_path, discardMarker);
    const root = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    writeFileSync(join(root, `${rec.id}.json`), JSON.stringify(rec));

    assert.deepEqual(recoverReceiptClaims(() => false), { restored: 0, committed: 0, discarded: 1 });
    assert.equal(existsSync(discardMarker), false);
    assert.equal(loadReceipt(rec.id, "ou_discard_recover"), null);
    assert.equal(existsSync(rec.files[0]?.path || ""), false);
  });

  it("discard is owner-bound and removes the receipt files", () => {
    const rec = stageBuffers("ou_discard", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    assert.equal(discardReceipt(rec.id, "ou_other"), false);
    assert.ok(loadReceipt(rec.id, "ou_discard"));
    assert.equal(discardReceipt(rec.id, "ou_discard"), true);
    assert.equal(loadReceipt(rec.id, "ou_discard"), null);
    assert.equal(existsSync(rec.files[0]?.path || ""), false);
  });

  it("listing purges a damaged receipt and its staged directory", () => {
    const rec = stageBuffers("ou_broken", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    const root = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    writeFileSync(join(root, `${rec.id}.json`), "{broken");
    listReceipts("ou_broken");
    assert.equal(existsSync(join(root, `${rec.id}.json`)), false);
    assert.equal(existsSync(join(root, rec.id)), false);
  });

  it("sweep removes stale orphan, incoming and abandoned take files", () => {
    const root = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    mkdirSync(root, { recursive: true });
    const id = "f20000000001";
    const orphan = join(root, id);
    const incoming = join(root, ".incoming-stale");
    const taken = join(root, `${id}.json.999.0.take`);
    mkdirSync(orphan);
    mkdirSync(incoming);
    writeFileSync(join(orphan, "ai-orphan.ai"), "%PDF");
    writeFileSync(join(incoming, "pdf-partial.pdf"), "%PDF");
    writeFileSync(taken, "{}");
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(orphan, old, old);
    utimesSync(incoming, old, old);
    utimesSync(taken, old, old);

    sweepReceipts();
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(incoming), false);
    assert.equal(existsSync(taken), false);
  });
});
