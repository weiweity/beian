import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DATA_DIR } from "./config.js";
import { afterEach, describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
import {
  MOCKUP_ATOMIC_WRITE_NOTE,
  MOCKUP_ATOMIC_WRITE_TRUSTED_ROOTS_NOTE,
  MOCKUP_ATOMIC_WRITE_WINDOWS_DURABILITY_PROVEN,
  MockupAtomicWriteError,
  atomicReplaceJobJson,
  resetMockupAtomicWriteTestHooks,
  setMockupAtomicWriteTestHooks,
} from "./mockupAtomicWrite.js";

function sortedNames(dir: string): string[] {
  return readdirSync(dir).sort();
}

afterEach(() => {
  resetMockupAtomicWriteTestHooks();
});

function expectWriteError(fn: () => unknown, cause: string): void {
  try {
    fn();
    assert.fail(`expected atomic write to fail (${cause})`);
  } catch (err) {
    assert.equal(err instanceof MockupAtomicWriteError, true, String(err));
    assert.equal((err as MockupAtomicWriteError).code, "render_generation_invalid");
    assert.equal((err as MockupAtomicWriteError).cause, cause);
    assert.doesNotMatch((err as Error).message, /PowerShell/i);
  }
}

describe("mockupAtomicWrite", () => {
  for (const boundary of [1, 2, 3]) {
    it(`deadline at atomic boundary ${boundary} preserves old JSON and cleans temporary bytes`, () => {
      const dir = makeTestTempDir("beian-atomic-deadline-");
      const path = join(dir, "job.json");
      writeFileSync(path, "old-current");
      let checks = 0;
      assert.throws(() => atomicReplaceJobJson(path, "new-current", () => {
        if (++checks === boundary) throw new Error("lifecycle_timeout");
      }), /lifecycle_timeout/);
      assert.equal(readFileSync(path, "utf8"), "old-current");
      assert.deepEqual(sortedNames(dir), ["job.json"]);
    });
  }

  it("creates an absent job.json preserving UTF-8 bytes and leaves no temporary files", () => {
    const dir = makeTestTempDir("beian-atomic-create-");
    const text = JSON.stringify({ label: "合成测试·底面", current: "g0-legacy-original" });
    atomicReplaceJobJson(join(dir, "job.json"), text);
    assert.equal(readFileSync(join(dir, "job.json"), "utf8"), text);
    assert.deepEqual(sortedNames(dir), ["job.json"]);
  });

  it("rejects invalid contents and relative destinations before creating any file", () => {
    const dir = makeTestTempDir("beian-atomic-input-");
    expectWriteError(() => atomicReplaceJobJson(join(dir, "job.json"), null as unknown as string), "contents");
    expectWriteError(() => atomicReplaceJobJson("job.json", "{}"), "dest_not_absolute");
    assert.deepEqual(sortedNames(dir), []);
  });

  it("rejects a directory at job.json without touching its children", () => {
    const dir = makeTestTempDir("beian-atomic-dest-dir-");
    const dest = join(dir, "job.json");
    mkdirSync(dest);
    writeFileSync(join(dest, "marker"), "unchanged");
    expectWriteError(() => atomicReplaceJobJson(dest, "{}"), "not_file");
    assert.deepEqual(sortedNames(dir), ["job.json"]);
    assert.equal(readFileSync(join(dest, "marker"), "utf8"), "unchanged");
  });

  it("cleans its temporary file after a codeless rename failure and supports retry", () => {
    const dir = makeTestTempDir("beian-atomic-retry-");
    const dest = join(dir, "job.json");
    writeFileSync(dest, "old");
    setMockupAtomicWriteTestHooks({ rename: () => { throw new Error("synthetic"); } });
    expectWriteError(() => atomicReplaceJobJson(dest, "new"), "rename_rename_failed");
    assert.equal(readFileSync(dest, "utf8"), "old");
    assert.deepEqual(sortedNames(dir), ["job.json"]);
    resetMockupAtomicWriteTestHooks();
    atomicReplaceJobJson(dest, "new");
    assert.equal(readFileSync(dest, "utf8"), "new");
    assert.deepEqual(sortedNames(dir), ["job.json"]);
  });

  it("refuses test hooks outside explicit test mode and restores the environment", () => {
    const previous = process.env.VITEST;
    try {
      delete process.env.VITEST;
      assert.throws(() => setMockupAtomicWriteTestHooks({}), /只能在 VITEST/);
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });

  it("replaces job.json via same-directory rename and keeps the new bytes", () => {
    const dir = makeTestTempDir("beian-atomic-ok-");
    const dest = join(dir, "job.json");
    writeFileSync(dest, '{"old":true}');
    atomicReplaceJobJson(dest, '{"current":"g1"}');
    assert.equal(readFileSync(dest, "utf8"), '{"current":"g1"}');
    assert.equal(MOCKUP_ATOMIC_WRITE_WINDOWS_DURABILITY_PROVEN, false);
    assert.match(MOCKUP_ATOMIC_WRITE_NOTE, /不是断电耐久性/);
    assert.match(MOCKUP_ATOMIC_WRITE_TRUSTED_ROOTS_NOTE, /\/tmp→\/private\/tmp/);
  });

  it("replaces job.json when nested ancestors are real directories", () => {
    const root = makeTestTempDir("beian-atomic-nested-");
    const dir = join(root, "a", "b", "task");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "job.json");
    writeFileSync(dest, '{"old":true}');
    writeFileSync(join(dir, "marker"), "keep");
    const beforeNames = sortedNames(dir);
    atomicReplaceJobJson(dest, '{"current":"g1"}');
    assert.equal(readFileSync(dest, "utf8"), '{"current":"g1"}');
    assert.equal(readFileSync(join(dir, "marker"), "utf8"), "keep");
    assert.deepEqual(sortedNames(dir), beforeNames);
  });

  it("keeps the old file when rename fails and does not copy over the destination", () => {
    const dir = makeTestTempDir("beian-atomic-fail-");
    const dest = join(dir, "job.json");
    writeFileSync(dest, '{"old":true}');
    let renameCalls = 0;
    setMockupAtomicWriteTestHooks({
      rename: () => {
        renameCalls += 1;
        throw Object.assign(new Error("simulated windows rename"), { code: "EPERM" });
      },
    });
    const beforeNames = sortedNames(dir);
    const beforeBytes = readFileSync(dest);
    expectWriteError(() => atomicReplaceJobJson(dest, '{"new":true}'), "rename_EPERM");
    assert.equal(renameCalls, 1);
    assert.equal(readFileSync(dest, "utf8"), '{"old":true}');
    assert.equal(readFileSync(dest).equals(beforeBytes), true);
    assert.deepEqual(sortedNames(dir), beforeNames);
  });

  it("refuses a symlink destination before writing the outside sentinel", () => {
    const dir = makeTestTempDir("beian-atomic-sym-");
    const outside = makeTestTempDir("beian-atomic-out-");
    const sentinel = join(outside, "sentinel.json");
    writeFileSync(sentinel, "UNCHANGED");
    const dest = join(dir, "job.json");
    symlinkSync(sentinel, dest);
    expectWriteError(() => atomicReplaceJobJson(dest, '{"hack":true}'), "symlink");
    assert.equal(readFileSync(sentinel, "utf8"), "UNCHANGED");
  });

  it("refuses a symlink parent directory and leaves the outside tree unchanged", () => {
    const outside = makeTestTempDir("beian-atomic-parent-out-");
    mkdirSync(join(outside, "jobdir"));
    writeFileSync(join(outside, "jobdir", "marker"), "keep");
    const beforeNames = sortedNames(join(outside, "jobdir"));
    const root = makeTestTempDir("beian-atomic-parent-");
    const jobDir = join(root, "linked-job");
    symlinkSync(join(outside, "jobdir"), jobDir);
    expectWriteError(() => atomicReplaceJobJson(join(jobDir, "job.json"), '{"x":1}'), "symlink_dir");
    assert.equal(readFileSync(join(outside, "jobdir", "marker"), "utf8"), "keep");
    assert.equal(existsSync(join(outside, "jobdir", "job.json")), false);
    assert.deepEqual(sortedNames(join(outside, "jobdir")), beforeNames);
  });

  it("refuses an ancestor symlink before creating a temp file and leaves external bytes unchanged", () => {
    const probeRoot = makeTestTempDir("beian-atomic-anc-");
    mkdirSync(join(probeRoot, "outside", "task"), { recursive: true });
    mkdirSync(join(probeRoot, "inside"));
    const outsideTask = join(probeRoot, "outside", "task");
    writeFileSync(join(outsideTask, "job.json"), "ORIGINAL");
    writeFileSync(join(outsideTask, "marker"), "keep");
    symlinkSync(join(probeRoot, "outside"), join(probeRoot, "inside", "link"));
    const beforeNames = sortedNames(outsideTask);
    const beforeJob = readFileSync(join(outsideTask, "job.json"));
    const beforeInside = sortedNames(join(probeRoot, "inside"));
    expectWriteError(
      () => atomicReplaceJobJson(join(probeRoot, "inside", "link", "task", "job.json"), "CHANGED"),
      "symlink_dir",
    );
    assert.equal(readFileSync(join(outsideTask, "job.json"), "utf8"), "ORIGINAL");
    assert.equal(readFileSync(join(outsideTask, "job.json")).equals(beforeJob), true);
    assert.equal(readFileSync(join(outsideTask, "marker"), "utf8"), "keep");
    assert.deepEqual(sortedNames(outsideTask), beforeNames);
    assert.deepEqual(sortedNames(join(probeRoot, "inside")), beforeInside);
    assert.equal(lstatSync(join(probeRoot, "inside", "link")).isSymbolicLink(), true);
  });

  it("rejects a missing parent and does not create directories or files", () => {
    const dir = makeTestTempDir("beian-atomic-miss-");
    writeFileSync(join(dir, "marker"), "keep");
    const beforeNames = sortedNames(dir);
    expectWriteError(() => atomicReplaceJobJson(join(dir, "missing", "job.json"), '{"x":1}'), "parent_missing");
    assert.deepEqual(sortedNames(dir), beforeNames);
    assert.equal(existsSync(join(dir, "missing")), false);
    assert.equal(readFileSync(join(dir, "marker"), "utf8"), "keep");
  });

  it("rejects a non-directory ancestor and leaves the file bytes unchanged", () => {
    const dir = makeTestTempDir("beian-atomic-file-");
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "UNCHANGED");
    const beforeNames = sortedNames(dir);
    const beforeBytes = readFileSync(blocker);
    expectWriteError(() => atomicReplaceJobJson(join(blocker, "nested", "job.json"), '{"x":1}'), "ancestor_not_dir");
    expectWriteError(() => atomicReplaceJobJson(join(blocker, "job.json"), '{"x":1}'), "parent_not_dir");
    assert.equal(readFileSync(blocker, "utf8"), "UNCHANGED");
    assert.equal(readFileSync(blocker).equals(beforeBytes), true);
    assert.deepEqual(sortedNames(dir), beforeNames);
  });

  it("rejects an arbitrary trusted-alias even when it points at a system tmp root", () => {
    const probeRoot = mkdtempSync(join(tmpdir(), "beian-atomic-trusted-alias-"));
    try {
      mkdirSync(join(probeRoot, "outside", "task"), { recursive: true });
      mkdirSync(join(probeRoot, "inside"));
      const outsideTask = join(probeRoot, "outside", "task");
      writeFileSync(join(outsideTask, "job.json"), "ORIGINAL");
      writeFileSync(join(outsideTask, "marker"), "keep");
      symlinkSync(tmpdir(), join(probeRoot, "inside", "trusted-alias"));
      const beforeNames = sortedNames(outsideTask);
      const beforeJob = readFileSync(join(outsideTask, "job.json"));
      const beforeInside = sortedNames(join(probeRoot, "inside"));
      const leaf = basename(probeRoot);
      expectWriteError(
        () =>
          atomicReplaceJobJson(
            join(probeRoot, "inside", "trusted-alias", leaf, "outside", "task", "job.json"),
            "ALIAS_CHANGED",
          ),
        "symlink_dir",
      );
      assert.equal(readFileSync(join(outsideTask, "job.json"), "utf8"), "ORIGINAL");
      assert.equal(readFileSync(join(outsideTask, "job.json")).equals(beforeJob), true);
      assert.equal(readFileSync(join(outsideTask, "marker"), "utf8"), "keep");
      assert.deepEqual(sortedNames(outsideTask), beforeNames);
      assert.deepEqual(sortedNames(join(probeRoot, "inside")), beforeInside);
      assert.equal(lstatSync(join(probeRoot, "inside", "trusted-alias")).isSymbolicLink(), true);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  });

  it("rejects an ancestor chain that aliases /private/tmp and leaves external bytes unchanged", {
    skip: !existsSync("/private/tmp"),
  }, () => {
    const probeRoot = mkdtempSync(join("/private/tmp", "beian-atomic-private-alias-"));
    try {
      mkdirSync(join(probeRoot, "outside", "task"), { recursive: true });
      mkdirSync(join(probeRoot, "inside"));
      const outsideTask = join(probeRoot, "outside", "task");
      writeFileSync(join(outsideTask, "job.json"), "ORIGINAL");
      writeFileSync(join(outsideTask, "marker"), "keep");
      symlinkSync("/private/tmp", join(probeRoot, "inside", "trusted-alias"));
      const beforeNames = sortedNames(outsideTask);
      const beforeJob = readFileSync(join(outsideTask, "job.json"));
      const beforeInside = sortedNames(join(probeRoot, "inside"));
      const leaf = basename(probeRoot);
      expectWriteError(
        () =>
          atomicReplaceJobJson(
            join(probeRoot, "inside", "trusted-alias", leaf, "outside", "task", "job.json"),
            "ALIAS_CHANGED",
          ),
        "symlink_dir",
      );
      assert.equal(readFileSync(join(outsideTask, "job.json"), "utf8"), "ORIGINAL");
      assert.equal(readFileSync(join(outsideTask, "job.json")).equals(beforeJob), true);
      assert.equal(readFileSync(join(outsideTask, "marker"), "utf8"), "keep");
      assert.deepEqual(sortedNames(outsideTask), beforeNames);
      assert.deepEqual(sortedNames(join(probeRoot, "inside")), beforeInside);
      assert.equal(existsSync(join(outsideTask, ".job.json")), false);
      assert.equal(lstatSync(join(probeRoot, "inside", "trusted-alias")).isSymbolicLink(), true);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  });

  it("rejects internal symlinks even when they point at DATA_DIR or /tmp", () => {
    const root = makeTestTempDir("beian-atomic-internal-alias-");
    mkdirSync(join(root, "inside"));
    writeFileSync(join(root, "marker"), "keep");
    const beforeRoot = sortedNames(root);
    symlinkSync(DATA_DIR, join(root, "inside", "to-data"));
    expectWriteError(() => atomicReplaceJobJson(join(root, "inside", "to-data", "job.json"), "CHANGED"), "symlink_dir");
    if (existsSync("/tmp")) {
      symlinkSync("/tmp", join(root, "inside", "to-tmp"));
      expectWriteError(() => atomicReplaceJobJson(join(root, "inside", "to-tmp", "job.json"), "CHANGED"), "symlink_dir");
    }
    assert.equal(readFileSync(join(root, "marker"), "utf8"), "keep");
    assert.deepEqual(sortedNames(root), beforeRoot);
    assert.equal(lstatSync(join(root, "inside", "to-data")).isSymbolicLink(), true);
    assert.equal(existsSync(join(root, "job.json")), false);
    assert.equal(existsSync(join(root, "inside", "job.json")), false);
  });

  it("allows dest under the system /tmp alias when ancestors are real directories", {
    skip: !existsSync("/tmp"),
  }, () => {
    const dir = mkdtempSync(join("/tmp", "beian-atomic-alias-"));
    try {
      const dest = join(dir, "job.json");
      writeFileSync(dest, '{"old":true}');
      writeFileSync(join(dir, "marker"), "keep");
      const beforeNames = sortedNames(dir);
      atomicReplaceJobJson(dest, '{"ok":true}');
      assert.equal(readFileSync(dest, "utf8"), '{"ok":true}');
      assert.equal(readFileSync(join(dir, "marker"), "utf8"), "keep");
      assert.deepEqual(sortedNames(dir), beforeNames);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a dest outside trusted canonical roots and leaves that tree unchanged", () => {
    const dir = mkdtempSync(join(homedir(), "beian-atomic-untrusted-"));
    try {
      const dest = join(dir, "job.json");
      writeFileSync(dest, "ORIGINAL");
      writeFileSync(join(dir, "marker"), "keep");
      const beforeNames = sortedNames(dir);
      const beforeBytes = readFileSync(dest);
      expectWriteError(() => atomicReplaceJobJson(dest, "CHANGED"), "untrusted_root");
      assert.equal(readFileSync(dest, "utf8"), "ORIGINAL");
      assert.equal(readFileSync(dest).equals(beforeBytes), true);
      assert.equal(readFileSync(join(dir, "marker"), "utf8"), "keep");
      assert.deepEqual(sortedNames(dir), beforeNames);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a hardlinked job.json so the outside inode stays frozen", () => {
    const dir = makeTestTempDir("beian-atomic-hl-");
    const outside = makeTestTempDir("beian-atomic-hl-out-");
    const sentinel = join(outside, "sentinel.json");
    writeFileSync(sentinel, "UNCHANGED");
    const dest = join(dir, "job.json");
    linkSync(sentinel, dest);
    expectWriteError(() => atomicReplaceJobJson(dest, '{"hack":true}'), "hardlink");
    assert.equal(readFileSync(sentinel, "utf8"), "UNCHANGED");
  });

  it("rejects non-job.json destinations", () => {
    const dir = makeTestTempDir("beian-atomic-name-");
    const dest = join(dir, "other.json");
    writeFileSync(dest, "{}");
    expectWriteError(() => atomicReplaceJobJson(dest, '{"x":1}'), "dest_name");
    assert.equal(readFileSync(dest, "utf8"), "{}");
  });
});
