import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hrefOf, isSpaPath, parsePath } from "./appRoute.js";

describe("parsePath", () => {
  it("maps desks and ids", () => {
    assert.deepEqual(parsePath("/"), { view: "tasks" });
    assert.deepEqual(parsePath("/new"), { view: "new" });
    assert.deepEqual(parsePath("/history/"), { view: "history" });
    assert.deepEqual(parsePath("/settings"), { view: "settings" });
    assert.deepEqual(parsePath("/mockup"), { view: "mockup", mockupId: null });
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
});

describe("hrefOf", () => {
  it("writes path without query", () => {
    assert.equal(hrefOf({ view: "tasks" }), "/");
    assert.equal(hrefOf({ view: "new" }), "/new");
    assert.equal(hrefOf({ view: "history" }), "/history");
    assert.equal(hrefOf({ view: "settings" }), "/settings");
    assert.equal(hrefOf({ view: "review" }), "/review");
    assert.equal(hrefOf({ view: "review", taskId: "aabbccddeeff" }), "/review/aabbccddeeff");
    assert.equal(hrefOf({ view: "mockup", mockupId: null }), "/mockup");
    assert.equal(hrefOf({ view: "mockup", mockupId: "aabbccddeeff" }), "/mockup/aabbccddeeff");
  });
});

describe("isSpaPath", () => {
  it("allows desks and rejects api", () => {
    assert.equal(isSpaPath("/"), true);
    assert.equal(isSpaPath("/new"), true);
    assert.equal(isSpaPath("/review"), true);
    assert.equal(isSpaPath("/review/aabbccddeeff"), true);
    assert.equal(isSpaPath("/review/not-an-id"), false);
    assert.equal(isSpaPath("/api/health"), false);
    assert.equal(isSpaPath("/brand/logo-mark.png"), false);
  });
});
