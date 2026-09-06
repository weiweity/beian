/** Normal adapter registry, separate from test hooks. Default is disabled.
 * This release deliberately exposes registration only for local temporary-data
 * review. No production opt-in/env switch exists. Windows native evidence and
 * production authorization are separate rollout gates, not caller booleans.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { tmpdir } from "node:os";
import { createRenderGenerationPreparer } from "./renderGenerationAdapter.js";
import { renderGenerationProcessSupported } from "./renderGenerationProcess.js";
import type { QualityVerifier } from "./renderGenerations.js";

type LocalRuntime = Readonly<{
  prepare: ReturnType<typeof createRenderGenerationPreparer>;
  archiveVerifier: QualityVerifier;
  productionEnabled: false;
  mode: "local-artifact-review";
}>;
let runtime: LocalRuntime | undefined;
export function getRenderGenerationRuntime(): LocalRuntime | undefined { return runtime; }

export function registerLocalRenderGenerationRuntime(options: Parameters<typeof createRenderGenerationPreparer>[0]): () => void {
  if (runtime) throw new Error("render_runtime_already_registered");
  if (!renderGenerationProcessSupported()) throw new Error("process_containment_unavailable");
  const root = realpathSync(options.dataRoot);
  const rel = relative(realpathSync(tmpdir()), root);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("production_registration_disabled");
  const archiveVerifier: QualityVerifier = input => ({
    generation_id: input.generation_id, contract_sha256: input.contract_sha256,
    content_fingerprint: input.content_fingerprint,
    verifier_status: input.mode === "legacy_import" ? "accepted" : "rejected",
    quality_status: input.mode === "legacy_import" ? "unwired" : "failed",
    verifier: "rf03-historical-archive/1",
    note: "仅存档已存在且由 store 校验的旧字节；不补写历史视觉质量通过",
  });
  const installed: LocalRuntime = Object.freeze({ prepare: createRenderGenerationPreparer({...options,dataRoot:root}),
    archiveVerifier, productionEnabled:false, mode:"local-artifact-review" });
  runtime = installed;
  return () => { if (runtime === installed) runtime = undefined; };
}
