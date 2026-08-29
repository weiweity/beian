import type { MockupJob } from "../api";

export type StructureNetProposal = NonNullable<MockupJob["structure_preview"]>["net_proposals"][number];
export type StructureAnchor = {
  proposal_id: string;
  front_face_id: string;
  quarter_turns: 0 | 1 | 2 | 3;
};

export function structureStatusLabel(job: Pick<MockupJob, "structure_status">): string | null {
  if (job.structure_status === "analyzing") return "识别结构";
  if (job.structure_status === "review_required") return "待确认结构";
  if (job.structure_status === "unsupported") return "结构暂不支持";
  return null;
}

export function structureIssueCopy(job: Pick<MockupJob, "structure_code" | "structure_message">): string {
  const message = String(job.structure_message || "").trim();
  if (job.structure_code === "structure_semantics_missing") {
    return "稿件里没有明确的 cut / crease 结构语义。请在 Illustrator 对象名、备注或图层上使用 packaging:cut 与 packaging:crease，再重新上传。";
  }
  if (job.structure_code === "structure_open_boundary") {
    return "刀线或折线存在断口，闭合后重新识别；系统不会自动补线。";
  }
  if (job.structure_code === "structure_multiple_components") {
    return "稿件里检测到多套结构，请只保留本次要打样的一套刀版。";
  }
  if (job.structure_code === "structure_units_ambiguous") {
    return "结构单位不明确，请确认使用 mm、pt 或 inch 后重新导出。";
  }
  return message || "包装结构需要人工确认后才能进入 Blender。";
}

export function selectedStructureAnchor(
  proposal: StructureNetProposal | undefined,
  frontFaceId: string,
  quarterTurns: 0 | 1 | 2 | 3,
): StructureAnchor | null {
  if (!proposal || !proposal.body_face_ids.includes(frontFaceId)) return null;
  return {
    proposal_id: proposal.id,
    front_face_id: frontFaceId,
    quarter_turns: quarterTurns,
  };
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
