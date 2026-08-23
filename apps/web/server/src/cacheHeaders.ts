/** Hash 后的 Vite 产物可长期缓存；HTML 必须每次重验，否则会指到已下线的 chunk。 */

export const ASSET_CACHE = "public, max-age=31536000, immutable";
export const BRAND_CACHE = "public, max-age=86400";
export const HTML_CACHE = "private, no-cache";
export const REDIRECT_CACHE = "private, no-store";

export function cacheHeaderFor(path: string): string | undefined {
  const p = path.split("?")[0] || "";
  if (p === "/" || p.endsWith("/index.html")) return HTML_CACHE;
  if (p.startsWith("/assets/")) return ASSET_CACHE;
  if (p.startsWith("/brand/")) return BRAND_CACHE;
  return undefined;
}
