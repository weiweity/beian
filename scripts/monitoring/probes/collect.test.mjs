import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyFact, createAlertEngine, expandFacts, replaySamples } from "../alert-core.mjs";
import { HELP_TEXT, main, parseArgs } from "./cli.mjs";
import {
  GET_SERVICES_PS1,
  buildWindowsArgv,
  createProbe,
  mapServiceObserved,
  parseServiceStdout,
  powershellExe,
} from "./collect.mjs";
import { assertProbeUrl, loopbackHeaders } from "./http-health.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FACT_KEYS = new Set(["kind", "sample_ok", "observed", "target", "http_status", "body_ok", "parse_ok", "version"]);
const REASON_ENUM = new Set([
  "timeout",
  "cancelled",
  "permission",
  "platform_not_windows",
  "missing_executable",
  "parse_failed",
  "non_json",
  "bad_json",
  "incomplete_fields",
  "network",
  "unrecognized_observed",
  "sample_failed",
]);
const config = { fail_threshold: 3, recover_threshold: 2, local_candidate: true };
const PROBE_SOURCES = [
  "collect.mjs",
  "windows-service.mjs",
  "http-health.mjs",
  "cli.mjs",
  "get-services.ps1",
  "README.md",
];

function liveBody(extra = {}) {
  return {
    ok: true,
    version: "0.24.0.0",
    runtime: "typescript",
    jobs: {
      ocr: { running: 0, queued: 0 },
      blender: { running: 0, queued: 0 },
      illustrator: { running: 0, queued: 0 },
    },
    uploads: { active: 0, waiting: 0 },
    feishu_notify: false,
    ...extra,
  };
}

function publicBody(extra = {}) {
  return {
    ok: true,
    version: "0.24.0.0",
    runtime: "typescript",
    jobs: { illustrator: { visibility: "authenticated" } },
    ...extra,
  };
}

function psRows(rows) {
  return JSON.stringify(rows);
}

function mockExec(stdout, extra = {}) {
  return async (argv, execOpts = {}) => {
    extra.captured = { argv, execOpts };
    if (extra.throwReason) {
      const err = new Error(extra.throwReason);
      err.reason = extra.throwReason;
      throw err;
    }
    if (execOpts.signal?.aborted) {
      const err = new Error("cancelled");
      err.reason = "cancelled";
      throw err;
    }
    return { stdout, stderr: extra.stderr || "secret-stderr", code: extra.code ?? 0 };
  };
}

function mockHttp(handler) {
  const calls = [];
  async function httpGet(url, opts = {}) {
    calls.push({ url, opts });
    if (opts.signal?.aborted) {
      const err = new Error("cancelled");
      err.reason = "cancelled";
      throw err;
    }
    return handler(url, opts, calls.length);
  }
  httpGet.calls = calls;
  return httpGet;
}

function assertAllowlist(facts) {
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.kind === "windows_service" || node.kind === "http") {
      for (const key of Object.keys(node)) assert.ok(FACT_KEYS.has(key), `unexpected fact key ${key}`);
      return;
    }
    for (const value of Object.values(node)) walk(value);
  }
  walk(facts);
  const text = JSON.stringify(facts);
  assert.doesNotMatch(text, /secret-stderr|password|Authorization|jianghua|Hangzhou|token=/i);
}

function assertReasons(reasons) {
  for (const value of Object.values(reasons || {})) assert.ok(REASON_ENUM.has(value), value);
}

