export type ZoomState = { scale: number; x: number; y: number };

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 6;

export function resetZoom(): ZoomState {
  return { scale: 1, x: 0, y: 0 };
}

export function clampScale(s: number): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

/** Zoom toward a point in view pixels (origin = canvas top-left). Keep pan at 1x. */
export function zoomAt(state: ZoomState, nextScale: number, originX: number, originY: number): ZoomState {
  const scale = clampScale(nextScale);
  if (scale <= ZOOM_MIN) return { scale: ZOOM_MIN, x: state.x, y: state.y };
  const k = scale / (state.scale || 1);
  return {
    scale,
    x: originX - (originX - state.x) * k,
    y: originY - (originY - state.y) * k,
  };
}

export function panBy(state: ZoomState, dx: number, dy: number): ZoomState {
  return { scale: state.scale, x: state.x + dx, y: state.y + dy };
}

export function zoomCss(state: ZoomState): string {
  return `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
}

export type PixelBox = { left: number; top: number; width: number; height: number };

/** Contain the page in the view and park it on the right (empty left for the dock). */
export function fittedPage(
  page: { width: number; height: number },
  view: { width: number; height: number },
): { imgW: number; imgH: number; offsetX: number; offsetY: number } {
  const pw = Number(page.width);
  const ph = Number(page.height);
  const vw = Number(view.width);
  const vh = Number(view.height);
  if (!(pw > 1) || !(ph > 1) || !(vw > 1) || !(vh > 1)) {
    return { imgW: 0, imgH: 0, offsetX: 0, offsetY: 0 };
  }
  const fit = Math.min(vw / pw, vh / ph);
  const imgW = pw * fit;
  const imgH = ph * fit;
  return { imgW, imgH, offsetX: Math.max(0, vw - imgW), offsetY: Math.max(0, (vh - imgH) / 2) };
}

/** Fit a page-pixel box into the visible canvas (~62% of the view). */
export function zoomToBox(
  box: PixelBox,
  page: { width: number; height: number },
  view: { width: number; height: number },
  fit = 0.62,
): ZoomState {
  const pw = Number(page.width);
  const ph = Number(page.height);
  const vw = Number(view.width);
  const vh = Number(view.height);
  if (!(pw > 1) || !(ph > 1) || !(vw > 1) || !(vh > 1)) return resetZoom();
  const laid = fittedPage(page, view);
  const boxW = Math.max((Number(box.width) / pw) * laid.imgW, 8);
  const boxH = Math.max((Number(box.height) / ph) * laid.imgH, 8);
  const cx = (Number(box.left) + Number(box.width) / 2) / pw * laid.imgW;
  const cy = (Number(box.top) + Number(box.height) / 2) / ph * laid.imgH;
  const scale = clampScale(Math.min((vw * fit) / boxW, (vh * fit) / boxH));
  return {
    scale,
    x: vw / 2 - laid.offsetX - cx * scale,
    y: vh / 2 - laid.offsetY - cy * scale,
  };
}
