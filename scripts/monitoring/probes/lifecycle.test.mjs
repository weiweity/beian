import assert from "node:assert/strict";
import { it } from "node:test";
import { getEventListeners, EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { defaultHttpGet, probeHttpHealth } from "./http-health.mjs";
import { createProbe } from "./collect.mjs";
import { classifyFact } from "../alert-core.mjs";

it("keeps 502 as bad without reading an error body, even if cancellation fails", async (t) => {
  let read = false;
  t.mock.method(globalThis, "fetch", async () => ({
    status: 502,
    text: async () => { read = true; throw new Error("body reset"); },
    body: { cancel: async () => { throw new Error("already errored"); } },
  }));
  const result = await probeHttpHealth({ target: "public", url: "https://example.test/health", httpGet: defaultHttpGet });
  assert.equal(classifyFact("http_health.public", result.fact).class, "bad");
  assert.equal(result.fact.http_status, 502);
  assert.equal(read, false);
});

it("stops and cancels a large response stream before buffering the whole body", async (t) => {
  let reads = 0, cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(c) { reads++; if (reads > 128) c.close(); else c.enqueue(new Uint8Array(32768)); },
    cancel() { cancelled = true; },
  }), { status: 200 }));
  await assert.rejects(defaultHttpGet("https://example.test/health"), /body_too_large/);
  assert.equal(cancelled, true);
  assert.ok(reads < 10, `read ${reads} chunks`);
});

it("decodes a bounded UTF-8 health body across chunk boundaries", async (t) => {
  const bytes = new TextEncoder().encode('{"ok":true,"note":"正常"}');
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); },
  })));
  assert.deepEqual(JSON.parse((await defaultHttpGet("https://example.test/health")).bodyText), {ok:true,note:"正常"});
});

it("cleans exec abort listeners after success, failure and cancellation, and skips pre-cancelled work", async (t) => {
  let mode = "success", launched = 0;
  t.mock.method(childProcess, "execFile", (_file, _args, _opts, callback) => {
    launched++;
    const child = new EventEmitter();
    child.kill = () => callback({ killed: true }, "", "");
    if (mode !== "cancel") queueMicrotask(() => callback(mode === "success" ? null : {code:"ENOENT"}, "[]", ""));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const probe = createProbe({ platform: "win32" });
  for (const nextMode of ["success", "failure", "cancel"]) {
    mode = nextMode;
    const ac = new AbortController();
    const pending = probe.collectSample({signal:ac.signal});
    if (mode === "cancel") ac.abort();
    await pending;
    assert.equal(getEventListeners(ac.signal,"abort").length,0,mode);
  }
  const ac = new AbortController(); ac.abort();
  const before = launched;
  await probe.collectSample({signal:ac.signal});
  assert.equal(launched,before);
});
