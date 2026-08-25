import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSpaPath, legacyDeskRedirect, spaIndexAction } from "./spaIndex.js";

describe("isSpaPath", () => {
  it("allows desks and ids, rejects api and static", () => {
    assert.equal(isSpaPath("/"), true);
    assert.equal(isSpaPath("/reviewup"), true);
    assert.equal(isSpaPath("/reviewup/new"), true);
    assert.equal(isSpaPath("/new"), true);
    assert.equal(isSpaPath("/history/"), true);
    assert.equal(isSpaPath("/settings"), true);
    assert.equal(isSpaPath("/review"), true);
    assert.equal(isSpaPath("/review/aabbccddeeff"), true);
    assert.equal(isSpaPath("/mockup"), true);
    assert.equal(isSpaPath("/mockup/new"), true);
    assert.equal(isSpaPath("/mockup/AABBCCDDEEFF"), true);
    assert.equal(isSpaPath("/api/health"), false);
    assert.equal(isSpaPath("/brand/logo-mark.png"), false);
    assert.equal(isSpaPath("/review/not-an-id"), false);
    assert.equal(isSpaPath("/reviewup/not-an-id"), false);
  });
});

describe("legacyDeskRedirect", () => {
  it("sends old review desk bookmarks to /reviewup", () => {
    assert.equal(legacyDeskRedirect("/"), "/reviewup");
    assert.equal(legacyDeskRedirect("/new"), "/reviewup/new");
    assert.equal(legacyDeskRedirect("/review"), "/reviewup");
    assert.equal(legacyDeskRedirect("/reviewup"), null);
    assert.equal(legacyDeskRedirect("/review/aabbccddeeff"), null);
    assert.equal(legacyDeskRedirect("/mockup"), null);
  });
});

describe("spaIndexAction", () => {
  it("keeps the Feishu error page on GET /", () => {
    assert.equal(
      spaIndexAction({ feishuError: "denied", hasSession: false, displayLogin: false, oauthReady: true }),
      "html",
    );
  });

  it("serves the app when the session cookie is valid", () => {
    assert.equal(
      spaIndexAction({ feishuError: "", hasSession: true, displayLogin: false, oauthReady: true }),
      "html",
    );
  });

  it("keeps display login on loopback", () => {
    assert.equal(
      spaIndexAction({ feishuError: "", hasSession: false, displayLogin: true, oauthReady: true }),
      "html",
    );
  });

  it("sends public anonymous visitors to Feishu before the SPA", () => {
    assert.equal(
      spaIndexAction({ feishuError: "", hasSession: false, displayLogin: false, oauthReady: true }),
      "feishu",
    );
  });

  it("does not loop when Feishu is not configured", () => {
    assert.equal(
      spaIndexAction({ feishuError: "", hasSession: false, displayLogin: false, oauthReady: false }),
      "html",
    );
  });
});
