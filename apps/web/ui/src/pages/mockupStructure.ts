import { ApiError, type MockupJob } from "../api";

export type StructureNetProposal = NonNullable<MockupJob["structure_preview"]>["net_proposals"][number];
export type StructureInput = NonNullable<MockupJob["structure_input"]>;
export type StructureAnchor = {
  proposal_id: string;
  front_face_id: string;
  quarter_turns: 0 | 1 | 2 | 3;
};

type IllustratorPreviewPath = NonNullable<StructureInput["preview"]>["layers"][number]["paths"][number];

function svgNumber(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function samePreviewPoint(left: number[], leftOffset: number, right: number[], rightOffset: number): boolean {
  return Math.abs(left[leftOffset] - right[rightOffset]) <= 0.001
    && Math.abs(left[leftOffset + 1] - right[rightOffset + 1]) <= 0.001;
}

export function illustratorPreviewPathD(path: IllustratorPreviewPath): string {
  if (path.points.length < 2) return "";
  const first = path.points[0];
  const commands = [`M ${svgNumber(first[0])} ${svgNumber(first[1])}`];
  const segmentCount = path.closed ? path.points.length : path.points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const current = path.points[index];
    const next = path.points[(index + 1) % path.points.length];
    if (samePreviewPoint(current, 0, current, 4) && samePreviewPoint(next, 0, next, 2)) {
      commands.push(`L ${svgNumber(next[0])} ${svgNumber(next[1])}`);
    } else {
      commands.push(
        `C ${svgNumber(current[4])} ${svgNumber(current[5])} ${svgNumber(next[2])} ${svgNumber(next[3])} ${svgNumber(next[0])} ${svgNumber(next[1])}`,
      );
    }
  }
  if (path.closed) commands.push("Z");
  return commands.join(" ");
}

export function illustratorLayerPreviewD(paths: IllustratorPreviewPath[]): string {
  return paths.map(illustratorPreviewPathD).filter(Boolean).join(" ");
}

export function selectedStructureLayerIds(input: StructureInput, selectedIds: string[]): string[] {
  const selected = new Set(selectedIds);
  return input.proposal_layers
    .filter((candidate) => selected.has(candidate.id))
    .slice(0, 16)
    .map((candidate) => candidate.id);
}

function uniqueProposalLayerByName(input: StructureInput, name: string) {
  const hits = input.proposal_layers.filter((candidate) => candidate.name === name);
  return hits.length === 1 ? hits[0] : undefined;
}

function uniqueFactoryKnifeLayer(input: StructureInput) {
  const knives = input.proposal_layers.filter((candidate) => candidate.name === "刀版" || candidate.name === "刀线");
  const names = new Set(knives.map((candidate) => candidate.name));
  if (names.size !== 1 || knives.length !== 1) return undefined;
  return knives[0];
}

export function defaultStructureLayerIds(input: StructureInput): string[] {
  if (input.selected_ids.length) return selectedStructureLayerIds(input, input.selected_ids);
  const cut = uniqueProposalLayerByName(input, "上刀线") || uniqueFactoryKnifeLayer(input);
  const print = uniqueProposalLayerByName(input, "印刷");
  const ids: string[] = [];
  if (cut) ids.push(cut.id);
  if (cut && print) ids.push(print.id);
  return selectedStructureLayerIds(input, ids);
}

export function shouldAutoSubmitStructureLayers(input: StructureInput): boolean {
  if (input.selected_ids.length) return false;
  if (!defaultStructureLayerIds(input).length) return false;
  return Boolean(uniqueProposalLayerByName(input, "上刀线")) || input.proposal_layers.length === 1;
}

export function sameStructureLayerSelection(input: StructureInput, selectedIds: string[]): boolean {
  const normalized = selectedStructureLayerIds(input, selectedIds);
  return normalized.length === input.selected_ids.length
    && normalized.every((id, index) => id === input.selected_ids[index]);
}

export function structureStatusLabel(job: Pick<MockupJob, "structure_status" | "structure_code">): string | null {
  if (job.structure_status === "analyzing") return "正在出图";
  if (job.structure_status === "review_required") {
    return job.structure_code === "structure_face_mapping_incomplete" ? "待选正面" : "打样失败";
  }
  if (job.structure_status === "unsupported") return "结构暂不支持";
  return null;
}

