import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

export type Hit = {
  id?: string;
  field?: string;
  status?: string;
  decision?: string;
  note?: string;
  excel?: string;
  excel_value?: string;
  pdf?: string;
  expected?: string;
  found?: string;
  page?: number | string;
  bboxes?: unknown[];
};

export type Task = {
  id: string;
  title: string;
  product_name?: string;
  type: string;
  status: string;
  created_at?: string;
  owner?: string;
  created_by?: string;
  actor?: string;
  completed_by?: string;
  completed_at?: string;
  conclusion?: string;
  complete_kind?: string;
  hits?: Hit[];
  hits_v2?: Hit[];
  pages?: unknown[];
  pages_v2?: unknown[];
  round?: number;
  rework_check?: unknown[];
  audit?: unknown[];
  [k: string]: unknown;
};

const TID = /^[0-9a-f]{12}$/;

function tasksDir() {
  const d = join(DATA_DIR, "tasks");
  mkdirSync(d, { recursive: true });
  return d;
}

export function assertTid(tid: string): string {
  if (!TID.test(tid || "")) throw Object.assign(new Error("无效任务 id"), { status: 400 });
  return tid;
}

export function loadTask(tid: string): Task {
  const p = join(tasksDir(), `${assertTid(tid)}.json`);
  if (!existsSync(p)) throw Object.assign(new Error("任务不存在"), { status: 404 });
  return JSON.parse(readFileSync(p, "utf8")) as Task;
}

export function saveTask(task: Task): void {
  const tid = assertTid(task.id);
  const p = join(tasksDir(), `${tid}.json`);
  writeFileSync(p, JSON.stringify(task, null, 2), "utf8");
}

export function listTasks(q = "", mineName = "", admin = false): Record<string, unknown>[] {
  const needle = q.trim().toLowerCase();
  const items: Task[] = [];
  for (const name of readdirSync(tasksDir())) {
    if (!name.endsWith(".json")) continue;
    try {
      items.push(JSON.parse(readFileSync(join(tasksDir(), name), "utf8")) as Task);
    } catch {
      /* skip */
    }
  }
  const filtered = items.filter((t) => {
    const owner = t.owner || t.created_by || t.actor || "";
    if (mineName && !admin && owner && owner !== mineName) return false;
    if (needle) {
      const hay = `${t.product_name || ""} ${t.title || ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  const open = filtered.filter((t) => t.status !== "completed");
  const done = filtered.filter((t) => t.status === "completed");
  const byTime = (a: Task, b: Task) => String(b.created_at || "").localeCompare(String(a.created_at || ""));
  open.sort(byTime);
  done.sort(byTime);
  return [...open, ...done].map((t) => ({
    id: t.id,
    title: t.title,
    product_name: t.product_name || "",
    type: t.type,
    status: t.status,
    created_at: t.created_at,
    owner: t.owner || t.created_by || t.actor,
    completed_by: t.completed_by,
    round: t.round || 1,
    board: boardColumn(t.status),
    error: typeof t.error === "string" ? t.error : "",
  }));
}

export const REVIEWABLE_STATUSES = ["pending_review", "in_review"] as const;
export const HIT_DECISIONS = ["confirm", "issue", "ignore"] as const;
export type HitDecision = (typeof HIT_DECISIONS)[number];

export function isReviewableStatus(status: string): boolean {
  return (REVIEWABLE_STATUSES as readonly string[]).includes(status);
}

export function isReworkableStatus(status: string): boolean {
  return status === "pending_review" || status === "in_review" || status === "completed";
}

export function hasReworkPages(task: { pages_v2?: unknown }): boolean {
  return Array.isArray(task.pages_v2) && task.pages_v2.length > 0;
}

export function isReworkableTask(task: { status: string; complete_kind?: string; pages_v2?: unknown }): boolean {
  if (hasReworkPages(task)) return false;
  if (task.status === "pending_review" || task.status === "in_review") return true;
  return task.status === "completed" && task.complete_kind === "rework";
}

export function activeHits(task: Task): Hit[] {
  if (Array.isArray(task.hits_v2) && task.hits_v2.length > 0) return task.hits_v2;
  return task.hits || [];
}

export function isHitDecision(value: unknown): value is HitDecision {
  return typeof value === "string" && (HIT_DECISIONS as readonly string[]).includes(value);
}

export type BoardColumn = "comparing" | "review" | "done";

export function boardColumn(status: string): BoardColumn {
  if (status === "completed") return "done";
  if (status === "pending_review" || status === "in_review") return "review";
  return "comparing";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newTid(): string {
  return randomTid();
}

function randomTid(): string {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 12; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}