describe("mapServiceObserved", () => {
  it("maps PascalCase, spaced, compact and numeric Win32 status onto core vocab", () => {
    assert.equal(mapServiceObserved("StartPending"), "start_pending");
    assert.equal(mapServiceObserved("Start Pending"), "start_pending");
    assert.equal(mapServiceObserved("startpending"), "start_pending");
    assert.equal(mapServiceObserved(2), "start_pending");
    assert.equal(mapServiceObserved("Running"), "running");
    assert.equal(mapServiceObserved(4), "running");
    assert.equal(mapServiceObserved("Stopped"), "stopped");
    assert.equal(mapServiceObserved(1), "stopped");
    assert.equal(mapServiceObserved("Paused"), "paused");
    assert.equal(mapServiceObserved(7), "paused");
    assert.equal(mapServiceObserved("missing"), "missing");
    assert.equal(mapServiceObserved("StopPending"), "stop_pending");
    assert.equal(mapServiceObserved(3), "stop_pending");
    assert.equal(mapServiceObserved("ContinuePending"), "continue_pending");
    assert.equal(mapServiceObserved(5), "continue_pending");
    assert.equal(mapServiceObserved("PausePending"), "pause_pending");
    assert.equal(mapServiceObserved(6), "pause_pending");
    assert.equal(mapServiceObserved(0), null);
    assert.equal(mapServiceObserved(8), null);
    assert.equal(mapServiceObserved("3.0"), null);
    assert.equal(mapServiceObserved("garbage"), null);
  });

  it("feeds mapped pending into classifyFact as unknown, not unrecognized", () => {
    const pending = classifyFact("beian-server-8787", {
      kind: "windows_service",
      sample_ok: true,
      observed: mapServiceObserved("StartPending"),
    });
    assert.equal(pending.class, "unknown");
    assert.equal(pending.reason, "service_unknown");
    assert.notEqual(pending.reason, "service_unrecognized");
    assert.equal(classifyFact("beian-server-8787", {
      kind: "windows_service",
      sample_ok: true,
      observed: mapServiceObserved("Running"),
    }).class, "ok");
    assert.equal(classifyFact("cloudflared", {
      kind: "windows_service",
      sample_ok: true,
      observed: mapServiceObserved(1),
    }).reason, "service_stopped");
    assert.equal(classifyFact("cloudflared", {
      kind: "windows_service",
      sample_ok: true,
      observed: mapServiceObserved("missing"),
    }).reason, "service_missing");
    assert.equal(classifyFact("cloudflared", {
      kind: "windows_service",
      sample_ok: true,
      observed: mapServiceObserved(3),
    }).reason, "service_unknown");
  });
});

describe("windows query adapter", () => {
  it("collects both running services from mock Get-Service JSON", async () => {
    const captured = {};
    const exec = mockExec(
      psRows([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ]),
      captured,
    );
    const { sample, reasons, platform_claim } = await createProbe({
      now: () => new Date("2026-09-09T00:00:00.000Z"),
      exec,
      platform: "win32",
    }).collectSample({ id: "s0" });
    assert.equal(platform_claim, "mock");
    assert.equal(sample.facts["beian-server-8787"].observed, "running");
    assert.equal(sample.facts.cloudflared.observed, "running");
    assert.equal(classifyFact("beian-server-8787", sample.facts["beian-server-8787"]).class, "ok");
    assert.equal(sample.facts.http_health, undefined);
    assertAllowlist(sample.facts);
    assertReasons(reasons);
    const argv = captured.captured.argv;
    assert.ok(Array.isArray(argv));
    assert.equal(argv[0], powershellExe());
    assert.ok(argv[0].includes("WindowsPowerShell\\v1.0\\powershell.exe"));
    assert.ok(!argv[0].includes("pwsh"));
    assert.deepEqual(argv.slice(1, 6), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
    assert.equal(argv[6], GET_SERVICES_PS1);
    assert.ok(!argv.includes("-Command"));
    assert.equal(captured.captured.execOpts.shell, undefined);
  });

  it("maps missing vs permission without collapsing access-denied into down", async () => {
    const { sample, reasons } = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "missing" },
        { name: "cloudflared", status: "permission" },
      ])),
    }).collectSample();
    assert.equal(sample.facts["beian-server-8787"].sample_ok, true);
    assert.equal(sample.facts["beian-server-8787"].observed, "missing");
    assert.equal(classifyFact("beian-server-8787", sample.facts["beian-server-8787"]).class, "bad");
    assert.equal(sample.facts.cloudflared.sample_ok, false);
    assert.equal(sample.facts.cloudflared.observed, undefined);
    assert.equal(reasons.cloudflared, "permission");
    assert.equal(classifyFact("cloudflared", sample.facts.cloudflared).reason, "sample_failed");
  });

  it("treats timeout, cancel and missing executable as sample_ok false, not stopped", async () => {
    for (const reason of ["timeout", "cancelled", "missing_executable"]) {
      const { sample, reasons } = await createProbe({
        exec: mockExec("", { throwReason: reason }),
      }).collectSample();
      assert.equal(sample.facts["beian-server-8787"].sample_ok, false);
      assert.equal(sample.facts["beian-server-8787"].observed, undefined);
      assert.equal(sample.facts.cloudflared.observed, undefined);
      assert.equal(reasons["beian-server-8787"], reason);
      assert.notEqual(sample.facts["beian-server-8787"].observed, "stopped");
      assert.notEqual(sample.facts["beian-server-8787"].observed, "missing");
    }
  });

  it("handles non-json, bad json, incomplete rows and PS5.1 singleton objects", async () => {
    const nonJson = await createProbe({ exec: mockExec("   ", { stderr: "secret-stderr" }) }).collectSample();
    assert.equal(nonJson.reasons["beian-server-8787"], "non_json");
    assert.doesNotMatch(JSON.stringify(nonJson.sample.facts), /secret-stderr/);
    const notObject = await createProbe({ exec: mockExec("1") }).collectSample();
    assert.equal(notObject.reasons.cloudflared, "non_json");

    const bad = await createProbe({ exec: mockExec("{") }).collectSample();
    assert.equal(bad.reasons.cloudflared, "bad_json");

    const incomplete = await createProbe({
      exec: mockExec(psRows([{ name: "beian-server-8787" }, { Name: "cloudflared", status: "" }])),
    }).collectSample();
    assert.equal(incomplete.sample.facts["beian-server-8787"].sample_ok, undefined);
    assert.equal(incomplete.reasons["beian-server-8787"], "incomplete_fields");
    assert.equal(classifyFact("beian-server-8787", incomplete.sample.facts["beian-server-8787"]).reason, "sample_incomplete");

    const singleton = parseServiceStdout('{"Name":"beian-server-8787","Status":"Running"}');
    assert.equal(singleton.rows.length, 1);
    const coerced = await createProbe({
      exec: mockExec('{"name":"CLOUDFLARED","status":"StartPending"}'),
    }).collectSample();
    assert.equal(coerced.sample.facts.cloudflared.observed, "start_pending");
    assert.equal(coerced.sample.facts["beian-server-8787"].reason, undefined);
    assert.equal(coerced.reasons["beian-server-8787"], "incomplete_fields");
  });

  it("omits observed for unrecognized numeric tables and never invents running/stopped", async () => {
    const { sample, reasons } = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: 0 },
        { name: "cloudflared", status: "nope" },
      ])),
    }).collectSample();
    assert.equal(sample.facts["beian-server-8787"].sample_ok, true);
    assert.equal(sample.facts["beian-server-8787"].observed, undefined);
    assert.equal(reasons["beian-server-8787"], "unrecognized_observed");
    assert.equal(sample.facts.cloudflared.observed, undefined);
  });
});

