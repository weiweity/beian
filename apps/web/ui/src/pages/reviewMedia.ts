import type { TaskPage } from "../api";

export type PreparedReviewMedia = {
  url: string;
  width: number;
  height: number;
  source: "svg" | "raster";
};

export type ReviewImageProbe = {
  src: string;
  decoding: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  decode?: () => Promise<void>;
  onload: (() => void) | null;
  onerror: (() => void) | null;
};

type ProbeFactory = () => ReviewImageProbe;

export const REVIEW_MEDIA_TIMEOUT_MS = 20_000;

type ReviewMediaOptions = {
  createProbe?: ProbeFactory;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function browserProbe(): ReviewImageProbe {
  return new Image() as ReviewImageProbe;
}

function waitForLoad(probe: ReviewImageProbe): Promise<void> {
  if (probe.complete && probe.naturalWidth > 1 && probe.naturalHeight > 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    probe.onload = () => resolve();
    probe.onerror = () => reject(new Error("核对图加载失败"));
  });
}

async function decodeProbe(probe: ReviewImageProbe, url: string): Promise<void> {
  if (typeof probe.decode === "function") {
    probe.src = url;
    await probe.decode();
    return;
  }
  // 旧浏览器没有 decode() 时先挂事件再赋 src，避免缓存命中或同步失败丢事件。
  const loaded = waitForLoad(probe);
  probe.src = url;
  await loaded;
}

function abortError(): DOMException {
  return new DOMException("核对图加载已取消", "AbortError");
}

async function guardedDecode(
  probe: ReviewImageProbe,
  url: string,
  signal?: AbortSignal,
  timeoutMs = REVIEW_MEDIA_TIMEOUT_MS,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = (error: Error) => {
      try {
        probe.src = "";
      } catch {
        /* probe cleanup is best-effort */
      }
      reject(error);
    };
    abort = () => stop(abortError());
    signal?.addEventListener("abort", abort, { once: true });
    timer = globalThis.setTimeout(() => stop(new Error("核对图加载超时")), timeoutMs);
  });
  try {
    await Promise.race([decodeProbe(probe, url), stopped]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

async function prepareCandidates(
  page: TaskPage,
  options: ReviewMediaOptions,
  failedUrls: ReadonlySet<string>,
): Promise<PreparedReviewMedia> {
  const createProbe = options.createProbe || browserProbe;
  const candidates = [
    page.url && !failedUrls.has(page.url) ? { url: page.url, source: "svg" as const } : null,
    page.raster_url && page.raster_url !== page.url && !failedUrls.has(page.raster_url)
      ? { url: page.raster_url, source: "raster" as const }
      : null,
  ].filter((candidate): candidate is { url: string; source: "svg" | "raster" } => Boolean(candidate?.url));

  for (const candidate of candidates) {
    if (options.signal?.aborted) throw abortError();
    const probe = createProbe();
    probe.decoding = "sync";
    try {
      await guardedDecode(probe, candidate.url, options.signal, options.timeoutMs);
      const pageWidth = Number(page.width);
      const pageHeight = Number(page.height);
      const width = pageWidth > 1 ? pageWidth : probe.naturalWidth;
      const height = pageHeight > 1 ? pageHeight : probe.naturalHeight;
      if (width > 1 && height > 1) return { ...candidate, width, height };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // SVG 生成、超时或浏览器解码失败时继续尝试服务端高清 PNG。
    } finally {
      probe.onload = null;
      probe.onerror = null;
    }
  }
  throw new Error("高清核对图加载失败，请刷新后重试");
}

/**
 * SVG 优先、高清 PNG 兜底。只有浏览器确认资源已解码后才交给画布，
 * 避免全屏触发重绘后才突然变清晰。
 */
export async function prepareReviewMedia(
  page: TaskPage,
  options: ReviewMediaOptions = {},
): Promise<PreparedReviewMedia> {
  return prepareCandidates(page, options, new Set());
}

/** 真正的画布 img 仍可能在预解码后失败；跳过该 URL，再走同一高清回退链。 */
export async function prepareReviewMediaAfterFailure(
  page: TaskPage,
  failedUrl: string,
  options: ReviewMediaOptions = {},
): Promise<PreparedReviewMedia> {
  return prepareCandidates(page, options, new Set([failedUrl]));
}
