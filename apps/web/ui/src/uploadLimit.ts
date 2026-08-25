/** Cloudflare 免费/Pro 橙云主机上传上限约 100MB。我们自己的 400 文案是 200MB，公网会先被 413 HTML 拦掉。 */
export const PUBLIC_UPLOAD_MB = 100;
export const PUBLIC_UPLOAD_BYTES = PUBLIC_UPLOAD_MB * 1024 * 1024;
export const UPLOAD_TOO_LARGE = `文件太大。官网一次大约 ${PUBLIC_UPLOAD_MB}MB（多份合计），请缩小包装 PDF 再传。`;

export function bytesTooLarge(...sizes: number[]): boolean {
  let total = 0;
  for (const n of sizes) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total > PUBLIC_UPLOAD_BYTES;
}
