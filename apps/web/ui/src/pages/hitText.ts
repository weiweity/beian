/** 核对页字段文案。后端 hits 用 excel_value + coverage，不一定有 pdf/found。 */

export type HitText = {
  excel?: string;
  excel_value?: string;
  expected?: string;
  pdf?: string;
  found?: string;
  evidence?: string;
  coverage?: { hit?: string[]; miss?: string[] };
};

export function excelText(h: HitText): string {
  const t = (h.excel || "").trim() || (h.excel_value || "").trim() || (h.expected || "").trim();
  return t || "—";
}

export function pdfText(h: HitText): string {
  const direct = (h.pdf || "").trim() || (h.found || "").trim();
  if (direct) return direct;
  const hits = (h.coverage?.hit || []).map((s) => String(s).trim()).filter(Boolean);
  if (hits.length) return hits.join(" ");
  const ev = (h.evidence || "").trim();
  if (ev) return ev;
  return "没读到";
}
