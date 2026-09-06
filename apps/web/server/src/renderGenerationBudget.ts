/** Local RF-03 lifecycle budget. Never removes candidate/ready/customer files.
 * Allocation is real writes (not truncate/sparse reservation). A reservation is
 * an owned, exclusive credit file; credit is consumed before store writes and
 * as the bounded executable's output grows. It is not a filesystem quota for
 * arbitrary hostile processes. Unknown process accounting fails closed.
 */
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync,
  readdirSync, readFileSync, readSync, statfsSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";

const MiB = 1024 * 1024;
const RENDER_LIFECYCLE_LIMITS = Object.freeze({
  diskBytes: 4096 * MiB, candidateBytes: 2304 * MiB, memoryBytes: 8192 * MiB,
  diskFloorBytes: 128 * MiB, memoryFloorBytes: 512 * MiB, fileCount: 256,
});
type RenderCheckpoint = (phase?: string) => void;
export class RenderBudgetError extends Error {
  constructor(readonly cause: string) { super(`候选资源预算未通过：${cause}`); }
}
function fail(cause: string): never { throw new RenderBudgetError(cause); }

function renderAvailableMemory(): number {
  if (process.platform === "darwin") {
    // macOS free pages exclude reclaimable cache. Use the native pressure
    // assessment, not freemem() which incorrectly rejects an idle cached Mac.
    const raw = execFileSync("/usr/bin/memory_pressure", ["-Q"], { encoding: "utf8", timeout: 1000, maxBuffer: 8192 });
    const match = /^System-wide memory free percentage: (\d+)%$/m.exec(raw);
    if (!match || Number(match[1]) > 100) fail("memory_admission_unknown");
    return Math.floor(totalmem() * Number(match[1]) / 100);
  }
  if (process.platform === "linux") {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (!match) fail("memory_admission_unknown");
    return Number(match[1]) * 1024;
  }
  return freemem();
}

/** ps reports the dedicated group including grandchildren, never just the PID.
 * Census is observational; it cannot authorize signalling a reused PID/group.
 */
export function renderGroupMemory(pid: number): number {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !["darwin", "linux"].includes(process.platform)) fail("memory_accounting_unavailable");
  const raw = execFileSync("/bin/ps", ["-axo", "pgid=,rss="], { encoding: "utf8", timeout: 1000, maxBuffer: MiB });
  let bytes = 0;
  for (const line of raw.trim().split(/\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) fail("memory_accounting_invalid");
    if (Number(match[1]) === pid) bytes += Number(match[2]) * 1024;
  }
  if (!Number.isSafeInteger(bytes)) fail("memory_accounting_invalid");
  return bytes;
}

/** Counts every file, not only declared outputs; never follows links. */
export function candidateDiskBytes(root: string): number {
  let files = 0;
  const walk = (path: string, depth: number): number => {
    if (depth > 6 || ++files > RENDER_LIFECYCLE_LIMITS.fileCount) fail("candidate_file_budget");
    let st;
    try { st = lstatSync(path); } catch (e) {
      if (depth === 0 && (e as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw e;
    }
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))) fail("candidate_file_type");
    if (!st.isDirectory()) return st.size;
    return readdirSync(path).reduce((sum, name) => sum + walk(join(path, name), depth + 1), 0);
  };
  return walk(root, 0);
}

export type RenderLifecycle = {
  deadline: number;
  check: RenderCheckpoint;
  beforeWrite(bytes: number): void;
  observe(candidateDir: string, groupPid?: number): void;
  /** Caller must prove all owned processes gone. False preserves the credit. */
  release(ownershipGone: boolean): void;
};
const lifecycles = new WeakSet<RenderLifecycle>();
export function isRenderLifecycle(value: RenderLifecycle | undefined): value is RenderLifecycle {
  return Boolean(value && lifecycles.has(value));
}

export function renderReservationPath(root: string, mutationId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(mutationId)) fail("reservation_identity");
  return join(root, `.reserve-${mutationId}`);
}

