import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { skipPackSheetField } from "./sheetSkip.js";

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

export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type JobKind = "compare" | "rework" | "mockup";

export type Viewer = {
  id: string;
  name: string;
  admin: boolean;
};

export function viewerFromSession(session: {
  open_id?: string;
  display_name?: string;
  role?: string;
}): Viewer {
  const name = String(session.display_name || "").trim();
  return {
    id: String(session.open_id || name).trim(),
    name,
    admin: session.role === "admin",
  };
}

export function canAccessOwner(owner: string, viewer: Viewer): boolean {
  if (viewer.admin) return true;
  const expected = String(owner || "").trim();
  return Boolean(expected) && (expected === viewer.id || expected === viewer.name);
}

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
  error?: string;
  hits?: Hit[];
  hits_v2?: Hit[];
  pages?: unknown[];
  pages_b?: unknown[];
  pages_v2?: unknown[];
  round?: number;
  rework_check?: unknown[];
  audit?: unknown[];
  job_kind?: JobKind;
  job_status?: JobStatus;
  job_stage?: string;
  job_stage_label?: string;
  job_eta_s?: number;
  job_error?: string;
  job_started_at?: string;
  job_finished_at?: string;
  job_pid?: number;
  notify_job_id?: string;
  notify_sent?: boolean;
  reclaim_count?: number;
  status_before_job?: string;
  /** 仅服务端用于开始接口幂等恢复，不返回前端。 */
  source_receipt?: string;
  [k: string]: unknown;
};

const TID = /^[0-9a-f]{12}$/;

function tasksDir() {
  const d = join(DATA_DIR, "tasks");
  mkdirSync(d, { recursive: true });
  return d;
}

export function isTid(tid: string): boolean {
  return TID.test(tid || "");
}

export function assertTid(tid: string): string {
  if (!isTid(tid)) throw Object.assign(new Error("无效任务 id"), { status: 400 });
  return tid;
}

export function loadTask(tid: string): Task {
  const p = join(tasksDir(), `${assertTid(tid)}.json`);
  if (!existsSync(p)) throw Object.assign(new Error("任务不存在"), { status: 404 });
  return JSON.parse(readFileSync(p, "utf8")) as Task;
}

/** POSIX rename is atomic replace. Windows rename cannot overwrite; copyFile overwrites without deleting dest first. */
export function replaceFile(dest: string, contents: string): void {
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  try {
    renameSync(tmp, dest);
    return;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
    if (code !== "EEXIST" && code !== "EPERM" && process.platform !== "win32") {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
  try {
    copyFileSync(tmp, dest);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function saveTask(task: Task): void {
  const tid = assertTid(task.id);
  const p = join(tasksDir(), `${tid}.json`);
  replaceFile(p, JSON.stringify(task, null, 2));
}

export function loadAllTasks(): Task[] {
  const items: Task[] = [];
  for (const name of readdirSync(tasksDir())) {
    if (!name.endsWith(".json")) continue;
    try {
      items.push(JSON.parse(readFileSync(join(tasksDir(), name), "utf8")) as Task);
    } catch {
      /* skip */
    }
  }
  return items;
}

export function taskOwner(task: Task): string {
  return String(task.owner || "").trim();
}

/** 回执属于具体账号；管理员权限也不能跨账号命中别人的幂等键。 */
export function findTaskBySourceReceipt(receiptId: string, owner: string): Task | undefined {
  if (!isTid(receiptId) || !owner) return undefined;
  return loadAllTasks().find(
    (task) => task.source_receipt === receiptId && taskOwner(task) === owner,
  );
}

export function assertCanAccessTask(task: Task, viewer: Viewer): void {
  if (!canAccessOwner(taskOwner(task), viewer)) {
    throw Object.assign(new Error("没有权限"), { status: 403 });
  }
}

export function listTasks(q: string, viewer: Viewer): Record<string, unknown>[] {
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
    if (!canAccessOwner(taskOwner(t), viewer)) return false;
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
    owner: t.created_by || t.actor || t.owner,
    completed_by: t.completed_by,
    round: t.round || 1,
    board: boardColumn(t.status, t.job_status),
    error: typeof t.error === "string" ? t.error : t.job_error || "",
    job_kind: t.job_kind,
    job_status: t.job_status,
    job_stage: t.job_stage,
    job_stage_label: t.job_stage_label,
    job_eta_s: t.job_eta_s,
    job_error: t.job_error,
    job_started_at: t.job_started_at,
    job_finished_at: t.job_finished_at,
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
  const hits = Array.isArray(task.hits_v2) && task.hits_v2.length > 0 ? task.hits_v2 : task.hits || [];
  return hits.filter((hit) => !skipPackSheetField(hit.field));
}

export function isHitDecision(value: unknown): value is HitDecision {
  return typeof value === "string" && (HIT_DECISIONS as readonly string[]).includes(value);
}

export type BoardColumn = "comparing" | "failed" | "review" | "done";

export function boardColumn(status: string, jobStatus?: string): BoardColumn {
  if (status === "completed") return "done";
  if (status === "pending_review" || status === "in_review") return "review";
  if (status === "compare_failed" || jobStatus === "failed") return "failed";
  return "comparing";
}

export function deleteTask(tid: string): void {
  const task = loadTask(tid);
  if (task.job_status === "queued" || task.job_status === "running") {
    throw Object.assign(new Error("对照还在跑，不能删。等结束或失败后再删。"), { status: 409 });
  }
  const p = join(tasksDir(), `${task.id}.json`);
  unlinkSync(p);
  const uploads = join(DATA_DIR, "uploads", task.id);
  if (existsSync(uploads)) rmSync(uploads, { recursive: true, force: true });
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
