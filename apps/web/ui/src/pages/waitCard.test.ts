import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareBoardProgress,
  detailLoadState,
  feishuReadyFromHealth,
  liveJobLine,
  liveNavPulse,
  mockupBoardProgress,
  pickLiveMockup,
  shouldShowWaitCard,
  waitCardActiveSteps,
  waitCardCopy,
  waitLoaderLetters,
} from "./waitCard.js";

describe("compareBoardProgress", () => {
  it("maps queue and compare stages to a compact board percentage", () => {
    assert.equal(compareBoardProgress({ status: "comparing", job_status: "queued" }), 0);
    assert.equal(compareBoardProgress({ status: "comparing", job_status: "running", job_stage: "render_pdf" }), 20);
    assert.equal(compareBoardProgress({ status: "comparing", job_status: "running", job_stage: "ingest" }), 35);
    assert.equal(compareBoardProgress({ status: "comparing", job_status: "running", job_stage_label: "认字" }), 55);
    assert.equal(compareBoardProgress({ status: "comparing", job_status: "running", job_stage: "layout" }), 70);
    assert.equal(compareBoardProgress({ status: "comparing", job_status: "running", job_stage: "match" }), 85);
    assert.equal(compareBoardProgress({ status: "comparing", job_status: "succeeded" }), 100);
  });

  it("keeps the new ingest and layout stages monotonic", () => {
    const stages = ["render_pdf", "ingest", "ocr", "layout", "match"];
    const values = stages.map((job_stage) =>
      compareBoardProgress({ status: "comparing", job_status: "running", job_stage }),
    );
    assert.deepEqual(values, [20, 35, 55, 70, 85]);
    assert.deepEqual(
      stages.map((stage) => waitCardActiveSteps("compare", "running", stage)),
      [1, 1, 2, 2, 3],
    );
  });

  it("does not invent a percentage for failed or non-running records", () => {
    assert.equal(compareBoardProgress({ status: "compare_failed", job_status: "failed" }), undefined);
    assert.equal(compareBoardProgress({ status: "comparing", job_status: "running" }), undefined);
    assert.equal(compareBoardProgress({ status: "pending_review" }), undefined);
    assert.equal(compareBoardProgress({ status: "pending_review", job_status: "succeeded" }), undefined);
    assert.equal(compareBoardProgress({ status: "completed" }), undefined);
  });
});

