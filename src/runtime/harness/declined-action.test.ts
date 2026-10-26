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

test('a declined workflow delete keeps the implementation-equivalent confirmation and target spellings declined', () => {
  for (const original of [{ name: 'Controlled Fixture', confirm: null }, { name: 'Controlled Fixture' }]) {
    const session = eventlog.createSession({ kind: 'chat' });
    const sinceIso = new Date(Date.now() - 1_000).toISOString();
    const card = registry.register({ sessionId: session.id, subject: 'delete fixture', tool: 'workflow_delete', args: original });
    registry.resolve(card.approvalId, 'rejected', 'owner');
    for (const args of [
      { name: 'Controlled Fixture', confirm: true },
      { names: ['Controlled Fixture'], confirm: true },
      { name: ' Controlled Fixture ', names: ['Controlled Fixture'], confirm: null },
    ]) {
      assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso, tool: 'workflow_delete', args }), true,
        JSON.stringify({ original, args }));
      assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso, tool: 'call_tool', args: { name: 'workflow_delete', args_json: args } }), true);
    }
    for (const args of [
      { name: 'Another Fixture', confirm: true },
      { names: ['Controlled Fixture', 'Another Fixture'], confirm: true },
      { name: 'Controlled Fixture', confirm: false },
      { name: 'Controlled Fixture', confirm: 'true' },
      { names: [42], confirm: true },
    ]) assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso, tool: 'workflow_delete', args }), false);
    assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso, tool: 'foreign__workflow_delete', args: { name: 'Controlled Fixture', confirm: true } }), false);
    assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso, tool: 'composio_execute_tool',
      args: { tool_slug: 'workflow_delete', arguments: { names: ['Controlled Fixture'], confirm: true } } }), false,
    'a gateway operation with a local-looking slug does not acquire the local delete schema');
    assert.equal(ownerDeclinedSameAction({ sessionId: session.id, sinceIso, tool: 'composio_execute_tool',
      args: { tool_slug: 'workflow_delete', arguments: { names: ['Controlled Fixture'] } } }), false,
    'raw gateway arguments cannot collide with the local-only normalized target set');
  }
});

test('delete equivalence does not erase another operation\'s confirmation, target form or nonempty null changes', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const sinceIso = new Date(Date.now() - 1_000).toISOString();
  const card = registry.register({ sessionId: session.id, subject: 'other operation', tool: 'other_tool',
    args: { name: 'Controlled Fixture', confirm: null, value: null } });
  registry.resolve(card.approvalId, 'rejected', 'owner');
  const matches = (args: unknown) => ownerDeclinedSameAction({ sessionId: session.id, sinceIso, tool: 'other_tool', args });
  assert.equal(matches({ name: 'Controlled Fixture' }), true, 'existing null-field comparison stays unchanged');
  assert.equal(matches({ name: 'Controlled Fixture', confirm: true }), false);
  assert.equal(matches({ names: ['Controlled Fixture'] }), false);
  assert.equal(matches({ name: 'Controlled Fixture', value: 'null' }), false);
});

test('the same declined workflow target set stays declined across merged fields, duplicates and order', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const sinceIso = new Date(Date.now() - 1_000).toISOString();
  const card = registry.register({ sessionId: session.id, subject: 'delete fixtures', tool: 'workflow_delete',
    args: { names: ['Fixture A', 'Fixture B'], confirm: true } });
  registry.resolve(card.approvalId, 'rejected', 'owner');
  const matches = (args: unknown) => ownerDeclinedSameAction({ sessionId: session.id, sinceIso, tool: 'workflow_delete', args });
  assert.equal(matches({ name: ' Fixture A ', names: ['Fixture B', 'Fixture A'], confirm: null }), true);
  assert.equal(matches({ names: ['Fixture B', 'Fixture A'] }), true);
  assert.equal(matches({ names: ['Fixture A'] }), false);
  assert.equal(matches({ names: ['Fixture A', 'fixture b'] }), false, 'case remains part of the exact target');
  assert.equal(matches({ names: ['Fixture A', 'Fixture B'], confirm: true, other: true }), false);
});
