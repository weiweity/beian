import type { FieldHit } from "../api";
import { coverageTally, doubtLines, excelText, humanMissLines, pdfText, spokenAsk } from "./hitText";

export type EvidenceText = {
  summary: string;
  full: string;
  expandable: boolean;
};

export type ReviewEvidence = {
  expected: EvidenceText;
  observed: EvidenceText;
};

export type IndexedReviewHit = { hit: FieldHit; index: number };

export function isReviewIssue(hit: FieldHit): boolean {
  return (
    hit.decision === "issue" ||
    /待人工|不清|疑|缺|误/.test(String(hit.status || "")) ||
    doubtLines(hit).length > 0
  );
}

export function partitionReviewHits(hits: FieldHit[]): {
  issues: IndexedReviewHit[];
  consistent: IndexedReviewHit[];
} {
  const issues: IndexedReviewHit[] = [];
  const consistent: IndexedReviewHit[] = [];
  hits.forEach((hit, index) => {
    (isReviewIssue(hit) ? issues : consistent).push({ hit, index });
  });
  return { issues, consistent };
}

export function withLocalNotes(hits: FieldHit[], notes: Record<string, string>): FieldHit[] {
  return hits.map((hit) => {
    if (!hit.id || !Object.prototype.hasOwnProperty.call(notes, hit.id)) return hit;
    return { ...hit, note: notes[hit.id] };
  });
}

export function buildRevisionList(
  productName: string,
  hits: FieldHit[],
  options: { located?: (hit: FieldHit) => boolean | undefined } = {},
) {
  const issues = hits.filter((hit) => hit.decision === "issue");
  const lines = [
    "待设计改稿",
    `品名：${productName || "—"}`,
    ...issues.map((hit, index) => {
      const note = hit.note ? `（${hit.note}）` : "";
      const spoken = spokenAsk(hit, hit.field, options.located?.(hit));
      const doubts = spoken ? [spoken.lead, spoken.ask] : doubtLines(hit);
      const miss = humanMissLines(hit);
      const missText = miss.length ? ` / 没读到：${miss.join("；")}` : "";
      const doubtText = doubts.length ? ` / 疑点：${doubts.join("；")}` : "";
      return `${index + 1}. ${hit.field || "字段"} / 第${hit.page ?? "?"}页 / Excel：${excelText(hit)} / 稿上：${pdfText(hit, hit.field)}${doubtText}${missText}${note}`;
    }),
  ];
  return { text: lines.join("\n"), count: issues.length };
}

export function compactEvidence(value: string, limit = 180): EvidenceText {
  const full = String(value || "—").trim() || "—";
  const oneLine = full.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit && full.split("\n").length <= 3) {
    return { summary: full, full, expandable: false };
  }
  const clipped = oneLine.slice(0, Math.max(24, limit)).replace(/[，、；：,.\s]+$/u, "");
  return { summary: `${clipped}…`, full, expandable: true };
}

export function reviewEvidence(hit: FieldHit): ReviewEvidence {
  const observed = compactEvidence(pdfText(hit, hit.field));
  const tally = coverageTally(hit);
  return {
    expected: compactEvidence(excelText(hit)),
    observed: tally
      ? {
          summary: observed.summary,
          full: observed.full === "没读到" ? tally : `${observed.full}\n${tally}`,
          expandable: true,
        }
      : observed,
  };
}
