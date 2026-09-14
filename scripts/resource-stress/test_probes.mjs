import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {parseRepoOut, isExecutedDirectly} from './probes/node_argv.mjs';
import {parseArgs as parseUpload, judgeUploadResult} from './probes/upload-probe.mjs';
import {judgeQueueResult} from './probes/queue-probe.mjs';
import {judgeBudgetResult} from './probes/budget-probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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
