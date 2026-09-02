import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterHistoryRows,
  historyActors,
  historyCanDelete,
  historyHasLive,
  historyMockRow,
  paginateHistoryRows,
  historyRowKey,
  historySelectionState,
  historyTaskRow,
  type HistoryRow,
} from "./historyRows.js";

describe("historyTaskRow", () => {
  it("shows live compare progress while the job is running", () => {
    const row = historyTaskRow({
      id: "t1",
      title: "花盒",
      product_name: "达肤妍",
      type: "pack",
      status: "comparing",
      job_status: "running",
      job_stage_label: "认字",
      job_eta_s: 40,
    });
    assert.equal(row.kind, "审稿台");
    assert.equal(row.status, "对照中");
    assert.equal(row.color, "processing");
    assert.equal(row.live, "认字 · 大约还要 40 秒");
    assert.doesNotMatch(row.live || "", /%/);
  });

  it("keeps a queued mockup in history with queue line", () => {
    const row = historyMockRow({
      id: "m1",
      status: "queued",
      title: "7片装花盒",
      files: [{ key: "a", name: "a.ai" }],
      job_status: "queued",
      queue_ahead: 1,
    });
    assert.equal(row.kind, "打样台");
    assert.equal(row.status, "打样中");
    assert.equal(row.color, "processing");
    assert.equal(row.live, "前面还有 1 单");
  });

  it("shows mockup stage once blender is running", () => {
    const row = historyMockRow({
      id: "m2",
      status: "running",
      title: "7片装花盒",
      files: [],
      job_stage_label: "打样",
      job_eta_s: 240,
    });
    assert.equal(row.status, "打样中");
    assert.equal(row.live, "打样 · 大约还要 4 分钟");
  });

  it("keeps structure review recoverable instead of calling it upload failure", () => {
    const row = historyMockRow({
      id: "structure1",
      title: "花盒",
      status: "review_required",
      structure_status: "review_required",
      job_status: "waiting_input",
      files: [],
    });
    assert.equal(row.status, "打样失败");
    assert.equal(row.color, "error");
    assert.equal(row.live, null);
    assert.equal(historyCanDelete(row), true);
  });

  it("keeps a unique missing front as 待选正面 instead of a failed mockup", () => {
    const row = historyMockRow({
      id: "structure2",
      title: "花盒",
      status: "review_required",
      structure_status: "review_required",
      structure_code: "structure_face_mapping_incomplete",
      job_status: "waiting_input",
      files: [],
    });
    assert.equal(row.status, "待选正面");
    assert.equal(row.color, "warning");
    assert.equal(row.live, null);
    assert.equal(historyCanDelete(row), true);
  });

  it("keeps a stale failed shell locked while its worker slot is still running", () => {
    const row = historyMockRow({
      id: "m3",
      status: "failed",
      title: "7片装花盒",
      files: [],
      job_status: "running",
      job_stage_label: "导出",
    });
    assert.equal(row.status, "打样中");
    assert.equal(row.color, "processing");
    assert.equal(historyCanDelete(row), false);
  });
});

describe("historyHasLive", () => {
  it("is true while either desk still has a running row", () => {
    const live = historyMockRow({
      id: "m",
      status: "running",
      title: "x",
      files: [],
    });
    const done = historyTaskRow({
      id: "t",
      title: "y",
      type: "pack",
      status: "completed",
    });
    assert.equal(historyHasLive([live, done]), true);
    assert.equal(historyHasLive([done]), false);
  });

  it("labels pending review as 待审核", () => {
    const row = historyTaskRow({
      id: "t2",
      title: "花盒",
      product_name: "达肤妍",
      type: "pack",
      status: "pending_review",
    });
    assert.equal(row.status, "待审核");
    assert.doesNotMatch(row.status, /待她判/);
  });

  it("已签字后仍按建单人显示和筛选，不把签字人当生成人", () => {
    const row = historyTaskRow({
      id: "t3",
      title: "花盒",
      type: "pack",
      status: "completed",
      owner: "魏炜",
      completed_by: "籽烨",
    });
    assert.equal(row.actor, "魏炜");
  });
});

