/**
 * Q05 测量用 UI 产物来源。
 *
 * 默认：本进程 mkdtemp + 注入的 build()，afterAll 只删这个目录。
 * 显式预构建：BEIAN_Q05_DIST 只读复用外部目录；缺资产或身份不匹配立即失败，
 * 不回退构建，也不删除该目录。
 *
 * 身份复用既有文件 sha256（与 fileSha / verify 同源）。只给经过本 helper 构建并
 * 写入 sidecar 的目录盖章；禁止把当前源码身份补写到未知旧产物上。
 * 供给浏览器的 index.html 与 /assets/* 在校验时读入内存，之后不再读盘。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const Q05_PREBUILT_ENV = "BEIAN_Q05_DIST";
export const Q05_IDENTITY_SCHEMA = "beian-q05-ui-prebuilt/1";
export const Q05_IDENTITY_FILE = ".beian-q05-ui-identity.json";

const UI_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OWNED_PREFIX = "beian-rf09-e2e-";
const INPUT_FILES = ["index.html", "vite.config.ts", "package.json", "tsconfig.json", "package-lock.json"];
const INPUT_TREES = ["src", "public"];

export class Q05ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Q05ArtifactError";
  }
}

export type Q05ArtifactMode = "built-temp" | "prebuilt-external";

export type Q05UiIdentity = {
  schema: typeof Q05_IDENTITY_SCHEMA;
  gitHead: string;
  sources: Record<string, string>;
  lock: { path: string; sha256: string };
  manifest: { indexHtml: string; assets: Record<string, string> };
};

export type Q05ArtifactSource = {
  dir: string;
  mode: Q05ArtifactMode;
  owned: boolean;
  identity: Q05UiIdentity;
  inputsSha: string;
  artifactSha: string;
  artifactFiles: number;
  indexHtml: Buffer;
  assets: Map<string, Buffer>;
};

type Q05ArtifactOptions = {
  build: (dir: string) => void;
  uiRoot?: string;
  env?: NodeJS.Dict<string>;
  prebuiltDir?: string;
  gitHead?: () => string;
  lockFile?: string;
};

type Snapshot = {
  indexHtml: Buffer;
  assets: Map<string, Buffer>;
  manifest: Q05UiIdentity["manifest"];
};

export function fileSha(rel: string, root: string = UI_ROOT): string {
  return sha256Bytes(readRegularFile(join(root, rel)));
}

export function resolveQ05Artifact(options: Q05ArtifactOptions): Q05ArtifactSource {
  const uiRoot = options.uiRoot ?? UI_ROOT;
  const requested = requestedPrebuilt(options);
  if (requested !== undefined) return openPrebuilt(requested, options, uiRoot);
  return buildOwned(options, uiRoot);
}

/** 构建到调用方目录并写入 sidecar。失败不删除该目录。 */
export function buildQ05ArtifactInto(dir: string, options: Q05ArtifactOptions): Q05ArtifactSource {
  const uiRoot = options.uiRoot ?? UI_ROOT;
  const dest = resolveExistingDir(dir);
  return finishBuild(dest, options, uiRoot, "prebuilt-external", false);
}

export function cleanupQ05Artifact(source: Q05ArtifactSource | undefined): void {
  if (!source?.owned) return;
  if (!basename(source.dir).startsWith(OWNED_PREFIX)) return;
  rmSync(source.dir, { recursive: true, force: true });
}

export function q05MeasurementWindows(source: Q05ArtifactSource) {
  const prebuilt = source.mode === "prebuilt-external";
  return {
    heap_raf: {
      interval: "in-test",
      first_sample: "card-visible after page.goto and card pixel assert",
      includes_ui_build: false as const,
      note: "CDP heap and rAF sample the Playwright page after beforeAll. Node vite build is a different process and is not in these samples.",
    },
    command_rss_wall: {
      interval: "whole playwright command including beforeAll",
      includes_ui_build: !prebuilt,
      note: prebuilt
        ? "prebuilt mode does not call npm run build; command RSS/wall still includes Chromium/Playwright and is not a browser peak or formal budget"
        : "default mode runs npm run build in beforeAll; peak_tree_rss/seconds of a wrapped command include tsc/vite and are not browser peaks",
    },
  };
}

function requestedPrebuilt(options: Q05ArtifactOptions): string | undefined {
  if (options.prebuiltDir !== undefined) return options.prebuiltDir;
  const env = options.env ?? process.env;
  if (!Object.prototype.hasOwnProperty.call(env, Q05_PREBUILT_ENV)) return undefined;
  return env[Q05_PREBUILT_ENV] ?? "";
}

