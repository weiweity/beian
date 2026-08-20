import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { feishuReadyFromHealth, shouldShowWaitCard, waitCardCopy } from "./waitCard.js";

describe("shouldShowWaitCard", () => {
  it("hides when there is no task", () => {
    assert.equal(shouldShowWaitCard(null), false);
    assert.equal(shouldShowWaitCard({}), false);
  });

  it("shows while job_status is queued or running", () => {
    assert.equal(shouldShowWaitCard({ status: "pending_review", job_status: "queued" }), true);
    assert.equal(shouldShowWaitCard({ status: "in_review", job_status: "running" }), true);
  });

  it("shows while status is comparing even without job_status", () => {
    assert.equal(shouldShowWaitCard({ status: "comparing" }), true);
    assert.equal(shouldShowWaitCard({ status: "comparing", job_status: "failed" }), true);
  });

  it("hides after the job is done or failed back to review", () => {
    assert.equal(shouldShowWaitCard({ status: "pending_review" }), false);
    assert.equal(shouldShowWaitCard({ status: "in_review", job_status: "succeeded" }), false);
    assert.equal(shouldShowWaitCard({ status: "in_review", job_status: "failed" }), false);
    assert.equal(shouldShowWaitCard({ status: "compare_failed", job_status: "failed" }), false);
  });

  it("does not treat mockup status queued as comparing", () => {
    assert.equal(shouldShowWaitCard({ status: "queued" }), false);
    assert.equal(shouldShowWaitCard({ status: "queued", job_status: "queued" }), true);
    assert.equal(shouldShowWaitCard({ status: "running", job_status: "running" }), true);
  });
});

describe("waitCardCopy", () => {
  it("queued compare shows queue_ahead, never a 40s eta", () => {
    const copy = waitCardCopy({ kind: "compare", job_status: "queued", queue_ahead: 2 });
    assert.equal(copy.title, "对照中");
    assert.equal(copy.eta, "前面还有 2 单");
    assert.match(copy.hint, /前面还有 2 单/);
    assert.doesNotMatch(copy.eta, /大约还要/);
    assert.doesNotMatch(copy.hint, /%/);
  });

  it("queued with 0 ahead says 就快轮到", () => {
    const copy = waitCardCopy({ kind: "compare", job_status: "queued", queue_ahead: 0 });
    assert.equal(copy.eta, "就快轮到");
    assert.match(copy.hint, /就快轮到/);
  });

  it("rework title is 对红中", () => {
    const copy = waitCardCopy({ kind: "rework", job_status: "running" });
    assert.equal(copy.title, "对红中");
    assert.equal(copy.eta, "大约还要 40 秒");
  });

  it("running uses stage label and job_eta_s", () => {
    const copy = waitCardCopy({
      kind: "compare",
      job_status: "running",
      job_stage_label: "认字",
      job_eta_s: 40,
    });
    assert.equal(copy.eta, "大约还要 40 秒");
    assert.match(copy.hint, /认字/);
  });

  it("mockup running defaults eta to 240 seconds", () => {
    const copy = waitCardCopy({ kind: "mockup", job_status: "running" });
    assert.equal(copy.title, "打样中");
    assert.equal(copy.eta, "大约还要 240 秒");
  });

  it("mockup running uses job_eta_s when present", () => {
    const copy = waitCardCopy({ kind: "mockup", job_status: "running", job_eta_s: 120 });
    assert.equal(copy.eta, "大约还要 120 秒");
  });

  it("feishuReady true tells her she can leave", () => {
    const copy = waitCardCopy({ kind: "compare", job_status: "running", feishuReady: true });
    assert.match(copy.hint, /可以离开，完了飞书叫你/);
  });

  it("feishuReady false points compare back to the board and mockup to this page", () => {
    const compare = waitCardCopy({ kind: "compare", job_status: "running", feishuReady: false });
    const rework = waitCardCopy({ kind: "rework", job_status: "queued", queue_ahead: 1, feishuReady: false });
    const mockup = waitCardCopy({ kind: "mockup", job_status: "running", feishuReady: false });
    assert.match(compare.hint, /对照完回看板/);
    assert.match(rework.hint, /对照完回看板/);
    assert.match(mockup.hint, /打样完回本页/);
    assert.doesNotMatch(compare.hint, /可以离开/);
  });

  it("never invents a percentage", () => {
    const copies = [
      waitCardCopy({ kind: "compare", job_status: "queued", queue_ahead: 3, feishuReady: true }),
      waitCardCopy({ kind: "rework", job_status: "running", job_stage_label: "对照" }),
      waitCardCopy({ kind: "mockup", job_status: "running" }),
    ];
    for (const copy of copies) {
      assert.doesNotMatch(`${copy.title}${copy.eta}${copy.hint}`, /%/);
    }
  });
});

describe("feishuReadyFromHealth", () => {
  it("is true only when feishu_notify is true", () => {
    assert.equal(feishuReadyFromHealth({ feishu_notify: true }), true);
    assert.equal(feishuReadyFromHealth({ feishu_notify: false }), false);
    assert.equal(feishuReadyFromHealth({}), false);
    assert.equal(feishuReadyFromHealth(null), false);
  });
});