/** Recovery calls this only after the persisted execution's exit barrier. */
export function releaseRenderReservation(root: string, mutationId: string): void {
  const path = renderReservationPath(root, mutationId);
  const metadataPath = `${path}.json`;
  let metadata;
  try { metadata = lstatSync(metadataPath); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 4096) fail("reservation_metadata");
  // Read a held inode into a fixed buffer; a path replacement/growth between
  // lstat and read must not turn recovery into an unbounded read or follow links.
  const metadataFd = openSync(metadataPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let identity;
  try {
    const opened = fstatSync(metadataFd);
    if (opened.ino !== metadata.ino || opened.dev !== metadata.dev || opened.nlink !== 1
      || opened.size !== metadata.size || !opened.isFile()) fail("reservation_metadata_changed");
    const raw = Buffer.alloc(4097);
    let size = 0;
    while (size < raw.length) {
      const count = readSync(metadataFd, raw, size, raw.length - size, size);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(metadataFd);
    if (size !== opened.size || size > 4096 || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs) fail("reservation_metadata_changed");
    identity = JSON.parse(raw.subarray(0, size).toString("utf8"));
  } finally { closeSync(metadataFd); }
  if (!identity || identity.schema !== "render-reservation/1" || identity.mutationId !== mutationId
    || typeof identity.ino !== "string" || typeof identity.dev !== "string") fail("reservation_metadata");
  let st;
  try { st = lstatSync(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (st) {
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1
      || String(st.ino) !== identity.ino || String(st.dev) !== identity.dev) fail("reservation_changed");
    const currentMetadata = lstatSync(metadataPath);
    if (currentMetadata.ino !== metadata.ino || currentMetadata.dev !== metadata.dev
      || currentMetadata.nlink !== 1 || currentMetadata.size !== metadata.size
      || currentMetadata.mtimeMs !== metadata.mtimeMs) fail("reservation_metadata_changed");
    unlinkSync(path);
  }
  const finalMetadata = lstatSync(metadataPath);
  if (finalMetadata.ino !== metadata.ino || finalMetadata.dev !== metadata.dev
    || finalMetadata.nlink !== 1 || finalMetadata.size !== metadata.size
    || finalMetadata.mtimeMs !== metadata.mtimeMs) fail("reservation_metadata_changed");
  unlinkSync(metadataPath);
}

export function createRenderLifecycle(input: {
  root: string; mutationId: string; timeoutMs: number; signal?: AbortSignal;
  /** Trusted host policy may tighten, never enlarge ceilings. */
  diskBytes?: number; memoryBytes?: number;
}): RenderLifecycle {
  const diskBytes = input.diskBytes ?? RENDER_LIFECYCLE_LIMITS.diskBytes;
  const memoryBytes = input.memoryBytes ?? 4096 * MiB;
  if (!Number.isSafeInteger(diskBytes) || diskBytes <= 0 || diskBytes > RENDER_LIFECYCLE_LIMITS.diskBytes
    || !Number.isSafeInteger(memoryBytes) || memoryBytes <= 0 || memoryBytes > RENDER_LIFECYCLE_LIMITS.memoryBytes
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 1_260_000) fail("lifecycle_policy");
  const deadline = performance.now() + input.timeoutMs;
  let usable = true;
  const check: RenderCheckpoint = () => {
    if (!usable) fail("lifecycle_closed");
    if (input.signal?.aborted) fail("cancelled");
    if (performance.now() >= deadline) fail("timeout");
    if (process.memoryUsage().rss > memoryBytes) fail("memory_budget");
    const fs = statfsSync(input.root);
    if (Number(fs.bavail) * Number(fs.bsize) < RENDER_LIFECYCLE_LIMITS.diskFloorBytes) fail("disk_watermark");
  };
  check();
  if (renderAvailableMemory() < memoryBytes + RENDER_LIFECYCLE_LIMITS.memoryFloorBytes) fail("memory_admission");
  const space = statfsSync(input.root);
  if (Number(space.bavail) * Number(space.bsize) < diskBytes + RENDER_LIFECYCLE_LIMITS.diskFloorBytes) fail("disk_admission");
  const path = renderReservationPath(input.root, input.mutationId);
  const rootStat = lstatSync(input.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("reservation_root");
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
  const identity = fstatSync(fd);
  let closed = false;
  let released = false;
  let consumed = 0;
  let observedBytes = 0;
  let metadataWritten = false;
  let metadataIdentity: ReturnType<typeof lstatSync> | undefined;
  const release = (gone: boolean) => {
    if (released) return;
    usable = false;
    if (!gone) { if (!closed) { closeSync(fd); closed = true; } return; }
    // Only our exact inode can be removed, never a replacement at the same name.
    try {
      const now = lstatSync(path);
      if (now.ino !== identity.ino || now.dev !== identity.dev || now.nlink !== 1) fail("reservation_changed");
      if (metadataWritten) {
        const meta = lstatSync(`${path}.json`);
        if (meta.ino !== metadataIdentity?.ino || meta.dev !== metadataIdentity.dev || meta.nlink !== 1) fail("reservation_metadata_changed");
      }
    } finally { if (!closed) closeSync(fd); closed = true; }
    unlinkSync(path);
    if (metadataWritten) unlinkSync(`${path}.json`);
    released = true;
  };
  try {
    // Persist inode ownership before allocating or allowing any child to start.
    writeFileSync(`${path}.json`, JSON.stringify({ schema: "render-reservation/1", mutationId: input.mutationId,
      ino: String(identity.ino), dev: String(identity.dev) }), { flag: "wx", mode: 0o600 });
    metadataWritten = true;
    metadataIdentity = lstatSync(`${path}.json`);
    const metadataFd = openSync(`${path}.json`, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { fsyncSync(metadataFd); } finally { closeSync(metadataFd); }
    const chunk = Buffer.alloc(MiB, 0xa5);
    for (let position = 0; position < diskBytes;) {
      check();
      const count = writeSync(fd, chunk, 0, Math.min(chunk.length, diskBytes - position), position);
      if (count <= 0) fail("reservation_short_write");
      position += count;
    }
    fsyncSync(fd); check();
    const allocated = fstatSync(fd);
    if (allocated.size !== diskBytes || allocated.blocks * 512 < diskBytes) fail("reservation_not_allocated");
  } catch (e) { release(true); throw e; }
  const beforeWrite = (bytes: number) => {
    check();
    if (closed || !Number.isSafeInteger(bytes) || bytes < 0 || consumed + bytes > diskBytes) fail("disk_budget");
    const current = lstatSync(path);
    if (current.ino !== identity.ino || current.dev !== identity.dev || current.nlink !== 1) fail("reservation_changed");
    consumed += bytes;
    ftruncateSync(fd, diskBytes - consumed);
    check();
  };
  const lifecycle: RenderLifecycle = { deadline, check, beforeWrite, release, observe: (candidate, pid) => {
    check();
    if (pid && renderGroupMemory(pid) + process.memoryUsage().rss > memoryBytes) fail("memory_budget");
    const bytes = candidateDiskBytes(candidate);
    if (bytes > RENDER_LIFECYCLE_LIMITS.candidateBytes) fail("candidate_disk_budget");
    if (bytes > observedBytes) { beforeWrite(bytes - observedBytes); observedBytes = bytes; }
    check();
  } };
  lifecycles.add(lifecycle);
  return Object.freeze(lifecycle);
}
