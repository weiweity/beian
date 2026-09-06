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

/** Versioned display transfer, not physical exposure or a change to source PNGs. */
const STUDIO_TRANSFER_VERSION = "highlight-power-v1";

export function highlightLut(light: number): Uint8ClampedArray {
  const exponent = 1 / Math.max(1, clampStudioLight(light));
  return Uint8ClampedArray.from({ length: 256 }, (_, value) => Math.round(255 * (value / 255) ** exponent));
}

export function protectStudioHighlights(data: Uint8ClampedArray, light: number): void {
  const lut = highlightLut(light);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = lut[data[index]];
    data[index + 1] = lut[data[index + 1]];
    data[index + 2] = lut[data[index + 2]];
    // Keep coverage unchanged, including partially transparent box edges.
  }
}

// One reusable scratch layer per destination, not a cache of full images for
// every slider position. Preview work scales with its backing size; exports
// process the original dimensions. Default/dimming paths stay unchanged.
const transferLayers = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>();

function drawStudioLayer(
  ctx: CanvasRenderingContext2D, source: SizedSource,
  rect: { x: number; y: number; w: number; h: number },
  light: number, product: boolean, filterSupported: boolean,
): void {
  const next = clampStudioLight(light);
  if (next <= 1) {
    ctx.filter = filterSupported ? (product ? stillsFilter(next) : next === 1 ? "none" : `brightness(${next})`) : "none";
    ctx.drawImage(source as CanvasImageSource, rect.x, rect.y, rect.w, rect.h);
    ctx.filter = "none";
    return;
  }
  let layer = transferLayers.get(ctx);
  if (!layer) {
    layer = document.createElement("canvas");
    transferLayers.set(ctx, layer);
  }
  layer.width = Math.max(1, Math.ceil(rect.w));
  layer.height = Math.max(1, Math.ceil(rect.h));
  const work = layer.getContext("2d", { willReadFrequently: true });
  if (!work) throw new Error("这台浏览器不能进行高光保护调灯");
  work.filter = product && filterSupported ? "contrast(1.04)" : "none";
  work.drawImage(source as CanvasImageSource, 0, 0, layer.width, layer.height);
  const pixels = work.getImageData(0, 0, layer.width, layer.height);
  protectStudioHighlights(pixels.data, next);
  work.putImageData(pixels, 0, 0);
  ctx.filter = "none";
  ctx.drawImage(layer, rect.x, rect.y, rect.w, rect.h);
}

export function composeStudioStill(
  ctx: CanvasRenderingContext2D,
  destW: number,
  destH: number,
  product: SizedSource | null,
  ground: SizedSource | null,
  opts: ComposeStudioOpts,
): void {
  if (ctx.canvas) ctx.canvas.dataset.studioTransfer = STUDIO_TRANSFER_VERSION;
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
  try {
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  if (useSet) {
    ctx.fillStyle = studioBackdrop(opts.backgroundLight, preset);
    ctx.fillRect(0, 0, destW, destH);
    drawStudioLayer(ctx, set!, rect, opts.backgroundLight, false, opts.filterSupported !== false);
  } else {
    paintStudioSet(ctx, destW, destH, preset, opts.backgroundLight);
    if (usesContactShadow(preset) && ground && groundSize.width && groundSize.height) {
      ctx.globalCompositeOperation = "multiply";
      drawStudioLayer(ctx, ground, rect, opts.backgroundLight, false, opts.filterSupported !== false);
      ctx.globalCompositeOperation = "source-over";
    }
  }
  if (product && productSize.width && productSize.height) {
    drawStudioLayer(ctx, product, rect, opts.productLight, true, opts.filterSupported !== false);
  }
  } finally {
    ctx.restore();
  }
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

/** A successful relight changes bytes without changing job id or file keys. */
export function studioAssetHref(jobId: string, key: string, generation = "", download = false): string {
  const base = `/api/mockups/${jobId}/files/${key}`;
  const query = new URLSearchParams();
  if (generation) query.set(/^(?:g0-legacy-original|g[1-9][0-9]*-|legacy-current-v2-)/.test(generation) ? "generation_id" : "generation", generation);
  if (download) query.set("download", "1");
  const suffix = query.toString();
  return suffix ? `${base}?${suffix}` : base;
}

export function loadStillImage(url: string): Promise<HTMLImageElement> {
  const existing = stillLoads.get(url);
  if (existing) return existing;
  // Relights reuse a logical asset: do not retain every decoded generation forever.
  const [asset, query = ""] = url.split("?");
  if (new URLSearchParams(query).has("generation") || new URLSearchParams(query).has("generation_id")) {
    for (const cached of stillLoads.keys()) {
      if (cached.split("?")[0] === asset) stillLoads.delete(cached);
    }
  }
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
    if (stillLoads.get(url) === pending) stillLoads.delete(url);
    throw error;
  });
  stillLoads.set(url, pending);
  return pending;
}

