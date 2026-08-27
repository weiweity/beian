import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { historyRowAction } from "./HistoryPage.js";
import type { HistoryRow } from "./historyRows.js";

function row(kind: HistoryRow["kind"], color: HistoryRow["color"] = "success"): HistoryRow {
  return {
    resource: kind === "审稿台" ? "task" : "mockup",
    kind,
    id: `${kind}-1`,
    title: "花盒",
    status: color === "processing" ? "对照中" : "已完成",
    color,
    at: "2026-08-26T00:00:00.000Z",
    actor: "籽烨",
    live: color === "processing" ? "认字" : null,
  };
}

describe("historyRowAction", () => {
  it("opens either desk outside batch-edit mode", () => {
    assert.equal(historyRowAction(row("审稿台"), false), "open-task");
    assert.equal(historyRowAction(row("打样台"), false), "open-mockup");
  });

  it("selects deletable rows but blocks running rows in batch-edit mode", () => {
    assert.equal(historyRowAction(row("审稿台"), true), "toggle");
    assert.equal(historyRowAction(row("审稿台", "processing"), true), "blocked");
  });
});