describe("http health adapter", () => {
  it("requires explicit URLs and loopback/public host rules", () => {
    const credentialUrl = new URL("http://127.0.0.1/api/health");
    credentialUrl.username = "user";
    credentialUrl.password = "pass";
    assert.throws(() => assertProbeUrl(credentialUrl.href, "loopback"), /credentials_in_url/);
    assert.throws(() => assertProbeUrl("http://127.0.0.1:8787/api/health", "public"), /loopback_as_public/);
    assert.throws(() => assertProbeUrl("http://example.test/api/health", "loopback"), /public_as_loopback/);
    assert.doesNotThrow(() => assertProbeUrl("http://127.0.0.1:8787/api/health", "loopback"));
    assert.doesNotThrow(() => assertProbeUrl("https://example.test/api/health", "public"));
  });

  it("accepts loopback liveStatus and public visibility independently", async () => {
    const httpGet = mockHttp(async () => ({ status: 200, bodyText: JSON.stringify(liveBody()) }));
    const { sample } = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ])),
      httpGet,
    }).collectSample({ loopbackUrl: "http://127.0.0.1:8787/api/health" });
    const loop = sample.facts.http_health.loopback;
    assert.equal(loop.body_ok, true);
    assert.equal(loop.parse_ok, true);
    assert.equal(loop.version, "0.24.0.0");
    assert.equal(sample.facts.http_health.public, undefined);
    assert.equal(httpGet.calls.length, 1);
    assert.equal(hasForbidden(httpGet.calls[0].opts.headers), false);
    assert.deepEqual(loopbackHeaders(), { accept: "application/json" });
    assert.equal(classifyFact("http_health.loopback", loop).class, "ok");
  });

  it("accepts public stub without live queues", async () => {
    const httpGet = mockHttp(async () => ({ status: 200, bodyText: JSON.stringify(publicBody()) }));
    const { sample } = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ])),
      httpGet,
    }).collectSample({ publicUrl: "https://example.test/api/health" });
    assert.equal(sample.facts.http_health.public.body_ok, true);
    assert.equal(sample.facts.http_health.loopback, undefined);
  });

  it("omits body_ok for incomplete 200 and sets false only for explicit unhealthy", async () => {
    const incomplete = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ])),
      httpGet: mockHttp(async () => ({ status: 200, bodyText: JSON.stringify({ ok: true, version: "0.24.0.0", runtime: "typescript" }) })),
    }).collectSample({ loopbackUrl: "http://127.0.0.1/api/health", publicUrl: "https://example.test/api/health" });
    assert.equal(incomplete.sample.facts.http_health.loopback.body_ok, undefined);
    assert.equal(incomplete.sample.facts.http_health.public.body_ok, undefined);
    assert.equal(
      classifyFact("http_health.loopback", incomplete.sample.facts.http_health.loopback).reason,
      "body_ok_missing",
    );

    const badRuntime = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ])),
      httpGet: mockHttp(async () => ({
        status: 200,
        bodyText: JSON.stringify({ ok: true, version: "0.24.0.0", runtime: "python", jobs: { illustrator: { visibility: "nope" } } }),
      })),
    }).collectSample({ publicUrl: "https://example.test/api/health" });
    assert.equal(badRuntime.sample.facts.http_health.public.body_ok, false);
  });

  it("keeps non-2xx as sampled bad HTTP and 200 non-JSON as parse_failed", async () => {
    const fail = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ])),
      httpGet: mockHttp(async () => ({ status: 502, bodyText: "<html>secret-body</html>" })),
    }).collectSample({ publicUrl: "https://example.test/api/health" });
    const pub = fail.sample.facts.http_health.public;
    assert.equal(pub.sample_ok, true);
    assert.equal(pub.http_status, 502);
    assert.equal(pub.parse_ok, true);
    assert.equal(pub.body_ok, false);
    assert.doesNotMatch(JSON.stringify(fail.sample.facts), /secret-body/);
    assert.equal(classifyFact("http_health.public", pub).class, "bad");

    const nonJson = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ])),
      httpGet: mockHttp(async () => ({ status: 200, bodyText: "not-json" })),
    }).collectSample({ loopbackUrl: "http://127.0.0.1/api/health" });
    assert.equal(nonJson.sample.facts.http_health.loopback.parse_ok, false);
    assert.equal(nonJson.sample.facts.http_health.loopback.body_ok, undefined);
    assert.equal(classifyFact("http_health.loopback", nonJson.sample.facts.http_health.loopback).reason, "parse_failed");
  });

  it("HTTP timeout or cancel omits status and does not mark services stopped", async () => {
    const timeout = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ])),
      httpGet: mockHttp(async () => {
        const err = new Error("timeout");
        err.reason = "timeout";
        throw err;
      }),
    }).collectSample({ publicUrl: "https://example.test/api/health" });
    assert.equal(timeout.sample.facts.http_health.public.sample_ok, false);
    assert.equal(timeout.sample.facts.http_health.public.http_status, undefined);
    assert.equal(timeout.sample.facts.http_health.public.parse_ok, undefined);
    assert.equal(timeout.reasons["http_health.public"], "timeout");
    assert.equal(timeout.sample.facts["beian-server-8787"].observed, "running");

    const ac = new AbortController();
    ac.abort();
    const cancelled = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ])),
      httpGet: mockHttp(async (_url, opts) => {
        if (opts.signal?.aborted) {
          const err = new Error("cancelled");
          err.reason = "cancelled";
          throw err;
        }
        return { status: 200, bodyText: "{}" };
      }),
    }).collectSample({ loopbackUrl: "http://127.0.0.1/api/health", signal: ac.signal });
    assert.equal(cancelled.sample.facts.http_health.loopback.sample_ok, false);
    assert.equal(cancelled.reasons["http_health.loopback"], "cancelled");
  });

  it("rejects bad URLs before exec or http", async () => {
    let execCalled = false;
    let httpCalled = false;
    await assert.rejects(
      () => createProbe({
        exec: async () => {
          execCalled = true;
          return { stdout: "[]", stderr: "", code: 0 };
        },
        httpGet: async () => {
          httpCalled = true;
          return { status: 200, bodyText: "{}" };
        },
      }).collectSample({ publicUrl: "http://127.0.0.1/api/health" }),
      /loopback_as_public/,
    );
    assert.equal(execCalled, false);
    assert.equal(httpCalled, false);
  });

  it("does not call httpGet when that arm is unconfigured", async () => {
    const httpGet = mockHttp(async () => ({ status: 200, bodyText: "{}" }));
    const { sample } = await createProbe({
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "Running" },
        { name: "cloudflared", status: "Running" },
      ])),
      httpGet,
    }).collectSample();
    assert.equal(httpGet.calls.length, 0);
    assert.equal(sample.facts.http_health, undefined);
  });
});

