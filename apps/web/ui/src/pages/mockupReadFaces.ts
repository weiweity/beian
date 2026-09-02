const READ_FACE_ROLES = ["front", "back", "right", "left", "top", "bottom"] as const;
export type ReadFaceRole = (typeof READ_FACE_ROLES)[number];

export const READ_FACE_LABEL: Record<ReadFaceRole, string> = {
  front: "正面",
  back: "反面",
  right: "右侧",
  left: "左侧",
  top: "顶部",
  bottom: "底部",
};

export function readFaceKey(role: ReadFaceRole): `read_${ReadFaceRole}` {
  return `read_${role}`;
}

export function listedReadFaces(files: Array<{ key: string }>): ReadFaceRole[] {
  const keys = new Set(files.map((file) => file.key));
  return READ_FACE_ROLES.filter((role) => keys.has(readFaceKey(role)));
}
