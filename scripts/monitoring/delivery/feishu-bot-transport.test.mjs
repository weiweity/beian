import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { replaySamples } from "../alert-core.mjs";
import { createDeliveryQueue, createFakeClock } from "./delivery-core.mjs";
import {
  buildFeishuBotArgv,
  createFeishuBotTransport,
  createFeishuHttpTransport,
  createLarkCliExec,
  FEISHU_BOT_TRANSPORT_NOTE,
} from "./feishu-bot-transport.mjs";

const CLI = "/usr/local/bin/lark-cli";
const RECEIVE = "ou_syntheticreceiveid0001";

function payload(over = {}) {
  return {
    event_id: "fault:beian-server-8787:2026-09-14T00:00:00.000Z",
    type: "fault",
    source: "beian-server-8787",
    at: "2026-09-14T00:00:00.000Z",
    incident_id: "inc-1",
    title: "beian-server-8787 故障",
    body: "连续采样失败",
    ...over,
  };
}

describe("feishu bot transport construction", () => {
  it("requires absolute cli path, ou_ receive id, bot identity and injected exec", () => {
    const exec = () => ({ code: 0, stdout: JSON.stringify({ ok: true }) });
    assert.throws(() => createFeishuBotTransport({ receiveId: RECEIVE, exec }), /cliPath/);
    assert.throws(() => createFeishuBotTransport({ cliPath: "lark-cli", receiveId: RECEIVE, exec }), /absolute/);
    assert.throws(() => createFeishuBotTransport({ cliPath: CLI, receiveId: "user-1", exec }), /ou_/);
    assert.throws(() => createFeishuBotTransport({
      cliPath: CLI, receiveId: RECEIVE, identity: "user", exec,
    }), /identity=bot/);
    assert.throws(() => createFeishuBotTransport({ cliPath: CLI, receiveId: RECEIVE }), /exec/);
  });

  it("does not read product FEISHU settings or environment", async () => {
    const previous = {
      FEISHU_ENABLED: process.env.FEISHU_ENABLED,
      FEISHU_OPEN_ID: process.env.FEISHU_OPEN_ID,
      FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    };
    process.env.FEISHU_ENABLED = "true";
    process.env.FEISHU_OPEN_ID = "ou_from_env_must_not_win";
    process.env.FEISHU_APP_SECRET = "must-not-be-read";
    const seen = [];
    const transport = createFeishuBotTransport({
      cliPath: CLI,
      receiveId: RECEIVE,
      exec: (argv) => {
        seen.push(argv);
        return { code: 0, stdout: JSON.stringify({ ok: true, data: { message_id: "om_fake" } }) };
      },
    });
    const result = await transport.send(payload());
    assert.equal(result.outcome, "confirmed");
    assert.equal(seen[0].includes("ou_from_env_must_not_win"), false);
    assert.equal(seen[0].includes(RECEIVE), true);
    assert.equal(JSON.stringify(seen).includes("must-not-be-read"), false);
    assert.match(FEISHU_BOT_TRANSPORT_NOTE, /allowRealSend=false/);
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
});

describe("feishu bot argv and outcomes", () => {
  it("sends as bot with user-id and keeps text exact", async () => {
    let argv;
    const transport = createFeishuBotTransport({
      cliPath: CLI,
      receiveId: RECEIVE,
      exec: (next) => {
        argv = next;
        return { code: 0, stdout: JSON.stringify({ ok: true }) };
      },
    });
    await transport.send(payload());
    assert.deepEqual(argv.slice(0, 11), [
      CLI, "im", "+messages-send", "--as", "bot", "--user-id", RECEIVE, "--text",
      "beian-server-8787 故障\n连续采样失败", "--format", "json",
    ]);
    assert.equal(argv.includes("--idempotency-key"), true);
  });

  it("maps ok false, exit 10, lost ack and missing binary", async () => {
    const rejected = createFeishuBotTransport({
      cliPath: CLI,
      receiveId: RECEIVE,
      exec: () => ({ code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: { type: "authorization" } }) }),
    });
    assert.deepEqual(await rejected.send(payload()), { outcome: "failed", retryable: false, code: "rejected" });

    const gated = createFeishuBotTransport({
      cliPath: CLI,
      receiveId: RECEIVE,
      exec: () => ({ code: 10, stdout: "", stderr: "confirmation_required" }),
    });
    assert.equal((await gated.send(payload())).code, "rejected");

    const lost = createFeishuBotTransport({
      cliPath: CLI,
      receiveId: RECEIVE,
      exec: () => ({ code: 0, stdout: "not-json", stderr: "" }),
    });
    assert.deepEqual(await lost.send(payload()), { outcome: "unknown", code: "lost_ack" });

    const missing = createFeishuBotTransport({
      cliPath: CLI,
      receiveId: RECEIVE,
      exec: () => {
        throw Object.assign(new Error("missing"), { reason: "missing_executable" });
      },
    });
    assert.deepEqual(await missing.send(payload()), {
      outcome: "failed", retryable: false, code: "rejected",
    });
  });

  it("maps abort to unknown timeout and does not throw into the queue", async () => {
    const transport = createFeishuBotTransport({
      cliPath: CLI,
      receiveId: RECEIVE,
      exec: (_argv, { signal }) => {
        assert.equal(signal.aborted, true);
        const err = new Error("cancelled");
        err.reason = "cancelled";
        throw err;
      },
    });
    const ac = new AbortController();
    ac.abort();
    assert.deepEqual(await transport.send(payload(), { signal: ac.signal }), {
      outcome: "unknown",
      code: "timeout",
    });
  });

  it("omits idempotency key when event id is too long", () => {
    const argv = buildFeishuBotArgv({
      cliPath: CLI,
      receiveId: RECEIVE,
      text: "x",
      eventId: "fault:http_health.public:2026-09-14T00:00:00.000Z-extra",
    });
    assert.equal(argv.includes("--idempotency-key"), false);
  });
});

