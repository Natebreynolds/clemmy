/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/revised-card-link.test.ts
 *
 * A change in words keeps its card: the fresh card names the one it
 * revises, the owner's words and the fields as they were.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-revised-card-link-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { revisedCardLink } = await import('./revised-card-link.js');

const OLD_FIELDS = [{ name: 'command', value: 'ssh -G localhost' }];

function changedCard(sessionId: string, approvalId: string) {
  eventlog.appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'approval_requested',
    data: { approvalId, tool: 'request_approval', preview: { operation: 'run_shell_command', fields: OLD_FIELDS } } });
  eventlog.appendEvent({ sessionId, turn: 0, role: 'system', type: 'approval_resolved',
    data: { approvalId, decision: 'reject', resolution: 'rejected', changeRequested: true, changeRequest: 'Yes, but add -v so I can see the verbose output too.' } });
}

test('the fresh card names the changed card, the owner\'s words and the fields as they were, once', () => {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  changedCard(session.id, 'apr-old1');
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Yes, but add -v so I can see the verbose output too.' } });
  assert.deepEqual(revisedCardLink(session.id, source.seq), {
    revises: { approvalId: 'apr-old1', fields: OLD_FIELDS, changeRequest: 'Yes, but add -v so I can see the verbose output too.' },
  });
  // Once a card has claimed the change, the next card revises nothing.
  eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'Clem', type: 'approval_requested',
    data: { approvalId: 'apr-new1', tool: 'request_approval', revises: { approvalId: 'apr-old1' } } });
  assert.deepEqual(revisedCardLink(session.id, source.seq), {});
});

test('without a change, or with the words only on the resolution, the link is exact', () => {
  const plain = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  eventlog.appendEvent({ sessionId: plain.id, turn: 1, role: 'Clem', type: 'approval_requested', data: { approvalId: 'apr-p', tool: 'request_approval' } });
  eventlog.appendEvent({ sessionId: plain.id, turn: 0, role: 'system', type: 'approval_resolved', data: { approvalId: 'apr-p', decision: 'reject' } });
  assert.deepEqual(revisedCardLink(plain.id, undefined), {}, 'a plain decline is not a change');
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  changedCard(session.id, 'apr-old2');
  // A card raised by a control turn (no accepted source of its own) still
  // carries the words the resolution recorded.
  assert.deepEqual(revisedCardLink(session.id, undefined), {
    revises: { approvalId: 'apr-old2', fields: OLD_FIELDS, changeRequest: 'Yes, but add -v so I can see the verbose output too.' },
  });
});

test('a session branched off the conversation reads the change along its lineage', () => {
  // The owner's words may run in an accepted-source successor session while
  // the changed card and its resolution sit in the conversation it branched from.
  const root = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  changedCard(root.id, 'apr-old3');
  const branch = eventlog.createSession({ kind: 'chat', channel: 'desktop',
    metadata: { __accepted_source_branch: { version: 1, rootSessionId: root.id, parentSessionId: root.id } } });
  const source = eventlog.appendEvent({ sessionId: branch.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Yes, but add -v.' } });
  assert.deepEqual(revisedCardLink(branch.id, source.seq), {
    revises: { approvalId: 'apr-old3', fields: OLD_FIELDS, changeRequest: 'Yes, but add -v.' },
  });
  const stranger = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  assert.deepEqual(revisedCardLink(stranger.id, undefined), {}, 'another conversation never inherits the change');
});
