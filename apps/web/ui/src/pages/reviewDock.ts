const DOCK_KEY = "wb_review_dock";
const PINS_KEY = "wb_review_pins";
const BOXES_KEY = "wb_review_boxes";
const SIZE_KEY = "wb_review_dock_size";
const PLACE_KEY = "wb_review_dock_place";

export type DockBox = { w: number; h: number };
export type DockPlace = { top: number; right: number };
export type DockHandle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

export const DOCK_MIN_W = 320;
export const DOCK_MIN_H = 280;
export const DOCK_DEFAULT_W = 560;
export const DOCK_DEFAULT_H = 520;
export const DOCK_SHUT_W = 168;
export const DOCK_SHUT_H = 48;
export const DOCK_SIDE_GAP = 8;
/** 壳左右 20px。进核对页时窗叠在左侧栏上，不盖右边签字。 */
export const DOCK_SHELL_PAD = 20;
/** 钉钉/飞书检视栏：portal 到 body 后相对视口。壳 20 + 主区 24 + 页头，不盖签字。 */
export const DOCK_BELOW_HEAD = 104;

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

export function readBoxesOn(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(BOXES_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeBoxesOn(storage: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    storage?.setItem(BOXES_KEY, on ? "on" : "off");
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

export type ScreenRect = { left: number; top: number; width: number; height: number };
export type DockInset = { left: number; top: number; right: number; bottom: number };

/** How much the floating dock covers the canvas. Overlap math only — the page image is not padded. */
export function dockCanvasInset(canvas: ScreenRect, dock: ScreenRect): DockInset {
  const out: DockInset = { left: 0, top: 0, right: 0, bottom: 0 };
  const cL = Number(canvas.left) || 0;
  const cT = Number(canvas.top) || 0;
  const cR = cL + Math.max(0, Number(canvas.width) || 0);
  const cB = cT + Math.max(0, Number(canvas.height) || 0);
  const dL = Number(dock.left) || 0;
  const dT = Number(dock.top) || 0;
  const dR = dL + Math.max(0, Number(dock.width) || 0);
  const dB = dT + Math.max(0, Number(dock.height) || 0);
  if (dR <= cL || dL >= cR || dB <= cT || dT >= cB) return out;
  const dockCx = (dL + dR) / 2;
  const canvasCx = (cL + cR) / 2;
  if (dockCx <= canvasCx) out.left = Math.max(0, Math.round(Math.min(dR, cR) - cL));
  else out.right = Math.max(0, Math.round(cR - Math.max(dL, cL)));
  return out;
}

export function rectsOverlap(a: ScreenRect, b: ScreenRect): boolean {
  const aR = a.left + a.width;
  const aB = a.top + a.height;
  const bR = b.left + b.width;
  const bB = b.top + b.height;
  return a.left < bR && aR > b.left && a.top < bB && aB > b.top;
}

export function clampDockPlace(place: DockPlace, room: { w: number; h: number }, box: DockBox): DockPlace {
  const maxRight = Math.max(8, Math.round(Number(room.w) || 800) - box.w - 8);
  const maxTop = Math.max(8, Math.round(Number(room.h) || 600) - box.h - 8);
  const minTop = Math.min(DOCK_BELOW_HEAD, maxTop);
  const top = Number(place.top);
  const right = Number(place.right);
  return {
    top: Math.min(maxTop, Math.max(minTop, Number.isFinite(top) ? Math.round(top) : DOCK_BELOW_HEAD)),
    right: Math.min(maxRight, Math.max(8, Number.isFinite(right) ? Math.round(right) : 8)),
  };
}

export function sidebarDockPlace(
  room: { w: number; h: number },
  box: DockBox,
  dockLeft = DOCK_SHELL_PAD,
): DockPlace {
  const left = Math.max(DOCK_SIDE_GAP, Math.round(Number(dockLeft) || DOCK_SHELL_PAD));
  return clampDockPlace(
    {
      top: DOCK_BELOW_HEAD,
      right: Math.round(Number(room.w) || 800) - box.w - left,
    },
    room,
    box,
  );
}

/** 收起时高度收到工具条，左边不动（叠在侧栏上往里收）。 */
export function dockVisual(
  open: boolean,
  box: DockBox,
  place: DockPlace,
  room: { w: number; h: number },
): { box: DockBox; place: DockPlace } {
  if (open) return { box, place };
  const left = Math.round(Number(room.w) || 800) - place.right - box.w;
  const shutBox = { w: DOCK_SHUT_W, h: DOCK_SHUT_H };
  return {
    box: shutBox,
    place: clampDockPlace(
      {
        top: place.top,
        right: Math.round(Number(room.w) || 800) - left - shutBox.w,
      },
      room,
      shutBox,
    ),
  };
}

export function readDockPlace(storage: Pick<Storage, "getItem"> | null): DockPlace {
  const fallback = sidebarDockPlace(
    { w: 2400, h: 1800 },
    { w: DOCK_DEFAULT_W, h: DOCK_DEFAULT_H },
  );
  try {
    const raw = storage?.getItem(PLACE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { top?: unknown; right?: unknown };
    return clampDockPlace(
      { top: Number(parsed.top), right: Number(parsed.right) },
      { w: 2400, h: 1800 },
      { w: DOCK_DEFAULT_W, h: DOCK_DEFAULT_H },
    );
  } catch {
    return fallback;
  }
}

export function writeDockPlace(storage: Pick<Storage, "setItem"> | null, place: DockPlace): void {
  try {
    storage?.setItem(PLACE_KEY, JSON.stringify({ top: place.top, right: place.right }));
  } catch {
    /* ignore quota */
  }
}

/** Grow the named edge/corner. dx right, dy down. Panel is top/right anchored. */
export function resizeDockCorner(
  start: DockBox,
  delta: { dx: number; dy: number },
  room: { w: number; h: number },
  corner: DockHandle = "sw",
): DockBox {
  return resizeDockHandle(start, { top: DOCK_BELOW_HEAD, right: 8 }, delta, room, corner).box;
}

export function resizeDockHandle(
  start: DockBox,
  place: DockPlace,
  delta: { dx: number; dy: number },
  room: { w: number; h: number },
  handle: DockHandle = "sw",
): { box: DockBox; place: DockPlace } {
  const east = handle === "e" || handle === "ne" || handle === "se";
  const west = handle === "w" || handle === "nw" || handle === "sw";
  const north = handle === "n" || handle === "ne" || handle === "nw";
  const south = handle === "s" || handle === "se" || handle === "sw";
  let w = start.w;
  let h = start.h;
  let top = place.top;
  let right = place.right;
  if (east) {
    w = start.w + delta.dx;
    right = place.right - delta.dx;
  }
  if (west) {
    w = start.w - delta.dx;
  }
  if (south) {
    h = start.h + delta.dy;
  }
  if (north) {
    h = start.h - delta.dy;
    top = place.top + delta.dy;
  }
  const box = clampDockBox({ w, h }, room);
  return { box, place: clampDockPlace({ top, right }, room, box) };
}

export function skipPackSheetField(field?: string): boolean {
  return /^(工艺说明|颜色要求|版本号)($|[\s：:·])/.test(String(field || "").trim());
}
