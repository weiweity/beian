import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hrefOf, isSpaPath, parsePath } from "./appRoute.js";

describe("parsePath", () => {
  it("maps desks and ids", () => {
    assert.deepEqual(parsePath("/"), { view: "tasks" });
    assert.deepEqual(parsePath("/reviewup"), { view: "tasks" });
    assert.deepEqual(parsePath("/reviewup/new"), { view: "new" });
    assert.deepEqual(parsePath("/new"), { view: "new" });
    assert.deepEqual(parsePath("/history/"), { view: "history" });
    assert.deepEqual(parsePath("/settings"), { view: "settings" });
    assert.deepEqual(parsePath("/mockup"), { view: "mockup", mockupId: null });
    assert.deepEqual(parsePath("/mockup/new"), { view: "mockupNew" });
    assert.deepEqual(parsePath("/review/aabbccddeeff"), { view: "review", taskId: "aabbccddeeff" });
    assert.deepEqual(parsePath("/mockup/AABBCCDDEEFF"), { view: "mockup", mockupId: "aabbccddeeff" });
    assert.deepEqual(parsePath("/", "?task=aabbccddeeff"), { view: "review", taskId: "aabbccddeeff" });
    assert.deepEqual(parsePath("/", "?mockup=aabbccddeeff"), { view: "mockup", mockupId: "aabbccddeeff" });
    assert.deepEqual(parsePath("/review"), { view: "tasks" });
    assert.deepEqual(parsePath("/review/not-an-id"), { view: "tasks" });
    assert.deepEqual(parsePath("/foo"), { view: "tasks" });
    assert.deepEqual(parsePath("/", "?tab=settings"), { view: "settings" });
    assert.deepEqual(parsePath("/", "", "#settings"), { view: "settings" });
  });

  it("只在新建页读取合法上传回执", () => {
    assert.deepEqual(parsePath("/reviewup/new", "?receipt=AABBCCDDEEFF"), {
      view: "new",
      receipt: "aabbccddeeff",
    });
    assert.deepEqual(parsePath("/mockup/new", "?receipt=112233445566"), {
      view: "mockupNew",
      receipt: "112233445566",
    });
    assert.deepEqual(parsePath("/reviewup/new", "?receipt=bad"), { view: "new" });
    assert.deepEqual(parsePath("/reviewup", "?receipt=aabbccddeeff"), { view: "tasks" });
  });
});

describe("hrefOf", () => {
  it("writes path without query", () => {
    assert.equal(hrefOf({ view: "tasks" }), "/reviewup");
    assert.equal(hrefOf({ view: "new" }), "/reviewup/new");
    assert.equal(hrefOf({ view: "history" }), "/history");
    assert.equal(hrefOf({ view: "settings" }), "/settings");
    assert.equal(hrefOf({ view: "review" }), "/reviewup");
    assert.equal(hrefOf({ view: "review", taskId: "aabbccddeeff" }), "/review/aabbccddeeff");
    assert.equal(hrefOf({ view: "mockupNew" }), "/mockup/new");
    assert.equal(hrefOf({ view: "mockup", mockupId: null }), "/mockup");
    assert.equal(hrefOf({ view: "mockup", mockupId: "aabbccddeeff" }), "/mockup/aabbccddeeff");
  });

  it("把合法回执保留到对应新建页", () => {
    assert.equal(hrefOf({ view: "new", receipt: "AABBCCDDEEFF" }), "/reviewup/new?receipt=aabbccddeeff");
    assert.equal(hrefOf({ view: "mockupNew", receipt: "112233445566" }), "/mockup/new?receipt=112233445566");
    assert.equal(hrefOf({ view: "new", receipt: "bad" }), "/reviewup/new");
  });
});

describe("isSpaPath", () => {
  it("allows desks and rejects api", () => {
    assert.equal(isSpaPath("/"), true);
    assert.equal(isSpaPath("/reviewup"), true);
    assert.equal(isSpaPath("/reviewup/new"), true);
    assert.equal(isSpaPath("/new"), true);
    assert.equal(isSpaPath("/mockup/new"), true);
    assert.equal(isSpaPath("/review"), true);
    assert.equal(isSpaPath("/review/aabbccddeeff"), true);
    assert.equal(isSpaPath("/reviewup/not-an-id"), false);
    assert.equal(isSpaPath("/review/not-an-id"), false);
    assert.equal(isSpaPath("/api/health"), false);
    assert.equal(isSpaPath("/brand/logo-mark.png"), false);
  });
});
