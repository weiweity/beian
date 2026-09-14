import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {parseRepoOut, isExecutedDirectly} from './probes/node_argv.mjs';
import {parseArgs as parseUpload, judgeUploadResult, runUploadProbe} from './probes/upload-probe.mjs';
import {judgeQueueResult} from './probes/queue-probe.mjs';
import {judgeBudgetResult} from './probes/budget-probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'behavior_fixtures.json'), 'utf8'));

test('missing repo/out fails closed without product import', () => {
  assert.throws(() => parseRepoOut(['node', 'probe.mjs']), {code: 'USAGE'});
  assert.throws(() => parseUpload(['node', 'upload-probe.mjs']), {code: 'USAGE'});
});

test('stale worktree path is refused', () => {
  assert.throws(
    () => parseRepoOut(['node', 'probe.mjs', '/Users/hutou/worktrees/beian-r04-resource-stress', '/tmp/out']),
    {code: 'STALE'},
  );
});

test('direct-execution guard does not treat imported modules as main', () => {
  assert.equal(isExecutedDirectly(import.meta.url, join(here, 'probes/upload-probe.mjs')), false);
});

test('upload/queue/budget judges require real result fields', () => {
  assert.deepEqual(judgeUploadResult({ok: true, log: [
    {phase: 'two-reserved-third-429'},
    {phase: 'both-discarded'},
    {phase: 'slot-reacquired-and-released'},
  ]}).reasons, []);
  assert.ok(judgeUploadResult({ok: true, log: []}).reasons.includes('missing_result'));
  assert.ok(judgeQueueResult({ok: true, maxActive: 2, events: [{}]}).reasons.includes('error_class_mismatch'));
  assert.ok(judgeBudgetResult({ok: true, rows: []}).reasons.includes('missing_result'));
});

test('probe -- missing argv does not start a 100MiB upload', () => {
  const result = spawnSync(process.execPath, [join(here, 'probes/upload-probe.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test('shared behavior fixtures constrain node judges', () => {
  const judges = {
    upload: judgeUploadResult,
    queue: judgeQueueResult,
    budget: judgeBudgetResult,
  };
  for (const caseRow of fixtures.cases) {
    for (const name of caseRow.judges) {
      if (!judges[name]) continue;
      const judged = judges[name](caseRow.result);
      if (caseRow.expect_pass) {
        assert.equal(judged.ok, true, caseRow.id + ' ' + JSON.stringify(judged.reasons));
      } else {
        assert.equal(judged.ok, false, caseRow.id);
        assert.ok(
          caseRow.expect_reasons_any.some((reason) => judged.reasons.includes(reason)),
          caseRow.id + ' ' + JSON.stringify(judged.reasons),
        );
      }
    }
  }
});

function memoryUploadRequest({failFinalDelete = false} = {}) {
  let creates = 0;
  let deletes = 0;
  let outstanding = 0;
  const request = async (_url, options) => {
    if (options.method === 'POST') {
      creates += 1;
      if (creates === 3) return new Response('{}', {status: 429});
      outstanding += 1;
      return new Response(JSON.stringify({upload: {id: 'synthetic-' + creates}}), {status: 200});
    }
    if (options.method === 'PUT') return new Response('{}', {status: 200});
    if (options.method === 'DELETE') {
      deletes += 1;
      if (failFinalDelete && deletes === 3) {
        return new Response('{"error":"synthetic-delete-failed"}', {status: 500});
      }
      outstanding -= 1;
      return new Response('{}', {status: 200});
    }
    throw new Error('unexpected request');
  };
  return {request, stats: () => ({creates, deletes, outstanding})};
}

test('upload probe records success only after final delete succeeds', async () => {
  const out = await mkdtemp(join(tmpdir(), 'r04-upload-ok-'));
  const {request, stats} = memoryUploadRequest({failFinalDelete: false});
  const result = await runUploadProbe({
    repo: join(here, 'unused-repo'),
    out,
    streamBytes: 16,
    request,
    issueSession: () => ({token: 'stub'}),
  });
  assert.equal(result.ok, true);
  assert.equal(stats().outstanding, 0);
  assert.ok(result.log.some((row) => row.phase === 'slot-reacquired-and-released'));
});

test('upload probe does not claim release when final delete fails', async () => {
  const out = await mkdtemp(join(tmpdir(), 'r04-upload-fail-'));
  const {request, stats} = memoryUploadRequest({failFinalDelete: true});
  const result = await runUploadProbe({
    repo: join(here, 'unused-repo'),
    out,
    streamBytes: 16,
    request,
    issueSession: () => ({token: 'stub'}),
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(stats().outstanding, 1);
  assert.ok(result.log.some((row) => row.phase === 'slot-reacquired-release-failed'));
  assert.ok(!result.log.some((row) => row.phase === 'slot-reacquired-and-released'));
  assert.ok(result.reasons.includes('cleanup_failed'));
});
