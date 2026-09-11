import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ALERT_CORE_EXACTLY_ONCE,
  ALERT_CORE_EXACTLY_ONCE_NOTE,
  ATOMIC_WRITE_NOTE,
  LOCAL_CANDIDATE_DEFAULTS,
  atomicWriteFile,
  classifyFact,
  createAlertEngine,
  emptyState,
  expandFacts,
  normalizeConfig,
  parseState,
  renderDraft,
  replaySamples,
  serializeState,
} from "./alert-core.mjs";

const config = { fail_threshold: 3, recover_threshold: 2, local_candidate: true };

function at(seconds) {
  return new Date(Date.parse("2026-09-09T00:00:00.000Z") + seconds * 1000).toISOString();
}

function svc(observed, sample_ok = true) {
  return { kind: "windows_service", sample_ok, observed };
}

function http(target, fields = {}) {
  return {
    kind: "http",
    target,
    sample_ok: true,
    http_status: 200,
    body_ok: true,
    parse_ok: true,
    ...fields,
  };
}

function sample(seconds, facts, extra = {}) {
  return { id: extra.id ?? `s${seconds}`, sampled_at: at(seconds), sequence: extra.sequence, facts };
}

describe("alert config", () => {
  it("tags defaults as local candidates, not production defaults", () => {
    assert.equal(LOCAL_CANDIDATE_DEFAULTS.production_default, false);
    assert.equal(LOCAL_CANDIDATE_DEFAULTS.local_candidate, true);
    assert.equal(LOCAL_CANDIDATE_DEFAULTS.fail_threshold, 3);
    assert.equal(LOCAL_CANDIDATE_DEFAULTS.recover_threshold, 2);
    assert.equal(ALERT_CORE_EXACTLY_ONCE, false);
    const normalized = normalizeConfig();
    assert.equal(normalized.production_default, false);
    assert.equal(normalized.local_candidate, true);
  });

  it("rejects non-positive thresholds", () => {
    assert.throws(() => normalizeConfig({ fail_threshold: 0 }), /positive integer/);
    assert.throws(() => normalizeConfig({ recover_threshold: 1.5 }), /positive integer/);
  });
});

describe("classifyFact", () => {
  it("keeps windows service, tunnel and HTTP health independent", () => {
    assert.equal(classifyFact("beian-server-8787", svc("running")).class, "ok");
    assert.equal(classifyFact("beian-server-8787", svc("stopped")).class, "bad");
    assert.equal(classifyFact("beian-server-8787", svc("Running")).class, "ok");
    assert.equal(classifyFact("cloudflared", svc("paused")).class, "bad");
    assert.equal(classifyFact("cloudflared", svc("start_pending")).class, "unknown");
    assert.equal(classifyFact("beian-server-8787", svc("unknown", false)).class, "unknown");
    assert.equal(classifyFact("http_health", http("public")).class, "ok");
    assert.equal(classifyFact("http_health.public", http("public", { http_status: 502, body_ok: false })).class, "bad");
    assert.equal(classifyFact("http_health.public", http("public", { sample_ok: false })).class, "unknown");
    assert.equal(classifyFact("http_health.loopback", http("loopback", { parse_ok: false })).class, "unknown");
    assert.equal(classifyFact("http_health", http("loopback", { http_status: 200, body_ok: undefined, parse_ok: true })).class, "unknown");
  });

  it("does not treat public HTTP failure as a stopped process", () => {
    const publicFail = classifyFact("http_health.public", http("public", { sample_ok: false }));
    const service = classifyFact("beian-server-8787", svc("running"));
    assert.equal(publicFail.class, "unknown");
    assert.equal(service.class, "ok");
    assert.notEqual(publicFail.class, "bad");
  });
});

describe("expandFacts", () => {
  it("splits nested HTTP loopback and public observations", () => {
    const facts = expandFacts({
      "beian-server-8787": svc("running"),
      http_health: {
        loopback: http("loopback"),
        public: http("public", { http_status: 502, body_ok: false }),
      },
    });
    assert.equal(facts["http_health.loopback"].target, "loopback");
    assert.equal(facts["http_health.public"].http_status, 502);
    assert.equal(facts.http_health, undefined);
  });
});

