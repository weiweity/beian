import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import {
  getRenderGenerationRuntime,
  ISOLATED_UPGRADE_PROFILE_DECLARED_SHA256,
  ISOLATED_UPGRADE_PROFILE_ID,
  ISOLATED_UPGRADE_REGISTRY_SHA256,
  registerLocalRenderGenerationRuntime,
} from "./renderGenerationRuntime.js";
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
    assert.equal(getRenderGenerationRuntime()?.upgradeCandidate, undefined);
    assert.equal(typeof getRenderGenerationRuntime()?.prepare, "function");
    assert.throws(() => registerLocalRenderGenerationRuntime(options), /already_registered/);
  } finally { clear(); }
  assert.equal(getRenderGenerationRuntime(), undefined);
});

it("isolated upgrade candidate is opt-in, identity-pinned, and still productionEnabled false", () => {
  const registry = resolve("../../../workers/packaging/profiles/render-profiles.v1.json");
  assert.equal(createHash("sha256").update(readFileSync(registry)).digest("hex"), ISOLATED_UPGRADE_REGISTRY_SHA256);
  const payload = JSON.parse(readFileSync(registry, "utf8")) as { profiles: Array<{ id: string; declared_sha256: string }> };
  const profile = payload.profiles.find((row) => row.id === ISOLATED_UPGRADE_PROFILE_ID);
  assert.equal(profile?.declared_sha256, ISOLATED_UPGRADE_PROFILE_DECLARED_SHA256);
  const options = { pythonExecutable:process.execPath, packagingDir:resolve("../../../workers/packaging"),
    blenderExecutable:process.execPath, dataRoot:resolve("../../..") };
  assert.throws(() => registerLocalRenderGenerationRuntime({
    ...options, dataRoot: makeTestTempDir("beian-runtime-"),
    upgradeCandidate: { profileId: "packshot-neutral-v1", declaredSha256: ISOLATED_UPGRADE_PROFILE_DECLARED_SHA256 },
  }), /upgrade_candidate_identity_invalid|process_containment_unavailable/);
  if (process.platform === "win32") return;
  assert.throws(() => registerLocalRenderGenerationRuntime({
    ...options, dataRoot: makeTestTempDir("beian-runtime-"),
    upgradeCandidate: { profileId: ISOLATED_UPGRADE_PROFILE_ID, declaredSha256: "sha256:" + "0".repeat(64) },
  }), /upgrade_candidate_identity_invalid/);
  const clear = registerLocalRenderGenerationRuntime({
    ...options, dataRoot: makeTestTempDir("beian-runtime-"),
    upgradeCandidate: { profileId: ISOLATED_UPGRADE_PROFILE_ID, declaredSha256: ISOLATED_UPGRADE_PROFILE_DECLARED_SHA256 },
  });
  try {
    assert.equal(getRenderGenerationRuntime()?.productionEnabled, false);
    assert.equal(getRenderGenerationRuntime()?.mode, "local-artifact-review");
    assert.deepEqual(getRenderGenerationRuntime()?.upgradeCandidate, {
      profileId: ISOLATED_UPGRADE_PROFILE_ID,
      declaredSha256: ISOLATED_UPGRADE_PROFILE_DECLARED_SHA256,
    });
  } finally { clear(); }
  assert.equal(getRenderGenerationRuntime(), undefined);
});
