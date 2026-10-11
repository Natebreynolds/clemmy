/** Stop closes an execution head, not the owner's visible conversation.
 * Exercise real accepted-source selection, persisted reopen and audience
 * isolation; no model/provider calls or external effects are involved. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-visible-continuity-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const eventlog = await import('../runtime/harness/eventlog.js');
const { claimSessionForAcceptedSource, selectSessionForAcceptedSource, readAcceptedSourceConversationProjection } =
  await import('../runtime/harness/accepted-source-session-branch.js');
const { buildUnifiedSessionList, getUnifiedSessionDetail, patchUnifiedSession, deleteUnifiedSession } =
  await import('./sessions-api.js');

test.after(() => { eventlog.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

const continuity = { provider: 'desktop', scopeId: null, conversationId: 'stop-continuity', audienceId: 'owner' };
let serial = 0;
function rootSession(label: string) {
  return eventlog.createSession({ id: `visible-continuity-${label}`, kind: 'chat', channel: continuity.provider,
    userId: continuity.audienceId, title: label,
    metadata: { source: continuity.provider, channelId: continuity.conversationId, userId: continuity.audienceId } });
}
function accept(entrySessionId: string, identity = continuity) {
  const n = ++serial;
  return claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId, durableSourceId: `visible-run-${n}`, continuity: identity,
    receipt: { requestId: `visible-request-${n}`, runId: `visible-run-${n}`, inputHash: String(n).padStart(64, '0') } });
}
function exchange(sessionId: string, request: string, reply: string, stop = false) {
  const source = eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: request } });
  eventlog.appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'conversation_completed',
    data: { sourceUserSeq: source.seq, reply, reason: stop ? 'cancelled' : 'success' } });
  if (stop) eventlog.updateSession(sessionId, { status: 'cancelled' });
}

test('Stop/Continue successors reopen as one public chat while exact receipts and cancelled heads stay unchanged', () => {
  const root = rootSession('stop-reopen');
  const first = accept(root.id);
  assert.equal(first.selection.sessionId, root.id);
  exchange(root.id, 'Keep the fixture draft.', 'I stopped this run.', true);
  const child = accept(root.id);
  assert.equal(child.selection.disposition, 'branched');
  exchange(child.selection.sessionId, 'Continue with the retained draft.', 'The fixture draft is complete.');
  const beforeBindings = eventlog.openEventLog().prepare('SELECT * FROM accepted_source_session_bindings ORDER BY durable_source_digest').all();

  const expected = { rootSessionId: root.id, headSessionId: child.selection.sessionId,
    sessionIds: [root.id, child.selection.sessionId] };
  assert.deepEqual(readAcceptedSourceConversationProjection(root.id), expected);
  assert.deepEqual(readAcceptedSourceConversationProjection(child.selection.sessionId), expected);
  const listed = buildUnifiedSessionList({ includeArchived: true, limit: 100 }).filter(row =>
    row.id === `harness:${root.id}` || row.id === `harness:${child.selection.sessionId}`);
  assert.equal(listed.length, 1, 'rail shows the conversation once');
  assert.equal(listed[0]!.id, `harness:${root.id}`);
  assert.equal(listed[0]!.executionSessionId, child.selection.sessionId);
  const detail = getUnifiedSessionDetail(`harness:${root.id}`)!;
  assert.deepEqual(detail.turns.map(turn => turn.text), [
    'Keep the fixture draft.', 'I stopped this run.', 'Continue with the retained draft.', 'The fixture draft is complete.',
  ]);
  assert.equal(detail.continueHint?.streamUrl, `/api/sessions/${child.selection.sessionId}/events`);
  assert.deepEqual(getUnifiedSessionDetail(`harness:${child.selection.sessionId}`), detail, 'old physical links canonicalize to the public chat');
  eventlog.closeEventLog();
  assert.deepEqual(getUnifiedSessionDetail(`harness:${root.id}`), detail, 'reopen uses persisted lineage, not process/UI memory');
  assert.equal(eventlog.getSession(root.id)?.status, 'cancelled');
  assert.equal(eventlog.getSession(child.selection.sessionId)?.status, 'active');
  assert.deepEqual(eventlog.openEventLog().prepare('SELECT * FROM accepted_source_session_bindings ORDER BY durable_source_digest').all(), beforeBindings,
    'presentation reads never transfer exact source ownership');
  assert.throws(() => selectSessionForAcceptedSource({ kind: 'bound_control', entrySessionId: root.id,
    targetSessionId: child.selection.sessionId, durableSourceId: 'foreign-control', continuity: { ...continuity, audienceId: 'other-owner' } }), /audience|principal/);

  const renamed = patchUnifiedSession(`harness:${child.selection.sessionId}`, { title: 'One stopped conversation', pinned: true })!;
  assert.equal(renamed.id, `harness:${root.id}`);
  assert.equal(renamed.title, 'One stopped conversation');
  assert.equal(eventlog.getSession(root.id)?.metadata.pinned, true);
  assert.equal(eventlog.getSession(child.selection.sessionId)?.metadata.pinned, true);
  deleteUnifiedSession(`harness:${root.id}`);
  assert.equal(eventlog.getSession(root.id)?.metadata.archived, true);
  assert.equal(eventlog.getSession(child.selection.sessionId)?.metadata.archived, true);
  assert.equal(eventlog.getSession(root.id)?.status, 'cancelled');
});

test('a long series of stopped execution heads retains the whole visible history without seeded-context duplicates', () => {
  const root = rootSession('long-stop-lineage');
  let head = root.id;
  const requests: string[] = [];
  const ids: string[] = [];
  for (let index = 0; index < 11; index += 1) {
    head = accept(head).selection.sessionId;
    ids.push(head);
    requests.push(`Named fixture turn ${index}.`);
    exchange(head, requests[index]!, `Stopped fixture turn ${index}.`, true);
  }
  const detail = getUnifiedSessionDetail(`harness:${root.id}`)!;
  assert.equal(detail.session.executionSessionId, head);
  assert.deepEqual(detail.turns.filter(turn => turn.role === 'user').map(turn => turn.text), requests);
  assert.equal(detail.turns.length, 22);
  assert.deepEqual(readAcceptedSourceConversationProjection(head)?.sessionIds, ids);
});

test('identity-split roots expose only their principal, and forged branch metadata cannot join private history', () => {
  const root = rootSession('principal-boundary');
  accept(root.id);
  exchange(root.id, 'Owner-only fixture request.', 'Owner-only fixture reply.', true);
  const otherIdentity = { ...continuity, audienceId: 'other-owner' };
  const split = accept(root.id, otherIdentity);
  assert.equal(split.selection.disposition, 'identity_split');
  exchange(split.selection.sessionId, 'Other owner fixture request.', 'Other owner fixture reply.');
  const other = getUnifiedSessionDetail(`harness:${split.selection.sessionId}`)!;
  assert.equal(other.session.id, `harness:${split.selection.sessionId}`);
  assert.deepEqual(other.turns.map(turn => turn.text), ['Other owner fixture request.', 'Other owner fixture reply.']);
  assert.deepEqual(readAcceptedSourceConversationProjection(split.selection.sessionId)?.sessionIds, [split.selection.sessionId]);

  const child = accept(root.id);
  exchange(child.selection.sessionId, 'Owner continuation fixture.', 'Owner continuation reply.');
  const childRow = eventlog.getSession(child.selection.sessionId)!;
  const forged = eventlog.createSession({ id: 'visible-forged-parent', kind: 'chat', channel: 'desktop', userId: 'owner',
    metadata: { ...childRow.metadata } });
  exchange(forged.id, 'Forged branch fixture.', 'Forged reply.');
  assert.equal(readAcceptedSourceConversationProjection(forged.id), null, 'copied metadata lacks an exact session-bound source binding');
  assert.deepEqual(getUnifiedSessionDetail(`harness:${forged.id}`)!.turns.map(turn => turn.text), ['Forged branch fixture.', 'Forged reply.']);
  assert.doesNotMatch(JSON.stringify(getUnifiedSessionDetail(`harness:${root.id}`)!.turns), /Other owner|Forged branch/);
  const pointer = eventlog.openEventLog().prepare('SELECT * FROM accepted_source_session_pointers WHERE root_session_id = ?').get(root.id) as { continuity_digest: string };
  eventlog.openEventLog().prepare('UPDATE accepted_source_session_pointers SET head_session_id = ? WHERE root_session_id = ? AND continuity_digest = ?')
    .run(forged.id, root.id, pointer.continuity_digest);
  assert.equal(readAcceptedSourceConversationProjection(root.id), null, 'a forged pointer cannot make a copied parent into ownership');
  assert.deepEqual(getUnifiedSessionDetail(`harness:${root.id}`)!.turns.map(turn => turn.text), ['Owner-only fixture request.', 'Owner-only fixture reply.']);
});
