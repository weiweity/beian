import assert from "node:assert/strict";
import { it } from "node:test";
import { getRenderGenerationRuntime, registerLocalRenderGenerationRuntime } from "./renderGenerationRuntime.js";
import { makeTestTempDir } from "./testTemp.js";
import { resolve } from "node:path";

it("normal registry defaults disabled, refuses production roots and never exposes production enable", () => {
  assert.equal(getRenderGenerationRuntime(), undefined);
  const options = { pythonExecutable:process.execPath, packagingDir:resolve("../../../workers/packaging"),
    blenderExecutable:process.execPath, dataRoot:resolve("../../..") };
  assert.throws(() => registerLocalRenderGenerationRuntime(options), /production_registration_disabled|process_containment_unavailable/);
  if (process.platform === "win32") return;
  const clear = registerLocalRenderGenerationRuntime({...options,dataRoot:makeTestTempDir("beian-runtime-")});
  try {
    assert.equal(getRenderGenerationRuntime()?.productionEnabled, false);
    assert.equal(typeof getRenderGenerationRuntime()?.prepare, "function");
    assert.throws(() => registerLocalRenderGenerationRuntime(options), /already_registered/);
  } finally { clear(); }
  assert.equal(getRenderGenerationRuntime(), undefined);
});
