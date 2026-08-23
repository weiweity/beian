import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-notify-"));
process.env.VITEST = "1";

const { saveSettings } = await import("./settings.js");
const { sendText } = await import("./notify.js");

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
});
