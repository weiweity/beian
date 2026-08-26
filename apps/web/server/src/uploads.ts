import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DATA_DIR } from "./config.js";
import { isTid, newTid, nowIso, viewerFromSession } from "./tasks.js";
import { maxUploadBytes } from "./settings.js";

export type StagedFile = { field: string; name: string; path: string; bytes: number };
export type UploadReceipt = {
  id: string;
  owner: string;
  created_at: string;
  client_upload_id?: string;
  files: StagedFile[];
};

export type ListedUploadReceipt = {
  id: string;
  files: { field: string; name: string; bytes: number }[];
  bytes: number;
  created_at: string;
  client_upload_id?: string;
  kind: "compare" | "mockup";
};

const TTL_MS = 30 * 60 * 1000;
export const MAX_UPLOAD_FILES_BYTES = 100 * 1024 * 1024;
/** 给 multipart boundary、字段名和文件名留协议开销；文件本身仍严格限 100 MiB。 */
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_FILES_BYTES + 1024 * 1024;
export const UPLOAD_BODY_TOO_LARGE = "上传总量超过 100 MB";
export const MAX_PENDING_RECEIPTS_PER_OWNER = 8;
export const MAX_PENDING_BYTES_PER_OWNER = 400 * 1024 * 1024;
export const MAX_PENDING_RECEIPTS_GLOBAL = 64;
export const MAX_PENDING_BYTES_GLOBAL = 1024 * 1024 * 1024;
export const UPLOAD_BUSY = "已有文件正在上传，请等它完成后再试";

type UploadAdmission = {
  run<T>(work: () => Promise<T>): Promise<T>;
  snapshot(): { active: number; waiting: number };
};

/**
 * multipart 会在 parseBody 时整包驻留内存。这里只准有限个解析器进入；超额请求
 * 立即 429，让前端明确重试，避免把多份 100 MiB 文件或等待中的 socket 堆起来。
 */
export function createUploadAdmission(limit = 1): UploadAdmission {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("上传并发数必须大于 0");
  let active = 0;

  function acquire(): void {
    if (active >= limit) {
      throw Object.assign(new Error(UPLOAD_BUSY), { status: 429 });
    }
    active += 1;
  }

  function release(): void {
    active -= 1;
  }

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
    snapshot: () => ({ active, waiting: 0 }),
  };
}

function receiptsDir(): string {
  return join(DATA_DIR, "uploads", "receipts");
}

function receiptPath(id: string): string {
  return join(receiptsDir(), `${id}.json`);
}

function receiptDir(id: string): string {
  return join(receiptsDir(), id);
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

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

function pathOlderThanTtl(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > TTL_MS;
  } catch {
    return true;
  }
}

/** 先原子占有 JSON，再删暂存目录，避免与同时发生的 consume 互删。 */
function purgeAvailableReceipt(id: string): void {
  if (!isTid(id)) return;
  const src = receiptPath(id);
  const taken = `${src}.${process.pid}.${Date.now()}.purge`;
  try {
    renameSync(src, taken);
  } catch {
    return;
  }
  unlinkQuietly(taken);
  purgeReceiptFiles(id);
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
  clientUploadId?: string,
): UploadReceipt {
  if (!parts.length) throw new Error("没有文件");
  if (uploadTotalTooLarge(parts.map((part) => part.buf.length))) throw new Error(UPLOAD_BODY_TOO_LARGE);
  for (const part of parts) {
    if (tooLarge(part.buf.length)) throw new Error(oversizeMessage());
    const err = magicOk(part.field, part.buf, part.name);
    if (err) throw new Error(err);
  }

  sweepReceipts();
  assertReceiptCapacity(owner, parts.reduce((sum, part) => sum + part.buf.length, 0));
  mkdirSync(receiptsDir(), { recursive: true });
  let id = "";
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = newTid();
    if (!existsSync(receiptPath(candidate)) && !existsSync(receiptDir(candidate))) {
      id = candidate;
      break;
    }
  }
  if (!id) throw new Error("暂存编号冲突，请重试");

  const dir = receiptDir(id);
  let ownsDir = false;
  try {
    mkdirSync(dir);
    ownsDir = true;
    const files: StagedFile[] = [];
    for (const part of parts) {
      const safe = part.name.replace(/[^a-zA-Z0-9._-]/g, "_") || part.field;
      const path = join(dir, `${part.field}-${safe}`);
      writeFileSync(path, part.buf);
      files.push({ field: part.field, name: part.name, path, bytes: part.buf.length });
    }
    const rec: UploadReceipt = {
      id,
      owner,
      created_at: nowIso(),
      client_upload_id: clientUploadId,
      files,
    };
    writeFileSync(receiptPath(id), JSON.stringify(rec), { encoding: "utf8", flag: "wx" });
    return rec;
  } catch (err) {
    if (ownsDir) {
      unlinkQuietly(receiptPath(id));
      purgeReceiptFiles(id);
    }
    throw err;
  }
}

