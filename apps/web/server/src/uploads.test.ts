import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-uploads-"));

const { consumeReceipt, loadReceipt, magicOk, purgeReceiptFiles, receiptOwner, stageBuffers, tooLarge } = await import("./uploads.js");

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
    writeFileSync(
      path,
      JSON.stringify({ ...rec, created_at: "2020-01-01T00:00:00.000Z" }),
    );
    assert.equal(loadReceipt(rec.id, "ou_ttl"), null);
    assert.equal(consumeReceipt(rec.id, "ou_ttl"), null);
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
});
