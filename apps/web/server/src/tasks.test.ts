import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-ts-"));

const { listTasks, saveTask } = await import("./tasks.js");

describe("listTasks", () => {
  before(() => {
    saveTask({
      id: "aaaaaaaaaaaa",
      title: "某某精华",
      product_name: "某某精华",
      type: "excel_pdf",
      status: "in_review",
      created_at: "2026-08-19T10:00:00Z",
    });
    saveTask({
      id: "bbbbbbbbbbbb",
      title: "另一支霜",
      product_name: "另一支霜",
      type: "excel_pdf",
      status: "completed",
      created_at: "2026-08-19T09:00:00Z",
    });
  });

  it("待签在前", () => {
    const rows = listTasks();
    assert.equal(rows[0]?.product_name, "某某精华");
    assert.equal(rows[1]?.product_name, "另一支霜");
  });

  it("按品名搜", () => {
    const rows = listTasks("精华");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "aaaaaaaaaaaa");
  });

  it("搜不到为空", () => {
    assert.deepEqual(listTasks("没有这个品"), []);
  });
});
