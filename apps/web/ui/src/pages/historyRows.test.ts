import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { historyHasLive, historyMockRow, historyTaskRow } from "./historyRows.js";

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
});
