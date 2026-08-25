import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-ts-"));

const { activeHits, boardColumn, deleteTask, hasReworkPages, isHitDecision, isReviewableStatus, isReworkableStatus, isReworkableTask, listTasks, loadTask, saveTask } = await import("./tasks.js");

const admin = { id: "ou_admin", name: "管理员", admin: true };

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
    const rows = listTasks("", admin);
    assert.equal(rows[0]?.product_name, "某某精华");
    assert.equal(rows[1]?.product_name, "另一支霜");
  });

  it("按品名搜", () => {
    const rows = listTasks("精华", admin);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "aaaaaaaaaaaa");
  });

  it("搜不到为空", () => {
    assert.deepEqual(listTasks("没有这个品", admin), []);
  });

  it("对照失败不进对照中列", () => {
    assert.equal(boardColumn("compare_failed"), "failed");
    assert.equal(boardColumn("comparing", "failed"), "failed");
    assert.equal(boardColumn("comparing", "running"), "comparing");
  });

  it("deleteTask removes the json", () => {
    saveTask({
      id: "cccccccccccc",
      title: "删我",
      product_name: "删我",
      type: "excel_pdf",
      status: "compare_failed",
      created_at: "2026-08-19T08:00:00Z",
    });
    deleteTask("cccccccccccc");
    assert.throws(() => loadTask("cccccccccccc"), /任务不存在/);
  });

  it("reviewer only sees own owner rows", () => {
    saveTask({
      id: "eeeeeeeeeeee",
      title: "爱丽丝",
      product_name: "爱丽丝",
      type: "excel_pdf",
      status: "pending_review",
      created_at: "2026-08-19T11:00:00Z",
      owner: "ou_alice",
      created_by: "同名",
    });
    const alice = { id: "ou_alice", name: "同名", admin: false };
    const bob = { id: "ou_bob", name: "同名", admin: false };
    assert.equal(listTasks("", alice).some((r) => r.id === "eeeeeeeeeeee"), true);
    assert.equal(listTasks("", bob).some((r) => r.id === "eeeeeeeeeeee"), false);
    assert.equal(listTasks("", alice).some((r) => r.id === "aaaaaaaaaaaa"), false);
  });

  it("deleteTask refuses a running compare", () => {
    saveTask({
      id: "dddddddddddd",
      title: "跑着",
      product_name: "跑着",
      type: "excel_pdf",
      status: "comparing",
      job_status: "running",
      created_at: "2026-08-19T08:01:00Z",
    });
    assert.throws(() => deleteTask("dddddddddddd"), /还在跑/);
    assert.equal(loadTask("dddddddddddd").id, "dddddddddddd");
  });
});

describe("review gates", () => {
  it("only pending_review and in_review are reviewable", () => {
    assert.equal(isReviewableStatus("pending_review"), true);
    assert.equal(isReviewableStatus("in_review"), true);
    assert.equal(isReviewableStatus("compare_failed"), false);
    assert.equal(isReviewableStatus("comparing"), false);
    assert.equal(isReviewableStatus("completed"), false);
  });

  it("only confirm issue ignore are hit decisions", () => {
    assert.equal(isHitDecision("confirm"), true);
    assert.equal(isHitDecision("issue"), true);
    assert.equal(isHitDecision("ignore"), true);
    assert.equal(isHitDecision("pending"), false);
    assert.equal(isHitDecision("ai_pass"), false);
    assert.equal(isHitDecision(""), false);
  });

  it("lets signed tasks rework but not failed or comparing ones", () => {
    assert.equal(isReworkableStatus("pending_review"), true);
    assert.equal(isReworkableStatus("in_review"), true);
    assert.equal(isReworkableStatus("completed"), true);
    assert.equal(isReworkableStatus("compare_failed"), false);
    assert.equal(isReworkableStatus("comparing"), false);
    assert.equal(hasReworkPages({}), false);
    assert.equal(hasReworkPages({ pages_v2: [] }), false);
    assert.equal(hasReworkPages({ pages_v2: [{ url: "/x.png" }] }), true);
    assert.equal(isReworkableTask({ status: "pending_review" }), true);
    assert.equal(isReworkableTask({ status: "in_review" }), true);
    assert.equal(isReworkableTask({ status: "completed", complete_kind: "rework" }), true);
    assert.equal(isReworkableTask({ status: "completed", complete_kind: "signed" }), false);
    assert.equal(
      isReworkableTask({ status: "completed", complete_kind: "rework", pages_v2: [{ url: "/x.png" }] }),
      false,
    );
    assert.equal(
      activeHits({
        id: "aaaaaaaaaaaa",
        title: "x",
        type: "excel_pdf",
        status: "in_review",
        hits: [{ id: "h1" }],
        hits_v2: [{ id: "v2_h1" }],
      })[0]?.id,
      "v2_h1",
    );
    assert.equal(
      activeHits({
        id: "aaaaaaaaaaaa",
        title: "x",
        type: "excel_pdf",
        status: "in_review",
        hits: [{ id: "h1" }],
        hits_v2: [],
      })[0]?.id,
      "h1",
    );
  });
});
