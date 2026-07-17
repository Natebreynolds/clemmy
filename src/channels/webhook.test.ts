import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from './webhook.js';
import type { EventRow, RunAttemptRecord, SessionRow } from '../runtime/harness/eventlog.js';

test('workflow run file fallback preserves needsAttention in activity enrichment', () => {
  const activityRun = __test__.workflowRunRecordAsActivityRun({
    id: 'wf-run-attention',
    workflow: 'daily_digest',
    status: 'completed',
    needsAttention: true,
    createdAt: '2026-06-24T09:00:00.000Z',
    finishedAt: '2026-06-24T09:02:00.000Z',
    output: 'Delivered the report, but the pinned goal was not confirmed.',
  });

  const enriched = __test__.enrichActivityRun(activityRun);

  assert.equal(activityRun.needsAttention, true);
  assert.equal(enriched.status, 'completed');
  assert.equal(enriched.runState, 'needs_attention');
  assert.equal(enriched.statusLabel, 'Needs attention');
  assert.equal(enriched.needsAttention, true);
  assert.equal(enriched.live, false);
  assert.equal(enriched.preview, 'Delivered the report, but the pinned goal was not confirmed.');
});

test('completionOutputPreview prefers reply over internal summary', () => {
  assert.equal(
    __test__.completionOutputPreview({
      data: { summary: 'Internal log: greeted user; awaiting request.', reply: 'Hey - what can I help with?' },
    }),
    'Hey - what can I help with?',
  );
});

test('completionOutputPreview falls back to summary for legacy completions', () => {
  assert.equal(
    __test__.completionOutputPreview({ data: { summary: 'Legacy public completion.' } }),
    'Legacy public completion.',
  );
});

test('message response serializer preserves route and stop diagnostics', () => {
  assert.deepEqual(
    __test__.serializeMessageResponse({
      text: 'hello',
      sessionId: 'sess-webhook-route',
      runId: 'run-webhook-route',
      stoppedReason: 'max-turns-with-grace',
      turnsUsed: 12,
      route: {
        routeKind: 'harness',
        surface: 'webhook',
        effectiveModel: 'glm-4.5',
        falloverFrom: 'claude_agent_sdk_brain',
      },
    }),
    {
      response: 'hello',
      session_id: 'sess-webhook-route',
      run_id: 'run-webhook-route',
      queued_task_id: undefined,
      pending_approval_id: undefined,
      stopped_reason: 'max-turns-with-grace',
      turns_used: 12,
      route: {
        routeKind: 'harness',
        surface: 'webhook',
        effectiveModel: 'glm-4.5',
        falloverFrom: 'claude_agent_sdk_brain',
      },
    },
  );
});

test('/api/message session resolver accepts snake_case and camelCase ids', () => {
  assert.deepEqual(
    __test__.resolveApiMessageSession({ session_id: 'sess-snake', sessionId: 'sess-camel', user_id: 'user-snake' }),
    { sessionId: 'sess-snake', userId: 'user-snake' },
  );
  assert.deepEqual(
    __test__.resolveApiMessageSession({ sessionId: 'sess-camel', userId: 'user-camel' }),
    { sessionId: 'sess-camel', userId: 'user-camel' },
  );
  assert.deepEqual(
    __test__.resolveApiMessageSession({ userId: 'user-camel' }),
    { sessionId: 'webhook:user-camel', userId: 'user-camel' },
  );
});

test('dashboard session cookie survives daemon restart without exposing the webhook secret', () => {
  const secret = 'desktop-webhook-secret-for-restart-proof';
  const firstBoot = __test__.deriveDashboardSessionToken(secret);
  const secondBoot = __test__.deriveDashboardSessionToken(secret);
  const rotatedSecretBoot = __test__.deriveDashboardSessionToken(`${secret}-rotated`);

  assert.equal(secondBoot, firstBoot, 'same installation secret preserves the cookie across process restarts');
  assert.notEqual(rotatedSecretBoot, firstBoot, 'rotating the webhook secret invalidates the prior cookie');
  assert.notEqual(firstBoot, secret, 'the bearer secret itself is never stored in the cookie');
  assert.match(firstBoot, /^[A-Za-z0-9_-]{43}$/);
});

