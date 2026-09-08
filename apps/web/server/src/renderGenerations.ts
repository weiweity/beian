/**
 * RF-03A 代际文件存储核心。
 *
 * 接受服务端显式传入的可信 job 根，不读 config.ts / DATA_DIR。
 * 只生成经过校验的 current_render_generation_id + files patch；不写 job.json，
 * 不改变当前展示。jobs.ts 必须在同一 job 锁内重读 current 再提交 patch。
 * 比较调用者传入的 expected/observed 不等于实现 CAS。
 *
 * 隐藏 .render-generations、staging、manifest、index、cursor key。
 * 无服务启动副作用。
 *
 * 质量验证器是强制回调：无验证器或验证失败不得 ready。RF-10 三层结果中
 * runtime hard 失败不得 ready；fixture baseline_mismatch 不阻止真实任务 current。
 * 不得把 quality_status 写成 pass，不得把机器结果写成 human_acceptance。
 *
 * 目录 rename 的原子可见性不是断电耐久性证明；未跑 Windows/断电不得声称完成。
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RenderLifecycle } from "./renderGenerationBudget.js";

const RENDER_GENERATION_SCHEMA = "render-generation/1";
const RENDER_GENERATION_INDEX_SCHEMA = "render-generation-index/1";
export const RENDER_GENERATION_DIR = ".render-generations";
export const G0_LEGACY_ORIGINAL_ID = "g0-legacy-original";
export const RENDER_GENERATION_HISTORY_DEFAULT_LIMIT = 20;
export const RENDER_GENERATION_HISTORY_MAX_LIMIT = 50;
const RENDER_GENERATION_DISK_SAFETY_MULTIPLIER = 2;
export const RENDER_GENERATION_DISK_SAFETY_FLOOR_BYTES = 64 * 1024 * 1024;
export const RENDER_GENERATION_UNWIRED_NOTE = "外部质量验证尚未接线";
const RENDER_GENERATION_MAX_FILE_BYTES = 256 * 1024 * 1024;
const INDEX_MAX_BYTES = 8 * 1024 * 1024;
// Old stores may have no persisted cursor key. A bounded process-local fallback
// keeps GET read-only; a restart then expires that cursor, never authorizes it.
const READ_CURSOR_SECRET = cryptoRandomBytes(32);

const INDEX_NAME = "index.jsonl";
const CURSOR_KEY_NAME = ".cursor-key";
const OUTPUTS_DIR = "outputs";
const MANIFEST_NAME = "generation.json";
const JOB_ID_RE = /^[0-9a-f]{12}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROFILE_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const GEN_ID_RE = /^g[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}-[a-f0-9]{8}$/;
const VIRTUAL_ID_RE = /^legacy-current-v2-[a-f0-9]{64}$/;
const OLD_VIRTUAL_ID_RE = /^legacy-current-[a-f0-9]{8}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GLB_MAGIC = Buffer.from("glTF");
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

const FACES = ["front", "right", "back", "left", "top", "bottom"] as const;
type RenderFace = (typeof FACES)[number];

const REQUIRED_KEYS = ["white_a", "white_b", "glb"] as const;
const OPTIONAL_KEYS = [
  "white_a_ground",
  "white_b_ground",
  "white_a_set",
  "white_b_set",
  "white_a_card",
  "white_b_card",
  "white_a_ground_card",
  "white_b_ground_card",
  "white_a_set_card",
  "white_b_set_card",
] as const;

const ALLOWED_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
const OPTIONAL_KEY_SET = new Set<string>(OPTIONAL_KEYS);

export function isRenderGenerationOutputKey(key: string): boolean {
  return ALLOWED_KEYS.has(key);
}

const MANIFEST_KEYS = new Set([
  "schema",
  "generation_id",
  "mode",
  "profile",
  "created_at",
  "contract_sha256",
  "status",
  "quality",
  "faces",
  "files",
  "optional_omitted",
  "total_bytes",
  "actor_label",
]);
const QUALITY_KEYS = new Set([
  "verifier_status",
  "quality_status",
  "verifier",
  "generation_id",
  "contract_sha256",
  "content_fingerprint",
  "note",
]);
const FILE_ROW_KEYS = new Set(["key", "name", "sha256", "bytes", "rel"]);
const FACE_ROW_KEYS = new Set(["sha256", "name"]);
const OMITTED_KEYS = new Set(["key", "reason"]);
const INDEX_KEYS = new Set(["schema", "event", "generation_id", "at", "seq"]);
const ACTIVATION_KEYS = new Set([...INDEX_KEYS,"event_id","from_generation_id","mode","actor_id"]);

type RenderGenerationMode = "legacy_import" | "legacy_relight" | "upgrade";
export type RenderGenerationErrorCode =
  | "render_generation_invalid"
  | "render_generation_stale"
  | "render_generation_disk_guard";
type RenderGenerationQualityStatus = "unwired" | "failed" | "runtime_verified";
type DiskSpaceSource = "statfs" | "injected";

type JobFileMirror = { key: string; path: string; name: string };
type RenderGenerationPatch = {
  current_render_generation_id: string;
  files: JobFileMirror[];
};

type PublicGenerationSummary = {
  generation_id: string;
  mode: RenderGenerationMode;
  profile: string;
  created_at: string;
  quality_status: RenderGenerationQualityStatus;
  current: boolean;
  actor_label?: string;
};

type DiskSpaceProbe = { availableBytes: number; source: DiskSpaceSource };

type DurabilityNotes = {
  fsync_files: boolean;
  fsync_directory: "ok" | "unsupported" | "not_attempted";
  rename_atomic_visibility: boolean;
  power_loss_proven: false;
  windows_durability_proven: false;
  note: string;
};

export type QualityVerifyInput = {
  /** In-process seal context; never persisted or exposed in public JSON. */
  resource_lifecycle?: Pick<RenderLifecycle, "check" | "beforeWrite">;
  generation_id: string;
  contract_sha256: string;
  content_fingerprint: string;
  mode: RenderGenerationMode;
  files: Array<{ key: string; sha256: string; bytes: number }>;
  faces: Record<RenderFace, string>;
};

export type QualityVerifyLayers = {
  runtime_hard: "pass" | "fail" | "not-run";
  fixture_regression_hard: "pass" | "fail" | "not-run" | "baseline_mismatch" | "baseline_absent";
  human_acceptance: "pending" | "accepted" | "rejected";
  production_ready: false;
};

export type QualityVerifyResult = {
  generation_id: string;
  contract_sha256: string;
  content_fingerprint: string;
  verifier_status: "accepted" | "rejected";
  quality_status: RenderGenerationQualityStatus;
  verifier: string;
  note: string;
  /** Process-local RF-10 layers. Not persisted in generation.json. */
  layers?: QualityVerifyLayers;
};

export type QualityVerifier = (input: QualityVerifyInput) => QualityVerifyResult;

export type RenderGenerationSource = { key: string; path: string };

type RenderGenerationFailpoints = {
  duringCopy?: (copiedKey: string) => void;
  afterManifestWrite?: () => void;
  beforeRename?: () => void;
  afterRenameBeforeIndex?: () => void;
};

type SealGenerationInput = {
  mode: RenderGenerationMode;
  contractSha256: string;
  contractBytes?: Uint8Array;
  profile: string;
  sources?: RenderGenerationSource[];
  observedCurrentGenerationId: string | null;
  expectedCurrentGenerationId: string | null;
  actorLabel?: string;
};

type OptionalOmitted = { key: string; reason: string };

type SealResult = {
  generation_id: string;
  patch: RenderGenerationPatch;
  public_summary: PublicGenerationSummary;
  /** Process-local final barrier; rehashes ready bytes and checks exact manifest
   * identity. Must run inside the jobs CAS lock immediately before job commit. */
  prepareCommit(): RenderGenerationPatch;
  report: {
    quality_wired: boolean;
    quality_status: RenderGenerationQualityStatus;
    note: string;
    optional_omitted: OptionalOmitted[];
    durability: DurabilityNotes;
    disk: {
      estimatedBytes: number;
      requiredBytes: number;
      availableBytes: number;
      source: DiskSpaceSource;
    };
  };
};

type RecoverResult = {
  recovered: string[];
  skipped_invalid: string[];
  already_indexed: string[];
};

type HistoryQuery = {
  cursor?: string | null;
  limit?: number;
  currentGenerationId?: string | null;
};

type HistoryPage = {
  items: PublicGenerationSummary[];
  next_cursor: string | null;
};

type PrepareActivationInput = {
  generationId: string;
  observedCurrentGenerationId: string | null;
  expectedCurrentGenerationId: string | null;
};

export type RenderGenerationStoreOptions = {
  jobRoot: string;
  jobId: string;
  now?: () => Date;
  randomBytes?: (n: number) => Buffer;
  probeDisk?: () => DiskSpaceProbe;
  qualityVerifier?: QualityVerifier;
  lifecycle?: Pick<RenderLifecycle, "check" | "beforeWrite">;
  failpoints?: RenderGenerationFailpoints;
};

export type RenderGenerationStore = {
  virtualLegacyCurrentId(): string;
  openFile(generationId: string, key: string): HeldGenerationFile;
  assertHistoryWritable(): void;
  assertRerenderSourceFresh(sourceId?: string): void;
  hasActivation(fact: RenderActivationFact): boolean;
  appendActivation(fact: RenderActivationFact): void;
  sealGeneration(input: SealGenerationInput): SealResult;
  prepareActivationPatch(input: PrepareActivationInput): RenderGenerationPatch;
  recoverOrphans(): RecoverResult;
  listHistory(query?: HistoryQuery): HistoryPage;
  publicSummary(generationId: string, currentGenerationId: string | null): PublicGenerationSummary;
};

export type HeldGenerationFile = { fd: number; name: string; sha256: string; bytes: number; close(): void };

export class RenderGenerationError extends Error {
  readonly code: RenderGenerationErrorCode;
  readonly problem: string;
  readonly cause: string;
  readonly fix: string;
  constructor(code: RenderGenerationErrorCode, problem: string, cause: string, fix: string) {
    super(problem);
    this.name = "RenderGenerationError";
    this.code = code;
    this.problem = problem;
    this.cause = cause;
    this.fix = fix;
  }
}

export function isRenderGenerationError(err: unknown): err is RenderGenerationError {
  return err instanceof RenderGenerationError;
}

