/**
 * Generation-managed mockup 的专用 job.json 原子写。
 *
 * 临时文件与目标同目录；独占创建、祖先/目标防护、文件 fsync；用 rename 替换。
 * 任何平台 rename 失败都保持旧文件：绝不 copyFile 覆盖兜底，绝不先 unlink 目标。
 * 本模块不实现 PowerShell / 生产脚本。Windows 走实际 Node rename；失败则明确报错。
 * 本地 hook 不能宣称 Windows 耐久性。
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "./config.js";

export const MOCKUP_ATOMIC_WRITE_WINDOWS_DURABILITY_PROVEN = false as const;
export const MOCKUP_ATOMIC_WRITE_NOTE =
  "rename 原子可见性不是断电耐久性；未跑 Windows/断电不得声称完成；rename 失败不会 copyFile/unlink 目标";
export const MOCKUP_ATOMIC_WRITE_TRUSTED_ROOTS_NOTE =
  "只允许明确配置根的原始词法入口及已验证系统别名（DATA_DIR、os.tmpdir()、POSIX /tmp→/private/tmp）；从选定词法根逐段校验后代。任意路径不得因 realpath 恰好等于可信根而获权；内部 symlink 即使指向 DATA_DIR 或 /tmp 也拒绝";

export class MockupAtomicWriteError extends Error {
  readonly code = "render_generation_invalid" as const;
  readonly problem: string;
  readonly cause: string;
  readonly fix: string;
  constructor(problem: string, cause: string, fix: string) {
    super(problem);
    this.name = "MockupAtomicWriteError";
    this.problem = problem;
    this.cause = cause;
    this.fix = fix;
  }
}

export type MockupAtomicWriteHooks = {
  rename?: typeof renameSync;
};

let hooks: MockupAtomicWriteHooks = {};

export function setMockupAtomicWriteTestHooks(next: MockupAtomicWriteHooks): void {
  if (process.env.VITEST !== "1") throw new Error("原子写测试钩子只能在 VITEST 使用");
  hooks = next;
}

export function resetMockupAtomicWriteTestHooks(): void {
  hooks = {};
}

function invalid(problem: string, cause: string, fix: string): MockupAtomicWriteError {
  return new MockupAtomicWriteError(problem, cause, fix);
}

function fsErrorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
}

function isNotFound(err: unknown): boolean {
  return fsErrorCode(err) === "ENOENT";
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = fsErrorCode(err);
    // ENOTDIR: 某段祖先是文件，当作缺失后继续向上分类为 ancestor_not_dir。
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function addUniquePath(list: string[], value: string): void {
  if (!value) return;
  const lexical = resolve(value);
  if (!list.includes(lexical)) list.push(lexical);
}

/**
 * 明确配置的词法根：DATA_DIR、os.tmpdir()，以及 POSIX 系统临时入口。
 * 这里是调用方写下的路径本身，不是“realpath 碰巧等于这些根”的任意别名。
 */
function configuredLexicalRoots(): string[] {
  const roots: string[] = [];
  addUniquePath(roots, DATA_DIR);
  addUniquePath(roots, tmpdir());
  if (process.platform !== "win32") {
    addUniquePath(roots, "/tmp");
    addUniquePath(roots, "/private/tmp");
    addUniquePath(roots, "/var/tmp");
    addUniquePath(roots, "/private/var/tmp");
  }
  return roots;
}

function configuredRootReals(): Set<string> {
  const reals = new Set<string>();
  for (const lexical of configuredLexicalRoots()) {
    const real = tryRealpath(lexical);
    if (real) reals.add(real);
  }
  return reals;
}

function isLexicalDescendant(full: string, root: string): boolean {
  if (full === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return full.startsWith(prefix);
}

/**
 * 选定覆盖 dest 的最长词法根：配置入口，或该入口已验证的 realpath 别名。
 * 不把任务目录里自建的 symlink 登记为根。
 */
function selectTrustedLexicalRoot(fullDir: string): string {
  let selected = "";
  const consider = (root: string): void => {
    if (!root || !isLexicalDescendant(fullDir, root)) return;
    if (root.length > selected.length) selected = root;
  };
  for (const lexical of configuredLexicalRoots()) {
    consider(lexical);
    const real = tryRealpath(lexical);
    if (real) consider(real);
  }
  if (!selected) {
    throw invalid("job.json 不在可信数据根下", "untrusted_root", "只写入 DATA_DIR 或系统临时根内的任务目录");
  }
  return selected;
}

/**
 * 从已选定可信词法根逐段向下 lstat（不跟随当前分量）。
 * 只有选定根自己可以是已验证的系统别名（例如 /tmp→/private/tmp）。
 * 内部 symlink 即使指向 DATA_DIR 或 /tmp 也拒绝。
 */
function assertTrustedAncestors(dir: string): void {
  const fullDir = resolve(dir);
  const selected = selectTrustedLexicalRoot(fullDir);
  const rel = relative(selected, fullDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw invalid("job.json 不在可信数据根下", "untrusted_root", "只写入 DATA_DIR 或系统临时根内的任务目录");
  }
  const rootStat = lstatIfExists(selected);
  if (!rootStat) {
    throw invalid("任务目录不存在", "parent_missing", "不要在缺失目录上写 job.json");
  }
  if (rootStat.isSymbolicLink()) {
    const real = tryRealpath(selected);
    if (!real || !configuredRootReals().has(real)) {
      throw invalid("拒绝符号链接", "symlink_dir", "任务目录必须是普通目录");
    }
  } else if (!rootStat.isDirectory()) {
    const isImmediateParent = selected === fullDir;
    throw invalid(
      isImmediateParent ? "任务目录不是普通目录" : "祖先不是普通目录",
      isImmediateParent ? "parent_not_dir" : "ancestor_not_dir",
      "任务目录必须是普通目录",
    );
  }
  const parts = rel.split(sep).filter((part) => part && part !== ".");
  let current = selected;
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i]);
    const st = lstatIfExists(current);
    const isLast = i === parts.length - 1;
    if (!st) {
      throw invalid("任务目录不存在", "parent_missing", "不要在缺失目录上写 job.json");
    }
    if (st.isSymbolicLink()) {
      throw invalid("拒绝符号链接", "symlink_dir", "任务目录必须是普通目录");
    }
    if (!st.isDirectory()) {
      throw invalid(
        isLast ? "任务目录不是普通目录" : "祖先不是普通目录",
        isLast ? "parent_not_dir" : "ancestor_not_dir",
        "任务目录必须是普通目录",
      );
    }
  }
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

