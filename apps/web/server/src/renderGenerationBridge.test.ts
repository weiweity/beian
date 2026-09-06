import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";
import { createRenderGenerationBridge, type RenderBridgeValidation } from "./renderGenerationBridge.js";
import { renderGenerationProcessSupported } from "./renderGenerationProcess.js";
import { contentFingerprint, type QualityVerifyInput } from "./renderGenerations.js";
import { createRenderLifecycle, renderReservationPath } from "./renderGenerationBudget.js";

const faces = ["front", "right", "back", "left", "top", "bottom"] as const;
const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Batch 07 controlled command protocol fixture, not RF-02/Blender validation.
// Actual Node -> Python integration coverage belongs to the subsequent batch 08.
const worker = String.raw`
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', b => input += b);
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  if (!Number.isSafeInteger(req.timeout_ms) || req.timeout_ms < 1 || req.timeout_ms > 1260000) throw Error('missing remaining time budget');
  const behavior = fs.readFileSync(path.join(__dirname, 'behavior'), 'utf8');
  if (behavior === 'disk-growth' || behavior === 'memory-growth') {
    fs.mkdirSync(req.candidate_dir);
    if (behavior === 'disk-growth') fs.writeFileSync(path.join(req.candidate_dir,'undeclared.bin'), Buffer.alloc(16*1024*1024,3));
    else global.retained = Buffer.alloc(256*1024*1024,3);
    setInterval(()=>{},1000); return;
  }
  const hash = b => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
  const id = hash('plan');
  const result = { ok:true, schema:'packaging-render-generation-result/1', action:req.action, mode:req.mode,
    source_identity: {resolved_job_sha256:req.expected_source_sha256, plan_identity:id,
      render_contract_hash:hash('contract'), render_profile_id:'synthetic-test', assets:req.expected_asset_sha256},
    candidate_plan_identity:id, candidate_identity:hash('candidate'), candidate_dir:req.candidate_dir || null,
    studio_adjustment:req.studio_adjustment || null,
    execution:{status:'validated', nonce:null}, outputs:{}, optional_warnings:[],
    quality:{status:'unwired', wired:false, runtime_gate:'pending', production_ready:false}};
  if (behavior === 'hang') {setInterval(()=>{}, 1000); return;}
  if (behavior === 'delayed-stop') {
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 120));
    process.stderr.write('STAGE validate\n');
    setInterval(()=>{},1000); return;
  }
  if (behavior === 'ignore-stop') {
    process.on('SIGTERM', () => {});
    process.stderr.write('STAGE validate\n');
    setInterval(()=>{},1000); return;
  }
  if (behavior === 'stdout-budget') {process.stdout.write('x'.repeat(1100000)); return;}
  if (behavior === 'stderr-budget') {process.stderr.write('x'.repeat(1100000)); return;}
  if (behavior === 'bad-json') {console.log('not JSON'); return;}
  if (behavior === 'nonzero') {console.log(JSON.stringify(result)); process.exitCode=1; return;}
  if (behavior.startsWith('orphan-')) {
    // Deliberately outlive the parent; orphan-pipes also inherits its output streams.
    // Finite lifetime also cleans up the controlled orphan when the regression fails.
    const descendant = require('node:child_process').spawn(process.execPath, ['-e',
      "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),1000);process.send('ready');"],
      {stdio:behavior === 'orphan-pipes' ? ['ignore',process.stdout,process.stderr,'ipc'] : ['ignore','ignore','ignore','ipc']});
    descendant.once('message', () => {
      fs.writeFileSync(path.join(__dirname, 'descendant-pid'), String(descendant.pid));
      descendant.disconnect(); descendant.unref();
      if (behavior === 'orphan-cancel') {
        process.stderr.write('STAGE validate\n'); setInterval(()=>{},1000); return;
      }
      if (behavior === 'orphan-pipes') process.stderr.write('STAGE prepare\n');
      console.log(JSON.stringify(result));
      process.exitCode = behavior === 'orphan-fail' ? 1 : 0;
    });
    return;
  }
  process.stderr.write('PRIVATE_NOT_FOR_UI\nSTAGE validate\n');
  if (req.action === 'render-candidate') {
    fs.mkdirSync(req.candidate_dir);
    for (const key of ['front_right','back_left','front_right_card','back_left_card','glb']) {
      const filename = path.join(req.candidate_dir, key);
      fs.writeFileSync(filename, 'synthetic-' + key);
      const bytes=fs.readFileSync(filename);
      result.outputs[key]={path:filename,sha256:hash(bytes),bytes:bytes.length};
    }
    result.execution={status:'rendered',nonce:'0123456789abcdef0123456789abcdef'};
    result.artifact_checks={glb:'passed',full_card:'passed',source_sampling:'passed'}; // Transport double, not real artifact QA.
    process.stderr.write('STAGE prepare\nSTAGE blender\n');
  }
  if (behavior === 'source-mismatch') result.source_identity.resolved_job_sha256=hash('wrong');
  if (behavior === 'asset-mismatch') result.source_identity.assets.front=hash('wrong');
  if (behavior === 'plan-mismatch') result.candidate_plan_identity=hash('wrong');
  if (behavior === 'quality-pass') result.quality.production_ready=true;
  if (behavior === 'lighting-mismatch') result.studio_adjustment={product_light:4,background_light:4};
  if (behavior === 'source-changed') fs.appendFileSync(path.join(req.job_root,'resolved_job.json'), ' ');
  if (behavior === 'asset-changed') fs.appendFileSync(JSON.parse(fs.readFileSync(path.join(req.job_root,'resolved_job.json'))).assets.front, '!');
  if (behavior === 'output-hash') result.outputs.glb.sha256=hash('wrong');
  if (behavior === 'output-size') result.outputs.glb.bytes++;
  if (behavior === 'output-path') result.outputs.glb.path=path.join(req.job_root,'resolved_job.json');
  if (behavior === 'output-symlink') {fs.unlinkSync(result.outputs.glb.path);fs.symlinkSync(path.join(req.job_root,'resolved_job.json'),result.outputs.glb.path);}
  if (behavior === 'missing-output') delete result.outputs.glb;
  if (behavior === 'missing-nonce') result.execution.nonce=null;
  if (behavior === 'missing-checks') delete result.artifact_checks;
  if (behavior === 'failed-check') result.artifact_checks.full_card='failed';
  if (behavior === 'failed-sampling') result.artifact_checks.source_sampling='failed';
  if (behavior === 'execution-identity') result.candidate_identity=hash('wrong');
  if (behavior === 'candidate-path') result.candidate_dir=req.job_root;
  if (behavior === 'optional-warning') result.optional_warnings=[{key:'blend',cause:'optional_missing'}];
  if (behavior === 'invalid-warning') result.optional_warnings=[{key:'glb',cause:'optional_missing'}];
  if (behavior === 'unknown-output') result.outputs.untrusted=result.outputs.glb;
  if (behavior === 'profile-invalid') result.source_identity.render_profile_id='../private';
  if (behavior === 'protocol-invalid') result.schema='unknown/1';
  if (behavior === 'structured-error' || behavior === 'private-error') {
    result.ok=false; result.code='render_generation_failed';
    result.cause=behavior === 'structured-error' ? 'missing_blender' : '/private/secret';
  }
  console.log(JSON.stringify(result));
});
`;

