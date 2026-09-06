import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { createRenderGenerationPreparer } from "./renderGenerationAdapter.js";
import { makeTestTempDir } from "./testTemp.js";

// Real adapter/bridge/Python execution is covered by the Python cross-language suite.
// This direct entry test keeps construction fail-closed and visible to static tooling.
it("constructs an inert preparer and rejects invalid bridge configuration without spawning", () => {
  const root = makeTestTempDir("beian-generation-adapter-");
  const options = {
    pythonExecutable: join(root, "missing-python"),
    packagingDir: root,
    dataRoot: root,
    blenderExecutable: join(root, "missing-blender"),
  };
  assert.equal(typeof createRenderGenerationPreparer(options), "function");
  assert.throws(() => createRenderGenerationPreparer({ ...options, timeoutMs: 0 }));
  assert.throws(() => createRenderGenerationPreparer({ ...options, dataRoot: "relative" }));
});