export function renderGenerationDiskRequiredBytes(estimatedBytes: number): number {
  if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) {
    throw invalid("磁盘估算无效", "estimate_invalid", "检查待复制文件大小后重试");
  }
  const scaled = estimatedBytes * RENDER_GENERATION_DISK_SAFETY_MULTIPLIER;
  const required = scaled + RENDER_GENERATION_DISK_SAFETY_FLOOR_BYTES;
  if (!Number.isSafeInteger(Math.trunc(required)) && required > Number.MAX_SAFE_INTEGER) {
    throw diskGuard("磁盘估算超出安全整数", "estimate_overflow", "拆分任务或扩容后再试");
  }
  return required;
}

const RENDER_GENERATION_DURABILITY_NOTE =
  "rename 原子可见性不是断电耐久性证明；文件 fsync 已做，目录 fsync 受平台限制；本切片未跑 Windows/断电取证";

function invalid(problem: string, cause: string, fix: string): RenderGenerationError {
  return new RenderGenerationError("render_generation_invalid", problem, cause, fix);
}

function stale(cause: string): RenderGenerationError {
  return new RenderGenerationError(
    "render_generation_stale",
    "当前代已变化，请刷新后再试",
    cause,
    "在同一 job 锁内重读 current 后再提交",
  );
}

function diskGuard(problem: string, cause: string, fix: string): RenderGenerationError {
  return new RenderGenerationError("render_generation_disk_guard", problem, cause, fix);
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "ENOENT");
}

function fsErrorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

function writeAllSync(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset);
  }
}

function mapUnsafeWriteError(err: unknown, cause: string): never {
  const code = fsErrorCode(err);
  if (code === "EEXIST") throw invalid("拒绝覆盖既存目标", cause, "每次固化独占新建，不能覆盖 symlink/hardlink/普通文件");
  if (code === "ELOOP") throw invalid("拒绝符号链接", "symlink", "用普通文件，不要 symlink");
  throw err;
}

function openWriteFd(path: string, flags: number, cause: string, mode?: number): number {
  try {
    return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
  } catch (err) {
    mapUnsafeWriteError(err, cause);
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function sha256Buffer(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isGenerationId(id: string): boolean {
  return id === G0_LEGACY_ORIGINAL_ID || GEN_ID_RE.test(id);
}

function looksLikePath(id: string): boolean {
  return !id || isAbsolute(id) || /[\\/]/.test(id) || id.includes("..") || id.startsWith(".");
}

function assertSafeId(id: string, cause: string): void {
  if (OLD_VIRTUAL_ID_RE.test(id)) throw stale("legacy_identity_expired");
  if (looksLikePath(id) || (!isGenerationId(id) && !VIRTUAL_ID_RE.test(id))) {
    throw invalid("代际 id 非法", cause, "只使用服务端公开的代际 id");
  }
}

function modeSlug(mode: RenderGenerationMode): string {
  if (mode === "legacy_import") return "legacy-original";
  if (mode === "legacy_relight") return "legacy-relight";
  return "upgrade";
}

function stillKeyFromName(lower: string): string {
  const card = lower.includes("_card.png");
  let base = "";
  if (lower.endsWith(".png") && lower.includes("front_right")) {
    if (/front_right_set(?:_card)?\.png$/.test(lower)) base = "white_a_set";
    else if (/front_right_ground(?:_card)?\.png$/.test(lower)) base = "white_a_ground";
    else base = "white_a";
  } else if (lower.endsWith(".png") && lower.includes("back_left")) {
    if (/back_left_set(?:_card)?\.png$/.test(lower)) base = "white_b_set";
    else if (/back_left_ground(?:_card)?\.png$/.test(lower)) base = "white_b_ground";
    else base = "white_b";
  }
  if (!base) return "";
  return card ? `${base}_card` : base;
}

function outputKeyFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".glb")) return "glb";
  return stillKeyFromName(lower);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function assertPng(buf: Buffer, causePrefix: string): void {
  if (buf.length < 45) throw invalid("PNG 不完整", `${causePrefix}:png_too_short`, "提供完整 PNG，而不是文件头");
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw invalid("PNG 签名无效", `${causePrefix}:png_magic`, "提供真实 PNG");
  }
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  let sawPlte = false;
  let idatEnded = false;
  let idatBytes = 0;
  let bitDepth = 0;
  let colorType = -1;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("binary");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > 0x7fffffff || length > buf.length || dataEnd + 4 > buf.length) {
      throw invalid("PNG chunk 截断", `${causePrefix}:png_chunk_truncated`, "提供完整 PNG");
    }
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) {
      throw invalid("PNG chunk 类型非法", `${causePrefix}:png_chunk_type`, "提供标准 PNG");
    }
    const typeAndData = buf.subarray(offset + 4, dataEnd);
    const expectedCrc = buf.readUInt32BE(dataEnd);
    if (crc32(typeAndData) !== expectedCrc) {
      throw invalid("PNG CRC 不匹配", `${causePrefix}:png_crc`, "提供未损坏的 PNG");
    }
    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) {
        throw invalid("PNG 缺少 IHDR", `${causePrefix}:png_ihdr`, "提供完整 PNG");
      }
      const width = buf.readUInt32BE(dataStart);
      const height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8] ?? 0;
      colorType = buf[dataStart + 9] ?? -1;
      if (width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff) {
        throw invalid("PNG 尺寸非法", `${causePrefix}:png_size`, "提供有效 PNG");
      }
      if (![1, 2, 4, 8, 16].includes(bitDepth || 0)) {
        throw invalid("PNG 位深非法", `${causePrefix}:png_bit_depth`, "提供有效 PNG");
      }
      if (![0, 2, 3, 4, 6].includes(colorType ?? -1)) {
        throw invalid("PNG 色彩类型非法", `${causePrefix}:png_color_type`, "提供有效 PNG");
      }
      if ((colorType === 3 && bitDepth === 16) || ([2, 4, 6].includes(colorType) && bitDepth < 8)) {
        throw invalid("PNG 位深与色彩类型不匹配", `${causePrefix}:png_bit_depth`, "提供有效 PNG");
      }
      if (buf[dataStart + 10] !== 0 || buf[dataStart + 11] !== 0 || ![0, 1].includes(buf[dataStart + 12] ?? -1)) {
        throw invalid("PNG 编码方法非法", `${causePrefix}:png_method`, "提供标准 PNG");
      }
      sawIhdr = true;
    } else if (type === "IHDR") {
      throw invalid("PNG 重复 IHDR", `${causePrefix}:png_ihdr_dup`, "提供有效 PNG");
    } else if (type === "PLTE") {
      const entries = length / 3;
      if (sawPlte || sawIdat || colorType === 0 || colorType === 4
        || length === 0 || length % 3 !== 0 || entries > 256
        || (colorType === 3 && entries > 2 ** bitDepth)) {
        throw invalid("PNG 调色板非法", `${causePrefix}:png_plte`, "提供有效 PNG");
      }
      sawPlte = true;
    } else if (type === "IDAT") {
      if (idatEnded || (colorType === 3 && !sawPlte)) {
        throw invalid("PNG 图像块顺序非法", `${causePrefix}:png_idat_order`, "提供有效 PNG");
      }
      sawIdat = true;
      idatBytes += length;
    } else if (type === "IEND") {
      if (length !== 0) throw invalid("PNG IEND 非法", `${causePrefix}:png_iend`, "提供有效 PNG");
      sawIend = true;
      offset = dataEnd + 4;
      break;
    } else if (type[0] === type[0]?.toUpperCase()) {
      throw invalid("PNG 含未知关键块", `${causePrefix}:png_critical_chunk`, "提供受支持的 PNG");
    }
    if (sawIdat && type !== "IDAT") idatEnded = true;
    offset = dataEnd + 4;
  }
  if (!sawIhdr || !sawIdat || !sawIend) {
    throw invalid("PNG 结构不完整", `${causePrefix}:png_incomplete`, "提供含 IHDR/IDAT/IEND 的 PNG");
  }
  if (offset !== buf.length) {
    throw invalid("PNG 尾部有多余字节", `${causePrefix}:png_trailing`, "提供标准 PNG");
  }
  if (idatBytes === 0) throw invalid("PNG IDAT 空", `${causePrefix}:png_idat_empty`, "提供有效 PNG");
}

function assertGlb(buf: Buffer, causePrefix: string): void {
  if (buf.length < 20) throw invalid("GLB 不完整", `${causePrefix}:glb_too_short`, "提供完整 GLB 2.0");
  if (!buf.subarray(0, 4).equals(GLB_MAGIC)) {
    throw invalid("GLB 签名无效", `${causePrefix}:glb_magic`, "提供真实 GLB");
  }
  const version = buf.readUInt32LE(4);
  const declared = buf.readUInt32LE(8);
  if (version !== 2) throw invalid("GLB 版本不受理", `${causePrefix}:glb_version`, "提供 GLB 2.0");
  if (declared !== buf.length) throw invalid("GLB 长度不匹配", `${causePrefix}:glb_length`, "提供完整 GLB");
  let offset = 12;
  let jsonDoc: unknown;
  let sawJson = false;
  let sawBin = false;
  while (offset + 8 <= buf.length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (chunkLength % 4 !== 0 || dataEnd > buf.length) {
      throw invalid("GLB chunk 非法", `${causePrefix}:glb_chunk`, "提供完整 GLB");
    }
    const payload = buf.subarray(dataStart, dataEnd);
    if (chunkType === GLB_JSON_CHUNK) {
      if (sawJson) throw invalid("GLB 多个 JSON chunk", `${causePrefix}:glb_json_dup`, "提供有效 GLB");
      try {
        jsonDoc = JSON.parse(payload.toString("utf8").replace(/\0+$/g, "").trim());
      } catch {
        throw invalid("GLB JSON 无法解析", `${causePrefix}:glb_json`, "提供有效 GLB");
      }
      if (!jsonDoc || typeof jsonDoc !== "object" || Array.isArray(jsonDoc)) {
        throw invalid("GLB JSON 根必须是对象", `${causePrefix}:glb_json_root`, "提供有效 GLB");
      }
      sawJson = true;
    } else if (chunkType === GLB_BIN_CHUNK) {
      if (sawBin) throw invalid("GLB 多个 BIN chunk", `${causePrefix}:glb_bin_dup`, "提供有效 GLB");
      sawBin = true;
    }
    offset = dataEnd;
  }
  if (offset !== buf.length) throw invalid("GLB 尾部不完整", `${causePrefix}:glb_trailing`, "提供完整 GLB");
  if (!sawJson) throw invalid("GLB 缺少 JSON chunk", `${causePrefix}:glb_json_missing`, "提供有效 GLB");
}

