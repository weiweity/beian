import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DATA_DIR } from "./config.js";
import { isTid, newTid, nowIso, viewerFromSession } from "./tasks.js";
import { maxUploadBytes } from "./settings.js";

export type StagedFile = { field: string; name: string; path: string; bytes: number };
export type UploadReceipt = {
  id: string;
  owner: string;
  created_at: string;
  files: StagedFile[];
};

const TTL_MS = 30 * 60 * 1000;

function receiptPath(id: string): string {
  return join(DATA_DIR, "uploads", "receipts", `${id}.json`);
}

function receiptDir(id: string): string {
  return join(DATA_DIR, "uploads", "receipts", id);
}

export function underReceiptDir(id: string, p: string): boolean {
  if (!isTid(id)) return false;
  const root = resolve(receiptDir(id));
  const full = resolve(p);
  const rel = relative(root, full);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

export function purgeReceiptFiles(id: string): void {
  if (!isTid(id)) return;
  try {
    rmSync(receiptDir(id), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

export function magicOk(field: string, buf: Buffer, name: string): string | null {
  if (field === "excel") {
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return "Excel 必须是 .xlsx（ZIP 格式）";
    return null;
  }
  if (field === "pdf") {
    if (buf.length < 5 || buf.subarray(0, 4).toString("utf8") !== "%PDF") return "不是有效的 PDF";
    return null;
  }
  if (field === "ai") {
    if (!/\.ai$/i.test(name)) return "只收 .ai 稿件。";
    return null;
  }
  return "不认识的文件栏";
}

/** 飞书号优先；显示名登录没有 open_id 时才用花名。同名两人不能互相领 receipt。 */
export function receiptOwner(s: { open_id?: string; display_name?: string }): string {
  return viewerFromSession(s).id;
}

export function stageBuffers(
  owner: string,
  parts: { field: string; name: string; buf: Buffer }[],
): UploadReceipt {
  const id = newTid();
  const dir = join(DATA_DIR, "uploads", "receipts", id);
  mkdirSync(dir, { recursive: true });
  const files: StagedFile[] = [];
  for (const part of parts) {
    if (tooLarge(part.buf.length)) throw new Error(oversizeMessage());
    const err = magicOk(part.field, part.buf, part.name);
    if (err) throw new Error(err);
    const safe = part.name.replace(/[^a-zA-Z0-9._-]/g, "_") || part.field;
    const path = join(dir, `${part.field}-${safe}`);
    writeFileSync(path, part.buf);
    files.push({ field: part.field, name: part.name, path, bytes: part.buf.length });
  }
  const rec: UploadReceipt = { id, owner, created_at: nowIso(), files };
  mkdirSync(join(DATA_DIR, "uploads", "receipts"), { recursive: true });
  writeFileSync(receiptPath(id), JSON.stringify(rec), "utf8");
  return rec;
}

function receiptUsable(rec: UploadReceipt, owner: string): boolean {
  if (!String(rec.owner || "").trim() || rec.owner !== owner) return false;
  const age = Date.now() - Date.parse(rec.created_at);
  return Number.isFinite(age) && age <= TTL_MS;
}

export function loadReceipt(id: string, owner: string): UploadReceipt | null {
  if (!isTid(id)) return null;
  try {
    const rec = JSON.parse(readFileSync(receiptPath(id), "utf8")) as UploadReceipt;
    if (!receiptUsable(rec, owner)) return null;
    return rec;
  } catch {
    return null;
  }
}

/** 原子拿走收据 JSON。稿件目录仍在，开工拷完后调用 purgeReceiptFiles。 */
export function consumeReceipt(id: string, owner: string): UploadReceipt | null {
  if (!isTid(id)) return null;
  const src = receiptPath(id);
  const taken = `${src}.${process.pid}.${Date.now()}.take`;
  try {
    renameSync(src, taken);
  } catch {
    return null;
  }
  try {
    const rec = JSON.parse(readFileSync(taken, "utf8")) as UploadReceipt;
    if (!receiptUsable(rec, owner)) {
      try {
        renameSync(taken, src);
      } catch {
        /* fail closed */
      }
      return null;
    }
    try {
      unlinkSync(taken);
    } catch {
      /* already gone */
    }
    return rec;
  } catch {
    try {
      renameSync(taken, src);
    } catch {
      /* fail closed */
    }
    return null;
  }
}

export function tooLarge(bytes: number): boolean {
  return bytes > maxUploadBytes();
}

export function oversizeMessage(): string {
  return `文件超过 ${Math.round(maxUploadBytes() / 1024 / 1024)} MB`;
}
