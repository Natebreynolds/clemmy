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
  const admitted = store.advanceHandoff({ ...identity('attempt-admit'), state: 'background_admitted' });
  assert.equal(admitted.ok, false, 'a writer invented a handoff already halfway up the ladder');
  assert.equal(store.loadHandoffRecord('attempt-admit'), undefined);

  assert.equal(store.advanceHandoff({ ...identity('attempt-admit'), state: 'requested' }).ok, true);
  assert.equal(store.loadHandoffRecord('attempt-admit')?.revision, 1);
});

test('the ladder moves forward only, and terminal is its last rung', () => {
  const id = identity('attempt-ladder');
  assert.equal(store.advanceHandoff({ ...id, state: 'requested' }).ok, true);
  assert.equal(store.advanceHandoff({ ...id, state: 'capsule_checkpointed' }).ok, true);
  assert.equal(store.advanceHandoff({ ...id, state: 'foreground_commit_fenced' }).ok, true);

  const regression = store.advanceHandoff({ ...id, state: 'requested' });
  assert.equal(regression.ok, false, 'the handoff regressed — foreground and background can both claim ownership');
  assert.match((regression as { reason: string }).reason, /regress/);

  assert.equal(store.advanceHandoff({ ...id, state: 'terminal', reason: 'admission failed' }).ok, true);
  assert.equal(store.loadHandoffRecord('attempt-ladder')?.reason, 'admission failed');
  assert.equal(
    store.advanceHandoff({ ...id, state: 'background_owner_active' }).ok,
    false,
    'a terminal handoff was revived — a worker would start for work nothing is fencing',
  );
});

test('identity is immutable: a foreign session cannot advance another attempt', () => {
  const id = identity('attempt-identity');
  assert.equal(store.advanceHandoff({ ...id, state: 'requested' }).ok, true);
  const foreign = store.advanceHandoff({ ...id, sessionId: 'sess-other', state: 'capsule_checkpointed' });
  assert.equal(foreign.ok, false, 'a different session advanced a handoff it does not own');
  assert.match((foreign as { reason: string }).reason, /identity mismatch/);
});

test('an advance that omits ids keeps the durable ones rather than erasing an owner', () => {
  const id = identity('attempt-keep');
  store.advanceHandoff({ ...id, state: 'requested' });
  store.advanceHandoff({ ...id, capsuleId: 'cap-1', state: 'capsule_checkpointed' });
  store.advanceHandoff({ ...id, backgroundTaskId: 'bg-1', state: 'background_admitted' });
  store.advanceHandoff({ ...id, state: 'background_owner_active' });

  const record = store.loadHandoffRecord('attempt-keep');
  assert.equal(record?.capsuleId, 'cap-1', 'the capsule identity was dropped by a later advance');
  assert.equal(record?.backgroundTaskId, 'bg-1', 'the background owner was dropped by a later advance');
});

// ─── contention ──────────────────────────────────────────────────────────────

test('eight claimants racing from one observed revision: exactly one wins', async () => {
  const id = identity('attempt-race');
  store.advanceHandoff({ ...id, state: 'requested' });
  const seen = store.loadHandoffRecord('attempt-race')!;

  const writes = await Promise.all(
    Array.from({ length: 8 }, (_, index) => Promise.resolve().then(() => store.advanceHandoff(
      { ...id, backgroundTaskId: `bg-${index}`, state: 'background_admitted' },
      { expectedRevision: seen.revision },
    ))),
  );
  const winners = writes.filter((write) => write.ok);
  assert.equal(winners.length, 1, `${winners.length} claimants won the same revision — the task has that many owners`);

  const record = store.loadHandoffRecord('attempt-race')!;
  assert.equal(record.revision, seen.revision + 1);
  assert.equal(record.state, 'background_admitted');
  // Every loser must be able to SEE the winner rather than assume it lost blindly.
  for (const write of writes.filter((candidate) => !candidate.ok)) {
    assert.equal((write as { current?: { revision: number } }).current?.revision, record.revision);
  }
});

test('two OS processes interleaving 50 advances each: the revision count equals the wins, and nothing regresses', async () => {
  const id = identity('attempt-cross-process');
  store.advanceHandoff({ ...id, state: 'requested' });
  // Close this process's handle so the workers contend for the file, not for a
  // handle this process is holding open in WAL mode.
  store.closeHandoffStoreForTests();

  // Both workers climb the same ladder from whatever they last observed. The
  // states repeat deliberately: a same-rung advance is still a revision bump, so
  // every accepted write is countable and no write is a no-op.
  const worker = `
    process.env.CLEMENTINE_HOME = ${JSON.stringify(TMP_HOME)};
    const store = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/execution/handoff-store.ts'))});
    const id = ${JSON.stringify(identity('attempt-cross-process'))};
    const states = ['capsule_checkpointed', 'foreground_commit_fenced', 'background_admitted', 'background_owner_active'];
    let wins = 0;
    let regressions = 0;
    let lastRank = -1;
    for (let i = 0; i < 50; i += 1) {
      const seen = store.loadHandoffRecord(id.acceptedAttemptId);
      const rank = store.handoffRank(seen.state);
      if (rank < lastRank) regressions += 1;
      lastRank = rank;
      const next = states[Math.min(Math.max(rank - 1, 0), states.length - 1)];
      const write = store.advanceHandoff({ ...id, state: next }, { expectedRevision: seen.revision });
      if (write.ok) wins += 1;
    }
    process.stdout.write(JSON.stringify({ wins, regressions }));
  `;

  // Concurrently, not one after the other: sequential workers would never
  // contend, and a broken CAS would pass.
  const run = () => new Promise<{ wins: number; regressions: number }>((resolve, reject) => {
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
      try { resolve(JSON.parse(out.trim())); } catch (error) { reject(new Error(`worker output ${out} ${err} ${String(error)}`)); }
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
  assert.ok(left.wins > 0 && right.wins > 0, 'one worker never wrote at all; the test proved nothing about contention');
});
