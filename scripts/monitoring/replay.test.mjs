import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseState } from "./alert-core.mjs";
import { HELP_TEXT, loadFixture, main, parseArgs, runReplay } from "./replay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const replayCli = join(here, "replay.mjs");
const fixtures = join(here, "fixtures");

function replayFile(name, extraArgs = []) {
  return spawnSync(process.execPath, [replayCli, "--input", join(fixtures, name), ...extraArgs], {
    encoding: "utf8",
    cwd: here,
  });
}

describe("replay CLI contract", () => {
  it("parses arguments and help text", () => {
    assert.deepEqual(parseArgs(["--input", "a.json", "--text"]), {
      input: "a.json",
      state: "",
      writeState: "",
      text: true,
      help: false,
    });
    assert.match(HELP_TEXT, /不发送/);
    assert.throws(() => parseArgs(["--wat"]), /未知参数/);
    const fixture = loadFixture(readFileSync(join(fixtures, "down.json"), "utf8"));
    assert.equal(fixture.samples.length, 3);
  });

  it("replays healthy / down / sustained / jitter / recovery fixtures", () => {
    const healthy = JSON.parse(replayFile("healthy.json").stdout);
    assert.equal(replayFile("healthy.json").status, 0);
    assert.equal(healthy.events.length, 0);

    const down = JSON.parse(replayFile("down.json").stdout);
    assert.equal(down.events.length, 1);
    assert.equal(down.events[0].type, "fault");
    assert.equal(down.events[0].source, "beian-server-8787");
    assert.equal(down.state.sources.cloudflared.class, "ok");
    assert.equal(down.state.sources.http_health.class, "unknown");
    assert.match(down.drafts[0].body, /未发送/);

    const sustained = JSON.parse(replayFile("sustained-down.json").stdout);
    assert.equal(sustained.events.length, 1);

    const jitter = JSON.parse(replayFile("jitter.json").stdout);
    assert.equal(jitter.events.length, 0);

    const recovery = JSON.parse(replayFile("recovery.json").stdout);
    assert.deepEqual(recovery.events.map((event) => event.type), ["fault", "recovery"]);
  });

  it("covers startup unknown, duplicate/out-of-order, and public HTTP without process inference", () => {
    const unknown = JSON.parse(replayFile("startup-unknown.json").stdout);
    assert.equal(unknown.events.length, 0);

    const mixed = JSON.parse(replayFile("duplicate-out-of-order.json").stdout);
    assert.equal(mixed.events.length, 1);
    assert.ok(mixed.skipped.some((row) => row.reason === "duplicate"));
    assert.ok(mixed.skipped.some((row) => row.reason === "out_of_order"));

    const pub = JSON.parse(replayFile("public-http-fail.json").stdout);
    assert.equal(pub.events.length, 1);
    assert.equal(pub.events[0].source, "http_health.public");
    assert.equal(pub.state.sources["beian-server-8787"].class, "ok");
    assert.equal(pub.state.sources.cloudflared.class, "ok");
    assert.match(pub.drafts[0].body, /不能用来断言/);
    assert.equal(pub.notify, false);
    assert.equal(pub.production_probe, false);
    assert.equal(pub.exactly_once, false);
  });

  it("prints redacted text drafts to stderr without sending", () => {
    const result = replayFile("down.json", ["--text"]);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /备案本地告警草稿/);
    assert.match(result.stderr, /接收人与渠道未配置/);
    assert.doesNotMatch(result.stderr, /FEISHU|open_id|secret/i);
  });

  it("reuses persisted state so a restart does not duplicate the fault", () => {
    const dir = mkdtempSync(join(tmpdir(), "beian-alert-replay-"));
    const statePath = join(dir, "state.json");
    const first = runReplay({
      inputPath: join(fixtures, "sustained-down.json"),
      writeStatePath: statePath,
      cwd: here,
    });
    assert.equal(first.events.length, 1);
    const loaded = parseState(readFileSync(statePath, "utf8"));
    assert.equal(loaded.invalid, false);
    assert.equal(loaded.state.sources["beian-server-8787"].incident.status, "open");
    const second = runReplay({
      inputPath: join(fixtures, "sustained-down.json"),
      statePath,
      cwd: here,
    });
    assert.equal(second.events.length, 0);
    assert.ok(second.skipped.length >= 1);
  });

  it("starts from empty suppression on a corrupt state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "beian-alert-bad-state-"));
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, "{truncated");
    const result = runReplay({
      inputPath: join(fixtures, "down.json"),
      statePath,
      cwd: here,
    });
    assert.equal(result.state_load.invalid, true);
    assert.ok(result.warnings.some((row) => row.code === "state_invalid"));
    assert.equal(result.events.length, 1);
  });

  it("exits 2 for missing input and unknown flags", () => {
    const missing = spawnSync(process.execPath, [replayCli], { encoding: "utf8" });
    assert.equal(missing.status, 2);
    const unknown = spawnSync(process.execPath, [replayCli, "--nope"], { encoding: "utf8" });
    assert.equal(unknown.status, 2);
    const help = spawnSync(process.execPath, [replayCli, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /本地告警回放/);
  });

  it("main writes JSON through the injected io host", () => {
    const chunks = [];
    const err = [];
    const io = {
      stdout: { write(text) { chunks.push(text); } },
      stderr: { write(text) { err.push(text); } },
      exitCode: 0,
    };
    const code = main(["--input", join(fixtures, "healthy.json"), "--text"], io);
    assert.equal(code, 0);
    assert.equal(JSON.parse(chunks.join("")).events.length, 0);
    assert.match(err.join(""), /无事件草稿/);
  });
});