describe("mockupBoardProgress", () => {
  it("maps only real packaging stages to the shared compact percentage", () => {
    assert.equal(mockupBoardProgress({ status: "queued", job_status: "queued" }), 0);
    assert.equal(mockupBoardProgress({ status: "running", job_status: "running", job_stage: "illustrator" }), 15);
    assert.equal(mockupBoardProgress({ status: "running", job_status: "running", job_stage: "render_pdf" }), 35);
    assert.equal(mockupBoardProgress({ status: "running", job_status: "running", job_stage_label: "打样" }), 70);
    assert.equal(mockupBoardProgress({ status: "running", job_status: "running", job_stage: "export" }), 90);
  });

  it("does not invent progress for finished, failed, or unknown stages", () => {
    assert.equal(mockupBoardProgress({ status: "done", job_status: "succeeded" }), undefined);
    assert.equal(mockupBoardProgress({ status: "failed", job_status: "failed" }), undefined);
    assert.equal(mockupBoardProgress({ status: "running", job_status: "running" }), undefined);
  });
});

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
  });

  it("does not wait when comparing was already interrupted", () => {
    assert.equal(shouldShowWaitCard({ status: "comparing", job_status: "failed" }), false);
    assert.equal(shouldShowWaitCard({ status: "compare_failed" }), false);
    assert.equal(shouldShowWaitCard({ status: "completed", job_status: "running" }), false);
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

describe("detailLoadState", () => {
  it("shows a revalidation error instead of a stale queued handoff", () => {
    assert.equal(detailLoadState({ status: "queued", job_status: "queued" }, "没有权限"), "error");
  });

  it("keeps loading, waiting and ready states distinct", () => {
    assert.equal(detailLoadState(null, null), "loading");
    assert.equal(detailLoadState({ status: "queued", job_status: "queued" }, null), "waiting");
    assert.equal(detailLoadState({ status: "pending_review", job_status: "succeeded" }, null), "ready");
  });
});

describe("waitLoaderLetters", () => {
  it("splits job title into per-character spans", () => {
    assert.deepEqual(waitLoaderLetters("compare"), ["对", "照", "中"]);
    assert.deepEqual(waitLoaderLetters("rework"), ["对", "红", "中"]);
    assert.deepEqual(waitLoaderLetters("mockup"), ["打", "样", "中"]);
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

  it("mockup running defaults eta to 4 minutes", () => {
    const copy = waitCardCopy({ kind: "mockup", job_status: "running" });
    assert.equal(copy.title, "打样中");
    assert.equal(copy.eta, "大约还要 4 分钟");
  });

  it("mockup running uses job_eta_s when present", () => {
    const copy = waitCardCopy({ kind: "mockup", job_status: "running", job_eta_s: 120 });
    assert.equal(copy.eta, "大约还要 2 分钟");
  });

  it("feishuReady true tells her she can leave", () => {
    const copy = waitCardCopy({ kind: "compare", job_status: "running", feishuReady: true });
    assert.match(copy.hint, /可以离开，完了飞书叫你/);
  });

  it("running uses Figma wait-card body, not a fake cancel", () => {
    const compare = waitCardCopy({ kind: "compare", job_status: "running", feishuReady: false });
    const rework = waitCardCopy({ kind: "rework", job_status: "queued", queue_ahead: 1, feishuReady: false });
    const mockup = waitCardCopy({ kind: "mockup", job_status: "running", feishuReady: false });
    assert.match(compare.hint, /机审只标疑点/);
    assert.match(rework.hint, /对照完回看板/);
    assert.match(mockup.hint, /本机 Blender/);
    assert.doesNotMatch(compare.hint, /可以离开/);
    assert.doesNotMatch(`${compare.hint}${mockup.hint}`, /取消/);
  });

  it("writes minutes once eta is 60 seconds or more", () => {
    assert.equal(
      waitCardCopy({ kind: "compare", job_status: "running", job_eta_s: 59 }).eta,
      "大约还要 59 秒",
    );
    assert.equal(
      waitCardCopy({ kind: "compare", job_status: "running", job_eta_s: 60 }).eta,
      "大约还要 1 分钟",
    );
    assert.equal(
      waitCardCopy({ kind: "mockup", job_status: "running", job_eta_s: 240 }).eta,
      "大约还要 4 分钟",
    );
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

describe("liveJobLine", () => {
  it("queued never writes a fake 40s eta", () => {
    assert.equal(liveJobLine({ job_status: "queued", queue_ahead: 2 }), "前面还有 2 单");
    assert.equal(liveJobLine({ job_status: "queued", queue_ahead: 0 }), "就快轮到");
    assert.equal(liveJobLine({ job_status: "succeeded", job_stage_label: "认字" }), null);
  });

  it("running joins stage and eta, never a percent", () => {
    const line = liveJobLine({
      job_status: "running",
      job_stage_label: "认字",
      job_eta_s: 40,
    });
    assert.equal(line, "认字 · 大约还要 40 秒");
    assert.doesNotMatch(line || "", /%/);
    assert.equal(liveJobLine({ job_status: "running", kind: "mockup" }), "大约还要 4 分钟");
  });
});

describe("waitCardActiveSteps", () => {
  it("walks compare and mockup stages", () => {
    assert.equal(waitCardActiveSteps("compare", "queued"), 0);
    assert.equal(waitCardActiveSteps("compare", "running", "ocr"), 2);
    assert.equal(waitCardActiveSteps("compare", "running", undefined, "对照"), 3);
    assert.equal(waitCardActiveSteps("compare", "running", "render_pdf"), 1);
    assert.equal(waitCardActiveSteps("mockup", "running", "render_pdf"), 1);
    assert.equal(waitCardActiveSteps("mockup", "running", "blender"), 3);
    assert.equal(waitCardActiveSteps("mockup", "running", undefined, "打样"), 3);
    assert.equal(waitCardActiveSteps("mockup", "running", "export"), 4);
  });
});

describe("pickLiveMockup", () => {
  it("picks the newest running or queued job", () => {
    assert.equal(pickLiveMockup([]), null);
    const live = pickLiveMockup([
      { status: "done", created_at: "2026-08-24T12:00:00.000Z" },
      { status: "running", created_at: "2026-08-24T11:00:00.000Z" },
      { status: "queued", created_at: "2026-08-24T12:30:00.000Z" },
    ]);
    assert.equal(live?.created_at, "2026-08-24T12:30:00.000Z");
  });

  it("does not treat a finished job with a stale running slot as live", () => {
    assert.equal(
      pickLiveMockup([{ status: "done", job_status: "running", created_at: "2026-08-24T13:00:00.000Z" }]),
      null,
    );
    assert.equal(pickLiveMockup([{ status: "failed", job_status: "queued" }]), null);
  });
});

describe("liveNavPulse", () => {
  it("lights 审稿台 / 打样台 from health.jobs counts", () => {
    assert.deepEqual(liveNavPulse(null), { review: false, mockup: false });
    assert.deepEqual(
      liveNavPulse({ jobs: { ocr: { running: 1, queued: 0 }, blender: { running: 0, queued: 0 } } }),
      { review: true, mockup: false },
    );
    assert.deepEqual(
      liveNavPulse({ jobs: { illustrator: { running: 0, queued: 1 } } }),
      { review: false, mockup: true },
    );
    assert.deepEqual(
      liveNavPulse({ jobs: { blender: { running: 1, queued: 0 }, ocr: { running: 0, queued: 1 } } }),
      { review: true, mockup: true },
    );
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
