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
  field?: string;
  field_group?: string;
  doubt_bucket?: string;
  bboxes?: unknown[];
  qrcode_boxes?: unknown[];
  coverage?: {
    hit?: string[];
    miss?: string[];
    ratio?: number;
    matched?: number;
    total?: number;
    parts?: {
      net?: { coverage?: number; matched?: number; total?: number; hit_phrases?: string[]; miss_phrases?: string[] };
      barcode?: { coverage?: number; matched?: number; total?: number; hit_phrases?: string[]; miss_phrases?: string[] };
    };
  };
  sequence_diff?: { only_in_excel?: string[] };
};

function isAccountingCopy(text: string): boolean {
  return /score\s*=|覆盖偏低|稿上命中\s*\d+\s*\/\s*\d+|best score|未见缺失/i.test(text);
}

function expectedSnippet(h: HitText): string {
  const raw = excelText(h).replace(/\s+/g, " ").trim();
  if (!raw || raw === "—") return "确认单要印的字";
  return raw.length > 18 ? `${raw.slice(0, 18)}…` : raw;
}

export type SpokenAsk = { lead: string; because: string; ask: string };

function notLocatedLines(h: HitText): string[] {
  return [
    "这条我没在图上圈到。",
    "不是已经判定漏印。",
    `请对着这一整面看确认单要的「${expectedSnippet(h)}」印了没有。`,
  ];
}

function hitIsLocated(h: HitText, located?: boolean): boolean {
  if (located === false) return false;
  if (located === true) return true;
  const boxes = Array.isArray(h.bboxes) ? h.bboxes.length : -1;
  const qr = Array.isArray(h.qrcode_boxes) ? h.qrcode_boxes.length : 0;
  if (boxes === 0 && qr === 0) return false;
  return true;
}

function isFlaggedReviewHit(h: HitText): boolean {
  return h.decision === "issue" || /待人工|不清|疑|缺|误/.test(h.status || "");
}

export function humanMissLines(h: HitText): string[] {
  return (h.coverage?.miss || [])
    .map((s) => String(s).trim())
    .filter((s) => s && !isAccountingCopy(s));
}

export function spokenLines(h: HitText, field?: string, located?: boolean): string[] {
  const flagged = isFlaggedReviewHit(h);
  if (!flagged) return [];
  if (!hitIsLocated(h, located)) {
    return notLocatedLines(h);
  }
  const fg = h.field_group || "";
  const name = field || h.field || "";
  const bucket = h.doubt_bucket || "";
  if (bucket === "ocr_smallprint" || /材料来源|良好管理|FSC|防伪/.test(`${name}${excelText(h)}`)) {
    return ["这条是法规小字，必须印。", "我没读全。", "请对着刀线边缘看这一句。"];
  }
  if (bucket === "ocr_graphic") {
    return ["这块是大号图形字，轮廓或竖排机器常认不出。", "请你看是不是印了确认单要的那几个字。", "请对着这一面核对。"];
  }
  if (fg === "净含量&条形码" || (/净含量/.test(name) && /条形码|条码/.test(name))) {
    return ["确认单要毫升和条码。", "我在这一面没都读全。", "请对着这一面看毫升数字和条码。"];
  }
  if (fg === "净含量" || /净含量/.test(name)) {
    return [`确认单要「${expectedSnippet(h)}」。`, "我在这一面没读到这个数字。", "请对着这一面核对。"];
  }
  if (fg === "二维码" || /二维码|QR/.test(name)) {
    return ["没读到完整扫码关注引导语。", "钉若在码上，看的是码不是那句话。", "请对着这一面核对。"];
  }
  const ev = (h.evidence || "").trim();
  if (ev && isAccountingCopy(ev)) {
    return ["确认单要印的这些，我没在稿上读全。", "我在这一面没读全。", "请对着这一面核对。"];
  }
  return [];
}

/** 核对窗 16px 嘱咐：lead / because / ask。无嘱咐时返回 null。 */
export function spokenAsk(h: HitText, field?: string, located?: boolean): SpokenAsk | null {
  const lines = spokenLines(h, field, located);
  const misses = humanMissLines(h);
  const flagged = isFlaggedReviewHit(h);
  if (lines.length >= 3) return { lead: lines[0], because: lines[1], ask: lines[2] };
  if (lines.length) {
    return {
      lead: lines[0],
      because: lines[1] || misses.filter((m) => m !== lines[0]).join("；") || "我在这一面没读全。",
      ask: lines[2] || "请对着这一面核对。",
    };
  }
  if (!flagged && !misses.length) return null;
  if (misses.length) {
    return {
      lead: "确认单要印的这些，我没在稿上读全。",
      because: misses.length <= 2 ? misses.join("；") : `有 ${misses.length} 处没读到。`,
      ask: "请对着这一面核对。",
    };
  }
  if (!flagged) return null;
  const ev = (h.evidence || "").trim();
  if (ev && !isAccountingCopy(ev)) {
    return { lead: ev.slice(0, 80), because: "我在这一面没读全。", ask: "请对着这一面核对。" };
  }
  return { lead: "这条需要你看一眼。", because: "我没读全。", ask: "请对着这一面核对。" };
}

/** 当前字段顶栏：机审 miss / 她标有错。一致且无 miss 返回空。 */
export function doubtLines(h: HitText): string[] {
  const spoken = spokenLines(h, h.field);
  if (spoken.length) return spoken;
  const misses = humanMissLines(h);
  const flagged = isFlaggedReviewHit(h);
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
    if (ev && !isAccountingCopy(ev)) out.push(ev.slice(0, 120));
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

export function coverageTally(h: HitText): string {
  const hits = (h.coverage?.hit || []).map((s) => String(s).trim()).filter(Boolean);
  const matched = Number(h.coverage?.matched);
  const total = Number(h.coverage?.total);
  if (!(Number.isFinite(total) && total > 0)) return "";
  const n = Number.isFinite(matched) ? matched : hits.length;
  return `${total} 个词里读到 ${n} 个`;
}

export function pdfText(h: HitText, field?: string): string {
  const direct = (h.pdf || "").trim() || (h.found || "").trim();
  const hits = (h.coverage?.hit || []).map((s) => String(s).trim()).filter(Boolean);
  const found = direct || (hits.length ? hits.join(" ") : "");
  const imageNote = isImageOnlyField(field) && !found ? "稿上这一块多半是图，OCR 读不到字。" : "";
  const parts: string[] = [];
  if (imageNote) parts.push(imageNote);
  if (found) parts.push(found);
  if (parts.length) return parts.join("\n");
  const ev = (h.evidence || "").trim();
  if (ev && !isAccountingCopy(ev)) return ev;
  return "没读到";
}