/** Drop only this page's cache references. An already-started download retains its own frozen sources. */
export function releaseStudioGeneration(jobId:string,generation:string): void {
  const prefix=`/api/mockups/${jobId}/files/`;
  for (const url of stillLoads.keys()) {
    if (!url.startsWith(prefix)) continue;
    const query=new URLSearchParams(url.split("?")[1] || "");
    if ((query.get("generation_id") || query.get("generation") || "") === generation) stillLoads.delete(url);
  }
}

type StudioSourceUrls = { full: string; card?: string };
export type StudioPreviewSources = { product: HTMLImageElement; ground: HTMLImageElement; set: HTMLImageElement | null };

/** Decode at source resolution. Cards are local, full images reuse the existing download cache. */
export function loadStudioPreview(
  urls: { product: StudioSourceUrls; ground: StudioSourceUrls; set: StudioSourceUrls | null },
  publish: (sources: StudioPreviewSources) => void,
  failed: () => void,
  loadFull = loadStillImage,
  loadCard = async (url: string) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = url;
    await image.decode();
    return image;
  },
): () => void {
  let cancelled = false;
  async function initial(source: StudioSourceUrls): Promise<HTMLImageElement> {
    if (source.card) {
      try { return await loadCard(source.card); } catch { /* missing card: try full */ }
    }
    return loadFull(source.full);
  }
  void (async () => {
    try {
      const [product, ground, set] = await Promise.all([
        initial(urls.product), initial(urls.ground),
        urls.set ? initial(urls.set).catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      let sources = { product, ground, set };
      publish(sources);
      await Promise.all((["product", "ground", "set"] as const).map(async (key) => {
        const source = urls[key];
        if (!source?.card) return;
        try {
          const full = await loadFull(source.full);
          if (cancelled) return;
          sources = { ...sources, [key]: full };
          publish(sources);
        } catch { /* retain this layer's usable card; other layers may still upgrade */ }
      }));
    } catch { if (!cancelled) failed(); }
  })();
  return () => { cancelled = true; };
}

/** Observe the container, not just the viewport. DPR changes re-arm the resolution query. */
export function observeStudioFrame(frame: HTMLElement, resized: (width: number, height: number) => void): () => void {
  let raf = 0;
  let stopped = false;
  let lastWidth = 0;
  let lastHeight = 0;
  let media: MediaQueryList | undefined;
  const measure = () => {
    raf = 0;
    if (stopped || !frame.clientWidth || !frame.clientHeight) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(frame.clientWidth * dpr));
    const height = Math.max(1, Math.round(frame.clientHeight * dpr));
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    resized(width, height);
  };
  const schedule = () => { if (!stopped && !raf) raf = requestAnimationFrame(measure); };
  const watchDpr = () => {
    media?.removeEventListener("change", watchDpr);
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    media.addEventListener("change", watchDpr);
    schedule();
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  observer?.observe(frame);
  window.addEventListener("resize", schedule);
  watchDpr();
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    media?.removeEventListener("change", watchDpr);
    window.removeEventListener("resize", schedule);
  };
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