function fixture(timeoutMs = 2000, terminationGraceMs = 200) {
  const root = makeTestTempDir("beian-render-bridge-");
  const jobRoot = join(root, "job");
  const packagingDir = join(root, "worker");
  mkdirSync(jobRoot);
  mkdirSync(packagingDir);
  mkdirSync(join(jobRoot, "assets"));
  mkdirSync(join(jobRoot, ".render-generations"));
  const assets = Object.fromEntries(faces.map(face => [face, join(jobRoot, "assets", `panel_${face}.png`)]));
  for (const file of Object.values(assets)) writeFileSync(file, "synthetic-face");
  const raw = Buffer.from(JSON.stringify({ assets }));
  writeFileSync(join(jobRoot, "resolved_job.json"), raw);
  writeFileSync(join(packagingDir, "render_generation.py"), worker);
  const behavior = (name: string) => writeFileSync(join(packagingDir, "behavior"), name);
  behavior("normal");
  const options = { pythonExecutable: process.execPath, packagingDir, dataRoot: root, timeoutMs, terminationGraceMs };
  const bridge = createRenderGenerationBridge(options);
  const input: RenderBridgeValidation = {
    jobRoot, mode: "preserve", expectedSourceSha256: hash(raw),
    expectedAssetSha256: Object.fromEntries(faces.map(face => [face, hash("synthetic-face")])) as RenderBridgeValidation["expectedAssetSha256"],
    studioAdjustment: { product_light: 1.2, background_light: 0.8 },
  };
  const candidate = join(jobRoot, ".render-generations", ".candidate-test");
  return { root, jobRoot, bridge, options, input, candidate, behavior, raw };
}

