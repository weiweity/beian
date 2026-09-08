from __future__ import annotations

from copy import deepcopy
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path
import struct
import subprocess
import sys

from PIL import Image
import pytest

from test_packaging_pipeline_v2 import (
    FACES,
    blender_measurement_result,
    pipeline_module,
    prepare_v2_product,
    seed_required_outputs,
    write_legacy_blender_job,
)


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
PYTHON = sys.executable


@pytest.mark.parametrize("damage", [None, "front_width", "bottom_height", "asset_identity"])
def test_source_sampling_checks_actual_face_pngs(tmp_path, damage):
    gen = generation_module()
    dimensions = {"width": 2.01, "depth": 3.01, "height": 4.01}
    axes = {"front": (41, 81), "back": (41, 81), "right": (61, 81),
            "left": (61, 81), "top": (41, 61), "bottom": (41, 61)}
    assets, hashes = {}, {}
    for face, size in axes.items():
        if damage == face + "_width": size = (size[0] - 1, size[1])
        if damage == face + "_height": size = (size[0], size[1] - 1)
        path = tmp_path / f"{face}.png"
        Image.new("RGBA", size, (1, 2, 3, 255)).save(path)
        assets[face] = str(path)
        hashes[face] = gen._sha256_file(path)
    if damage == "asset_identity": hashes["front"] = "sha256:" + "0" * 64
    job = {"assets": assets}
    plan = {"spec": {"geometry": {"outer_dimensions_mm": dimensions}},
            "sampling": {"strategy": "minimum-floor-v1", "maximum_face_pixels": 32_000_000,
                         "per_face_target_pixels_per_mm": {face: 20.0 for face in axes}}}
    if damage:
        with pytest.raises(gen.RenderGenerationError) as caught:
            gen.verify_source_sampling(job, plan, hashes)
        assert caught.value.cause == "source_sampling_quality"
    else:
        report = gen.verify_source_sampling(job, plan, hashes)
        assert report["faces"]["front"]["required_size_px"] == [41, 81]
        assert report["faces"]["front"]["source_pixels_per_mm"][0] >= 20.0
        assert report["faces"]["front"]["source_sha256"] == hashes["front"]
        assert report["upstream_resample_count"] is None
        assert report["projected_pixels_per_mm"] is None