describe("hysteresis and suppression", () => {
  it("emits nothing while healthy", () => {
    const result = replaySamples([
      sample(0, { "beian-server-8787": svc("running"), cloudflared: svc("running"), http_health: http("loopback") }),
      sample(30, { "beian-server-8787": svc("running"), cloudflared: svc("running"), http_health: http("loopback") }),
      sample(60, { "beian-server-8787": svc("running"), cloudflared: svc("running"), http_health: http("loopback") }),
    ], { config });
    assert.deepEqual(result.events, []);
    assert.equal(result.notify, false);
    assert.equal(result.exactly_once, false);
  });

  it("needs consecutive failures to open one fault and does not spam", () => {
    const samples = [0, 30, 60, 90, 120].map((sec) => sample(sec, { "beian-server-8787": svc("stopped") }));
    const result = replaySamples(samples, { config });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "fault");
    assert.equal(result.events[0].source, "beian-server-8787");
    assert.equal(result.events[0].consecutive, 3);
    assert.equal(result.events[0].notify, false);
    assert.equal(result.state.sources["beian-server-8787"].incident.status, "open");
  });

  it("ignores jitter below the fail threshold", () => {
    const result = replaySamples([
      sample(0, { cloudflared: svc("stopped") }),
      sample(30, { cloudflared: svc("running") }),
      sample(60, { cloudflared: svc("stopped") }),
      sample(90, { cloudflared: svc("running") }),
      sample(120, { cloudflared: svc("stopped") }),
    ], { config });
    assert.equal(result.events.length, 0);
  });

  it("emits one recovery after consecutive ok", () => {
    const result = replaySamples([
      sample(0, { "beian-server-8787": svc("stopped") }),
      sample(30, { "beian-server-8787": svc("stopped") }),
      sample(60, { "beian-server-8787": svc("stopped") }),
      sample(90, { "beian-server-8787": svc("running") }),
      sample(120, { "beian-server-8787": svc("running") }),
    ], { config });
    assert.deepEqual(result.events.map((event) => event.type), ["fault", "recovery"]);
    assert.equal(result.state.sources["beian-server-8787"].incident.status, "closed");
    assert.match(result.drafts[0].body, /故障：beian-server-8787/);
    assert.match(result.drafts[1].body, /恢复：beian-server-8787/);
    assert.equal(result.drafts[0].sent, false);
    assert.equal(result.drafts[0].channel, "unconfigured");
  });

  it("does not alert on startup unknown or sample failure", () => {
    const result = replaySamples([
      sample(0, { "beian-server-8787": svc("unknown", false), http_health: http("public", { sample_ok: false }) }),
      sample(30, { "beian-server-8787": svc("start_pending"), http_health: http("loopback", { parse_ok: false }) }),
      sample(60, { "beian-server-8787": svc("unknown"), http_health: http("loopback", { body_ok: undefined }) }),
      sample(90, { "beian-server-8787": { kind: "windows_service", sample_ok: false } }),
    ], { config });
    assert.equal(result.events.length, 0);
    assert.equal(result.state.sources["beian-server-8787"].class, "unknown");
  });

  it("lets unknown break consecutive streaks by default", () => {
    const result = replaySamples([
      sample(0, { "beian-server-8787": svc("stopped") }),
      sample(30, { "beian-server-8787": svc("stopped") }),
      sample(60, { "beian-server-8787": { kind: "windows_service", sample_ok: false } }),
      sample(90, { "beian-server-8787": svc("stopped") }),
    ], { config });
    assert.equal(result.events.length, 0);
    assert.equal(result.state.sources["beian-server-8787"].consecutive_bad, 1);
  });

  it("skips duplicate and out-of-order samples so they cannot manufacture a fault", () => {
    const engine = createAlertEngine({ config });
    const first = engine.ingest(sample(0, { "beian-server-8787": svc("stopped") }, { id: "a", sequence: 1 }));
    const dup = engine.ingest(sample(0, { "beian-server-8787": svc("stopped") }, { id: "a", sequence: 1 }));
    const second = engine.ingest(sample(30, { "beian-server-8787": svc("stopped") }, { id: "b", sequence: 2 }));
    const late = engine.ingest(sample(-10, { "beian-server-8787": svc("stopped") }, { id: "late", sequence: 0 }));
    const third = engine.ingest(sample(60, { "beian-server-8787": svc("stopped") }, { id: "c", sequence: 3 }));
    assert.equal(first.events.length, 0);
    assert.equal(dup.skipped[0].reason, "duplicate");
    assert.equal(second.events.length, 0);
    assert.equal(late.skipped[0].reason, "out_of_order");
    assert.equal(third.events.length, 1);
    assert.equal(third.events[0].type, "fault");
  });

  it("does not assert a process is down when only public HTTP fails", () => {
    const result = replaySamples([
      sample(0, {
        "beian-server-8787": svc("running"),
        cloudflared: svc("running"),
        http_health: { loopback: http("loopback"), public: http("public", { http_status: 502, body_ok: false }) },
      }),
      sample(30, {
        "beian-server-8787": svc("running"),
        cloudflared: svc("running"),
        http_health: { loopback: http("loopback"), public: http("public", { http_status: 502, body_ok: false }) },
      }),
      sample(60, {
        "beian-server-8787": svc("running"),
        cloudflared: svc("running"),
        http_health: { loopback: http("loopback"), public: http("public", { http_status: 503, body_ok: false }) },
      }),
    ], { config });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].source, "http_health.public");
    assert.equal(result.events[0].type, "fault");
    assert.equal(result.state.sources["beian-server-8787"].class, "ok");
    assert.equal(result.state.sources.cloudflared.class, "ok");
    assert.equal(result.state.sources["beian-server-8787"].incident, null);
    assert.match(result.drafts[0].body, /不能用来断言/);
    assert.doesNotMatch(JSON.stringify(result.events), /secret|token|open_id|password/i);
  });
});

