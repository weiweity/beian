import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { replaySamples } from "../alert-core.mjs";
import { createDeliveryQueue, createFakeClock } from "./delivery-core.mjs";
import { EXAMPLE_HELP, main, runExample } from "./example.mjs";
import { createFakeTransport } from "./fake-transport.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");
const exampleCli = join(here, "example.mjs");

const FIXTURE_EVENTS = {
  "healthy.json": [],
  "jitter.json": [],
  "startup-unknown.json": [],
  "down.json": [{ type: "fault", source: "beian-server-8787" }],
  "sustained-down.json": [{ type: "fault", source: "beian-server-8787" }],
  "public-http-fail.json": [{ type: "fault", source: "http_health.public" }],
  "duplicate-out-of-order.json": [{ type: "fault", source: "beian-server-8787" }],
  "recovery.json": [
    { type: "fault", source: "beian-server-8787" },
    { type: "recovery", source: "beian-server-8787" },
  ],
};

function replayFixture(name) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
  return replaySamples(fixture.samples, { config: fixture.config });
}

function tmpState() {
  return join(mkdtempSync(join(tmpdir(), "beian-delivery-compat-")), "delivery.json");
}

describe("alert-core fixture compatibility", () => {
  it("covers every bundled fixture and keeps event identity", () => {
    const names = readdirSync(fixturesDir).filter((name) => name.endsWith(".json")).sort();
    assert.deepEqual(names, Object.keys(FIXTURE_EVENTS).sort());

    for (const name of names) {
      const result = replayFixture(name);
      const expected = FIXTURE_EVENTS[name];
      assert.equal(result.events.length, expected.length, name);
      assert.deepEqual(
        result.events.map((event) => ({ type: event.type, source: event.source })),
        expected,
        name,
      );
      const transport = createFakeTransport();
      const queue = createDeliveryQueue({
        statePath: tmpState(),
        clock: createFakeClock(),
        transport,
      });
      const first = queue.enqueueFromReplay(result);
      const second = queue.enqueueFromReplay(result);
      assert.equal(first.added.length, expected.length, name);
      assert.equal(second.added.length, 0, name);
      assert.equal(queue.snapshot().items.length, expected.length, name);
      const tick = queue.tick();
      assert.equal(tick.attempted.length, expected.length, name);
      assert.equal(transport.calls.length, expected.length, name);
      if (expected.length) {
        assert.deepEqual(
          queue.snapshot().items.map((item) => item.event_id),
          result.events.map((event) => event.id),
          name,
        );
        assert.ok(queue.snapshot().items.every((item) => item.status === "confirmed"), name);
        assert.equal(result.drafts[0].channel, "unconfigured");
        assert.equal(result.drafts[0].recipients, "unconfigured");
        assert.doesNotMatch(JSON.stringify(queue.snapshot()), /lark|webhook|FEISHU|app_secret/i);
      }
    }
  });

  it("keeps public HTTP failure independent of process sources", () => {
    const result = replayFixture("public-http-fail.json");
    assert.equal(result.events[0].source, "http_health.public");
    assert.equal(result.state.sources["beian-server-8787"].class, "ok");
    assert.equal(result.state.sources.cloudflared.class, "ok");
    const queue = createDeliveryQueue({
      statePath: tmpState(),
      clock: createFakeClock(),
      transport: createFakeTransport(),
    });
    queue.enqueueFromReplay(result);
    queue.tick();
    assert.equal(queue.snapshot().items[0].source, "http_health.public");
    assert.match(queue.snapshot().items[0].draft.body, /不能用来断言/);
  });

  it("sends recovery fixture in source order: fault then recovery", () => {
    const result = replayFixture("recovery.json");
    const transport = createFakeTransport();
    const queue = createDeliveryQueue({
      statePath: tmpState(),
      clock: createFakeClock(),
      transport,
    });
    queue.enqueueFromReplay(result);
    queue.tick();
    assert.deepEqual(result.events.map((event) => event.type), ["fault", "recovery"]);
    assert.deepEqual(transport.calls.map((row) => row.type), ["fault", "recovery"]);
    assert.deepEqual(transport.calls.map((row) => row.event_id), result.events.map((event) => event.id));
  });
});

describe("example API", () => {
  it("runs the documented recovery example with fake transport only", () => {
    const result = runExample();
    assert.equal(result.production_send, false);
    assert.equal(result.notify, false);
    assert.equal(result.exactly_once, false);
    assert.equal(result.enqueued.added.length, 2);
    assert.equal(result.transport_calls, 2);
    assert.ok(result.snapshot.items.every((item) => item.status === "confirmed"));
    assert.match(EXAMPLE_HELP, /不访问网络/);
  });

  it("exposes a CLI the main agent can copy", () => {
    const help = spawnSync(process.execPath, [exampleCli, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /fake transport/);
    const run = spawnSync(process.execPath, [exampleCli], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.schema, "beian-delivery-example-v1");
    assert.equal(parsed.transport_calls, 2);
    let stderr = "";
    const bad = main(["--webhook"], {
      stdout: { write() {} },
      stderr: { write(chunk) { stderr += chunk; } },
      exitCode: 0,
    });
    assert.equal(bad, 2);
    assert.match(stderr, /未知参数/);
  });
});