export function contentFingerprint(
  files: Array<{ key: string; sha256: string }>,
  faces: Record<string, string>,
): string {
  const filePart = [...files]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((f) => `${f.key}:${f.sha256}`)
    .join("|");
  const facePart = FACES.map((face) => `${face}:${faces[face] || ""}`).join("|");
  return sha256Text(`${filePart}\n${facePart}`);
}

function fsyncFile(path: string): void {
  // r+ 会跟随 symlink；nlink>1 的 hardlink 会把 fsync 作用到 jail 外同一 inode。
  const st = lstatIfExists(path);
  if (!st || st.isSymbolicLink() || !st.isFile()) {
    throw invalid("同步目标不是普通文件", "fsync_target", "不要用 symlink 当任务目录");
  }
  if (st.nlink !== 1) {
    throw invalid("拒绝 hardlink 外部写入", "hardlink", "索引/清单/cursor 不能 hardlink 到外部文件");
  }
  const fd = openSync(path, fsConstants.O_RDWR | noFollowFlag());
  try {
    const opened = fstatSync(fd);
    if (opened.nlink !== 1 || !opened.isFile()) {
      throw invalid("拒绝 hardlink 外部写入", "hardlink", "索引/清单/cursor 不能 hardlink 到外部文件");
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function tryFsyncDir(path: string): "ok" | "unsupported" {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return "ok";
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (process.platform === "win32" && (code === "EPERM" || code === "EINVAL" || code === "EBADF" || code === "EISDIR")) {
      return "unsupported";
    }
    if (code === "EPERM" || code === "EINVAL" || code === "EBADF") return "unsupported";
    throw err;
  }
}

function defaultProbeDisk(root: string): DiskSpaceProbe {
  const st = statfsSync(root);
  const bavail = Number(st.bavail);
  const bsize = Number(st.bsize);
  if (!Number.isFinite(bavail) || !Number.isFinite(bsize) || bsize <= 0 || bavail < 0) {
    throw diskGuard("无法读取磁盘余量", "statfs_invalid", "检查文件系统或注入 probeDisk");
  }
  return { availableBytes: bavail * bsize, source: "statfs" };
}

function asRecord(value: unknown, cause: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("代际清单字段类型错误", cause, "保留当前代并检查 generation.json");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, cause: string): string {
  if (typeof value !== "string" || !value) throw invalid("代际清单字段类型错误", cause, "保留当前代并检查 generation.json");
  return value;
}

function asFiniteInt(value: unknown, cause: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalid("代际清单字段类型错误", cause, "保留当前代并检查 generation.json");
  }
  return value;
}

function assertExactKeys(obj: Record<string, unknown>, allowed: Set<string>, cause: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw invalid("代际清单含未知字段", `${cause}:${key}`, "保留当前代");
  }
}

type FileRow = { key: string; name: string; sha256: string; bytes: number; rel: string };
type FaceRow = { sha256: string; name: string };
type QualityBlock = {
  verifier_status: "accepted" | "rejected";
  quality_status: RenderGenerationQualityStatus;
  verifier: string;
  generation_id: string;
  contract_sha256: string;
  content_fingerprint: string;
  note: string;
};
type Manifest = {
  schema: typeof RENDER_GENERATION_SCHEMA;
  generation_id: string;
  mode: RenderGenerationMode;
  profile: string;
  created_at: string;
  contract_sha256: string;
  status: "ready";
  quality: QualityBlock;
  faces: Record<RenderFace, FaceRow>;
  files: FileRow[];
  optional_omitted: OptionalOmitted[];
  total_bytes: number;
  actor_label?: string;
};

export type RenderActivationFact = {
  event_id: string;
  from_generation_id: string;
  generation_id: string;
  mode: "activate" | "legacy_relight" | "upgrade";
  at: string;
  actor_id: string;
};

type IndexEvent = {
  schema: typeof RENDER_GENERATION_INDEX_SCHEMA;
  event: "ready" | "recovered" | "activated";
  generation_id: string;
  at: string;
  seq: number;
  activation?: RenderActivationFact;
};

function parseQuality(raw: unknown): QualityBlock {
  const obj = asRecord(raw, "quality");
  assertExactKeys(obj, QUALITY_KEYS, "quality");
  const verifierStatus = asString(obj.verifier_status, "quality.verifier_status");
  if (verifierStatus !== "accepted" && verifierStatus !== "rejected") {
    throw invalid("质量结果非法", "quality.verifier_status", "保留当前代");
  }
  const qualityStatus = asString(obj.quality_status, "quality.quality_status");
  if (qualityStatus !== "unwired" && qualityStatus !== "failed" && qualityStatus !== "runtime_verified") {
    throw invalid("质量状态非法", "quality.quality_status", "保留当前代");
  }
  return {
    verifier_status: verifierStatus,
    quality_status: qualityStatus,
    verifier: asString(obj.verifier, "quality.verifier"),
    generation_id: asString(obj.generation_id, "quality.generation_id"),
    contract_sha256: asString(obj.contract_sha256, "quality.contract_sha256"),
    content_fingerprint: asString(obj.content_fingerprint, "quality.content_fingerprint"),
    note: asString(obj.note, "quality.note"),
  };
}

function parseManifest(raw: unknown): Manifest {
  const obj = asRecord(raw, "manifest");
  assertExactKeys(obj, MANIFEST_KEYS, "manifest");
  if (obj.schema !== RENDER_GENERATION_SCHEMA) throw invalid("代际 schema 不匹配", "schema", "保留当前代");
  const generationId = asString(obj.generation_id, "generation_id");
  if (!isGenerationId(generationId)) throw invalid("代际 id 与目录不一致", "generation_id", "保留当前代");
  const mode = asString(obj.mode, "mode");
  if (mode !== "legacy_import" && mode !== "legacy_relight" && mode !== "upgrade") {
    throw invalid("代际 mode 非法", "mode", "保留当前代");
  }
  const profile = asString(obj.profile, "profile");
  if (!PROFILE_RE.test(profile)) throw invalid("profile 非法", "profile", "保留当前代");
  const createdAt = asString(obj.created_at, "created_at");
  if (!ISO_RE.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) {
    throw invalid("created_at 非法", "created_at", "保留当前代");
  }
  const contractSha = asString(obj.contract_sha256, "contract_sha256");
  if (!SHA256_RE.test(contractSha)) throw invalid("合同 SHA 非法", "contract_sha256", "保留当前代");
  if (obj.status !== "ready") throw invalid("代际状态不是 ready", "status", "保留当前代");
  const quality = parseQuality(obj.quality);
  if (quality.generation_id !== generationId || quality.contract_sha256 !== contractSha) {
    throw invalid("质量结果未绑定本代身份", "quality_identity", "保留当前代");
  }
  const facesRaw = asRecord(obj.faces, "faces");
  const faces = {} as Record<RenderFace, FaceRow>;
  for (const face of FACES) {
    const row = asRecord(facesRaw[face], `faces.${face}`);
    assertExactKeys(row, FACE_ROW_KEYS, `faces.${face}`);
    const sha = asString(row.sha256, `faces.${face}.sha256`);
    if (!SHA256_RE.test(sha)) throw invalid("六面 SHA 非法", `faces.${face}.sha256`, "保留当前代");
    const name = asString(row.name, `faces.${face}.name`);
    if (name !== `panel_${face}.png`) throw invalid("六面文件名非法", `faces.${face}.name`, "保留当前代");
    faces[face] = { sha256: sha, name };
  }
  if (Object.keys(facesRaw).length !== FACES.length) throw invalid("六面字段不完整", "faces", "保留当前代");
  if (!Array.isArray(obj.files)) throw invalid("files 必须是数组", "files", "保留当前代");
  const files: FileRow[] = [];
  const seen = new Set<string>();
  for (const item of obj.files) {
    const row = asRecord(item, "files[]");
    assertExactKeys(row, FILE_ROW_KEYS, "files[]");
    const key = asString(row.key, "files[].key");
    if (!ALLOWED_KEYS.has(key) || seen.has(key)) throw invalid("文件 key 非法或重复", "files[].key", "保留当前代");
    seen.add(key);
    const name = asString(row.name, "files[].name");
    if (looksLikePath(name) || name !== basename(name)) throw invalid("输出文件名非法", "files[].name", "保留当前代");
    const sha = asString(row.sha256, "files[].sha256");
    if (!SHA256_RE.test(sha)) throw invalid("文件 SHA 非法", "files[].sha256", "保留当前代");
    const rel = asString(row.rel, "files[].rel");
    if (rel !== `${OUTPUTS_DIR}/${name}`) throw invalid("输出相对路径非法", "files[].rel", "保留当前代");
    files.push({ key, name, sha256: sha, bytes: asFiniteInt(row.bytes, "files[].bytes"), rel });
  }
  for (const key of REQUIRED_KEYS) {
    if (!seen.has(key)) throw invalid("缺少必需输出", `missing_${key}`, "保留当前代");
  }
  let omitted: OptionalOmitted[] = [];
  if (obj.optional_omitted !== undefined) {
    if (!Array.isArray(obj.optional_omitted)) throw invalid("optional_omitted 必须是数组", "optional_omitted", "保留当前代");
    omitted = obj.optional_omitted.map((item, i) => {
      const row = asRecord(item, `optional_omitted[${i}]`);
      assertExactKeys(row, OMITTED_KEYS, "optional_omitted[]");
      return { key: asString(row.key, "optional_omitted[].key"), reason: asString(row.reason, "optional_omitted[].reason") };
    });
  }
  const actor = obj.actor_label === undefined ? undefined : asString(obj.actor_label, "actor_label");
  if (actor && looksLikePath(actor)) throw invalid("操作者字段不能是路径", "actor_label", "保留当前代");
  const expectedFp = contentFingerprint(
    files.map((f) => ({ key: f.key, sha256: f.sha256 })),
    Object.fromEntries(FACES.map((face) => [face, faces[face].sha256])),
  );
  if (quality.content_fingerprint !== expectedFp) {
    throw invalid("内容指纹与文件表不一致", "content_fingerprint", "保留当前代");
  }
  if (quality.verifier_status !== "accepted" || !["unwired", "runtime_verified"].includes(quality.quality_status)) {
    throw invalid("质量验证未接受，不能当 ready", "quality_rejected", "保留当前代");
  }
  return {
    schema: RENDER_GENERATION_SCHEMA,
    generation_id: generationId,
    mode,
    profile,
    created_at: createdAt,
    contract_sha256: contractSha,
    status: "ready",
    quality,
    faces,
    files,
    optional_omitted: omitted,
    total_bytes: asFiniteInt(obj.total_bytes, "total_bytes"),
    actor_label: actor,
  };
}

