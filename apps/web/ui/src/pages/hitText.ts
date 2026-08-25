/** 核对页字段文案。后端 hits 用 excel_value + coverage，不一定有 pdf/found。 */

export type HitText = {
  excel?: string;
  excel_value?: string;
  expected?: string;
  pdf?: string;
  found?: string;
  evidence?: string;
  status?: string;
  decision?: string;
  coverage?: { hit?: string[]; miss?: string[]; ratio?: number; matched?: number; total?: number };
  sequence_diff?: { only_in_excel?: string[] };
};

/** 当前字段顶栏：机审 miss / 她标有错。一致且无 miss 返回空。 */
export function doubtLines(h: HitText): string[] {
  const misses = (h.coverage?.miss || []).map((s) => String(s).trim()).filter(Boolean);
  const st = h.status || "";
  const flagged = h.decision === "issue" || /疑|缺|误/.test(st);
  const excelOnly = flagged
    ? (h.sequence_diff?.only_in_excel || []).map((s) => String(s).trim()).filter(Boolean)
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...misses, ...excelOnly]) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  if (!out.length && flagged) {
    const ev = (h.evidence || "").trim();
    if (ev) out.push(ev.slice(0, 120));
  }
  return out;
}

export function excelText(h: HitText): string {
  const t = (h.excel || "").trim() || (h.excel_value || "").trim() || (h.expected || "").trim();
  return t || "—";
}

export function isImageOnlyField(field?: string): boolean {
  return Boolean(field && /品名|品牌|logo|标志|商标/i.test(field));
}

export function pdfText(h: HitText, field?: string): string {
  const direct = (h.pdf || "").trim() || (h.found || "").trim();
  const hits = (h.coverage?.hit || []).map((s) => String(s).trim()).filter(Boolean);
  const misses = (h.coverage?.miss || []).map((s) => String(s).trim()).filter(Boolean);
  const matched = Number(h.coverage?.matched);
  const total = Number(h.coverage?.total);
  const found = direct || (hits.length ? hits.join(" ") : "");
  const tally =
    Number.isFinite(total) && total > 0
      ? `稿上命中 ${Number.isFinite(matched) ? matched : hits.length}/${total} 项`
      : "";
  const imageNote = isImageOnlyField(field) && !found ? "稿上这一块多半是图，OCR 读不到字。" : "";
  const parts: string[] = [];
  if (imageNote) parts.push(imageNote);
  if (found) parts.push(found);
  if (tally) parts.push(tally);
  if (misses.length) parts.push(`未在稿上读到：${misses.join(" ")}`);
  if (parts.length) return parts.join("\n");
  const ev = (h.evidence || "").trim();
  if (ev) return ev;
  return "没读到";
}
