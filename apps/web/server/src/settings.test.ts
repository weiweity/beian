import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-set-"));

const { saveSettings, getSetting, publicView, runProbe } = await import("./settings.js");

describe("settings mask", () => {
  it("secret never echoed", () => {
    saveSettings({ FEISHU_APP_SECRET: "super-secret-value-9999" });
    assert.equal(getSetting("FEISHU_APP_SECRET"), "super-secret-value-9999");
    const view = publicView();
    const field = view.groups.flatMap((g) => g.fields).find((f) => f.key === "FEISHU_APP_SECRET");
    assert.ok(field);
    assert.equal(field.value, "");
    assert.equal(field.set, true);
    assert.match(field.last4, /9999|已填/);
    const dumped = JSON.stringify(view);
    assert.equal(dumped.includes("super-secret-value-9999"), false);
  });

  it("empty secret keeps previous", () => {
    saveSettings({ BAIDU_OCR_API_KEY: "keep-me-aaaa" });
    saveSettings({ BAIDU_OCR_API_KEY: "" });
    assert.equal(getSetting("BAIDU_OCR_API_KEY"), "keep-me-aaaa");
  });

  it("unknown keys are ignored", () => {
    saveSettings({ NOT_A_REAL_KEY: "nope" });
    assert.equal(getSetting("NOT_A_REAL_KEY"), "");
  });

  it("writes baidu aliases into process env for python workers", () => {
    saveSettings({ BAIDU_OCR_API_KEY: "alias-key-zzzz", BAIDU_OCR_SECRET_KEY: "alias-sec-yyyy" });
    assert.equal(process.env.BAIDU_API_KEY, "alias-key-zzzz");
    assert.equal(process.env.BAIDU_SECRET_KEY, "alias-sec-yyyy");
  });

  it("unknown probe id fails closed", async () => {
    const r = await runProbe("not-a-probe");
    assert.equal(r.ok, false);
    assert.match(r.message, /未知/);
  });
});
