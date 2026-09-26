/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approval-precheck.test.ts
 *
 * Live 2026-09-25: an email went out breaking a standing rule that was already
 * in Clem's context; the card showed only subject and recipients. The owner's
 * checker now reads the exact content before the card, and the card says what
 * it found.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-precheck-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { approvalPrecheck, parseApprovalPrecheck, _setApprovalPrecheckRunForTests } = await import('./approval-precheck.js');

test.after(() => {
  _setApprovalPrecheckRunForTests(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

function conversation() {
  const session = eventlog.createSession({ id: `precheck-${Math.random().toString(36).slice(2)}`, kind: 'chat' });
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'email the snapshot to my two colleagues' } });
  eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'approve apr-abcd', synthetic: true } });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 3, role: 'user', type: 'user_input_received',
    data: { text: 'yes send it' } });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

const email = {
  operation: 'Send Outlook email',
  fields: [
    { name: 'to', value: 'colleague@example.test' },
    { name: 'body', value: 'SCOPE: pulled from the research tool, US/English, today.' },
  ],
};

test('the owner\'s checker reads the exact content, the recent asks and the rules; the card gets its conflicts', async () => {
  const where = conversation();
  const seen: Array<{ content: string; ownerAsked: string[]; ownerRules: string }> = [];
  _setApprovalPrecheckRunForTests(async (input) => {
    seen.push(input);
    return { conflicts: [{ problem: 'It names "the research tool"; you asked never to name tools in emails.' }] };
  });
  assert.deepEqual(await approvalPrecheck({ ...where, preview: email }), {
    status: 'conflicts',
    conflicts: ['It names "the research tool"; you asked never to name tools in emails.'],
  });
  assert.match(seen[0]!.content, /SCOPE: pulled from the research tool/);
  assert.deepEqual(seen[0]!.ownerAsked, ['email the snapshot to my two colleagues', 'yes send it'],
    'the owner\'s own recent words, never host control text');
  assert.equal(typeof seen[0]!.ownerRules, 'string');
});

test('a clean check says so, a failed check says it could not check, and id-only calls are not checked', async () => {
  const where = conversation();
  _setApprovalPrecheckRunForTests(async () => '{"conflicts": []}');
  assert.deepEqual(await approvalPrecheck({ ...where, preview: email }), { status: 'clear' });
  _setApprovalPrecheckRunForTests(async () => { throw new Error('checker unavailable'); });
  assert.deepEqual(await approvalPrecheck({ ...where, preview: email }), { status: 'unavailable' });
  _setApprovalPrecheckRunForTests(async () => 'not json at all');
  assert.deepEqual(await approvalPrecheck({ ...where, preview: email }), { status: 'unavailable' });
  let ran = false;
  _setApprovalPrecheckRunForTests(async () => { ran = true; return { conflicts: [] }; });
  assert.equal(await approvalPrecheck({ ...where, preview: { operation: 'Open Slack dm', fields: [{ name: 'users', value: 'U0FIXTURE1' }] } }), undefined);
  assert.equal(ran, false, 'nothing to read in an id-only call');
});

test('conflict lines are bounded to three short sentences', () => {
  const long = 'x '.repeat(300);
  const lines = parseApprovalPrecheck({ conflicts: [{ problem: long }, { problem: 'b' }, { problem: 'c' }, { problem: 'd' }, { problem: '' }] });
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.length <= 240);
  assert.throws(() => parseApprovalPrecheck({ nope: true }));
});