describe("dedup state", () => {
  it("treats corrupt state as empty and may re-emit after a new threshold — not exactly-once", () => {
    for (const raw of ["", "{", "null", "[]", "{\"schema\":\"nope\"}", "{\"schema\":\"beian-alert-state-v1\",\"exactly_once\":true,\"seen_ids\":[],\"sources\":{}}"]) {
      const parsed = parseState(raw);
      if (raw === "") {
        assert.equal(parsed.missing, true);
        assert.equal(parsed.invalid, false);
      } else {
        assert.equal(parsed.invalid, true, raw);
        assert.deepEqual(parsed.state, emptyState());
      }
    }
    const result = replaySamples(
      [0, 30, 60].map((sec) => sample(sec, { cloudflared: svc("stopped") })),
      { config, stateText: "{not-json" },
    );
    assert.equal(result.warnings[0].code, "state_invalid");
    assert.equal(result.events.length, 1);
    assert.match(ALERT_CORE_EXACTLY_ONCE_NOTE, /exactly-once/);
  });

  it("does not re-emit an open incident after restart when state loads", () => {
    const first = replaySamples(
      [0, 30, 60, 90].map((sec) => sample(sec, { "beian-server-8787": svc("stopped") })),
      { config },
    );
    assert.equal(first.events.length, 1);
    const restart = replaySamples(
      [120, 150, 180].map((sec) => sample(sec, { "beian-server-8787": svc("stopped") })),
      { config, state: first.state },
    );
    assert.equal(restart.events.length, 0);
    assert.equal(restart.state.sources["beian-server-8787"].incident.status, "open");
  });

  it("replays the same sample ids after restart without counting them twice", () => {
    const samples = [0, 30, 60].map((sec) => sample(sec, { "beian-server-8787": svc("stopped") }));
    const first = replaySamples(samples, { config });
    assert.equal(first.events.length, 1);
    const again = replaySamples(samples, { config, state: first.state });
    assert.equal(again.events.length, 0);
    assert.ok(again.skipped.every((row) => row.reason === "duplicate"));
  });

  it("writes state atomically and keeps the old file when rename fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "beian-alert-state-"));
    const dest = join(dir, "state.json");
    writeFileSync(dest, "old-state");
    atomicWriteFile(dest, serializeState(emptyState()), { nonce: "abc", pid: 1, now: 2 });
    assert.match(readFileSync(dest, "utf8"), /beian-alert-state-v1/);
    assert.deepEqual(readdirSync(dir), ["state.json"]);
    assert.throws(() => atomicWriteFile(dest, "new-state", {
      rename() {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    }));
    assert.match(readFileSync(dest, "utf8"), /beian-alert-state-v1/);
    assert.deepEqual(readdirSync(dir), ["state.json"]);
    assert.match(ATOMIC_WRITE_NOTE, /copyFile/);
  });
});

describe("drafts", () => {
  it("redacts to an allowlist and leaves recipients unconfigured", () => {
    const event = replaySamples(
      [0, 30, 60].map((sec) => sample(sec, {
        "beian-server-8787": { ...svc("stopped"), token: "should-not-leak", detail: "C:\\\\Users\\\\secret" },
      })),
      { config },
    ).events[0];
    const draft = renderDraft(event);
    assert.equal(draft.recipients, "unconfigured");
    assert.equal(event.facts.token, undefined);
    assert.equal(event.facts.detail, undefined);
    assert.equal(event.facts.observed, "stopped");
    assert.doesNotMatch(draft.body, /should-not-leak|Users/);
  });
});

it("does not copy credentials or nested objects from allowed fact fields", () => {
  // Synthetic URL exercises credential stripping without embedding a credential URL.
  const target = new URL("https://example.test/private?token=secret");
  target.username = "user";
  target.password = "password";
  const result = replaySamples([{id:"safe", sampled_at:at(1), facts:{http_health:http(target.href, {http_status:503, version:{token:"secret"}})}}], {config:{fail_threshold:1}});
  assert.equal(result.events.length, 1);
  assert.ok(!JSON.stringify(result.events).includes("secret"));
  assert.ok(!JSON.stringify(result.drafts).includes("password"));
});

it("same sequence with a new id cannot advance a streak", () => {
  const engine = createAlertEngine({config:{fail_threshold:2}});
  engine.ingest(sample(0,{cloudflared:svc("stopped")},{id:"a",sequence:1}));
  const duplicate=engine.ingest(sample(1,{cloudflared:svc("stopped")},{id:"b",sequence:1}));
  assert.equal(duplicate.events.length,0);
  assert.equal(engine.snapshot().sources.cloudflared.consecutive_bad,1);
});
it("sync failure cleans temporary state and preserves original", () => {
  const dir=mkdtempSync(join(tmpdir(),"alert-fsync-")); const dest=join(dir,"state.json");
  writeFileSync(dest,"old");
  assert.throws(()=>atomicWriteFile(dest,"new",{fsync(){throw new Error("disk failure");}}));
  assert.equal(readFileSync(dest,"utf8"),"old");
  assert.deepEqual(readdirSync(dir),["state.json"]);
});