function openPrebuilt(rawDir: string, options: Q05ArtifactOptions, uiRoot: string): Q05ArtifactSource {
  if (!rawDir.trim()) throw failClosed(`${Q05_PREBUILT_ENV} 已设置但路径为空`);
  const dir = resolveExistingDir(rawDir);
  const snapshot = loadSnapshot(dir);
  const recorded = readIdentity(dir);
  const current = currentIdentity(options, uiRoot);
  const drift = identityDrift(current, recorded);
  if (drift.length) {
    throw failClosed(`预构建产物与当前源码/配置/依赖不一致：${drift.join("；")}`);
  }
  assertManifest(snapshot.manifest, recorded.manifest);
  return describeSource(dir, "prebuilt-external", false, recorded, snapshot);
}

function buildOwned(options: Q05ArtifactOptions, uiRoot: string): Q05ArtifactSource {
  const dir = mkdtempSync(join(tmpdir(), OWNED_PREFIX));
  try {
    return finishBuild(dir, options, uiRoot, "built-temp", true);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function finishBuild(
  dir: string,
  options: Q05ArtifactOptions,
  uiRoot: string,
  mode: Q05ArtifactMode,
  owned: boolean,
): Q05ArtifactSource {
  const before = currentIdentity(options, uiRoot);
  options.build(dir);
  const after = currentIdentity(options, uiRoot);
  const drift = identityDrift(before, after);
  if (drift.length) throw failClosed(`构建期间源码/配置/依赖变化：${drift.join("；")}`);
  const snapshot = loadSnapshot(dir);
  const identity: Q05UiIdentity = { ...before, manifest: snapshot.manifest };
  writeFileSync(join(dir, Q05_IDENTITY_FILE), `${JSON.stringify(identity, null, 2)}\n`);
  return describeSource(dir, mode, owned, identity, snapshot);
}

function currentIdentity(options: Q05ArtifactOptions, uiRoot: string): Omit<Q05UiIdentity, "manifest"> {
  const gitHead = (options.gitHead || (() => gitRevParse(uiRoot)))().trim();
  if (!gitHead) throw failClosed("无法读取 git HEAD");
  const lockFile = options.lockFile || resolve(uiRoot, "../../../package-lock.json");
  const lockBytes = readRegularFile(lockFile);
  const sources = hashSources(uiRoot);
  if (!Object.keys(sources).some((label) => label.startsWith("src/"))) {
    throw failClosed(`无法计算构建输入指纹（${join(uiRoot, "src")} 为空）`);
  }
  return {
    schema: Q05_IDENTITY_SCHEMA,
    gitHead,
    sources,
    lock: { path: "package-lock.json", sha256: sha256Bytes(lockBytes) },
  };
}

function hashSources(uiRoot: string): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const file of collectBuildInputs(uiRoot)) {
    if (file.label.endsWith(".test.ts") || file.label.endsWith(".test.tsx")) continue;
    sources[file.label] = sha256Bytes(readRegularFile(file.path));
  }
  return sources;
}

