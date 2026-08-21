import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-workers-"));

const { killTree, pidAlive } = await import("./workers.js");

describe("killTree", () => {
  it("no-ops on missing pids", () => {
    killTree(0);
    killTree(-1);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-3), false);
  });

  it("does not throw when the pid is already gone", () => {
    assert.doesNotThrow(() => killTree(999_999_991, true));
  });
});
