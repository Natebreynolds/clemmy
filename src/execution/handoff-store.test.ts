/**
 * Run: npx tsx --test src/execution/handoff-store.test.ts
 *
 * The handoff store decides which executor OWNS an accepted turn, so its
 * compare-and-swap has to hold under real contention, not just in a single
 * sequential caller. These tests contend for the same row from many concurrent
 * claimants and from a genuinely separate OS process, because the failure this
 * store exists to remove — two winners from the same observed revision — is
 * invisible to a test that only ever has one writer.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-handoff-store-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const store = await import('./handoff-store.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function identity(acceptedAttemptId: string) {
  return {
    logicalTaskId: `task-${acceptedAttemptId}`,
    acceptedAttemptId,
    sessionId: 'sess-1',
    sourceUserSeq: 7,
  };
}

test('a handoff only comes into existence as requested', () => {
  const admitted = store.advanceHandoff(
    { ...identity('attempt-admit'), state: 'background_admitted' }, { expectedRevision: 0 });
  assert.equal(admitted.ok, false, 'a writer invented a handoff already halfway up the ladder');
  assert.equal(store.loadHandoffRecord('attempt-admit'), undefined);

  assert.equal(
    store.advanceHandoff({ ...identity('attempt-admit'), state: 'requested' }, { expectedRevision: 0 }).ok, true);
  assert.equal(store.loadHandoffRecord('attempt-admit')?.revision, 1);
});

test('the ladder moves forward one rung at a time, and terminal ends it', () => {
  const id = identity('attempt-ladder');
  assert.equal(store.advanceHandoff({ ...id, state: 'requested' }, { expectedRevision: 0 }).ok, true);
  assert.equal(store.advanceHandoff({ ...id, state: 'capsule_checkpointed' }, { expectedRevision: 1 }).ok, true);
  assert.equal(store.advanceHandoff({ ...id, state: 'background_admitted' }, { expectedRevision: 2 }).ok, true);

  const regression = store.advanceHandoff({ ...id, state: 'requested' }, { expectedRevision: 3 });
  assert.equal(regression.ok, false, 'the handoff regressed — foreground and background can both claim ownership');
  assert.match((regression as { reason: string }).reason, /adjacent/);

  // Terminal is the abort edge and is reachable from any rung: a crash has to
  // be endable from wherever it left the row.
  assert.equal(
    store.advanceHandoff({ ...id, state: 'terminal', reason: 'admission failed' }, { expectedRevision: 3 }).ok, true);
  assert.equal(store.loadHandoffRecord('attempt-ladder')?.reason, 'admission failed');
  assert.equal(
    store.advanceHandoff({ ...id, state: 'foreground_released' }, { expectedRevision: 4 }).ok,
    false,
    'a terminal handoff was revived — a worker would start for work nothing is fencing',
  );
});

test('identity is immutable: a foreign session cannot advance another attempt', () => {
  const id = identity('attempt-identity');
  assert.equal(store.advanceHandoff({ ...id, state: 'requested' }, { expectedRevision: 0 }).ok, true);
  const foreign = store.advanceHandoff(
    { ...id, sessionId: 'sess-other', state: 'capsule_checkpointed' }, { expectedRevision: 1 });
  assert.equal(foreign.ok, false, 'a different session advanced a handoff it does not own');
  assert.match((foreign as { reason: string }).reason, /identity mismatch/);
});

test('an advance that omits ids keeps the durable ones rather than erasing an owner', () => {
  const id = identity('attempt-keep');
  store.advanceHandoff({ ...id, state: 'requested' }, { expectedRevision: 0 });
  store.advanceHandoff({ ...id, capsuleId: 'cap-1', state: 'capsule_checkpointed' }, { expectedRevision: 1 });
  store.advanceHandoff({ ...id, backgroundTaskId: 'bg-1', state: 'background_admitted' }, { expectedRevision: 2 });
  store.advanceHandoff({ ...id, state: 'foreground_commit_fenced' }, { expectedRevision: 3 });

  const record = store.loadHandoffRecord('attempt-keep');
  assert.equal(record?.capsuleId, 'cap-1', 'the capsule identity was dropped by a later advance');
  assert.equal(record?.backgroundTaskId, 'bg-1', 'the background owner was dropped by a later advance');
});

// ─── contention ──────────────────────────────────────────────────────────────

test('eight claimants racing from one observed revision: exactly one wins', async () => {
  const id = identity('attempt-race');
  store.advanceHandoff({ ...id, state: 'requested' }, { expectedRevision: 0 });
  const seen = store.loadHandoffRecord('attempt-race')!;

  const writes = await Promise.all(
    Array.from({ length: 8 }, (_, index) => Promise.resolve().then(() => store.advanceHandoff(
      { ...id, capsuleId: `cap-${index}`, state: 'capsule_checkpointed' },
      { expectedRevision: seen.revision },
    ))),
  );
  const winners = writes.filter((write) => write.ok);
  assert.equal(winners.length, 1, `${winners.length} claimants won the same revision — the task has that many owners`);

  const record = store.loadHandoffRecord('attempt-race')!;
  assert.equal(record.revision, seen.revision + 1);
  assert.equal(record.state, 'capsule_checkpointed');
  // Every loser must be able to SEE the winner rather than assume it lost blindly.
  for (const write of writes.filter((candidate) => !candidate.ok)) {
    assert.equal((write as { current?: { revision: number } }).current?.revision, record.revision);
  }
});

test('two OS processes contending for the same rungs: one winner per rung, nothing regresses', async () => {
  const id = identity('attempt-cross-process');
  store.advanceHandoff({ ...id, state: 'requested' }, { expectedRevision: 0 });
  // Close this process's handle so the workers contend for the file, not for a
  // handle this process is holding open in WAL mode.
  store.closeHandoffStoreForTests();

  // Both workers repeatedly read the row and try to take the NEXT rung pinned to
  // what they read. Only one can win each rung; the loser must observe the
  // winner's revision rather than overwrite it.
  const worker = `
    process.env.CLEMENTINE_HOME = ${JSON.stringify(TMP_HOME)};
    const fs = await import('node:fs');
    const store = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/execution/handoff-store.ts'))});
    const id = ${JSON.stringify(identity('attempt-cross-process'))};
    // START BARRIER. tsx startup varies by seconds, so without this the two
    // processes routinely run one after the other and never contend — the test
    // would then pass on a store with no CAS at all.
    const barrier = ${JSON.stringify(path.join(TMP_HOME, 'barrier'))};
    fs.mkdirSync(barrier, { recursive: true });
    fs.writeFileSync(barrier + '/' + process.pid, '');
    const deadline = Date.now() + 15000;
    while (fs.readdirSync(barrier).length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    let wins = 0;
    let refusals = 0;
    let regressions = 0;
    let observations = 0;
    let lastRank = -1;
    for (let i = 0; i < 50; i += 1) {
      const seen = store.loadHandoffRecord(id.acceptedAttemptId);
      observations += 1;
      const rank = store.handoffRank(seen.state);
      if (rank < lastRank) regressions += 1;
      lastRank = rank;
      const next = store.HANDOFF_ORDER[rank + 1];
      if (!next || next === 'terminal') break;
      const write = store.advanceHandoff({ ...id, state: next }, { expectedRevision: seen.revision });
      if (write.ok) wins += 1; else refusals += 1;
      await new Promise((r) => setTimeout(r, 1));
    }
    process.stdout.write('<<<' + JSON.stringify({ wins, refusals, regressions, observations }) + '>>>');
  `;

  // Concurrently, not one after the other: sequential workers would never
  // contend, and a broken CAS would pass.
  const run = () => new Promise<{ wins: number; refusals: number; regressions: number; observations: number }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', worker], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${err}`));
      const fenced = /<<<([\s\S]*?)>>>/.exec(out);
      if (!fenced) return reject(new Error(`no result in worker output: ${out} ${err}`));
      try { resolve(JSON.parse(fenced[1])); } catch (error) { reject(new Error(`worker output ${out} ${err} ${String(error)}`)); }
    });
  });

  const [left, right] = await Promise.all([run(), run()]);

  assert.equal(left.regressions, 0, 'a worker observed the state moving backwards');
  assert.equal(right.regressions, 0, 'a worker observed the state moving backwards');

  const record = store.loadHandoffRecord('attempt-cross-process')!;
  // Revision 1 was the admission in this process; every accepted worker write
  // added exactly one. A CAS that let two writers share a revision would leave
  // the revision BELOW the number of accepted writes.
  assert.equal(
    record.revision,
    1 + left.wins + right.wins,
    'accepted writes and durable revisions disagree — two writers shared a revision',
  );
  // Four forward rungs exist above 'requested' before 'terminal'; exactly those
  // were won, once each, across both processes.
  assert.equal(left.wins + right.wins, 4, 'a rung was taken twice or not at all');
  assert.equal(record.state, 'foreground_released');
  // Both processes genuinely worked the same row. Asserting on REFUSALS would
  // depend on scheduling luck — a worker that starts after the ladder is
  // exhausted refuses nothing — whereas "each observed the row, and exactly
  // four rungs were taken between them" is the exactly-once property itself and
  // holds under every interleaving.
  assert.ok(left.observations > 0 && right.observations > 0,
    'a worker never read the contended row; the test proved nothing about two processes');
});