function collectBuildInputs(uiRoot: string): Array<{ path: string; label: string }> {
  const candidates = [
    ...INPUT_FILES.map((rel) => join(uiRoot, rel)),
    resolve(uiRoot, "../../../package-lock.json"),
    ...INPUT_TREES.flatMap((tree) => walkFiles(join(uiRoot, tree), tree)),
  ];
  const seen = new Set<string>();
  const inputs: Array<{ path: string; label: string }> = [];
  for (const path of candidates) {
    if (seen.has(path) || !existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw failClosed(`身份输入含符号链接：${relative(uiRoot, path)}`);
    if (!stat.isFile()) continue;
    seen.add(path);
    inputs.push({ path, label: relative(uiRoot, path).replaceAll("\\", "/") || basename(path) });
  }
  return inputs.sort((a, b) => a.label.localeCompare(b.label));
}

function describeSource(
  dir: string,
  mode: Q05ArtifactMode,
  owned: boolean,
  identity: Q05UiIdentity,
  snapshot: Snapshot,
): Q05ArtifactSource {
  return {
    dir,
    mode,
    owned,
    identity,
    indexHtml: snapshot.indexHtml,
    assets: snapshot.assets,
    artifactFiles: 1 + snapshot.assets.size,
    inputsSha: fingerprint(identity.sources),
    artifactSha: fingerprint({
      "index.html": identity.manifest.indexHtml,
      ...Object.fromEntries(Object.entries(identity.manifest.assets).map(([name, sha]) => [`assets/${name}`, sha])),
    }),
  };
}

function loadSnapshot(dir: string): Snapshot {
  const indexPath = join(dir, "index.html");
  const indexHtml = readRegularFile(indexPath);
  if (indexHtml.length === 0) throw failClosed(`预构建产物缺少非空 index.html：${indexPath}`);
  const html = indexHtml.toString("utf8");
  if (html.includes("/src/main.tsx") || html.includes("@vite/client")) {
    throw failClosed(`index.html 像开发入口，不是构建产物：${indexPath}`);
  }
  const assetsDir = join(dir, "assets");
  if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
    throw failClosed(`构建产物缺少 assets/ 目录：${assetsDir}`);
  }
  const assets = new Map<string, Buffer>();
  const manifestAssets: Record<string, string> = {};
  for (const name of readdirSync(assetsDir).sort()) {
    const path = join(assetsDir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw failClosed(`产物 assets 含符号链接：${name}`);
    if (!stat.isFile()) continue;
    const body = readFileSync(path);
    assets.set(`/assets/${name}`, body);
    manifestAssets[name] = sha256Bytes(body);
  }
  if (![...assets.keys()].some((name) => name.endsWith(".js"))) throw failClosed("预构建目录缺少 hashed JS");
  if (![...assets.keys()].some((name) => name.endsWith(".css"))) throw failClosed("预构建目录缺少 hashed CSS");
  const refs = [...new Set([...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((match) => match[1]))];
  const missing = refs.filter((ref) => {
    if (ref.startsWith("/assets/")) return !assets.has(ref);
    const path = join(dir, ref.replace(/^\//, ""));
    return !existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0;
  });
  if (missing.length) throw failClosed(`index.html 引用的同源资源缺失或为空：${missing.join("、")}`);
  if (!refs.some((ref) => ref.startsWith("/assets/") && ref.endsWith(".js"))) {
    throw failClosed(`index.html 未引用 /assets/*.js：${indexPath}`);
  }
  return {
    indexHtml,
    assets,
    manifest: { indexHtml: sha256Bytes(indexHtml), assets: manifestAssets },
  };
}

function readIdentity(dir: string): Q05UiIdentity {
  const path = join(dir, Q05_IDENTITY_FILE);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw failClosed(`预构建目录缺少身份记录 ${Q05_IDENTITY_FILE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw failClosed("预构建身份记录不是合法 JSON");
  }
  if (!isIdentity(parsed)) throw failClosed("预构建身份记录字段不完整或 schema 不匹配");
  return parsed;
}

function isIdentity(value: unknown): value is Q05UiIdentity {
  if (!value || typeof value !== "object") return false;
  const row = value as Q05UiIdentity;
  return row.schema === Q05_IDENTITY_SCHEMA
    && typeof row.gitHead === "string"
    && !!row.gitHead
    && isHashMap(row.sources)
    && !!row.lock
    && typeof row.lock.path === "string"
    && isHex(row.lock.sha256)
    && !!row.manifest
    && isHex(row.manifest.indexHtml)
    && isHashMap(row.manifest.assets);
}

function isHashMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, hash]) => key.length > 0 && isHex(hash));
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function identityDrift(current: Omit<Q05UiIdentity, "manifest">, recorded: Omit<Q05UiIdentity, "manifest">): string[] {
  const drift: string[] = [];
  if (recorded.schema !== current.schema) drift.push("schema");
  if (recorded.gitHead !== current.gitHead) drift.push("gitHead");
  if (recorded.lock.sha256 !== current.lock.sha256) drift.push("package-lock.json");
  const keys = new Set([...Object.keys(current.sources), ...Object.keys(recorded.sources)]);
  for (const key of [...keys].sort()) {
    if (current.sources[key] !== recorded.sources[key]) drift.push(key);
  }
  return drift;
}

function assertManifest(actual: Q05UiIdentity["manifest"], expected: Q05UiIdentity["manifest"]): void {
  if (actual.indexHtml !== expected.indexHtml) throw failClosed("index.html 与身份记录不一致");
  const names = new Set([...Object.keys(actual.assets), ...Object.keys(expected.assets)]);
  for (const name of names) {
    if (actual.assets[name] !== expected.assets[name]) {
      throw failClosed(`assets/${name} 与身份记录不一致`);
    }
  }
}

function walkFiles(dir: string, prefix: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = `${prefix}/${entry.name}`;
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw failClosed(`身份输入含符号链接：${rel}`);
    if (entry.isDirectory()) out.push(...walkFiles(child, rel));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function fingerprint(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const label of Object.keys(files).sort()) {
    hash.update(label).update("\0").update(files[label]).update("\n");
  }
  return hash.digest("hex");
}

function gitRevParse(uiRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: uiRoot, encoding: "utf8" }).trim();
}

function readRegularFile(path: string): Buffer {
  if (!existsSync(path)) throw failClosed(`缺少文件：${path}`);
  if (lstatSync(path).isSymbolicLink()) throw failClosed(`身份输入含符号链接：${path}`);
  if (!statSync(path).isFile()) throw failClosed(`不是普通文件：${path}`);
  return readFileSync(path);
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveExistingDir(path: string): string {
  const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw failClosed(`${Q05_PREBUILT_ENV} 不是现存目录：${resolved}`);
  }
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function failClosed(message: string): Q05ArtifactError {
  return new Q05ArtifactError(`${message}。已拒绝回退构建，未删除外部目录`);
}