function parseIndexEvent(line: string): IndexEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(obj.event === "activated" ? ACTIVATION_KEYS : INDEX_KEYS).has(key)) return null;
  }
  if (obj.schema !== RENDER_GENERATION_INDEX_SCHEMA) return null;
  if (obj.event !== "ready" && obj.event !== "recovered" && obj.event !== "activated") return null;
  if (typeof obj.generation_id !== "string" || !isGenerationId(obj.generation_id)) return null;
  if (typeof obj.at !== "string" || !ISO_RE.test(obj.at)) return null;
  if (typeof obj.seq !== "number" || !Number.isInteger(obj.seq) || obj.seq < 1) return null;
  let activation: RenderActivationFact | undefined;
  if (obj.event === "activated") {
    if (typeof obj.event_id !== "string" || !/^a[a-f0-9]{32}$/.test(obj.event_id)
      || typeof obj.from_generation_id !== "string" || (!isGenerationId(obj.from_generation_id) && !VIRTUAL_ID_RE.test(obj.from_generation_id))
      || !["activate","legacy_relight","upgrade"].includes(String(obj.mode))
      || typeof obj.actor_id !== "string" || !obj.actor_id || obj.actor_id.length > 256) return null;
    activation = {event_id:obj.event_id,from_generation_id:obj.from_generation_id,generation_id:obj.generation_id,
      mode:obj.mode as RenderActivationFact["mode"],at:obj.at,actor_id:obj.actor_id};
  }
  return {
    schema: RENDER_GENERATION_INDEX_SCHEMA,
    event: obj.event,
    generation_id: obj.generation_id,
    at: obj.at,
    seq: obj.seq,
    activation,
  };
}

function readIndexFile(path: string): { events: IndexEvent[]; truncatedTail: boolean } {
  // lstat 父目录：.render-generations 若是 symlink，existsSync 会跟随并读到 jail 外。
  const parent = dirname(path);
  const parentStat = lstatIfExists(parent);
  if (!parentStat) return { events: [], truncatedTail: false };
  if (parentStat.isSymbolicLink()) throw invalid("拒绝符号链接", "symlink_dir", "不要用 symlink 当任务目录");
  if (!parentStat.isDirectory()) throw invalid("索引目录不是普通目录", "index_parent", "不要用 symlink 当任务目录");
  const lst = lstatIfExists(path);
  if (!lst) return { events: [], truncatedTail: false };
  if (lst.isSymbolicLink() || !lst.isFile()) throw invalid("索引不是普通文件", "index_not_file", "不要用路径式 cursor");
  const raw = readBoundedMetadata(path, INDEX_MAX_BYTES, "history_capacity").toString("utf8");
  if (!raw) return { events: [], truncatedTail: false };
  const trailingNewline = raw.endsWith("\n");
  const parts = raw.split("\n");
  if (trailingNewline) parts.pop();
  const events: IndexEvent[] = [];
  let truncatedTail = false;
  for (let i = 0; i < parts.length; i += 1) {
    const parsed = parseIndexEvent(parts[i] || "");
    if (!parsed) {
      if (i === parts.length - 1 && !trailingNewline) truncatedTail = true;
      continue;
    }
    events.push(parsed);
  }
  if (!trailingNewline) truncatedTail = true;
  return { events, truncatedTail };
}

/** Fixed bound on the held inode, not just a path stat followed by readFile. */
function readBoundedMetadata(path: string, maxBytes: number, cause: string): Buffer {
  const before = lstatSync(path);
  const problem = cause === "history_capacity" ? "索引容量已满" : "代际元数据非法";
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw invalid(problem,cause,"保留当前文件，核验元数据");
  }
  const fd = openSync(path,fsConstants.O_RDONLY | noFollowFlag());
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || opened.size !== before.size) {
      throw invalid(problem,cause,"保留当前文件，重新读取");
    }
    const buf = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buf.length) {
      const n = readSync(fd,buf,count,Math.min(1024*1024,buf.length-count),count);
      if (!n) break;
      count += n;
    }
    const after = fstatSync(fd);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw invalid(problem,cause,"保留当前文件，重新读取");
    }
    return buf.subarray(0,count);
  } finally { closeSync(fd); }
}