function receiptFresh(rec: UploadReceipt): boolean {
  const age = Date.now() - Date.parse(rec.created_at);
  return Number.isFinite(age) && age <= TTL_MS;
}

function receiptShapeOk(id: string, rec: UploadReceipt): boolean {
  return (
    rec?.id === id &&
    isTid(rec.id) &&
    typeof rec.owner === "string" &&
    typeof rec.created_at === "string" &&
    (rec.client_upload_id === undefined || typeof rec.client_upload_id === "string") &&
    Array.isArray(rec.files) &&
    rec.files.every(
      (file) =>
        Boolean(file) &&
        typeof file.field === "string" &&
        typeof file.name === "string" &&
        typeof file.path === "string" &&
        Number.isFinite(file.bytes) &&
        file.bytes >= 0,
    )
  );
}

function readReceipt(id: string): UploadReceipt | null {
  try {
    const rec = JSON.parse(readFileSync(receiptPath(id), "utf8")) as UploadReceipt;
    return receiptShapeOk(id, rec) ? rec : null;
  } catch {
    return null;
  }
}

function ownedBy(rec: UploadReceipt, owner: string): boolean {
  return Boolean(String(rec.owner || "").trim()) && rec.owner === owner;
}

function receiptBytes(rec: UploadReceipt): number {
  let total = 0;
  for (const file of rec.files) {
    if (!Number.isFinite(file.bytes) || file.bytes < 0) return 0;
    total += file.bytes;
  }
  return total;
}

function assertReceiptCapacity(owner: string, incomingBytes: number): void {
  let names: string[];
  try {
    names = readdirSync(receiptsDir());
  } catch {
    return;
  }
  let globalCount = 0;
  let globalBytes = 0;
  let ownerCount = 0;
  let ownerBytes = 0;
  for (const name of names) {
    const match = /^([0-9a-f]{12})\.json$/.exec(name);
    if (!match) continue;
    const rec = readReceipt(match[1]);
    if (!rec || !receiptFresh(rec)) continue;
    const bytes = receiptBytes(rec);
    globalCount += 1;
    globalBytes += bytes;
    if (ownedBy(rec, owner)) {
      ownerCount += 1;
      ownerBytes += bytes;
    }
  }
  if (ownerCount >= MAX_PENDING_RECEIPTS_PER_OWNER) {
    throw new Error(`待开工上传最多保留 ${MAX_PENDING_RECEIPTS_PER_OWNER} 单，请先开始已有上传`);
  }
  if (ownerBytes + incomingBytes > MAX_PENDING_BYTES_PER_OWNER) {
    throw new Error("待开工上传总量超过 400 MB，请先开始已有上传");
  }
  if (globalCount >= MAX_PENDING_RECEIPTS_GLOBAL || globalBytes + incomingBytes > MAX_PENDING_BYTES_GLOBAL) {
    throw new Error("上传暂存区繁忙，请稍后再试");
  }
}

