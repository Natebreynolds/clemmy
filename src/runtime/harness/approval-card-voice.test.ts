/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approval-card-voice.test.ts
 *
 * Live 10-02: Needs you titled a card "Cli setup" and the phone "I'm ready to
 * cli_setup: install". Every surface now titles a card with Clem's own
 * question from its approval_requested event, when her checker wrote one.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-card-voice-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { approvalCardAsk, approvalCardVoice } = await import('./approval-card-voice.js');
const { presentApprovalForHumans } = await import('../../dashboard/approval-presentation.js');

after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

test('a card is titled with Clem\'s own question when her checker wrote one, and as before when not', () => {
  const session = eventlog.createSession({ kind: 'chat', title: 'card voice' });
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'approval_requested', data: {
    tool: 'work_call', subject: 'cli_setup: install', approvalId: 'apr-v01c',
    preview: { operation: 'cli_setup', fields: [], ask: 'Can I install Vapi\'s command-line tool on your Mac?', why: 'It changes your Mac.' },
  } });
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'approval_requested', data: {
    tool: 'work_call', subject: 'Send Slack message', approvalId: 'apr-n0v0', preview: { operation: 'Send Slack message', fields: [] },
  } });
  const ask = approvalCardAsk(session.id, 'apr-v01c');
  assert.equal(ask, 'Can I install Vapi\'s command-line tool on your Mac?');
  assert.equal(approvalCardAsk(session.id, 'apr-n0v0'), null);
  assert.deepEqual(approvalCardVoice(session.id, 'apr-v01c'), { ask, why: 'It changes your Mac.' });
  assert.equal(presentApprovalForHumans({ tool: 'work_call', args: {}, subject: 'x', ask, why: 'It changes your Mac.' }).why, 'It changes your Mac.');
  assert.equal(approvalCardAsk('another-session', 'apr-v01c'), null, 'read from the card\'s own conversation only');
  assert.equal(presentApprovalForHumans({ tool: 'work_call', args: {}, subject: 'cli_setup: install', ask }).ask, ask);
  assert.equal(presentApprovalForHumans({ tool: 'work_call', args: {}, subject: 'Send Slack message', ask: null }).ask, undefined);
});
