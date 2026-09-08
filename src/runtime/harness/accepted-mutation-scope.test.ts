/**
 * Every mutation must be bound to the job the owner accepted.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/accepted-mutation-scope.test.ts
 *
 * Live 2026-09-07, source 142281 in sess-desktop-64773a28542156699b66368c: the
 * owner asked Clem to CREATE a workflow. The name already existed, so the create
 * returned a known non-write. Clem then called workflow_update on that
 * pre-existing workflow and changed it — receipt 142367 shows 769 bytes become
 * 755. Every consistency check passed, because graphless consent derives its
 * coverage from the proposed call itself.
 *
 * These drive the REAL scope producer. A fixture that hands the comparison its
 * own expected answer would prove nothing.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-mutation-scope-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'mutation-scope\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { admitMutationIntoAcceptedScope } = await import('./accepted-mutation-scope.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

function job(title: string) {
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title });
  const attempt = eventlog.beginRunAttempt(row.id, { runId: `run-${title}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: 'do the thing' },
  });
  return { sessionId: row.id, sourceUserSeq: source.seq, attempt };
}

let call = 0;
function propose(j: { sessionId: string; sourceUserSeq: number }, op: string, posture: string) {
  call += 1;
  return admitMutationIntoAcceptedScope({
    sessionId: j.sessionId,
    sourceUserSeq: j.sourceUserSeq,
    turn: 1,
    logicalToolCallId: `call-${call}`,
    operationId: op,
    deliverableKind: 'workflow',
    destinationPosture: posture,
  });
}

/*
 * NOTE ON LINEAGE COVERAGE. The `created_by_this_source` branch reads a
 * SUCCEEDED settlement, and a settlement row requires the whole canonical
 * authority/logical-call chain. Forging one here would prove only that the
 * fixture can write a row. That branch is therefore qualified LIVE, by a real
 * same-source create-then-edit journey; the refusal direction — the
 * safety-critical one — is proven below without any forgery.
 */

test('THE 142281 CASE: create-then-patch-a-pre-existing-artifact is refused', () => {
  const j = job('create-then-patch');
  // The owner asked to CREATE. That freezes the scope.
  const created = propose(j, 'workflow_create', 'create_new');
  assert.equal(created.allowed, true);
  assert.equal(created.allowed === true && created.basis, 'first_accepted_mutation');

  // The create hit a duplicate and built nothing — no settlement is recorded.
  // The model then proposes patching the artifact that was already there.
  const patch = propose(j, 'workflow_update', 'named_existing');
  assert.equal(patch.allowed, false, 'an unrequested patch is outside the accepted job');
  assert.equal(patch.allowed === false && patch.reason, 'outside_accepted_scope');
  assert.match(
    patch.allowed === false ? patch.detail : '',
    /different instruction/,
    'and says why, so the model can ask instead of acting',
  );
});

test('an ADMITTED BUT FAILED create grants no lineage', () => {
  // The precise difference from the test above: nothing was built, so there is
  // nothing of this source's own to edit.
  const j = job('failed-create');
  propose(j, 'workflow_create', 'create_new');
  const edit = propose(j, 'workflow_update', 'named_existing');
  assert.equal(edit.allowed, false);
});

test('EXPLICIT EDIT: a job that starts as an edit is allowed, and stays allowed', () => {
  const j = job('explicit-edit');
  const first = propose(j, 'workflow_update', 'named_existing');
  assert.equal(first.allowed, true, 'the owner asked for an edit');
  assert.equal(first.allowed === true && first.basis, 'first_accepted_mutation');

  const second = propose(j, 'workflow_update', 'named_existing');
  assert.equal(second.allowed, true, 'and a second edit in the same job is in scope');
  assert.equal(second.allowed === true && second.basis, 'within_accepted_scope');
});

test('CREATING something new is always in scope', () => {
  // Creating is bounded by its own duplicate and consent checks; it is never an
  // expansion over work someone else owns.
  const j = job('mixed');
  propose(j, 'workflow_update', 'named_existing');
  const created = propose(j, 'workflow_create', 'create_new');
  assert.equal(created.allowed, true);
  assert.equal(created.allowed === true && created.basis, 'create_new');
});

test('AN OWNER AMENDMENT re-opens the job', () => {
  const j = job('amendment');
  propose(j, 'workflow_create', 'create_new');
  const before = propose(j, 'workflow_update', 'named_existing');
  assert.equal(before.allowed, false, 'refused before the owner says anything more');

  eventlog.appendEvent({
    sessionId: j.sessionId, turn: 0, role: 'user', type: 'user_steer_note',
    data: { text: 'Actually just update the existing one.' },
  });

  const after = propose(j, 'workflow_update', 'named_existing');
  assert.equal(after.allowed, true, 'a further instruction changes the job');
  assert.equal(after.allowed === true && after.basis, 'owner_amendment');
});

test('scope is per accepted source, not per session', () => {
  const first = job('source-one');
  propose(first, 'workflow_create', 'create_new');
  assert.equal(propose(first, 'workflow_update', 'named_existing').allowed, false);

  // A NEW accepted source in the same session brings its own job.
  const attempt = eventlog.beginRunAttempt(first.sessionId, { runId: 'second' });
  const second = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 2, role: 'user', data: { text: 'now edit it' },
  });
  const edit = propose({ sessionId: first.sessionId, sourceUserSeq: second.seq },
    'workflow_update', 'named_existing');
  assert.equal(edit.allowed, true, "the new source's own first mutation sets its scope");
});
