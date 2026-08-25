import type { MockupJob, TaskSummary } from "../api";
import { liveJobLine } from "./waitCard";

export type HistoryRow = {
  kind: "审稿台" | "打样台";
  id: string;
  title: string;
  status: string;
  color: "default" | "warning" | "error" | "processing" | "success";
  at: string;
  actor: string;
  live: string | null;
};

function taskLive(row: TaskSummary): string | null {
  return liveJobLine({
    job_status: row.job_status,
    job_stage_label: row.job_stage_label,
    job_eta_s: row.job_eta_s,
    queue_ahead: row.queue_ahead,
    kind: row.job_kind === "rework" ? "rework" : "compare",
  });
}

function mockLive(row: MockupJob): string | null {
  const job_status =
    row.job_status || (row.status === "queued" || row.status === "running" ? row.status : undefined);
  return liveJobLine({
    job_status,
    job_stage_label: row.job_stage_label,
    job_eta_s: row.job_eta_s,
    queue_ahead: row.queue_ahead,
    kind: "mockup",
  });
}

export function historyTaskRow(row: TaskSummary): HistoryRow {
  const live = taskLive(row);
  let status = row.status;
  let color: HistoryRow["color"] = "default";
  if (row.job_status === "queued" || row.job_status === "running" || row.status === "comparing") {
    status = row.job_kind === "rework" ? "对红中" : "对照中";
    color = "processing";
  } else if (row.status === "completed") {
    status = "已签字";
    color = "success";
  } else if (row.status === "in_review" || row.status === "pending_review") {
    status = "待审核";
    color = "warning";
  } else if (row.status === "compare_failed" || row.job_status === "failed") {
    status = row.job_error || row.error || "对照失败";
    color = "error";
  }
  return {
    kind: "审稿台",
    id: row.id,
    title: row.product_name || row.title,
    status,
    color,
    at: row.created_at || "",
    actor: row.completed_by || row.owner || "",
    live,
  };
}

export function historyMockRow(row: MockupJob): HistoryRow {
  const live = mockLive(row);
  let status = "打样";
  let color: HistoryRow["color"] = "default";
  if (row.status === "done") {
    status = "已出图";
    color = "success";
  } else if (row.status === "failed") {
    status = "打样中断";
    color = "error";
  } else if (row.status === "running" || row.status === "queued") {
    status = "打样中";
    color = "processing";
  } else {
    status = row.status;
  }
  return {
    kind: "打样台",
    id: row.id,
    title: row.title || row.files[0]?.name || row.id.slice(0, 8),
    status,
    color,
    at: row.created_at || "",
    actor: row.owner || "",
    live,
  };
}

export function historyHasLive(rows: HistoryRow[]): boolean {
  return rows.some((r) => r.color === "processing");
}
