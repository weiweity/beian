export const STUDIO_LIGHT_MIN = 0.6;
export const STUDIO_LIGHT_MAX = 1.4;
export const STUDIO_LIGHT_DEFAULT = 1;
export const STUDIO_GROUND_FILL = "rgb(228, 228, 232)";
export const BACKDROP_PRESETS = ["white", "silver", "white_set"] as const;
export type BackdropPreset = (typeof BACKDROP_PRESETS)[number];
export const BACKDROP_DEFAULT: BackdropPreset = "white_set";
export const BACKDROP_LABEL: Record<BackdropPreset, string> = {
  white: "白底",
  silver: "银底",
  white_set: "白桌白墙",
};
const BACKDROP_STORAGE_KEY = "beian.mockup.backdrop";
const WHITE_SET_HORIZON = 0.58;

export function clampStudioLight(value: number): number {
  if (!Number.isFinite(value)) return STUDIO_LIGHT_DEFAULT;
  return Math.min(STUDIO_LIGHT_MAX, Math.max(STUDIO_LIGHT_MIN, value));
}

export function stillsFilter(light: number): string {
  const next = clampStudioLight(light);
  return `contrast(1.04) brightness(${next})`;
}

export function glbExposure(light: number): string {
  return String(Math.round(0.9 * clampStudioLight(light) * 100) / 100);
}

export function parseBackdropPreset(value: unknown): BackdropPreset {
  return value === "white" || value === "silver" || value === "white_set" ? value : BACKDROP_DEFAULT;
}

export function readBackdropPreset(): BackdropPreset {
  try {
    if (typeof localStorage === "undefined") return BACKDROP_DEFAULT;
    return parseBackdropPreset(localStorage.getItem(BACKDROP_STORAGE_KEY));
  } catch {
    return BACKDROP_DEFAULT;
  }
}

export function writeBackdropPreset(preset: BackdropPreset): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(BACKDROP_STORAGE_KEY, preset);
  } catch {
    /* quota / private mode */
  }
}

export function usesContactShadow(preset: BackdropPreset): boolean {
  return preset === "white_set";
}

export function backdropFrameClass(preset: BackdropPreset): string {
  if (preset === "silver") return "is-backdrop-silver";
  if (preset === "white_set") return "is-backdrop-white-set";
  return "is-backdrop-white";
}

function litChannel(base: number, light: number): number {
  return Math.round(Math.min(255, Math.max(0, base * clampStudioLight(light))));
}

function silverFill(light: number): string {
  return `rgb(${litChannel(196, light)}, ${litChannel(201, light)}, ${litChannel(208, light)})`;
}

function whiteSetWallFill(light: number): string {
  return `rgb(${litChannel(238, light)}, ${litChannel(238, light)}, ${litChannel(236, light)})`;
}

/** 白底默认约 RGB 238，给白盒留层次；滑条仍能加到接近白。银底浅银。白桌白墙用台面灰，墙面另画。 */
export function studioBackdrop(light: number, preset: BackdropPreset = "white"): string {
  if (preset === "silver") return silverFill(light);
  if (preset === "white_set") {
    return `rgb(${litChannel(228, light)}, ${litChannel(228, light)}, ${litChannel(232, light)})`;
  }
  return `rgb(${litChannel(238, light)}, ${litChannel(238, light)}, ${litChannel(238, light)})`;
}

function paintStudioSet(
  ctx: CanvasRenderingContext2D,
  destW: number,
  destH: number,
  preset: BackdropPreset,
  backgroundLight: number,
): void {
  ctx.fillStyle = studioBackdrop(backgroundLight, preset);
  ctx.fillRect(0, 0, destW, destH);
  if (preset !== "white_set" || destH <= 0) return;
  const horizon = Math.round(destH * WHITE_SET_HORIZON);
  ctx.fillStyle = whiteSetWallFill(backgroundLight);
  ctx.fillRect(0, 0, destW, horizon);
  ctx.fillStyle = "rgba(40, 24, 56, 0.12)";
  ctx.fillRect(0, horizon, destW, Math.max(1, Math.round(destH * 0.004)));
}

export function jobHasGround(files: Array<{ key: string }> | undefined): boolean {
  return (files || []).some((file) => file.key === "white_a_ground" || file.key === "white_b_ground");
}

export type StudioStillKey =
  | "white_a"
  | "white_b"
  | "white_a_ground"
  | "white_b_ground"
  | "white_a_set"
  | "white_b_set";

export function stillSetKey(fileKey: "white_a" | "white_b"): "white_a_set" | "white_b_set" {
  return fileKey === "white_a" ? "white_a_set" : "white_b_set";
}

export function jobHasSet(
  files: Array<{ key: string }> | undefined,
  fileKey: "white_a" | "white_b",
): boolean {
  const key = stillSetKey(fileKey);
  return (files || []).some((file) => file.key === key);
}

export function reviewCardKey(key: StudioStillKey): string {
  return `${key}_card`;
}

export function jobHasReviewCard(
  files: Array<{ key: string }> | undefined,
  key: StudioStillKey,
): boolean {
  const card = reviewCardKey(key);
  return (files || []).some((file) => file.key === card);
}

export function containRect(
  destW: number,
  destH: number,
  srcW: number,
  srcH: number,
): { x: number; y: number; w: number; h: number } {
  if (srcW <= 0 || srcH <= 0 || destW <= 0 || destH <= 0) {
    return { x: 0, y: 0, w: destW, h: destH };
  }
  const scale = Math.min(destW / srcW, destH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (destW - w) / 2, y: (destH - h) / 2, w, h };
}

