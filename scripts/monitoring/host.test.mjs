import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assembleHost,
  createHostTransport,
  loadMonitorIdentity,
  parseHostArgs,
  runHost,
} from "./host.mjs";
import { createFixtureSampler } from "./runner/runner-core.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function tmp() {
  return mkdtempSync(join(tmpdir(), "beian-monitor-host-"));
}

function writeIdentity(dir, over = {}) {
  const path = join(dir, "monitor-identity.json");
  writeFileSync(path, JSON.stringify({
    schema: "beian-monitor-identity-v1",
    receiveId: "ou_syntheticreceiveid0001",
    allowRealSend: false,
    ...over,
  }));
  return path;
}

function healthySamples() {
  return [{
    id: "s1",
    sampled_at: "2026-09-14T00:00:00.000Z",
    facts: {
      "beian-server-8787": { kind: "windows_service", sample_ok: true, observed: "running" },
      cloudflared: { kind: "windows_service", sample_ok: true, observed: "running" },
    },
  }];
}

describe("host argv and identity", () => {
  it("requires explicit absolute host paths and both probe URLs", () => {
    assert.deepEqual(parseHostArgs(["--once"]).once, true);
    assert.throws(() => parseHostArgs(["--unknown"]), /未知参数/);
    const dir = tmp();
    assert.throws(() => loadMonitorIdentity("relative.json"), /absolute/);
    writeFileSync(join(dir, "settings.json"), "{}");
    assert.throws(() => loadMonitorIdentity(join(dir, "settings.json")), /product settings/);
  });

  it("refuses identity or state inside the git checkout", () => {
    const inside = join(repoRoot, "tmp-must-not-use-identity.json");
    assert.throws(
      () => loadMonitorIdentity(inside, { repoRoot }),
      /outside the git checkout/,
    );
  });

  it("does not send when allowRealSend is false", () => {
    const identity = {
      receiveId: "ou_syntheticreceiveid0001",
      allowRealSend: false,
      cliPath: "/usr/local/bin/lark-cli",
      appId: "",
      appSecret: "",
    };
    assert.equal(createHostTransport(identity), null);
  });
});

describe("host assemble", () => {
  it("runs one cycle with injected sampler and no network send", async () => {
    const root = tmp();
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    const identityPath = writeIdentity(root, { allowRealSend: false });
    const assembled = assembleHost({
      stateDir,
      identityPath,
      loopbackUrl: "http://127.0.0.1:8787/api/health",
      publicUrl: "https://www.jianghua.site/api/health",
      repoRoot,
      sampler: createFixtureSampler(healthySamples()),
      platform: "win32",
    });
    assert.equal(assembled.transport, null);
    assert.equal(assembled.identity.allowRealSend, false);
    await assembled.runner.start({ schedule: false });
    const cycle = await assembled.runner.runCycle();
    await assembled.runner.stop();
    assert.equal(cycle.skipped, null);
  });

  it("HTTP transport uses injected postJson and never product env", async () => {
    const previous = process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_APP_SECRET = "must-not-be-read";
    const root = tmp();
    const identityPath = writeIdentity(root, {
      allowRealSend: true,
      appId: "cli_testapp",
      appSecret: "secret-from-identity-file",
    });
    const posts = [];
    mkdirSync(join(root, "state"));
    const assembled = assembleHost({
      stateDir: join(root, "state"),
      identityPath,
      loopbackUrl: "http://127.0.0.1:8787/api/health",
      publicUrl: "https://www.jianghua.site/api/health",
      repoRoot,
      sampler: createFixtureSampler(healthySamples()),
      postJson: async (url, opts) => {
        posts.push({ url, body: opts.body });
        if (url.includes("tenant_access_token")) {
          return { status: 200, json: { tenant_access_token: "tok" } };
        }
        return { status: 200, json: { code: 0 } };
      },
    });
    assert.equal(assembled.transport.channel, "feishu_bot_http");
    const result = await assembled.transport.send({
      event_id: "test:1",
      type: "fault",
      title: "t",
      body: "b",
    });
    assert.equal(result.outcome, "confirmed");
    assert.equal(JSON.stringify(posts).includes("must-not-be-read"), false);
    assert.equal(posts[0].body.app_id, "cli_testapp");
    if (previous == null) delete process.env.FEISHU_APP_SECRET;
    else process.env.FEISHU_APP_SECRET = previous;
  });

  it("runHost --once returns a cycle summary", async () => {
    const root = tmp();
    mkdirSync(join(root, "state"));
    const identityPath = writeIdentity(root);
    const result = await runHost({
      stateDir: join(root, "state"),
      identityPath,
      loopbackUrl: "http://127.0.0.1:8787/api/health",
      publicUrl: "https://www.jianghua.site/api/health",
      once: true,
    }, {
      repoRoot,
      sampler: createFixtureSampler(healthySamples()),
    });
    assert.equal(result.code, 0);
    assert.equal(result.sending, false);
    assert.equal(result.cycle.skipped, null);
  });
});