def test_low_density_source_rejected_before_prepare_or_blender(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    Image.new("RGBA", (8, 8), (1, 2, 3, 255)).save(job["assets"]["front"])
    request = request_payload(root, action="prepare", candidate_dir=str(tmp_path / "candidate"))
    before = inventory(root)
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.run_request(request)
    assert caught.value.cause == "source_sampling_quality"
    assert not (tmp_path / "candidate").exists()
    assert inventory(root) == before


@pytest.mark.parametrize("timeout", [True, 0, -1, 1_260_001, 1.5])
def test_request_timeout_budget_is_bounded(tmp_path, timeout):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.run_request(request_payload(root, timeout_ms=timeout))
    assert caught.value.cause == "timeout_budget"


def test_deadline_covers_source_read_and_resets_after_failure(tmp_path, monkeypatch):
    from types import SimpleNamespace
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    clock = [100.0]
    monkeypatch.setattr(gen, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    original = gen.read_source_job

    def slow_read(path):
        result = original(path)
        clock[0] += 2
        return result

    monkeypatch.setattr(gen, "read_source_job", slow_read)
    payload = request_payload(root, action="prepare", candidate_dir=str(tmp_path / "candidate"), timeout_ms=1000)
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.run_request(payload)
    assert caught.value.cause == "timeout"
    assert not (tmp_path / "candidate").exists()
    assert gen._REQUEST_DEADLINE.get() is None
    assert gen.run_request(request_payload(root, timeout_ms=10000))["ok"] is True


def test_disk_admission_rejects_before_creating_candidate(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    monkeypatch.setattr(gen, "_available_disk_bytes", lambda path: 0, raising=False)
    before = inventory(root)
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.run_request(request_payload(root, action="prepare", candidate_dir=str(tmp_path / "candidate")))
    assert caught.value.cause == "candidate_disk_budget"
    assert not (tmp_path / "candidate").exists()
    assert inventory(root) == before


def test_aggregate_source_pixel_budget_rejects_before_candidate(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    monkeypatch.setattr(gen, "MAX_SOURCE_PIXELS", 1, raising=False)
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.run_request(request_payload(root, action="prepare", candidate_dir=str(tmp_path / "candidate")))
    assert caught.value.cause == "source_aggregate_budget"
    assert not (tmp_path / "candidate").exists()


def test_candidate_enforces_admitted_output_ceiling(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    fake_blender(gen, monkeypatch)
    monkeypatch.setattr(gen, "check_candidate_disk_budget", lambda *args: {"candidate_output_ceiling_bytes": 1})
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.run_request(request_payload(root, action="render-candidate", candidate_dir=str(tmp_path / "candidate"),
                                        blender_executable=str(dummy_blender(tmp_path / "blender"))))
    assert caught.value.cause == "output_aggregate_budget"


def test_capture_failure_keeps_bounded_log_without_quality_or_seal(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)

    def limited(*args, **kwargs):
        raise gen.packaging_pipeline.BlenderProcessError("blender_log_budget", b"synthetic bounded evidence")

    monkeypatch.setattr(gen.packaging_pipeline, "run_bounded_blender", limited)
    candidate = tmp_path / "candidate"
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.run_request(request_payload(root, action="render-candidate", candidate_dir=str(candidate),
                                        blender_executable=str(dummy_blender(tmp_path / "blender"))))
    assert caught.value.cause == "blender_log_budget"
    assert (candidate / "blender.log").read_bytes() == b"synthetic bounded evidence"
    assert not (candidate / "generation.json").exists()


def test_invalid_optional_output_cannot_evade_disk_byte_budget(tmp_path, monkeypatch):
    gen = generation_module()
    optional = tmp_path / "bad_ground.png"
    optional.write_bytes(b"not-png" * 10)
    job = {"outputs": {"front_right_ground": str(optional)}}
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.check_output_byte_budget(job, ceiling=32)
    assert caught.value.cause == "output_aggregate_budget"
    monkeypatch.setattr(gen, "MAX_FILE_BYTES", 32)
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.check_output_byte_budget(job)
    assert caught.value.cause == "output_file_budget"


@pytest.mark.parametrize("max_edge", [10, 40])
@pytest.mark.parametrize("damage", [None, "resolution", "opaque", "empty", "card_size", "card_pixels", "card_alpha", "changed_bytes"])
def test_full_card_runtime_contract(tmp_path, damage, max_edge):
    gen = generation_module()
    outputs = {}
    for index, key in enumerate(("front_right", "back_left")):
        full = Image.new("RGBA", (16, 20), (0, 0, 0, 0))
        full.paste((40 + index * 50, 60, 80, 255), (4, 4, 12, 16))
        if key == "front_right":
            if damage == "resolution": full = full.resize((8, 10))
            if damage == "opaque": full.putalpha(255)
            if damage == "empty": full.putalpha(0)
        path = tmp_path / f"{key}.png"
        full.save(path)
        card = full.resize((8, 10), Image.Resampling.LANCZOS) if max_edge == 10 else full.copy()
        if key == "front_right":
            if damage == "card_size": card = card.resize((4, 5))
            if damage == "card_pixels": card.putpixel((4, 5), (255, 0, 0, 255))
            if damage == "card_alpha": card.putalpha(255)
        card_path = tmp_path / f"{key}_card.png"
        card.save(card_path)
        for name, file in ((key, path), (key + "_card", card_path)):
            outputs[name] = {"path": str(file), "sha256": gen._sha256_file(file), "bytes": file.stat().st_size}
    if damage == "changed_bytes":
        outputs["front_right"]["sha256"] = "sha256:" + "0" * 64
    job = {"render": {"resolution_x": 16, "resolution_y": 20}}
    if damage:
        with pytest.raises(gen.RenderGenerationError) as caught:
            gen.verify_full_card_contract(job, outputs, max_edge=max_edge)
        assert caught.value.cause == "runtime_full_card_quality"
    else:
        gen.verify_full_card_contract(job, outputs, max_edge=max_edge)


@pytest.mark.parametrize("damage", ["full_resolution", "wrong_card", "opaque"])
def test_candidate_rejects_full_card_damage_after_successful_nonce(tmp_path, monkeypatch, damage):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    fake_blender(gen, monkeypatch)
    original = gen.packaging_pipeline.run_blender_candidate

    def damaged(*args, **kwargs):
        result = original(*args, **kwargs)
        outputs = result["outputs"]
        if damage == "wrong_card":
            shutil.copyfile(outputs["back_left_card"], outputs["front_right_card"])
        else:
            with Image.open(outputs["front_right"]) as opened:
                image = opened.copy()
            if damage == "full_resolution": image = image.resize((8, 8))
            if damage == "opaque": image.putalpha(255)
            image.save(outputs["front_right"])
        return result

    monkeypatch.setattr(gen.packaging_pipeline, "run_blender_candidate", damaged)
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.run_request(request_payload(root, action="render-candidate", candidate_dir=str(tmp_path / "candidate"),
                        blender_executable=str(dummy_blender(tmp_path / "blender"))))
    assert caught.value.cause == "runtime_full_card_quality"


def test_source_plan_budget_before_json_parse(tmp_path, monkeypatch):
    gen = generation_module()
    monkeypatch.setattr(gen, "MAX_PLAN_BYTES", 32, raising=False)
    (tmp_path / "resolved_job.json").write_bytes(b" " * 33)
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.read_source_job(tmp_path)
    assert caught.value.cause == "source_plan_budget"


def test_hash_file_budget_before_read(tmp_path, monkeypatch):
    gen = generation_module()
    monkeypatch.setattr(gen, "MAX_FILE_BYTES", 16, raising=False)
    path = tmp_path / "large.png"
    path.write_bytes(b"x" * 17)
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen._sha256_file(path)
    assert caught.value.cause == "file_budget"


def test_source_pixel_budget_rejects_before_candidate_creation(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    payload = request_payload(root, action="prepare")
    candidate = tmp_path / "too-large-candidate"
    payload["candidate_dir"] = str(candidate)
    before = inventory(root)
    monkeypatch.setattr(gen, "MAX_IMAGE_PIXELS", 1, raising=False)
    with pytest.raises(gen.RenderGenerationError) as caught:
        gen.run_request(payload)
    assert caught.value.cause == "asset_pixel_budget"
    assert not candidate.exists()
    assert inventory(root) == before


def test_cli_stdin_validate_and_prepare(tmp_path: Path):
    _pipeline, _job, root = make_spec_source(tmp_path)
    before = inventory(root)
    candidate = tmp_path / "stdin-candidate"
    for action in ("validate", "prepare"):
        payload = request_payload(root, action=action)
        if action == "prepare":
            payload["candidate_dir"] = str(candidate)
        run = subprocess.run(
            [PYTHON, str(PACKAGING / "render_generation.py"), "-"],
            input=json.dumps(payload), capture_output=True, text=True, timeout=30,
        )
        assert run.returncode == 0, run.stderr
        result = json.loads(run.stdout.splitlines()[-1])
        assert result["execution"]["status"] == ("validated" if action == "validate" else "prepared")
        assert result["quality"]["production_ready"] is False
    assert inventory(root) == before
    assert (candidate / "resolved_job.json").is_file()


@pytest.mark.parametrize("use_stdin", [True, False])
def test_cli_request_budget_before_json_or_source_reads(tmp_path: Path, use_stdin: bool):
    payload = b" " * (64 * 1024 + 1)
    request_file = tmp_path / "request.json"
    request_file.write_bytes(payload)
    run = subprocess.run(
        [PYTHON, str(PACKAGING / "render_generation.py"), "-" if use_stdin else str(request_file)],
        input=payload if use_stdin else None, capture_output=True, timeout=30,
    )
    assert run.returncode == 2
    result = json.loads(run.stdout.splitlines()[-1])
    assert result["cause"] == "request_budget"
    assert result["ok"] is False


@pytest.mark.skipif(sys.platform not in ("darwin", "linux"), reason="C2 bridge requires POSIX group evidence; Windows containment is not implemented")
@pytest.mark.parametrize("entry", ["missing", "bridge", "adapter", "jobs", "seal-proof", "seal-tamper"])
def test_node_bridge_calls_real_rf02_validator_without_blender(tmp_path: Path, entry: str, profile_id="compat-legacy-v0"):
    actual_blender = entry == "actual-blender"
    uses_jobs = entry in {"jobs", "actual-blender"}
    controlled_render = entry not in {"missing", "actual-blender"}
    data_root = tmp_path
    if uses_jobs:
        _pipeline = pipeline_module()
        product, _source = prepare_v2_product(tmp_path)
        if profile_id != "compat-legacy-v0":
            template_path = tmp_path / product["template"]
            template = json.loads(template_path.read_text())
            template["render_profile_id"] = profile_id
            template_path.write_text(json.dumps(template))
        product["code"] = "00000000c222"
        data_root = tmp_path / "data"
        _job = _pipeline.preflight_product(product, tmp_path, data_root / "mockups", False, {"enabled": False}, False)
        seed_required_outputs(_job)
        Path(_job["outputs"]["glb"]).write_bytes(minimal_valid_glb())
        root = Path(_job["project_dir"])
    else:
        _pipeline, _job, root = make_spec_source(tmp_path)
    if entry.startswith("seal-"):
        Path(_job["outputs"]["glb"]).write_bytes(minimal_valid_glb())
    before = inventory(root)
    node = shutil.which("node")
    assert node, "Node is required for the Node-to-Python bridge contract test"
    repo = PACKAGING.parents[1]
    command_dir = PACKAGING
    if controlled_render:
        # Only the Blender subprocess is controlled; keep the real CLI, RF-02
        # validator, private execution snapshot, nonce checks and card writer.
        command_dir = tmp_path / "controlled-worker"
        command_dir.mkdir()
        (command_dir / "render_generation.py").write_text(
            "import sys\n"
            f"sys.path.insert(0, {str(Path(__file__).parent)!r})\n"
            "import pytest\n"
            "from test_packaging_render_generation import generation_module, fake_blender\n"
            "gen = generation_module()\n"
            "fake_blender(gen, pytest.MonkeyPatch())\n"
            "raise SystemExit(gen.main())\n",
            encoding="utf-8",
        )
    script = r"""
import assert from 'node:assert/strict';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
const config = JSON.parse(process.argv[1]);
const { createRenderGenerationBridge } = await import(config.module);
const bridge = createRenderGenerationBridge({
  pythonExecutable: config.python, packagingDir: config.packaging,
  dataRoot: config.dataRoot, timeoutMs: 30000,
});
const stages = [];
const receipt = await bridge.verify(config.input, {onStage: stage => stages.push(stage)});
assert.equal(receipt.sourceSha256, config.input.expectedSourceSha256);
assert.match(receipt.planIdentity, /^sha256:[a-f0-9]{64}$/);
assert.equal(stages.includes('validate'), true);
if (!config.useJobs) await mkdir(join(config.input.jobRoot, '.render-generations'));
if (config.useJobs) {
  process.env.WB_DATA_DIR = config.dataRoot;
  delete process.env.VITEST;
  const { registerLocalRenderGenerationRuntime } = await import(config.runtime);
  const jobs = await import(config.jobs);
  const mockup = await import(config.mockup);
  const generations = await import(config.generations);
  const plan = JSON.parse(await readFile(join(config.input.jobRoot,'resolved_job.json'),'utf8'));
  const qualityVerifier = input => ({ generation_id:input.generation_id, contract_sha256:input.contract_sha256,
    content_fingerprint:input.content_fingerprint, verifier_status:'accepted', quality_status:'unwired',
    verifier:'controlled-jobs-test', note:generations.RENDER_GENERATION_UNWIRED_NOTE });
  mockup.saveMockup({id:config.jobId, owner:'test-owner',created_by:'test',status:'done',
    created_at:'2026-09-05T00:00:00.000Z',job_kind:'mockup',job_status:'succeeded',
    files:[['white_a','front_right'],['white_b','back_left'],['glb','glb']].map(([key,k])=>({key,path:plan.outputs[k],name:k}))});
  const unregister = registerLocalRenderGenerationRuntime({
    pythonExecutable:config.python, packagingDir:config.packaging, dataRoot:config.dataRoot, blenderExecutable:config.blender,
    timeoutMs:config.timeoutMs,
    resourcePolicy:{diskBytes:config.actualBlender ? 512*1024*1024 : 64*1024*1024,
      memoryBytes:(config.actualBlender ? 4 : 2)*1024*1024*1024}});
  const source = generations.openRenderGenerationStore({jobRoot:config.input.jobRoot,jobId:config.jobId,qualityVerifier}).virtualLegacyCurrentId();
  jobs.enqueueRenderGenerationMutation({jobId:config.jobId,viewer:{id:'test-owner',name:'test',admin:false},
    clientRequestId:'actual-bridge-test',mode:'legacy_relight',sourceGenerationId:source,expectedCurrentGenerationId:source,
    studioAdjustment:config.input.studioAdjustment});
  const deadline=Date.now()+config.timeoutMs+6000;
  while (Date.now()<deadline && !['succeeded','failed'].includes(mockup.loadMockup(config.jobId)?.render_mutation?.status)) {
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  const final=mockup.readMockupFromDisk(config.jobId);
  assert.equal(final.render_mutation.status,'succeeded', JSON.stringify(final.render_mutation));
  assert.match(final.current_render_generation_id,/^g1-/);
  assert.equal(final.render_generation_request.worker_pid,undefined);
  assert.equal(final.render_generation_request.worker_protocol,'render-generation/1');
  assert.equal(generations.openRenderGenerationStore({jobRoot:config.input.jobRoot,jobId:config.jobId})
    .publicSummary(final.current_render_generation_id,final.current_render_generation_id).quality_status,'runtime_verified');
  unregister();
  console.log('REAL_RF02_NORMAL_LOCAL_REGISTRY_RUNTIME_VERIFIED_CURRENT_NO_TEST_HOOKS');
} else if (config.useAdapter) {
  const { createRenderGenerationPreparer } = await import(config.adapter);
  const prepare = createRenderGenerationPreparer({pythonExecutable:config.python,
    packagingDir:config.packaging, dataRoot:config.dataRoot, blenderExecutable:config.blender,
    resourcePolicy:{diskBytes:64*1024*1024,memoryBytes:2*1024*1024*1024}});
  const lifecycle = [];
  const bytes = await readFile(join(config.input.jobRoot, 'resolved_job.json'));
  const prepared = await prepare({jobId:'testjob', mutationId:'mtest', jobRoot:config.input.jobRoot,
    sourcePath:join(config.input.jobRoot, 'resolved_job.json'), bytes, mode:'legacy_relight',
    studioAdjustment:config.input.studioAdjustment, observer:{context:{jobId:'testjob',mutationId:'mtest'},
      onSpawn:(pid, id)=>lifecycle.push(['spawn',pid,id]), onClose:(pid,id)=>lifecycle.push(['close',pid,id])}});
  const result = await prepared.execute({jobId:'testjob', mutationId:'mtest', jobRoot:config.input.jobRoot,
    mode:'legacy_relight', sourceGenerationId:'g0-legacy-original',
    candidateDir:join(config.input.jobRoot,'.render-generations','.candidate-adapter'),
    plan:prepared.plan, sourceOutputs:[], studioAdjustment:config.input.studioAdjustment});
  assert.equal(result.runtimeQuality, 'verified');
  assert.equal(typeof result.qualityVerifier,'function');
  assert.equal(result.contract_sha256, config.input.expectedSourceSha256.slice(7));
  assert.equal(prepared.plan.sourceAssets.length, 6);
  assert.ok(result.outputs.some(row=>row.key === 'white_a_card'));
  assert.equal(lifecycle.length, 4);
  assert.equal(lifecycle[0][2], lifecycle[1][2]);
  assert.equal(lifecycle[2][2], lifecycle[3][2]);
  assert.notEqual(lifecycle[0][2], lifecycle[2][2]);
  assert.match(lifecycle[0][2], /^testjob:mtest:[a-f0-9]{32}$/);
  prepared.lifecycle.release(true);
  console.log('REAL_RF02_ADAPTER_LIFECYCLE_AND_CANDIDATE_VERIFIED');
} else if (config.controlledRender) {
  const result = await bridge.render(receipt,
    join(config.input.jobRoot, '.render-generations', '.candidate-controlled'), config.blender);
  assert.equal(result.quality.production_ready, false);
  assert.match(result.executionNonce, /^[a-f0-9]{32}$/);
  assert.ok(result.outputs.front_right_card.bytes > 0);
  assert.ok(result.outputs.glb.bytes > 0);
  if (config.sealProof) {
    const {openRenderGenerationStore} = await import(config.generations);
    const {RENDER_GENERATION_OUTPUT_KEYS} = await import(config.module);
    // Historical archival integrity is explicitly separate from new artifact proof.
    const archive = openRenderGenerationStore({jobRoot:config.input.jobRoot,jobId:'00000000c222',
      qualityVerifier:input=>({...input,verifier_status:'accepted',quality_status:'unwired',verifier:'test-g0-archive',note:'synthetic archive only'})});
    const bytes = await readFile(join(config.input.jobRoot,'resolved_job.json'));
    const g0 = archive.sealGeneration({mode:'legacy_import',profile:receipt.profile,
      contractSha256:receipt.sourceSha256.slice(7),contractBytes:bytes,
      observedCurrentGenerationId:null,expectedCurrentGenerationId:archive.virtualLegacyCurrentId()});
    const verifier = bridge.createPartialSealVerifier(result);
    if (config.sealTamper) await copyFile(result.outputs.back_left.path,result.outputs.front_right.path);
    let called = 0;
    const store = openRenderGenerationStore({jobRoot:config.input.jobRoot,jobId:'00000000c222',
      qualityVerifier: input=>{called++; return verifier(input);}});
    const seal = ()=>store.sealGeneration({mode:'legacy_relight',profile:receipt.profile,
      contractSha256:receipt.sourceSha256.slice(7),contractBytes:bytes,
      sources:Object.entries(result.outputs).filter(([key])=>RENDER_GENERATION_OUTPUT_KEYS[key])
        .map(([key,row])=>({key:RENDER_GENERATION_OUTPUT_KEYS[key],path:row.path})),
      observedCurrentGenerationId:g0.generation_id,expectedCurrentGenerationId:g0.generation_id});
    if (config.sealTamper) assert.throws(seal,error=>error.cause === 'quality_rejected');
    else {
      const sealed = seal();
      assert.equal(sealed.report.quality_status,'unwired');
      assert.equal(sealed.report.quality_wired,false);
      assert.ok(sealed.patch.files.some(row=>row.key === 'white_a_card'));
    }
    assert.equal(called,1); // Real store invoked proof AFTER copying and hashing.
  }
  console.log('REAL_RF02_CONTROLLED_RENDER_NONCE_AND_OUTPUTS_VERIFIED');
} else {
  await assert.rejects(bridge.render(receipt,
    join(config.input.jobRoot, '.render-generations', '.candidate-missing-blender'),
    join(config.dataRoot, 'missing-blender')), /missing_blender/);
  console.log('REAL_RF02_VALIDATED_MISSING_BLENDER_REJECTED');
}
"""
    ids = identities_for(root)
    controlled_blender = dummy_blender(tmp_path / "controlled-blender")
    if actual_blender:
        installed = shutil.which("blender")
        assert installed, "explicit synthetic full/card test requires installed Blender"
        controlled_blender = Path(installed).resolve()
    config = {
        "module": (repo / "apps/web/server/src/renderGenerationBridge.ts").as_uri(),
        "adapter": (repo / "apps/web/server/src/renderGenerationAdapter.ts").as_uri(),
        "runtime": (repo / "apps/web/server/src/renderGenerationRuntime.ts").as_uri(),
        "jobs": (repo / "apps/web/server/src/jobs.ts").as_uri(),
        "mockup": (repo / "apps/web/server/src/mockup.ts").as_uri(),
        "generations": (repo / "apps/web/server/src/renderGenerations.ts").as_uri(),
        "useJobs": uses_jobs, "jobId": root.name,
        "actualBlender": actual_blender, "timeoutMs": 180_000 if actual_blender else 30_000,
        "sealProof": entry.startswith("seal-"), "sealTamper": entry == "seal-tamper",
        "useAdapter": entry == "adapter",
        "python": PYTHON,
        "packaging": str(command_dir),
        "controlledRender": controlled_render,
        "blender": str(controlled_blender),
        "dataRoot": str(data_root),
        "input": {
            "jobRoot": str(root), "mode": "legacy_relight" if entry.startswith("seal-") else "preserve",
            "expectedSourceSha256": ids["expected_source_sha256"],
            "expectedAssetSha256": ids["expected_asset_sha256"],
            "studioAdjustment": {"product_light": 1.2, "background_light": 0.8},
        },
    }
    run = subprocess.run(
        [node, "--import", "tsx", "--input-type=module", "-e", script, json.dumps(config)],
        cwd=repo, capture_output=True, text=True, timeout=240 if actual_blender else 60,
    )
    assert run.returncode == 0, run.stderr
    assert "REAL_RF02_" in run.stdout
    after = inventory(root)
    assert {name: value for name, value in after.items() if not name.startswith(".render-generations/")
            and not (uses_jobs and name == "job.json")} == before
    if entry not in {"jobs", "actual-blender", "seal-proof", "seal-tamper"}:
        assert all(not name.endswith("generation.json") for name in after)
    elif entry == "seal-tamper":
        assert not any(name.startswith(".render-generations/g1-") for name in after)
    assert not (root / ".render-generations/.candidate-missing-blender").exists()


@pytest.mark.skipif(os.environ.get("BEIAN_TEST_BLENDER_FULL") != "1", reason="explicit local synthetic full/card/GLB render")
@pytest.mark.parametrize("profile_id", ["compat-legacy-v0", "packshot-carton-geometry-v1"])
def test_normal_local_runtime_with_actual_synthetic_blender_full_card_glb(tmp_path, profile_id):
    # Explicit profiles at unchanged registry resolution; synthetic artwork only.
    # No approved baseline, production registration or fake subprocess.
    test_node_bridge_calls_real_rf02_validator_without_blender(tmp_path, "actual-blender", profile_id)



def generation_module():
    spec = importlib.util.spec_from_file_location(
        "packaging_render_generation_rf03c1",
        PACKAGING / "render_generation.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_bytes(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def inventory(root: Path) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        current = Path(dirpath)
        dirnames[:] = [name for name in dirnames if not (current / name).is_symlink()]
        for name in filenames:
            path = current / name
            rel = str(path.relative_to(root))
            if path.is_symlink():
                mapping[rel] = "symlink:" + os.readlink(path)
            elif path.is_file():
                mapping[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
    return mapping


def complete_tree(root: Path) -> dict[str, str]:
    mapping: dict[str, str] = {}
    if not root.exists():
        return mapping
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        current = Path(dirpath)
        dirnames.sort()
        filenames.sort()
        rel_dir = "." if current == root else str(current.relative_to(root))
        mapping["dir:" + rel_dir] = "dir"
        for name in dirnames:
            path = current / name
            rel = str(path.relative_to(root))
            if path.is_symlink():
                mapping[rel + "/"] = "symlink:" + os.readlink(path)
            else:
                mapping[rel + "/"] = "dir"
        for name in filenames:
            path = current / name
            rel = str(path.relative_to(root))
            if path.is_symlink():
                mapping[rel] = "symlink:" + os.readlink(path)
            elif path.is_file():
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                mapping[rel] = f"{digest}:{path.stat().st_size}"
    return mapping


def minimal_valid_glb() -> bytes:
    document = json.dumps({"asset": {"version": "2.0"}}, separators=(",", ":")).encode(
        "utf-8"
    )
    document += b" " * ((4 - len(document) % 4) % 4)
    json_type = 0x4E4F534A
    bin_type = 0x004E4942
    body = (
        struct.pack("<II", len(document), json_type)
        + document
        + struct.pack("<II", 0, bin_type)
    )
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


def header_only_glb() -> bytes:
    return b"glTF" + b"\x02\x00\x00\x00\x0c\x00\x00\x00"


def truncated_png_with_magic() -> bytes:
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + b"\x00" * 8


def identities_for(job_root: Path) -> dict[str, object]:
    resolved = job_root / "resolved_job.json"
    raw = resolved.read_bytes()
    job = json.loads(raw.decode("utf-8"))
    return {
        "expected_source_sha256": sha256_bytes(raw),
        "expected_asset_sha256": {
            face: sha256_file(Path(job["assets"][face])) for face in FACES
        },
    }


def make_spec_source(tmp_path: Path) -> tuple[object, dict, Path]:
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    job = pipeline.preflight_product(
        product, tmp_path, tmp_path / "output", False, {"enabled": False}, False
    )
    seed_required_outputs(job)
    root = Path(job["project_dir"])
    return pipeline, job, root


def request_payload(job_root: Path, **overrides) -> dict:
    payload = {
        "schema": "packaging-render-generation-request/1",
        "action": "validate",
        "job_root": str(job_root),
        "mode": "preserve",
    }
    if "expected_source_sha256" not in overrides or "expected_asset_sha256" not in overrides:
        payload.update(identities_for(job_root))
    payload.update(overrides)
    return payload


def fake_blender(
    gen,
    monkeypatch: pytest.MonkeyPatch,
    *,
    returncode: int = 0,
    stdout: str = "",
    skip: tuple[str, ...] = (),
    stale_nonce: bool = False,
    bad_optional: bool = False,
    truncated_optional: bool = False,
    corrupt_glb: bytes | None = None,
    conflict_output: Path | None = None,
):
    seen: dict[str, object] = {}

    def fake_run(command, capture_output=True, text=True):
        snapshot_path = Path(command[-1])
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        seen["snapshot"] = snapshot
        seen["command"] = list(command)
        project = Path(snapshot["project_dir"])
        nonce = "stale-nonce" if stale_nonce else snapshot["execution_nonce"]
        result_outputs = dict(snapshot["outputs"])
        for key, raw in snapshot["outputs"].items():
            if key in skip:
                continue
            dest = Path(str(raw))
            dest.parent.mkdir(parents=True, exist_ok=True)
            if key == "glb":
                if corrupt_glb is not None:
                    dest.write_bytes(corrupt_glb)
                else:
                    from test_packaging_glb_verify import glb_verify, _runtime_artifact, _write_artifact
                    module = glb_verify()
                    artifact, _assets = _runtime_artifact(module, project,
                        expected_assets=snapshot["assets"], dimensions=snapshot["dimensions_mm"],
                        substrate=snapshot["render"].get("substrate_rgba", [module.PAPER_ALBEDO_LINEAR]*3 + [1.0]))
                    _write_artifact(module, project, artifact).replace(dest)
            elif key == "blend":
                dest.write_bytes(b"BLENDER-v293")
            elif "ground" in key or key.endswith("_set"):
                if bad_optional:
                    dest.write_bytes(b"not-a-png")
                elif truncated_optional:
                    dest.write_bytes(truncated_png_with_magic())
                else:
                    Image.new("RGBA", (8, 8), (9, 9, 9, 255)).save(dest)
            else:
                width, height = (snapshot["render"][k] for k in ("resolution_x", "resolution_y"))
                image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
                image.paste((11 if key.startswith("front") else 111, 22, 33, 255),
                            (width // 4, height // 4, width * 3 // 4, height * 3 // 4))
                image.save(dest)
        if conflict_output is not None:
            conflict_output.write_bytes(b"stolen")
            result_outputs["front_right"] = str(conflict_output)
        gen.packaging_pipeline.save_json(
            project / "blender_result.json",
            blender_measurement_result(
                snapshot,
                execution_nonce=nonce,
                outputs=result_outputs,
            ),
        )
        return subprocess.CompletedProcess(command, returncode, stdout, "")

    monkeypatch.setattr(gen.packaging_pipeline.subprocess, "run", fake_run)
    def bounded_fake(command, *, deadline):
        assert deadline > 0
        result = gen.packaging_pipeline.subprocess.run(command)
        return subprocess.CompletedProcess(command, result.returncode,
                                            (result.stdout + "\n" + result.stderr).encode(), b"")
    monkeypatch.setattr(gen.packaging_pipeline, "run_bounded_blender", bounded_fake)
    return seen


def dummy_blender(path: Path) -> Path:
    path.write_bytes(b"not-real-blender")
    return path


def _bind_experimental_gloss(job: dict) -> dict:
    from test_packaging_render_contract import carton_job, contract_module

    contract = contract_module()
    structure = carton_job(dimensions=job["dimensions_mm"])
    structure["structure_hash"] = job["structure_hash"]
    plan = contract.render_plan_for_experimental_material_job(
        structure, "packshot-material-white-gloss-v1"
    )
    job["render_spec"] = plan["spec"]
    job["render"] = plan["render"]
    job.update(plan["identity"])
    Path(job["resolved_job_path"]).write_text(json.dumps(job), encoding="utf-8")
    return job


@pytest.mark.parametrize("damage", ["clearcoat", "normal_scale"])
def test_candidate_runtime_gate_rejects_declared_pbr_tampering(tmp_path, monkeypatch, damage):
    from test_packaging_glb_verify import _write_artifact, glb_verify
    from test_packaging_render_contract import contract_module
    from test_packaging_render_materials import _pbr_carton_artifact

    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    job = _bind_experimental_gloss(job)
    before = inventory(root)
    module = glb_verify()
    contract = contract_module()
    pbr_dir = tmp_path / "pbr-src"
    pbr_dir.mkdir()
    geometry = job["render_spec"]["geometry"]
    artifact, _assets = _pbr_carton_artifact(
        module,
        contract,
        pbr_dir,
        assets=job["assets"],
        dimensions=job["dimensions_mm"],
        substrate=job["render"]["substrate_rgba"],
        extras={
            "render_family": geometry["family"],
            "geometry_model": geometry["closure_detail"],
            "render_profile_id": job["render_profile_id"],
            "render_contract_hash": job["render_contract_hash"],
        },
    )
    if damage == "clearcoat":
        for material in artifact.document["materials"]:
            material.pop("extensions", None)
        artifact.document.pop("extensionsUsed", None)
    else:
        for material in artifact.document["materials"]:
            if isinstance(material.get("normalTexture"), dict):
                material["normalTexture"]["scale"] = 0
    glb_path = _write_artifact(module, pbr_dir, artifact)
    fake_blender(gen, monkeypatch, corrupt_glb=glb_path.read_bytes())
    original = gen.compare_glb_artifact_contract
    seen_layers = {}

    def wrapped(*args, **kwargs):
        seen_layers["present"] = kwargs.get("material_layers") is not None
        kwargs = dict(kwargs)
        kwargs["geometry"] = None
        return original(*args, **kwargs)

    monkeypatch.setattr(gen, "compare_glb_artifact_contract", wrapped)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / f"pbr-{damage}"),
                blender_executable=str(dummy_blender(tmp_path / "fake-blender")),
            )
        )
    assert raised.value.cause == "runtime_glb_quality"
    assert seen_layers.get("present") is True
    assert inventory(root) == before


def test_candidate_rejects_parseable_empty_glb_despite_success_nonce(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    before = inventory(root)
    fake_blender(gen, monkeypatch, corrupt_glb=minimal_valid_glb())
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(request_payload(root, action="render-candidate",
            candidate_dir=str(tmp_path / "empty-model"), blender_executable=str(dummy_blender(tmp_path / "fake-blender"))))
    assert raised.value.cause == "runtime_glb_quality"
    assert inventory(root) == before


@pytest.mark.parametrize("target", ["glb", "face"])
def test_candidate_rechecks_quality_bytes_before_return(tmp_path, monkeypatch, target):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    candidate = tmp_path / "changed-after-quality"
    before = inventory(root)
    seen = fake_blender(gen, monkeypatch)
    original = gen.compare_glb_artifact_contract
    def changing_verifier(artifact, expected_assets, *args, **kwargs):
        report = original(artifact, expected_assets, *args, **kwargs)
        assert report["ok"], report
        path = Path(seen["snapshot"]["outputs"]["glb"] if target == "glb" else expected_assets["front"])
        path.write_bytes(path.read_bytes() + b"changed")
        return report
    monkeypatch.setattr(gen, "compare_glb_artifact_contract", changing_verifier)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(request_payload(root, action="render-candidate", candidate_dir=str(candidate),
            blender_executable=str(dummy_blender(tmp_path / "fake-blender"))))
    assert raised.value.cause == "runtime_glb_quality"
    assert inventory(root) == before


def test_validate_legal_spec_distinguishes_source_bytes_from_plan_identity(tmp_path: Path):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    result = gen.run_request(request_payload(root))
    source_sha = identities_for(root)["expected_source_sha256"]
    assert result["ok"] is True
    assert result["action"] == "validate"
    assert result["source_identity"]["resolved_job_sha256"] == source_sha
    assert result["source_identity"]["plan_identity"] != source_sha
    assert result["candidate_identity"] != source_sha
    assert result["candidate_plan_identity"] == result["source_identity"]["plan_identity"]
    assert result["source_identity"]["render_profile_id"] == "compat-legacy-v0"
    assert result["quality"]["status"] == "layered"
    assert result["quality"]["wired"] is True
    assert result["quality"]["runtime_gate"] == "not-run"
    assert result["quality"]["fixture_regression"] == "not-run"
    assert result["quality"]["human_acceptance"] == "pending"
    assert result["quality"]["production_ready"] is False
    assert result["quality"]["machine_metrics"]["runtime_integrity"] == "not-run"
    assert job["render_spec"]["schema"] == "packaging-render-spec/1"


@pytest.mark.parametrize("sufficient_density", [False, True])
def test_legacy_relight_requires_sampling_even_for_known_pre_rf02(tmp_path: Path, sufficient_density: bool):
    gen = generation_module()
    job = write_legacy_blender_job(tmp_path)
    root = tmp_path / "LEGACYBOX"
    if not sufficient_density:
        with pytest.raises(gen.RenderGenerationError) as caught:
            gen.run_request(request_payload(root, mode="legacy_relight"))
        assert caught.value.cause == "source_sampling_quality"
        return
    for face, path in job["assets"].items():
        # Fresh synthetic full-density fixture, never upscale a source image.
        Image.new("RGBA", (950, 950 if face in {"top", "bottom"} else 3550), (1, 2, 3, 255)).save(path)
    result = gen.run_request(request_payload(root, mode="legacy_relight"))
    assert result["ok"] is True
    disk = json.loads((root / "resolved_job.json").read_text(encoding="utf-8"))
    assert "render_spec" not in disk
    assert result["source_identity"]["plan_identity"].startswith("sha256:")


def test_preserve_rejects_missing_spec_even_if_legacy_synthesis_would_work(tmp_path: Path):
    gen = generation_module()
    write_legacy_blender_job(tmp_path)
    root = tmp_path / "LEGACYBOX"
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(request_payload(root, mode="preserve"))
    assert raised.value.code == "render_contract_invalid"


def test_unknown_missing_and_conflicting_fields_fail_before_write(tmp_path: Path):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    before = inventory(root)
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(request_payload(root, profile="packshot-neutral-v1"))
    with pytest.raises(gen.RenderGenerationError):
        payload = request_payload(root)
        payload.pop("expected_source_sha256")
        gen.run_request(payload)
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(request_payload(root, mode="not-a-mode"))
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(request_payload(root, mode="upgrade"))
    assert raised.value.code == "render_generation_unsupported"
    assert inventory(root) == before


def test_self_reported_or_tampered_hash_is_not_rf02_verification(tmp_path: Path):
    gen = generation_module()
    pipeline, job, root = make_spec_source(tmp_path)
    before = inventory(root)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(
            request_payload(root, expected_source_sha256="sha256:" + "a" * 64)
        )
    assert raised.value.cause == "source_sha_mismatch"
    disk = json.loads((root / "resolved_job.json").read_text(encoding="utf-8"))
    disk["render_spec"] = deepcopy(job["render_spec"])
    disk["render_spec"]["render_contract_hash"] = "sha256:" + "c" * 64
    pipeline.save_json(root / "resolved_job.json", disk)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(request_payload(root, **identities_for(root)))
    assert raised.value.code == "render_contract_invalid"
    assert (root / "resolved_job.json").is_file()
    assert inventory(root)[str(Path("resolved_job.json"))] != before[str(Path("resolved_job.json"))]


def test_structure_facts_are_not_guessed(tmp_path: Path):
    gen = generation_module()
    pipeline, job, root = make_spec_source(tmp_path)
    disk = json.loads((root / "resolved_job.json").read_text(encoding="utf-8"))
    disk["structure_hash"] = "sha256:" + "f" * 64
    pipeline.save_json(root / "resolved_job.json", disk)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(request_payload(root, **identities_for(root)))
    assert raised.value.code == "render_contract_invalid"


def test_payload_project_dir_is_not_the_trusted_root(tmp_path: Path):
    gen = generation_module()
    pipeline, job, root = make_spec_source(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    disk = json.loads((root / "resolved_job.json").read_text(encoding="utf-8"))
    disk["project_dir"] = str(outside)
    pipeline.save_json(root / "resolved_job.json", disk)
    result = gen.run_request(request_payload(root, **identities_for(root)))
    assert result["ok"] is True
    escaped = json.loads((root / "resolved_job.json").read_text(encoding="utf-8"))
    stolen = outside / "panel_front.png"
    write_png = Path(job["assets"]["front"])
    stolen.write_bytes(write_png.read_bytes())
    escaped["assets"] = dict(escaped["assets"])
    escaped["assets"]["front"] = str(stolen)
    pipeline.save_json(root / "resolved_job.json", escaped)
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(request_payload(root, **identities_for(root)))


def test_asset_identity_mismatch_and_missing_asset_fail_before_candidate(tmp_path: Path):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    ids = identities_for(root)
    before = inventory(root)
    wrong = dict(ids)
    wrong["expected_asset_sha256"] = dict(ids["expected_asset_sha256"])
    wrong["expected_asset_sha256"]["front"] = "sha256:" + "b" * 64
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(request_payload(root, **wrong))
    assert "asset_sha_front" in raised.value.cause
    Path(job["assets"]["left"]).unlink()
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(request_payload(root, **ids))
    assert not (tmp_path / "candidate").exists()
    assert inventory(root)[str(Path("resolved_job.json"))] == before[str(Path("resolved_job.json"))]


def test_prepare_writes_only_candidate_and_keeps_source_inventory(tmp_path: Path):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    candidate = tmp_path / "candidate"
    before = inventory(root)
    result = gen.run_request(
        request_payload(root, action="prepare", candidate_dir=str(candidate))
    )
    assert result["execution"]["status"] == "prepared"
    assert candidate.is_dir()
    assert (candidate / "resolved_job.json").is_file()
    disk = json.loads((candidate / "resolved_job.json").read_text(encoding="utf-8"))
    assert disk["project_dir"] == str(candidate.resolve())
    assert Path(disk["outputs"]["front_right"]).parent == candidate.resolve()
    assert Path(disk["assets"]["front"]).is_file()
    assert Path(disk["assets"]["front"]).resolve().is_relative_to(candidate.resolve())
    for face in FACES:
        copied = Path(disk["assets"][face])
        source = Path(job["assets"][face])
        assert copied.read_bytes() == source.read_bytes()
        assert not copied.samefile(source)
        assert copied.stat().st_nlink == 1
    assert inventory(root) == before
    source_disk = json.loads((root / "resolved_job.json").read_text(encoding="utf-8"))
    assert source_disk["outputs"]["front_right"] == job["outputs"]["front_right"]


def test_existing_candidate_and_source_overlap_fail_closed(tmp_path: Path):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    existing = tmp_path / "candidate"
    existing.mkdir()
    (existing / "marker").write_text("keep", encoding="utf-8")
    before_source = inventory(root)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(
            request_payload(root, action="prepare", candidate_dir=str(existing))
        )
    assert raised.value.cause == "candidate_exists"
    assert (existing / "marker").read_text(encoding="utf-8") == "keep"
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(
            request_payload(root, action="prepare", candidate_dir=str(root))
        )
    assert inventory(root) == before_source


def test_symlink_and_trusted_alias_escape_rejected(tmp_path: Path):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "job.json"
    sentinel.write_text("ORIGINAL", encoding="utf-8")
    alias = root / "trusted-alias"
    alias.symlink_to(outside)
    before_outside = inventory(outside)
    before_source = inventory(root)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(
            request_payload(
                root,
                action="prepare",
                candidate_dir=str(alias / "stolen-candidate"),
            )
        )
    assert raised.value.cause == "symlink_dir"
    assert inventory(outside) == before_outside
    assert sentinel.read_text(encoding="utf-8") == "ORIGINAL"
    parent_link = tmp_path / "link-parent"
    parent_link.symlink_to(outside)
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(
            request_payload(
                root,
                action="prepare",
                candidate_dir=str(parent_link / "nested"),
            )
        )
    assert inventory(root)[str(Path("resolved_job.json"))] == before_source[str(Path("resolved_job.json"))]


def test_hardlink_and_case_alias_do_not_authorize_source_overwrite(tmp_path: Path):
    gen = generation_module()
    pipeline, job, root = make_spec_source(tmp_path)
    front = Path(job["outputs"]["front_right"])
    alias_dir = tmp_path / "alias-cand"
    alias_dir.mkdir()
    alias = alias_dir / front.name
    os.link(front, alias)
    original = front.read_bytes()
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(
            request_payload(root, action="prepare", candidate_dir=str(root / front.name))
        )
    assert front.read_bytes() == original
    upper = tmp_path / "CASE"
    if not upper.exists():
        payload = request_payload(
            root, action="prepare", candidate_dir=str(tmp_path / "case")
        )
        gen.run_request(payload)
        second = request_payload(
            root, action="prepare", candidate_dir=str(tmp_path / "CASE")
        )
        if (tmp_path / "CASE").exists() and (tmp_path / "CASE").samefile(tmp_path / "case"):
            with pytest.raises(gen.RenderGenerationError):
                gen.run_request(second)


def test_render_candidate_uses_real_run_blender_job_and_leaves_source_frozen(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    candidate = tmp_path / "candidate"
    blender = dummy_blender(tmp_path / "fake-blender")
    seen = fake_blender(gen, monkeypatch)
    before = inventory(root)
    lighting = {"product_light": 1.2, "background_light": 0.8}
    result = gen.run_request(
        request_payload(
            root,
            action="render-candidate",
            candidate_dir=str(candidate),
            blender_executable=str(blender),
            studio_adjustment=lighting,
        )
    )
    snapshot = seen["snapshot"]
    command = seen["command"]
    assert command[-2] == "--"
    assert Path(command[-3]).name == "render_job.py"
    assert snapshot["execution_nonce"]
    assert snapshot["project_dir"] == str(candidate.resolve())
    assert snapshot["render"]["light_energy_scale"] == pytest.approx(4.8)
    assert snapshot["render"]["world_strength"] == pytest.approx(0.496)
    assert snapshot["studio_adjustment"] == lighting
    disk = json.loads((candidate / "resolved_job.json").read_text(encoding="utf-8"))
    assert disk["render"]["light_energy_scale"] == job["render"]["light_energy_scale"]
    assert disk["render"]["world_strength"] == job["render"]["world_strength"]
    assert disk["studio_adjustment"] == lighting
    assert result["execution"]["status"] == "rendered"
    assert result["execution"]["nonce"] == snapshot["execution_nonce"]
    assert result["execution"]["nonce"] not in {None, "", "from-old-file"}
    assert result["candidate_identity"] != result["source_identity"]["resolved_job_sha256"]
    assert result["outputs"]["front_right"]["sha256"].startswith("sha256:")
    assert result["outputs"]["front_right_card"]["bytes"] > 0
    assert result["outputs"]["glb"]["bytes"] > 12
    assert Path(result["outputs"]["glb"]["path"]).read_bytes().startswith(b"glTF")
    assert len(Path(result["outputs"]["glb"]["path"]).read_bytes()) > 20
    assert Path(result["outputs"]["front_right"]["path"]).resolve().is_relative_to(candidate.resolve())
    assert inventory(root) == before
    assert Path(job["outputs"]["front_right"]).read_bytes() != Path(
        result["outputs"]["front_right"]["path"]
    ).read_bytes()
    assert result["quality"]["production_ready"] is False
    assert not (root / ".render-generations").exists()
    assert "current_render_generation_id" not in json.loads(
        (root / "resolved_job.json").read_text(encoding="utf-8")
    )


def test_optional_ground_invalid_is_warning_not_good_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    candidate = tmp_path / "candidate"
    blender = dummy_blender(tmp_path / "fake-blender")
    fake_blender(gen, monkeypatch, bad_optional=True)
    result = gen.run_request(
        request_payload(
            root,
            action="render-candidate",
            candidate_dir=str(candidate),
            blender_executable=str(blender),
        )
    )
    assert result["ok"] is True
    warning_keys = {item["key"] for item in result["optional_warnings"]}
    assert "front_right_ground" in warning_keys
    assert "front_right_ground" not in result["outputs"]
    assert "front_right" in result["outputs"]


def test_missing_blender_nonzero_stale_nonce_and_missing_output_do_not_touch_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    before = inventory(root)
    original_front = Path(job["outputs"]["front_right"]).read_bytes()

    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "c-missing"),
                blender_executable=str(tmp_path / "no-blender"),
            )
        )
    assert "Blender" in str(raised.value)
    assert not (tmp_path / "c-missing").exists()

    blender = dummy_blender(tmp_path / "fake-blender")
    fake_blender(gen, monkeypatch, returncode=1)
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "c-nonzero"),
                blender_executable=str(blender),
            )
        )

    fake_blender(gen, monkeypatch, stale_nonce=True)
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "c-stale"),
                blender_executable=str(blender),
            )
        )

    fake_blender(gen, monkeypatch, skip=("front_right",))
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "c-skip"),
                blender_executable=str(blender),
            )
        )

    stolen = tmp_path / "stolen.png"
    fake_blender(gen, monkeypatch, conflict_output=stolen)
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "c-conflict"),
                blender_executable=str(blender),
            )
        )

    assert inventory(root) == before
    assert Path(job["outputs"]["front_right"]).read_bytes() == original_front


