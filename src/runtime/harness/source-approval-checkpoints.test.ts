import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-source-approval-'));
process.env.CLEMENTINE_HOME = home;
const events = await import('./eventlog.js');
const store = await import('./source-approval-checkpoints.js');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const session = events.createSession({ kind: 'chat' });
  const source = () => events.appendEvent({ sessionId: session.id, role: 'user', turn: 1,
    type: 'user_input_received', data: { text: 'Controlled approval fixture' } });
  const identity = { sessionId: session.id, sourceUserSeq: source().seq };
  const other = { sessionId: session.id, sourceUserSeq: source().seq };
  const checkpoint = (owner = identity, suffix = '') => ({
    serialized: JSON.stringify({ __clemHostInterrupt: 6,
      acceptedModelBatchRef: { ...owner, batchId: `fixture${suffix}`, batchOrdinal: 1 }, pending: [] }),
    mcpToolScope: { reason: `exact scope${suffix}`, allowedServerSlugs: [suffix || 'first'] },
  });
  return { identity, other, checkpoint };
}

test('two source pauses and exact connector scopes survive reopen without overwriting metadata', () => {
  const { identity, other, checkpoint } = fixture();
  events.updateSession(identity.sessionId, { metadata: { marker: 'keep', __interrupt_state: 'legacy pause' } });
  const first = store.replaceSourceApprovalCheckpoint({ ...identity, expectedRevision: null, checkpoint: checkpoint() });
  const second = store.replaceSourceApprovalCheckpoint({ ...other, expectedRevision: null, checkpoint: checkpoint(other, 'second') });
  assert.equal(first.updated, true);
  assert.equal(second.updated, true);
  events.closeEventLog();
  assert.deepEqual(store.readSourceApprovalCheckpoint(identity).checkpoint, checkpoint());
  assert.deepEqual(store.readSourceApprovalCheckpoint(other).checkpoint, checkpoint(other, 'second'));
  assert.equal(store.listSourceApprovalCheckpoints(identity.sessionId).length, 2);
  assert.equal(events.getSession(identity.sessionId)!.metadata.marker, 'keep');
  assert.equal(events.getSession(identity.sessionId)!.metadata.__interrupt_state, 'legacy pause');
  const detached = store.readSourceApprovalCheckpoint(identity);
  detached.checkpoint!.mcpToolScope!.allowedServerSlugs!.push('unauthorized');
  assert.deepEqual(store.readSourceApprovalCheckpoint(identity).checkpoint, checkpoint());
  if (!first.updated) throw new Error('fixture save failed');
  assert.equal(store.replaceSourceApprovalCheckpoint({ ...identity,
    expectedRevision: first.snapshot.revision, checkpoint: null }).updated, true);
  assert.deepEqual(store.readSourceApprovalCheckpoint(other).checkpoint, checkpoint(other, 'second'),
    'clearing one task leaves the other task and connector scope intact');
});

test('stale save and clear cannot replace a newer revision or resurrect a cleared pause', () => {
  const { identity, checkpoint } = fixture();
  const first = store.replaceSourceApprovalCheckpoint({ ...identity, expectedRevision: null, checkpoint: checkpoint() });
  assert.equal(first.updated, true);
  if (!first.updated) throw new Error('fixture save failed');
  const newer = store.replaceSourceApprovalCheckpoint({ ...identity, expectedRevision: first.snapshot.revision, checkpoint: checkpoint(identity, 'new') });
  assert.equal(newer.updated, true);
  assert.deepEqual(store.replaceSourceApprovalCheckpoint({ ...identity, expectedRevision: first.snapshot.revision, checkpoint: null }), { updated: false });
  if (!newer.updated) throw new Error('fixture replacement failed');
  const cleared = store.replaceSourceApprovalCheckpoint({ ...identity, expectedRevision: newer.snapshot.revision, checkpoint: null });
  assert.equal(cleared.updated, true);
  events.closeEventLog();
  assert.deepEqual(store.replaceSourceApprovalCheckpoint({ ...identity, expectedRevision: null, checkpoint: checkpoint() }), { updated: false });
  assert.deepEqual(store.replaceSourceApprovalCheckpoint({ ...identity, expectedRevision: newer.snapshot.revision, checkpoint: checkpoint() }), { updated: false });
  assert.deepEqual(store.listSourceApprovalCheckpoints(identity.sessionId), []);
});

test('checkpoint source and every consent subject must agree with an actual user event', () => {
  const { identity, other, checkpoint } = fixture();
  assert.throws(() => store.replaceSourceApprovalCheckpoint({ ...identity, expectedRevision: null, checkpoint: checkpoint(other) }), /do not belong/);
  const mixed = checkpoint();
  const parsed = JSON.parse(mixed.serialized);
  parsed.pending = [{ consentSubject: other }];
  mixed.serialized = JSON.stringify(parsed);
  assert.throws(() => store.replaceSourceApprovalCheckpoint({ ...identity, expectedRevision: null, checkpoint: mixed }), /do not belong/);
  const nonexistent = { ...identity, sourceUserSeq: other.sourceUserSeq + 1000 };
  assert.throws(() => store.replaceSourceApprovalCheckpoint({ ...nonexistent, expectedRevision: null, checkpoint: checkpoint(nonexistent) }), /not an accepted/);
  assert.equal(store.readSourceApprovalCheckpoint(identity).revision, null);
});

test('malformed persisted indexes cannot be treated as an empty store', () => {
  const { identity, checkpoint } = fixture();
  events.updateSession(identity.sessionId, { metadata: { __source_approval_checkpoints: 'corrupt' } });
  assert.throws(() => store.readSourceApprovalCheckpoint(identity), /Malformed/);
  assert.throws(() => store.listSourceApprovalCheckpoints(identity.sessionId), /Malformed/);
  assert.throws(() => store.replaceSourceApprovalCheckpoint({ ...identity, expectedRevision: null, checkpoint: checkpoint() }), /Malformed/);
  assert.equal(events.getSession(identity.sessionId)!.metadata.__source_approval_checkpoints, 'corrupt');
});