export type SizedSource = {
  id?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  width?: number;
  height?: number;
};

function sourceSize(image: SizedSource): { width: number; height: number } {
  return {
    width: Number(image.naturalWidth || image.width || 0),
    height: Number(image.naturalHeight || image.height || 0),
  };
}

export type ComposeStudioOpts = {
  productLight: number;
  backgroundLight: number;
  filterSupported?: boolean;
  backdrop?: BackdropPreset;
  set?: SizedSource | null;
};

export function composeStudioStill(
  ctx: CanvasRenderingContext2D,
  destW: number,
  destH: number,
  product: SizedSource | null,
  ground: SizedSource | null,
  opts: ComposeStudioOpts,
): void {
  // Backdrop fill → set still (white_set) or CSS wall + optional ground multiply → product.
  const preset = parseBackdropPreset(opts.backdrop ?? BACKDROP_DEFAULT);
  const productSize = product ? sourceSize(product) : { width: 0, height: 0 };
  const groundSize = ground ? sourceSize(ground) : { width: 0, height: 0 };
  const set = opts.set || null;
  const setSize = set ? sourceSize(set) : { width: 0, height: 0 };
  const useSet = preset === "white_set" && Boolean(set && setSize.width && setSize.height);
  const srcW = productSize.width || setSize.width || groundSize.width;
  const srcH = productSize.height || setSize.height || groundSize.height;
  const rect = containRect(destW, destH, srcW, srcH);
  ctx.save();
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  if (useSet) {
    ctx.fillStyle = studioBackdrop(opts.backgroundLight, preset);
    ctx.fillRect(0, 0, destW, destH);
    const background = clampStudioLight(opts.backgroundLight);
    if (background !== STUDIO_LIGHT_DEFAULT && opts.filterSupported !== false) {
      ctx.filter = `brightness(${background})`;
    }
    ctx.drawImage(set as CanvasImageSource, rect.x, rect.y, rect.w, rect.h);
    ctx.filter = "none";
  } else {
    paintStudioSet(ctx, destW, destH, preset, opts.backgroundLight);
    if (usesContactShadow(preset) && ground && groundSize.width && groundSize.height) {
      const background = clampStudioLight(opts.backgroundLight);
      if (background !== STUDIO_LIGHT_DEFAULT && opts.filterSupported !== false) {
        ctx.filter = `brightness(${background})`;
      }
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(ground as CanvasImageSource, rect.x, rect.y, rect.w, rect.h);
      ctx.filter = "none";
      ctx.globalCompositeOperation = "source-over";
    }
  }
  if (product && productSize.width && productSize.height) {
    if (opts.filterSupported !== false) {
      ctx.filter = stillsFilter(opts.productLight);
    }
    ctx.drawImage(product as CanvasImageSource, rect.x, rect.y, rect.w, rect.h);
    ctx.filter = "none";
  }
  ctx.restore();
}

let filterProbe: boolean | undefined;

export function canvasFilterSupported(ctx: CanvasRenderingContext2D): boolean {
  if (typeof ctx.filter !== "string") return false;
  if (typeof document === "undefined") return false;
  if (filterProbe !== undefined) return filterProbe;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const probe = canvas.getContext("2d");
    if (!probe || typeof probe.filter !== "string") {
      filterProbe = false;
      return false;
    }
    probe.fillStyle = "rgb(255, 255, 255)";
    probe.fillRect(0, 0, 1, 1);
    probe.filter = "brightness(0)";
    probe.fillStyle = "rgb(255, 255, 255)";
    probe.fillRect(0, 0, 1, 1);
    const px = probe.getImageData(0, 0, 1, 1).data;
    filterProbe = px[0] < 128;
    return filterProbe;
  } catch {
    filterProbe = false;
    return false;
  }
}

export async function blobFromLitStill(
  image: SizedSource,
  opts: { productLight: number; backgroundLight: number; backdrop?: BackdropPreset },
): Promise<Blob> {
  const width = Number(image.naturalWidth || image.width || 0);
  const height = Number(image.naturalHeight || image.height || 0);
  if (!width || !height) throw new Error("图还没加载完");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("这台浏览器不能导出白底图");
  composeStudioStill(ctx, width, height, image, null, {
    ...opts,
    filterSupported: canvasFilterSupported(ctx),
  });
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("导出失败"))), "image/png");
  });
}

const stillLoads = new Map<string, Promise<HTMLImageElement>>();

export function loadStillImage(url: string): Promise<HTMLImageElement> {
  const existing = stillLoads.get(url);
  if (existing) return existing;
  const pending = (async () => {
    if (typeof Image === "undefined") {
      throw new Error("load");
    }
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = url;
    await image.decode();
    return image;
  })().catch((error) => {
    stillLoads.delete(url);
    throw error;
  });
  stillLoads.set(url, pending);
  return pending;
}

export async function blobFromStudioStill(
  product: SizedSource,
  ground: SizedSource | null,
  opts: { productLight: number; backgroundLight: number; backdrop?: BackdropPreset; set?: SizedSource | null },
): Promise<Blob> {
  const width = Number(product.naturalWidth || product.width || 0);
  const height = Number(product.naturalHeight || product.height || 0);
  if (!width || !height) throw new Error("图还没加载完");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("这台浏览器不能导出成片");
  composeStudioStill(ctx, width, height, product, ground, {
    ...opts,
    filterSupported: canvasFilterSupported(ctx),
  });
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("导出失败"))), "image/png");
  });
}
