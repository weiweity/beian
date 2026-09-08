import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { inspectRenderGenerationGroup, renderGenerationProcessSupported, signalRenderGenerationGroup } from "./renderGenerationProcess.js";
import { contentFingerprint, type QualityVerifier } from "./renderGenerations.js";
import { isRenderLifecycle, RenderBudgetError, type RenderLifecycle } from "./renderGenerationBudget.js";

export const RENDER_GENERATION_OUTPUT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  front_right: "white_a", back_left: "white_b", glb: "glb",
  front_right_card: "white_a_card", back_left_card: "white_b_card",
  front_right_ground: "white_a_ground", back_left_ground: "white_b_ground",
  front_right_set: "white_a_set", back_left_set: "white_b_set",
  front_right_ground_card: "white_a_ground_card", back_left_ground_card: "white_b_ground_card",
  front_right_set_card: "white_a_set_card", back_left_set_card: "white_b_set_card",
});

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
  lifecycle?: RenderLifecycle;
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

type Binding = { request: Json; source: Json; studio: unknown; used: boolean; deadline: number };
type OutputEvidence = { path: string; sha256: string; bytes: number };
export type RenderBridgeCandidate = {
  receipt: RenderPlanReceipt;
  candidateDir: string;
  executionNonce: string;
  outputs: Record<string, OutputEvidence>;
  optionalWarnings: Array<{ key: string; cause: string }>;
  quality: {
    status: "layered";
    production_ready: false;
    runtime_gate: "pass" | "fail" | "not-run";
    human_acceptance: "pending";
  };
};

function invalid(cause: string): never {
  throw new RenderBridgeError("render_generation_invalid", cause);
}

function publicFailure(error: unknown): RenderBridgeError {
  if (error instanceof RenderBudgetError) return new RenderBridgeError("render_generation_failed", error.cause);
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

async function fileIdentity(root: string, file: string, limit = FILE_LIMIT, check = () => {}): Promise<OutputEvidence> {
  check();
  await inside(root, file);
  check();
  const before = await lstat(file);
  if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > limit) invalid("file_budget_or_type");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) invalid("file_changed");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      check();
      bytes += chunk.length;
      if (bytes > limit) invalid("file_budget");
      hash.update(chunk);
    }
    const after = await handle.stat();
    check();
    if (bytes !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size) invalid("file_changed");
    return { path: file, bytes, sha256: `sha256:${hash.digest("hex")}` };
  } finally {
    await handle.close();
  }
}

function qualityLayersContract(result: Json): void {
  const q = object(result.quality);
  if (q.production_ready !== false) invalid("unexpected_quality_claim");
  if (q.human_acceptance !== undefined && q.human_acceptance !== "pending") invalid("unexpected_human_acceptance");
  if (q.status !== "layered" || q.wired !== true) invalid("unexpected_quality_claim");
  if (q.runtime_gate !== "pass" && q.runtime_gate !== "fail" && q.runtime_gate !== "not-run") {
    invalid("unexpected_quality_claim");
  }
  if (q.fixture_regression !== undefined && q.fixture_regression !== "not-run") {
    invalid("unexpected_fixture_regression_on_real_job");
  }
}