describe("alert-core compatibility", () => {
  it("replays healthy nested facts without events", async () => {
    const httpGet = mockHttp(async (url) => {
      if (String(url).includes("127.0.0.1")) return { status: 200, bodyText: JSON.stringify(liveBody()) };
      return { status: 200, bodyText: JSON.stringify(publicBody()) };
    });
    const samples = [];
    for (let i = 0; i < 3; i += 1) {
      const { sample } = await createProbe({
        now: () => new Date(Date.parse("2026-09-09T00:00:00.000Z") + i * 30_000),
        exec: mockExec(psRows([
          { name: "beian-server-8787", status: "Running" },
          { name: "cloudflared", status: "Running" },
        ])),
        httpGet,
      }).collectSample({
        id: `h${i + 1}`,
        loopbackUrl: "http://127.0.0.1:8787/api/health",
        publicUrl: "https://example.test/api/health",
      });
      samples.push(sample);
      const expanded = expandFacts(sample.facts);
      assert.equal(expanded["http_health.loopback"].target, "loopback");
      assert.equal(expanded["http_health.public"].target, "public");
      assert.equal(classifyFact("beian-server-8787", expanded["beian-server-8787"]).class, "ok");
      assert.equal(classifyFact("http_health.public", expanded["http_health.public"]).class, "ok");
    }
    const result = replaySamples(samples, { config });
    assert.equal(result.events.length, 0);
    assert.equal(result.notify, false);
  });

  it("opens only http_health.public when public HTTP fails and services stay running", async () => {
    const samples = [];
    for (let i = 0; i < 3; i += 1) {
      const { sample } = await createProbe({
        now: () => new Date(Date.parse("2026-09-09T07:00:00.000Z") + i * 30_000),
        exec: mockExec(psRows([
          { name: "beian-server-8787", status: "Running" },
          { name: "cloudflared", status: "Running" },
        ])),
        httpGet: mockHttp(async (url) => {
          if (String(url).includes("127.0.0.1")) return { status: 200, bodyText: JSON.stringify(liveBody()) };
          return { status: i === 2 ? 503 : 502, bodyText: "bad gateway" };
        }),
      }).collectSample({
        id: `p${i + 1}`,
        loopbackUrl: "http://127.0.0.1/api/health",
        publicUrl: "https://example.test/api/health",
      });
      samples.push(sample);
    }
    const result = replaySamples(samples, { config });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].source, "http_health.public");
    assert.equal(result.events[0].type, "fault");
    assert.equal(result.state.sources["beian-server-8787"].class, "ok");
    assert.equal(result.state.sources.cloudflared.class, "ok");
    assert.equal(result.state.sources["beian-server-8787"].incident, null);
    assert.doesNotMatch(JSON.stringify(result.events[0].facts), /example\.test|bad gateway/);
  });

  it("does not emit events for startup unknown shapes", async () => {
    const pending = await createProbe({
      now: () => new Date("2026-09-09T05:01:00.000Z"),
      exec: mockExec(psRows([
        { name: "beian-server-8787", status: "StartPending" },
        { name: "cloudflared", status: "Running" },
      ])),
      httpGet: mockHttp(async () => ({ status: 200, bodyText: JSON.stringify({ ok: true, version: "0.24.0.0", runtime: "typescript" }) })),
    }).collectSample({ id: "u3", loopbackUrl: "http://127.0.0.1/api/health" });
    assert.equal(pending.sample.facts["beian-server-8787"].observed, "start_pending");
    assert.equal(pending.sample.facts.http_health.loopback.body_ok, undefined);
    const engine = createAlertEngine({ config });
    const failed = engine.ingest({
      id: "u1",
      sampled_at: "2026-09-09T05:00:00.000Z",
      facts: {
        "beian-server-8787": { kind: "windows_service", sample_ok: false },
        cloudflared: { kind: "windows_service", sample_ok: false },
        http_health: { kind: "http", target: "loopback", sample_ok: false },
      },
    });
    const parsed = engine.ingest({
      id: "u2",
      sampled_at: "2026-09-09T05:00:30.000Z",
      facts: {
        "beian-server-8787": { kind: "windows_service", sample_ok: true, observed: "unknown" },
        http_health: { kind: "http", target: "public", sample_ok: true, parse_ok: false, http_status: 200 },
      },
    });
    const third = engine.ingest(pending.sample);
    assert.equal(failed.events.length + parsed.events.length + third.events.length, 0);
    const result = replaySamples([pending.sample], { config });
    assert.equal(result.events.length, 0);
  });
});