test('harness status uses the latest scoped lifecycle in chronological events', () => {
  const session = {
    status: 'active',
    updatedAt: new Date().toISOString(),
  } as SessionRow;
  const event = (type: EventRow['type'], data: Record<string, unknown> = {}): EventRow => ({
    seq: 1,
    id: `${type}-event`,
    sessionId: 'sess-current',
    turn: 1,
    role: 'system',
    type,
    parentEventId: null,
    data,
    createdAt: new Date().toISOString(),
  });

  assert.equal(__test__.effectiveHarnessStatus(session, [
    event('approval_requested'),
    event('conversation_completed', { reply: 'Done.' }),
  ]), 'completed', 'completion after approval wins');
  assert.equal(__test__.effectiveHarnessStatus(session, [event('turn_started')], {
    sessionId: 'sess-current',
    attemptId: 'attempt-current',
    runId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'active',
    leaseOwner: null,
    leaseExpiresAt: null,
  } as RunAttemptRecord), 'running', 'a fresh attempt does not inherit an old completion');
  assert.equal(__test__.effectiveHarnessStatus(session, [
    event('conversation_completed', { reason: 'cancelled_by_user', summary: 'Stopped.' }),
  ]), 'cancelled', 'cancelled completion is never labelled Done');
  assert.equal(__test__.effectiveHarnessStatus(session, [
    event('approval_requested'),
    event('approval_resolved', { decision: 'approved' }),
  ], {
    sessionId: 'sess-current', attemptId: 'attempt-current', runId: null,
    startedAt: new Date().toISOString(), finishedAt: null, status: 'active',
    leaseOwner: null, leaseExpiresAt: null,
  }), 'running', 'an approval resolution clears the older waiting state');
  assert.equal(__test__.effectiveHarnessStatus(session, [
    event('approval_requested'),
    event('approval_resolved', { decision: 'rejected' }),
  ]), 'cancelled', 'a rejected approval is a stopped run, not a pending one');
});

test('a post-completion user input starts a latest-turn projection instead of inheriting the old attempt', () => {
  const attempt = {
    sessionId: 'sess-reused',
    attemptId: 'attempt-a',
    runId: 'run-a',
    startedAt: '2026-07-16T12:00:00.000Z',
    finishedAt: '2026-07-16T12:01:00.000Z',
    status: 'completed',
    leaseOwner: null,
    leaseExpiresAt: null,
  } as RunAttemptRecord;
  const event = (createdAt: string, data: Record<string, unknown>): EventRow => ({
    seq: 9,
    id: 'input-b',
    sessionId: 'sess-reused',
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    parentEventId: null,
    data,
    createdAt,
  });

  assert.equal(__test__.latestInputStartsNewTurn(
    event('2026-07-16T12:02:00.000Z', { text: 'new request' }),
    attempt,
  ), true);
  assert.equal(__test__.latestInputStartsNewTurn(
    event('2026-07-16T12:00:30.000Z', { text: 'request A', attemptId: 'attempt-a' }),
    attempt,
  ), false);
  assert.equal(__test__.latestInputStartsNewTurn(
    event('2026-07-16T12:00:30.000Z', { text: 'request B', attemptId: 'attempt-b' }),
    attempt,
  ), true);
});

test('artifact projection follows the durable root while keeping the attempt scope distinct', () => {
  assert.equal(__test__.chooseArtifactProjectionScope(
    'sess::brain:attempt-b',
    'sess::brain:attempt-a',
    undefined,
  ), 'sess::brain:attempt-a');
  assert.equal(__test__.chooseArtifactProjectionScope(
    'sess::brain:attempt-b',
    null,
    'sess::brain:attempt-a',
  ), 'sess::brain:attempt-a');
  assert.equal(__test__.chooseArtifactProjectionScope(
    'sess::brain:attempt-b',
    null,
    undefined,
  ), 'sess::brain:attempt-b');
});

test('tool projection counts the full canonical scope without MCP mirror inflation', () => {
  const events = Array.from({ length: 135 }, (_, index) => ([
    {
      id: `top-${index}`,
      type: 'tool_called',
      data: { canonicalCallId: `call-${index}`, tool: index < 100 ? 'search' : 'create_doc' },
    },
    {
      id: `mirror-${index}`,
      type: 'tool_called',
      data: { canonicalCallId: `call-${index}`, tool: 'mcp transport', accounting: 'transport_mirror' },
    },
  ])).flat();
  // Replayed top-level telemetry with the same canonical id stays one logical
  // call while recordedCalls remains an honest audit-event count.
  events.push({ id: 'top-replay', type: 'tool_called', data: { canonicalCallId: 'call-0', tool: 'search' } });

  const summary = __test__.projectScopedToolSummary(events);
  assert.equal(summary.logicalCount, 135);
  assert.equal(summary.recordedCalls, 136);
  assert.equal(summary.mirrorEvents, 135);
  assert.deepEqual(summary.countsByName, { search: 100, create_doc: 35 });
});

test('environment state uses one sanitized canonical tool milestone without returning tool payloads', () => {
  const milestone = __test__.latestCanonicalToolMilestone([
    {
      id: 'top-level',
      type: 'tool_called',
      createdAt: '2026-07-16T12:00:02.000Z',
      data: {
        tool: 'composio_execute_tool',
        slug: 'GOOGLEDOCS_CREATE_DOCUMENT',
        canonicalCallId: 'call-1',
        args: { body: 'x'.repeat(8_000) },
      },
    },
    {
      id: 'transport-mirror',
      type: 'tool_called',
      createdAt: '2026-07-16T12:00:03.000Z',
      data: { tool: 'mcp transport', accounting: 'transport_mirror', canonicalCallId: 'call-1' },
    },
  ]);

  assert.deepEqual(milestone, {
    id: 'top-level',
    type: 'tool_called',
    createdAt: '2026-07-16T12:00:02.000Z',
    data: { tool: 'GOOGLEDOCS_CREATE_DOCUMENT', accounting: 'top_level' },
  });

  const structural = [{
    type: 'plan_drafted',
    createdAt: '2026-07-16T12:00:01.000Z',
    data: { objective: 'Create the document' },
  }];
  const detail = __test__.enrichProjectedActivityRunDetail({
    id: 'sess-environment-working',
    status: 'running',
    updatedAt: new Date().toISOString(),
    events: structural,
  }, [...structural, milestone!]);
  assert.equal(detail.runState, 'executing');
  assert.equal(detail.liveLine, 'Using GOOGLEDOCS_CREATE_DOCUMENT…');
  assert.deepEqual(detail.events, structural, 'raw tool args stay outside the compact response projection');
});

