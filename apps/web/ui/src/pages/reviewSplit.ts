const KEY = "wb_review_split";

export const DEFAULT_RIGHT = 400;
export const MIN_RIGHT = 280;
export const MIN_LEFT = 240;

export function clampRight(right: number, total: number): number {
  const t = Number(total);
  const maxRight = Number.isFinite(t) && t > 0 ? Math.max(MIN_RIGHT, t - MIN_LEFT) : DEFAULT_RIGHT;
  const n = Number(right);
  if (!Number.isFinite(n)) return Math.min(maxRight, DEFAULT_RIGHT);
  return Math.min(maxRight, Math.max(MIN_RIGHT, Math.round(n)));
}

export function readSplit(storage: Pick<Storage, "getItem"> | null, total: number): number {
  try {
    const raw = Number(storage?.getItem(KEY));
    if (!Number.isFinite(raw) || raw <= 0) return clampRight(DEFAULT_RIGHT, total);
    return clampRight(raw, total);
  } catch {
    return clampRight(DEFAULT_RIGHT, total);
  }
}

export function writeSplit(storage: Pick<Storage, "setItem"> | null, right: number): void {
  try {
    storage?.setItem(KEY, String(right));
  } catch {
    /* ignore quota */
  }
}
