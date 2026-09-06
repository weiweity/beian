import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { inspectRenderGenerationGroup, renderGenerationProcessSupported, signalRenderGenerationGroup } from "./renderGenerationProcess.js";

const REQUEST_LIMIT = 64 * 1024;
const OUTPUT_LIMIT = 1024 * 1024;
const PLAN_LIMIT = 8 * 1024 * 1024;
const FILE_LIMIT = 512 * 1024 * 1024;
const FACES = ["front", "right", "back", "left", "top", "bottom"] as const;
const OUTPUT_KEYS = new Set([
  "front_right", "back_left", "front_right_card", "back_left_card", "glb", "blend",
  "front_right_ground", "back_left_ground", "front_right_set", "back_left_set",
  "front_right_ground_card", "back_left_ground_card", "front_right_set_card", "back_left_set_card",
]);
const REQUIRED = ["front_right", "back_left", "front_right_card", "back_left_card", "glb"];
const SHA = /^sha256:[a-f0-9]{64}$/;
type Json = Record<string, unknown>;
type Studio = { product_light: number; background_light: number };

export class RenderBridgeError extends Error {
  readonly fix = "保留当前产物，核对输入与执行环境后重新验证";
  constructor(readonly code: string, readonly cause: string) {
    super(`候选渲染未完成：${cause}`);
  }
}

export type RenderBridgeObserver = {
  signal?: AbortSignal;
  context?: { jobId: string; mutationId: string };
  /** Must persist ownership synchronously before stdin is delivered. A throw aborts this child. */
  onSpawn?: (pid: number, executionId: string) => void;
  /** Release notification: parent closed AND its dedicated group is absent. */
  onClose?: (pid: number, executionId: string) => void;
  onStage?: (stage: "validate" | "prepare" | "blender") => void;
};

export type RenderBridgeOptions = {
  pythonExecutable: string;
  packagingDir: string;
  dataRoot: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
};

export type RenderBridgeValidation = {
  jobRoot: string;
  mode: "preserve" | "legacy_relight" | "upgrade";
  expectedSourceSha256: string;
  expectedAssetSha256: Record<(typeof FACES)[number], string>;
  studioAdjustment?: Studio;
};

/** Opaque, process-local receipt, not a serialized credential or a quality approval. */
export type RenderPlanReceipt = Readonly<{
  sourceSha256: string;
  planIdentity: string;
  candidateIdentity: string;
  profile: string;
  sourceAssets: ReadonlyArray<Readonly<OutputEvidence>>;
}>;

type Binding = { request: Json; source: Json; studio: unknown; used: boolean };
type OutputEvidence = { path: string; sha256: string; bytes: number };
export type RenderBridgeCandidate = {
  receipt: RenderPlanReceipt;
  candidateDir: string;
  executionNonce: string;
  outputs: Record<string, OutputEvidence>;
  optionalWarnings: Array<{ key: string; cause: string }>;
  quality: { status: "unwired"; production_ready: false };
};

function invalid(cause: string): never {
  throw new RenderBridgeError("render_generation_invalid", cause);
}

function publicFailure(error: unknown): RenderBridgeError {
  return error instanceof RenderBridgeError ? error : new RenderBridgeError("render_generation_invalid", "input_or_file_unavailable");
}

function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("protocol_object");
  return value as Json;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) invalid("protocol_sha256");
  return value;
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = Object.keys(left).sort();
  const b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, i) => key === b[i]
    && same((left as Json)[key], (right as Json)[key]));
}

function absolute(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 1024 || /[\x00-\x1f]/.test(value)) {
    invalid("absolute_path");
  }
  return resolve(value);
}

/** Root is selected by the server, never taken from worker output. System root aliases are allowed. */
async function inside(root: string, file: string): Promise<void> {
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    invalid("path_escape");
  }
  let cursor = file;
  while (cursor !== root) {
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) invalid("path_symlink");
    cursor = dirname(cursor);
  }
  const physicalRoot = await realpath(root);
  const physical = await realpath(file);
  const actual = relative(physicalRoot, physical);
  if (!actual || actual === ".." || actual.startsWith("../") || actual.startsWith("..\\") || isAbsolute(actual)) {
    invalid("path_escape");
  }
}

async function fileIdentity(root: string, file: string, limit = FILE_LIMIT): Promise<OutputEvidence> {
  await inside(root, file);
  const before = await lstat(file);
  if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > limit) invalid("file_budget_or_type");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) invalid("file_changed");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > limit) invalid("file_budget");
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (bytes !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size) invalid("file_changed");
    return { path: file, bytes, sha256: `sha256:${hash.digest("hex")}` };
  } finally {
    await handle.close();
  }
}