def test_source_change_after_validate_fail_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    gen = generation_module()
    pipeline, job, root = make_spec_source(tmp_path)
    blender = dummy_blender(tmp_path / "fake-blender")
    seen = fake_blender(gen, monkeypatch)
    real_refresh = gen._refresh_source
    calls = {"n": 0}

    def wrapped(request):
        result = real_refresh(request)
        calls["n"] += 1
        if calls["n"] == 1:
            disk = json.loads((root / "resolved_job.json").read_text(encoding="utf-8"))
            disk["display_name"] = "tampered-after-validate"
            pipeline.save_json(root / "resolved_job.json", disk)
        return result

    monkeypatch.setattr(gen, "_refresh_source", wrapped)
    before_front = Path(job["outputs"]["front_right"]).read_bytes()
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "c-race"),
                blender_executable=str(blender),
            )
        )
    assert raised.value.cause in {"source_changed_after_validate", "source_sha_mismatch"}
    assert "snapshot" not in seen
    assert Path(job["outputs"]["front_right"]).read_bytes() == before_front


def test_remap_reuse_does_not_copy_back_like_relight(tmp_path: Path):
    pipeline = pipeline_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    original = Path(job["outputs"]["front_right"]).read_bytes()
    candidate = tmp_path / "remap"
    candidate.mkdir()
    remapped = pipeline.remap_job_outputs_to_candidate(job, candidate)
    Path(remapped["outputs"]["front_right"]).write_bytes(b"candidate-only")
    assert Path(job["outputs"]["front_right"]).read_bytes() == original
    assert remapped["project_dir"] == str(candidate)
    assert remapped["assets"]["front"] == job["assets"]["front"]


