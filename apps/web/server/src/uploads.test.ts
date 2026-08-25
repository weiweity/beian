import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-uploads-"));

const { consumeReceipt, magicOk, receiptOwner, stageBuffers, tooLarge } = await import("./uploads.js");

describe("uploads staging", () => {
  it("rejects a pdf that is not a pdf", () => {
    assert.equal(magicOk("pdf", Buffer.from("not-pdf"), "a.pdf"), "不是有效的 PDF");
    assert.equal(magicOk("excel", Buffer.from("PK\x03\x04xx"), "a.xlsx"), null);
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
  });
});
