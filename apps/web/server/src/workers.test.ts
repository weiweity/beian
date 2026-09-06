import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-workers-");

const {
  WORKER_OUTPUT_LIMIT_BYTES,
  killTree,
  pidAlive,
  runPython,
  workerCommandMatches,
} = await import("./workers.js");

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

describe("worker process identity", () => {
  it("binds generation workers to exact job, mutation, token and CLI position", () => {
    const expected = { kind: "render_generation" as const, id: "job1", mutationId: "m1",
      executionId: `job1:m1:${"a".repeat(32)}` };
    const command = `python /trusted/render_generation.py - --execution-id ${expected.executionId}`;
    assert.equal(workerCommandMatches(command, expected), true);
    for (const bad of [command.replace("job1:m1:", "job2:m1:"), command.replace("job1:m1:", "job1:m2:"),
      command.replace("a".repeat(32), "b".repeat(32)), command.replace("render_generation.py", "pipeline.py"),
      `${command} --execution-id other`, command.replace(" - --execution-id", " request.json --execution-id")]) {
      assert.equal(workerCommandMatches(bad, expected), false);
    }
    assert.equal(workerCommandMatches(command, { ...expected, mutationId: "different" }), false);
  });
  it("requires both the job kind and exact task id", () => {
    const id = "00000000abcd";
    assert.equal(
      workerCommandMatches(`python -m app.cli compare --tid ${id} --data-dir /tmp/data`, { kind: "compare", id }),
      true,
    );
    assert.equal(
      workerCommandMatches(`python -m app.cli rework --tid ${id} --data-dir /tmp/data`, { kind: "compare", id }),
      false,
    );
    assert.equal(
      workerCommandMatches("python -m app.cli compare --tid 00000000abce --data-dir /tmp/data", { kind: "compare", id }),
      false,
    );
  });

  it("recognizes a mockup only when pipeline.py carries the task id path segment", () => {
    const id = "00000000abcd";
    assert.equal(
      workerCommandMatches(`python pipeline.py "C:\\supply\\data\\mockups\\${id}\\manifest.json" --workers 1`, {
        kind: "mockup",
        id,
      }),
      true,
    );
    assert.equal(
      workerCommandMatches("python pipeline.py C:\\supply\\data\\mockups\\00000000abce\\manifest.json --workers 1", {
        kind: "mockup",
        id,
      }),
      false,
    );
  });
});

describe("runPython output bounds", () => {
  it("bounds large output while keeping final JSON and streaming STAGE lines", async () => {
    const stages: string[] = [];
    const result = await runPython({
      args: [
        "-c",
        [
          "import json, sys",
          `sys.stdout.write('x' * ${WORKER_OUTPUT_LIMIT_BYTES + 65_536})`,
          "sys.stdout.write('\\n' + json.dumps({'status': 'pending_review'}) + '\\n')",
          `sys.stderr.write('y' * ${WORKER_OUTPUT_LIMIT_BYTES + 65_536})`,
          "sys.stderr.write('\\nSTAGE ocr\\n')",
        ].join("; "),
      ],
      timeoutMs: 10_000,
      onStderrLine: (line) => {
        if (line.startsWith("STAGE ")) stages.push(line);
      },
    });

    assert.equal(result.code, 0);
    assert.ok(Buffer.byteLength(result.stdout) <= WORKER_OUTPUT_LIMIT_BYTES);
    assert.ok(Buffer.byteLength(result.stderr) <= WORKER_OUTPUT_LIMIT_BYTES);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\n/).at(-1) || ""), { status: "pending_review" });
    assert.deepEqual(stages, ["STAGE ocr"]);
  });
});
