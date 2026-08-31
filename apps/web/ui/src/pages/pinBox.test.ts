import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boxTooLarge,
  hitOnPage,
  overlayFromBox,
  overlaysForHit,
  pinHitGroupsForPage,
  pickHitBox,
  resolvePageMetrics,
  visiblePinGroups,
  locateBoxesForHit,
  locationPageForHit,
} from "./pinBox.js";

describe("pinHitGroupsForPage", () => {
  it("keeps two review fields but renders one shared bilingual pin", () => {
    const rows = pinHitGroupsForPage(
      [
        { page: 1, bilingual_pair_id: "pair-a", field: "中文品名" },
        { page: 1, bilingual_pair_id: "pair-a", field: "英文品名" },
        { page: 1, field: "净含量" },
        { page: 2, field: "条码" },
      ],
      1,
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].indices, [0, 1]);
    assert.deepEqual(rows[1].indices, [2]);
  });
});

describe("visiblePinGroups", () => {
  it("keeps only the active bilingual group", () => {
    const rows = pinHitGroupsForPage(
      [
        { page: 1, bilingual_pair_id: "pair-a", field: "中文品名" },
        { page: 1, bilingual_pair_id: "pair-a", field: "英文品名" },
        { page: 1, field: "净含量" },
      ],
      1,
    );
    assert.equal(visiblePinGroups(rows, 1).length, 1);
    assert.deepEqual(visiblePinGroups(rows, 1)[0]?.indices, [0, 1]);
    assert.deepEqual(visiblePinGroups(rows, 2)[0]?.indices, [2]);
    assert.deepEqual(visiblePinGroups(rows, -1), []);
  });
});

describe("resolvePageMetrics", () => {
  it("uses page width/height when they are real", () => {
    const m = resolvePageMetrics({ width: 2000, height: 2800 }, { width: 10, height: 10 });
    assert.deepEqual(m, { width: 2000, height: 2800 });
  });

  it("falls back to the image natural size when page meta is missing or 1", () => {
    assert.equal(resolvePageMetrics({ width: 1, height: 1 }, null), null);
    assert.deepEqual(resolvePageMetrics({ width: 1, height: 1 }, { width: 1600, height: 2200 }), {
      width: 1600,
      height: 2200,
    });
    assert.equal(resolvePageMetrics(null, { width: 0, height: 100 }), null);
  });
});

describe("hitOnPage", () => {
  it("does not scatter a hit with no page onto every canvas", () => {
    assert.equal(hitOnPage({}, 1), false);
    assert.equal(hitOnPage({ page: 0 }, 1), false);
    assert.equal(hitOnPage({ page: 2 }, 1), false);
    assert.equal(hitOnPage({ page: 2 }, 2), true);
    assert.equal(hitOnPage({ page: "2" }, 2), true);
    assert.equal(hitOnPage({ page: "x" }, 1), false);
  });

  it("uses a QR box page when guide text has no box", () => {
    const hit = { page: 1, bboxes: [], qrcode_boxes: [{ page: 2, left: 10, top: 20, width: 30, height: 30 }] };
    assert.equal(locationPageForHit(hit), 2);
    assert.equal(hitOnPage(hit, 1), false);
    assert.equal(hitOnPage(hit, 2), true);
  });
});