describe("history filters and batch selection", () => {
  const rows: HistoryRow[] = [
    {
      resource: "task",
      kind: "审稿台",
      id: "a",
      title: "喷雾",
      status: "已签字",
      color: "success",
      at: "2026-08-26T02:00:00.000Z",
      actor: "籽烨",
      live: null,
    },
    {
      resource: "mockup",
      kind: "打样台",
      id: "b",
      title: "花盒",
      status: "已出图",
      color: "success",
      at: "2026-08-20T02:00:00.000Z",
      actor: "魏炜",
      live: null,
    },
    {
      resource: "task",
      kind: "审稿台",
      id: "c",
      title: "旧单",
      status: "对照中",
      color: "processing",
      at: "2026-07-01T02:00:00.000Z",
      actor: "籽烨",
      live: "认字",
    },
  ];

  it("combines desk, time and actor filters", () => {
    const filtered = filterHistoryRows(
      rows,
      { kind: "审稿台", time: "近 7 天", actor: "籽烨" },
      new Date("2026-08-26T12:00:00.000Z"),
    );
    assert.deepEqual(filtered.map((row) => row.id), ["a"]);
  });

  it("uses an explicit date range instead of the preset time chip", () => {
    const filtered = filterHistoryRows(
      rows,
      {
        kind: "全部",
        time: "今天",
        actor: "魏炜",
        range: {
          from: new Date("2026-08-19T00:00:00.000Z"),
          to: new Date("2026-08-21T23:59:59.999Z"),
        },
      },
      new Date("2026-08-26T12:00:00.000Z"),
    );
    assert.deepEqual(filtered.map((row) => row.id), ["b"]);
  });

  it("treats 今天 as the local calendar day and drops invalid timestamps", () => {
    const invalid = { ...rows[0], id: "bad", at: "not-a-date" };
    const filtered = filterHistoryRows(
      [...rows, invalid],
      { kind: "全部", time: "今天", actor: "" },
      new Date("2026-08-26T12:00:00.000Z"),
    );
    assert.deepEqual(filtered.map((row) => row.id), ["a"]);
  });

  it("lists unique non-empty actors and keeps running rows out of deletion", () => {
    assert.deepEqual(historyActors([...rows, { ...rows[0], id: "d", actor: "" }]), ["魏炜", "籽烨"]);
    assert.equal(historyCanDelete(rows[0]), true);
    assert.equal(historyCanDelete(rows[2]), false);
    assert.equal(historyRowKey(rows[0]), "task-a");
  });

  it("selects every deletable visible row and reports the indeterminate state", () => {
    const selectable = historySelectionState(rows, []);
    assert.deepEqual(selectable.keys, ["task-a", "mockup-b"]);
    assert.equal(selectable.all, false);
    assert.equal(selectable.some, false);

    const partial = historySelectionState(rows, ["task-a"]);
    assert.equal(partial.all, false);
    assert.equal(partial.some, true);

    const all = historySelectionState(rows, selectable.keys);
    assert.equal(all.all, true);
    assert.equal(all.some, false);
  });

  it("paginates merged history at ten rows and clamps a stale page", () => {
    const many = Array.from({ length: 23 }, (_, index) => ({
      ...rows[0],
      id: String(index + 1),
    }));
    assert.deepEqual(paginateHistoryRows(many, 1).rows.map((row) => row.id), many.slice(0, 10).map((row) => row.id));
    assert.equal(paginateHistoryRows(many, 2).rows.length, 10);
    assert.equal(paginateHistoryRows(many, 3).rows.length, 3);
    assert.deepEqual(paginateHistoryRows(many, 99), {
      page: 3,
      pageCount: 3,
      rows: many.slice(20),
    });
    assert.deepEqual(paginateHistoryRows([], 4), { page: 1, pageCount: 1, rows: [] });
  });

  it("filters the merged history before paginating and clamps a page removed by the filter", () => {
    const many = Array.from({ length: 23 }, (_, index) => ({
      ...rows[index % 2],
      id: String(index + 1),
    }));
    const mockups = filterHistoryRows(many, { kind: "打样台", time: "全部", actor: "" });

    assert.equal(mockups.length, 11);
    assert.deepEqual(paginateHistoryRows(mockups, 3), {
      page: 2,
      pageCount: 2,
      rows: mockups.slice(10),
    });
  });
});
