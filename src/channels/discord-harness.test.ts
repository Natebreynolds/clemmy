/**
 * Run: npx tsx --test src/channels/discord-harness.test.ts
 *
 * applyEventToState is the pure heart of the Discord live-edit loop:
 * harness events come in, the display state mutates, the renderer
 * paints. Driving real Discord.js or actionBus from a unit test is
 * not worth it — but the state machine is.
 *
 * These tests anchor the contract so the surface we ship doesn't
 * silently regress: which events advance the summary, which events
 * change just the status line, which events mark the reply done.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventRow } from '../runtime/harness/eventlog.js';
import { applyEventToState, parseApprovalIntent, parseHarnessCommand } from './discord-harness.js';

function freshState() {
  return { summary: '', status: 'starting', done: false, toolsCalled: [], toolCount: 0 };
}

function event(type: EventRow['type'], data: Record<string, unknown> = {}): EventRow {
  return {
    seq: 1,
    id: 'ev-test',
    sessionId: 'sess-test',
    turn: 1,
    role: 'system',
    type,
    parentEventId: null,
    data,
    createdAt: '2026-05-17T12:00:00.000Z',
  };
}

test('turn_started → "thinking…" status only', () => {
  const s = freshState();
  applyEventToState(event('turn_started'), s);
  assert.equal(s.status, 'thinking…');
  assert.equal(s.summary, '');
  assert.equal(s.done, false);
});

test('tool_called → "using <name>"', () => {
  const s = freshState();
  applyEventToState(event('tool_called', { tool: 'read_file' }), s);
  assert.equal(s.status, 'using read_file');
  assert.equal(s.done, false);
});

test('handoff → "→ <target>"', () => {
  const s = freshState();
  applyEventToState(event('handoff', { to: 'Executor' }), s);
  assert.equal(s.status, '→ Executor');
});

test('conversation_step updates the summary and step counter', () => {
  const s = freshState();
  applyEventToState(
    event('conversation_step', {
      step: 2,
      decision: { summary: 'handed off to Executor for the scrape', done: false, nextAction: 'awaiting_handoff_result' },
    }),
    s,
  );
  assert.equal(s.summary, 'handed off to Executor for the scrape');
  assert.equal(s.status, 'step 2');
  assert.equal(s.done, false);
});

test('approval_requested surfaces the subject in summary and marks the display done', () => {
  // The summary (not status) carries the approval text because
  // renderBody hides status when done=true. Putting the message in
  // summary is what makes the Discord reply settle on
  // "Approval required: ..." instead of degrading to "working…".
  const s = freshState();
  applyEventToState(event('approval_requested', { subject: 'deploy to prod', tool: 'request_approval' }), s);
  assert.ok(s.summary.startsWith('Approval required: deploy to prod'));
  assert.ok(s.summary.includes('approve'));
  assert.equal(s.status, 'approval required');
  assert.equal(s.done, true);
});

test('approval_requested falls back to tool name when no subject', () => {
  const s = freshState();
  applyEventToState(event('approval_requested', { tool: 'cx_zendesk_create_ticket' }), s);
  assert.ok(s.summary.startsWith('Approval required: cx_zendesk_create_ticket'));
});

test('awaiting_user_input promotes the question to the summary and marks done', () => {
  const s = freshState();
  applyEventToState(event('awaiting_user_input', { question: 'which environment?' }), s);
  assert.equal(s.summary, 'which environment?');
  assert.equal(s.status, 'awaiting reply');
  assert.equal(s.done, true);
});

test('conversation_completed promotes summary, marks done, "complete" status', () => {
  const s = { summary: 'older summary', status: 'step 3', done: false, toolsCalled: [], toolCount: 0 };
  applyEventToState(
    event('conversation_completed', { summary: 'all 20 emails scheduled for 2pm daily', steps: 4 }),
    s,
  );
  assert.equal(s.summary, 'all 20 emails scheduled for 2pm daily');
  assert.equal(s.status, 'complete');
  assert.equal(s.done, true);
});

test('conversation_completed with abandoned reason marks "abandoned" status', () => {
  const s = freshState();
  applyEventToState(
    event('conversation_completed', {
      summary: 'cannot proceed without admin role',
      reason: 'abandoned_by_orchestrator',
    }),
    s,
  );
  assert.equal(s.status, 'abandoned');
  assert.equal(s.done, true);
});

test('run_failed shows the error and marks done', () => {
  const s = freshState();
  applyEventToState(event('run_failed', { error: 'composio catalog timeout' }), s);
  assert.match(s.summary, /composio catalog timeout/);
  assert.equal(s.status, 'failed');
  assert.equal(s.done, true);
});

test('conversation_limit_exceeded surfaces the reason and marks done', () => {
  const s = freshState();
  applyEventToState(event('conversation_limit_exceeded', { reason: 'wall_clock', steps: 12 }), s);
  assert.equal(s.status, 'stopped: wall_clock');
  assert.equal(s.done, true);
});

test('unknown event types are no-ops (state untouched)', () => {
  const s = { summary: 'still here', status: 'mid-flight', done: false, toolsCalled: [] as string[], toolCount: 0 };
  applyEventToState(event('heartbeat'), s);
  applyEventToState(event('plan_drafted'), s);
  assert.deepEqual(s, { summary: 'still here', status: 'mid-flight', done: false, toolsCalled: [], toolCount: 0 });
});

test('summary persists across steps when a later event lacks one', () => {
  const s = freshState();
  applyEventToState(
    event('conversation_step', {
      step: 1,
      decision: { summary: 'researched accounts', done: false, nextAction: 'awaiting_handoff_result' },
    }),
    s,
  );
  // Next event has no summary — it should leave the previous one intact.
  applyEventToState(event('tool_called', { tool: 'write_file' }), s);
  assert.equal(s.summary, 'researched accounts');
  assert.equal(s.status, 'using write_file');
});

// ─── parseApprovalIntent — T1.2 tightening (v0.4.22+) ─────────────

test('parseApprovalIntent: strong verbs match without an apr-xxxx', () => {
  assert.deepEqual(parseApprovalIntent('approve'), { decision: 'approve' });
  assert.deepEqual(parseApprovalIntent('approved'), { decision: 'approve' });
  assert.deepEqual(parseApprovalIntent('proceed'), { decision: 'approve' });
  assert.deepEqual(parseApprovalIntent('go ahead'), { decision: 'approve' });
  assert.deepEqual(parseApprovalIntent('lgtm'), { decision: 'approve' });
  assert.deepEqual(parseApprovalIntent('do it'), { decision: 'approve' });
  assert.deepEqual(parseApprovalIntent('confirm'), { decision: 'approve' });
  assert.deepEqual(parseApprovalIntent('👍'), { decision: 'approve' });
  assert.deepEqual(parseApprovalIntent('reject'), { decision: 'reject' });
  assert.deepEqual(parseApprovalIntent('deny'), { decision: 'reject' });
  assert.deepEqual(parseApprovalIntent('abort'), { decision: 'reject' });
  assert.deepEqual(parseApprovalIntent('nevermind'), { decision: 'reject' });
  assert.deepEqual(parseApprovalIntent("don't do it"), { decision: 'reject' });
  assert.deepEqual(parseApprovalIntent('👎'), { decision: 'reject' });
});

test('parseApprovalIntent: bare loose verbs do NOT match (T1.2 tightening)', () => {
  // These used to count as approve/reject under the old matcher. They
  // were the source of the "what's up?" hijack — too many real
  // conversation messages started with these.
  assert.equal(parseApprovalIntent('yes'), null);
  assert.equal(parseApprovalIntent('y'), null);
  assert.equal(parseApprovalIntent('ok'), null);
  assert.equal(parseApprovalIntent('okay'), null);
  assert.equal(parseApprovalIntent('sure'), null);
  assert.equal(parseApprovalIntent('sounds good'), null);
  assert.equal(parseApprovalIntent('no'), null);
  assert.equal(parseApprovalIntent('n'), null);
  assert.equal(parseApprovalIntent('stop'), null);
  // The "cancel" word is reserved for /cancel — no longer a reject.
  assert.equal(parseApprovalIntent('cancel'), null);
  assert.equal(parseApprovalIntent("what's up?"), null);
  assert.equal(parseApprovalIntent('any updates?'), null);
});

test('parseApprovalIntent: loose verbs DO match when an apr-xxxx is present', () => {
  // "yes apr-26ba" reads as approval because the ID makes the intent
  // unambiguous; the user is explicitly addressing the approval.
  assert.deepEqual(parseApprovalIntent('yes apr-26ba'), { decision: 'approve', approvalId: 'apr-26ba' });
  assert.deepEqual(parseApprovalIntent('ok apr-xy7q'), { decision: 'approve', approvalId: 'apr-xy7q' });
  assert.deepEqual(parseApprovalIntent('sure apr-1abc'), { decision: 'approve', approvalId: 'apr-1abc' });
  assert.deepEqual(parseApprovalIntent('no apr-99zz'), { decision: 'reject', approvalId: 'apr-99zz' });
  assert.deepEqual(parseApprovalIntent('stop apr-0000'), { decision: 'reject', approvalId: 'apr-0000' });
});

test('parseApprovalIntent: strong verbs pick up an apr-xxxx when present', () => {
  assert.deepEqual(parseApprovalIntent('approve apr-xy7q'), { decision: 'approve', approvalId: 'apr-xy7q' });
  assert.deepEqual(parseApprovalIntent('reject apr-26ba'), { decision: 'reject', approvalId: 'apr-26ba' });
  // ID at end of a longer phrase still extracts.
  assert.deepEqual(
    parseApprovalIntent('approve the salesforce one apr-111h please'),
    { decision: 'approve', approvalId: 'apr-111h' },
  );
});

test('parseApprovalIntent: trims + ignores case', () => {
  assert.deepEqual(parseApprovalIntent('  APPROVE  '), { decision: 'approve' });
  assert.deepEqual(parseApprovalIntent('Reject'), { decision: 'reject' });
});

test('parseApprovalIntent: empty string returns null', () => {
  assert.equal(parseApprovalIntent(''), null);
  assert.equal(parseApprovalIntent('   '), null);
});

// ─── parseHarnessCommand — /cancel and /new (T1.2) ────────────────

test('parseHarnessCommand: recognizes /cancel and bare cancel', () => {
  assert.equal(parseHarnessCommand('/cancel'), 'cancel');
  assert.equal(parseHarnessCommand('cancel'), 'cancel');
  assert.equal(parseHarnessCommand('  cancel  '), 'cancel');
  assert.equal(parseHarnessCommand('CANCEL'), 'cancel');
});

test('parseHarnessCommand: recognizes /new and bare new', () => {
  assert.equal(parseHarnessCommand('/new'), 'new');
  assert.equal(parseHarnessCommand('new'), 'new');
  assert.equal(parseHarnessCommand('  New  '), 'new');
});

test('parseHarnessCommand: recognizes /continue, continue, and "keep going" (T1.3)', () => {
  assert.equal(parseHarnessCommand('/continue'), 'continue');
  assert.equal(parseHarnessCommand('continue'), 'continue');
  assert.equal(parseHarnessCommand('Continue'), 'continue');
  assert.equal(parseHarnessCommand('keep going'), 'continue');
  assert.equal(parseHarnessCommand('  CONTINUE  '), 'continue');
});

test('parseHarnessCommand: does NOT match substring matches or natural language', () => {
  // The whole message must equal the command — "cancel the workflow"
  // is a regular agent prompt, not a /cancel directive.
  assert.equal(parseHarnessCommand('cancel the workflow'), null);
  assert.equal(parseHarnessCommand('please cancel'), null);
  assert.equal(parseHarnessCommand('start a new project'), null);
  assert.equal(parseHarnessCommand('/cancel-this'), null);
  assert.equal(parseHarnessCommand('continue the conversation'), null);
  assert.equal(parseHarnessCommand("let's keep going on this"), null);
  assert.equal(parseHarnessCommand(''), null);
});