/** 只在开工准备失败时恢复刚拿走的回执；源文件必须仍完整留在自己的暂存目录。 */
export function restoreReceipt(rec: UploadReceipt): boolean {
  if (!receiptShapeOk(rec.id, rec) || !receiptFresh(rec) || !rec.files.length) return false;
  if (!rec.files.every((file) => underReceiptDir(rec.id, file.path) && existsSync(file.path))) return false;
  mkdirSync(receiptsDir(), { recursive: true });
  try {
    writeFileSync(receiptPath(rec.id), JSON.stringify(rec), { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function loadReceipt(id: string, owner: string): UploadReceipt | null {
  if (!isTid(id)) return null;
  const rec = readReceipt(id);
  if (!rec) return null;
  if (!receiptFresh(rec)) {
    purgeAvailableReceipt(id);
    return null;
  }
  return ownedBy(rec, owner) ? rec : null;
}

/** 清理过期、损坏和崩溃遗留的回执；每次列出或新上传时执行，避免重复上传长期涨盘。 */
export function sweepReceipts(): void {
  let names: string[];
  try {
    names = readdirSync(receiptsDir());
  } catch {
    return;
  }
  for (const name of names) {
    const json = /^([0-9a-f]{12})\.json$/.exec(name);
    if (json) {
      const id = json[1];
      const rec = readReceipt(id);
      if (!rec || !receiptFresh(rec)) purgeAvailableReceipt(id);
      continue;
    }
    const dir = /^([0-9a-f]{12})$/.exec(name);
    if (dir) {
      const id = dir[1];
      if (!existsSync(receiptPath(id)) && pathOlderThanTtl(receiptDir(id))) purgeReceiptFiles(id);
      continue;
    }
    const taken = /^([0-9a-f]{12})\.json\..+\.(take|purge)$/.exec(name);
    if (taken) {
      const path = join(receiptsDir(), name);
      if (pathOlderThanTtl(path)) unlinkQuietly(path);
    }
  }
}

function listedReceipt(rec: UploadReceipt): ListedUploadReceipt {
  const files = rec.files.map(({ field, name, bytes }) => ({ field, name, bytes }));
  return {
    id: rec.id,
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    created_at: rec.created_at,
    ...(rec.client_upload_id ? { client_upload_id: rec.client_upload_id } : {}),
    kind: files.some((file) => file.field === "ai") ? "mockup" : "compare",
  };
}

/** 列表读取顺手清掉已过期的 JSON 和暂存目录，不在内存保存回执。 */
export function listReceipts(owner: string): ListedUploadReceipt[] {
  sweepReceipts();
  let names: string[];
  try {
    names = readdirSync(receiptsDir());
  } catch {
    return [];
  }
  const found: ListedUploadReceipt[] = [];
  for (const name of names) {
    const match = /^([0-9a-f]{12})\.json$/.exec(name);
    if (!match) continue;
    const id = match[1];
    const rec = readReceipt(id);
    if (!rec) continue;
    if (!receiptFresh(rec)) {
      purgeAvailableReceipt(id);
      continue;
    }
    if (ownedBy(rec, owner)) found.push(listedReceipt(rec));
  }
  return found.sort((a, b) => b.created_at.localeCompare(a.created_at));
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
    if (!receiptShapeOk(id, rec) || !receiptFresh(rec)) {
      unlinkQuietly(taken);
      purgeReceiptFiles(id);
      return null;
    }
    if (!ownedBy(rec, owner)) {
      try {
        renameSync(taken, src);
      } catch {
        /* fail closed */
      }
      return null;
    }
    unlinkQuietly(taken);
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

export function discardReceipt(id: string, owner: string): boolean {
  const rec = consumeReceipt(id, owner);
  if (!rec) return false;
  purgeReceiptFiles(rec.id);
  return true;
}

export function tooLarge(bytes: number): boolean {
  return bytes > maxUploadBytes();
}

export function uploadTotalTooLarge(sizes: number[]): boolean {
  let total = 0;
  for (const size of sizes) {
    if (!Number.isFinite(size) || size < 0) return true;
    total += size;
    if (total > MAX_UPLOAD_FILES_BYTES) return true;
  }
  return false;
}

export function oversizeMessage(): string {
  return `文件超过 ${Math.round(maxUploadBytes() / 1024 / 1024)} MB`;
}
