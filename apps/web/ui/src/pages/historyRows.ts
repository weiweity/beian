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

export type HistoryKindFilter = "全部" | HistoryRow["kind"];
export type HistoryTimeFilter = "全部" | "今天" | "近 7 天" | "近 30 天";

export type HistoryFilters = {
  kind: HistoryKindFilter;
  time: HistoryTimeFilter;
  actor: string;
  range?: { from: Date; to: Date } | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

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
    // “生成人”始终是建单人；签字人只代表完成动作，不能改写筛选维度。
    actor: row.owner || "",
    live,
  };
}

export function historyMockRow(row: MockupJob): HistoryRow {
  const live = mockLive(row);
  let status = "打样";
  let color: HistoryRow["color"] = "default";
  if (
    row.status === "running" ||
    row.status === "queued" ||
    row.job_status === "running" ||
    row.job_status === "queued"
  ) {
    status = "打样中";
    color = "processing";
  } else if (row.status === "done") {
    status = "已出图";
    color = "success";
  } else if (row.status === "failed") {
    status = "打样中断";
    color = "error";
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

export function historyRowKey(row: HistoryRow): string {
  return `${row.kind}-${row.id}`;
}

export function historyCanDelete(row: HistoryRow): boolean {
  return row.color !== "processing";
}

export function historySelectionState(rows: HistoryRow[], selected: string[]): {
  keys: string[];
  all: boolean;
  some: boolean;
} {
  const keys = rows.filter(historyCanDelete).map(historyRowKey);
  const chosen = new Set(selected);
  const selectedCount = keys.reduce((count, key) => count + Number(chosen.has(key)), 0);
  return {
    keys,
    all: keys.length > 0 && selectedCount === keys.length,
    some: selectedCount > 0 && selectedCount < keys.length,
  };
}

export function historyActors(rows: HistoryRow[]): string[] {
  return [...new Set(rows.map((row) => row.actor.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );
}

function timeFloor(filter: HistoryTimeFilter, now: Date): number | null {
  if (filter === "全部") return null;
  if (filter === "今天") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  return now.getTime() - (filter === "近 7 天" ? 7 : 30) * DAY_MS;
}

export function filterHistoryRows(
  rows: HistoryRow[],
  filters: HistoryFilters,
  now = new Date(),
): HistoryRow[] {
  const customFrom = filters.range?.from.getTime();
  const customTo = filters.range?.to.getTime();
  const floor = Number.isFinite(customFrom) ? customFrom! : timeFloor(filters.time, now);
  const ceiling = Number.isFinite(customTo) ? customTo! : now.getTime();
  return rows.filter((row) => {
    if (filters.kind !== "全部" && row.kind !== filters.kind) return false;
    if (filters.actor && row.actor !== filters.actor) return false;
    if (floor !== null) {
      const at = new Date(row.at).getTime();
      if (!Number.isFinite(at) || at < floor || at > ceiling) return false;
    }
    return true;
  });
}
