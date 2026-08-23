import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProbeResult } from "../api";
import {
  BOARD_ROWS,
  WIZARD,
  idleRowMessage,
  probeErrorMessage,
  progressSpoken,
  setupHeadline,
  shortGroupLabel,
  statusWord,
} from "./setupBoard.js";

describe("setupBoard copy", () => {
  it("has seven rows; MiniMax idle copy names the models list", () => {
    assert.equal(BOARD_ROWS.length, 7);
    assert.equal(
      BOARD_ROWS.some((row) => row.title === "通" || row.title === "不通"),
      false,
    );
    assert.match(idleRowMessage("minimax", "wizard"), /模型列表/);
    assert.match(idleRowMessage("minimax", "wizard"), /\/v1\/models/);
    assert.doesNotMatch(idleRowMessage("minimax", "wizard"), /^通$|^不通$/);
    assert.match(idleRowMessage("blender", "scan"), /魏炜/);
    assert.match(idleRowMessage("lark", "push"), /发一条测试/);
  });

  it("wizard pages are numbered steps, MiniMax names the models-list probe", () => {
    assert.equal(WIZARD["飞书登录"].steps.length, 3);
    assert.equal(WIZARD["百度 OCR"].steps.length, 3);
    assert.equal(WIZARD["MiniMax（可选）"].steps.length, 3);
    assert.match(WIZARD["飞书登录"].steps[1], /\/api\/auth\/feishu\/callback/);
    assert.match(WIZARD["百度 OCR"].intro, /对照/);
    assert.match(WIZARD["百度 OCR"].steps.join(""), /没有静默授权/);
    const mini = `${WIZARD["MiniMax（可选）"].intro} ${WIZARD["MiniMax（可选）"].steps.join(" ")}`;
    assert.match(mini, /GET \/v1\/models/);
    assert.match(mini, /模型列表/);
    assert.match(mini, /不是对话/);
    assert.match(mini, /不能只写一个「通」/);
  });

  it("status words are 可用/还缺/未测/超时, never 通/不通", () => {
    assert.deepEqual(statusWord(undefined), { cls: "is-idle", text: "未测" });
    assert.deepEqual(statusWord({ pending: true }), { cls: "is-wait", text: "检测中" });
    assert.equal(statusWord({ id: "x", ok: true, message: "模型列表 GET /v1/models 通了" }).text, "可用");
    assert.equal(statusWord({ id: "x", ok: false, message: "Key 无效" }).text, "还缺");
    assert.equal(statusWord({ id: "x", ok: false, message: "12 秒超时" }).text, "超时");
    assert.notEqual(statusWord({ id: "x", ok: false, message: "不通" }).text, "不通");
  });

  it("7/7 headline refuses 可以接稿", () => {
    const ok: ProbeResult = { id: "feishu", ok: true, message: "网页应用能走完 OAuth" };
    const probes = Object.fromEntries(BOARD_ROWS.map((row) => [row.id, { ...ok, id: row.id }]));
    const line = setupHeadline(probes);
    assert.match(line, /七条探测通过/);
    assert.doesNotMatch(line, /可以接稿/);
    assert.doesNotMatch(line, /8\/31 验收已/);
    assert.equal(
      progressSpoken(probes, ""),
      "7 分之 7 可用，七条探测通过",
    );
  });

  it("progress spoken names the next red row", () => {
    const probes = {
      feishu: { id: "feishu", ok: true, message: "ok" },
      lark: { id: "lark", ok: true, message: "ok" },
      baidu: { id: "baidu", ok: false, message: "还没填" },
    };
    assert.match(progressSpoken(probes, ""), /下一步 百度 OCR/);
    assert.match(setupHeadline(probes), /还缺 5 条/);
    assert.match(progressSpoken({}, "检测中 3/7"), /检测中 3\/7/);
  });

  it("probe errors stay Chinese, not Failed to fetch", () => {
    assert.equal(probeErrorMessage(new Error("Failed to fetch")), "服务没连上。看杭州 :8787 还在不在。");
    assert.equal(probeErrorMessage(new Error("Key 无效")), "Key 无效");
  });

  it("narrow pills keep values, shorten labels", () => {
    assert.equal(shortGroupLabel("外观"), "外观");
    assert.equal(shortGroupLabel("费用账单"), "费用");
    assert.equal(shortGroupLabel("MiniMax（可选）"), "MiniMax");
    assert.equal(shortGroupLabel("本机依赖"), "本机");
  });
});
