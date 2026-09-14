import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {runQueueProbe} from './probes/queue-probe.mjs';
import {runBudgetProbe} from './probes/budget-probe.mjs';

function temporary(t) {
  const out = mkdtempSync(join(tmpdir(), 'r04-ship-probe-'));
  const saved = {...process.env};
  t.after(() => {
    for (const key of ['VITEST', 'WB_DATA_DIR']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(out, {recursive: true, force: true});
  });
  return out;
}

function queueHooks({rejectEnqueue = false} = {}) {
  const records = new Map();
  const state = {pending: 0, reset: 0, chain: Promise.resolve()};
  let worker;
  return {
    state,
    workerDelayMs: 1,
    mockup: {saveMockup: (row) => records.set(row.id, row), readMockupFromDisk: (id) => records.get(id)},
    admission: {releaseReadiness: ({jobs}) => ({ready: jobs[0].pending === 0})},
    queueSnapshot: () => ({blender: {pending: state.pending}}),
    setJobsTestHooks: (hooks) => { worker = hooks.runPrintFaceRepair; },
    resetJobsTestHooks: () => { state.reset++; },
    repairMockupPrintFaces: async (id) => {
      if (rejectEnqueue) throw new Error('synthetic enqueue failure');
      state.pending++;
      state.chain = state.chain.then(async () => {
        await worker({assets: join(process.env.WB_DATA_DIR, 'mockups', id, 'assets')});
        records.get(id).print_faces_request = {status: 'succeeded'};
        state.pending--;
      });
    },
  };
}

test('queue probe executes both synthetic workers and persists drain transitions', async (t) => {
  const out = temporary(t);
  const hooks = queueHooks();
  const result = await runQueueProbe({repo: join(out, 'unused'), out, hooks});
  await hooks.state.chain;
  assert.equal(result.ok, true);
  assert.equal(result.maxActive, 1);
  assert.equal(hooks.state.reset, 1);
  assert.deepEqual(result.events.filter((row) => row.phase === 'worker-start').map((row) => row.n), [1, 2]);
  assert.equal(result.events.find((row) => row.phase === 'drain-during').readiness.ready, false);
  assert.equal(result.events.find((row) => row.phase === 'drain-after').readiness.ready, true);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')), result);
});

test('queue probe resets hooks on rejected enqueue and does not mint successful result', async (t) => {
  const out = temporary(t);
  const hooks = queueHooks({rejectEnqueue: true});
  await assert.rejects(runQueueProbe({repo: join(out, 'unused'), out, hooks}), /synthetic enqueue failure/);
  assert.equal(hooks.state.reset, 1);
  assert.equal(existsSync(join(out, 'result.json')), false);
});

function budgetLifecycle({wrongCause = false} = {}) {
  const released = [];
  const reservation = (root) => join(root, 'reservation');
  const remove = (root) => {
    unlinkSync(reservation(root));
    unlinkSync(reservation(root) + '.json');
  };
  return {
    released,
    renderReservationPath: reservation,
    releaseRenderReservation: (root) => { released.push('recovery'); remove(root); },
    createRenderLifecycle: ({root, signal, diskBytes, memoryBytes, timeoutMs}) => {
      assert.equal(diskBytes, 32 * 1024 * 1024);
      assert.equal(memoryBytes, 512 * 1024 * 1024);
      assert.equal(timeoutMs, 10000);
      writeFileSync(reservation(root), 'tiny synthetic reservation');
      writeFileSync(reservation(root) + '.json', '{}');
      let requested = 0;
      return {
        beforeWrite: (bytes) => {
          requested += bytes;
          if (requested > diskBytes) throw {cause: wrongCause ? 'wrong' : 'disk_budget'};
        },
        check: () => { if (signal.aborted) throw {cause: 'cancelled'}; },
        release: (owned) => { released.push(owned); if (owned) remove(root); },
      };
    },
  };
}

test('budget probe observes all four release modes with tiny synthetic reservation files', async (t) => {
  const out = temporary(t);
  const lifecycleFactory = budgetLifecycle();
  const result = await runBudgetProbe({repo: join(out, 'unused'), out, lifecycleFactory});
  assert.equal(result.ok, true);
  assert.deepEqual(lifecycleFactory.released, [true, true, true, false, 'recovery']);
  assert.deepEqual(result.rows.map(({cause}) => cause), [null, 'disk_budget', 'cancelled', null]);
  assert.ok(result.rows.every((row) => row.remaining_after_release === 0));
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')), result);
});

test('budget probe rejects unexpected budget cause instead of recording success', async (t) => {
  const out = temporary(t);
  await assert.rejects(runBudgetProbe({repo: join(out, 'unused'), out,
    lifecycleFactory: budgetLifecycle({wrongCause: true})}), {code: 'ERR_ASSERTION'});
  assert.equal(existsSync(join(out, 'result.json')), false);
});
