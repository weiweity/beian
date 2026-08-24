import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-notify-"));
process.env.VITEST = "1";

const { saveSettings } = await import("./settings.js");
const { jobOpenPath, sendText } = await import("./notify.js");

describe("jobOpenPath", () => {
  it("opens review and mockup desks by path", () => {
    assert.equal(jobOpenPath("compare", "aabbccddeeff"), "/review/aabbccddeeff");
    assert.equal(jobOpenPath("rework", "aabbccddeeff"), "/review/aabbccddeeff");
    assert.equal(jobOpenPath("mockup", "aabbccddeeff"), "/mockup/aabbccddeeff");
  });
});

describe("sendText", () => {
  it("skips when push is off unless forced", async () => {
    saveSettings({ FEISHU_ENABLED: "false", FEISHU_OPEN_ID: "ou_test" });
    const skipped = await sendText("hi", "ou_test");
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, true);
  });

  it("force still needs an open_id", async () => {
    saveSettings({ FEISHU_ENABLED: "false", FEISHU_OPEN_ID: "" });
    const r = await sendText("hi", "", { force: true });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
  });

  it("force without lark-cli or app credentials fails closed", async () => {
    saveSettings({
      FEISHU_ENABLED: "false",
      FEISHU_OPEN_ID: "ou_force",
      FEISHU_APP_ID: "",
      FEISHU_APP_SECRET: "",
    });
    const r = await sendText("hi", "ou_force", { force: true });
    assert.equal(r.ok, false);
    assert.match(String(r.reason || ""), /App ID|Secret|lark-cli|飞书应用/);
  });
});
