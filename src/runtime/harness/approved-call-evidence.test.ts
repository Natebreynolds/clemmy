/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approved-call-evidence.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approved-call-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const { personApprovalForCall } = await import('./approved-call-evidence.js');
const approvals = await import('./approval-registry.js');
const { createSession, appendEvent, closeEventLog, openEventLog } = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const outcomes = await import('./attempt-outcome.js');
const store = await import('./logical-call-settlement-store.js');

after(() => {
  closeEventLog();
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const VALUE = 'dana.whitlock@harborline.example';
const TOOL = 'peoplescope__notify';
const ARGS = { to: VALUE, text: 'The draft is ready.' };

interface Scenario {
  resolver?: string;
  decision?: string;
  markerRole?: 'system' | 'user';
  approvedArgs?: Record<string, unknown>;
  fields?: Array<{ name: string; value: string; label?: string }>;
  /** Settle the call before the approval is given. */
  settleFirst?: boolean;
  /** A second call of the same request with the same contract. */
  twin?: boolean;
  carrier?: boolean;
  /** The work first read the record that carries the value and its name. */
  directory?: boolean;
}

function settle(
  task: { sessionId: string; sourceUserSeq: number; acceptedTaskId: string }, callId: string, args: Record<string, unknown>,
  read?: { tool: string; payload: unknown },
): void {
  const tool = read?.tool ?? TOOL;
  const started = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId: callId, physicalDispatchId: `${callId}:1`, ordinal: 0 }, tool, args });
  assert.equal(started.status, 'inserted', JSON.stringify(started));
  if (started.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({ identity: started.identity, tool, outcome: 'returned' }).status, 'inserted');
  assert.equal(store.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: callId }, contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' }, result: { payload: read?.payload ?? { ok: true } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: !read }, observer: { lane: 'byo', turn: 1 },
  }).status, 'committed');
}

function build(id: string, scenario: Scenario = {}): { sessionId: string; sourceUserSeq: number; approvalId: string } {
  const session = createSession({ id, kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Tell Dana Whitlock the draft is ready.' } });
  assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } }));
  const task = { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq) };
  if (scenario.directory) {
    settle(task, 'r-people', { query: 'Dana Whitlock' }, { tool: 'peoplescope__find', payload: { people: [
      { profile: { displayName: 'Dana Whitlock', title: 'Operations lead' }, contact: VALUE },
      { profile: { displayName: 'Rafi Okonkwo' }, contact: 'rafi@harborline.example' }] } });
  }
  if (scenario.settleFirst) settle(task, 'w-notify', ARGS);
  const approved = scenario.approvedArgs ?? ARGS;
  const card = approvals.register({
    sessionId: session.id, subject: 'fixture',
    ...(scenario.carrier
      ? { tool: 'work_call', args: { name: TOOL, args_json: JSON.stringify(approved) } }
      : { tool: TOOL, args: approved }),
  });
  appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'approval_requested', data: {
    approvalId: card.approvalId, tool: card.tool, subject: 'fixture', args: card.args,
    preview: { operation: TOOL, fields: scenario.fields ?? [
      { name: 'to', value: VALUE, label: 'Dana Whitlock' }, { name: 'text', value: 'The draft is ready.' }] },
  } });
  const decision = scenario.decision ?? 'approve';
  assert.equal(approvals.resolve(card.approvalId, 'approved', scenario.resolver ?? 'desktop-command-center').ok, true);
  const control = appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: {
    text: `Approve ${card.approvalId}.`, synthetic: true, source: 'approval_resume', approvalId: card.approvalId, decision,
  } });
  appendEvent({ sessionId: session.id, turn: 2, role: scenario.markerRole ?? 'system', type: 'run_resumed', data: {
    reviewContinuationVersion: 1, deliverySourceUserSeq: control.seq, executionSourceUserSeq: source.seq,
    approvalId: card.approvalId, decision,
  } });
  if (!scenario.settleFirst) {
    // The decision and the settlement are compared by their recorded times.
    openEventLog().prepare("UPDATE pending_approvals SET requested_at = ?, resolved_at = ? WHERE approval_id = ?")
      .run(new Date(Date.now() - 5_000).toISOString(), new Date(Date.now() - 2_000).toISOString(), card.approvalId);
    settle(task, 'w-notify', ARGS);
  }
  if (scenario.twin) settle(task, 'w-notify-again', ARGS);
  return { sessionId: session.id, sourceUserSeq: source.seq, approvalId: card.approvalId };
}

const ask = (built: { sessionId: string; sourceUserSeq: number }, value = VALUE) =>
  personApprovalForCall({ sessionId: built.sessionId, sourceUserSeq: built.sourceUserSeq, callId: 'w-notify', value });

test('a person who approved the card that showed the value approved the call that used it', () => {
  const direct = build('approved-direct');
  assert.deepEqual(ask(direct), { approvalId: direct.approvalId });
  const carried = build('approved-carrier', { carrier: true });
  assert.deepEqual(ask(carried), { approvalId: carried.approvalId }, 'the approval held the call inside a carrier');
  const nested = build('approved-nested', { fields: [{ name: 'message', value: JSON.stringify({ recipients: [{ address: VALUE }] }) }] });
  assert.deepEqual(ask(nested), { approvalId: nested.approvalId }, 'a structure shown whole shows what it holds');
});

