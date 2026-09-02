export const STUDIO_LIGHT_MIN = 0.6;
export const STUDIO_LIGHT_MAX = 1.4;
export const STUDIO_LIGHT_DEFAULT = 1;

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

export async function blobFromLitStill(
  image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number },
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
  ctx.drawImage(image, 0, 0, width, height);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("导出失败"))), "image/png");
  });
}
