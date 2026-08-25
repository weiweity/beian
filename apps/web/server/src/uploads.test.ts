import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-uploads-"));

const {
  consumeReceipt,
  createUploadAdmission,
  discardReceipt,
  listReceipts,
  loadReceipt,
  magicOk,
  MAX_PENDING_RECEIPTS_PER_OWNER,
  MAX_PENDING_BYTES_GLOBAL,
  MAX_PENDING_BYTES_PER_OWNER,
  MAX_UPLOAD_FILES_BYTES,
  purgeReceiptFiles,
  receiptOwner,
  restoreReceipt,
  stageBuffers,
  sweepReceipts,
  tooLarge,
  uploadTotalTooLarge,
} = await import("./uploads.js");

describe("uploads staging", () => {
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
    const first = consumeReceipt(rec.id, "魏炜");
    assert.ok(first);
    assert.equal(consumeReceipt(rec.id, "魏炜"), null);
  });

  it("does not hand a receipt to another display name", () => {
    const rec = stageBuffers("魏炜", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    assert.equal(consumeReceipt(rec.id, "刘籽烨"), null);
  });

  it("binds a receipt to open_id when the session has one", () => {
    assert.equal(receiptOwner({ open_id: "ou_weiwei", display_name: "魏炜" }), "ou_weiwei");
    assert.equal(receiptOwner({ open_id: "", display_name: "天元" }), "天元");
    const rec = stageBuffers("ou_weiwei", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    assert.equal(consumeReceipt(rec.id, "魏炜"), null);
    assert.ok(consumeReceipt(rec.id, "ou_weiwei"));
  });

  it("tooLarge is false for tiny buffers", () => {
    assert.equal(tooLarge(12), false);
    assert.equal(tooLarge(201 * 1024 * 1024), true);
    assert.equal(uploadTotalTooLarge([MAX_UPLOAD_FILES_BYTES]), false);
    assert.equal(uploadTotalTooLarge([MAX_UPLOAD_FILES_BYTES, 1]), true);
  });

  it("ignores a receipt id that is not a tid", () => {
    const rec = stageBuffers("ou_weiwei", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    assert.equal(consumeReceipt(`../tasks/${rec.id}`, "ou_weiwei"), null);
    assert.equal(consumeReceipt("../../settings.json", "ou_weiwei"), null);
    assert.ok(loadReceipt(rec.id, "ou_weiwei"));
  });

  it("does not hand an empty-owner receipt to anyone", () => {
    const id = "cafebabeface";
    const dir = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        id,
        owner: "",
        created_at: new Date().toISOString(),
        files: [{ field: "ai", name: "box.ai", path: join(dir, id, "ai-box.ai"), bytes: 4 }],
      }),
    );
    assert.equal(loadReceipt(id, "ou_anyone"), null);
    assert.equal(consumeReceipt(id, "ou_anyone"), null);
    assert.equal(existsSync(join(dir, `${id}.json`)), true);
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
    assert.equal(consumeReceipt(rec.id, "ou_ttl"), null);
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
    assert.deepEqual(Object.keys(compareRow?.files[0] || {}).sort(), ["bytes", "field", "name"]);
    assert.equal(listed.find((row) => row.id === mockup.id)?.kind, "mockup");

    for (const [rec, owner] of [[compare, "ou_list"], [mockup, "ou_list"], [other, "ou_other"]] as const) {
      assert.ok(consumeReceipt(rec.id, owner));
      purgeReceiptFiles(rec.id);
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
      assert.ok(consumeReceipt(rec.id, "ou_repeat"));
      purgeReceiptFiles(rec.id);
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

  it("admits only one upload body parser and rejects excess requests with 429", async () => {
    const gate = createUploadAdmission(1);
    const entered: string[] = [];
    let releaseFirst!: () => void;
    const first = gate.run(async () => {
      entered.push("first");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(
      gate.run(async () => {
        entered.push("overflow");
      }),
      (err: unknown) =>
        err instanceof Error && /已有文件正在上传/.test(err.message) && (err as Error & { status?: number }).status === 429,
    );
    assert.deepEqual(entered, ["first"]);
    assert.deepEqual(gate.snapshot(), { active: 1, waiting: 0 });
    releaseFirst();
    await first;
    await gate.run(async () => {
      entered.push("second");
    });
    assert.deepEqual(entered, ["first", "second"]);
    assert.deepEqual(gate.snapshot(), { active: 0, waiting: 0 });
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

  it("purges the staging directory after consume", () => {
    const rec = stageBuffers("ou_purge", [
      { field: "excel", name: "a.xlsx", buf: Buffer.from("PK\x03\x04hello") },
      { field: "pdf", name: "a.pdf", buf: Buffer.from("%PDF-1.4\n%") },
    ]);
    const staged = rec.files[0]?.path || "";
    assert.ok(existsSync(staged));
    assert.ok(consumeReceipt(rec.id, "ou_purge"));
    assert.ok(existsSync(staged));
    purgeReceiptFiles(rec.id);
    assert.equal(existsSync(join(process.env.WB_DATA_DIR!, "uploads", "receipts", rec.id)), false);
  });

  it("restores a consumed receipt when task preparation fails before enqueue", () => {
    const rec = stageBuffers("ou_restore", [{ field: "ai", name: "box.ai", buf: Buffer.from("%PDF") }]);
    const taken = consumeReceipt(rec.id, "ou_restore");
    assert.ok(taken);
    assert.equal(loadReceipt(rec.id, "ou_restore"), null);
    assert.equal(restoreReceipt(taken!), true);
    assert.ok(loadReceipt(rec.id, "ou_restore"));
    assert.equal(discardReceipt(rec.id, "ou_restore"), true);
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

  it("sweep removes stale orphan directories and abandoned take files", () => {
    const root = join(process.env.WB_DATA_DIR!, "uploads", "receipts");
    mkdirSync(root, { recursive: true });
    const id = "f20000000001";
    const orphan = join(root, id);
    const taken = join(root, `${id}.json.999.0.take`);
    mkdirSync(orphan);
    writeFileSync(join(orphan, "ai-orphan.ai"), "%PDF");
    writeFileSync(taken, "{}");
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(orphan, old, old);
    utimesSync(taken, old, old);

    sweepReceipts();
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(taken), false);
  });
});
