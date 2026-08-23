/** 上传文件名 → 品名。去掉扩展名、【】[]、多余空白。 */
export function stemFromFilename(name: string): string {
  let s = String(name || "").trim();
  s = s.replace(/\.[^.\\/]+$/, "");
  s = s.replace(/[【\[]([^】\]]*)[】\]]/g, " $1 ");
  s = s.replace(/[【】\[\]（）()]/g, " ");
  s = s.replace(/[_-]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, 80);
}

export function formatBytes(n: number): string {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return "";
  if (x < 1024) return `${Math.round(x)} B`;
  if (x < 1024 * 1024) return `${Math.max(1, Math.round(x / 1024))} KB`;
  return `${(x / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}
