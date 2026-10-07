/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/terminal-delivery-resume-ledger.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-delivery-resume-ledger-'));
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
const eventlog = await import('./eventlog.js');
const ledger = await import('./terminal-delivery-resume-ledger.js');
test.after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

test('a delivery-judge resume is remembered across activations, per accepted source', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const first = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Delete it.' } });
  const second = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'And again.' } });
  assert.equal(ledger.priorTerminalDeliveryResumes(session.id, first.seq), 0);
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'heartbeat',
    data: { kind: 'terminal_delivery_resume', reason: 'verify the state', attempt: 1, sourceUserSeq: first.seq } });
  assert.equal(ledger.priorTerminalDeliveryResumes(session.id, first.seq), 1, 'the second activation sees the first resume');
  assert.equal(ledger.priorTerminalDeliveryResumes(session.id, second.seq), 0, 'another source is not charged for it');
  assert.equal(ledger.priorTerminalDeliveryResumes(session.id, undefined), 0);
});
