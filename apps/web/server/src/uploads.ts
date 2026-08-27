import {
  closeSync,
  copyFileSync,
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
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
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
  product_name?: string;
  pack_surface?: string;
  files: StagedFile[];
};

export type ListedUploadReceipt = {
  id: string;
  files: { field: string; name: string; bytes: number; received: number; last_modified?: number }[];
  bytes: number;
  received: number;
  created_at: string;
  client_upload_id?: string;
  product_name?: string;
  pack_surface?: string;
  kind: "compare" | "mockup";
  phase: "ready" | "paused";
};

export type UploadSessionFile = {
  field: "excel" | "pdf" | "ai";
  name: string;
  bytes: number;
  received: number;
  last_modified?: number;
  storage_name: string;
};

export type UploadSession = {
  id: string;
  owner: string;
  created_at: string;
  updated_at: string;
  client_upload_id: string;
  product_name?: string;
  pack_surface?: string;
  kind: "compare" | "mockup";
  files: UploadSessionFile[];
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
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
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

function sessionsDir(): string {
  return join(DATA_DIR, "uploads", "sessions");
}

function sessionDir(id: string): string {
  return join(sessionsDir(), id);
}

function sessionPath(id: string): string {
  return join(sessionDir(id), "session.json");
}

function sessionFilePath(session: UploadSession, file: UploadSessionFile): string {
  return join(sessionDir(session.id), file.storage_name);
}

function replaceJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  try {
    renameSync(tmp, path);
  } catch {
    try {
      copyFileSync(tmp, path);
    } finally {
      unlinkQuietly(tmp);
    }
  }
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
    if (
      !existsSync(receiptPath(candidate)) &&
      !existsSync(receiptDir(candidate)) &&
      !existsSync(sessionDir(candidate))
    ) {
      return candidate;
    }
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
    (rec.product_name === undefined || typeof rec.product_name === "string") &&
    (rec.pack_surface === undefined || typeof rec.pack_surface === "string") &&
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

function uploadSessionShapeOk(id: string, session: UploadSession): boolean {
  return (
    session?.id === id &&
    isTid(session.id) &&
    typeof session.owner === "string" &&
    typeof session.created_at === "string" &&
    typeof session.updated_at === "string" &&
    /^[a-zA-Z0-9_-]{8,80}$/.test(session.client_upload_id || "") &&
    (session.kind === "compare" || session.kind === "mockup") &&
    Array.isArray(session.files) &&
    session.files.length > 0 &&
    session.files.every(
      (file) =>
        Boolean(file) &&
        (["excel", "pdf", "ai"] as string[]).includes(file.field) &&
        typeof file.name === "string" &&
        Number.isInteger(file.bytes) &&
        file.bytes >= 0 &&
        Number.isInteger(file.received) &&
        file.received >= 0 &&
        file.received <= file.bytes &&
        typeof file.storage_name === "string" &&
        !file.storage_name.includes("/") &&
        !file.storage_name.includes("\\"),
    )
  );
}

function uploadSessionFresh(session: UploadSession): boolean {
  const age = Date.now() - Date.parse(session.updated_at);
  return Number.isFinite(age) && age <= TTL_MS;
}

function saveUploadSession(session: UploadSession): void {
  replaceJson(sessionPath(session.id), session);
}

export function loadUploadSession(id: string, owner: string): UploadSession | null {
  if (!isTid(id)) return null;
  let session: UploadSession;
  try {
    session = JSON.parse(readFileSync(sessionPath(id), "utf8")) as UploadSession;
  } catch {
    return null;
  }
  if (!uploadSessionShapeOk(id, session) || !uploadSessionFresh(session) || session.owner !== owner) {
    return null;
  }

  let changed = false;
  for (const file of session.files) {
    const path = sessionFilePath(session, file);
    let actual = 0;
    try {
      actual = statSync(path).size;
    } catch {
      return null;
    }
    if (actual > file.bytes) return null;
    if (actual !== file.received) {
      file.received = actual;
      changed = true;
    }
  }
  if (changed) saveUploadSession(session);
  return session;
}

function listedSession(session: UploadSession): ListedUploadReceipt {
  const files = session.files.map(({ field, name, bytes, received, last_modified }) => ({
    field,
    name,
    bytes,
    received,
    ...(last_modified === undefined ? {} : { last_modified }),
  }));
  return {
    id: session.id,
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    received: files.reduce((sum, file) => sum + file.received, 0),
    created_at: session.created_at,
    client_upload_id: session.client_upload_id,
    ...(session.product_name ? { product_name: session.product_name } : {}),
    ...(session.pack_surface ? { pack_surface: session.pack_surface } : {}),
    kind: session.kind,
    phase: "paused",
  };
}

function allSessionIds(): string[] {
  try {
    return readdirSync(sessionsDir()).filter((name) => isTid(name));
  } catch {
    return [];
  }
}

export function sweepUploadSessions(): void {
  for (const id of allSessionIds()) {
    let session: UploadSession | null = null;
    try {
      session = JSON.parse(readFileSync(sessionPath(id), "utf8")) as UploadSession;
    } catch {
      /* remove below */
    }
    if (!session || !uploadSessionShapeOk(id, session) || !uploadSessionFresh(session)) {
      try {
        rmSync(sessionDir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // Windows 杀毒/索引可能短暂占用分片；下次读取继续清理。
      }
    }
  }
}

function sessionFieldsKind(files: UploadSessionFile[]): "compare" | "mockup" {
  const fields = files.map((file) => file.field).sort();
  if (fields.length === 1 && fields[0] === "ai") return "mockup";
  if (fields.length === 2 && fields[0] === "excel" && fields[1] === "pdf") return "compare";
  throw uploadFailure("审稿需要 Excel + PDF；打样需要一份 AI");
}

function normalizeSessionFiles(
  files: { field?: unknown; name?: unknown; bytes?: unknown; last_modified?: unknown }[],
): UploadSessionFile[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > 2) {
    throw uploadFailure("一次只收一份打样稿，或一对审稿文件");
  }
  const seen = new Set<string>();
  const normalized = files.map((raw) => {
    const field = raw.field === "file" ? "ai" : String(raw.field || "");
    if (!(field === "excel" || field === "pdf" || field === "ai") || seen.has(field)) {
      throw uploadFailure("上传文件栏不正确");
    }
    seen.add(field);
    const name = String(raw.name || "").trim();
    const bytes = Number(raw.bytes);
    if (!name || !Number.isInteger(bytes) || bytes <= 0) throw uploadFailure("上传文件信息不完整");
    if (tooLarge(bytes)) throw uploadFailure(oversizeMessage(), 413);
    const lastModified = Number(raw.last_modified);
    return {
      field,
      name,
      bytes,
      received: 0,
      ...(Number.isFinite(lastModified) && lastModified >= 0 ? { last_modified: lastModified } : {}),
      storage_name: `${field}-${safeStagedName(name, field)}.part`,
    } as UploadSessionFile;
  });
  if (uploadTotalTooLarge(normalized.map((file) => file.bytes))) {
    throw uploadFailure(UPLOAD_BODY_TOO_LARGE, 413);
  }
  sessionFieldsKind(normalized);
  return normalized;
}

function sessionMetadataMatches(session: UploadSession, files: UploadSessionFile[]): boolean {
  if (session.files.length !== files.length) return false;
  return files.every((file) => {
    const existing = session.files.find((candidate) => candidate.field === file.field);
    return Boolean(
      existing &&
        existing.name === file.name &&
        existing.bytes === file.bytes &&
        (existing.last_modified ?? 0) === (file.last_modified ?? 0),
    );
  });
}

export function startUploadSession(
  owner: string,
  input: {
    client_upload_id?: unknown;
    product_name?: unknown;
    pack_surface?: unknown;
    files?: { field?: unknown; name?: unknown; bytes?: unknown; last_modified?: unknown }[];
  },
): ListedUploadReceipt {
  const clientUploadId = String(input.client_upload_id || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(clientUploadId)) throw uploadFailure("上传标识不正确");
  const files = normalizeSessionFiles(input.files || []);

  const completed = listReceipts(owner).find((item) => item.client_upload_id === clientUploadId);
  if (completed) return completed;

  sweepUploadSessions();
  for (const id of allSessionIds()) {
    const existing = loadUploadSession(id, owner);
    if (!existing || existing.client_upload_id !== clientUploadId) continue;
    if (!sessionMetadataMatches(existing, files)) {
      throw uploadFailure("这次上传选择的文件与服务器记录不一致，请放弃后重新选择", 409);
    }
    return listedSession(existing);
  }

  assertReceiptCapacity(owner, files.reduce((sum, file) => sum + file.bytes, 0));
  const id = newReceiptId();
  const dir = sessionDir(id);
  mkdirSync(sessionsDir(), { recursive: true });
  mkdirSync(dir, { recursive: false });
  try {
    for (const file of files) writeFileSync(join(dir, file.storage_name), Buffer.alloc(0), { flag: "wx" });
    const created = nowIso();
    const session: UploadSession = {
      id,
      owner,
      created_at: created,
      updated_at: created,
      client_upload_id: clientUploadId,
      product_name: String(input.product_name || "").trim().slice(0, 80) || undefined,
      pack_surface: String(input.pack_surface || "").trim().slice(0, 24) || undefined,
      kind: sessionFieldsKind(files),
      files,
    };
    writeFileSync(sessionPath(id), JSON.stringify(session), { encoding: "utf8", flag: "wx" });
    return listedSession(session);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function readChunk(path: string, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, bytes);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function appendUploadChunk(
  id: string,
  owner: string,
  field: string,
  offset: number,
  chunk: Buffer,
  sha256: string,
): ListedUploadReceipt {
  if (!Number.isInteger(offset) || offset < 0) throw uploadFailure("上传位置不正确", 400);
  if (!chunk.length || chunk.length > UPLOAD_CHUNK_BYTES) throw uploadFailure("上传分片大小不正确", 413);
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw uploadFailure("上传分片缺少校验值", 400);
  const actualHash = createHash("sha256").update(chunk).digest("hex");
  if (actualHash !== sha256.toLowerCase()) throw uploadFailure("上传分片校验失败，请重试", 409);

  const session = loadUploadSession(id, owner);
  if (!session) throw uploadFailure("上传会话已过期，请重新选择文件", 404);
  const file = session.files.find((candidate) => candidate.field === field);
  if (!file) throw uploadFailure("上传文件栏不存在", 404);
  const path = sessionFilePath(session, file);

  if (offset < file.received) {
    if (offset + chunk.length > file.received) throw uploadFailure(`服务器已收到 ${file.received} 字节，请从该位置继续`, 409);
    const existingHash = createHash("sha256").update(readChunk(path, offset, chunk.length)).digest("hex");
    if (existingHash !== actualHash) throw uploadFailure("重新选择的文件与已上传内容不一致，请重新开始", 409);
    return listedSession(session);
  }
  if (offset !== file.received) throw uploadFailure(`服务器已收到 ${file.received} 字节，请从该位置继续`, 409);
  if (offset + chunk.length > file.bytes) throw uploadFailure("上传内容超过文件大小", 413);

  let fd: number | undefined;
  try {
    fd = openSync(path, "r+");
    let written = 0;
    while (written < chunk.length) {
      written += writeSync(fd, chunk, written, chunk.length - written, offset + written);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  file.received = offset + chunk.length;
  session.updated_at = nowIso();
  saveUploadSession(session);
  return listedSession(session);
}

export function completeUploadSession(id: string, owner: string): ListedUploadReceipt {
  const completed = loadReceipt(id, owner);
  if (completed) return listedReceipt(completed);
  const session = loadUploadSession(id, owner);
  if (!session) throw uploadFailure("上传会话已过期，请重新选择文件", 404);
  if (session.files.some((file) => file.received !== file.bytes)) {
    throw uploadFailure("文件还没有传完", 409);
  }
  for (const file of session.files) {
    const error = magicOk(file.field, readPrefix(sessionFilePath(session, file)), file.name);
    if (error) throw uploadFailure(error);
  }

  const finalDir = receiptDir(id);
  rmSync(finalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  mkdirSync(finalDir, { recursive: false });
  try {
    const files: StagedFile[] = session.files.map((file) => {
      const storageName = `${file.field}-${safeStagedName(file.name, file.field)}`;
      const path = join(finalDir, storageName);
      copyFileSync(sessionFilePath(session, file), path);
      return { field: file.field, name: file.name, path, bytes: file.bytes };
    });
    const receipt: UploadReceipt = {
      id,
      owner,
      created_at: session.created_at,
      client_upload_id: session.client_upload_id,
      product_name: session.product_name,
      pack_surface: session.pack_surface,
      files,
    };
    writeFileSync(receiptPath(id), JSON.stringify(receipt), { encoding: "utf8", flag: "wx" });
    try {
      rmSync(sessionDir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // 回执已经成为事实；遗留分片由 sweep 清理，不能把成功响应改成失败。
    }
    return listedReceipt(receipt);
  } catch (err) {
    if (!existsSync(receiptPath(id))) rmSync(finalDir, { recursive: true, force: true });
    throw err;
  }
}

export function discardUploadSession(id: string, owner: string): boolean {
  const session = loadUploadSession(id, owner);
  if (!session) return false;
  rmSync(sessionDir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return true;
}

function assertReceiptCapacity(owner: string, incomingBytes: number): void {
  sweepUploadSessions();
  let names: string[];
  try {
    names = readdirSync(receiptsDir());
  } catch {
    names = [];
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
  for (const id of allSessionIds()) {
    const session = loadUploadSession(id, owner) || (() => {
      try {
        const raw = JSON.parse(readFileSync(sessionPath(id), "utf8")) as UploadSession;
        return uploadSessionShapeOk(id, raw) && uploadSessionFresh(raw) ? raw : null;
      } catch {
        return null;
      }
    })();
    if (!session) continue;
    const bytes = session.files.reduce((sum, file) => sum + file.bytes, 0);
    globalCount += 1;
    globalBytes += bytes;
    if (session.owner === owner) {
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
  const files = rec.files.map(({ field, name, bytes }) => ({ field, name, bytes, received: bytes }));
  return {
    id: rec.id,
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    received: files.reduce((sum, file) => sum + file.received, 0),
    created_at: rec.created_at,
    ...(rec.client_upload_id ? { client_upload_id: rec.client_upload_id } : {}),
    ...(rec.product_name ? { product_name: rec.product_name } : {}),
    ...(rec.pack_surface ? { pack_surface: rec.pack_surface } : {}),
    kind: files.some((file) => file.field === "ai") ? "mockup" : "compare",
    phase: "ready",
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

/** 台面和历史记录共用：完整回执可开工，部分会话可续传。 */
export function listPendingUploads(owner: string): ListedUploadReceipt[] {
  const ready = listReceipts(owner);
  const completedClients = new Set(ready.map((item) => item.client_upload_id).filter(Boolean));
  sweepUploadSessions();
  const partial: ListedUploadReceipt[] = [];
  for (const id of allSessionIds()) {
    const session = loadUploadSession(id, owner);
    if (!session || completedClients.has(session.client_upload_id)) continue;
    partial.push(listedSession(session));
  }
  return [...ready, ...partial].sort((a, b) => b.created_at.localeCompare(a.created_at));
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

export function discardPendingUpload(id: string, owner: string): boolean {
  return discardReceipt(id, owner) || discardUploadSession(id, owner);
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
