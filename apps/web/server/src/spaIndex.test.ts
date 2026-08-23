import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spaIndexAction } from "./spaIndex.js";

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
