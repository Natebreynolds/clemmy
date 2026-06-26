/**
 * Run: npx tsx --test src/runtime/activity-format.test.ts
 *
 * Contract: the formatter translates raw runs/events into user-facing language
 * deterministically. Noise event types stay out of the clean timeline; kind /
 * status / category mappings are stable; liveLine reflects the current action.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventVisibility,
  friendlyEventMessage,
  friendlyKindLabel,
  friendlyStatusLabel,
  friendlyTimeline,
  isLive,
  liveLine,
  runFilterCategory,
  runPreview,
  userFacingRunState,
  userFacingRunStateIsLive,
  userFacingRunStateLabel,
  type ActivityRunLike,
} from './activity-format.js';

test('eventVisibility hides internal noise and keeps milestones', () => {
  for (const noise of [
    'turn_started', 'turn_ended', 'heartbeat', 'condenser_applied',
    'native_compaction_applied', 'mcp_tool_scope', 'agent_context_packet',
    'memory_signals_captured', 'turn_memory_primer', 'budget_elevated',
    'cross_session_prefix', 'guardrail_tripped', 'some_future_type',
  ]) {
    assert.equal(eventVisibility(noise), 'noise', `${noise} should be noise`);
  }
  for (const milestone of [
    'tool_called', 'approval_requested', 'step_started', 'step_failed',
    'run_completed', 'run_failed', 'conversation_completed', 'received',
  ]) {
    assert.equal(eventVisibility(milestone), 'milestone', `${milestone} should be a milestone`);
  }
  assert.equal(eventVisibility(undefined), 'noise');
});

test('friendlyEventMessage produces plain language', () => {
  assert.equal(friendlyEventMessage({ type: 'tool_called', data: { tool: 'Gmail' } }), 'Used Gmail');
  assert.equal(friendlyEventMessage({ type: 'approval_resolved', data: { decision: 'approved' } }), 'Approval approved');
  assert.equal(friendlyEventMessage({ type: 'run_completed' }), 'Completed');
  assert.equal(
    friendlyEventMessage({ type: 'conversation_completed', data: { summary: 'Sent the report.' } }),
    'Sent the report.',
  );
  assert.equal(
    friendlyEventMessage({
      type: 'conversation_completed',
      data: { summary: 'Internal log: sent report.', reply: 'Sent the report to Maya.' },
    }),
    'Sent the report to Maya.',
  );
  // Unknown type falls back to a humanized label, never the raw machine name.
  assert.equal(friendlyEventMessage({ type: 'turn_started' }), 'Turn started');
});

test('friendlyKindLabel maps source/kind to product language', () => {
  assert.equal(friendlyKindLabel({ kind: 'chat', source: 'daemon' }), 'Chat');
  assert.equal(friendlyKindLabel({ kind: 'workflow', channel: 'workflow' }), 'Workflow');
  assert.equal(friendlyKindLabel({ source: 'discord' }), 'Discord');
  assert.equal(friendlyKindLabel({ channel: 'discord-dm' }), 'Discord');
  assert.equal(friendlyKindLabel({ queuedTaskId: 'bg-1' }), 'Background task');
  assert.equal(friendlyKindLabel({ metadata: { source: 'cron' } }), 'Scheduled');
});

test('runFilterCategory buckets for the filter chips', () => {
  assert.equal(runFilterCategory({ kind: 'chat' }), 'chat');
  assert.equal(runFilterCategory({ source: 'discord' }), 'chat');
  assert.equal(runFilterCategory({ kind: 'workflow' }), 'workflow');
  assert.equal(runFilterCategory({ metadata: { source: 'cron' } }), 'scheduled');
  assert.equal(runFilterCategory({ kind: 'agent' }), 'background');
  assert.equal(runFilterCategory({ queuedTaskId: 'bg-1' }), 'background');
  // Background-task runs as actually created (channel + session-id + run-id),
  // none of which set queuedTaskId/kind — these regressed to 'chat' before.
  assert.equal(runFilterCategory({ channel: 'background', source: 'gateway' }), 'background');
  assert.equal(runFilterCategory({ sessionId: 'background:abc', source: 'daemon' }), 'background');
  assert.equal(runFilterCategory({ id: 'run-bg-xyz', source: 'daemon' }), 'background');
  // Cron via the `cron:` session prefix (not just channel).
  assert.equal(runFilterCategory({ sessionId: 'cron:nightly' }), 'scheduled');
  // Autonomy agent work is background to the user, not a chat.
  assert.equal(runFilterCategory({ channel: 'agent', source: 'daemon' }), 'background');
});

test('friendlyStatusLabel and isLive agree on live states', () => {
  assert.equal(friendlyStatusLabel('running'), 'Running…');
  assert.equal(friendlyStatusLabel('awaiting_approval'), 'Waiting for your approval');
  assert.equal(friendlyStatusLabel('parked'), 'Waiting for your approval');
  assert.equal(friendlyStatusLabel('completed'), 'Done');
  assert.equal(isLive('running'), true);
  assert.equal(isLive('awaiting_approval'), true);
  assert.equal(isLive('parked'), true);
  assert.equal(isLive('idle'), false); // active-but-stale chat must not pin to "Now"
  assert.equal(isLive('completed'), false);
});

test('liveLine reflects the current action', () => {
  const running: ActivityRunLike = {
    status: 'running',
    events: [
      { type: 'turn_started' },
      { type: 'tool_called', data: { tool: 'Calendar' } },
    ],
  };
  assert.equal(liveLine(running), 'Using Calendar…');

  const stepping: ActivityRunLike = {
    status: 'running',
    events: [
      { type: 'step_started', stepId: 'fetch' },
      { type: 'step_verified', stepId: 'fetch' },
      { type: 'step_started', stepId: 'summarize' },
    ],
  };
  assert.equal(liveLine(stepping), 'Working on step 2…');

  assert.equal(liveLine({ status: 'awaiting_approval', events: [] }), 'Waiting for your approval');
  assert.equal(liveLine({ status: 'parked', events: [] }), 'Waiting for your approval');
  assert.equal(liveLine({ status: 'completed', events: [] }), ''); // not live → empty
});

test('runPreview is an email-like snippet', () => {
  assert.equal(
    runPreview({ status: 'running', events: [{ type: 'tool_called', data: { tool: 'Slack' } }] }),
    'Using Slack…',
  );
  assert.equal(runPreview({ status: 'completed', outputPreview: 'All 3 emails sent.' }), 'All 3 emails sent.');
  assert.equal(runPreview({ status: 'failed', error: 'Network timeout' }), 'Network timeout');
});

test('userFacingRunState distinguishes planning, execution, waiting, and stale work', () => {
  const now = Date.parse('2026-05-29T10:30:00Z');

  assert.equal(userFacingRunState({
    status: 'running',
    updatedAt: '2026-05-29T10:29:00Z',
    events: [{ type: 'plan_drafted', createdAt: '2026-05-29T10:29:00Z' }],
  }, now), 'planning');

  assert.equal(userFacingRunState({
    status: 'running',
    updatedAt: '2026-05-29T10:29:30Z',
    events: [{ type: 'tool_called', data: { tool: 'memory_search' }, createdAt: '2026-05-29T10:29:30Z' }],
  }, now), 'executing');

  assert.equal(userFacingRunState({
    status: 'running',
    updatedAt: '2026-05-29T10:29:30Z',
    events: [{ type: 'awaiting_user_input', createdAt: '2026-05-29T10:29:30Z' }],
  }, now), 'waiting_for_input');

  assert.equal(userFacingRunState({
    status: 'parked',
    updatedAt: '2026-05-29T10:29:30Z',
    events: [{ type: 'approval_required', createdAt: '2026-05-29T10:29:30Z' }],
  }, now), 'waiting_for_approval');

  assert.equal(userFacingRunState({
    status: 'running',
    updatedAt: '2026-05-29T10:00:00Z',
    events: [{ type: 'tool_called', data: { tool: 'Outlook' }, createdAt: '2026-05-29T10:00:00Z' }],
  }, now), 'stalled');

  assert.equal(userFacingRunStateLabel('stalled'), 'Needs attention');
  assert.equal(userFacingRunStateLabel('needs_attention'), 'Needs attention');
  assert.equal(userFacingRunStateIsLive('executing'), true);
  assert.equal(userFacingRunStateIsLive('stalled'), false);
  assert.equal(runPreview({
    status: 'running',
    updatedAt: '2020-01-01T10:00:00Z',
    events: [{ type: 'tool_called', data: { tool: 'Outlook' }, createdAt: '2020-01-01T10:00:00Z' }],
  }), 'No recent progress — needs attention');
});

test('completed runs flagged needsAttention render as attention, not done', () => {
  const run: ActivityRunLike = {
    status: 'completed',
    needsAttention: true,
    outputPreview: 'Delivered the report, but the target was not confirmed.',
    events: [{ type: 'completed' }],
  };
  assert.equal(userFacingRunState(run), 'needs_attention');
  assert.equal(userFacingRunStateLabel(userFacingRunState(run)), 'Needs attention');
  assert.equal(userFacingRunStateIsLive(userFacingRunState(run)), false);
  assert.equal(runPreview(run), 'Delivered the report, but the target was not confirmed.');
});

test('liveLine + timeline are order-agnostic (harness events arrive newest-first)', () => {
  // Descending (newest-first), as harness sessions are fetched.
  const desc: ActivityRunLike = {
    status: 'running',
    updatedAt: '2999-05-29T10:00:03Z',
    events: [
      { type: 'tool_called', data: { tool: 'Slack' }, createdAt: '2999-05-29T10:00:03Z' },
      { type: 'tool_called', data: { tool: 'Gmail' }, createdAt: '2999-05-29T10:00:02Z' },
      { type: 'received', createdAt: '2999-05-29T10:00:01Z' },
    ],
  };
  // Newest milestone is the Slack call — must not pick the older Gmail one.
  assert.equal(liveLine(desc), 'Using Slack…');
  // Timeline must render oldest-first regardless of input order.
  assert.deepEqual(
    friendlyTimeline(desc.events).map((e) => e.message),
    ['Received your request', 'Used Gmail', 'Used Slack'],
  );
});

test('friendlyTimeline drops noise events', () => {
  const timeline = friendlyTimeline([
    { type: 'turn_started' },
    { type: 'tool_called', data: { tool: 'Gmail' } },
    { type: 'heartbeat' },
    { type: 'run_completed' },
  ]);
  assert.deepEqual(timeline.map((entry) => entry.message), ['Used Gmail', 'Completed']);
});