describe("platform claim and CLI", () => {
  it("does not spawn powershell on darwin default exec", async () => {
    const { sample, reasons, platform_claim } = await createProbe({ platform: "darwin" }).collectSample();
    assert.equal(platform_claim, "not_windows");
    assert.equal(sample.facts["beian-server-8787"].sample_ok, false);
    assert.equal(reasons["beian-server-8787"], "platform_not_windows");
    assert.notEqual(platform_claim, "windows");
  });

  it("parses CLI args and prints an ingestible sample", async () => {
    assert.deepEqual(parseArgs(["--loopback-url", "http://127.0.0.1/api/health", "--timeout-ms", "3"]), {
      loopbackUrl: "http://127.0.0.1/api/health",
      publicUrl: "",
      timeoutMs: 3,
      id: "",
      help: false,
    });
    assert.match(HELP_TEXT, /不发送/);
    assert.doesNotMatch(HELP_TEXT, /jianghua|Hangzhou|www\./i);
    assert.throws(() => parseArgs(["--wat"]), /未知参数/);
    const helpIo = host();
    assert.equal(await main(["--help"], helpIo), 0);
    assert.match(helpIo.stdout.chunks.join(""), /只读探测/);
    const badIo = host();
    assert.equal(await main(["--timeout-ms", "nope"], badIo), 2);
    const credIo = host();
    const credentialUrl = new URL("http://127.0.0.1/api/health");
    credentialUrl.username = "user";
    credentialUrl.password = "secret";
    assert.equal(await main(["--loopback-url", credentialUrl.href], credIo), 2);
    assert.doesNotMatch(credIo.stderr.chunks.join(""), /secret|user:secret/);
    const collectIo = host();
    assert.equal(await main([], collectIo), 0);
    const payload = JSON.parse(collectIo.stdout.chunks.join(""));
    assert.ok(payload.sampled_at);
    assert.ok(payload.facts["beian-server-8787"]);
    assert.equal(payload.sample, undefined);
    assert.equal(payload.platform_claim, undefined);
  });
});