describe("default lark exec refuses real send", () => {
  it("does not spawn when allowRealSend is not true", async () => {
    let spawned = false;
    const exec = createLarkCliExec({
      allowRealSend: false,
      spawnImpl: () => { spawned = true; },
    });
    const result = await exec([CLI, "im", "+messages-send"]);
    assert.equal(spawned, false);
    assert.equal(result.authorized, false);
    const transport = createFeishuBotTransport({ cliPath: CLI, receiveId: RECEIVE, exec });
    assert.deepEqual(await transport.send(payload()), {
      outcome: "failed", retryable: false, code: "rejected",
    });
  });
});

describe("feishu HTTP transport", () => {
  it("confirms with injected postJson and keeps secrets out of calls", async () => {
    const posts = [];
    const transport = createFeishuHttpTransport({
      receiveId: RECEIVE,
      appId: "cli_test",
      appSecret: "secret-value",
      postJson: async (url, opts) => {
        posts.push(url);
        if (url.includes("tenant_access_token")) {
          return { status: 200, json: { tenant_access_token: "tok" } };
        }
        return { status: 200, json: { code: 0 } };
      },
    });
    const result = await transport.send(payload());
    assert.equal(result.outcome, "confirmed");
    assert.equal(JSON.stringify(transport.calls).includes("secret-value"), false);
    assert.equal(posts.length, 2);
  });
});

describe("delivery queue with injected feishu exec", () => {
  it("confirms a fixture fault without network or product settings", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "beian-feishu-bot-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fixture = {
      samples: [
        {
          sampled_at: "2026-09-14T00:00:00.000Z",
          facts: {
            "beian-server-8787": { kind: "windows_service", sample_ok: true, observed: "stopped" },
            cloudflared: { kind: "windows_service", sample_ok: true, observed: "running" },
          },
        },
        {
          sampled_at: "2026-09-14T00:00:30.000Z",
          facts: {
            "beian-server-8787": { kind: "windows_service", sample_ok: true, observed: "stopped" },
            cloudflared: { kind: "windows_service", sample_ok: true, observed: "running" },
          },
        },
      ],
      config: { fail_threshold: 2, recover_threshold: 2 },
    };
    const replay = replaySamples(fixture.samples, { config: fixture.config });
    const transport = createFeishuBotTransport({
      cliPath: CLI,
      receiveId: RECEIVE,
      exec: () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { message_id: "om_test" } }) }),
    });
    const queue = createDeliveryQueue({
      statePath: join(dir, "delivery.json"),
      clock: createFakeClock(Date.parse("2026-09-14T00:01:00.000Z")),
      transport,
    });
    queue.enqueueFromReplay(replay);
    const tick = await queue.tick();
    assert.equal(tick.attempted.length, 1);
    assert.equal(queue.snapshot().items[0].status, "confirmed");
    const raw = JSON.stringify(queue.snapshot());
    assert.doesNotMatch(raw, /ou_synthetic/);
    assert.doesNotMatch(raw, /FEISHU|app_secret|open_id/i);
  });
});
