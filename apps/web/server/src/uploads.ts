import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { isAbsolute, join, relative, resolve } from "node:path";
import busboy from "busboy";
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
export const UPLOAD_CONCURRENCY = 2;
export const UPLOAD_BUSY = "同时最多上传 2 份，请等其中一份完成后再试";
const SINGLE_UPLOAD_BUSY = "已有文件正在上传，请等它完成后再试";

type UploadAdmission = {
  run<T>(work: () => Promise<T>): Promise<T>;
  snapshot(): { active: number; waiting: number };
};

/** 超额请求立即 429，不把等待中的 socket 堆到 Cloudflare 超时。 */
export function createUploadAdmission(
  limit = 1,
  busyMessage = limit === UPLOAD_CONCURRENCY ? UPLOAD_BUSY : SINGLE_UPLOAD_BUSY,
): UploadAdmission {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("上传并发数必须大于 0");
  let active = 0;

  function acquire(): void {
    if (active >= limit) {
      throw Object.assign(new Error(busyMessage), { status: 429 });
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

function newReceiptId(): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = newTid();
    if (!existsSync(receiptPath(candidate)) && !existsSync(receiptDir(candidate))) return candidate;
  }
  throw new Error("暂存编号冲突，请重试");
}

function uploadFailure(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function readPrefix(path: string, length = 8): Buffer {
  const buf = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytes);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function safeStagedName(name: string, fallback: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-160);
  return safe || fallback;
}

type IncomingStagedFile = StagedFile & { storage_name: string };

/**
 * 把 multipart 文件流直接写进同盘临时目录；全部限额和魔数校验通过后，再把目录
 * 原子改名并发布回执。这样两份上传可并行，而不会让 Hono/Blob/Buffer 各留一份副本。
 */
export async function stageMultipart(
  owner: string,
  body: AsyncIterable<Uint8Array>,
  contentType: string,
): Promise<UploadReceipt> {
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    throw uploadFailure("上传格式必须是 multipart/form-data");
  }

  sweepReceipts();
  mkdirSync(receiptsDir(), { recursive: true });
  const incomingDir = mkdtempSync(join(receiptsDir(), ".incoming-"));
  const incomingFiles: IncomingStagedFile[] = [];
  const writes: Promise<void>[] = [];
  const seenFields = new Set<string>();
  let clientUploadId: string | undefined;
  let totalBodyBytes = 0;
  let totalFileBytes = 0;
  let failure: (Error & { status?: number }) | undefined;
  let finalId = "";

  function fail(err: unknown, fallback = "上传失败"): void {
    if (failure) return;
    if (err instanceof Error) {
      failure = err as Error & { status?: number };
    } else {
      failure = uploadFailure(fallback);
    }
  }

  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: { "content-type": contentType },
      defParamCharset: "utf8",
      limits: {
        fieldNameSize: 80,
        fieldSize: 256,
        fields: 2,
        fileSize: Math.min(maxUploadBytes(), MAX_UPLOAD_FILES_BYTES),
        files: 2,
        parts: 4,
        headerPairs: 50,
      },
    });
  } catch {
    rmSync(incomingDir, { recursive: true, force: true });
    throw uploadFailure("上传格式不正确");
  }

  parser.on("field", (field, value, info) => {
    if (field !== "client_upload_id") return;
    if (info.valueTruncated) {
      fail(uploadFailure("上传标识过长"));
      return;
    }
    if (/^[a-zA-Z0-9_-]{8,80}$/.test(value)) clientUploadId = value;
  });

  parser.on("file", (rawField, stream, info) => {
    const field = rawField === "file" ? "ai" : rawField;
    if (!(["excel", "pdf", "ai"] as string[]).includes(field)) {
      fail(uploadFailure("不认识的文件栏"));
      stream.resume();
      return;
    }
    if (seenFields.has(field)) {
      fail(uploadFailure("同一文件栏只能上传一个文件"));
      stream.resume();
      return;
    }
    seenFields.add(field);
    const name = String(info.filename || "").trim();
    if (!name) {
      fail(uploadFailure("文件名为空"));
      stream.resume();
      return;
    }

    const storageName = `${field}-${safeStagedName(name, field)}`;
    const path = join(incomingDir, storageName);
    const staged: IncomingStagedFile = { field, name, path, bytes: 0, storage_name: storageName };
    incomingFiles.push(staged);
    stream.on("data", (chunk: Buffer) => {
      staged.bytes += chunk.length;
      totalFileBytes += chunk.length;
      if (totalFileBytes > MAX_UPLOAD_FILES_BYTES) {
        fail(uploadFailure(UPLOAD_BODY_TOO_LARGE, 413));
      }
    });
    stream.once("limit", () => fail(uploadFailure(oversizeMessage())));
    const output = createWriteStream(path, { flags: "wx" });
    writes.push(
      new Promise<void>((resolveWrite) => {
        output.once("close", resolveWrite);
        output.once("error", (err) => {
          fail(err);
          resolveWrite();
        });
        stream.once("error", () => {
          fail(uploadFailure("上传中断，请重新上传"));
          output.destroy();
        });
        stream.pipe(output);
      }),
    );
  });

  parser.once("filesLimit", () => fail(uploadFailure("一次最多上传两个文件")));
  parser.once("fieldsLimit", () => fail(uploadFailure("上传字段过多")));
  parser.once("partsLimit", () => fail(uploadFailure("上传内容过多")));
  const parserDone = new Promise<void>((resolveParser) => {
    parser.once("close", resolveParser);
    parser.once("error", () => {
      fail(uploadFailure("上传格式不完整，请重新上传"));
      resolveParser();
    });
  });

  try {
    try {
      for await (const rawChunk of body) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        totalBodyBytes += chunk.length;
        if (totalBodyBytes > MAX_UPLOAD_BODY_BYTES) {
          fail(uploadFailure(UPLOAD_BODY_TOO_LARGE, 413));
          break;
        }
        if (!parser.write(chunk)) await once(parser, "drain");
      }
      parser.end();
    } catch {
      fail(uploadFailure("上传中断，请重新上传"));
      parser.destroy();
    }
    await parserDone;
    await Promise.all(writes);

    if (failure) throw failure;
    if (!incomingFiles.length) throw uploadFailure("没有文件");
    if (totalFileBytes > MAX_UPLOAD_FILES_BYTES) throw uploadFailure(UPLOAD_BODY_TOO_LARGE, 413);
    for (const file of incomingFiles) {
      if (tooLarge(file.bytes)) throw uploadFailure(oversizeMessage());
      const magicError = magicOk(file.field, readPrefix(file.path), file.name);
      if (magicError) throw uploadFailure(magicError);
    }

    assertReceiptCapacity(owner, totalFileBytes);
    finalId = newReceiptId();
    const finalDir = receiptDir(finalId);
    renameSync(incomingDir, finalDir);
    const files: StagedFile[] = incomingFiles.map(({ storage_name, ...file }) => ({
      ...file,
      path: join(finalDir, storage_name),
    }));
    const receipt: UploadReceipt = {
      id: finalId,
      owner,
      created_at: nowIso(),
      client_upload_id: clientUploadId,
      files,
    };
    writeFileSync(receiptPath(finalId), JSON.stringify(receipt), { encoding: "utf8", flag: "wx" });
    return receipt;
  } catch (err) {
    if (finalId) {
      unlinkQuietly(receiptPath(finalId));
      purgeReceiptFiles(finalId);
    } else {
      rmSync(incomingDir, { recursive: true, force: true });
    }
    throw err;
  }
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
  const id = newReceiptId();

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
    throw uploadFailure(`待开工上传最多保留 ${MAX_PENDING_RECEIPTS_PER_OWNER} 单，请先开始已有上传`, 429);
  }
  if (ownerBytes + incomingBytes > MAX_PENDING_BYTES_PER_OWNER) {
    throw uploadFailure("待开工上传总量超过 400 MB，请先开始已有上传", 429);
  }
  if (globalCount >= MAX_PENDING_RECEIPTS_GLOBAL || globalBytes + incomingBytes > MAX_PENDING_BYTES_GLOBAL) {
    throw uploadFailure("上传暂存区繁忙，请稍后再试", 429);
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
      continue;
    }
    if (/^\.incoming-[a-zA-Z0-9_-]+$/.test(name)) {
      const path = join(receiptsDir(), name);
      if (pathOlderThanTtl(path)) rmSync(path, { recursive: true, force: true });
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
