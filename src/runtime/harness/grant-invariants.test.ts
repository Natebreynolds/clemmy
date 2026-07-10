/**
 * Run: npx tsx --test src/runtime/harness/grant-invariants.test.ts
 *
 * THE-GRANT invariants (Phase 1) — the permanent regression floor built from
 * 2026-07-09's three live exhibits. These replays must stay green at every
 * phase of the plan, forever:
 *   I1 / Exhibit A: an irreversible send can never execute on POLICY consent —
 *       only a real human card decision arms it.
 *   I2 / Exhibit C: after a human yes (certified batch), session bookkeeping
 *       (the execution-wrap gate) can never refuse the dispatch.
 *   I3 / Exhibit B: the completion judge never fires while the human's
 *       approval card is open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-grant-inv-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { queuePendingAction, markPendingActionApprovalResolved, getPendingAction } = await import('./pending-actions.js');
const { executeApprovedPendingActionCall } = await import('../../execution/pending-action-executor.js');
const { shouldRunObjectiveJudge } = await import('./objective-judge.js');
const { wrapToolForHarness, withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
const { createSession, resetEventLog } = await import('./eventlog.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

function queueSendAction() {
  return queuePendingAction({
    title: 'Send reactivation email',
    summary: 'one outbound email',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to_email: 'a@firm.com', subject: 's', body: 'b' }) },
    sessionId: 'sess-grant',
    createdBy: 'test',
  });
}

test('EXHIBIT A replay: a POLICY-approved irreversible send is inert at every executor', async () => {
  const record = queueSendAction();
  // The forgery path: policy consent (what "Auto-approved by YOLO mode" mints).
  markPendingActionApprovalResolved(record.id, 'approved', null, {
    by: 'policy',
    evidence: { kind: 'policy', scope: 'yolo' },
  });
  assert.equal(getPendingAction(record.id)?.approvedBy, 'policy');

  let dispatched = 0;
  const result = await executeApprovedPendingActionCall(record.id, {
    dispatch: async () => { dispatched += 1; return 'sent'; },
  });
  assert.equal(result.ok, false, 'policy consent must not execute an irreversible send');
  assert.match(result.resultSummary, /approved by POLICY/i);
  assert.equal(dispatched, 0, 'zero sends — Exhibit A is impossible');
});

test('I1 counterpart: a HUMAN card decision arms the same action', async () => {
  const record = queueSendAction();
  markPendingActionApprovalResolved(record.id, 'approved', 'apr-human-1');
  const after = getPendingAction(record.id);
  assert.equal(after?.approvedBy, 'human');
  assert.deepEqual(after?.approvalEvidence, { kind: 'card', approvalId: 'apr-human-1' });

  let dispatched = 0;
  const result = await executeApprovedPendingActionCall(record.id, {
    dispatch: async () => { dispatched += 1; return 'sent'; },
  });
  assert.equal(result.ok, true, 'human consent executes');
  assert.equal(dispatched, 1);
});

test('EXHIBIT C replay: a certified (human-approved) batch item passes the execution-wrap gate with NO active execution', async () => {
  const prevGate = process.env.CLEMMY_EXECUTION_GATE;
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.CLEMMY_EXECUTION_GATE = 'on';
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  try {
    const wrapped = wrapToolForHarness({
      name: 'composio_execute_tool',
      execute: async () => 'sent',
    });
    const send = (certified: boolean) =>
      withHarnessRunContext(
        { sessionId: sess.id, counter: new ToolCallsCounter(50), ...(certified ? { certifiedBatch: { batchId: 'b1', payloadHash: 'h1' } } : {}) },
        () => wrapped.execute!({ tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to_email: 'x@y.com', subject: 's', body: 'b' }) }),
      );
    // Ungranted ad-hoc send with no active execution → the gate still guards.
    const blocked = String(await send(false));
    assert.match(blocked, /refused by harness|EXECUTION_WRAP/i, 'ungranted send is still gated');
    // Certified batch item (the human-approved, byte-pinned plan) → dispatches.
    const granted = String(await send(true));
    assert.ok(granted.startsWith('sent'), 'a human yes cannot be vetoed by session bookkeeping — Exhibit C is impossible');
  } finally {
    process.env.CLEMMY_EXECUTION_GATE = prevGate;
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
  }
});

test('EXHIBIT B guard: the completion judge never fires while an approval card is open', () => {
  const base = {
    optIn: true,
    actionIntent: true,
    meaningfulToolEvidence: false,
    continuationsUsed: 0,
    maxContinuations: 2,
    nextAction: 'completed',
  };
  assert.equal(shouldRunObjectiveJudge({ ...base, openApprovalCard: false }), true, 'judge runs normally');
  assert.equal(shouldRunObjectiveJudge({ ...base, openApprovalCard: true }), false, 'open card = waiting on the human, never judged');
});

// ─── Global send floor (bypass-hunt lanes, 2026-07-09) ───────────────────────

const { looksLikeNativeMcpSend } = await import('./execution-gate.js');
const { classifyExternalWrite } = await import('./confirm-first-gate.js');

test('native MCP send names are classified as irreversible sends across naming conventions', () => {
  for (const name of [
    'outlook_send_mail',
    'gmail__send_email',
    'gmail__sendEmail',
    'vapi__make-outbound-call',
    'create_call',
    'slack__post_message',
    'slack__postMessage',
    'calendar__createEvent',
    'x__broadcast',
  ]) {
    assert.equal(looksLikeNativeMcpSend(name), true, `${name} should be a send`);
    const shape = classifyExternalWrite(name, {});
    assert.equal(shape.irreversible, true, `${name} classifies irreversible`);
  }
  // Reversible / non-send names are NOT gated.
  for (const name of ['outlook__create_draft', 'gmail__list_messages', 'sheets__values_get', 'notion__search']) {
    assert.equal(looksLikeNativeMcpSend(name), false, `${name} is not a send`);
  }
});

test('the send floor gates irreversible sends on EVERY session kind, not just chat (lanes 4/5)', async () => {
  const prevGate = process.env.CLEMMY_CONFIRM_FIRST;
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.CLEMMY_CONFIRM_FIRST = 'on';
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
  saveProactivityPolicy({ autoApproveScope: 'yolo', batchConfirmThreshold: 3 });
  try {
    // A WORKFLOW session (kind 'execution') — the default-scope lane that
    // needed no YOLO to bypass the old chat-only gate.
    for (const kind of ['execution', 'workflow'] as const) {
      resetEventLog();
      const sess = createSession({ kind });
      const wrapped = wrapToolForHarness({ name: 'composio_execute_tool', execute: async () => 'sent' });
      const send = (n: number) => withHarnessRunContext(
        { sessionId: sess.id, counter: new ToolCallsCounter(50) },
        () => wrapped.execute!({ tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to_email: `p${n}@x.com`, subject: 's', body: 'b' }) }),
      );
      assert.ok(String(await send(1)).startsWith('sent'), `${kind} send #1 under threshold flows`);
      assert.ok(String(await send(2)).startsWith('sent'), `${kind} send #2 flows`);
      const blocked = String(await send(3));
      assert.match(blocked, /refused by harness|confirm/i, `${kind} send #3 (batch threshold) is gated even off-chat`);
    }
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced', batchConfirmThreshold: 5 });
    process.env.CLEMMY_CONFIRM_FIRST = prevGate;
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
  }
});

test('Hole 4 (TOCTOU): concurrent fan-out of irreversible sends is counted as a batch, not N masquerading singles', async () => {
  const prevGate = process.env.CLEMMY_CONFIRM_FIRST;
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.CLEMMY_CONFIRM_FIRST = 'on';
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
  saveProactivityPolicy({ autoApproveScope: 'yolo', batchConfirmThreshold: 3 });
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  try {
    const wrapped = wrapToolForHarness({ name: 'composio_execute_tool', execute: async () => 'sent' });
    // Fire 6 sends CONCURRENTLY (the worker fan-out shape) — pre-fix, all 6
    // read prior<threshold in the await gap and all send.
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      withHarnessRunContext(
        { sessionId: sess.id, counter: new ToolCallsCounter(50) },
        () => wrapped.execute!({ tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to_email: `p${i}@x.com`, subject: 's', body: 'b' }) }),
      ).then((r) => String(r)).catch((e) => `blocked:${e instanceof Error ? e.message : e}`),
    ));
    const sent = results.filter((r) => r.startsWith('sent')).length;
    const blocked = results.filter((r) => /refused by harness|blocked:/.test(r)).length;
    assert.ok(sent < 6, `not all 6 concurrent sends should pass (got ${sent} sent)`);
    assert.ok(blocked >= 1, 'the batch floor trips under concurrency — at least one send is gated');
    // Under threshold 3: at most the first 2 flow, the rest gate.
    assert.ok(sent <= 2, `at most threshold-1 sends flow before the floor (got ${sent})`);
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced', batchConfirmThreshold: 5 });
    process.env.CLEMMY_CONFIRM_FIRST = prevGate;
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
  }
});

// ─── Round-3 precise holes (multiplexer laundering / verbs / YOLO) ───────────

const { evaluateAutoApprove, openPlanScope, closePlanScope, isAutoApprovedByScope, isUngrantableMultiplexer } = await import('../../agents/plan-scope.js');

test('Hole A: a scope naming the composio gateway does NOT launder consent across slugs', () => {
  // request_approval opened a scope for GMAIL_SEND_EMAIL only.
  openPlanScope({ sessionId: 'sess-launder', planProposalId: 'p', approvedPlanObjective: 'send one gmail',
    allowedTools: ['composio_execute_tool'], allowedComposioSlugs: ['GMAIL_SEND_EMAIL'] });
  const gmail = { tool_slug: 'GMAIL_SEND_EMAIL' };
  const slack = { tool_slug: 'SLACK_SEND_MESSAGE' };
  assert.equal(isAutoApprovedByScope('sess-launder', 'composio_execute_tool', gmail, 'send'), true, 'the enumerated slug flows');
  assert.equal(isAutoApprovedByScope('sess-launder', 'composio_execute_tool', slack, 'send'), false, 'a DIFFERENT slug through the gateway is NOT auto-approved');
  closePlanScope('sess-launder', 'test');
});

test('Hole B: telephony + post slugs classify as irreversible sends', () => {
  for (const slug of ['VAPI_CREATE_CALL', 'TWILIO_MAKE_OUTBOUND_CALL', 'SLACK_CHAT_POST_MESSAGE', 'LINKEDIN_CREATE_LINKED_IN_POST', 'TWITTER_CREATION_OF_A_POST']) {
    const shape = classifyExternalWrite('composio_execute_tool', { tool_slug: slug });
    assert.equal(shape.irreversible, true, `${slug} must be irreversible`);
  }
  // Reversible data writes stay reversible (not over-gated).
  for (const slug of ['GOOGLESHEETS_VALUES_UPDATE', 'AIRTABLE_CREATE_RECORD', 'GMAIL_CREATE_DRAFT']) {
    const shape = classifyExternalWrite('composio_execute_tool', { tool_slug: slug });
    assert.equal(shape.irreversible, false, `${slug} stays reversible`);
  }
});

test('Hole C: YOLO never auto-approves an irreversible send on the per-tool path', () => {
  const send = evaluateAutoApprove({ sessionId: undefined, toolName: 'outlook_send_mail', args: {}, scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(send.autoApproved, false, 'YOLO does not wave an irreversible send');
  // YOLO still auto-approves a reversible action.
  const write = evaluateAutoApprove({ sessionId: undefined, toolName: 'write_file', args: {}, scope: 'yolo', insideWorkspace: false, kindHint: 'other' });
  assert.equal(write.autoApproved, true, 'YOLO still covers reversible work');
});

// ─── 2026-07-09 RE-HUNT holes (5 lanes) — permanent regression floor ───

test('re-hunt Lane 5: SEND_DRAFT / FORWARD / REPLY are irreversible; CHAT_COMPLETION / COMMENT stay reversible', () => {
  for (const slug of ['OUTLOOK_SEND_DRAFT', 'GMAIL_SEND_DRAFT', 'OUTLOOK_FORWARD_MAIL', 'GMAIL_REPLY_TO_THREAD']) {
    assert.equal(classifyExternalWrite('composio_execute_tool', { tool_slug: slug }).irreversible, true, `${slug} must be irreversible`);
  }
  // Over-gating fixed: an LLM call, an internal comment, and a draft are reversible.
  for (const slug of ['OPENAI_CREATE_CHAT_COMPLETION', 'NOTION_CREATE_COMMENT', 'OUTLOOK_CREATE_DRAFT', 'OUTLOOK_CREATE_REPLY_DRAFT']) {
    assert.equal(classifyExternalWrite('composio_execute_tool', { tool_slug: slug }).irreversible, false, `${slug} must stay reversible`);
  }
});

test('re-hunt Lanes 2/3: a native comm-object send (create_event) is NOT auto-approved under YOLO or a wildcard scope', () => {
  // The taxonomy verb list called create_event 'write' → kindHint 'other',
  // which used to short-circuit the send lock. Now the authoritative classifier
  // wins: YOLO must ask, and a wildcard '*' scope must NOT launder it.
  const yolo = evaluateAutoApprove({ sessionId: undefined, toolName: 'claude_ai_Google_Calendar__create_event', args: { attendees: ['a@x.com'] }, scope: 'yolo', insideWorkspace: false, kindHint: 'other' });
  assert.equal(yolo.autoApproved, false, 'YOLO must not wave a calendar-invite send');
  openPlanScope({ sessionId: 'sess-wild', planProposalId: 'p', approvedPlanObjective: 'do work', allowedTools: ['*'] });
  assert.equal(isAutoApprovedByScope('sess-wild', 'claude_ai_Google_Calendar__create_event', { attendees: ['a@x.com'] }, 'other'), false, 'a wildcard scope must not auto-approve an invite send');
  // A genuinely reversible native write still flows under the wildcard scope.
  assert.equal(isAutoApprovedByScope('sess-wild', 'create_file', { path: 'x' }, 'other'), true, 'reversible work still flows under a wildcard scope');
  closePlanScope('sess-wild', 'test');
});

test('re-hunt Lane 1: the composio gateway name is an ungrantable multiplexer (never sticky-approvable)', () => {
  assert.equal(isUngrantableMultiplexer('composio_execute_tool'), true, 'the gateway name never counts as consent');
  assert.equal(isUngrantableMultiplexer('write_file'), false, 'a real single-purpose tool can be granted');
});