def test_cli_validate_and_prepare_use_stdout_json(tmp_path: Path):
    _pipeline, _job, root = make_spec_source(tmp_path)
    req = tmp_path / "request.json"
    req.write_text(
        json.dumps(request_payload(root), ensure_ascii=False),
        encoding="utf-8",
    )
    process = subprocess.run(
        [PYTHON, str(PACKAGING / "render_generation.py"), str(req)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    result = json.loads(process.stdout.strip().splitlines()[-1])
    assert result["ok"] is True
    assert result["action"] == "validate"
    assert "STAGE validate" in process.stderr
    candidate = tmp_path / "cli-candidate"
    req.write_text(
        json.dumps(
            request_payload(root, action="prepare", candidate_dir=str(candidate)),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    prepared = subprocess.run(
        [PYTHON, str(PACKAGING / "render_generation.py"), str(req)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert prepared.returncode == 0, prepared.stderr
    payload = json.loads(prepared.stdout.strip().splitlines()[-1])
    assert payload["execution"]["status"] == "prepared"
    assert "STAGE prepare" in prepared.stderr
    assert (candidate / "resolved_job.json").is_file()


def test_cli_rejects_upgrade_and_missing_blender_without_touching_source(tmp_path: Path):
    _pipeline, job, root = make_spec_source(tmp_path)
    before = inventory(root)
    req = tmp_path / "request.json"
    req.write_text(
        json.dumps(request_payload(root, mode="upgrade"), ensure_ascii=False),
        encoding="utf-8",
    )
    process = subprocess.run(
        [PYTHON, str(PACKAGING / "render_generation.py"), str(req)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 2
    payload = json.loads(process.stdout.strip().splitlines()[-1])
    assert payload["ok"] is False
    assert payload["code"] == "render_generation_unsupported"
    req.write_text(
        json.dumps(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "nope"),
                blender_executable=str(tmp_path / "missing"),
            ),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    missing = subprocess.run(
        [PYTHON, str(PACKAGING / "render_generation.py"), str(req)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert missing.returncode == 2
    failed = json.loads(missing.stdout.strip().splitlines()[-1])
    assert failed["ok"] is False
    assert "Blender" in failed["error"]
    assert not (tmp_path / "nope").exists()
    assert inventory(root) == before
    assert Path(job["outputs"]["front_right"]).is_file()


def test_studio_adjustment_budget_and_unknown_keys(tmp_path: Path):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(
            request_payload(root, studio_adjustment={"product_light": 99, "background_light": 1})
        )
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(
            request_payload(
                root,
                studio_adjustment={"product_light": 1, "background_light": 1, "profile": "x"},
            )
        )


def test_ready_root_and_nested_descendants_rejected_before_create(tmp_path: Path):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    gens = root / ".render-generations"
    ready = gens / "g1-existing-ready"
    ready.mkdir(parents=True)
    (ready / "generation.json").write_text("{}", encoding="utf-8")
    nested = ready / "mid" / "deep"
    nested.mkdir(parents=True)
    (nested / "keep.bin").write_bytes(b"ready-nested")
    before_source = inventory(root)
    before_ready = complete_tree(ready)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(
            request_payload(
                root,
                action="prepare",
                candidate_dir=str(ready / ".candidate-in-ready"),
            )
        )
    assert raised.value.cause == "candidate_points_at_ready"
    assert not (ready / ".candidate-in-ready").exists()
    with pytest.raises(gen.RenderGenerationError) as raised_nested:
        gen.run_request(
            request_payload(
                root,
                action="prepare",
                candidate_dir=str(nested / "deeper-candidate"),
            )
        )
    assert raised_nested.value.cause == "candidate_points_at_ready"
    assert not (nested / "deeper-candidate").exists()
    assert inventory(root) == before_source
    sealed = gens / "sealed-not-g-prefix"
    sealed.mkdir()
    (sealed / "generation.json").write_text("{}", encoding="utf-8")
    (sealed / "keep.bin").write_bytes(b"marked-ready")
    before_sealed = complete_tree(sealed)
    with pytest.raises(gen.RenderGenerationError) as raised_marker:
        gen.run_request(
            request_payload(
                root,
                action="prepare",
                candidate_dir=str(sealed / "child-candidate"),
            )
        )
    assert raised_marker.value.cause == "candidate_points_at_ready"
    assert not (sealed / "child-candidate").exists()
    assert complete_tree(sealed) == before_sealed
    assert complete_tree(ready) == before_ready
    assert inventory(root)[str(Path("resolved_job.json"))] == before_source[
        str(Path("resolved_job.json"))
    ]


def test_ready_case_alias_and_ancestor_symlink_rejected(tmp_path: Path):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    ready = root / ".render-generations" / "g1-existing-ready"
    ready.mkdir(parents=True)
    (ready / "generation.json").write_text("{}", encoding="utf-8")
    (ready / "keep.bin").write_bytes(b"ready-bytes")
    before_ready = complete_tree(ready)
    before_source = inventory(root)
    alias_parent = ready.parent / "G1-EXISTING-READY"
    if alias_parent.exists() and alias_parent.samefile(ready):
        with pytest.raises(gen.RenderGenerationError) as raised:
            gen.run_request(
                request_payload(
                    root,
                    action="prepare",
                    candidate_dir=str(alias_parent / ".case-candidate"),
                )
            )
        assert raised.value.cause == "candidate_points_at_ready"
        assert not (alias_parent / ".case-candidate").exists()
    link = tmp_path / "alias-ready"
    link.symlink_to(ready)
    with pytest.raises(gen.RenderGenerationError) as raised_link:
        gen.run_request(
            request_payload(
                root,
                action="prepare",
                candidate_dir=str(link / ".symlink-candidate"),
            )
        )
    assert raised_link.value.cause in {"candidate_points_at_ready", "symlink_dir"}
    assert not (link / ".symlink-candidate").exists()
    assert complete_tree(ready) == before_ready
    assert inventory(root) == before_source


def test_legal_generation_sibling_and_tmp_candidates_still_prepare(tmp_path: Path):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    ready = root / ".render-generations" / "g1-existing-ready"
    ready.mkdir(parents=True)
    (ready / "generation.json").write_text("{}", encoding="utf-8")
    (ready / "keep.bin").write_bytes(b"ready-bytes")
    before_ready = complete_tree(ready)
    before_source = inventory(root)
    sibling = root / ".render-generations" / ".candidate"
    result = gen.run_request(
        request_payload(root, action="prepare", candidate_dir=str(sibling))
    )
    assert result["execution"]["status"] == "prepared"
    assert (sibling / "resolved_job.json").is_file()
    independent = tmp_path / "independent-tmp-candidate"
    tmp_result = gen.run_request(
        request_payload(root, action="prepare", candidate_dir=str(independent))
    )
    assert tmp_result["execution"]["status"] == "prepared"
    assert (independent / "resolved_job.json").is_file()
    assert complete_tree(ready) == before_ready
    assert inventory(root)[str(Path("resolved_job.json"))] == before_source[
        str(Path("resolved_job.json"))
    ]


def test_foreign_ready_ancestors_rejected_without_scanning_data_dir(tmp_path: Path):
    gen = generation_module()
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    _pipeline, _job, root = make_spec_source(fixture)
    foreign = tmp_path / "another-job"
    ready = foreign / ".render-generations" / "g1-ready"
    ready.mkdir(parents=True)
    (ready / "generation.json").write_text("{}", encoding="utf-8")
    (ready / "keep.bin").write_bytes(b"foreign-ready")
    (foreign / "unrelated.txt").write_bytes(b"leave-foreign-job")
    nested = ready / "mid" / "deep"
    nested.mkdir(parents=True)
    (nested / "keep.bin").write_bytes(b"foreign-nested")
    before_foreign = complete_tree(foreign)
    before_source = inventory(root)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(
            request_payload(
                root,
                action="prepare",
                candidate_dir=str(ready / ".candidate-cross-job"),
            )
        )
    assert raised.value.cause == "candidate_points_at_ready"
    assert not (ready / ".candidate-cross-job").exists()
    with pytest.raises(gen.RenderGenerationError) as raised_nested:
        gen.run_request(
            request_payload(
                root,
                action="prepare",
                candidate_dir=str(nested / "deeper-candidate"),
            )
        )
    assert raised_nested.value.cause == "candidate_points_at_ready"
    assert not (nested / "deeper-candidate").exists()
    assert complete_tree(foreign) == before_foreign
    assert inventory(root) == before_source
    sibling = root / ".render-generations" / ".candidate"
    # Candidate creation is intentionally exclusive and non-recursive: the
    # calling store owns the parent directory, so the success fixture must too.
    sibling.parent.mkdir()
    sibling_result = gen.run_request(
        request_payload(root, action="prepare", candidate_dir=str(sibling))
    )
    assert sibling_result["execution"]["status"] == "prepared"
    assert (sibling / "resolved_job.json").is_file()
    independent = tmp_path / "independent-tmp-candidate"
    tmp_result = gen.run_request(
        request_payload(root, action="prepare", candidate_dir=str(independent))
    )
    assert tmp_result["execution"]["status"] == "prepared"
    assert (independent / "resolved_job.json").is_file()
    assert complete_tree(foreign) == before_foreign
    assert inventory(root)[str(Path("resolved_job.json"))] == before_source[
        str(Path("resolved_job.json"))
    ]


def test_required_glb_and_png_need_structure_not_magic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    blender = dummy_blender(tmp_path / "fake-blender")
    before = inventory(root)
    original_front = Path(job["outputs"]["front_right"]).read_bytes()
    fake_blender(gen, monkeypatch, corrupt_glb=b"not-a-glb")
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "c-not-a-glb"),
                blender_executable=str(blender),
            )
        )
    assert raised.value.cause == "outputs.glb"
    fake_blender(gen, monkeypatch, corrupt_glb=header_only_glb())
    with pytest.raises(gen.RenderGenerationError) as raised_header:
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "c-header-glb"),
                blender_executable=str(blender),
            )
        )
    assert raised_header.value.cause == "outputs.glb"
    original_cards = gen.packaging_pipeline.write_review_cards

    def corrupt_still_after_cards(job):
        original_cards(job)
        Path(job["outputs"]["front_right"]).write_bytes(truncated_png_with_magic())

    monkeypatch.setattr(gen.packaging_pipeline, "write_review_cards", corrupt_still_after_cards)
    fake_blender(gen, monkeypatch)
    with pytest.raises(gen.RenderGenerationError) as raised_png:
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "c-trunc-png"),
                blender_executable=str(blender),
            )
        )
    assert raised_png.value.cause == "outputs.front_right"

    def corrupt_card_after_cards(job):
        original_cards(job)
        Path(job["outputs"]["front_right_card"]).write_bytes(truncated_png_with_magic())

    monkeypatch.setattr(gen.packaging_pipeline, "write_review_cards", corrupt_card_after_cards)
    fake_blender(gen, monkeypatch)
    with pytest.raises(gen.RenderGenerationError) as raised_card:
        gen.run_request(
            request_payload(
                root,
                action="render-candidate",
                candidate_dir=str(tmp_path / "c-trunc-card"),
                blender_executable=str(blender),
            )
        )
    assert raised_card.value.cause == "outputs.front_right_card"
    assert inventory(root) == before
    assert Path(job["outputs"]["front_right"]).read_bytes() == original_front


def test_truncated_optional_png_with_magic_is_not_good_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    blender = dummy_blender(tmp_path / "fake-blender")
    fake_blender(gen, monkeypatch, truncated_optional=True)
    result = gen.run_request(
        request_payload(
            root,
            action="render-candidate",
            candidate_dir=str(tmp_path / "c-trunc-optional"),
            blender_executable=str(blender),
        )
    )
    warning_keys = {item["key"] for item in result["optional_warnings"]}
    assert "front_right_ground" in warning_keys
    assert "front_right_ground" not in result["outputs"]
    assert result["outputs"]["glb"]["bytes"] > 12
    assert result["quality"]["status"] == "layered"
    assert result["quality"]["wired"] is True
    assert result["quality"]["runtime_gate"] == "pass"
    assert result["quality"]["fixture_regression"] == "not-run"
    assert result["quality"]["human_acceptance"] == "pending"
    assert result["quality"]["production_ready"] is False


def test_render_nonce_is_this_round_verified_not_copied_from_old_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    blender = dummy_blender(tmp_path / "fake-blender")
    planted = {
        "execution_nonce": "from-old-file",
        "code": job["code"],
        "outputs": job["outputs"],
    }
    (root / "blender_result.json").write_text(
        json.dumps(planted), encoding="utf-8"
    )
    seen = fake_blender(gen, monkeypatch)
    before = inventory(root)
    result = gen.run_request(
        request_payload(
            root,
            action="render-candidate",
            candidate_dir=str(tmp_path / "c-nonce"),
            blender_executable=str(blender),
        )
    )
    snapshot = seen["snapshot"]
    assert result["execution"]["nonce"] == snapshot["execution_nonce"]
    assert result["execution"]["nonce"] != "from-old-file"
    assert result["execution"]["nonce"] != planted["execution_nonce"]
    disk_candidate = json.loads(
        (tmp_path / "c-nonce" / "resolved_job.json").read_text(encoding="utf-8")
    )
    assert disk_candidate.get("execution_nonce") in {None, ""} or "execution_nonce" not in disk_candidate
    assert result["quality"]["production_ready"] is False
    assert inventory(root) == before
    assert Path(job["outputs"]["front_right"]).is_file()


@pytest.mark.parametrize("depth", [0, 2])
def test_candidate_rejects_other_jobs_ready_ancestors_without_writes(
    tmp_path: Path, depth: int
):
    gen = generation_module()
    _pipeline, _job, source_root = make_spec_source(tmp_path)
    other_root = tmp_path / "other-job"
    ready = other_root / ".render-generations" / "g1-ready"
    ready.mkdir(parents=True)
    (ready / "generation.json").write_text('{"immutable":true}', encoding="utf-8")
    (ready / "keep.bin").write_bytes(b"historical output")
    parent = ready
    for index in range(depth):
        parent = parent / f"level-{index}"
        parent.mkdir()
    candidate = parent / ".candidate-cross-job"
    source_before = inventory(source_root)
    other_before = inventory(other_root)
    # Files alone miss an empty directory created before a failed preparation.
    entries_before = sorted(str(path.relative_to(other_root)) for path in other_root.rglob("*"))

    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(request_payload(source_root, action="prepare", candidate_dir=str(candidate)))

    assert raised.value.cause == "candidate_points_at_ready"
    assert not candidate.exists()
    assert inventory(source_root) == source_before
    assert inventory(other_root) == other_before
    assert sorted(str(path.relative_to(other_root)) for path in other_root.rglob("*")) == entries_before


@pytest.mark.parametrize("inside_job", [False, True])
def test_ready_guard_preserves_normal_candidate_locations(tmp_path: Path, inside_job: bool):
    gen = generation_module()
    _pipeline, _job, source_root = make_spec_source(tmp_path)
    if inside_job:
        parent = source_root / ".render-generations"
        parent.mkdir()
    else:
        parent = tmp_path / "external-candidates"
        parent.mkdir()
    candidate = parent / ".candidate-new"
    source_before = inventory(source_root)
    result = gen.run_request(request_payload(source_root, action="prepare", candidate_dir=str(candidate)))
    assert result["execution"]["status"] == "prepared"
    assert (candidate / "resolved_job.json").is_file()
    # Source assets and existing outputs never change, even for an in-job candidate.
    source_after = inventory(source_root)
    assert {key: source_after[key] for key in source_before} == source_before
    if not inside_job:
        assert source_after == source_before


@pytest.mark.parametrize("field,value,cause", [
    ("schema", "packaging-render-generation-request/2", "schema"),
    ("action", "validate\n", "action"),
    ("action", True, "action"),
    ("job_root", "relative/path", "job_root"),
    ("job_root", "/tmp/\x00bad", "job_root"),
    ("job_root", "/" + "x" * 1024, "job_root"),
    ("expected_source_sha256", "sha256:" + "A" * 64, "expected_source_sha256"),
    ("expected_asset_sha256", [], "expected_asset_sha256"),
    ("expected_asset_sha256", {}, "expected_asset_sha256"),
    ("studio_adjustment", [], "studio_adjustment"),
    ("studio_adjustment", {"product_light": True}, "studio_adjustment.product_light"),
    ("studio_adjustment", {"product_light": float("nan")}, "studio_adjustment.product_light"),
    ("studio_adjustment", {"background_light": float("inf")}, "studio_adjustment.background_light"),
    ("studio_adjustment", {"background_light": 0.099}, "studio_adjustment.background_light"),
])
def test_request_boundaries_reject_before_source_read(monkeypatch, field, value, cause):
    gen = generation_module()
    payload = {
        "schema": gen.REQUEST_SCHEMA, "action": "validate", "mode": "preserve",
        "job_root": "/does-not-exist", "expected_source_sha256": "sha256:" + "a" * 64,
        "expected_asset_sha256": {face: "sha256:" + "b" * 64 for face in FACES},
    }
    payload[field] = value

    def forbidden_read(*args, **kwargs):
        pytest.fail("invalid request reached source reads")

    monkeypatch.setattr(gen, "_refresh_source", forbidden_read)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(payload)
    assert raised.value.cause == cause


def test_studio_limits_and_default_identity_are_deterministic():
    gen = generation_module()
    assert gen._studio_adjustment({"product_light": 0.1, "background_light": 4}) == {
        "product_light": 0.1, "background_light": 4.0,
    }
    first = gen.candidate_identity_sha(source_plan_identity="plan", mode="preserve",
                                     studio_adjustment=gen._studio_adjustment({}))
    equivalent = gen.candidate_identity_sha(source_plan_identity="plan", mode="preserve",
                                           studio_adjustment=gen._studio_adjustment({"background_light": 1, "product_light": 1}))
    changed = gen.candidate_identity_sha(source_plan_identity="plan", mode="preserve",
                                       studio_adjustment=gen._studio_adjustment({"product_light": 1.1}))
    assert first == equivalent
    assert changed != first


def test_asset_change_after_prepare_blocks_blender_and_preserves_failed_candidate(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    candidate = tmp_path / "changed-asset-candidate"
    blender = dummy_blender(tmp_path / "fake-blender")
    seen = fake_blender(gen, monkeypatch)
    original_save = gen.packaging_pipeline.save_json
    source_job_before = (root / "resolved_job.json").read_bytes()
    source_output_before = Path(job["outputs"]["front_right"]).read_bytes()

    def change_asset_after_prepare(path, payload):
        original_save(path, payload)
        if Path(path) == candidate / "resolved_job.json":
            Image.new("RGBA", (8, 8), (255, 0, 0, 255)).save(job["assets"]["front"])

    monkeypatch.setattr(gen.packaging_pipeline, "save_json", change_asset_after_prepare)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(request_payload(root, action="render-candidate", candidate_dir=str(candidate),
                                        blender_executable=str(blender)))
    assert raised.value.cause == "asset_sha_front"
    assert "snapshot" not in seen
    assert (candidate / "resolved_job.json").is_file()
    assert (root / "resolved_job.json").read_bytes() == source_job_before
    assert Path(job["outputs"]["front_right"]).read_bytes() == source_output_before


@pytest.mark.parametrize("nonces", [[], [""], ["one", "two"], [None]])
def test_render_requires_one_verified_nonce_even_with_planted_result(tmp_path, monkeypatch, nonces):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    candidate = tmp_path / "missing-nonce"
    blender = dummy_blender(tmp_path / "fake-blender")
    before = inventory(root)

    def unverified_render(job, _blender, **kwargs):
        kwargs["verified_nonce_holder"].extend(nonces)
        (candidate / "blender_result.json").write_text('{"execution_nonce":"planted"}')
        return job

    monkeypatch.setattr(gen.packaging_pipeline, "run_blender_candidate", unverified_render)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(request_payload(root, action="render-candidate", candidate_dir=str(candidate),
                                        blender_executable=str(blender)))
    assert raised.value.cause == "execution_nonce_missing"
    assert inventory(root) == before
    assert (candidate / "resolved_job.json").is_file()


def test_failed_render_keeps_evidence_and_requires_fresh_candidate(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    candidate = tmp_path / "failed-render"
    blender = dummy_blender(tmp_path / "fake-blender")
    before = inventory(root)
    fake_blender(gen, monkeypatch, returncode=1, stdout="synthetic renderer failure")
    payload = request_payload(root, action="render-candidate", candidate_dir=str(candidate),
                              blender_executable=str(blender))
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(payload)
    assert "synthetic renderer failure" in (candidate / "blender.log").read_text()
    candidate_before = complete_tree(candidate)
    with pytest.raises(gen.RenderGenerationError) as raised:
        gen.run_request(payload)
    assert raised.value.cause == "candidate_exists"
    assert complete_tree(candidate) == candidate_before
    assert inventory(root) == before


def test_optional_missing_outputs_are_warnings_with_verifiable_required_evidence(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, _job, root = make_spec_source(tmp_path)
    blender = dummy_blender(tmp_path / "fake-blender")
    fake_blender(gen, monkeypatch, skip=("front_right_ground", "back_left_ground"))
    result = gen.run_request(request_payload(root, action="render-candidate",
                                            candidate_dir=str(tmp_path / "missing-optional"),
                                            blender_executable=str(blender)))
    assert {"key": "front_right_ground", "cause": "optional_missing"} in result["optional_warnings"]
    assert "front_right_ground" not in result["outputs"]
    for record in result["outputs"].values():
        path = Path(record["path"])
        assert record["sha256"] == sha256_file(path)
        assert record["bytes"] == path.stat().st_size
    assert result["quality"]["production_ready"] is False


def test_source_asset_change_at_blender_launch_cannot_change_candidate_pixels(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    candidate = tmp_path / "launch-race"
    blender = dummy_blender(tmp_path / "fake-blender")
    expected = identities_for(root)["expected_asset_sha256"]
    fake_blender(gen, monkeypatch)
    renderer = gen.packaging_pipeline.subprocess.run
    observed = {}

    def change_source_at_launch(command, **kwargs):
        Image.new("RGBA", (8, 8), (255, 0, 0, 255)).save(job["assets"]["front"])
        snapshot = json.loads(Path(command[-1]).read_text())
        observed["assets"] = snapshot["assets"]
        observed["hashes"] = {face: sha256_file(Path(snapshot["assets"][face])) for face in FACES}
        return renderer(command, **kwargs)

    monkeypatch.setattr(gen.packaging_pipeline.subprocess, "run", change_source_at_launch)
    result = gen.run_request(request_payload(root, action="render-candidate",
                                            candidate_dir=str(candidate), blender_executable=str(blender)))
    assert result["execution"]["status"] == "rendered"
    assert observed["hashes"] == expected
    for face in FACES:
        frozen = Path(observed["assets"][face])
        assert frozen.is_relative_to(candidate)
        assert not frozen.samefile(job["assets"][face])


def test_source_change_before_copy_is_rejected_without_launch(tmp_path, monkeypatch):
    gen = generation_module()
    _pipeline, job, root = make_spec_source(tmp_path)
    candidate = tmp_path / "copy-race"
    blender = dummy_blender(tmp_path / "fake-blender")
    seen = fake_blender(gen, monkeypatch)
    create = gen.mkdir_exclusive

    def change_source_before_copy(path):
        create(path)
        Image.new("RGBA", (8, 8), (255, 0, 0, 255)).save(job["assets"]["front"])

    monkeypatch.setattr(gen, "mkdir_exclusive", change_source_before_copy)
    # Prepare must itself reject changed bytes, without relying on render's
    # later source refresh to discover a corrupt candidate.
    with pytest.raises(gen.RenderGenerationError):
        gen.run_request(request_payload(root, action="prepare", candidate_dir=str(candidate)))
    assert "snapshot" not in seen
    assert not (candidate / "resolved_job.json").exists()


@pytest.mark.parametrize("failure", ["changed_stream", "read_error", "changed_destination"])
def test_asset_copy_failure_retains_only_private_partial_files(tmp_path, monkeypatch, failure):
    gen = generation_module()
    source = tmp_path / "source"
    source.mkdir()
    assets = {}
    for face in FACES:
        path = source / f"{face}.png"
        Image.new("RGBA", (8, 8), (10, 20, 30, 255)).save(path)
        assets[face] = str(path)
    expected = {face: sha256_file(Path(path)) for face, path in assets.items()}
    ready = source / ".render-generations" / "ready"
    ready.mkdir(parents=True)
    (ready / "generation.json").write_text("{}")
    (ready / "keep.bin").write_bytes(b"immutable")
    before = complete_tree(source)
    candidate = tmp_path / "copy-failed"
    candidate.mkdir()
    if failure in {"changed_stream", "read_error"}:
        fdopen = gen.os.fdopen

        class SourceStream:
            def __init__(self, handle):
                self.handle = handle

            def __enter__(self):
                self.handle.__enter__()
                return self

            def __exit__(self, *args):
                return self.handle.__exit__(*args)

            def fileno(self):
                return self.handle.fileno()

            def read(self, size):
                chunk = self.handle.read(size)
                if failure == "read_error":
                    raise OSError("synthetic interrupted copy")
                return b"X" + chunk[1:] if chunk else chunk

        monkeypatch.setattr(gen.os, "fdopen", lambda *args, **kwargs: SourceStream(fdopen(*args, **kwargs)))
    else:
        digest_file = gen._sha256_file

        def corrupt_completed_destination(path):
            if path.is_relative_to(candidate):
                path.write_bytes(b"damaged completed copy")
            return digest_file(path)

        monkeypatch.setattr(gen, "_sha256_file", corrupt_completed_destination)
    error_type = OSError if failure == "read_error" else gen.RenderGenerationError
    with pytest.raises(error_type):
        gen.copy_candidate_assets({"assets": assets}, candidate, expected)
    assert complete_tree(source) == before
    assert (candidate / "assets").is_dir()
    assert not (candidate / "resolved_job.json").exists()
