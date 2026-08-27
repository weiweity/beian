import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-static-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app, faviconResponse } = await import("./index.js");

describe("brand static", () => {
  it("serves logo-mark.png from ui/public/brand", async () => {
    const res = await app.request("/brand/logo-mark.png");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /image\/png/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 100);
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50);
  });

  it("serves nested nav svg", async () => {
    const res = await app.request("/brand/ui/nav-review.svg");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<svg/i);
  });

  it("404s a missing brand file", async () => {
    const res = await app.request("/brand/not-a-real-file.png");
    assert.equal(res.status, 404);
  });

  it("caches brand files for a day", async () => {
    const res = await app.request("/brand/logo-mark.png");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /max-age=86400/);
  });

  it("serves the brand mark for the browser default favicon request", async () => {
    const res = await app.request("/favicon.ico");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /image\/png/);
    assert.match(res.headers.get("cache-control") || "", /max-age=86400/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50);
  });

  it("rejects a missing or corrupt favicon source before streaming it", () => {
    const dir = makeTestTempDir("beian-favicon-http-");
    const missing = join(dir, "missing.png");
    assert.throws(() => faviconResponse(missing), (error: Error & { status?: number }) => error.status === 404);

    const corrupt = join(dir, "corrupt.png");
    writeFileSync(corrupt, "not-a-png");
    assert.throws(() => faviconResponse(corrupt), (error: Error & { status?: number }) => error.status === 404);
  });
});