it("refuses the uncontained Windows bridge before spawn or stdin delivery", { skip: process.platform !== "win32" }, async () => {
  const f = fixture();
  await assert.rejects(f.bridge.verify(f.input, {
    onSpawn: () => { assert.fail("no uncontained worker may start"); },
  }), /process_containment_unavailable/);
});

describe("RF-03C2.1 async render bridge", { skip: !renderGenerationProcessSupported() }, () => {
  for (const sealContext of ["same", "missing", "closed"] as const) {
    it(`runtime proof requires the real live seal resource context: ${sealContext}`, async () => {
      const f = fixture(5000); f.input.mode = "legacy_relight";
      const lifecycle = createRenderLifecycle({root:join(f.jobRoot,".render-generations"),mutationId:"proof",
        timeoutMs:5000,diskBytes:8*1024*1024,memoryBytes:512*1024*1024});
      try {
        const receipt = await f.bridge.verify(f.input,{lifecycle});
        const candidate = await f.bridge.render(receipt,f.candidate,process.execPath,{lifecycle});
        const proof = f.bridge.createRuntimeSealVerifier(candidate);
        assert.throws(() => f.bridge.createPartialSealVerifier(candidate),/candidate_unknown_or_used/);
        const mapping: Record<string,string> = {front_right:"white_a",back_left:"white_b",glb:"glb",
          front_right_card:"white_a_card",back_left_card:"white_b_card"};
        const files = Object.entries(candidate.outputs).map(([key,row]) => ({key:mapping[key],sha256:row.sha256.slice(7),bytes:row.bytes}));
        const faceHashes = Object.fromEntries(faces.map(face => [face,hash("synthetic-face").slice(7)])) as QualityVerifyInput["faces"];
        const input: QualityVerifyInput = {generation_id:"g1-runtime",contract_sha256:receipt.sourceSha256.slice(7),mode:"legacy_relight",
          files,faces:faceHashes,content_fingerprint:contentFingerprint(files,faceHashes),resource_lifecycle:sealContext === "missing" ? undefined : lifecycle};
        if (sealContext === "closed") {
          lifecycle.release(true); assert.throws(() => proof(input),/lifecycle_closed/);
        } else assert.equal(proof(input).quality_status,sealContext === "same" ? "runtime_verified" : "failed");
        assert.throws(() => proof(input),/seal_proof_used/);
      } finally { lifecycle.release(true); }
    });
  }

  it("an unbudgeted bridge cannot mint a runtime proof from successful protocol/artifact results", async () => {
    const f = fixture(); f.input.mode = "legacy_relight";
    const receipt = await f.bridge.verify(f.input);
    const candidate = await f.bridge.render(receipt,f.candidate,process.execPath);
    assert.throws(() => f.bridge.createRuntimeSealVerifier(candidate),/runtime_proof_unavailable/);
  });

  for (const resource of ["disk", "memory"]) {
    it(`stops a real owned worker on sampled ${resource} excess and confirms exit before release`, async () => {
      const f = fixture(5000);
      const root = join(f.jobRoot, ".render-generations");
      const lifecycle = createRenderLifecycle({root, mutationId: "resources", timeoutMs: 5000,
        diskBytes: 8*1024*1024, memoryBytes: 256*1024*1024});
      let owned = false;
      const observer = { lifecycle, onSpawn: () => { owned = true; }, onClose: () => { owned = false; } };
      try {
        const receipt = await f.bridge.verify(f.input, observer);
        f.behavior(resource + "-growth");
        await assert.rejects(f.bridge.render(receipt, f.candidate, process.execPath, observer), new RegExp(resource + "_budget"));
        assert.equal(owned, false);
      } finally { lifecycle.release(!owned); }
      assert.equal(existsSync(renderReservationPath(root, "resources")), false);
      if (resource === "disk") assert.equal(existsSync(join(f.candidate, "undeclared.bin")), true);
    });
  }

  for (const damage of ["none", "files", "bytes", "faces", "contract", "fingerprint", "mode", "extra", "missing", "duplicate"]) {
    it(`binds one-shot partial seal proof to copied evidence: ${damage}`, async () => {
      const f = fixture();
      f.input.mode = "legacy_relight";
      const receipt = await f.bridge.verify(f.input);
      const candidate = await f.bridge.render(receipt, f.candidate, process.execPath);
      const mapping: Record<string, string> = {front_right:'white_a',back_left:'white_b',glb:'glb',
        front_right_card:'white_a_card',back_left_card:'white_b_card'};
      const files = Object.entries(candidate.outputs).map(([key,row]) => ({key:mapping[key],sha256:row.sha256.slice(7),bytes:row.bytes}));
      const faceHashes = Object.fromEntries(faces.map(face => [face,hash('synthetic-face').slice(7)])) as QualityVerifyInput['faces'];
      const input: QualityVerifyInput = {generation_id:'g1-test',contract_sha256:receipt.sourceSha256.slice(7),
        mode:'legacy_relight',files,faces:faceHashes,content_fingerprint:contentFingerprint(files,faceHashes)};
      assert.throws(() => f.bridge.createPartialSealVerifier({...candidate}), /candidate_unknown_or_used/);
      assert.throws(() => createRenderGenerationBridge(f.options).createPartialSealVerifier(candidate), /candidate_unknown_or_used/);
      const verifier = f.bridge.createPartialSealVerifier(candidate);
      assert.throws(() => f.bridge.createPartialSealVerifier(candidate), /candidate_unknown_or_used/);
      // Caller mutations cannot rewrite bridge-private expected evidence.
      candidate.outputs.glb.sha256 = hash('forged');
      if (damage === 'files') input.files[0].sha256 = hash('wrong').slice(7);
      if (damage === 'bytes') input.files[0].bytes++;
      if (damage === 'faces') input.faces.front = hash('wrong').slice(7);
      if (damage === 'contract') input.contract_sha256 = hash('wrong').slice(7);
      if (damage === 'fingerprint') input.content_fingerprint = hash('wrong').slice(7);
      if (damage === 'mode') input.mode = 'legacy_import';
      if (damage === 'extra') input.files.push({key:'white_a_ground',sha256:hash('extra').slice(7),bytes:12});
      if (damage === 'missing') input.files.pop();
      if (damage === 'duplicate') input.files.push({...input.files[0]});
      const result = verifier(input);
      assert.equal(result.verifier_status, damage === 'none' ? 'accepted' : 'rejected');
      assert.equal(result.quality_status, damage === 'none' ? 'unwired' : 'failed');
      assert.throws(() => verifier(input), /seal_proof_used/);
    });
  }

  for (const behavior of ['missing-checks', 'failed-check', 'failed-sampling']) {
    it(`refuses missing or failed CLI artifact checks: ${behavior}`, async () => {
      const f = fixture();
      const receipt = await f.bridge.verify(f.input);
      f.behavior(behavior);
      await assert.rejects(f.bridge.render(receipt, f.candidate, process.execPath), /artifact_checks/);
    });
  }

  for (const reason of ['cancelled', 'timeout']) {
    it(`consumes partial seal proof when ${reason} before sealing`, async () => {
      const f = fixture(reason === 'timeout' ? 1000 : 2000);
      f.input.mode = 'legacy_relight';
      const controller = new AbortController();
      const receipt = await f.bridge.verify(f.input, {signal:controller.signal});
      const candidate = await f.bridge.render(receipt, f.candidate, process.execPath, {signal:controller.signal});
      const verifier = f.bridge.createPartialSealVerifier(candidate);
      if (reason === 'cancelled') controller.abort();
      else await delay(1050);
      // Cancellation/deadline is checked before reading any caller-supplied evidence.
      assert.throws(() => verifier(undefined as unknown as QualityVerifyInput), new RegExp(reason));
      assert.throws(() => verifier(undefined as unknown as QualityVerifyInput), /seal_proof_used/);
    });
  }

  it("shares one deadline between validation and candidate execution", async () => {
    const f = fixture(1000);
    const receipt = await f.bridge.verifyBytes({ jobRoot: f.jobRoot, bytes: f.raw, mode: "preserve" });
    await delay(1050);
    await assert.rejects(f.bridge.render(receipt, f.candidate, process.execPath, {
      onSpawn: () => assert.fail("expired receipt must not start another process"),
    }), /timeout/);
    assert.equal(existsSync(f.candidate), false);
    await assert.rejects(f.bridge.render(receipt, f.candidate, process.execPath), /receipt_unknown_or_used/);
  });

  it("honors cancellation before reading input files", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.bridge.verifyBytes({ jobRoot: join(f.root, "missing"), bytes: f.raw, mode: "preserve" }, {
      signal: controller.signal,
    }), /cancelled/);
  });

  it("validates bounded bytes and freezes all receipt evidence without a lighting adjustment", async () => {
    const f = fixture();
    const receipt = await f.bridge.verifyBytes({ jobRoot: f.jobRoot, bytes: f.raw, mode: "preserve" });
    assert.equal(receipt.sourceSha256, hash(f.raw));
    assert.equal(receipt.sourceAssets.length, 6);
    assert.ok(Object.isFrozen(receipt.sourceAssets));
    assert.ok(receipt.sourceAssets.every(row => Object.isFrozen(row) && row.sha256 === hash("synthetic-face")));
    const result = await f.bridge.render(receipt, f.candidate, process.execPath);
    assert.equal(result.receipt, receipt);
    assert.deepEqual(result.optionalWarnings, []);
  });

  it("rejects empty, oversized, non-object and stale supplied plan bytes before spawn", async () => {
    const f = fixture();
    for (const [bytes, cause] of [[Buffer.alloc(0), /plan_budget/], [Buffer.alloc(8 * 1024 * 1024 + 1), /plan_budget/],
      [Buffer.from("[]"), /protocol_object/], [Buffer.concat([f.raw, Buffer.from(" ")]), /source_changed/]] as const) {
      await assert.rejects(f.bridge.verifyBytes({ jobRoot: f.jobRoot, bytes, mode: "preserve" }, {
        onSpawn: () => assert.fail("invalid bytes must not spawn"),
      }), cause);
    }
  });

  it("rejects invalid absolute paths, time budgets, hashes and execution contexts", async () => {
    const f = fixture();
    for (const pythonExecutable of ["relative", "/private/\u0000bad", "/" + "x".repeat(1024)]) {
      assert.throws(() => createRenderGenerationBridge({ ...f.options, pythonExecutable }), /absolute_path/);
    }
    for (const timeoutMs of [0, -1, 1.5, NaN, 1_260_001]) {
      assert.throws(() => createRenderGenerationBridge({ ...f.options, timeoutMs }), /time_budget/);
    }
    assert.throws(() => createRenderGenerationBridge({ ...f.options, terminationGraceMs: 5001 }), /time_budget/);
    await assert.rejects(f.bridge.verify({ ...f.input, expectedSourceSha256: "bad" }), /protocol_sha256/);
    await assert.rejects(f.bridge.verify(f.input, { context: { jobId: "../bad", mutationId: "ok" },
      onSpawn: () => assert.fail("invalid context must not spawn") }), /execution_context/);
  });

  it("accepts a missing optional asset warning while retaining all required evidence", async () => {
    const f = fixture();
    const receipt = await f.bridge.verify(f.input);
    f.behavior("optional-warning");
    const result = await f.bridge.render(receipt, f.candidate, process.execPath);
    assert.deepEqual(result.optionalWarnings, [{ key: "blend", cause: "optional_missing" }]);
    assert.equal(Object.keys(result.outputs).length, 5);
  });

  it("rejects empty and hard-linked source assets before spawning", async () => {
    for (const kind of ["empty", "hard-link"]) {
      const f = fixture();
      const asset = join(f.jobRoot, "assets", "panel_front.png");
      if (kind === "empty") writeFileSync(asset, "");
      else linkSync(asset, join(f.jobRoot, "second-link"));
      let spawned = false;
      await assert.rejects(f.bridge.verify(f.input, { onSpawn: () => { spawned = true; } }), /file_budget_or_type/);
      assert.equal(spawned, false);
    }
  });

  it("caps serialized requests before ownership is acquired", async () => {
    const f = fixture();
    let spawned = false;
    const studioAdjustment = { ...f.input.studioAdjustment!, extra: "x".repeat(65536) };
    await assert.rejects(f.bridge.verify({ ...f.input, studioAdjustment }, {
      onSpawn: () => { spawned = true; },
    }), /request_budget/);
    assert.equal(spawned, false);
  });

  for (const [behavior, cause] of [["invalid-warning", /optional_warnings/], ["unknown-output", /output_key/]] as const) {
    it(`rejects ${behavior} and consumes the failed receipt`, async () => {
      const f = fixture();
      const receipt = await f.bridge.verify(f.input);
      f.behavior(behavior);
      await assert.rejects(f.bridge.render(receipt, f.candidate, process.execPath), cause);
      await assert.rejects(f.bridge.render(receipt, f.candidate, process.execPath), /receipt_unknown_or_used/);
    });
  }

  it("propagates safe structured worker errors and suppresses private causes", async () => {
    const f = fixture();
    f.behavior("structured-error");
    await assert.rejects(f.bridge.verify(f.input), { code: "render_generation_failed", cause: "missing_blender" });
    f.behavior("private-error");
    await assert.rejects(f.bridge.verify(f.input), { code: "render_generation_failed", cause: "worker_exit" });
  });

  it("rejects invalid protocol schemas and profile identities", async () => {
    const f = fixture();
    for (const [behavior, cause] of [["protocol-invalid", /worker_protocol/], ["profile-invalid", /profile_identity/]] as const) {
      f.behavior(behavior);
      await assert.rejects(f.bridge.verify(f.input), cause);
    }
  });

  it("pairs close ownership with the spawn identity and rejects close persistence failure", async () => {
    const f = fixture();
    let spawned: [number, string] | undefined;
    let closed: [number, string] | undefined;
    await assert.rejects(f.bridge.verify(f.input, {
      context: { jobId: "job_07", mutationId: "change_07" },
      onSpawn: (pid, id) => { spawned = [pid, id]; },
      onClose: (pid, id) => {
        closed = [pid, id];
        throw new Error("private persistence failure");
      },
    }), { code: "render_generation_failed", cause: "close_persistence" });
    assert.ok(closed);
    assert.deepEqual(closed, spawned);
    assert.match(closed[1], /^job_07:change_07:[a-f0-9]{32}$/);
    const closedPid = closed[0];
    assert.throws(() => process.kill(-closedPid, 0), { code: "ESRCH" });
  });
  it("bounds inherited-pipe draining without releasing a live orphan group", async () => {
    const f = fixture(3000, 50);
    f.behavior("orphan-pipes");
    let parent = 0, released = false;
    let descendantReadyAt = 0;
    try {
      await assert.rejects(f.bridge.verify(f.input, {
        onSpawn: pid => { parent = pid; }, onClose: () => { released = true; },
        onStage: stage => { if (stage === "prepare") descendantReadyAt = Date.now(); },
      }), /process_group_unconfirmed/);
      assert.ok(descendantReadyAt > 0, "descendant must be ready before testing inherited-pipe draining");
      assert.ok(Date.now() - descendantReadyAt < 700, "must settle before the orphan's one-second self-exit");
      assert.equal(released, false);
      assert.throws(() => process.kill(parent, 0), { code: "ESRCH" });
      assert.doesNotThrow(() => process.kill(-parent, 0));
    } finally {
      for (let i = 0; i < 250 && parent; i++) {
        try { process.kill(-parent, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") { parent = 0; break; }
        }
        await delay(20);
      }
      assert.equal(parent, 0, "finite fixture cleans up without killing an unowned PID");
    }
  });
  for (const behavior of ["orphan-success", "orphan-fail", "orphan-cancel"]) {
    it(`does not release ownership on parent close with a live descendant: ${behavior}`, { skip: process.platform === "win32" }, async () => {
      const f = fixture(3000, 150);
      f.behavior(behavior);
      let parent = 0;
      let released = false;
      const controller = new AbortController();
      try {
        await assert.rejects(f.bridge.verify(f.input, {
          signal: controller.signal,
          onSpawn: pid => { parent = pid; },
          onClose: () => { released = true; },
          onStage: () => controller.abort(),
        }), /process_group_unconfirmed/);
        assert.equal(released, false, "parent close is not group exit evidence");
        assert.throws(() => process.kill(parent, 0), { code: "ESRCH" });
        assert.doesNotThrow(() => process.kill(Number(readFileSync(join(f.options.packagingDir, "descendant-pid"), "utf8")), 0));
      } finally {
        // No arbitrary PID killing: this fixture exits by its own bounded timer.
        for (let i = 0; i < 250 && parent; i++) {
          try { process.kill(-parent, 0); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") { parent = 0; break; }
          }
          await delay(20);
        }
        assert.equal(parent, 0, "controlled process group must finish cleanup");
      }
    });
  }
  it("validates and renders with bound evidence, leaves source unchanged, never claims quality pass", async () => {
    const f = fixture();
    const stages: string[] = [];
    let pid = 0;
    const receipt = await f.bridge.verify(f.input, { onSpawn: p => { pid = p; }, onStage: stage => stages.push(stage) });
    assert.ok(pid > 0);
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(existsSync(f.candidate), false);
    const result = await f.bridge.render(receipt, f.candidate, process.execPath, { onStage: stage => stages.push(stage) });
    assert.equal(Object.keys(result.outputs).length, 5);
    assert.deepEqual(result.quality, { status: "unwired", production_ready: false });
    assert.deepEqual(stages, ["validate", "validate", "prepare", "blender"]);
    assert.deepEqual(readFileSync(join(f.jobRoot, "resolved_job.json")), f.raw);
    assert.equal(existsSync(join(f.candidate, "generation.json")), false);
    await assert.rejects(f.bridge.render(receipt, f.candidate, process.execPath), /receipt_unknown_or_used/);
  });

  it("rejects copied receipts and receipts from another bridge", async () => {
    const f = fixture();
    const receipt = await f.bridge.verify(f.input);
    await assert.rejects(f.bridge.render({ ...receipt }, f.candidate, process.execPath), /receipt_unknown_or_used/);
    await assert.rejects(createRenderGenerationBridge(f.options).render(receipt, f.candidate, process.execPath), /receipt_unknown_or_used/);
    assert.equal(existsSync(f.candidate), false);
  });

  for (const behavior of ["source-mismatch", "asset-mismatch", "plan-mismatch", "quality-pass", "lighting-mismatch",
    "source-changed", "asset-changed", "bad-json", "nonzero", "stdout-budget", "stderr-budget"]) {
    it(`rejects validation ${behavior}`, async () => {
      const f = fixture();
      f.behavior(behavior);
      await assert.rejects(f.bridge.verify(f.input));
      assert.equal(existsSync(f.candidate), false);
    });
  }

  for (const behavior of ["output-hash", "output-size", "output-path", "output-symlink", "missing-output",
    "missing-nonce", "execution-identity", "candidate-path", "source-changed", "asset-changed", "quality-pass"]) {
    it(`rejects candidate ${behavior} without marking ready`, async () => {
      const f = fixture();
      const receipt = await f.bridge.verify(f.input);
      f.behavior(behavior);
      await assert.rejects(f.bridge.render(receipt, f.candidate, process.execPath));
      assert.equal(existsSync(join(f.candidate, "generation.json")), false);
    });
  }

  it("does not follow source asset symlinks", async () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    writeFileSync(outside, "synthetic-face");
    const plan = JSON.parse(f.raw.toString());
    plan.assets.front = join(f.jobRoot, "assets", "linked.png");
    symlinkSync(outside, plan.assets.front);
    const raw = Buffer.from(JSON.stringify(plan));
    writeFileSync(join(f.jobRoot, "resolved_job.json"), raw);
    await assert.rejects(f.bridge.verify({ ...f.input, expectedSourceSha256: hash(raw) }), /path_symlink/);
  });

  it("rejects source changes between verify and render before any subprocess starts", async () => {
    const f = fixture();
    const receipt = await f.bridge.verify(f.input);
    writeFileSync(join(f.jobRoot, "resolved_job.json"), Buffer.concat([f.raw, Buffer.from(" ")]));
    let spawned = false;
    await assert.rejects(f.bridge.render(receipt, f.candidate, process.execPath, { onSpawn: () => { spawned = true; } }), /source_changed/);
    assert.equal(spawned, false);
    assert.equal(existsSync(f.candidate), false);
  });

  it("rejects existing candidates without changing their bytes", async () => {
    const f = fixture();
    const receipt = await f.bridge.verify(f.input);
    mkdirSync(f.candidate);
    writeFileSync(join(f.candidate, "keep"), "original");
    await assert.rejects(f.bridge.render(receipt, f.candidate, process.execPath), /candidate_exists/);
    assert.equal(readFileSync(join(f.candidate, "keep"), "utf8"), "original");
  });

  it("rejects candidates outside the private job generation directory", async () => {
    const f = fixture();
    const receipt = await f.bridge.verify(f.input);
    await assert.rejects(f.bridge.render(receipt, join(f.root, ".candidate-other"), process.execPath), /candidate_location/);
  });

  it("times out a controlled hanging child without blocking the event loop", async () => {
    const f = fixture(100);
    f.behavior("hang");
    let tick = false;
    const pending = f.bridge.verify(f.input);
    const rejection = assert.rejects(pending, /timeout/);
    await delay(20); tick = true;
    assert.equal(tick, true);
    await rejection;
  });

  it("cancels before spawn", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    await assert.rejects(f.bridge.verify(f.input, { signal: controller.signal, onSpawn: () => { spawned = true; } }), /cancelled/);
    assert.equal(spawned, false);
  });

  it("cancels inside the ownership callback without delivering a request", async () => {
    const f = fixture();
    const controller = new AbortController();
    const stages: string[] = [];
    await assert.rejects(f.bridge.verify(f.input, {
      signal: controller.signal, onSpawn: () => controller.abort(), onStage: stage => stages.push(stage),
    }), /cancelled/);
    assert.deepEqual(stages, []);
  });

  it("does not leak filesystem paths on an unavailable input", async () => {
    const f = fixture();
    await assert.rejects(f.bridge.verify({ ...f.input, jobRoot: join(f.root, "missing") }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(f.root), false);
      assert.match(error.message, /input_or_file_unavailable/);
      return true;
    });
  });

  it("waits for actual child close after cancel, rather than treating the signal as completion", { skip: process.platform === "win32" }, async () => {
    const f = fixture(2000, 500);
    f.behavior("delayed-stop");
    const controller = new AbortController();
    let cancelledAt = 0;
    const task = f.bridge.verify(f.input, {
      signal: controller.signal,
      onStage: () => { cancelledAt = Date.now(); controller.abort(); },
    });
    await assert.rejects(task, /cancelled/);
    assert.ok(cancelledAt > 0);
    assert.ok(Date.now() - cancelledAt >= 100);
  });

  it("escalates only its own controlled child when graceful termination is ignored", { skip: process.platform === "win32" }, async () => {
    const f = fixture(2000, 150);
    f.behavior("ignore-stop");
    const controller = new AbortController();
    let cancelledAt = 0;
    let pid = 0;
    await assert.rejects(f.bridge.verify(f.input, {
      signal: controller.signal,
      onSpawn: value => { pid = value; },
      onStage: () => { cancelledAt = Date.now(); controller.abort(); },
    }), /cancelled/);
    assert.ok(Date.now() - cancelledAt >= 130);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });

  it("fails safely when the ownership callback throws, before delivering a request", async () => {
    const f = fixture();
    await assert.rejects(f.bridge.verify(f.input, { onSpawn: () => { throw new Error("persistence failed"); } }), /ownership_callback/);
    assert.equal(existsSync(f.candidate), false);
  });

  it("handles missing executable and observer exceptions without an unhandled process error", async () => {
    const f = fixture();
    await assert.rejects(createRenderGenerationBridge({ ...f.options, pythonExecutable: join(f.root, "missing-python") }).verify(f.input), /spawn_error/);
    await assert.rejects(f.bridge.verify(f.input, { onStage: () => { throw new Error("observer failed"); } }), /stage_callback/);
  });
});
