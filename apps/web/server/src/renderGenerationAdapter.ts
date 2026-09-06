import { createRenderGenerationBridge, type RenderBridgeOptions } from "./renderGenerationBridge.js";
import type { RenderGenerationPreparer } from "./jobs.js";

const KEY_MAP: Record<string, string> = {
  front_right: "white_a", back_left: "white_b", glb: "glb",
  front_right_card: "white_a_card", back_left_card: "white_b_card",
  front_right_ground: "white_a_ground", back_left_ground: "white_b_ground",
  front_right_set: "white_a_set", back_left_set: "white_b_set",
  front_right_ground_card: "white_a_ground_card", back_left_ground_card: "white_b_ground_card",
  front_right_set_card: "white_a_set_card", back_left_set_card: "white_b_set_card",
};

/** Constructed by a trusted host, not registered at startup until the runtime quality gate exists. */
export function createRenderGenerationPreparer(options: RenderBridgeOptions & { blenderExecutable: string }): RenderGenerationPreparer {
  const bridge = createRenderGenerationBridge(options);
  const blender = options.blenderExecutable;
  return async input => {
    const bytes = Buffer.from(input.bytes);
    const receipt = await bridge.verifyBytes({ jobRoot: input.jobRoot, bytes, mode: input.mode,
      studioAdjustment: input.studioAdjustment }, input.observer);
    return {
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
        const candidate = await bridge.render(receipt, execution.candidateDir, blender, input.observer);
        return {
          outputs: Object.entries(candidate.outputs).filter(([key]) => KEY_MAP[key]).map(([key, row]) => ({ key: KEY_MAP[key], path: row.path })),
          contract_sha256: execution.plan.identitySha256,
          plan_identity_sha256: execution.plan.identitySha256,
          source_generation_id: execution.sourceGenerationId,
          // Cannot turn a transport/basic decoder success into runtime quality approval.
          runtimeQuality: "unwired",
        };
      },
    };
  };
}
