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
const { approvalPrecheck, parseApprovalPrecheck, _setApprovalPrecheckRunForTests, APPROVAL_PRECHECK_INSTRUCTIONS } = await import('./approval-precheck.js');

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

test('a clean check says so, a failed check says it could not check, and no call means no check', async () => {
  const where = conversation();
  _setApprovalPrecheckRunForTests(async () => '{"conflicts": []}');
  assert.deepEqual(await approvalPrecheck({ ...where, preview: email }), { status: 'clear' });
  _setApprovalPrecheckRunForTests(async () => { throw new Error('checker unavailable'); });
  assert.deepEqual(await approvalPrecheck({ ...where, preview: email }), { status: 'unavailable' });
  _setApprovalPrecheckRunForTests(async () => 'not json at all');
  assert.deepEqual(await approvalPrecheck({ ...where, preview: email }), { status: 'unavailable' });
  assert.equal(await approvalPrecheck({ ...where, preview: null }), undefined, 'no call, nothing to read');
});

// Live 10-02: cards read "Approve: cli_setup: install" over raw argument names;
// the question card, in Clem's own words, was the one the owner loved.
test('the checker writes the card in Clem\'s words for every card, from the exact call and the consent facts', async () => {
  const where = conversation();
  const seen: Array<Record<string, unknown>> = [];
  _setApprovalPrecheckRunForTests(async (input) => {
    seen.push(input as unknown as Record<string, unknown>);
    return {
      ask: 'Can I install Vapi\'s command-line tool on your Mac?',
      why: 'It changes your Mac, and you asked me to wire up the API, not install a tool.',
      conflicts: [{ problem: 'You asked me to wire the API into Settings, not install a command-line tool.' }],
    };
  });
  const install = { operation: 'cli_setup', fields: [{ name: 'action', value: 'install' }, { name: 'command', value: 'npm install -g @vapi-ai/cli' }] };
  const result = await approvalPrecheck({ ...where, preview: install,
    consent: { effect: 'local_write', consequence: 'update', reversibility: 'ordinary_non_destructive', destructive: false } });
  assert.deepEqual(result, {
    status: 'conflicts',
    conflicts: ['You asked me to wire the API into Settings, not install a command-line tool.'],
    ask: 'Can I install Vapi\'s command-line tool on your Mac?',
    why: 'It changes your Mac, and you asked me to wire up the API, not install a tool.',
  });
  assert.deepEqual(seen[0]!.consent, { effect: 'local_write', consequence: 'update', reversibility: 'ordinary_non_destructive', destructive: false });
  // An id-only call is read too: its card still needs Clem's question.
  _setApprovalPrecheckRunForTests(async () => ({ ask: 'Can I open a direct message with Dana?', why: '', conflicts: [] }));
  assert.deepEqual(await approvalPrecheck({ ...where, preview: { operation: 'Open Slack dm', fields: [{ name: 'users', value: 'U0FIXTURE1' }] } }),
    { status: 'clear', ask: 'Can I open a direct message with Dana?' });
  assert.match(APPROVAL_PRECHECK_INSTRUCTIONS, /Never use tool names, operation ids, field names, JSON or record ids/);
  assert.match(APPROVAL_PRECHECK_INSTRUCTIONS, /to the owner as "you"/);
});

test('the card\'s words are bounded and optional', async () => {
  const where = conversation();
  _setApprovalPrecheckRunForTests(async () => ({ ask: `Can I ${'really '.repeat(60)}do it?`, conflicts: [] }));
  const result = await approvalPrecheck({ ...where, preview: email });
  assert.ok((result?.ask ?? '').length <= 200);
  assert.equal(result?.why, undefined);
  _setApprovalPrecheckRunForTests(async () => '{"conflicts": []}');
  assert.deepEqual(await approvalPrecheck({ ...where, preview: email }), { status: 'clear' }, 'an older reply shape still works');
});

test('conflict lines are bounded to three short sentences', () => {
  const long = 'x '.repeat(300);
  const lines = parseApprovalPrecheck({ conflicts: [{ problem: long }, { problem: 'b' }, { problem: 'c' }, { problem: 'd' }, { problem: '' }] });
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.length <= 240);
  assert.throws(() => parseApprovalPrecheck({ nope: true }));
});

test('the check judges against what the owner wants now: a later message replaces an earlier one', () => {
  // Live regression: a card revised by the owner's written change was flagged
  // as contradicting the original request the change had replaced.
  assert.match(APPROVAL_PRECHECK_INSTRUCTIONS, /recent messages oldest first/);
  assert.match(APPROVAL_PRECHECK_INSTRUCTIONS, /A later message changes or replaces what an earlier one asked/);
  assert.match(APPROVAL_PRECHECK_INSTRUCTIONS, /not a conflict with the earlier request/);
});

test('after a refusal in the same turn the checker is told to say what was refused and what changed', () => {
  // Owner 2026-10-09: a change of plan after an app said no is put to the
  // owner; the card's why carries the refusal and the change.
  assert.match(APPROVAL_PRECHECK_INSTRUCTIONS, /"refusedEarlier"/);
  assert.match(APPROVAL_PRECHECK_INSTRUCTIONS, /what the app refused and what this attempt changes/);
});

test('a card partway through a request opens with what is already done', async () => {
  // Phone test 2026-10-09: after the owner approved the HTML body, the next
  // card only asked to delete an attachment, and the owner read the request
  // as not done. The checker now gets the writes already through.
  assert.match(APPROVAL_PRECHECK_INSTRUCTIONS, /"doneThisTurn"/);
  assert.match(APPROVAL_PRECHECK_INSTRUCTIONS, /Open "ask" with a short clause on what is already done/);
  const where = conversation();
  let seen: Record<string, unknown> | undefined;
  _setApprovalPrecheckRunForTests(async (input) => { seen = input as Record<string, unknown>; return { ask: 'Can I?', conflicts: [] }; });
  await approvalPrecheck({ ...where, preview: email });
  assert.equal(seen && 'doneThisTurn' in seen, false, 'nothing done yet: the field is absent');
});