describe("pickHitBox", () => {
  it("prefers check, then miss_anchor, on the current page", () => {
    const box = pickHitBox(
      [
        { role: "hit", left: 10, top: 10, width: 20, height: 20, page: 1 },
        { role: "miss_anchor", left: 80, top: 90, width: 30, height: 12, page: 1 },
        { role: "check", left: 400, top: 800, width: 120, height: 40, page: 1 },
        { role: "miss_anchor", left: 1, top: 1, width: 8, height: 8, page: 2 },
      ],
      1,
    );
    assert.equal(box?.role, "check");
    assert.equal(box?.left, 400);
    const miss = pickHitBox(
      [
        { role: "hit", left: 10, top: 10, width: 20, height: 20, page: 1 },
        { role: "miss_anchor", left: 80, top: 90, width: 30, height: 12, page: 1 },
      ],
      1,
    );
    assert.equal(miss?.role, "miss_anchor");
  });

  it("accepts x/y aliases", () => {
    const box = pickHitBox([{ x: 50, y: 80, width: 10, height: 12 }], 1);
    assert.deepEqual(box, { left: 50, top: 80, width: 10, height: 12, role: "", page: 0 });
  });

  it("returns null when there is no box", () => {
    assert.equal(pickHitBox([], 1), null);
    assert.equal(pickHitBox([{ left: 0, top: 0, width: 0, height: 0 }], 1), null);
  });

  it("skips a page-sized box and keeps the smaller locate box", () => {
    const page = { width: 1000, height: 1000 };
    const box = pickHitBox(
      [
        { role: "check", left: 0, top: 0, width: 900, height: 900, page: 1 },
        { role: "hit", left: 800, top: 300, width: 80, height: 80, page: 1 },
      ],
      1,
      page,
    );
    assert.equal(box?.role, "hit");
    assert.equal(box?.left, 800);
  });
});

describe("overlayFromBox", () => {
  it("places the rectangle and pin in percent of the page", () => {
    const ov = overlayFromBox(
      { left: 200, top: 100, width: 100, height: 50, role: "check", page: 1 },
      { width: 1000, height: 500 },
    );
    assert.ok(ov);
    assert.equal(ov.left, "20%");
    assert.equal(ov.top, "20%");
    assert.equal(ov.width, "10%");
    assert.equal(ov.height, "10%");
    assert.equal(ov.pinLeft, "25%");
    assert.equal(ov.pinTop, "25%");
    assert.equal(ov.kind, "warn");
  });

  it("does not invent a position when the page size is dummy 1", () => {
    assert.equal(
      overlayFromBox({ left: 12, top: 12, width: 40, height: 20, role: "hit", page: 1 }, { width: 1, height: 1 }),
      null,
    );
  });
});

describe("overlaysForHit", () => {
  it("keeps every box on this page and drops the other page", () => {
    const ovs = overlaysForHit(
      [
        { role: "hit", left: 0, top: 0, width: 100, height: 50, page: 1 },
        { role: "check", left: 50, top: 50, width: 10, height: 10, page: 2 },
      ],
      1,
      { width: 200, height: 100 },
    );
    assert.equal(ovs.length, 1);
    assert.equal(ovs[0]?.kind, "hit");
    assert.equal(ovs[0]?.left, "0%");
  });

  it("draws nothing without page metrics", () => {
    assert.deepEqual(overlaysForHit([{ left: 1, top: 1, width: 2, height: 2 }], 1, null), []);
  });

  it("drops a box that covers most of the page", () => {
    const page = { width: 1000, height: 1000 };
    assert.equal(
      overlaysForHit([{ left: 0, top: 0, width: 900, height: 900, page: 1 }], 1, page).length,
      0,
    );
    assert.equal(boxTooLarge({ left: 0, top: 0, width: 900, height: 900, role: "hit", page: 1 }, page), true);
  });

  it("filters exactly 30 percent but retains a box just below the boundary", () => {
    const page = { width: 1000, height: 1000 };
    assert.equal(boxTooLarge({ left: 0, top: 0, width: 300, height: 1000, role: "hit", page: 1 }, page), true);
    assert.equal(boxTooLarge({ left: 0, top: 0, width: 299, height: 1000, role: "hit", page: 1 }, page), false);
  });
});

describe("locateBoxesForHit", () => {
  it("keeps guide boxes and adds QR graphic boxes", () => {
    const boxes = locateBoxesForHit({
      bboxes: [{ left: 12, top: 14, width: 100, height: 24, role: "check" }],
      qrcode_boxes: [{ left: 800, top: 300, width: 180, height: 180 }],
    });
    assert.equal(boxes.length, 2);
    assert.equal(boxes[1]?.role, "hit");
    assert.equal(boxes[1]?.left, 800);
  });

  it("ignores malformed persisted box collections instead of crashing the page", () => {
    assert.deepEqual(locateBoxesForHit({ bboxes: "broken", qrcode_boxes: { left: 1 } }), []);
  });
});
