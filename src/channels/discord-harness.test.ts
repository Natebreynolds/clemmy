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
import {
  applyEventToState,
  isContinueCompletionReason,
  parseApprovalIntent,
  parseHarnessCommand,
  toDiscordMarkdown,
  __test__,
} from './discord-harness.js';
import type { PendingApprovalRow } from '../runtime/harness/approval-registry.js';

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

function approvalRow(overrides: Partial<PendingApprovalRow> = {}): PendingApprovalRow {
  return {
    approvalId: 'apr-test',
    sessionId: 'sess-test',
    channel: 'discord',
    channelId: 'chan-a',
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    subject: 'test approval',
    tool: 'request_approval',
    args: null,
    status: 'pending',
    resolution: null,
    resolver: null,
    resolvedAt: null,
    ...overrides,
  };
}

test('turn_started → "thinking…" status only', () => {
  const s = freshState();
  applyEventToState(event('turn_started'), s);
  assert.equal(s.status, 'thinking…');
  assert.equal(s.summary, '');
  assert.equal(s.done, false);
});

test('tool_called → "using <name>" when args missing', () => {
  // Fallback path: no args means we can't build a rich preview, so we
  // keep the existing "using <tool>" UX rather than dropping the
  // verb. Without this fallback the user reads "read_file" as a noun.
  const s = freshState();
  applyEventToState(event('tool_called', { tool: 'read_file' }), s);
  assert.equal(s.status, 'using read_file');
  assert.equal(s.done, false);
});