export function openRenderGenerationStore(opts: RenderGenerationStoreOptions): RenderGenerationStore {
  if (!opts || typeof opts.jobId !== "string" || !JOB_ID_RE.test(opts.jobId)) {
    throw invalid("job id 非法", "job_id", "传入服务端 12 位 hex 任务 id");
  }
  if (!opts.jobRoot || typeof opts.jobRoot !== "string" || !isAbsolute(opts.jobRoot)) {
    throw invalid("job 根必须是绝对路径", "job_root", "由服务端传入可信 job 根");
  }
  if (!existsSync(opts.jobRoot)) throw invalid("job 根不存在", "job_root_missing", "传入已存在的任务目录");
  const rootLstat = lstatSync(opts.jobRoot);
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
    throw invalid("job 根必须是普通目录", "job_root_not_dir", "传入可信任务目录");
  }
  const jobRoot = realpathSync(resolve(opts.jobRoot));
  const jobId = opts.jobId;
  const now = opts.now || (() => new Date());
  const randomBytes = opts.randomBytes || cryptoRandomBytes;
  const failpoints = opts.failpoints || {};
  const check = () => opts.lifecycle?.check("seal");

  function genDir(): string {
    return join(jobRoot, RENDER_GENERATION_DIR);
  }

  function readyDir(id: string): string {
    return join(genDir(), id);
  }

  function indexPath(): string {
    return join(genDir(), INDEX_NAME);
  }

  function cursorKeyPath(): string {
    return join(genDir(), CURSOR_KEY_NAME);
  }

  function jailRel(from: string, to: string, allowRoot = false): string {
    const rel = relative(from, to);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part === "..")) {
      throw invalid("路径越出任务目录", "path_escape", "只使用任务目录内文件");
    }
    if (!rel && !allowRoot) throw invalid("路径越出任务目录", "path_escape", "只使用任务目录内文件");
    return rel;
  }

  function splitRelParts(target: string): string[] {
    const full = resolve(target);
    jailRel(jobRoot, full, true);
    const rel = relative(jobRoot, full);
    if (!rel) return [];
    return rel.split(/[\\/]/).filter((part) => part && part !== ".");
  }

  function assertSafePart(part: string): void {
    if (!part || part === "." || part === ".." || /[\\/]/.test(part)) {
      throw invalid("路径越出任务目录", "path_escape", "只使用任务目录内文件");
    }
  }

  // recursive mkdir 会跟随目录 symlink，在 jail 外创建 staging/index/cursor。
  // 任何 mkdir 或 index/cursor 写入前，按词法分量 lstat 祖先与目标。
  function assertNoSymlinkChain(target: string, opts: { targetMayBeMissing?: boolean } = {}): void {
    const full = resolve(target);
    const parts = splitRelParts(full);
    let current = jobRoot;
    const rootStat = lstatSync(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw invalid("job 根必须是普通目录", "job_root_not_dir", "传入可信任务目录");
    }
    jailRel(jobRoot, realpathSync(current), true);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part) continue;
      assertSafePart(part);
      const next = join(current, part);
      const st = lstatIfExists(next);
      const isLast = i === parts.length - 1;
      if (!st) {
        if (isLast && !opts.targetMayBeMissing) {
          throw invalid("路径越出任务目录", "path_escape", "只使用任务目录内文件");
        }
        return;
      }
      if (st.isSymbolicLink()) {
        throw invalid(
          "拒绝符号链接",
          isLast && !st.isDirectory() ? "symlink" : "symlink_dir",
          "不要用 symlink 当任务目录",
        );
      }
      jailRel(jobRoot, realpathSync(next), st.isDirectory());
      current = next;
    }
  }

  function ensurePhysicalDir(target: string): string {
    const full = resolve(target);
    const parts = splitRelParts(full);
    let current = jobRoot;
    const rootStat = lstatSync(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw invalid("job 根必须是普通目录", "job_root_not_dir", "传入可信任务目录");
    }
    jailRel(jobRoot, realpathSync(current), true);
    for (const part of parts) {
      assertSafePart(part);
      const next = join(current, part);
      const st = lstatIfExists(next);
      if (!st) {
        mkdirSync(next);
        const created = lstatSync(next);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw invalid("拒绝符号链接", "symlink_dir", "不要用 symlink 当任务目录");
        }
        jailRel(jobRoot, realpathSync(next), true);
      } else {
        if (st.isSymbolicLink()) throw invalid("拒绝符号链接", "symlink_dir", "不要用 symlink 当任务目录");
        if (!st.isDirectory()) throw invalid("路径不是普通目录", "not_dir", "只使用任务目录内文件");
        jailRel(jobRoot, realpathSync(next), true);
      }
      current = next;
    }
    return current;
  }

  function peekGenDir(): "missing" | "dir" {
    const dir = genDir();
    const st = lstatIfExists(dir);
    if (!st) return "missing";
    if (st.isSymbolicLink()) throw invalid("拒绝符号链接", "symlink_dir", "不要用 symlink 当任务目录");
    if (!st.isDirectory()) throw invalid("代际根不是普通目录", "gen_dir_not_dir", "不要用 symlink 当任务目录");
    jailRel(jobRoot, realpathSync(dir), true);
    return "dir";
  }

  function assertPhysicalFileForWrite(path: string): void {
    assertNoSymlinkChain(path, { targetMayBeMissing: true });
    const st = lstatIfExists(path);
    if (!st) return;
    if (st.isSymbolicLink()) throw invalid("拒绝符号链接", "symlink", "用普通文件，不要 symlink");
    if (!st.isFile()) throw invalid("目标不是普通文件", "not_file", "不要用 symlink 当任务目录");
    if (st.nlink !== 1) throw invalid("拒绝 hardlink 外部写入", "hardlink", "索引/清单/cursor 不能 hardlink 到外部文件");
    jailRel(jobRoot, realpathSync(path));
  }

  // 写入前目标必须不存在：writeFile 会跟随 symlink，append 会改 hardlink 的外部 inode。
  function assertTargetAbsent(path: string, cause: string): void {
    assertNoSymlinkChain(path, { targetMayBeMissing: true });
    if (lstatIfExists(path)) {
      throw invalid("拒绝覆盖既存目标", cause, "每次固化独占新建，不能覆盖 symlink/hardlink/普通文件");
    }
  }

  function mkdirExclusive(path: string, cause: string): void {
    assertTargetAbsent(path, cause);
    try {
      mkdirSync(path);
    } catch (err) {
      mapUnsafeWriteError(err, cause);
    }
    const created = lstatSync(path);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw invalid("拒绝符号链接", "symlink_dir", "不要用 symlink 当任务目录");
    }
    jailRel(jobRoot, realpathSync(path), true);
  }

  function writeFileExclusive(path: string, data: string | Buffer, opts?: { mode?: number; cause?: string }): void {
    check();
    const cause = opts?.cause || "target_exists";
    assertTargetAbsent(path, cause);
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    chargeWrite(buf.length);
    const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag();
    const fd = openWriteFd(path, flags, cause, opts?.mode ?? 0o644);
    try {
      writeAllSync(fd, buf);
      fsyncSync(fd);
      check();
    } finally {
      closeSync(fd);
    }
    const written = lstatSync(path);
    if (written.isSymbolicLink() || !written.isFile() || written.nlink !== 1) {
      throw invalid("拒绝 hardlink 外部写入", "hardlink", "索引/清单/cursor 不能 hardlink 到外部文件");
    }
    jailRel(jobRoot, realpathSync(path));
  }

  function appendFileExclusive(path: string, data: string): void {
    check();
    assertNoSymlinkChain(path, { targetMayBeMissing: true });
    const st = lstatIfExists(path);
    if (!st) {
      writeFileExclusive(path, data, { cause: "index_exists" });
      return;
    }
    if (st.isSymbolicLink()) throw invalid("拒绝符号链接", "symlink", "用普通文件，不要 symlink");
    if (!st.isFile()) throw invalid("目标不是普通文件", "not_file", "不要用 symlink 当任务目录");
    if (st.nlink !== 1) throw invalid("拒绝 hardlink 外部写入", "hardlink", "索引/清单/cursor 不能 hardlink 到外部文件");
    jailRel(jobRoot, realpathSync(path));
    const buf = Buffer.from(data, "utf8");
    chargeWrite(buf.length);
    const fd = openWriteFd(path, fsConstants.O_APPEND | fsConstants.O_WRONLY | noFollowFlag(), "hardlink");
    try {
      const opened = fstatSync(fd);
      if (opened.nlink !== 1 || !opened.isFile()) {
        throw invalid("拒绝 hardlink 外部写入", "hardlink", "索引/清单/cursor 不能 hardlink 到外部文件");
      }
      writeAllSync(fd, buf);
      fsyncSync(fd);
      check();
    } finally {
      closeSync(fd);
    }
  }

  function copyFileExclusive(srcPath: string, dest: string, cause: string): void {
    check();
    assertInside(dest);
    assertTargetAbsent(dest, cause);
    const before = lstatSync(srcPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size > RENDER_GENERATION_MAX_FILE_BYTES) throw invalid("复制源非法", cause, "检查源文件");
    const source = openSync(srcPath, fsConstants.O_RDONLY | noFollowFlag());
    try {
      const opened = fstatSync(source);
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw invalid("复制源已变化", cause, "重新验证");
      const target = openWriteFd(dest, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(), cause);
      try {
        const chunk = Buffer.alloc(1024 * 1024);
        let count = 0;
        while (true) {
          check();
          const n = readSync(source, chunk, 0, chunk.length, null);
          if (!n) break;
          count += n;
          if (count > before.size) throw invalid("复制源增长", cause, "重新验证");
          chargeWrite(n);
          writeAllSync(target, chunk.subarray(0, n));
        }
        const after = fstatSync(source);
        if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw invalid("复制源已变化", cause, "重新验证");
        }
        check();
      } finally { closeSync(target); }
    } catch (err) {
      mapUnsafeWriteError(err, cause);
    } finally { closeSync(source); }
    const destStat = lstatSync(dest);
    if (destStat.isSymbolicLink() || !destStat.isFile()) {
      throw invalid("复制结果不是普通文件", cause, "不要使用 hardlink/symlink");
    }
    if (destStat.nlink !== 1) {
      throw invalid("拒绝 hardlink 外部写入", "hardlink", "必须复制字节，不能 hardlink");
    }
  }

  function chargeWrite(bytes: number): void { opts.lifecycle?.beforeWrite(bytes); }

  function assertInside(candidate: string): string {
    const full = resolve(candidate);
    jailRel(jobRoot, full, true);
    assertNoSymlinkChain(full, { targetMayBeMissing: true });
    const lst = lstatIfExists(full);
    if (lst) {
      if (lst.isSymbolicLink()) throw invalid("拒绝符号链接", "symlink", "用普通文件，不要 symlink");
      jailRel(jobRoot, realpathSync(full), lst.isDirectory());
      return lst.isDirectory() ? realpathSync(full) : full;
    }
    const parent = dirname(full);
    const parentStat = lstatIfExists(parent);
    if (!parentStat) throw invalid("路径越出任务目录", "path_escape", "只使用任务目录内文件");
    if (parentStat.isSymbolicLink()) throw invalid("拒绝符号链接", "symlink_dir", "不要用 symlink 当任务目录");
    if (!parentStat.isDirectory()) throw invalid("路径不是普通目录", "not_dir", "只使用任务目录内文件");
    const realParent = realpathSync(parent);
    jailRel(jobRoot, realParent, true);
    const name = basename(full);
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
      throw invalid("路径越出任务目录", "path_escape", "只使用任务目录内文件");
    }
    return join(realParent, name);
  }

  function assertExistingInside(candidate: string): { path: string; ino: string; size: number } {
    const full = resolve(candidate);
    if (!existsSync(full)) throw invalid("源文件不存在", "missing_source", "提供任务目录内普通文件");
    const lst = lstatSync(full);
    if (lst.isSymbolicLink()) throw invalid("拒绝符号链接", "symlink", "用普通文件，不要 symlink");
    if (!lst.isFile()) throw invalid("源不是普通文件", "not_file", "提供普通文件");
    let real = full;
    try {
      real = realpathSync(full);
    } catch {
      throw invalid("无法解析源路径", "realpath", "检查文件是否越界");
    }
    jailRel(jobRoot, real);
    return { path: real, ino: `${lst.dev}:${lst.ino}`, size: lst.size };
  }

  function isoNow(): string {
    return now().toISOString();
  }

  function probe(): DiskSpaceProbe {
    if (opts.probeDisk) {
      const disk = opts.probeDisk();
      if (!disk || disk.source !== "injected" || !Number.isFinite(disk.availableBytes) || disk.availableBytes < 0) {
        throw diskGuard("注入的磁盘余量无效", "probe_injected_invalid", "测试注入须标明 source=injected");
      }
      return disk;
    }
    return defaultProbeDisk(jobRoot);
  }

  function discoverSources(): RenderGenerationSource[] {
    const found: RenderGenerationSource[] = [];
    const seen = new Set<string>();
    let count = 0;
    const walk = (dir: string, depth = 0) => {
      if (depth > 6) throw invalid("输出目录超过读取预算","source_budget","核验任务目录");
      if (!existsSync(dir)) return;
      const lst = lstatSync(dir);
      if (lst.isSymbolicLink()) throw invalid("拒绝目录符号链接", "symlink_dir", "不要用 symlink 当任务目录");
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (++count > 256) throw invalid("输出目录超过读取预算","source_budget","核验任务目录");
        const p = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || entry.name === "assets") continue;
          walk(p, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const key = outputKeyFromName(entry.name);
        if (!key || !ALLOWED_KEYS.has(key)) continue;
        if (seen.has(key)) throw invalid("输出 key 重复", `duplicate_${key}`, "每把 key 只保留一个文件");
        seen.add(key);
        found.push({ key, path: p });
      }
    };
    walk(jobRoot);
    return found;
  }

  function holdAndHash(path: string, key: string, validate = true): HeldGenerationFile {
    check();
    assertNoSymlinkChain(path);
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) throw invalid("输出不是普通文件", `${key}:not_file`, "复制必须得到普通文件");
    // Legacy identity must distinguish a damaged optional file from a missing one.
    // Serving files and validating required/ready outputs still reject empty bytes.
    const identityOnlyOptional = !validate && !(REQUIRED_KEYS as readonly string[]).includes(key);
    if ((st.size === 0 && !identityOnlyOptional) || st.size > RENDER_GENERATION_MAX_FILE_BYTES) {
      throw invalid("输出体积非法", `${key}:size`, "检查文件大小");
    }
    const buf = Buffer.alloc(st.size);
    const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
    try {
      const opened = fstatSync(fd);
      if (opened.ino !== st.ino || opened.dev !== st.dev || opened.nlink !== 1) throw invalid("读取身份变化", `${key}:changed`, "重新验证");
      let position = 0;
      while (position < buf.length) {
        check();
        const n = readSync(fd, buf, position, Math.min(1024 * 1024, buf.length - position), position);
        if (!n) throw invalid("读取长度不一致", `${key}:short_read`, "重试复制");
        position += n;
      }
      const after = fstatSync(fd);
      if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw invalid("读取期间变化", `${key}:changed`, "重新验证");
      check();
      if (validate) {
        if (key === "glb") assertGlb(buf, key);
        else assertPng(buf, key);
      }
      const hash = createHash("sha256");
      for (let p = 0; p < buf.length; p += 1024 * 1024) { check(); hash.update(buf.subarray(p, p + 1024 * 1024)); }
      check();
      let closed = false;
      return { fd, name:basename(path), sha256:hash.digest("hex"), bytes:buf.length,
        close:() => { if (!closed) { closed = true; closeSync(fd); } } };
    } catch (error) { closeSync(fd); throw error; }
  }

  function hashAndValidate(path: string, key: string): { sha256: string; bytes: number } {
    const held = holdAndHash(path,key);
    try { return {sha256:held.sha256, bytes:held.bytes}; } finally { held.close(); }
  }

  function readFaces(): Record<RenderFace, FaceRow> {
    const faces = {} as Record<RenderFace, FaceRow>;
    const inodes = new Set<string>();
    for (const face of FACES) {
      const name = `panel_${face}.png`;
      const path = join(jobRoot, "assets", name);
      const meta = assertExistingInside(path);
      if (inodes.has(meta.ino)) throw invalid("六面文件 inode 重复", `face_inode_${face}`, "每面必须是独立文件");
      inodes.add(meta.ino);
      const hashed = hashAndValidate(meta.path, `face_${face}`);
      faces[face] = { sha256: hashed.sha256, name };
    }
    return faces;
  }

  function legacySnapshot() {
    const sources = discoverSources();
    const rows = [...ALLOWED_KEYS].sort().map((key) => {
      const src = sources.find((item) => item.key === key);
      if (!src) {
        if ((REQUIRED_KEYS as readonly string[]).includes(key)) throw invalid("缺少必需输出，无法计算虚拟当前代", `missing_${key}`, "补齐产品 PNG 和 GLB");
        return {key,missing:true};
      }
      const meta = assertExistingInside(src.path);
      const held = holdAndHash(meta.path,key,(REQUIRED_KEYS as readonly string[]).includes(key));
      try { return {key, sha256:held.sha256, bytes:held.bytes, path:meta.path}; } finally { held.close(); }
    });
    const digest = sha256Text(JSON.stringify({schema:"legacy-current/2",jobId,
      files:rows.map(({path: _path,...identity}) => identity)}));
    return {id:`legacy-current-v2-${digest}`, rows};
  }

  function virtualLegacyCurrentId(): string { return legacySnapshot().id; }

  function openFile(generationId: string, key: string): HeldGenerationFile {
    assertSafeId(generationId,"generation_id");
    if (!ALLOWED_KEYS.has(key)) throw invalid("本代没有这张图","generation_missing","只读取本代公开资源");
    let row;
    if (VIRTUAL_ID_RE.test(generationId)) {
      const snapshot = legacySnapshot();
      if (snapshot.id !== generationId) throw stale("legacy_identity_changed");
      row = snapshot.rows.find(item => item.key === key && item.path);
    } else {
      const manifest = loadVerifiedManifest(generationId);
      const found = manifest.files.find(item => item.key === key);
      row = found ? {...found,path:resolve(readyDir(generationId),found.rel)} : undefined;
    }
    if (!row?.path) throw invalid("本代没有这张图","generation_missing","只读取本代公开资源");
    const held = holdAndHash(row.path,key);
    if (held.sha256 !== row.sha256 || held.bytes !== row.bytes) {
      held.close(); throw stale("file_identity_changed");
    }
    return held;
  }

  function assertPointer(id: string | null): void {
    if (id === null) return;
    assertSafeId(id, "pointer_id");
  }

  function assertExpectedCurrent(expected: string | null, observed: string | null): void {
    assertPointer(expected);
    assertPointer(observed);
    if (observed === null) {
      const virtual = virtualLegacyCurrentId();
      if (expected !== virtual) throw stale("expected_current_mismatch");
      return;
    }
    if (expected !== observed) throw stale("expected_current_mismatch");
    if (!isGenerationId(observed) || !readyExists(observed)) throw stale("observed_current_missing");
  }

  function readyExists(id: string): boolean {
    if (!isGenerationId(id)) return false;
    if (peekGenDir() === "missing") return false;
    const dir = readyDir(id);
    const st = lstatIfExists(dir);
    return Boolean(st && st.isDirectory() && !st.isSymbolicLink());
  }

  function listReadyIds(): string[] {
    if (peekGenDir() === "missing") return [];
    const dir = genDir();
    const ids: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (isGenerationId(entry.name)) ids.push(entry.name);
    }
    return ids;
  }

  function nextGenerationId(mode: RenderGenerationMode, contractSha: string): string {
    if (mode === "legacy_import") return G0_LEGACY_ORIGINAL_ID;
    let maxSeq = 0;
    for (const id of listReadyIds()) {
      const match = /^g(\d+)-/.exec(id);
      if (!match) continue;
      const seq = Number(match[1]);
      if (seq > maxSeq) maxSeq = seq;
    }
    const seq = maxSeq + 1;
    if (seq < 1) throw invalid("代次计算失败", "seq", "不要传入路径式 id");
    const rand = randomBytes(4).toString("hex");
    const id = `g${seq}-${modeSlug(mode)}-${contractSha.slice(0, 8)}-${rand}`;
    if (!GEN_ID_RE.test(id) || looksLikePath(id)) throw invalid("生成的代际 id 非法", "generated_id", "由服务端重新生成");
    return id;
  }

  function readCursorKey(): Buffer {
    assertNoSymlinkChain(cursorKeyPath(), { targetMayBeMissing: true });
    const path = cursorKeyPath();
    assertPhysicalFileForWrite(path);
    const existing = lstatIfExists(path);
    if (!existing) {
      return createHmac("sha256",READ_CURSOR_SECRET).update(jobId).digest();
    }
    const written = lstatSync(path);
    if (written.isSymbolicLink() || !written.isFile() || written.nlink !== 1) {
      throw invalid("拒绝 hardlink 外部写入", written.isSymbolicLink() ? "symlink" : "hardlink", "不要把 cursor 做成指向外部的 symlink/hardlink");
    }
    const raw = readBoundedMetadata(path,128,"cursor_key").toString("utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(raw)) throw invalid("cursor 密钥损坏", "cursor_key", "不要使用伪造 cursor");
    return Buffer.from(raw, "hex");
  }

  function encodeCursor(seq: number, generationId: string): string {
    const key = readCursorKey();
    const payload = `${jobId}:${seq}:${generationId}`;
    const mac = createHmac("sha256", key).update(payload).digest("base64url");
    return `${Buffer.from(payload).toString("base64url")}.${mac}`;
  }

  function decodeCursor(cursor: string): { seq: number; generationId: string } {
    if (typeof cursor !== "string" || !cursor || cursor.length > 512 || looksLikePath(cursor)) {
      throw invalid("cursor 非法", "cursor_invalid", "使用本单签发的 cursor");
    }
    const parts = cursor.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid("cursor 非法", "cursor_invalid", "使用本单签发的 cursor");
    let payload = "";
    try {
      payload = Buffer.from(parts[0], "base64url").toString("utf8");
    } catch {
      throw invalid("cursor 非法", "cursor_invalid", "使用本单签发的 cursor");
    }
    const key = readCursorKey();
    const expectedMac = createHmac("sha256", key).update(payload).digest();
    let givenMac: Buffer;
    try {
      givenMac = Buffer.from(parts[1], "base64url");
    } catch {
      throw invalid("cursor 非法", "cursor_invalid", "使用本单签发的 cursor");
    }
    if (givenMac.length !== expectedMac.length || !timingSafeEqual(expectedMac, givenMac)) {
      throw invalid("cursor 非法", "cursor_invalid", "使用本单签发的 cursor");
    }
    const match =
      /^([0-9a-f]{12}):([1-9][0-9]*):(g0-legacy-original|g[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}-[a-f0-9]{8})$/.exec(
        payload,
      );
    if (!match || match[1] !== jobId) throw invalid("cursor 非法", "cursor_invalid", "使用本单签发的 cursor");
    return { seq: Number(match[2]), generationId: match[3] };
  }

  function appendIndex(event: "ready" | "recovered", generationId: string): void {
    assertNoSymlinkChain(indexPath(), { targetMayBeMissing: true });
    ensurePhysicalDir(genDir());
    const path = indexPath();
    assertPhysicalFileForWrite(path);
    const { events, truncatedTail } = readIndexFile(path);
    if (events.some((item) => item.generation_id === generationId && (item.event === "ready" || item.event === "recovered"))) {
      return;
    }
    const seq = events.reduce((max, item) => (item.seq > max ? item.seq : max), 0) + 1;
    const record: IndexEvent = {
      schema: RENDER_GENERATION_INDEX_SCHEMA,
      event,
      generation_id: generationId,
      at: isoNow(),
      seq,
    };
    const prefix = truncatedTail ? "\n" : "";
    assertHistoryWritable(Buffer.byteLength(`${prefix}${JSON.stringify(record)}\n`));
    appendFileExclusive(path, `${prefix}${JSON.stringify(record)}\n`);
  }

  function assertHistoryWritable(additionalBytes = 2048): void {
    readIndexFile(indexPath());
    const size = Number(lstatIfExists(indexPath())?.size ?? 0);
    if (size + additionalBytes > INDEX_MAX_BYTES) throw invalid("索引容量已满","history_capacity","保留当前代，停止新增写入");
  }

  function hasActivation(fact: RenderActivationFact): boolean {
    const record = {schema:RENDER_GENERATION_INDEX_SCHEMA,event:"activated",...fact,seq:1};
    if (!parseIndexEvent(JSON.stringify(record))) throw invalid("切换记账无效","audit_pending","保留当前代及待记账事实");
    const existing = readIndexFile(indexPath()).events.find(row => row.activation?.event_id === fact.event_id)?.activation;
    if (!existing) return false;
    if (Object.keys(fact).some(key => existing[key as keyof RenderActivationFact] !== fact[key as keyof RenderActivationFact])) {
      throw invalid("切换记账冲突","audit_pending","保留当前代及待记账事实");
    }
    return true;
  }

  function appendActivation(fact: RenderActivationFact): void {
    if (hasActivation(fact)) return;
    const path = indexPath();
    assertNoSymlinkChain(path,{targetMayBeMissing:true});
    ensurePhysicalDir(genDir());
    assertPhysicalFileForWrite(path);
    const {events,truncatedTail} = readIndexFile(path);
    const record = {schema:RENDER_GENERATION_INDEX_SCHEMA,event:"activated",...fact,
      seq:events.reduce((max,row) => Math.max(max,row.seq),0)+1};
    const line = `${truncatedTail ? "\n" : ""}${JSON.stringify(record)}\n`;
    assertHistoryWritable(Buffer.byteLength(line));
    appendFileExclusive(path,line);
  }

  function loadVerifiedManifest(id: string): Manifest {
    assertSafeId(id, "generation_id");
    if (!isGenerationId(id)) throw invalid("代际 id 非法", "generation_id", "只使用服务端公开的代际 id");
    if (peekGenDir() === "missing") throw invalid("代际不存在", "generation_missing", "保留当前代");
    const dir = readyDir(id);
    assertNoSymlinkChain(dir, { targetMayBeMissing: true });
    const dirStat = lstatIfExists(dir);
    if (!dirStat) throw invalid("代际不存在", "generation_missing", "保留当前代");
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw invalid("代际目录非法", "generation_dir", "保留当前代");
    if (basename(dir) !== id) throw invalid("代际 id 与目录不一致", "id_dir_mismatch", "保留当前代");
    const manifestPath = join(dir, MANIFEST_NAME);
    const manifestMeta = assertExistingInside(manifestPath);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(readBoundedMetadata(manifestMeta.path,1024*1024,"manifest_budget").toString("utf8"));
    } catch {
      throw invalid("代际清单无法解析", "manifest_json", "保留当前代");
    }
    const parsed = parseManifest(parsedJson);
    if (parsed.generation_id !== id) throw invalid("代际 id 与目录不一致", "id_dir_mismatch", "保留当前代");
    const seenInodes = new Set<string>();
    for (const row of parsed.files) {
      const filePath = join(dir, row.rel.split("/").join(sep));
      const meta = assertExistingInside(filePath);
      if (basename(meta.path) !== row.name) throw invalid("输出文件名不一致", `file_name_${row.key}`, "保留当前代");
      if (seenInodes.has(meta.ino)) throw invalid("输出 inode 重复", `file_inode_${row.key}`, "保留当前代");
      seenInodes.add(meta.ino);
      const hashed = hashAndValidate(meta.path, row.key);
      if (hashed.sha256 !== row.sha256 || hashed.bytes !== row.bytes) {
        throw invalid("输出内容与清单不一致", `hash_mismatch_${row.key}`, "保留当前代");
      }
    }
    // 历史读取只核 ready 输出与清单内记录的六面 SHA；不把当前共享 assets 当历史有效性条件。
    const fp = contentFingerprint(
      parsed.files.map((f) => ({ key: f.key, sha256: f.sha256 })),
      Object.fromEntries(FACES.map((face) => [face, parsed.faces[face].sha256])),
    );
    if (fp !== parsed.quality.content_fingerprint) {
      throw invalid("内容指纹失效", "content_fingerprint", "保留当前代");
    }
    if (parsed.total_bytes !== parsed.files.reduce((sum, f) => sum + f.bytes, 0)) {
      throw invalid("总字节与文件表不一致", "total_bytes", "保留当前代");
    }
    return parsed;
  }

  // 贴图变化后旧代仍可查看/激活；用该代继续重渲必须单独证明当前六面仍与源代绑定一致。
  function assertRerenderSourceFresh(sourceId?: string): void {
    const manifest = sourceId === undefined ? undefined : loadVerifiedManifest(sourceId);
    let live: Record<RenderFace, FaceRow>;
    try {
      live = readFaces();
    } catch {
      throw invalid("贴图已缺失，不能用旧代继续重渲", "rerender_source_missing", "查看历史仍可用；补齐当前六面后再重渲");
    }
    // An unarchived legacy job has no source manifest yet; validate its six faces without importing g0.
    if (!manifest) return;
    for (const face of FACES) {
      if (live[face].sha256 !== manifest.faces[face].sha256) {
        throw invalid("贴图已变化，不能用旧代继续重渲", `rerender_source_unfresh_${face}`, "查看历史仍可用；不能拿旧代继续重渲");
      }
    }
  }

  function patchFromManifest(manifest: Manifest): RenderGenerationPatch {
    return {
      current_render_generation_id: manifest.generation_id,
      files: manifest.files.map((row) => ({
        key: row.key,
        name: row.name,
        path: resolve(readyDir(manifest.generation_id), row.rel.split("/").join(sep)),
      })),
    };
  }

  function publicFromManifest(manifest: Manifest, currentGenerationId: string | null): PublicGenerationSummary {
    const summary: PublicGenerationSummary = {
      generation_id: manifest.generation_id,
      mode: manifest.mode,
      profile: manifest.profile,
      created_at: manifest.created_at,
      quality_status: manifest.quality.quality_status,
      current: currentGenerationId === manifest.generation_id,
    };
    if (manifest.actor_label) summary.actor_label = manifest.actor_label;
    return summary;
  }

  function sealGeneration(input: SealGenerationInput): SealResult {
    check();
    if (!input || (input.mode !== "legacy_import" && input.mode !== "legacy_relight" && input.mode !== "upgrade")) {
      throw invalid("mode 非法", "mode", "只使用 legacy_import / legacy_relight / upgrade");
    }
    if (!input.profile || !PROFILE_RE.test(input.profile) || looksLikePath(input.profile)) {
      throw invalid("profile 非法", "profile", "由服务端传入已登记 profile 名");
    }
    if (!input.contractSha256 || !SHA256_RE.test(input.contractSha256)) {
      throw invalid("合同 SHA 非法", "contract_sha256", "传入服务端计算的合同哈希");
    }
    if (input.contractBytes) {
      const hashed = sha256Buffer(input.contractBytes);
      if (hashed !== input.contractSha256) throw invalid("合同 SHA 与字节不一致", "contract_bytes", "不要自报哈希");
    }
    if (input.actorLabel !== undefined && (typeof input.actorLabel !== "string" || !input.actorLabel || looksLikePath(input.actorLabel))) {
      throw invalid("操作者字段非法", "actor_label", "只传显示名");
    }
    peekGenDir();
    assertNoSymlinkChain(indexPath(), { targetMayBeMissing: true });
    assertNoSymlinkChain(cursorKeyPath(), { targetMayBeMissing: true });
    assertPhysicalFileForWrite(indexPath());
    assertPhysicalFileForWrite(cursorKeyPath());
    assertHistoryWritable();
    assertExpectedCurrent(input.expectedCurrentGenerationId, input.observedCurrentGenerationId);
    if (input.mode === "legacy_import") {
      if (input.observedCurrentGenerationId !== null) throw stale("legacy_import_after_current");
    } else if (input.observedCurrentGenerationId === null) {
      throw stale("missing_current_for_new_generation");
    } else {
      assertRerenderSourceFresh(input.observedCurrentGenerationId);
    }

    const generationId = nextGenerationId(input.mode, input.contractSha256);
    if (readyExists(generationId)) throw invalid("该代已固化，拒绝重复写入", "duplicate_ready", "新动作必须生成新代");

    const sources = input.sources || (input.mode === "legacy_import" ? discoverSources() : null);
    if (!sources) throw invalid("缺少源文件", "sources_required", "非导入模式必须传入源文件");

    const byKey = new Map<string, { path: string; ino: string; size: number; name: string }>();
    const inodes = new Map<string, string>();
    const caseIndex = new Map<string, string>();
    for (const src of sources) {
      if (!src || !ALLOWED_KEYS.has(src.key)) throw invalid("未知输出 key", "source_key", "只使用既有 output keys");
      if (byKey.has(src.key)) throw invalid("输出 key 重复", `duplicate_${src.key}`, "每把 key 只保留一个文件");
      const meta = assertExistingInside(src.path);
      const name = basename(meta.path);
      if (!name || looksLikePath(name)) throw invalid("源文件名非法", `name_${src.key}`, "使用普通文件名");
      const folded = resolve(meta.path).toLowerCase();
      const aliased = caseIndex.get(folded);
      if (aliased && aliased !== src.key) throw invalid("路径大小写别名重复", `alias_${src.key}`, "每把 key 使用独立文件");
      caseIndex.set(folded, src.key);
      const otherKey = inodes.get(meta.ino);
      if (otherKey) throw invalid("源文件 inode 重复", `inode_${src.key}`, "不要用 hardlink 共享可写源");
      inodes.set(meta.ino, src.key);
      byKey.set(src.key, { path: meta.path, ino: meta.ino, size: meta.size, name });
    }
    for (const key of REQUIRED_KEYS) {
      if (!byKey.has(key)) throw invalid("缺少必需输出", `missing_${key}`, "至少提供两张产品 PNG 和 GLB");
    }
    const destNames = new Map<string, string>();
    for (const [key, src] of byKey) {
      const folded = src.name.toLowerCase();
      const clash = destNames.get(folded);
      if (clash && clash !== key) throw invalid("目标文件名冲突", `dest_alias_${key}`, "输出文件名不能只靠大小写区分");
      destNames.set(folded, key);
    }

    const faces = readFaces();
    const estimated = [...byKey.values()].reduce((sum, item) => sum + item.size, 0) + 256 * 1024;
    const required = renderGenerationDiskRequiredBytes(estimated);
    const disk = probe();
    if (disk.availableBytes < required) {
      throw diskGuard(
        "磁盘剩余空间低于生成前安全水位",
        disk.source === "injected" ? "disk_injected" : "disk_statfs",
        "删除不再需要的整单或扩容；不自动删历史代",
      );
    }

    if (!opts.qualityVerifier) {
      throw invalid("未提供质量验证器，不能 ready", "quality_verifier_missing", RENDER_GENERATION_UNWIRED_NOTE);
    }

    const stagingName = `.staging-${generationId}-${randomBytes(4).toString("hex")}`;
    if (looksLikePath(stagingName.replace(/^\./, ""))) throw invalid("staging 名非法", "staging_name", "由存储层生成");
    const stagingDir = join(genDir(), stagingName);
    const outputsDir = join(stagingDir, OUTPUTS_DIR);
    // 拒绝复用既存 staging（普通目录 / dangling symlink / 已有清单）。
    // 清单必须在路径校验后 O_EXCL 新建，writeFile 跟随 symlink 会先改外部哨兵再失败。
    ensurePhysicalDir(genDir());
    mkdirExclusive(stagingDir, "staging_exists");
    mkdirExclusive(outputsDir, "staging_outputs_exists");
    let dirFsync: DurabilityNotes["fsync_directory"] = "not_attempted";

    const copied: FileRow[] = [];
    const omitted: OptionalOmitted[] = [];
    for (const key of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) {
        const src = byKey.get(key);
        if (!src) continue;
        const dest = join(stagingDir, OUTPUTS_DIR, src.name);
        try {
          if (OPTIONAL_KEY_SET.has(key)) {
            try {
              hashAndValidate(src.path, key);
            } catch (err) {
              if (err instanceof RenderGenerationError && err.code === "render_generation_invalid") {
                omitted.push({ key, reason: err.cause });
                continue;
              }
              throw err;
            }
          }
          copyFileExclusive(src.path, dest, `${key}:dest_exists`);
          const destStat = lstatSync(dest);
          if (`${destStat.dev}:${destStat.ino}` === src.ino) {
            throw invalid("复制结果与源共享 inode", `${key}:hardlink`, "必须复制字节，不能 hardlink");
          }
          fsyncFile(dest);
          check();
          const hashed = hashAndValidate(dest, key);
          copied.push({
            key,
            name: src.name,
            sha256: hashed.sha256,
            bytes: hashed.bytes,
            rel: `${OUTPUTS_DIR}/${src.name}`,
          });
          failpoints.duringCopy?.(key);
        } catch (err) {
          if (OPTIONAL_KEY_SET.has(key) && err instanceof RenderGenerationError && err.code === "render_generation_invalid") {
            try {
              if (existsSync(dest)) unlinkSync(dest);
            } catch {
              /* keep staging for diagnosis */
            }
            omitted.push({ key, reason: err.cause });
            continue;
          }
          throw err;
        }
      }
      for (const key of REQUIRED_KEYS) {
        if (!copied.some((row) => row.key === key)) throw invalid("必需输出没有进入 staging", `missing_${key}`, "检查源文件");
      }
      const fp = contentFingerprint(
        copied.map((row) => ({ key: row.key, sha256: row.sha256 })),
        Object.fromEntries(FACES.map((face) => [face, faces[face].sha256])),
      );
      const verifyInput: QualityVerifyInput = {
        resource_lifecycle: opts.lifecycle,
        generation_id: generationId,
        contract_sha256: input.contractSha256,
        content_fingerprint: fp,
        mode: input.mode,
        files: copied.map((row) => ({ key: row.key, sha256: row.sha256, bytes: row.bytes })),
        faces: Object.fromEntries(FACES.map((face) => [face, faces[face].sha256])) as Record<RenderFace, string>,
      };
      const verified = opts.qualityVerifier(verifyInput);
      check();
      if (
        !verified
        || verified.generation_id !== generationId
        || verified.contract_sha256 !== input.contractSha256
        || verified.content_fingerprint !== fp
      ) {
        throw invalid("质量结果未绑定本代身份", "quality_unbound", RENDER_GENERATION_UNWIRED_NOTE);
      }
      if (verified.verifier_status !== "accepted") {
        throw invalid("质量验证失败，不能 ready", "quality_rejected", RENDER_GENERATION_UNWIRED_NOTE);
      }
      if (verified.quality_status !== "unwired" && verified.quality_status !== "failed" && verified.quality_status !== "runtime_verified") {
        throw invalid("质量状态非法", "quality_status", "不要伪造质量绿灯");
      }
      if (verified.quality_status === "failed") {
        throw invalid("质量验证失败，不能 ready", "quality_failed", RENDER_GENERATION_UNWIRED_NOTE);
      }
      const layers = verified.layers;
      if (layers) {
        if (layers.production_ready !== false) {
          throw invalid("不能宣称 production_ready", "production_ready", "机器结果不得写成生产通过");
        }
        if (layers.human_acceptance !== "pending") {
          throw invalid("机器结果不能写成人工通过", "human_acceptance", "human_acceptance 保持独立 pending");
        }
        if (layers.runtime_hard === "fail") {
          throw invalid("质量验证失败，不能 ready", "quality_failed", "runtime hard gate 阻止 current 切换");
        }
      }
      const manifest: Manifest = {
        schema: RENDER_GENERATION_SCHEMA,
        generation_id: generationId,
        mode: input.mode,
        profile: input.profile,
        created_at: isoNow(),
        contract_sha256: input.contractSha256,
        status: "ready",
        quality: {
          verifier_status: "accepted",
          quality_status: verified.quality_status,
          verifier: verified.verifier,
          generation_id: generationId,
          contract_sha256: input.contractSha256,
          content_fingerprint: fp,
          note: verified.note || RENDER_GENERATION_UNWIRED_NOTE,
        },
        faces,
        files: copied,
        optional_omitted: omitted,
        total_bytes: copied.reduce((sum, row) => sum + row.bytes, 0),
        actor_label: input.actorLabel,
      };
      const manifestPath = join(stagingDir, MANIFEST_NAME);
      // 使用与历史读取相同的完整校验；坏回调/字段不能先占据不可覆写的 ready 代。
      const validatedManifest = parseManifest(manifest);
      writeFileExclusive(manifestPath, `${JSON.stringify(validatedManifest, null, 2)}\n`, { cause: "manifest_exists" });
      failpoints.afterManifestWrite?.();
      dirFsync = tryFsyncDir(stagingDir);
      check();
      failpoints.beforeRename?.();
      const destDir = readyDir(generationId);
      assertNoSymlinkChain(destDir, { targetMayBeMissing: true });
      if (lstatIfExists(destDir)) throw invalid("该代已固化，拒绝重复写入", "duplicate_ready", "新动作必须生成新代");
      check();
      renameSync(stagingDir, destDir);
      const parentFsync = tryFsyncDir(genDir());
      if (dirFsync === "ok" && parentFsync !== "ok") dirFsync = parentFsync;
      check();
      failpoints.afterRenameBeforeIndex?.();
      appendIndex("ready", generationId);
      const loaded = loadVerifiedManifest(generationId);
      const patch = patchFromManifest(loaded);
      check();
      return {
        generation_id: generationId,
        patch,
        public_summary: publicFromManifest(loaded, null),
        prepareCommit: () => {
          check();
          const final = loadVerifiedManifest(generationId);
          if (JSON.stringify(final) !== JSON.stringify(loaded)) throw invalid("封存身份已变化", "seal_identity_changed", "保留旧 current");
          check();
          return patchFromManifest(final);
        },
        report: {
          quality_wired: loaded.quality.quality_status === "runtime_verified",
          quality_status: loaded.quality.quality_status,
          note: loaded.quality.note,
          optional_omitted: omitted,
          durability: {
            fsync_files: true,
            fsync_directory: dirFsync,
            rename_atomic_visibility: true,
            power_loss_proven: false,
            windows_durability_proven: false,
            note: RENDER_GENERATION_DURABILITY_NOTE,
          },
          disk: {
            estimatedBytes: estimated,
            requiredBytes: required,
            availableBytes: disk.availableBytes,
            source: disk.source,
          },
        },
      };
  }

  function prepareActivationPatch(input: PrepareActivationInput): RenderGenerationPatch {
    if (!input || typeof input.generationId !== "string") throw invalid("代际 id 非法", "generation_id", "只使用服务端公开的代际 id");
    assertSafeId(input.generationId, "generation_id");
    if (!isGenerationId(input.generationId)) throw invalid("代际 id 非法", "generation_id", "只使用服务端公开的代际 id");
    assertExpectedCurrent(input.expectedCurrentGenerationId, input.observedCurrentGenerationId);
    const manifest = loadVerifiedManifest(input.generationId);
    return patchFromManifest(manifest);
  }

  function recoverOrphans(): RecoverResult {
    const recovered: string[] = [];
    const skippedInvalid: string[] = [];
    const already: string[] = [];
    const { events } = readIndexFile(indexPath());
    const indexed = new Set(events.filter(item => item.event !== "activated").map((item) => item.generation_id));
    for (const id of listReadyIds()) {
      if (indexed.has(id)) {
        already.push(id);
        continue;
      }
      try {
        loadVerifiedManifest(id);
      } catch {
        skippedInvalid.push(id);
        continue;
      }
      appendIndex("recovered", id);
      recovered.push(id);
      indexed.add(id);
    }
    return { recovered, skipped_invalid: skippedInvalid, already_indexed: already };
  }

  function listHistory(query: HistoryQuery = {}): HistoryPage {
    const limit = query.limit === undefined ? RENDER_GENERATION_HISTORY_DEFAULT_LIMIT : query.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > RENDER_GENERATION_HISTORY_MAX_LIMIT) {
      throw invalid("分页 limit 非法", "limit", `使用 1–${RENDER_GENERATION_HISTORY_MAX_LIMIT}，默认 ${RENDER_GENERATION_HISTORY_DEFAULT_LIMIT}`);
    }
    const { events } = readIndexFile(indexPath());
    const seen = new Set<string>();
    const ordered: Array<{ seq: number; generationId: string }> = [];
    for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
      if (event.event === "activated") continue;
      if (seen.has(event.generation_id)) continue;
      seen.add(event.generation_id);
      ordered.push({ seq: event.seq, generationId: event.generation_id });
    }
    let start = 0;
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      const idx = ordered.findIndex((item) => item.seq === decoded.seq && item.generationId === decoded.generationId);
      if (idx < 0) throw invalid("cursor 非法", "cursor_invalid", "使用本单签发的 cursor");
      start = idx + 1;
    }
    const slice = ordered.slice(start, start + limit);
    const items: PublicGenerationSummary[] = [];
    for (const item of slice) {
      try {
        const manifest = loadVerifiedManifest(item.generationId);
        items.push(publicFromManifest(manifest, query.currentGenerationId ?? null));
      } catch {
        continue;
      }
    }
    const last = slice[slice.length - 1];
    const more = start + slice.length < ordered.length;
    return {
      items,
      next_cursor: more && last ? encodeCursor(last.seq, last.generationId) : null,
    };
  }

  function publicSummary(generationId: string, currentGenerationId: string | null): PublicGenerationSummary {
    assertSafeId(generationId, "generation_id");
    const manifest = loadVerifiedManifest(generationId);
    return publicFromManifest(manifest, currentGenerationId);
  }

  return {
    virtualLegacyCurrentId,
    openFile,
    assertHistoryWritable,
    assertRerenderSourceFresh,
    hasActivation,
    appendActivation,
    sealGeneration,
    prepareActivationPatch,
    recoverOrphans,
    listHistory,
    publicSummary,
  };
}
