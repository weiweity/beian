const DOCK_KEY = "wb_review_dock";
const PINS_KEY = "wb_review_pins";
const SIZE_KEY = "wb_review_dock_size";

export type DockBox = { w: number; h: number };

export const DOCK_MIN_W = 320;
export const DOCK_MIN_H = 280;
export const DOCK_DEFAULT_W = 560;
export const DOCK_DEFAULT_H = 520;

export function readDockOpen(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(DOCK_KEY) !== "shut";
  } catch {
    return true;
  }
}

export function writeDockOpen(storage: Pick<Storage, "setItem"> | null, open: boolean): void {
  try {
    storage?.setItem(DOCK_KEY, open ? "open" : "shut");
  } catch {
    /* ignore quota */
  }
}

export function readPinsOn(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(PINS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writePinsOn(storage: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    storage?.setItem(PINS_KEY, on ? "on" : "off");
  } catch {
    /* ignore quota */
  }
}

export function clampDockBox(box: DockBox, room: { w: number; h: number }): DockBox {
  const maxW = Math.max(DOCK_MIN_W, Math.round(Number(room.w) || DOCK_DEFAULT_W) - 24);
  const maxH = Math.max(DOCK_MIN_H, Math.round(Number(room.h) || DOCK_DEFAULT_H) - 24);
  const w = Number(box.w);
  const h = Number(box.h);
  return {
    w: Math.min(maxW, Math.max(DOCK_MIN_W, Number.isFinite(w) ? Math.round(w) : DOCK_DEFAULT_W)),
    h: Math.min(maxH, Math.max(DOCK_MIN_H, Number.isFinite(h) ? Math.round(h) : DOCK_DEFAULT_H)),
  };
}

export function readDockBox(storage: Pick<Storage, "getItem"> | null): DockBox {
  try {
    const raw = storage?.getItem(SIZE_KEY);
    if (!raw) return { w: DOCK_DEFAULT_W, h: DOCK_DEFAULT_H };
    const parsed = JSON.parse(raw) as { w?: unknown; h?: unknown };
    return clampDockBox(
      { w: Number(parsed.w), h: Number(parsed.h) },
      { w: 2400, h: 1800 },
    );
  } catch {
    return { w: DOCK_DEFAULT_W, h: DOCK_DEFAULT_H };
  }
}

export function writeDockBox(storage: Pick<Storage, "setItem"> | null, box: DockBox): void {
  try {
    storage?.setItem(SIZE_KEY, JSON.stringify({ w: box.w, h: box.h }));
  } catch {
    /* ignore quota */
  }
}

/** Top-right panel: drag the bottom-left corner. Left grows width, down grows height. */
export function resizeDockCorner(
  start: DockBox,
  delta: { dx: number; dy: number },
  room: { w: number; h: number },
): DockBox {
  return clampDockBox({ w: start.w - delta.dx, h: start.h + delta.dy }, room);
}