function qualityUnwired(result: Json): void {
  const q = object(result.quality);
  if (q.status !== "unwired" || q.wired !== false || q.production_ready !== false || q.runtime_gate !== "pending") {
    invalid("unexpected_quality_claim");
  }
}

/** Only this child/group is signalled. Parent close alone cannot release ownership. */
function command(options: Required<RenderBridgeOptions>, request: Json, observer: RenderBridgeObserver): Promise<Json> {
  const input = Buffer.from(JSON.stringify(request));
  if (input.length > REQUEST_LIMIT) invalid("request_budget");
  if (observer.signal?.aborted) return Promise.reject(new RenderBridgeError("render_generation_cancelled", "cancelled"));
  if (!renderGenerationProcessSupported()) {
    return Promise.reject(new RenderBridgeError("render_generation_unavailable", "process_containment_unavailable"));
  }
  const context = observer.context ?? { jobId: "standalone", mutationId: "standalone" };
  if (![context.jobId, context.mutationId].every(v => /^[a-zA-Z0-9_-]{1,96}$/.test(v))) invalid("execution_context");
  const executionId = `${context.jobId}:${context.mutationId}:${randomBytes(16).toString("hex")}`;
  return new Promise((accept, reject) => {
    const child = spawn(options.pythonExecutable, [join(options.packagingDir, "render_generation.py"), "-", "--execution-id", executionId], {
      cwd: options.packagingDir,
      env: { ...process.env, WB_DATA_DIR: options.dataRoot, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
      detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let failure: RenderBridgeError | undefined;
    let closed = false;
    let parentExited = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let rest = "";
    const decoder = new StringDecoder("utf8");
    const signalTree = (force: boolean): void => {
      if (closed || parentExited || !child.pid) return;
      try { signalRenderGenerationGroup(child.pid, force); }
      catch { /* No fallback to an unverified/reused standalone PID. */ }
    };
    const stop = (cause: string, code = "render_generation_failed"): void => {
      if (failure || closed) return;
      failure = new RenderBridgeError(code, cause);
      signalTree(false);
      forceTimer = setTimeout(() => signalTree(true), options.terminationGraceMs);
    };
    const abort = () => stop("cancelled", "render_generation_cancelled");
    const timer = setTimeout(() => stop("timeout", "render_generation_timeout"), options.timeoutMs);
    observer.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (stdout.length + chunk.length > OUTPUT_LIMIT) { stop("stdout_budget"); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return;
      stderrBytes += chunk.length;
      if (stderrBytes > OUTPUT_LIMIT) { stop("stderr_budget"); return; }
      const lines = (rest + decoder.write(chunk)).split(/\r?\n/);
      rest = lines.pop() ?? "";
      if (rest.length > 65536) { stop("stderr_line_budget"); return; }
      for (const line of lines) {
        if (failure) break;
        const match = /^STAGE (validate|prepare|blender)$/.exec(line.trim());
        if (!match) continue;
        try { observer.onStage?.(match[1] as "validate" | "prepare" | "blender"); }
        catch { stop("stage_callback"); }
      }
    });
    child.stdin.on("error", () => stop("stdin_error"));
    child.on("error", () => stop("spawn_error"));
    child.on("exit", () => {
      parentExited = true;
      // Once the leader exits, a later group number is not a durable kill handle.
      if (forceTimer) clearTimeout(forceTimer);
      // Descendants may inherit pipes and prevent `close` after the leader exits.
      // Bound transport draining, not process ownership: close still checks the group.
      drainTimer = setTimeout(() => {
        if (closed) return;
        failure ??= new RenderBridgeError("render_generation_failed", "process_group_unconfirmed");
        clearTimeout(timer);
        observer.signal?.removeEventListener("abort", abort);
        reject(failure);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }, options.terminationGraceMs);
    });
    child.on("spawn", () => {
      if (failure || observer.signal?.aborted) { abort(); child.stdin.end(); return; }
      try {
        observer.onSpawn?.(child.pid!, executionId);
        if (failure || observer.signal?.aborted) { abort(); child.stdin.end(); return; }
        child.stdin.end(input);
      } catch { stop("ownership_callback"); child.stdin.end(); }
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (drainTimer) clearTimeout(drainTimer);
      observer.signal?.removeEventListener("abort", abort);
      if (child.pid) {
        if (inspectRenderGenerationGroup(child.pid) !== "missing") {
          // Settle as failed but keep persisted ownership and the shared fence.
          // Recovery may later prove absence; never mark a live orphan as released.
          reject(new RenderBridgeError("render_generation_failed", "process_group_unconfirmed"));
          return;
        }
        try { observer.onClose?.(child.pid, executionId); }
        catch { failure = new RenderBridgeError("render_generation_failed", "close_persistence"); }
      }
      if (failure) { reject(failure); return; }
      try {
        const line = stdout.toString("utf8").trim().split(/\r?\n/).at(-1);
        const result = object(JSON.parse(line || ""));
        if (code !== 0 || result.ok !== true) {
          // Propagate short structured reasons (e.g. missing_blender), never raw stderr or paths.
          if (result.ok === false && result.schema === "packaging-render-generation-result/1"
            && typeof result.code === "string" && /^(render_[a-z_]+|packaging_failed)$/.test(result.code)
            && typeof result.cause === "string" && /^[a-z0-9_.-]{1,80}$/.test(result.cause)) {
            throw new RenderBridgeError(result.code, result.cause);
          }
          throw new RenderBridgeError("render_generation_failed", "worker_exit");
        }
        if (result.ok !== true || result.schema !== "packaging-render-generation-result/1") invalid("worker_protocol");
        qualityUnwired(result);
        accept(result);
      } catch (error) {
        reject(error instanceof RenderBridgeError ? error : new RenderBridgeError("render_generation_invalid", "worker_json"));
      }
    });
  });
}

/** C2.1: real async RF-02 validation + isolated candidate execution, deliberately not registered in jobs. */
export function createRenderGenerationBridge(config: RenderBridgeOptions) {
  const options: Required<RenderBridgeOptions> = {
    ...config,
    pythonExecutable: absolute(config.pythonExecutable),
    packagingDir: absolute(config.packagingDir),
    dataRoot: absolute(config.dataRoot),
    timeoutMs: config.timeoutMs ?? 1_260_000,
    terminationGraceMs: config.terminationGraceMs ?? 5000,
  };
  for (const [value, ceiling] of [[options.timeoutMs, 1_260_000], [options.terminationGraceMs, 5000]]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) invalid("time_budget");
  }
  const receipts = new WeakMap<RenderPlanReceipt, Binding>();

  const fresh = async (request: Json): Promise<OutputEvidence[]> => {
    const root = String(request.job_root);
    await inside(options.dataRoot, root);
    const source = join(root, "resolved_job.json");
    const evidence = await fileIdentity(root, source, PLAN_LIMIT);
    if (evidence.sha256 !== request.expected_source_sha256) invalid("source_changed");
    // Parsing only locates bounded input files; Python remains the sole RF-02 validator.
    const handle = await open(source, "r");
    let raw: Buffer;
    try { raw = Buffer.alloc(evidence.bytes); await handle.read(raw, 0, raw.length, 0); }
    finally { await handle.close(); }
    if (digest(raw) !== evidence.sha256) invalid("source_changed");
    const assets = object(object(JSON.parse(raw.toString("utf8"))).assets);
    const rows: OutputEvidence[] = [];
    for (const face of FACES) {
      const path = absolute(String(assets[face]));
      const current = await fileIdentity(root, path);
      if (current.sha256 !== object(request.expected_asset_sha256)[face]) invalid("asset_changed");
      rows.push(current);
    }
    return rows;
  };

  const bridge = {
    async verifyBytes(input: { jobRoot: string; bytes: Buffer; mode: RenderBridgeValidation["mode"]; studioAdjustment?: Studio },
      observer: RenderBridgeObserver = {}): Promise<RenderPlanReceipt> {
      try {
        const root = absolute(input.jobRoot);
        if (!Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > PLAN_LIMIT) invalid("plan_budget");
        const bytes = Buffer.from(input.bytes);
        await inside(options.dataRoot, root);
        const assets = object(object(JSON.parse(bytes.toString("utf8"))).assets);
        const hashes = {} as RenderBridgeValidation["expectedAssetSha256"];
        for (const face of FACES) hashes[face] = (await fileIdentity(root, absolute(String(assets[face])))).sha256;
        return await bridge.verify({ jobRoot: root, mode: input.mode, expectedSourceSha256: digest(bytes),
          expectedAssetSha256: hashes, studioAdjustment: input.studioAdjustment }, observer);
      } catch (error) { throw publicFailure(error); }
    },
    async verify(input: RenderBridgeValidation, observer: RenderBridgeObserver = {}): Promise<RenderPlanReceipt> {
      try {
        const request: Json = {
          schema: "packaging-render-generation-request/1", action: "validate",
          job_root: absolute(input.jobRoot), mode: input.mode,
          expected_source_sha256: sha(input.expectedSourceSha256),
          expected_asset_sha256: Object.fromEntries(FACES.map(face => [face, sha(input.expectedAssetSha256[face])])),
        };
        if (input.studioAdjustment) request.studio_adjustment = { ...input.studioAdjustment };
        await inside(options.dataRoot, String(request.job_root));
        await fresh(request);
        const result = await command(options, request, observer);
        const source = object(result.source_identity);
        const execution = object(result.execution);
        if (result.action !== "validate" || result.mode !== input.mode || execution.status !== "validated"
          || execution.nonce !== null || result.candidate_dir !== null
          || source.resolved_job_sha256 !== request.expected_source_sha256
          || !same(source.assets, request.expected_asset_sha256)
          || !same(result.studio_adjustment, request.studio_adjustment ?? null)
          || result.candidate_plan_identity !== source.plan_identity) invalid("validation_binding");
        sha(source.render_contract_hash);
        if (typeof source.render_profile_id !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(source.render_profile_id)) {
          invalid("profile_identity");
        }
        const sourceAssets = await fresh(request);
        const receipt = Object.freeze({
          sourceSha256: sha(source.resolved_job_sha256), planIdentity: sha(source.plan_identity),
          candidateIdentity: sha(result.candidate_identity), profile: source.render_profile_id,
          sourceAssets: Object.freeze(sourceAssets.map(row => Object.freeze({ ...row }))),
        });
        receipts.set(receipt, { request, source, studio: result.studio_adjustment, used: false });
        return receipt;
      } catch (error) { throw publicFailure(error); }
    },

    async render(receipt: RenderPlanReceipt, candidate: string, blender: string,
      observer: RenderBridgeObserver = {}): Promise<RenderBridgeCandidate> {
      try {
        const binding = receipts.get(receipt);
        if (!binding || binding.used) invalid("receipt_unknown_or_used");
        // A render attempt consumes its receipt, even on failure; retries require fresh validation.
        binding.used = true;
        const candidateDir = absolute(candidate);
        const parent = join(String(binding.request.job_root), ".render-generations");
        if (dirname(candidateDir) !== parent || !/^\.candidate-[a-zA-Z0-9_-]{1,96}$/.test(basename(candidateDir))) {
          invalid("candidate_location");
        }
        await inside(options.dataRoot, parent);
        try {
          await lstat(candidateDir);
          invalid("candidate_exists");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await fresh(binding.request);
        const result = await command(options, {
          ...binding.request, action: "render-candidate", candidate_dir: candidateDir,
          blender_executable: absolute(blender),
        }, observer);
        const execution = object(result.execution);
        if (result.action !== "render-candidate" || result.mode !== binding.request.mode
          || !same(result.source_identity, binding.source) || !same(result.studio_adjustment, binding.studio)
          || result.candidate_identity !== receipt.candidateIdentity || result.candidate_plan_identity !== receipt.planIdentity
          || result.candidate_dir !== candidateDir || execution.status !== "rendered"
          || typeof execution.nonce !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(execution.nonce)) {
          invalid("execution_binding");
        }
        const rows = object(result.outputs);
        await inside(options.dataRoot, candidateDir);
        if (REQUIRED.some(key => !rows[key])) invalid("required_output_missing");
        const outputs: Record<string, OutputEvidence> = {};
        for (const [key, raw] of Object.entries(rows)) {
          if (!OUTPUT_KEYS.has(key)) invalid("output_key");
          const row = object(raw);
          const evidence = await fileIdentity(candidateDir, absolute(String(row.path)));
          if (evidence.sha256 !== row.sha256 || evidence.bytes !== row.bytes) invalid("output_identity");
          outputs[key] = evidence;
        }
        if (!Array.isArray(result.optional_warnings) || result.optional_warnings.length > OUTPUT_KEYS.size) {
          invalid("optional_warnings");
        }
        const optionalWarnings = result.optional_warnings.map(raw => {
          const warning = object(raw);
          if (typeof warning.key !== "string" || !OUTPUT_KEYS.has(warning.key)
            || REQUIRED.includes(warning.key) || outputs[warning.key]
            || (warning.cause !== "optional_missing" && warning.cause !== "optional_invalid")) {
            invalid("optional_warnings");
          }
          return { key: warning.key, cause: warning.cause };
        });
        await fresh(binding.request);
        return { receipt, candidateDir, executionNonce: execution.nonce, outputs, optionalWarnings,
          quality: { status: "unwired", production_ready: false } };
      } catch (error) { throw publicFailure(error); }
    },
  };
  return bridge;
}
