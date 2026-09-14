import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync, readdirSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {isExecutedDirectly, parseRepoOut} from './node_argv.mjs';

const MiB = 1024 * 1024;
const HISTORICAL_STREAM_BYTES = 100 * MiB;

export function parseArgs(argv = process.argv, env = process.env) {
  return parseRepoOut(argv, env);
}

export function judgeUploadResult(result) {
  const reasons = [];
  if (!result || result.ok !== true) reasons.push('result_not_ok');
  const log = result?.log;
  if (!Array.isArray(log) || !log.length) reasons.push('missing_result');
  else {
    const phases = log.map((row) => row.phase);
    if (!phases.includes('two-reserved-third-429')) reasons.push('error_class_mismatch');
    if (!phases.includes('both-discarded')) reasons.push('cleanup_failed');
    if (!phases.includes('slot-reacquired-and-released')) reasons.push('cleanup_failed');
  }
  return {ok: reasons.length === 0, reasons, budget_effective: false};
}

export async function runUploadProbe({repo, out, streamBytes = HISTORICAL_STREAM_BYTES, request}) {
  mkdirSync(out, {recursive: true});
  process.env.VITEST = '1';
  process.env.WB_DATA_DIR = join(out, 'data');
  process.env.WB_PORT = '0';
  process.env.WB_HOST = '127.0.0.1';
  const base = join(repo, 'apps/web/server/src') + '/';
  let appRequest = request;
  if (!appRequest) {
    const {app} = await import(base + 'index.ts');
    appRequest = app.request.bind(app);
  }
  const {issueSessionForTest} = await import(base + 'auth.ts');
  const sess = issueSessionForTest('R04 synthetic', 'admin', 'ou_r04_synthetic');
  const headers = {authorization: `Bearer ${sess.token}`};
  const log = [];
  const start = performance.now();
  function disk(p) {
    try {
      return readdirSync(p, {withFileTypes: true}).reduce(
        (n, e) => n + (e.isDirectory() ? disk(join(p, e.name)) : statSync(join(p, e.name)).size),
        0,
      );
    } catch {
      return 0;
    }
  }
  function record(phase, extra = {}) {
    log.push({phase, t_ms: performance.now() - start, rss: process.memoryUsage().rss, disk: disk(process.env.WB_DATA_DIR), ...extra});
  }
  async function create(n) {
    return appRequest('/api/uploads/sessions', {
      method: 'POST',
      headers: {...headers, 'content-type': 'application/json'},
      body: JSON.stringify({
        client_upload_id: `r04-stream-${n}`,
        files: [{field: 'ai', name: `synthetic-${n}.ai`, bytes: streamBytes, last_modified: 1}],
      }),
    });
  }
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = await create(i);
    assert.equal(r.status, 200);
    ids.push((await r.json()).upload.id);
  }
  assert.equal((await create(2)).status, 429);
  record('two-reserved-third-429');
  await Promise.all(ids.map(async (id, index) => {
    for (let offset = 0; offset < streamBytes; offset += MiB) {
      const chunk = Buffer.alloc(Math.min(MiB, streamBytes - offset), 65 + index);
      if (offset === 0) chunk.write('%PDF-1.7\n');
      const res = await appRequest(`/api/uploads/sessions/${id}/files/ai`, {
        method: 'PUT',
        headers: {
          ...headers,
          'content-type': 'application/octet-stream',
          'x-upload-offset': String(offset),
          'x-upload-sha256': createHash('sha256').update(chunk).digest('hex'),
        },
        body: chunk,
      });
      assert.equal(res.status, 200, await res.text());
    }
  }));
  record('both-streams-written');
  for (const id of ids) {
    const r = await appRequest(`/api/uploads/${id}`, {method: 'DELETE', headers});
    assert.equal(r.status, 200);
  }
  record('both-discarded');
  const again = await create(2);
  assert.equal(again.status, 200);
  await appRequest(`/api/uploads/${(await again.json()).upload.id}`, {method: 'DELETE', headers});
  record('slot-reacquired-and-released');
  const result = {
    ok: true,
    mode: 'in-process Hono real filesystem; synthetic byte stream, no network/native parsing',
    repo,
    total_per_stream: streamBytes,
    note: '100MiB is the historical dual-upload observation size, not a Hangzhou throughput budget',
    log,
  };
  const judged = judgeUploadResult(result);
  result.ok = judged.ok;
  result.reasons = judged.reasons;
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

if (isExecutedDirectly(import.meta.url)) {
  try {
    const args = parseArgs();
    const result = await runUploadProbe(args);
    console.log(JSON.stringify({ok: result.ok, log: result.log}));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error.message || error);
    process.exit(error.code === 'USAGE' ? 2 : 1);
  }
}