test('anything short of that is no approval of the value', () => {
  const cases: Array<[string, Scenario, string?]> = [
    ['a runner resolved it', { resolver: 'workflow-runner' }],
    ['a rule resolved it', { resolver: 'system:workflow-auto' }],
    ['the server resolved a duplicate nobody pressed', { resolver: 'desktop-command-center:exact-duplicate' }],
    ['the resume default resolved it', { resolver: 'harness-resume' }],
    ['a surface nobody has classified', { resolver: 'some-new-surface' }],
    ['a reply in words with no record of who replied', { resolver: 'discord-conversation' }],
    ['the marker was not written by the host', { markerRole: 'user' }],
    ['the approval was changed before it was given', { decision: 'approve_with_edits' }],
    ['the approval was for other arguments', { approvedArgs: { to: 'rafi@harborline.example', text: 'The draft is ready.' } }],
    ['the card did not show the value', { fields: [{ name: 'text', value: 'The draft is ready.' }] }],
    ['the card withheld the value', { fields: [{ name: 'to', value: '[withheld: looks like a secret]' }] }],
    ['the card showed a structure cut short', { fields: [{ name: 'message', value: `{"recipients":[{"address":"${VALUE}"},{"note":"…` }] }],
    ['the call had settled before anyone decided', { settleFirst: true }],
    ['two calls share the contract, so which one was approved is not known', { twin: true }],
  ];
  for (const [why, scenario] of cases) {
    assert.equal(ask(build(`not-approved-${cases.findIndex((row) => row[0] === why)}`, scenario)), null, why);
  }
  const built = build('approved-other-value');
  assert.equal(ask(built, 'rafi@harborline.example'), null, 'a value the card never showed');
  assert.equal(personApprovalForCall({ ...built, callId: 'no-such-call', value: VALUE }), null);
  assert.equal(personApprovalForCall({ sessionId: 'no-such-session', sourceUserSeq: 1, callId: 'w-notify', value: VALUE }), null);
});

test('who decided is classified in one place and an unknown surface confers nothing', () => {
  const base = { status: 'resolved' as const, resolution: 'approved' as const, presentation: null,
    requestedAt: '2026-09-29T08:00:00.000Z', expiresAt: '2026-09-30T08:00:00.000Z', resolvedAt: '2026-09-29T08:01:00.000Z' };
  const replied = { responseSourceUserSeq: 12, responseUserId: 'owner' } as never;
  const person = ['desktop-command-center', 'desktop-tasks-board', 'desktop-chat-card', 'mobile-inbox',
    'chat-dock-user', 'slack-user', 'discord-user'];
  for (const resolver of person) assert.equal(approvals.approvalDecidedByPerson({ ...base, resolver }), true, resolver);
  for (const resolver of ['discord-conversation', 'daemon-conversation-recovery']) {
    assert.equal(approvals.approvalDecidedByPerson({ ...base, resolver }), false, `${resolver} without the reply`);
    assert.equal(approvals.approvalDecidedByPerson({ ...base, resolver, presentation: replied }), true, `${resolver} with the reply`);
  }
  const notPerson = ['', 'reaper', 'reaper-dead-session', 'approval-resume', 'harness-resume', 'workflow-runner',
    'background-task-drain', 'system:workflow-auto', 'harness:reviewed_cli_read:list', 'tidy', 'slack-workflow-pause',
    'desktop-command-center:exact-duplicate', 'chat-dock-user:req-1', 'discord-conversation-changed',
    'mobile-chat-control', 'console-home-control', 'space-data-runner-trust', 'automation-recurrence-reconciler',
    'dashboard:bulk-cancel-stale', 'U0FIXTURE1'];
  for (const resolver of notPerson) assert.equal(approvals.approvalDecidedByPerson({ ...base, resolver }), false, resolver);
  assert.equal(approvals.approvalDecidedByPerson({ ...base, resolver: null }), false);
  assert.equal(approvals.approvalDecidedByPerson({ ...base, resolver: 'mobile-inbox', resolution: 'rejected' }), false);
  assert.equal(approvals.approvalDecidedByPerson({ ...base, resolver: 'mobile-inbox', resolvedAt: '2026-10-02T08:00:00.000Z' }), false,
    'a decision recorded after the card expired');
});

// The rule the owner agreed on 2026-09-29: an approval confirms a name only
// when the naming check also leans to that name.
test('finished work the owner approved is learned as confirmed when the naming check leans to the name', async () => {
  const { learnResolvedReferencesForAcceptedTask } = await import('./resolved-reference-learning.js');
  const { findActiveFactsByContentPrefix } = await import('../../memory/facts.js');
  const lean = async (question: { candidates: string[] }) =>
    ({ name: question.candidates.find((candidate) => candidate === 'Dana Whitlock') ?? null, confidence: 0.72 });

  const approved = build('learned-approved', { directory: true });
  const kept = await learnResolvedReferencesForAcceptedTask(approved, { readName: lean });
  assert.deepEqual(kept.references.map((row) => [row.named, row.value, row.grade, row.basis, row.outcome]), [
    ['Dana Whitlock', VALUE, 'confirmed', { namingConfidence: 0.72, confirmedBy: 'owner_approval', approvalId: approved.approvalId }, 'kept']]);
  const fact = findActiveFactsByContentPrefix('reference', 'When a request names "Dana Whitlock", peoplescope__notify takes to = ')[0]!;
  assert.match(fact.content, /\(confirmed: the owner approved the call that used it; used in a change the provider accepted; found in a peoplescope__find result\)/);
  assert.equal(fact.trustLevel, 0.8);

  // The same work released by something that is not a person stays a lead,
  // and a lead does not replace what the owner confirmed.
  const unattended = build('learned-unattended', { directory: true, resolver: 'workflow-runner' });
  const lead = await learnResolvedReferencesForAcceptedTask(unattended, { readName: lean });
  assert.deepEqual(lead.references.map((row) => [row.grade, row.basis, row.outcome]), [['provisional', { namingConfidence: 0.72 }, 'held']]);
  assert.equal(findActiveFactsByContentPrefix('reference', 'When a request names "Dana Whitlock", peoplescope__notify takes to = ').length, 1);
});
