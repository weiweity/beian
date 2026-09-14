import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isExecutedDirectly, parseRepoOut} from './node_argv.mjs';

export function parseArgs(argv = process.argv, env = process.env) {
  return parseRepoOut(argv, env);
}

export function judgeQueueResult(result) {
  const reasons = [];
  if (!result || result.ok !== true) reasons.push('result_not_ok');
  if (result?.maxActive !== 1) reasons.push('error_class_mismatch');
  if (!Array.isArray(result?.events) || !result.events.length) reasons.push('missing_result');
  return {ok: reasons.length === 0, reasons, budget_effective: false};
}

export async function runQueueProbe({repo, out, hooks}) {
  mkdirSync(out, {recursive: true});
  process.env.VITEST = '1';
  process.env.WB_DATA_DIR = join(out, 'data');
  const base = join(repo, 'apps/web/server/src') + '/';
  const jobs = hooks || await import(base + 'jobs.ts');
  const {repairMockupPrintFaces, queueSnapshot, setJobsTestHooks, resetJobsTestHooks} = jobs;
  const {saveMockup, readMockupFromDisk} = hooks?.mockup || await import(base + 'mockup.ts');
  const {releaseReadiness} = hooks?.admission || await import(base + 'releaseAdmission.ts');
  const events = [];
  const start = performance.now();
  const record = (phase, extra = {}) => events.push({phase, t_ms: performance.now() - start, ...extra});
  const ids = ['aa00aa04aa01', 'aa00aa04aa02'];
  for (const id of ids) {
    const dir = join(process.env.WB_DATA_DIR, 'mockups', id);
    mkdirSync(join(dir, 'assets'), {recursive: true});
    writeFileSync(join(dir, 'artwork.pdf'), '%PDF synthetic');
    writeFileSync(join(dir, 'resolved.json'), JSON.stringify({schema: 'resolved-packaging-job/3', faces: {}}));
    saveMockup({
      id,
      status: 'done',
      job_kind: 'mockup',
      job_status: 'succeeded',
      created_at: new Date().toISOString(),
      files: [],
      structure_engine: 'v2',
      structure_status: 'ready',
      structure_artwork_path: join(dir, 'artwork.pdf'),
      structure_resolution_path: join(dir, 'resolved.json'),
    });
  }
  let active = 0, maxActive = 0, calls = 0;
  setJobsTestHooks({
    runPrintFaceRepair: async (opts) => {
      const n = ++calls;
      active++;
      maxActive = Math.max(maxActive, active);
      record('worker-start', {n});
      await new Promise((r) => setTimeout(r, hooks?.workerDelayMs ?? 200));
      mkdirSync(opts.assets, {recursive: true});
      for (const role of ['front', 'back', 'left', 'right']) {
        writeFileSync(join(opts.assets, `panel_${role}.png`), Buffer.from('89504e470d0a1a0a', 'hex'));
      }
      active--;
      record('worker-end', {n});
      return {code: 0, stdout: '', stderr: '', timedOut: false};
    },
  });
  function readiness() {
    const snap = queueSnapshot();
    return releaseReadiness({
      admission: {state: 'draining', active: 0},
      jobs: [snap.blender],
      uploads: {active: 0, waiting: 0},
      notifications: {active: 0},
    });
  }
  try {
    for (const id of ids) {
      record('enqueue', {id});
      await repairMockupPrintFaces(id, {id: 'r04', name: 'synthetic', admin: false});
    }
    record('drain-during', {readiness: readiness(), snapshot: queueSnapshot()});
    assert.equal(readiness().ready, false);
    const deadline = performance.now() + 5000;
    while (ids.some((id) => readMockupFromDisk(id)?.print_faces_request?.status !== 'succeeded')) {
      assert.ok(performance.now() < deadline);
      await new Promise((r) => setTimeout(r, 5));
    }
    record('drain-after', {readiness: readiness(), snapshot: queueSnapshot()});
    assert.equal(readiness().ready, true);
    assert.equal(maxActive, 1);
    assert.equal(calls, 2);
    const result = {
      ok: true,
      repo,
      mode: 'real durable queue/filesystem + synthetic 200ms worker; not native Blender throughput',
      maxActive,
      events,
    };
    const judged = judgeQueueResult(result);
    result.ok = judged.ok;
    result.reasons = judged.reasons;
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    resetJobsTestHooks();
  }
}

if (isExecutedDirectly(import.meta.url)) {
  try {
    const args = parseArgs();
    const result = await runQueueProbe(args);
    console.log(JSON.stringify({ok: result.ok, events: result.events}));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error.message || error);
    process.exit(error.code === 'USAGE' ? 2 : 1);
  }
}
