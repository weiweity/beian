import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-set-");

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

  it("minimax disabled copy is not an isolated 通", async () => {
    saveSettings({ MINIMAX_ENABLED: "false", MINIMAX_API_KEY: "" });
    const r = await runProbe("minimax");
    assert.equal(r.message.trim() === "通" || r.message.trim() === "不通", false);
    assert.match(r.message, /未启用|模型列表|Key/);
  });

  it("adminOnly keys include blender and illustrator", async () => {
    const { adminOnlyKeys } = await import("./settings.js");
    const keys = adminOnlyKeys();
    assert.ok(keys.includes("BLENDER_EXECUTABLE"));
    assert.ok(keys.includes("ILLUSTRATOR_EXECUTABLE"));
  });

  it("illustrator probe does not claim isolated 通", async () => {
    const r = await runProbe("illustrator");
    assert.equal(r.ok, false);
    assert.equal(r.message.trim() === "通" || r.message.trim() === "不通", false);
    assert.match(r.message, /路径|扫描/);
  });

  it("lark probe does not require lark-cli when app credentials exist", async () => {
    saveSettings({ FEISHU_APP_ID: "cli_probe_app", FEISHU_APP_SECRET: "probe-secret" });
    const r = await runProbe("lark");
    assert.equal(r.message.trim() === "通" || r.message.trim() === "不通", false);
    assert.equal(r.message.includes("本机找不到 lark-cli") && !r.ok, false);
    if (!r.ok) assert.match(r.message, /凭证|lark-cli|测试/);
    else assert.match(r.message, /飞书应用|lark-cli|发一条测试/);
  });
});
