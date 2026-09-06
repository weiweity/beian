import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectRenderGenerationGroup, renderGenerationProcessSupported, signalRenderGenerationGroup } from "./renderGenerationProcess.js";

describe("generation process group absence proof", () => {
  it("supports only the implemented POSIX platforms, not Windows taskkill", () => {
    assert.equal(renderGenerationProcessSupported("darwin"), true);
    assert.equal(renderGenerationProcessSupported("linux"), true);
    assert.equal(renderGenerationProcessSupported("win32"), false);
    assert.equal(renderGenerationProcessSupported("freebsd"), false);
  });
  it("probes the negative process group id with signal zero, never a parent PID", () => {
    const calls: unknown[] = [];
    assert.equal(inspectRenderGenerationGroup(2345, { platform: "darwin", kill: (pid, signal) => {
      calls.push([pid, signal]); return true;
    } }), "present");
    assert.deepEqual(calls, [[-2345, 0]]);
  });
  for (const code of ["ESRCH", "EPERM", "EINVAL", undefined]) {
    it(`treats only ESRCH as missing, probe error=${code}`, () => {
      assert.equal(inspectRenderGenerationGroup(2345, { platform: "linux", kill: () => {
        throw Object.assign(new Error("probe failure"), { code });
      } }), code === "ESRCH" ? "missing" : "unknown");
    });
  }
  it("does not probe invalid identifiers or unsupported platforms", () => {
    const kill = () => { assert.fail("must not signal"); };
    for (const pid of [0, 1, -4, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(inspectRenderGenerationGroup(pid, { platform: "darwin", kill }), "unknown");
    }
    assert.equal(inspectRenderGenerationGroup(2345, { platform: "win32", kill }), "unknown");
    assert.throws(() => signalRenderGenerationGroup(0), /unsupported/);
    assert.throws(() => signalRenderGenerationGroup(1), /unsupported/);
  });
});
