export const STUDIO_LIGHT_MIN = 0.6;
export const STUDIO_LIGHT_MAX = 1.4;
export const STUDIO_LIGHT_DEFAULT = 1;
export const STUDIO_GROUND_FILL = "rgb(242, 242, 244)";

export function clampStudioLight(value: number): number {
  if (!Number.isFinite(value)) return STUDIO_LIGHT_DEFAULT;
  return Math.min(STUDIO_LIGHT_MAX, Math.max(STUDIO_LIGHT_MIN, value));
}

export function stillsFilter(light: number): string {
  const next = clampStudioLight(light);
  return `contrast(1.12) brightness(${next})`;
}

export function glbExposure(light: number): string {
  return String(Math.round(0.9 * clampStudioLight(light) * 100) / 100);
}

/** 0.6 灰底 → 1.0 及更亮为纯白。透明产品层叠在这层上面。 */
export function studioBackdrop(light: number): string {
  const value = Math.round(255 * Math.min(1, clampStudioLight(light)));
  return `rgb(${value}, ${value}, ${value})`;
}

export function jobHasGround(files: Array<{ key: string }> | undefined): boolean {
  return (files || []).some((file) => file.key === "white_a_ground" || file.key === "white_b_ground");
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
};

export function composeStudioStill(
  ctx: CanvasRenderingContext2D,
  destW: number,
  destH: number,
  product: SizedSource | null,
  ground: SizedSource | null,
  opts: ComposeStudioOpts,
): void {
  // fill 242 → multiply ground matte → product; contain, never cover.
  const productSize = product ? sourceSize(product) : { width: 0, height: 0 };
  const groundSize = ground ? sourceSize(ground) : { width: 0, height: 0 };
  const srcW = productSize.width || groundSize.width;
  const srcH = productSize.height || groundSize.height;
  const rect = containRect(destW, destH, srcW, srcH);
  ctx.save();
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = STUDIO_GROUND_FILL;
  ctx.fillRect(0, 0, destW, destH);
  if (ground && groundSize.width && groundSize.height) {
    const background = clampStudioLight(opts.backgroundLight);
    if (background !== STUDIO_LIGHT_DEFAULT && opts.filterSupported !== false) {
      ctx.filter = `brightness(${background})`;
    }
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(ground as CanvasImageSource, rect.x, rect.y, rect.w, rect.h);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
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
  opts: { productLight: number; backgroundLight: number },
): Promise<Blob> {
  const width = Number(image.naturalWidth || image.width || 0);
  const height = Number(image.naturalHeight || image.height || 0);
  if (!width || !height) throw new Error("图还没加载完");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("这台浏览器不能导出白底图");
  ctx.fillStyle = studioBackdrop(opts.backgroundLight);
  ctx.fillRect(0, 0, width, height);
  ctx.filter = stillsFilter(opts.productLight);
  ctx.drawImage(image as CanvasImageSource, 0, 0, width, height);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("导出失败"))), "image/png");
  });
}

export async function blobFromStudioStill(
  product: SizedSource,
  ground: SizedSource | null,
  opts: { productLight: number; backgroundLight: number },
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
