/** A no stays a no for the request it answered (controlled fixtures only). */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-declined-action-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const registry = await import('./approval-registry.js');
const { ownerDeclinedSameAction } = await import('./declined-action.js');

test.after(() => { eventlog.closeEventLog(); rmSync(TEST_HOME, { recursive: true, force: true }); });

test('the same action the owner declined in this request gets no second card, however it is carried; another action or a later request may', () => {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop', title: 'Controlled declined fixture' });
  const since = new Date(Date.now() - 1_000).toISOString();
  const card = registry.register({ sessionId: session.id, subject: 'workflow_delete', tool: 'workflow_delete',
    args: { name: 'Controlled Fixture', names: null, confirm: null } });
  assert.equal(registry.resolve(card.approvalId, 'rejected', 'owner').ok, true);

  const sameThroughCarrier = { requirement_id: 'cap:local:workflow_delete:confirmed', name: 'workflow_delete', args_json: { confirm: null, name: 'Controlled Fixture' } };
  assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso: since, tool: 'work_call', args: sameThroughCarrier }), true);
  assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso: since, tool: 'workflow_delete', args: { name: 'Controlled Fixture' } }), true,
    'empty fields do not make it a different action');
  assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso: since, tool: 'workflow_delete', args: { name: 'Another Fixture' } }), false);
  assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso: new Date(Date.now() + 60_000).toISOString(), tool: 'workflow_delete', args: { name: 'Controlled Fixture' } }), false,
    'a later request from the owner can ask for it again');

  const approvedCard = registry.register({ sessionId: session.id, subject: 'workflow_delete', tool: 'workflow_delete', args: { name: 'Approved Fixture' } });
  registry.resolve(approvedCard.approvalId, 'approved', 'owner');
  assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso: since, tool: 'workflow_delete', args: { name: 'Approved Fixture' } }), false);
});