/** Only this child/group is signalled. Parent close alone cannot release ownership. */
function command(options: Required<RenderBridgeOptions>, request: Json, observer: RenderBridgeObserver): Promise<Json> {
  // Transport-only remaining duration, never part of the persisted visual identity.
  const input = Buffer.from(JSON.stringify({ ...request, timeout_ms: options.timeoutMs }));
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
    const budgetTimer = observer.lifecycle ? setInterval(() => {
      if (closed || failure) return;
      try {
        observer.lifecycle!.observe(String(request.candidate_dir ?? join(String(request.job_root), ".render-generations", ".candidate-none")), child.pid);
      } catch (err) { stop(err instanceof RenderBudgetError ? err.cause : "resource_accounting_unavailable"); }
    }, 100) : undefined;
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
        if (budgetTimer) clearInterval(budgetTimer);
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
      if (budgetTimer) clearInterval(budgetTimer);
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
        qualityLayersContract(result);
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
  const partialSealProofs = new WeakMap<RenderBridgeCandidate, QualityVerifier>();
  const runtimeSealProofs = new WeakMap<RenderBridgeCandidate, QualityVerifier>();
  // One monotonic budget covers validation hashes, both child runs and final
  // evidence hashes. Cooperative I/O checkpoints cannot interrupt a stuck OS
  // filesystem call; jobs sealing and Windows containment remain separate gates.
  const remaining = (deadline: number, observer: RenderBridgeObserver): number => {
    observer.lifecycle?.check();
    if (observer.signal?.aborted) throw new RenderBridgeError("render_generation_cancelled", "cancelled");
    const left = Math.ceil(deadline - performance.now());
    if (left <= 0) throw new RenderBridgeError("render_generation_timeout", "timeout");
    return left;
  };

  const fresh = async (request: Json, check: () => void): Promise<OutputEvidence[]> => {
    check();
    const root = String(request.job_root);
    await inside(options.dataRoot, root);
    const source = join(root, "resolved_job.json");
    const evidence = await fileIdentity(root, source, PLAN_LIMIT, check);
    if (evidence.sha256 !== request.expected_source_sha256) invalid("source_changed");
    // Parsing only locates bounded input files; Python remains the sole RF-02 validator.
    const handle = await open(source, "r");
    let raw: Buffer;
    try { raw = Buffer.alloc(evidence.bytes); await handle.read(raw, 0, raw.length, 0); }
    finally { await handle.close(); }
    check();
    if (digest(raw) !== evidence.sha256) invalid("source_changed");
    const assets = object(object(JSON.parse(raw.toString("utf8"))).assets);
    const rows: OutputEvidence[] = [];
    for (const face of FACES) {
      const path = absolute(String(assets[face]));
      const current = await fileIdentity(root, path, FILE_LIMIT, check);
      if (current.sha256 !== object(request.expected_asset_sha256)[face]) invalid("asset_changed");
      rows.push(current);
    }
    return rows;
  };

  const verify = async (input: RenderBridgeValidation, observer: RenderBridgeObserver, deadline: number): Promise<RenderPlanReceipt> => {
    try {
      const check = () => { remaining(deadline, observer); };
      check();
      const request: Json = {
        schema: "packaging-render-generation-request/1", action: "validate",
        job_root: absolute(input.jobRoot), mode: input.mode,
        expected_source_sha256: sha(input.expectedSourceSha256),
        expected_asset_sha256: Object.fromEntries(FACES.map(face => [face, sha(input.expectedAssetSha256[face])])),
      };
      if (input.studioAdjustment) request.studio_adjustment = { ...input.studioAdjustment };
      await inside(options.dataRoot, String(request.job_root));
      await fresh(request, check);
      const result = await command({ ...options, timeoutMs: remaining(deadline, observer) }, request, observer);
      check();
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
      const sourceAssets = await fresh(request, check);
      const receipt = Object.freeze({
        sourceSha256: sha(source.resolved_job_sha256), planIdentity: sha(source.plan_identity),
        candidateIdentity: sha(result.candidate_identity), profile: source.render_profile_id,
        sourceAssets: Object.freeze(sourceAssets.map(row => Object.freeze({ ...row }))),
      });
      check();
      receipts.set(receipt, { request, source, studio: result.studio_adjustment, used: false, deadline });
      return receipt;
    } catch (error) { throw publicFailure(error); }
  };

  const bridge = {
    async assertJobRoot(jobRoot: string): Promise<void> { await inside(options.dataRoot, absolute(jobRoot)); },
    async verifyBytes(input: { jobRoot: string; bytes: Buffer; mode: RenderBridgeValidation["mode"]; studioAdjustment?: Studio },
      observer: RenderBridgeObserver = {}): Promise<RenderPlanReceipt> {
      const deadline = observer.lifecycle?.deadline ?? performance.now() + options.timeoutMs;
      const check = () => { remaining(deadline, observer); };
      try {
        check();
        const root = absolute(input.jobRoot);
        if (!Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > PLAN_LIMIT) invalid("plan_budget");
        const bytes = Buffer.from(input.bytes);
        await inside(options.dataRoot, root);
        check();
        const assets = object(object(JSON.parse(bytes.toString("utf8"))).assets);
        const hashes = {} as RenderBridgeValidation["expectedAssetSha256"];
        for (const face of FACES) hashes[face] = (await fileIdentity(root, absolute(String(assets[face])), FILE_LIMIT, check)).sha256;
        return await verify({ jobRoot: root, mode: input.mode, expectedSourceSha256: digest(bytes),
          expectedAssetSha256: hashes, studioAdjustment: input.studioAdjustment }, observer, deadline);
      } catch (error) { throw publicFailure(error); }
    },
    verify(input: RenderBridgeValidation, observer: RenderBridgeObserver = {}): Promise<RenderPlanReceipt> {
      return verify(input, observer, observer.lifecycle?.deadline ?? performance.now() + options.timeoutMs);
    },

    async render(receipt: RenderPlanReceipt, candidate: string, blender: string,
      observer: RenderBridgeObserver = {}): Promise<RenderBridgeCandidate> {
      try {
        const binding = receipts.get(receipt);
        if (!binding || binding.used) invalid("receipt_unknown_or_used");
        // A render attempt consumes its receipt, even on failure; retries require fresh validation.
        binding.used = true;
        const check = () => { remaining(binding.deadline, observer); };
        check();
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
        await fresh(binding.request, check);
        const result = await command({ ...options, timeoutMs: remaining(binding.deadline, observer) }, {
          ...binding.request, action: "render-candidate", candidate_dir: candidateDir,
          blender_executable: absolute(blender),
        }, observer);
        observer.lifecycle?.observe(candidateDir);
        check();
        const execution = object(result.execution);
        if (result.action !== "render-candidate" || result.mode !== binding.request.mode
          || !same(result.source_identity, binding.source) || !same(result.studio_adjustment, binding.studio)
          || result.candidate_identity !== receipt.candidateIdentity || result.candidate_plan_identity !== receipt.planIdentity
          || result.candidate_dir !== candidateDir || execution.status !== "rendered"
          || typeof execution.nonce !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(execution.nonce)) {
          invalid("execution_binding");
        }
        if (!same(result.artifact_checks, { glb: "passed", full_card: "passed", source_sampling: "passed" })) invalid("artifact_checks");
        const rows = object(result.outputs);
        await inside(options.dataRoot, candidateDir);
        if (REQUIRED.some(key => !rows[key])) invalid("required_output_missing");
        const outputs: Record<string, OutputEvidence> = {};
        for (const [key, raw] of Object.entries(rows)) {
          if (!OUTPUT_KEYS.has(key)) invalid("output_key");
          const row = object(raw);
          const evidence = await fileIdentity(candidateDir, absolute(String(row.path)), FILE_LIMIT, check);
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
        await fresh(binding.request, check);
        check();
        const workerQuality = object(result.quality);
        if (workerQuality.runtime_gate !== "pass") invalid("unexpected_quality_claim");
        const candidateResult: RenderBridgeCandidate = { receipt, candidateDir, executionNonce: execution.nonce, outputs, optionalWarnings,
          quality: { status: "layered", production_ready: false, runtime_gate: "pass", human_acceptance: "pending" } };
        // Capture copies, never trust caller-mutable candidate rows as proof.
        const files = Object.entries(outputs).filter(([key]) => RENDER_GENERATION_OUTPUT_KEYS[key])
          .map(([key, row]) => ({ key: RENDER_GENERATION_OUTPUT_KEYS[key], sha256: row.sha256.slice(7), bytes: row.bytes }))
          .sort((a, b) => a.key.localeCompare(b.key));
        const faces = Object.fromEntries(FACES.map(face => [face, String(object(binding.request.expected_asset_sha256)[face]).slice(7)]));
        const fingerprint = contentFingerprint(files, faces);
        const contract = receipt.sourceSha256.slice(7);
        const mode = binding.request.mode;
        let consumed = false;
        const runtimeLifecycle = observer.lifecycle;
        const makeProof = (runtime: boolean): QualityVerifier => input => {
          if (consumed) invalid("seal_proof_used");
          consumed = true; // Failure, cancellation and expiry also consume this attempt.
          check();
          if (runtime) runtimeLifecycle!.check();
          const accepted = (!runtime || input.resource_lifecycle === runtimeLifecycle)
            && (mode === "legacy_relight" || mode === "upgrade") && input.mode === mode
            && input.contract_sha256 === contract && input.content_fingerprint === fingerprint
            && same(input.faces, faces)
            && same([...input.files].sort((a, b) => a.key.localeCompare(b.key)), files);
          return { generation_id: input.generation_id, contract_sha256: input.contract_sha256,
            content_fingerprint: input.content_fingerprint, verifier_status: accepted ? "accepted" : "rejected",
            quality_status: accepted ? (runtime ? "runtime_verified" : "unwired") : "failed",
            verifier: runtime ? "rf03-runtime-artifacts/1" : "rf03-artifact-subgates/1",
            layers: {
              runtime_hard: accepted && runtime ? "pass" : accepted ? "not-run" : "fail",
              fixture_regression_hard: "not-run",
              human_acceptance: "pending",
              production_ready: false,
            },
            note: accepted ? (runtime ? "本轮合同、六面、实际 GLB/full/card、源 PNG 网格及封存字节一致；资源生命周期受限；夹具回归未跑；human_acceptance 独立 pending；不代表视觉基线、PDF 固有清晰度或实机验收" : "GLB/full/card/源采样子门与封存字节一致；fixture regression 未在真实任务运行；human_acceptance 独立 pending") : "封存字节与本轮候选凭证不符" };
        };
        partialSealProofs.set(candidateResult, makeProof(false));
        if (isRenderLifecycle(runtimeLifecycle)) runtimeSealProofs.set(candidateResult, makeProof(true));
        return candidateResult;
      } catch (error) { throw publicFailure(error); }
    },

    /** Local one-shot subgate proof. Not a production/runtime pass or a g0 import verifier. */
    createPartialSealVerifier(candidate: RenderBridgeCandidate): QualityVerifier {
      const verifier = partialSealProofs.get(candidate);
      if (!verifier) invalid("candidate_unknown_or_used");
      partialSealProofs.delete(candidate);
      runtimeSealProofs.delete(candidate);
      return verifier;
    },
    /** Requires the real resource lifecycle and this bridge's verified candidate.
     * Runtime artifact conformance is deliberately not visual-baseline approval.
     */
    createRuntimeSealVerifier(candidate: RenderBridgeCandidate): QualityVerifier {
      const verifier = runtimeSealProofs.get(candidate);
      if (!verifier) invalid("runtime_proof_unavailable");
      runtimeSealProofs.delete(candidate);
      partialSealProofs.delete(candidate);
      return verifier;
    },
  };
  return bridge;
}