function assertSafeJobJsonPath(dest: string): { dest: string; dir: string } {
  if (!dest || typeof dest !== "string" || !isAbsolute(dest)) {
    throw invalid("job.json 路径非法", "dest_not_absolute", "由 saveMockup 传入任务目录内绝对路径");
  }
  const full = resolve(dest);
  if (basename(full) !== "job.json") {
    throw invalid("只允许写入 job.json", "dest_name", "generation 专用写者不能写其它文件");
  }
  if (full.includes("\0") || /[\\/]\.\.[\\/]/.test(full)) {
    throw invalid("job.json 路径非法", "dest_escape", "由 saveMockup 传入任务目录内绝对路径");
  }
  const dir = dirname(full);
  assertTrustedAncestors(dir);
  return { dest: join(dir, "job.json"), dir };
}

function assertDestSafe(dest: string): void {
  const st = lstatIfExists(dest);
  if (!st) return;
  if (st.isSymbolicLink()) throw invalid("拒绝符号链接", "symlink", "job.json 不能是 symlink");
  if (!st.isFile()) throw invalid("job.json 不是普通文件", "not_file", "不要把 job.json 做成目录或设备");
  if (st.nlink !== 1) throw invalid("拒绝 hardlink 外部写入", "hardlink", "job.json 不能 hardlink 到外部");
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/**
 * 用同目录临时文件 + rename 替换 dest。rename 失败时 dest 原件保持不变。
 */
export function atomicReplaceJobJson(dest: string, contents: string): void {
  if (typeof contents !== "string") {
    throw invalid("job.json 内容非法", "contents", "传入 UTF-8 JSON 文本");
  }
  const { dest: target, dir } = assertSafeJobJsonPath(dest);
  assertDestSafe(target);
  const tmp = join(dir, `.job.json.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`);
  if (lstatIfExists(tmp)) {
    throw invalid("拒绝覆盖既存临时文件", "tmp_exists", "每次写入独占新建临时文件");
  }
  const buf = Buffer.from(contents, "utf8");
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag();
  let fd: number;
  try {
    fd = openSync(tmp, flags, 0o644);
  } catch (err) {
    const code = fsErrorCode(err);
    if (code === "EEXIST") throw invalid("拒绝覆盖既存临时文件", "tmp_exists", "每次写入独占新建临时文件");
    if (code === "ELOOP") throw invalid("拒绝符号链接", "symlink", "临时文件不能是 symlink");
    throw err;
  }
  try {
    writeAllSync(fd, buf);
    fsyncSync(fd);
    const opened = fstatSync(fd);
    if (opened.nlink !== 1 || !opened.isFile()) {
      throw invalid("拒绝 hardlink 外部写入", "hardlink", "临时文件必须是普通文件");
    }
  } finally {
    closeSync(fd);
  }
  const tmpStat = lstatSync(tmp);
  if (tmpStat.isSymbolicLink() || !tmpStat.isFile() || tmpStat.nlink !== 1) {
    unlinkIfExists(tmp);
    throw invalid("临时文件不是普通文件", "tmp_not_file", "独占新建普通临时文件后再 rename");
  }
  assertTrustedAncestors(dir);
  assertDestSafe(target);
  const rename = hooks.rename || renameSync;
  try {
    rename(tmp, target);
  } catch (err) {
    unlinkIfExists(tmp);
    const code = fsErrorCode(err) || "rename_failed";
    throw invalid(
      "原子替换失败，已保留旧 job.json",
      `rename_${code}`,
      "不要 copyFile 覆盖，不要先删目标；检查目标是否被占用后重试",
    );
  }
  try {
    const out = openSync(target, fsConstants.O_RDONLY | noFollowFlag());
    try {
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
  } catch {
    /* 文件 fsync 尽力而为；rename 已使新内容可见。不是断电证明。 */
  }
}
