import { createRenderGenerationBridge, RENDER_GENERATION_OUTPUT_KEYS as KEY_MAP, type RenderBridgeOptions } from "./renderGenerationBridge.js";
import type { RenderGenerationPreparer } from "./jobs.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRenderLifecycle } from "./renderGenerationBudget.js";

/** Constructed by a trusted host, not registered at startup until the runtime quality gate exists. */
export function createRenderGenerationPreparer(options: RenderBridgeOptions & {
  blenderExecutable: string; resourcePolicy?: { diskBytes?: number; memoryBytes?: number };
}): RenderGenerationPreparer {
  const bridge = createRenderGenerationBridge(options);
  const blender = options.blenderExecutable;
  return async input => {
    const bytes = Buffer.from(input.bytes);
    await bridge.assertJobRoot(input.jobRoot);
    const root = join(input.jobRoot, ".render-generations");
    mkdirSync(root, { recursive: true });
    const lifecycle = createRenderLifecycle({ root, mutationId: input.mutationId,
      timeoutMs: options.timeoutMs ?? 1_260_000, signal: input.observer.signal, ...options.resourcePolicy });
    let owned = false;
    const observer = { ...input.observer, lifecycle,
      onSpawn: (pid: number, id: string) => { owned = true; input.observer.onSpawn?.(pid, id); },
      onClose: (pid: number, id: string) => { input.observer.onClose?.(pid, id); owned = false; },
    };
    let receipt;
    try {
      receipt = await bridge.verifyBytes({ jobRoot: input.jobRoot, bytes, mode: input.mode,
        studioAdjustment: input.studioAdjustment }, observer);
    } catch (error) { lifecycle.release(!owned); throw error; }
    return {
      lifecycle,
      plan: {
        bytes, identitySha256: receipt.sourceSha256.slice(7), profile: receipt.profile,
        verifier: "rf02-candidate-cli",
        sourceAssets: receipt.sourceAssets.map((row, index) => ({
          ...row, key: ["front", "right", "back", "left", "top", "bottom"][index], sha256: row.sha256.slice(7),
        })),
      },
      execute: async execution => {
        // The capability is for exactly the already-verified job, mode and bytes.
        if (execution.jobId !== input.jobId || execution.mutationId !== input.mutationId
          || execution.jobRoot !== input.jobRoot || execution.mode !== input.mode
          || !execution.plan.bytes.equals(bytes) || execution.plan.identitySha256 !== receipt.sourceSha256.slice(7)
          || JSON.stringify(execution.studioAdjustment) !== JSON.stringify(input.studioAdjustment)) {
          throw new Error("候选执行快照与验证凭证不符");
        }
        const candidate = await bridge.render(receipt, execution.candidateDir, blender, observer);
        return {
          outputs: Object.entries(candidate.outputs).filter(([key]) => KEY_MAP[key]).map(([key, row]) => ({ key: KEY_MAP[key], path: row.path })),
          contract_sha256: execution.plan.identitySha256,
          plan_identity_sha256: execution.plan.identitySha256,
          source_generation_id: execution.sourceGenerationId,
          // Minted only after actual artifact gates, resource monitoring and
          // owned-tree exit; store consumes it against its own copied bytes.
          runtimeQuality: "verified",
          qualityVerifier: bridge.createRuntimeSealVerifier(candidate),
        };
      },
    };
  };
}
