/** Normal adapter registry, separate from test hooks. Default is disabled.
 * This release deliberately exposes registration only for local temporary-data
 * review. No production opt-in/env switch exists. Windows native evidence and
 * production authorization are separate rollout gates, not caller booleans.
 * Isolated upgradeCandidate is opt-in at this register call only.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { tmpdir } from "node:os";
import { createRenderGenerationPreparer } from "./renderGenerationAdapter.js";
import { renderGenerationProcessSupported } from "./renderGenerationProcess.js";
import type { QualityVerifier } from "./renderGenerations.js";
import {
  assertIsolatedUpgradeCandidate,
  type IsolatedUpgradeCandidate,
} from "./renderGenerationUpgradeCandidate.js";

export {
  ISOLATED_UPGRADE_PROFILE_DECLARED_SHA256,
  ISOLATED_UPGRADE_PROFILE_ID,
  ISOLATED_UPGRADE_REGISTRY_SHA256,
} from "./renderGenerationUpgradeCandidate.js";

type LocalRuntime = Readonly<{
  prepare: ReturnType<typeof createRenderGenerationPreparer>;
  archiveVerifier: QualityVerifier;
  productionEnabled: false;
  mode: "local-artifact-review";
  upgradeCandidate?: IsolatedUpgradeCandidate;
}>;
let runtime: LocalRuntime | undefined;
export function getRenderGenerationRuntime(): LocalRuntime | undefined { return runtime; }

export function registerLocalRenderGenerationRuntime(options: Omit<Parameters<typeof createRenderGenerationPreparer>[0], "upgradeCandidate"> & {
  upgradeCandidate?: { profileId: string; declaredSha256: string };
}): () => void {
  if (runtime) throw new Error("render_runtime_already_registered");
  if (!renderGenerationProcessSupported()) throw new Error("process_containment_unavailable");
  const root = realpathSync(options.dataRoot);
  const rel = relative(realpathSync(tmpdir()), root);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("production_registration_disabled");
  const upgradeCandidate = options.upgradeCandidate
    ? assertIsolatedUpgradeCandidate(options.upgradeCandidate)
    : undefined;
  const archiveVerifier: QualityVerifier = input => ({
    generation_id: input.generation_id, contract_sha256: input.contract_sha256,
    content_fingerprint: input.content_fingerprint,
    verifier_status: input.mode === "legacy_import" ? "accepted" : "rejected",
    quality_status: input.mode === "legacy_import" ? "unwired" : "failed",
    verifier: "rf03-historical-archive/1",
    note: "仅存档已存在且由 store 校验的旧字节；不补写历史视觉质量通过",
  });
  const installed: LocalRuntime = Object.freeze({
    prepare: createRenderGenerationPreparer({ ...options, dataRoot: root, upgradeCandidate }),
    archiveVerifier, productionEnabled: false, mode: "local-artifact-review", upgradeCandidate,
  });
  runtime = installed;
  return () => { if (runtime === installed) runtime = undefined; };
}