export function structureIssueCopy(
  job: Pick<MockupJob, "structure_code" | "structure_message">,
  view: { desk?: boolean } = {},
): string {
  const message = String(job.structure_message || "").trim();
  const desk = view.desk === true;
  if (job.structure_code === "structure_semantics_missing") {
    return desk
      ? "稿件里没有可自动识别的刀版。请勾选「刀版」或「刀线」后重新识别；表、标注、印刷不要当结构层。"
      : "打样失败。稿件里没有可自动识别的刀版。";
  }
  if (job.structure_code === "structure_flattened_artwork") {
    return "当前不支持（拼合稿）。请用还留着印刷/刀版分层的源稿重新打样，不要只交「图层 1」。";
  }
  if (job.structure_code === "structure_category_unsupported") {
    return message || "当前不支持这类包装。打样台只做花盒展开图，膜袋、内包和标贴请不要送进来。";
  }
  if (job.structure_code === "structure_open_boundary") {
    return "刀线或折线存在断口，闭合后重新识别；系统不会自动补线。";
  }
  if (job.structure_code === "structure_multiple_components") {
    return desk
      ? "稿件里检测到多套可成盒结构，请选择需要打样的完整盒型；若列表中没有外盒，请只保留正确刀版后重新上传。"
      : "打样失败。稿件里有多套盒型，当前不能自动选。";
  }
  if (job.structure_code === "structure_units_ambiguous") {
    return "结构单位不明确，请确认使用 mm、pt 或 inch 后重新导出。";
  }
  if (job.structure_code === "structure_box_net_missing") {
    return desk
      ? "这组线组不成花盒。只留刀版或刀线再识别；系统不会按颜色或白色区域猜外盒。"
      : "打样失败。这组刀线不是一个完整花盒。";
  }
  if (job.structure_code === "structure_limit_exceeded" || job.structure_code === "structure_curve_complexity_exceeded") {
    return "结构线数量或曲线复杂度超过安全上限。请在 Illustrator 中只保留本次刀版的结构线并简化异常路径后重新上传。";
  }
  if (job.structure_code === "structure_confirmation_stale" || job.structure_code === "structure_source_mismatch") {
    return "结构候选已随源稿或识别版本更新，请刷新本单后重新选择。";
  }
  return message || (desk ? "包装结构需要人工确认后才能进入 Blender。" : "这张稿现在打不了样。");
}

export function structureConfirmationErrorCopy(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : "结构确认失败，请检查后重试";
  }
  if (error.code === "structure_confirmation_stale" || error.code === "structure_source_mismatch") {
    return "结构候选已更新，请刷新本单后重新选择正面。";
  }
  if (error.code === "structure_fold_graph_invalid") {
    return "这套盒型不能形成连续折叠关系，请整理真实刀线和折线后重新上传。";
  }
  if (error.code === "artwork_transform_invalid" || error.code === "structure_confirmation_invalid") {
    return "当前正面未通过成盒预检，请重新选择页面仍可用的正面。";
  }
  return error.message || "结构确认失败，请检查后重试";
}

export function selectedStructureAnchor(
  proposal: StructureNetProposal | undefined,
  frontFaceId: string,
  quarterTurns: 0 | 1 | 2 | 3,
): StructureAnchor | null {
  if (!proposal || !proposal.body_face_ids.includes(frontFaceId)) return null;
  const valid = validTurnsForFace(proposal, frontFaceId);
  if (!valid.includes(quarterTurns)) return null;
  return {
    proposal_id: proposal.id,
    front_face_id: frontFaceId,
    quarter_turns: quarterTurns,
  };
}

export function validTurnsForFace(
  proposal: StructureNetProposal | undefined,
  frontFaceId: string,
): Array<0 | 1 | 2 | 3> {
  if (!proposal || !proposal.body_face_ids.includes(frontFaceId)) return [];
  if (!proposal.valid_anchors) return [];
  return proposal.valid_anchors.find((item) => item.front_face_id === frontFaceId)?.quarter_turns || [];
}

export function preferredStructureTurn(
  proposal: StructureNetProposal | undefined,
  frontFaceId: string,
): 0 | 1 | 2 | 3 | null {
  const valid = validTurnsForFace(proposal, frontFaceId);
  if (!valid.length) return null;
  const preferred = proposal?.valid_anchors?.find(
    (item) => item.front_face_id === frontFaceId,
  )?.preferred_quarter_turns;
  return preferred !== undefined && valid.includes(preferred) ? preferred : null;
}

export function structureProposalHasRealPolygons(
  proposal: StructureNetProposal,
  faces: NonNullable<MockupJob["structure_preview"]>["faces"],
): boolean {
  const polygonFaceIds = new Set(
    faces
      .filter((face) => (
        Array.isArray(face.points_mm)
        && face.points_mm.length >= 3
        && face.points_mm.every((point) => point.every(Number.isFinite))
      ))
      .map((face) => face.id),
  );
  return proposal.face_ids.every((faceId) => polygonFaceIds.has(faceId));
}

export function structureViewBox(
  faces: NonNullable<MockupJob["structure_preview"]>["faces"],
): [number, number, number, number] {
  if (!faces.length) return [0, 0, 1, 1];
  const left = Math.min(...faces.map((face) => face.bounds_mm[0]));
  const top = Math.min(...faces.map((face) => face.bounds_mm[1]));
  const right = Math.max(...faces.map((face) => face.bounds_mm[2]));
  const bottom = Math.max(...faces.map((face) => face.bounds_mm[3]));
  const pad = Math.max(2, Math.max(right - left, bottom - top) * 0.04);
  return [left - pad, top - pad, Math.max(1, right - left + 2 * pad), Math.max(1, bottom - top + 2 * pad)];
}

export function structurePolygonPoints(
  face: NonNullable<MockupJob["structure_preview"]>["faces"][number],
): string | null {
  if (!face.points_mm?.length) return null;
  return face.points_mm.map(([x, y]) => `${x},${y}`).join(" ");
}