describe("source hygiene", () => {
  it("keeps production modules free of alert-core imports and Hangzhou defaults", () => {
    for (const name of PROBE_SOURCES) {
      const text = readFileSync(join(here, name), "utf8");
      assert.doesNotMatch(text, /jianghua\.site/i);
      assert.doesNotMatch(text, /www\.jianghua/i);
      if (name !== "README.md" && name !== "get-services.ps1") {
        assert.doesNotMatch(text, /classifyFact|alert-core\.mjs/);
      }
    }
    const ps1 = readFileSync(join(here, "get-services.ps1"), "utf8");
    assert.doesNotMatch(ps1, /(?<![\w-])(?:Stop|Start|Restart)-Service(?![\w-])/);
    assert.doesNotMatch(ps1, /ErrorAction\s+SilentlyContinue/);
    const argv = buildWindowsArgv(GET_SERVICES_PS1);
    assert.ok(Array.isArray(argv));
    assert.equal(argv.includes("-Command"), false);
  });
});

function hasForbidden(headers) {
  const keys = Object.keys(headers || {}).map((key) => key.toLowerCase());
  return ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "authorization", "cookie", "x-beian-release-token"]
    .some((key) => keys.includes(key));
}

function host() {
  return {
    stdout: { chunks: [], write(chunk) { this.chunks.push(chunk); return true; } },
    stderr: { chunks: [], write(chunk) { this.chunks.push(chunk); return true; } },
    exitCode: 0,
  };
}

it("failed service command cannot supply healthy observations", async () => {
  const { sample, reasons } = await createProbe({
    exec: async () => ({ code: 1, stdout: JSON.stringify([
      { name: "beian-server-8787", status: "Running" },
      { name: "cloudflared", status: "Running" },
    ]) }),
  }).collectSample();
  assert.equal(sample.facts.cloudflared.sample_ok, false);
  assert.equal(reasons.cloudflared, "command_failed");
});

it("injected error reasons cannot leak arbitrary diagnostic text", async () => {
  const probe = createProbe({
    exec: async () => { throw { reason: "private-diagnostic-marker" }; },
    httpGet: async () => { throw { reason: "private-diagnostic-marker" }; },
  });
  const result = await probe.collectSample({ publicUrl: "https://example.test/api/health" });
  assert.doesNotMatch(JSON.stringify(result), /private-diagnostic-marker/);
});
