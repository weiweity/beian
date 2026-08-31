/** 核对页框：OCR 像素 bbox 叠到页图上。页宽高 ≤1 不画，也不编造顶排钉。 */

export type OverlayBox = {
  left: string;
  top: string;
  width: string;
  height: string;
  pinLeft: string;
  pinTop: string;
  kind: "hit" | "warn";
};

export type PageMetrics = { width: number; height: number };

export type PixelBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  role: string;
  page: number;
};

export function resolvePageMetrics(
  page?: { width?: number; height?: number } | null,
  natural?: { width: number; height: number } | null,
): PageMetrics | null {
  const fromPageW = Number(page?.width);
  const fromPageH = Number(page?.height);
  const w = fromPageW > 1 ? fromPageW : Number(natural?.width) || 0;
  const h = fromPageH > 1 ? fromPageH : Number(natural?.height) || 0;
  if (!(w > 1) || !(h > 1)) return null;
  return { width: w, height: h };
}

export function hitOnPage(hit: { page?: number | string }, pageNo: number): boolean {
  const p = Number(hit.page);
  const n = Number(pageNo);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (!Number.isFinite(n) || n <= 0) return false;
  return p === n;
}

export type PinHitGroup<T> = { h: T; i: number; indices: number[] };

/** 只亮当前字段（含双语共钉）。全页淡钉已废。 */
export function visiblePinGroups<T>(
  groups: Array<PinHitGroup<T>>,
  active: number,
): Array<PinHitGroup<T>> {
  if (!Number.isFinite(active) || active < 0) return [];
  return groups.filter((g) => g.indices.includes(active));
}

function boxAreaRatio(box: PixelBox, page: PageMetrics): number {
  if (!(page.width > 1) || !(page.height > 1)) return 0;
  return (Math.max(box.width, 0) * Math.max(box.height, 0)) / (page.width * page.height);
}

export function boxTooLarge(box: PixelBox, page: PageMetrics, ratio = 0.3): boolean {
  return boxAreaRatio(box, page) >= ratio;
}

function pct(n: number): string {
  const clamped = Math.min(100, Math.max(0, n));
  return `${clamped}%`;
}

/** 中英文品名可共享同一个联合框；保留两条审核字段，只在画布上画一个钉。 */
export function pinHitGroupsForPage<
  T extends { page?: number | string; bilingual_pair_id?: string },
>(hits: T[], pageNo: number): Array<PinHitGroup<T>> {
  const out: Array<PinHitGroup<T>> = [];
  const pairIndex = new Map<string, number>();
  hits.forEach((h, i) => {
    if (!hitOnPage(h, pageNo)) return;
    const pairId = String(h.bilingual_pair_id || "").trim();
    const existing = pairId ? pairIndex.get(pairId) : undefined;
    if (existing != null) {
      out[existing].indices.push(i);
      return;
    }
    if (pairId) pairIndex.set(pairId, out.length);
    out.push({ h, i, indices: [i] });
  });
  return out;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function boxPixels(b: Record<string, unknown> | null | undefined): PixelBox | null {
  if (!b || typeof b !== "object") return null;
  const left = num(b.left ?? b.x);
  const top = num(b.top ?? b.y);
  const width = num(b.width);
  const height = num(b.height);
  if (width <= 0 && height <= 0 && left === 0 && top === 0) return null;
  if (width < 0 || height < 0) return null;
  return {
    left,
    top,
    width,
    height,
    role: String(b.role || ""),
    page: num(b.page),
  };
}

const ROLE_RANK: Record<string, number> = {
  check: 0,
  miss_anchor: 1,
  hit: 2,
};

export function pickHitBox(
  bboxes: Array<Record<string, unknown>> | undefined,
  pageNo: number,
  page?: PageMetrics | null,
): PixelBox | null {
  const boxes = (bboxes || [])
    .map(boxPixels)
    .filter((b): b is PixelBox => {
      if (!b) return false;
      if (b.page && pageNo && b.page !== pageNo) return false;
      if (page && boxTooLarge(b, page)) return false;
      return true;
    });
  if (!boxes.length) return null;
  boxes.sort((a, b) => (ROLE_RANK[a.role] ?? 8) - (ROLE_RANK[b.role] ?? 8));
  return boxes[0];
}

export function overlayFromBox(box: PixelBox, page: PageMetrics): OverlayBox | null {
  if (page.width <= 1 || page.height <= 1) return null;
  const w = Math.max(box.width, 8);
  const h = Math.max(box.height, 8);
  const cx = box.left + (box.width > 0 ? box.width / 2 : 0);
  const cy = box.top + (box.height > 0 ? box.height / 2 : 0);
  const kind = box.role === "check" || box.role === "miss_anchor" ? "warn" : "hit";
  return {
    left: pct((box.left / page.width) * 100),
    top: pct((box.top / page.height) * 100),
    width: pct((w / page.width) * 100),
    height: pct((h / page.height) * 100),
    pinLeft: pct((cx / page.width) * 100),
    pinTop: pct((cy / page.height) * 100),
    kind,
  };
}

/** 引导语框 + 码图框。码图只作定位，不改结论。 */
export function locateBoxesForHit(hit: {
  bboxes?: Array<Record<string, unknown>>;
  qrcode_boxes?: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  const extra = (hit.qrcode_boxes || []).map((box) => ({ ...box, role: box.role || "hit" }));
  return [...(hit.bboxes || []), ...extra];
}

export function overlaysForHit(
  bboxes: Array<Record<string, unknown>> | undefined,
  pageNo: number,
  page: PageMetrics | null,
): OverlayBox[] {
  if (!page) return [];
  const out: OverlayBox[] = [];
  for (const raw of bboxes || []) {
    const box = boxPixels(raw);
    if (!box) continue;
    if (box.page && pageNo && box.page !== pageNo) continue;
    if (boxTooLarge(box, page)) continue;
    const ov = overlayFromBox(box, page);
    if (ov) out.push(ov);
  }
  return out;
}