test('desktop background control is hidden for external chat origins until report-back attribution is preserved', () => {
  const session = (input: Partial<SessionRow>): SessionRow => ({
    id: 'session',
    kind: 'chat',
    channel: 'desktop',
    userId: null,
    createdAt: '2026-07-16T12:00:00.000Z',
    updatedAt: '2026-07-16T12:00:00.000Z',
    status: 'active',
    title: null,
    objective: null,
    tokenBudget: null,
    tokensUsed: 0,
    currentPlanId: null,
    metadata: {},
    ...input,
  });

  assert.equal(__test__.supportsDesktopBackgroundHandoff(session({ id: 'desktop-session' })), true);
  assert.equal(__test__.supportsDesktopBackgroundHandoff(session({
    id: 'discord:channel:user', channel: 'discord', metadata: { source: 'discord' },
  })), false);
  assert.equal(__test__.supportsDesktopBackgroundHandoff(session({
    id: 'slack:channel:user', channel: 'slack', metadata: { source: 'slack' },
  })), false);
  assert.equal(__test__.supportsDesktopBackgroundHandoff(session({ id: 'background:bg-1' })), false);
});

test('run list summaries never include raw event arrays', () => {
  const compact = __test__.compactActivityRunListRow({
    id: 'sess-compact',
    title: 'Compact me',
    status: 'running',
    canCancel: true,
    cancelEndpoint: '/api/console/harness-sessions/sess-compact/cancel',
    events: [{ type: 'tool_called', data: { tool: 'Search', large: 'x'.repeat(8_000) } }],
  } as Parameters<typeof __test__.compactActivityRunListRow>[0] & { canCancel: boolean; cancelEndpoint: string });
  assert.equal('events' in compact, false);
  assert.equal(compact.liveLine, 'Using Search…');
  assert.equal(compact.canCancel, true);
  assert.equal(compact.cancelEndpoint, '/api/console/harness-sessions/sess-compact/cancel');
});

test('harness controls are bound to the exact active attempt and durable run scope', () => {
  const attempt = {
    sessionId: 'discord:channel:user',
    attemptId: 'attempt:desktop:abc',
    runId: 'desktop:abc',
    startedAt: '2026-07-16T12:00:00.000Z',
    finishedAt: null,
    status: 'active',
    leaseOwner: null,
    leaseExpiresAt: null,
  } as RunAttemptRecord;
  const scope = {
    attempt,
    attemptId: attempt.attemptId,
    query: {},
    runScopeId: 'discord:channel:user::brain:desktop:abc',
    scopeKind: 'current_attempt' as const,
    scopeStartedAt: attempt.startedAt,
  };
  assert.deepEqual(__test__.harnessRunControlProjection(
    'discord:channel:user',
    scope,
    'running',
    true,
  ), {
    canCancel: true,
    cancelEndpoint: '/api/console/harness-sessions/discord%3Achannel%3Auser/cancel?attemptId=attempt%3Adesktop%3Aabc&runScopeId=discord%3Achannel%3Auser%3A%3Abrain%3Adesktop%3Aabc',
    canBackground: true,
    backgroundEndpoint: '/api/console/harness-sessions/discord%3Achannel%3Auser/background?attemptId=attempt%3Adesktop%3Aabc&runScopeId=discord%3Achannel%3Auser%3A%3Abrain%3Adesktop%3Aabc',
  });
  assert.deepEqual(__test__.harnessRunControlProjection(
    'discord:channel:user',
    scope,
    'awaiting_approval',
    true,
  ), {
    canCancel: true,
    cancelEndpoint: '/api/console/harness-sessions/discord%3Achannel%3Auser/cancel?attemptId=attempt%3Adesktop%3Aabc&runScopeId=discord%3Achannel%3Auser%3A%3Abrain%3Adesktop%3Aabc',
    canBackground: false,
  });
  assert.deepEqual(__test__.harnessRunControlProjection(
    'discord:channel:user',
    { ...scope, attempt: { ...attempt, status: 'completed', finishedAt: '2026-07-16T12:01:00.000Z' } },
    'completed',
    true,
  ), { canCancel: false, canBackground: false });
});

test('JSON run cancellation contract preserves missing-run failure status', () => {
  const result = __test__.cancelTrackedRun('run-definitely-missing-webhook-test');
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 404);
  assert.match(result.message, /Run not found/);
});
