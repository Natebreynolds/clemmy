/**
 * Run: npx tsx --test src/execution/continuation-integrity.test.ts
 *
 * F4 integrity: a continuation capsule is resume AUTHORITY — it says what the
 * objective was, which items are already done, and what may safely run next —
 * and the handoff record decides which of foreground and background owns the
 * task. Both are durable files, so both must be able to say "this is not what
 * I wrote" and "you are working from a stale view."
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-continuation-integrity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const capsule = await import('./continuation-capsule.js');

const CAPSULE_DIR = path.join(TMP_HOME, 'state', 'continuation-capsules', 'machine-A');

function baseCapsule(logicalTaskId: string) {
  return {
    logicalTaskId,
    sessionId: 'sess-1',
    acceptedSource: 'sess-1:12',
    activationId: 'act-1',
    objective: 'summarize last month of closed opportunities',
    successCriteria: ['every closed opportunity counted once'],
    constraints: ['read only'],
    decisions: [],
    scopeRefs: {},
    capabilityRefs: {},
    effectRefs: [],
    deliverableRefs: [],
    nextSafeActions: ['resume item enumeration'],
  };
}

function handoff(state: string, over: Record<string, unknown> = {}) {
  return {
    logicalTaskId: 'task-1',
    acceptedAttemptId: 'attempt-1',
    sessionId: 'sess-1',
    sourceUserSeq: 12,
    state,
    ...over,
  } as never;
}

// ─── the capsule is only authority if it is intact ───────────────────────────

test('a capsule that no longer matches its own digest is not resume authority', () => {
  capsule.checkpointCapsule(baseCapsule('task-tamper'));
  assert.ok(capsule.loadCapsule('task-tamper'), 'a freshly written capsule did not load');

  const file = path.join(CAPSULE_DIR, 'task-tamper.json');
  const stored = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...stored, objective: 'delete last month of opportunities' }), 'utf-8');

  assert.equal(capsule.loadCapsule('task-tamper'), undefined,
    'an edited capsule loaded — a rewritten objective would steer the resume');
});

test('a capsule truncated mid-write is a miss, not a partial resume', () => {
  capsule.checkpointCapsule(baseCapsule('task-torn'));
  const file = path.join(CAPSULE_DIR, 'task-torn.json');
  writeFileSync(file, readFileSync(file, 'utf-8').slice(0, 120), 'utf-8');
  assert.equal(capsule.loadCapsule('task-torn'), undefined, 'a torn capsule loaded');
});

test('completed work survives a rewrite of the same capsule and is never redone', () => {
  const withProgress = {
    ...baseCapsule('task-progress'),
    manifest: {
      manifestId: 'm-1', contractVersion: 'v1',
      items: [
        { itemId: 'opp-1', status: 'completed' as const },
        { itemId: 'opp-2', status: 'pending' as const },
      ],
    },
  };
  capsule.checkpointCapsule(withProgress);
  assert.deepEqual(capsule.completedItemIds(capsule.loadCapsule('task-progress')), ['opp-1']);
  // A later checkpoint that carries the same completed item keeps it complete.
  capsule.checkpointCapsule({
    ...withProgress,
    manifest: {
      ...withProgress.manifest,
      items: [
        { itemId: 'opp-1', status: 'completed' as const },
        { itemId: 'opp-2', status: 'completed' as const },
      ],
    },
  });
  assert.deepEqual(capsule.completedItemIds(capsule.loadCapsule('task-progress')), ['opp-1', 'opp-2']);
});

// ─── exactly one owner ───────────────────────────────────────────────────────

test('handoff state moves forward only — a late writer cannot hand the task back', () => {
  assert.equal(capsule.advanceHandoffState(handoff('requested')).ok, true);
  assert.equal(capsule.advanceHandoffState(handoff('capsule_checkpointed')).ok, true);
  assert.equal(capsule.advanceHandoffState(handoff('background_owner_active')).ok, true);

  const regression = capsule.advanceHandoffState(handoff('requested'));
  assert.equal(regression.ok, false, 'the handoff regressed — foreground and background can both claim ownership');
  assert.match((regression as { reason: string }).reason, /regress/);
  assert.equal(capsule.loadHandoffState('attempt-1')?.state, 'background_owner_active');
});

test('two activations racing to claim one attempt: exactly one wins', () => {
  const attempt = { acceptedAttemptId: 'attempt-race' };
  assert.equal(capsule.advanceHandoffState(handoff('requested', attempt)).ok, true);
  const seen = capsule.loadHandoffState('attempt-race')!;

  const first = capsule.advanceHandoffState(handoff('background_admitted', attempt), {
    expectedRevision: seen.revision,
  });
  const second = capsule.advanceHandoffState(handoff('background_owner_active', attempt), {
    expectedRevision: seen.revision,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false, 'both activations claimed the same attempt from the same revision');
  assert.match((second as { reason: string }).reason, /revision/);
});

test('revisions are monotonic, so a stale reader can always tell it is stale', () => {
  const attempt = { acceptedAttemptId: 'attempt-rev' };
  const revisions = (['requested', 'capsule_checkpointed', 'background_admitted'] as const)
    .map((state) => capsule.advanceHandoffState(handoff(state, attempt)))
    .map((write) => (write.ok ? write.record.revision : -1));
  assert.deepEqual(revisions, [1, 2, 3]);
});

test('crash repair converges every durable state to one owner', () => {
  const seen = new Set<string>();
  for (const state of [
    'requested', 'foreground_commit_fenced', 'capsule_checkpointed',
    'background_admitted', 'background_owner_active', 'foreground_released',
  ] as const) {
    const repair = capsule.repairHandoff({
      version: 1, logicalTaskId: 't', acceptedAttemptId: 'a', sessionId: 's',
      sourceUserSeq: 1, state, revision: 1, updatedAt: 'now',
    });
    assert.ok(repair.action, `${state} has no repair action`);
    assert.ok(repair.reason.length > 0, `${state} repairs without saying why`);
    seen.add(repair.action);
  }
  assert.equal(capsule.repairHandoff(undefined).action, 'start_fresh');
  assert.ok(seen.size >= 3, 'every durable state repaired identically — the record is not being read');
});
