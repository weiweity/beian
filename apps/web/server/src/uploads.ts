import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { newTid, nowIso, viewerFromSession } from "./tasks.js";
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

export function loadReceipt(id: string, owner: string): UploadReceipt | null {
  try {
    const rec = JSON.parse(readFileSync(receiptPath(id), "utf8")) as UploadReceipt;
    if (rec.owner && rec.owner !== owner) return null;
    const age = Date.now() - Date.parse(rec.created_at);
    if (!Number.isFinite(age) || age > TTL_MS) return null;
    return rec;
  } catch {
    return null;
  }
}

export function consumeReceipt(id: string, owner: string): UploadReceipt | null {
  const rec = loadReceipt(id, owner);
  if (!rec) return null;
  try {
    unlinkSync(receiptPath(id));
  } catch {
    /* already gone */
  }
  return rec;
}

export function tooLarge(bytes: number): boolean {
  return bytes > maxUploadBytes();
}

export function oversizeMessage(): string {
  return `文件超过 ${Math.round(maxUploadBytes() / 1024 / 1024)} MB`;
}
