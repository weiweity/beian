const PINS_KEY = "wb_review_pins";
const BOXES_KEY = "wb_review_boxes";
// v2 is a horizontal evidence desk. Do not reuse a persisted narrow size from
// the former two-column vertical dock.
const SIZE_KEY = "wb_review_dock_size_v2";
// v3 stores a viewport-relative top/left anchor. The former right-offset model
// coupled placement to the expanded width and created a false floor when the
// dock was collapsed.
const PLACE_KEY = "wb_review_dock_place_v3";

export type DockBox = { w: number; h: number };
export type DockPlace = { top: number; left: number };
export type DockHandle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

export const DOCK_MIN_W = 320;
export const DOCK_MIN_H = 280;
export const DOCK_DEFAULT_W = 900;
export const DOCK_DEFAULT_H = 480;
export const DOCK_SHUT_W = 168;
export const DOCK_SHUT_H = 48;
const DOCK_SIDE_GAP = 8;
/** Application-layer ordering: page < dock < controls opened from the dock < system modal. */
export const REVIEW_DOCK_LAYER = 950;
export const REVIEW_DOCK_POPUP_LAYER = 960;
/** 壳左右 20px。进核对页时窗默认叠在左侧栏上。 */
const DOCK_SHELL_PAD = 20;
/** 默认位置仍避开浏览器顶部，但用户可拖到视口内任何位置。 */
const DOCK_DEFAULT_TOP = 104;

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

export function clampDockBox(
  box: DockBox,
  room: { w: number; h: number },
): DockBox {
  const roomW = Math.round(Number(room.w) || DOCK_DEFAULT_W);
  const roomH = Math.round(Number(room.h) || DOCK_DEFAULT_H);
  const maxW = Math.max(DOCK_SHUT_W, roomW - DOCK_SIDE_GAP * 2);
  const maxH = Math.max(DOCK_SHUT_H, roomH - DOCK_SIDE_GAP * 2);
  const minW = Math.min(DOCK_MIN_W, maxW);
  const minH = Math.min(DOCK_MIN_H, maxH);
  const w = Number(box.w);
  const h = Number(box.h);
  return {
    w: Math.min(maxW, Math.max(minW, Number.isFinite(w) ? Math.round(w) : DOCK_DEFAULT_W)),
    h: Math.min(maxH, Math.max(minH, Number.isFinite(h) ? Math.round(h) : DOCK_DEFAULT_H)),
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

export function clampDockPlace(
  place: DockPlace,
  room: { w: number; h: number },
  box: DockBox,
): DockPlace {
  const maxLeft = Math.max(DOCK_SIDE_GAP, Math.round(Number(room.w) || 800) - box.w - DOCK_SIDE_GAP);
  const maxTop = Math.max(DOCK_SIDE_GAP, Math.round(Number(room.h) || 600) - box.h - DOCK_SIDE_GAP);
  const top = Number(place.top);
  const left = Number(place.left);
  return {
    top: Math.min(
      maxTop,
      Math.max(DOCK_SIDE_GAP, Number.isFinite(top) ? Math.round(top) : DOCK_DEFAULT_TOP),
    ),
    left: Math.min(
      maxLeft,
      Math.max(DOCK_SIDE_GAP, Number.isFinite(left) ? Math.round(left) : DOCK_SHELL_PAD),
    ),
  };
}

export function sidebarDockPlace(
  room: { w: number; h: number },
  box: DockBox,
  dockLeft = DOCK_SHELL_PAD,
  dockTop = DOCK_DEFAULT_TOP,
): DockPlace {
  const left = Math.max(DOCK_SIDE_GAP, Math.round(Number(dockLeft) || DOCK_SHELL_PAD));
  return clampDockPlace(
    {
      top: dockTop,
      left,
    },
    room,
    box,
  );
}

/** 收起时只改变可见尺寸，视口左上角锚点不变。 */
export function dockVisual(
  open: boolean,
  box: DockBox,
  place: DockPlace,
  room: { w: number; h: number },
): { box: DockBox; place: DockPlace } {
  const shownBox = open ? box : { w: DOCK_SHUT_W, h: DOCK_SHUT_H };
  return {
    box: shownBox,
    place: clampDockPlace(place, room, shownBox),
  };
}

/** Read only an explicit user placement. Missing/corrupt state stays null so a
 * first visit can use the sidebar-aligned default in the current viewport. */
export function readStoredDockPlace(storage: Pick<Storage, "getItem"> | null): DockPlace | null {
  try {
    const raw = storage?.getItem(PLACE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { top?: unknown; left?: unknown };
    const top = Number(parsed.top);
    const left = Number(parsed.left);
    if (!Number.isFinite(top) || !Number.isFinite(left)) return null;
    return { top, left };
  } catch {
    return null;
  }
}

export function writeDockPlace(storage: Pick<Storage, "setItem"> | null, place: DockPlace): void {
  try {
    storage?.setItem(PLACE_KEY, JSON.stringify({ top: place.top, left: place.left }));
  } catch {
    /* ignore quota */
  }
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
  let left = place.left;
  if (east) {
    w = start.w + delta.dx;
  }
  if (west) {
    w = start.w - delta.dx;
  }
  if (south) {
    h = start.h + delta.dy;
  }
  if (north) {
    h = start.h - delta.dy;
  }
  const box = clampDockBox({ w, h }, room);
  if (west) left = place.left + (start.w - box.w);
  if (north) top = place.top + (start.h - box.h);
  return { box, place: clampDockPlace({ top, left }, room, box) };
}

export function skipPackSheetField(field?: string): boolean {
  return /^(工艺说明|颜色要求|版本号|更新内容)($|[\s：:·])/.test(String(field || "").trim());
}
