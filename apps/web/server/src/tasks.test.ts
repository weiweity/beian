import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-ts-"));

const { activeHits, hasReworkPages, isHitDecision, isReviewableStatus, isReworkableStatus, isReworkableTask, listTasks, saveTask } = await import("./tasks.js");

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
