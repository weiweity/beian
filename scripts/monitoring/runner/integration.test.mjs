import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createPidFileLock, createLocalMonitor, createFixtureSampler, createManualScheduler, createFakeClock } from './runner-core.mjs';
import { createFakeTransport } from '../delivery/fake-transport.mjs';

function setup(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'beian-runtime-integration-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}
function sample(seconds, observed) {
  return { sampled_at: new Date(Date.UTC(2026,8,9,0,0,seconds)).toISOString(), facts: {
    'beian-server-8787': { kind: 'windows_service', sample_ok: true, observed },
  } };
}
function make(stateDir, extra = {}) {
  return createLocalMonitor({ stateDir, scheduler: createManualScheduler(),
    sampler: createFixtureSampler([sample(0,'stopped')]),
    config: { fail_threshold: 1, recover_threshold: 1 }, ...extra });
}
it('a preconstructed successor reloads core after acquiring the lock', async (t) => {
  const dir = setup(t);
  const first = make(dir);
  const next = make(dir, { sampler: createFixtureSampler([sample(1,'running')]) });
  await first.start({ schedule: false });
  await first.runCycle();
  await first.stop();
  await next.start({ schedule: false });
  const result = await next.runCycle();
  assert.deepEqual(result.events.map(e => e.type), ['recovery']);
  assert.equal(result.sequence, 2);
  await next.stop();
});
it('stop is bounded for an uncooperative sampler and keeps ownership until it settles', async (t) => {
  const dir = setup(t);
  let release, entered;
  const ready = new Promise(r => { entered = r; });
  const runner = make(dir, { sampler: { collectSample() { entered(); return new Promise(r => { release = r; }); } } });
  await runner.start({ schedule: false });
  const cycle = runner.runCycle();
  await ready;
  let timer;
  const stopped = await Promise.race([runner.stop({ timeoutMs: 15 }), new Promise(r => { timer = setTimeout(() => r({status:'hung'}), 100); })]);
  clearTimeout(timer);
  release({ sample: sample(0,'stopped') });
  await cycle;
  await new Promise(r => setImmediate(r));
  assert.equal(stopped.status, 'stopping');
  assert.equal(stopped.lock_held, true);
  assert.equal(runner.snapshot().lock_held, false);
  assert.equal(runner.snapshot().sequence, 0);
});
it('real runner awaits async delivery and restart preserves event dedup', async (t) => {
  const dir = setup(t);
  const transport = createFakeTransport(() => Promise.resolve({ outcome: 'confirmed' }));
  const runner = make(dir, { transport, sampler: createFixtureSampler([sample(0,'stopped'),sample(1,'running')]) });
  await runner.start({ schedule: false });
  await runner.runCycle(); await runner.runCycle(); await runner.stop();
  assert.deepEqual(transport.calls.map(e => e.type), ['fault','recovery']);
  const restarted = make(dir, { transport });
  await restarted.start({ schedule: false });
  assert.equal(transport.calls.length, 2);
  assert.ok(restarted.deliverySnapshot().items.every(i => i.status === 'confirmed'));
  await restarted.stop();
});
it('runner timeout leaves unknown; late success cannot overwrite it', async (t) => {
  const dir = setup(t); const clock = createFakeClock(); let release, entered;
  const ready = new Promise(r => { entered = r; });
  const transport = createFakeTransport(() => { entered(); return new Promise(r => { release = r; }); });
  const runner = make(dir, { clock, transport });
  await runner.start({ schedule: false });
  const cycle = runner.runCycle(); await ready; clock.advance(5000); await cycle;
  assert.equal(runner.deliverySnapshot().items[0].status, 'unknown');
  release({outcome:'confirmed'}); await new Promise(r => setImmediate(r));
  assert.equal(runner.deliverySnapshot().items[0].status, 'unknown');
  await runner.stop();
});

it('stale lock takeover serializes competing claimants', t => {
  const dir = setup(t); const lockPath = join(dir, 'runner.lock');
  writeFileSync(lockPath, JSON.stringify({schema:'beian-monitor-runner-lock-v1',pid:111,instance_id:'old'}));
  const second = createPidFileLock({lockPath,pid:333,isAlive:()=>false});
  let raced;
  const first = createPidFileLock({lockPath,pid:222,isAlive:()=> { raced = second.tryAcquire(); return false; }});
  assert.equal(first.tryAcquire().ok, true);
  assert.equal(raced.ok, false);
  assert.equal(raced.reason, 'acquisition_in_progress');
  first.release();
});

it('a failed sample preserves core and the scheduled next cycle can recover', async t => {
  const dir = setup(t);
  const scheduler = createManualScheduler();
  let calls = 0;
  const runner = make(dir, { scheduler, sampler: {
    async collectSample() {
      if (++calls === 1) throw new Error('sample unavailable');
      return { sample: sample(1, 'stopped') };
    },
  } });
  t.after(() => runner.stop());
  await runner.start();
  await scheduler.runNext();
  assert.equal(runner.snapshot().sequence, 0);
  assert.equal(runner.snapshot().core.last_sampled_at, null);
  assert.deepEqual(runner.snapshot().pending_event_ids, []);
  assert.equal(runner.snapshot().last_error, 'sample unavailable');
  assert.equal(scheduler.pending, 1);
  await scheduler.runNext();
  assert.equal(calls, 2);
  assert.equal(runner.snapshot().sequence, 1);
  assert.equal(runner.deliverySnapshot().items[0].type, 'fault');
  assert.equal(runner.deliverySnapshot().items[0].status, 'queued');
});

it('a timer cycle error remains observable and does not stop the next scheduled handoff', async t => {
  const dir = setup(t);
  const scheduler = createManualScheduler();
  let fail = true;
  const runner = make(dir, { scheduler, hooks: {
    beforeHandoffPersist() {
      if (fail) { fail = false; throw new Error('handoff unavailable'); }
    },
  } });
  t.after(() => runner.stop());
  await runner.start();
  await scheduler.runNext();
  assert.equal(runner.snapshot().sequence, 0);
  assert.equal(runner.snapshot().last_error, 'handoff unavailable');
  assert.equal(scheduler.pending, 1);
  await scheduler.runNext();
  assert.equal(runner.snapshot().sequence, 1);
  assert.equal(runner.deliverySnapshot().items.length, 1);
  assert.deepEqual(runner.snapshot().pending_event_ids, []);
});

it('failed startup recovery releases ownership so a successor can start', async t => {
  const dir = setup(t);
  const failed = make(dir, { queue: {
    enqueueFromReplay() { throw new Error('unexpected enqueue'); },
    async tick() { throw new Error('recovery unavailable'); },
  } });
  await assert.rejects(failed.start({ schedule: false }), /recovery unavailable/);
  assert.equal(failed.snapshot().started, false);
  assert.equal(failed.snapshot().lock_held, false);
  const successor = make(dir);
  t.after(() => successor.stop());
  await successor.start({ schedule: false });
  assert.equal(successor.snapshot().lock_held, true);
  assert.equal((await successor.runCycle()).events[0].type, 'fault');
});

it('release refuses to delete a lock replaced by another owner', t => {
  const dir = setup(t);
  const lockPath = join(dir, 'runner.lock');
  const lock = createPidFileLock({ lockPath, pid: 111, instanceId: 'first' });
  assert.equal(lock.tryAcquire().ok, true);
  const replacement = JSON.stringify({ schema: 'beian-monitor-runner-lock-v1', pid: 222, instance_id: 'successor' });
  writeFileSync(lockPath, replacement);
  assert.throws(() => lock.release(), /ownership changed/);
  assert.equal(readFileSync(lockPath, 'utf8'), replacement);
});
