import type { FieldHit } from "../api";
import { locationPageForHit } from "./pinBox";
import { partitionReviewHits } from "./reviewEvidence";

export function isPendingDecision(decision?: string): boolean {
  return decision !== "confirm" && decision !== "issue" && decision !== "ignore";
}

export function firstPendingIssueIndex(hits: FieldHit[]): number | null {
  const pending = partitionReviewHits(hits).issues.find(({ hit }) => isPendingDecision(hit.decision));
  return pending ? pending.index : null;
}

export function pageIndexForHit(
  pages: Array<{ page?: number }>,
  hit?: Pick<FieldHit, "page" | "bboxes" | "qrcode_boxes">,
): number | null {
  const p = hit ? locationPageForHit(hit) : 0;
  if (!Number.isFinite(p) || p <= 0) return null;
  const idx = pages.findIndex((pg) => Number(pg.page) === p);
  return idx >= 0 ? idx : null;
}

export function issueOrdinal(hits: FieldHit[], index: number): number {
  const pos = partitionReviewHits(hits).issues.findIndex((row) => row.index === index);
  return pos >= 0 ? pos + 1 : 0;
}

export function reviewProgress(hits: FieldHit[], pageNo: number, active: number): {
  jobPending: number;
  pageLeft: number;
} {
  const pending = partitionReviewHits(hits).issues.filter(({ hit }) => isPendingDecision(hit.decision));
  return {
    jobPending: pending.length,
    pageLeft: pending.filter(({ hit, index }) => index !== active && Number(hit.page) === pageNo).length,
  };
}
