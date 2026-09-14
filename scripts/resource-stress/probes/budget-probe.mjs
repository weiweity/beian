import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync, lstatSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {isExecutedDirectly, parseRepoOut} from './node_argv.mjs';

const MiB = 1024 * 1024;
export const HISTORICAL_DISK_BYTES = 32 * MiB;
export const PRODUCT_DEFAULT_DISK_BYTES = 4096 * MiB;
export const PRODUCT_DEFAULT_MEMORY_BYTES = 8192 * MiB;

export function parseArgs(argv = process.argv, env = process.env) {
  return parseRepoOut(argv, env);
}

export function judgeBudgetResult(result) {
  const reasons = [];
  if (!result || result.ok !== true) reasons.push('result_not_ok');
  const rows = result?.rows;
  const required = ['success', 'disk-exhaustion', 'cancel', 'ownership-unknown'];
  if (!Array.isArray(rows) || rows.length !== 4) reasons.push('missing_result');
  else {
    const seen = [];
    const byMode = {};
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        reasons.push('malformed_result');
        continue;
      }
      seen.push(row.mode);
      byMode[row.mode] = row;
      if (typeof row.remaining_after_release !== 'number') reasons.push('cleanup_unproven');
      else if (row.remaining_after_release !== 0) reasons.push('cleanup_failed');
    }
    if (seen.length !== 4 || new Set(seen).size !== 4 || !required.every((mode) => seen.includes(mode))) {
      reasons.push('error_class_mismatch');
    }
    if (byMode['disk-exhaustion']?.cause !== 'disk_budget') reasons.push('error_class_mismatch');
    if (byMode.cancel?.cause !== 'cancelled') reasons.push('error_class_mismatch');
  }
  return {ok: reasons.length === 0, reasons, budget_effective: false};
}

export async function runBudgetProbe({repo, out, lifecycleFactory}) {
  mkdirSync(out, {recursive: true});
  const base = join(repo, 'apps/web/server/src') + '/';
  const budget = lifecycleFactory || await import(base + 'renderGenerationBudget.ts');
  const {createRenderLifecycle, renderReservationPath, releaseRenderReservation} = budget;
  const rows = [];
  for (const mode of ['success', 'disk-exhaustion', 'cancel', 'ownership-unknown']) {
    const root = join(out, mode);
    mkdirSync(root, {recursive: true});
    const c = new AbortController();
    const start = performance.now();
    const b = createRenderLifecycle({
      root,
      mutationId: 'r04',
      diskBytes: HISTORICAL_DISK_BYTES,
      memoryBytes: 512 * MiB,
      timeoutMs: 10000,
      signal: c.signal,
    });
    const p = renderReservationPath(root, 'r04');
    const initial = lstatSync(p);
    b.beforeWrite(8 * MiB);
    let cause = null;
    if (mode === 'disk-exhaustion') {
      try {
        b.beforeWrite(25 * MiB);
      } catch (e) {
        cause = e.cause;
      }
      assert.equal(cause, 'disk_budget');
    }
    if (mode === 'cancel') {
      c.abort();
      try {
        b.check();
      } catch (e) {
        cause = e.cause;
      }
      assert.equal(cause, 'cancelled');
    }
    const remaining = lstatSync(p).size;
    if (mode === 'ownership-unknown') {
      b.release(false);
      assert.ok(existsSync(p));
      releaseRenderReservation(root, 'r04');
    } else {
      b.release(true);
    }
    assert.equal(existsSync(p), false);
    assert.equal(existsSync(p + '.json'), false);
    rows.push({
      mode,
      allocated: initial.blocks * 512,
      initial_bytes: initial.size,
      remaining_before_release: remaining,
      cause,
      remaining_after_release: 0,
      seconds: (performance.now() - start) / 1000,
    });
  }
  const result = {
    ok: true,
    repo,
    note: 'diskBytes 32MiB is this probe input, not product default 4096MiB disk / 8192MiB memory',
    product_default_disk_bytes: PRODUCT_DEFAULT_DISK_BYTES,
    product_default_memory_bytes: PRODUCT_DEFAULT_MEMORY_BYTES,
    rows,
  };
  const judged = judgeBudgetResult(result);
  result.ok = judged.ok;
  result.reasons = judged.reasons;
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

if (isExecutedDirectly(import.meta.url)) {
  try {
    const args = parseArgs();
    const result = await runBudgetProbe(args);
    console.log(JSON.stringify(result.rows));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error.message || error);
    process.exit(error.code === 'USAGE' ? 2 : 1);
  }
}