test('tool_called → rich preview when args extract a useful field', () => {
  // v0.5.5: 7-call run_shell_command sequences during skill execution
  // used to show "using run_shell_command" 7 times — useless to the
  // Discord viewer. Now we surface the actual command. Same idea for
  // write_file (the path) and composio_execute_tool (the slug).
  const shell = freshState();
  applyEventToState(
    event('tool_called', { tool: 'run_shell_command', arguments: JSON.stringify({ command: 'pwd && ls -la' }) }),
    shell,
  );
  assert.equal(shell.status, 'running: pwd && ls -la');

  const write = freshState();
  applyEventToState(
    event('tool_called', { tool: 'write_file', arguments: JSON.stringify({ path: '/tmp/foo.txt' }) }),
    write,
  );
  assert.equal(write.status, 'writing /tmp/foo.txt');

  const composio = freshState();
  applyEventToState(
    event('tool_called', { tool: 'composio_execute_tool', arguments: JSON.stringify({ tool_slug: 'OUTLOOK_LIST_MESSAGES' }) }),
    composio,
  );
  assert.equal(composio.status, 'composio · OUTLOOK_LIST_MESSAGES');
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

test('approval buttons render for a single pending approval', () => {
  const s = freshState();
  applyEventToState(event('approval_requested', { subject: 'create draft', tool: 'request_approval', approvalId: 'apr-1111' }), s);
  const rows = __test__.approvalComponentsForState(s) as Array<{ components: Array<{ label: string; custom_id: string }> }>;
  assert.equal(rows[0].components[0].label, 'Approve');
  assert.equal(rows[0].components[0].custom_id, 'clementine:approve:apr-1111');
  assert.equal(rows[0].components[1].label, 'Edit');
  assert.equal(rows[0].components[2].label, 'Reject');
});

test('approval buttons collapse sibling approvals into one batch action', () => {
  const s = freshState();
  applyEventToState(event('approval_requested', { subject: 'draft one', tool: 'composio_execute_tool', approvalId: 'apr-1111' }), s);
  applyEventToState(event('approval_requested', { subject: 'draft two', tool: 'composio_execute_tool', approvalId: 'apr-2222' }), s);
  const rows = __test__.approvalComponentsForState(s) as Array<{ components: Array<{ label: string; custom_id: string }> }>;
  assert.equal(rows[0].components.length, 2);
  assert.equal(rows[0].components[0].label, 'Approve all 2');
  assert.equal(rows[0].components[0].custom_id, 'clementine:approve:apr-1111');
  assert.equal(rows[0].components[1].label, 'Reject all 2');
});

test('approval picker gives each ambiguous global approval explicit buttons', () => {
  const rows = __test__.approvalPickerComponents([
    approvalRow({ approvalId: 'apr-1111', subject: 'first approval' }),
    approvalRow({ approvalId: 'apr-2222', subject: 'second approval' }),
  ]) as Array<{ components: Array<{ label: string; custom_id: string }> }>;

  assert.equal(rows.length, 2);
  assert.equal(rows[0].components[0].label, 'Approve apr-1111');
  assert.equal(rows[0].components[0].custom_id, 'clementine:approve:apr-1111');
  assert.equal(rows[0].components[1].custom_id, 'clementine:reject:apr-1111');
  assert.equal(rows[1].components[0].custom_id, 'clementine:approve:apr-2222');
  assert.equal(rows[1].components[1].custom_id, 'clementine:reject:apr-2222');
});

test('guardrail_tripped stays internal and does not overwrite Discord status', () => {
  const s = { summary: 'Approval required: create sheet', status: 'approval required', done: true, toolsCalled: [], toolCount: 0 };
  applyEventToState(event('guardrail_tripped', { name: 'guardrail' }), s);
  assert.equal(s.summary, 'Approval required: create sheet');
  assert.equal(s.status, 'approval required');
  assert.equal(s.done, true);
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

test('conversation_completed with sub-agent stall marks "stalled" status', () => {
  const s = freshState();
  applyEventToState(
    event('conversation_completed', {
      summary: "The sub-agent announced work it was about to do but didn't actually call the tool.",
      reason: 'sub_agent_stalled',
    }),
    s,
  );
  assert.match(s.summary, /didn't actually call the tool/);
  assert.equal(s.status, 'stalled');
  assert.equal(s.done, true);
});

test('continuation completion reasons include current and legacy limit markers', () => {
  assert.equal(isContinueCompletionReason('awaiting_continue'), true);
  assert.equal(isContinueCompletionReason('limit_exceeded'), true);
  assert.equal(isContinueCompletionReason('claude_agent_sdk_brain'), false);
  assert.equal(isContinueCompletionReason(undefined), false);
});

test('conversation_completed awaiting_continue marks stopped and preserves reply', () => {
  const s = freshState();
  applyEventToState(
    event('conversation_completed', {
      reply: 'Reply `continue` to keep going.',
      reason: 'awaiting_continue',
      limitKind: 'max_steps',
    }),
    s,
  );
  assert.equal(s.summary, 'Reply `continue` to keep going.');
  assert.equal(s.status, 'stopped: max_steps');
  assert.equal(s.done, true);
});

test('conversation_completed legacy limit_exceeded remains continuable', () => {
  const s = freshState();
  applyEventToState(
    event('conversation_completed', {
      summary: 'Paused at the model turn budget.',
      reason: 'limit_exceeded',
    }),
    s,
  );
  assert.equal(s.summary, 'Paused at the model turn budget.');
  assert.equal(s.status, 'stopped: continue');
  assert.equal(s.done, true);
});

test('run_failed shows the error and marks done', () => {
  const s = freshState();
  applyEventToState(event('run_failed', { error: 'composio catalog timeout' }), s);
  assert.match(s.summary, /composio catalog timeout/);
  assert.equal(s.status, 'failed');
  assert.equal(s.done, true);
});

test('conversation_limit_exceeded surfaces the reason without closing before the continue reply', () => {
  const s = freshState();
  applyEventToState(event('conversation_limit_exceeded', { reason: 'wall_clock', steps: 12 }), s);
  assert.equal(s.status, 'stopped: wall_clock');
  assert.equal(s.done, false);
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

test('approval routing only accepts approvals for the current Discord channel', () => {
  assert.equal(
    __test__.approvalBelongsToDiscordChannel(approvalRow({ channelId: 'chan-a' }), 'chan-a'),
    true,
  );
  assert.equal(
    __test__.approvalBelongsToDiscordChannel(approvalRow({ channelId: 'chan-a' }), 'chan-b'),
    false,
  );
});

test('approval routing rejects expired or non-Discord approvals', () => {
  assert.equal(
    __test__.approvalBelongsToDiscordChannel(
      approvalRow({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      'chan-a',
    ),
    false,
  );
  assert.equal(
    __test__.approvalBelongsToDiscordChannel(approvalRow({ channel: 'workflow', channelId: null }), 'chan-a'),
    false,
  );
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

test('parseHarnessCommand: recognizes /sessions and bare sessions', () => {
  assert.equal(parseHarnessCommand('/sessions'), 'sessions');
  assert.equal(parseHarnessCommand('sessions'), 'sessions');
  assert.equal(parseHarnessCommand('/session'), 'sessions');
  assert.equal(parseHarnessCommand('session'), 'sessions');
  assert.equal(parseHarnessCommand('  Sessions  '), 'sessions');
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
  assert.equal(parseHarnessCommand('show active sessions please'), null);
  assert.equal(parseHarnessCommand("let's keep going on this"), null);
  assert.equal(parseHarnessCommand(''), null);
});

test('session picker renders resume and pending approval buttons', () => {
  const option = {
    session: {
      id: 'sess-test-1234',
      kind: 'chat',
      channel: 'electron',
      userId: null,
      createdAt: '2026-05-27T12:00:00.000Z',
      updatedAt: '2026-05-27T12:01:00.000Z',
      status: 'paused',
      title: 'Desktop meeting follow-up',
      objective: null,
      tokenBudget: null,
      tokensUsed: 0,
      currentPlanId: null,
      metadata: {},
    },
    pendingApprovals: [approvalRow({ approvalId: 'apr-abcd', sessionId: 'sess-test-1234' })],
    isBound: false,
    rank: 1,
  };
  const text = __test__.renderSessionPickerText([option] as never, 'chan-a');
  assert.match(text, /Desktop meeting follow-up/);
  assert.match(text, /1 approval waiting/);
  const rows = __test__.sessionPickerComponents([option] as never) as Array<{ components: Array<{ custom_id: string; label: string }> }>;
  assert.equal(rows[0].components[0].custom_id, 'clementine:session-resume:sess-test-1234');
  assert.equal(rows[0].components[1].custom_id, 'clementine:approve:apr-abcd');
  assert.equal(rows[0].components[2].custom_id, 'clementine:reject:apr-abcd');
});

// ─── isDiscordTokenExpired — P0-1 detection layer (v0.5.x) ───────
// Discord interaction tokens die at 15 minutes. When that happens
// handle.edit() throws with one of several shapes (REST API code,
// HTTP status, or message text). The detector must recognize ALL of
// them so the flush/finalFlush fallback through sendFollowup
// (discord-harness.ts:1141 + :1184) actually triggers. Missing a
// shape means a long workflow goes dark past minute 15.

test('isDiscordTokenExpired: numeric REST code 10015 (Unknown Webhook)', () => {
  assert.equal(__test__.isDiscordTokenExpired({ code: 10015 }), true);
});

test('isDiscordTokenExpired: numeric REST code 50027 (Invalid Webhook Token)', () => {
  assert.equal(__test__.isDiscordTokenExpired({ code: 50027 }), true);
});

test('isDiscordTokenExpired: string REST code is parsed as a number', () => {
  // discord.js sometimes hands the code through as a string. The
  // detector parses to make sure neither shape slips past.
  assert.equal(__test__.isDiscordTokenExpired({ code: '10015' }), true);
  assert.equal(__test__.isDiscordTokenExpired({ code: '50027' }), true);
});

test('isDiscordTokenExpired: HTTP status 401 and 404', () => {
  assert.equal(__test__.isDiscordTokenExpired({ status: 401 }), true);
  assert.equal(__test__.isDiscordTokenExpired({ status: 404 }), true);
  // Some versions of @discordjs/rest expose httpStatus instead.
  assert.equal(__test__.isDiscordTokenExpired({ httpStatus: 401 }), true);
  assert.equal(__test__.isDiscordTokenExpired({ httpStatus: 404 }), true);
});

test('isDiscordTokenExpired: known message texts', () => {
  // These are the substrings Discord's REST returns at minute 15+.
  // Match must be case-insensitive — the detector lowercases first.
  assert.equal(__test__.isDiscordTokenExpired({ message: 'Invalid Webhook Token' }), true);
  assert.equal(__test__.isDiscordTokenExpired({ message: 'invalid webhook token' }), true);
  assert.equal(__test__.isDiscordTokenExpired({ message: 'Unknown Webhook' }), true);
  assert.equal(__test__.isDiscordTokenExpired({ message: 'Interaction has expired' }), true);
  assert.equal(__test__.isDiscordTokenExpired({ message: 'interaction expired' }), true);
});

test('isDiscordTokenExpired: unrelated errors are NOT misclassified', () => {
  // Rate limit, network blip, and generic errors must NOT trigger the
  // fallback — otherwise every transient blip becomes a "fresh message
  // in channel" instead of a retry on the existing handle.
  assert.equal(__test__.isDiscordTokenExpired({ code: 429 }), false);
  assert.equal(__test__.isDiscordTokenExpired({ status: 500 }), false);
  assert.equal(__test__.isDiscordTokenExpired({ message: 'rate limit hit, retrying' }), false);
  assert.equal(__test__.isDiscordTokenExpired(new Error('socket disconnected')), false);
  assert.equal(__test__.isDiscordTokenExpired(null), false);
  assert.equal(__test__.isDiscordTokenExpired(undefined), false);
  assert.equal(__test__.isDiscordTokenExpired('plain string error'), false);
});

// ── Discord rendering: final reply is plain text, not a broken blockquote ──
test('renderFullBody: multi-line reply is plain text (no `> ` blockquote)', () => {
  const state = { ...freshState(), done: true, summary: 'Line one\nLine two\nLine three' };
  const body = __test__.renderFullBody(state);
  assert.ok(!body.startsWith('> '), 'reply must not be blockquoted');
  assert.ok(!body.includes('\n> '), 'no interior blockquote markers either');
  assert.ok(body.includes('Line two') && body.includes('Line three'), 'all lines survive');
});

test('renderFullBody: adapts a GFM table in the final reply', () => {
  const summary = 'Results:\n\n| A | B |\n| --- | --- |\n| 1 | 22 |';
  const state = { ...freshState(), done: true, summary };
  const body = __test__.renderFullBody(state);
  assert.match(body, /```/, 'table wrapped in a code block');
  assert.ok(!/\| --- \|/.test(body), 'no raw GFM separator row');
});

// ── Discord rendering: streamed reply is visible while the turn runs ──
test('renderBody: while streaming, shows a tail of the reply below the status line', () => {
  const state = { ...freshState(), done: false, status: 'drafting', summary: 'The answer is forming nicely.' };
  const body = __test__.renderBody(state);
  assert.match(body, /drafting/, 'status line still present');
  assert.match(body, /The answer is forming nicely\./, 'streamed reply is shown');
});

test('createDiscordBridgeChunkStreamer: extracts structured harness JSON instead of flashing raw braces', () => {
  let out = '';
  const feed = __test__.createDiscordBridgeChunkStreamer((delta: string) => { out += delta; });
  for (const chunk of '{"summary":"internal","reply":"Clean Discord reply.","done":true}'.split('')) feed(chunk);
  assert.equal(out, 'Clean Discord reply.');
  assert.ok(!out.includes('{"summary"'), 'raw structured envelope never reaches Discord');
});

test('createDiscordBridgeChunkStreamer: passes Claude SDK plain prose through', () => {
  let out = '';
  const feed = __test__.createDiscordBridgeChunkStreamer((delta: string) => { out += delta; });
  feed('Doing ');
  feed('the lookup now.');
  assert.equal(out, 'Doing the lookup now.');
});

test('renderBody: long streaming reply is tail-clipped with a leading ellipsis', () => {
  const long = 'x'.repeat(50) + ' ' + 'END-OF-REPLY-MARKER '.repeat(200);
  const state = { ...freshState(), done: false, status: 'working', summary: long };
  const body = __test__.renderBody(state);
  assert.ok(body.length <= 1_900, 'body stays under the Discord per-message cap');
  assert.match(body, /…/, 'leading ellipsis marks the clipped head');
  assert.match(body, /END-OF-REPLY-MARKER/, 'the most recent text is what survives');
});

test('renderBody: done state is unchanged — just the summary, no status line', () => {
  const state = { ...freshState(), done: true, summary: 'final answer' };
  assert.equal(__test__.renderBody(state), 'final answer');
});

// ── toDiscordMarkdown: adapt GFM to the subset Discord renders ──
test('toDiscordMarkdown: pipe table → aligned code block', () => {
  const md = '| Col | Score |\n| --- | --- |\n| Acme | 12 |\n| Beta | 340 |';
  const out = toDiscordMarkdown(md);
  assert.ok(out.startsWith('```') && out.trimEnd().endsWith('```'), 'wrapped in a fenced code block');
  assert.ok(!out.includes('| --- |'), 'GFM separator row removed');
  // "Col" (3) pads to col width 4, plus the 2-space gutter ⇒ 3 spaces.
  assert.match(out, /Col {3}Score/, 'header padded to the widest cell');
  assert.match(out, /Beta {2}340/, 'rows aligned');
});

test('toDiscordMarkdown: table without outer pipes still converts', () => {
  const md = 'A | B\n--- | ---\n1 | 2';
  const out = toDiscordMarkdown(md);
  assert.match(out, /```/);
  assert.ok(!out.includes('--- | ---'));
});

test('toDiscordMarkdown: #### and deeper headers demote to bold; #/##/### kept', () => {
  assert.equal(toDiscordMarkdown('#### Deep'), '**Deep**');
  assert.equal(toDiscordMarkdown('##### Deeper'), '**Deeper**');
  assert.equal(toDiscordMarkdown('### Kept'), '### Kept');
});

test('toDiscordMarkdown: horizontal rules are stripped', () => {
  // The rule line plus its surrounding blank lines collapse cleanly.
  assert.equal(toDiscordMarkdown('above\n\n---\n\nbelow'), 'above\n\nbelow');
  assert.equal(toDiscordMarkdown('***'), '');
});

test('toDiscordMarkdown: plain prose and empty input pass through untouched', () => {
  assert.equal(toDiscordMarkdown('just a normal **bold** line with a [link](https://x)'),
    'just a normal **bold** line with a [link](https://x)');
  assert.equal(toDiscordMarkdown(''), '');
});
