/**
 * Run: npx tsx --test src/dashboard/sessions-api.test.ts
 *
 * Contracts the unified Conversations API must keep:
 *   - merges desktop (sessions.json) + harness (harness.db) sessions
 *   - collapses per-step workflow sessions to one row per run
 *   - chat sessions are continuable; workflow/agent runs are read-only
 *   - pinned-first ordering; q / tag / includeArchived filters
 *   - detail returns turns + a correct continueHint per store
 *   - patch dispatches to the right store; delete = hard (desktop) / archive (harness)
 *
 * Isolated via per-test CLEMENTINE_HOME.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-sessions-api-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildUnifiedSessionList,
  getUnifiedSessionDetail,
  patchUnifiedSession,
  deleteUnifiedSession,
} = await import('./sessions-api.js');
const { SessionStore } = await import('../memory/session-store.js');
const {
  createSession,
  appendEvent,
  beginRunAttempt,
  getSession,
  openEventLog,
  reapStaleSessions,
  recordRunAttemptUserInput,
  updateSession,
} = await import('../runtime/harness/eventlog.js');
const { claimSessionForAcceptedSource } = await import('../runtime/harness/accepted-source-session-branch.js');
const { ClementineGateway } = await import('../gateway/router.js');
const { PUBLIC_RUN_FAILURE_TEXT } = await import('../runtime/harness/public-presentation.js');
const {
  surfacePlan,
  surfaceAskingPlan,
  rejectPlanProposal,
} = await import('../agents/plan-proposals.js');

const turn = (role: 'user' | 'assistant', text: string) => ({ role, text, createdAt: new Date().toISOString() });

function exactPlan(overrides: Record<string, unknown> = {}) {
  return {
    objective: 'Prepare the exact release-readiness brief.',
    steps: [
      { n: 1, action: 'Collect the release evidence.', rationale: 'Ground the review.', verification: null },
      { n: 2, action: 'Write the final brief.', rationale: 'Deliver the result.', verification: null },
    ],
    successCriteria: ['The brief names every release gate.'],
    risks: [],
    estimatedComplexity: 'moderate' as const,
    recommendsTrackedExecution: false,
    needsUserInput: [],
    appliedInstructions: [],
    ...overrides,
  };
}

// ── Seed both stores ──────────────────────────────────────────────────────
const store = new SessionStore();
// Desktop chat.
store.appendTurn('chat-desktop', turn('user', 'Help me plan the SEO audit'));
store.appendTurn('chat-desktop', turn('assistant', 'Sure, here is a plan.'));

// Harness Discord chat (continuable).
const discord = createSession({ kind: 'chat', channel: 'discord', title: 'Discord thread', metadata: { source: 'discord' } });
appendEvent({ sessionId: discord.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'hi from discord' } });
appendEvent({ sessionId: discord.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'hello!' } });

// Workflow run with two step-sessions sharing a runId → collapses to one row.
const workflowStep1 = createSession({ kind: 'workflow', channel: 'workflow', title: 'My Flow::step-1', metadata: { source: 'workflow', workflowName: 'My Flow', workflowRunId: 'run-xyz', stepId: 'step-1' } });
appendEvent({ sessionId: workflowStep1.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'step one gathered source notes' } });
const workflowStep2 = createSession({ kind: 'workflow', channel: 'workflow', title: 'My Flow::step-2', metadata: { source: 'workflow', workflowName: 'My Flow', workflowRunId: 'run-xyz', stepId: 'step-2' } });
appendEvent({ sessionId: workflowStep2.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'step two produced final brief' } });

test('list merges both stores and collapses workflow steps', () => {
  const sessions = buildUnifiedSessionList();
  const byOrigin = (o: string) => sessions.filter((s) => s.origin === o);
  assert.equal(byOrigin('desktop').length, 1, 'one desktop chat');
  assert.equal(byOrigin('discord').length, 1, 'one discord chat');
  assert.equal(byOrigin('workflow').length, 1, 'two workflow steps collapse to one run');

  const desktop = byOrigin('desktop')[0];
  assert.equal(desktop.continuable, true);
  // Auto-title strips the polite "Help me " preamble (deriveTitle).
  assert.equal(desktop.title, 'plan the SEO audit');
  assert.ok(desktop.id.startsWith('desktop:'));

  const workflow = byOrigin('workflow')[0];
  assert.equal(workflow.continuable, false, 'workflow runs are read-only');
  assert.equal(workflow.title, 'My Flow', 'titled by workflow name, not step');
  assert.equal(workflow.preview, 'step two produced final brief');
  assert.equal(workflow.turnCount, 2);
});

test('pinned sessions sort first', () => {
  patchUnifiedSession(`desktop:chat-desktop`, { pinned: true });
  const sessions = buildUnifiedSessionList();
  assert.equal(sessions[0].origin, 'desktop', 'pinned desktop chat is first');
  assert.equal(sessions[0].pinned, true);
  // Reset for later tests.
  patchUnifiedSession(`desktop:chat-desktop`, { pinned: false });
});

test('q filter matches title plus desktop and harness transcripts; source filter narrows', () => {
  assert.equal(buildUnifiedSessionList({ q: 'SEO audit' }).length, 1);
  assert.equal(buildUnifiedSessionList({ q: 'discord' }).length, 1);
  assert.equal(buildUnifiedSessionList({ q: 'hi from discord' })[0]?.id, `harness:${discord.id}`);
  assert.equal(buildUnifiedSessionList({ q: 'source notes' })[0]?.origin, 'workflow');
  assert.equal(buildUnifiedSessionList({ source: 'workflow' }).length, 1);
  assert.equal(buildUnifiedSessionList({ source: 'discord' })[0].origin, 'discord');
});

test('archived sessions hidden by default, shown with includeArchived', () => {
  patchUnifiedSession(`desktop:chat-desktop`, { archived: true });
  assert.equal(buildUnifiedSessionList().some((s) => s.origin === 'desktop'), false);
  assert.equal(buildUnifiedSessionList({ includeArchived: true }).some((s) => s.origin === 'desktop'), true);
  patchUnifiedSession(`desktop:chat-desktop`, { archived: false });
});

test('detail returns turns and the right continueHint per store', () => {
  const desktop = getUnifiedSessionDetail('desktop:chat-desktop');
  assert.ok(desktop);
  assert.equal(desktop!.turns.length, 2);
  assert.equal(desktop!.continueHint?.protocol, 'ndjson');
  assert.equal(desktop!.continueHint?.endpoint, '/api/console/home/chat/stream');

  const dc = getUnifiedSessionDetail(`harness:${discord.id}`);
  assert.ok(dc);
  assert.deepEqual(dc!.turns.map((t) => t.text), ['hi from discord', 'hello!']);
  assert.equal(dc!.continueHint?.protocol, 'sse');
  assert.equal(dc!.continueHint?.streamUrl, `/api/sessions/${discord.id}/events`);

  // Workflow detail is read-only (no continueHint).
  const wf = buildUnifiedSessionList({ source: 'workflow' })[0];
  const wfDetail = getUnifiedSessionDetail(wf.id);
  assert.ok(wfDetail);
  assert.deepEqual(wfDetail!.turns.map((t) => t.text), ['step one gathered source notes', 'step two produced final brief']);
  assert.equal(wfDetail!.continueHint, null);
});

test('detail hides synthetic outcome turns but keeps real user + assistant turns (workflow run)', () => {
  const step = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Report Flow::only',
    metadata: { source: 'workflow', workflowName: 'Report Flow', workflowRunId: 'run-synthetic', stepId: 'only' },
  });
  appendEvent({ sessionId: step.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'kick off the report' } });
  // Synthetic report-back injected by runtime/outcome.ts — must not render as a user bubble.
  appendEvent({
    sessionId: step.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: { text: '[workflow run run-synthetic completed] Report Flow\n\nDone.', synthetic: true, source: 'outcome' },
  });
  appendEvent({ sessionId: step.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Report is ready.' } });

  const detail = getUnifiedSessionDetail(`harness:${step.id}`);
  assert.ok(detail);
  assert.deepEqual(
    detail!.turns.map((t) => `${t.role}:${t.text}`),
    ['user:kick off the report', 'assistant:Report is ready.'],
    'synthetic turn hidden; real user turn + assistant reply render',
  );
});

test('workflow detail, preview, and search all use the public terminal projection', () => {
  const privateSentinel = 'PRIVATE_SEARCH_SENTINEL_93';
  const step = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Projection Flow::only',
    metadata: { source: 'workflow', workflowName: 'Projection Flow', workflowRunId: 'run-public-projection', stepId: 'only' },
  });
  appendEvent({
    sessionId: step.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reply: [
        `summary: ${privateSentinel}`,
        'reply: Public projection answer.',
        'done: true',
        'nextAction: completed',
        'reason: private reducer state',
      ].join('\n'),
      internalSummary: privateSentinel,
    },
  });

  const summary = buildUnifiedSessionList({ source: 'workflow', includeArchived: true, limit: 500 })
    .find((item) => item.title === 'Projection Flow');
  assert.ok(summary);
  assert.equal(summary.preview, 'Public projection answer.');
  assert.deepEqual(
    getUnifiedSessionDetail(summary.id)?.turns.map((item) => item.text),
    ['Public projection answer.'],
  );
  assert.equal(buildUnifiedSessionList({ q: privateSentinel, includeArchived: true, limit: 500 }).length, 0);
  assert.equal(
    buildUnifiedSessionList({ q: 'Public projection answer', includeArchived: true, limit: 500 })
      .some((item) => item.id === summary.id),
    true,
  );
});

test('legacy desktop detail, preview, and search use the same public projection', () => {
  const id = 'desktop-public-projection';
  const privateSentinel = 'PRIVATE_DESKTOP_SEARCH_SENTINEL_41';
  store.appendTurn(id, turn('user', 'show the public result'));
  store.appendTurn(id, turn('assistant', [
    `summary: ${privateSentinel}`,
    'reply: Public desktop answer.',
    'done: true',
    'nextAction: completed',
    'reason: private legacy reducer state',
  ].join('\n')));

  const detail = getUnifiedSessionDetail(`desktop:${id}`);
  assert.ok(detail);
  assert.deepEqual(detail.turns.map((item) => item.text), ['show the public result', 'Public desktop answer.']);
  assert.equal(detail.session.preview, 'Public desktop answer.');
  assert.equal(buildUnifiedSessionList({ q: privateSentinel, includeArchived: true, limit: 500 }).length, 0);
  assert.equal(
    buildUnifiedSessionList({ q: 'Public desktop answer', includeArchived: true, limit: 500 })
      .some((item) => item.id === `desktop:${id}`),
    true,
  );
});

test('detail returns null for unknown / malformed ids', () => {
  assert.equal(getUnifiedSessionDetail('desktop:nope'), null);
  assert.equal(getUnifiedSessionDetail('harness:nope'), null);
  assert.equal(getUnifiedSessionDetail('garbage'), null);
});

test('list prefers the harness session over a same-raw-id desktop report-back ghost', () => {
  const rawId = 'same-raw-reportback';
  createSession({ id: rawId, kind: 'chat', channel: 'desktop', title: 'Original harness chat' });
  appendEvent({ sessionId: rawId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'original harness question' } });
  appendEvent({ sessionId: rawId, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'original harness answer' } });
  store.appendTurn(rawId, turn('user', '[background task bg-ghost completed] synthetic report-back only'));

  const matches = buildUnifiedSessionList({ includeArchived: true, limit: 500 })
    .filter((s) => s.id.endsWith(rawId));
  assert.deepEqual(matches.map((s) => s.id), [`harness:${rawId}`]);

  const detail = getUnifiedSessionDetail(`harness:${rawId}`);
  assert.ok(detail);
  assert.deepEqual(detail!.turns.map((t) => t.text), ['original harness question', 'original harness answer']);

  const staleDetail = getUnifiedSessionDetail(`desktop:${rawId}`);
  assert.ok(staleDetail);
  assert.equal(staleDetail!.session.id, `harness:${rawId}`);
  assert.deepEqual(staleDetail!.turns.map((t) => t.text), ['original harness question', 'original harness answer']);

  const patched = patchUnifiedSession(`desktop:${rawId}`, { pinned: true, tags: ['canonical'] });
  assert.equal(patched?.id, `harness:${rawId}`);
  assert.equal(getSession(rawId)?.metadata.pinned, true);
  assert.deepEqual(getSession(rawId)?.metadata.tags, ['canonical']);
});

test('list still prefers an older harness session when newer harness rows fill the first page', () => {
  const rawId = 'same-raw-behind-harness-page';
  createSession({ id: rawId, kind: 'chat', channel: 'desktop', title: 'Older canonical harness chat' });
  appendEvent({ sessionId: rawId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'older canonical question' } });
  appendEvent({ sessionId: rawId, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'older canonical answer' } });
  store.appendTurn(rawId, turn('user', '[background task bg-page-ghost completed] ghost only'));

  for (let i = 0; i < 305; i += 1) {
    createSession({
      id: `workflow:newer-page-fill:${i}:s1`,
      kind: 'workflow',
      channel: 'workflow',
      title: `Page Fill ${i}::step`,
      metadata: { source: 'workflow', workflowName: `Page Fill ${i}`, workflowRunId: `page-fill-${i}` },
    });
  }

  const matches = buildUnifiedSessionList({ includeArchived: true, limit: 500 })
    .filter((s) => s.id.endsWith(rawId));
  assert.deepEqual(matches.map((s) => s.id), [`harness:${rawId}`]);

  const detail = getUnifiedSessionDetail(`harness:${rawId}`);
  assert.ok(detail);
  assert.deepEqual(detail!.turns.map((t) => t.text), ['older canonical question', 'older canonical answer']);
});

test('list suppresses desktop ghosts for non-representative collapsed workflow steps', () => {
  const runId = 'run-collapsed-step-ghost';
  const stepA = createSession({
    id: `workflow:${runId}:a`,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Collapsed Ghost Flow::a',
    metadata: { source: 'workflow', workflowName: 'Collapsed Ghost Flow', workflowRunId: runId, stepId: 'a' },
  });
  appendEvent({ sessionId: stepA.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'hidden step canonical event' } });
  const stepZ = createSession({
    id: `workflow:${runId}:z`,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Collapsed Ghost Flow::z',
    metadata: { source: 'workflow', workflowName: 'Collapsed Ghost Flow', workflowRunId: runId, stepId: 'z' },
  });
  appendEvent({ sessionId: stepZ.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'representative step canonical event' } });
  store.appendTurn(stepA.id, turn('user', '[background task ghost-for-step-a completed] synthetic report-back only'));

  const sessions = buildUnifiedSessionList({ includeArchived: true, limit: 500 });
  assert.equal(sessions.some((s) => s.id === `desktop:${stepA.id}`), false);
  const workflow = sessions.find((s) => s.title === 'Collapsed Ghost Flow');
  assert.ok(workflow);
  assert.equal(workflow.origin, 'workflow');
  assert.deepEqual(getUnifiedSessionDetail(workflow.id)?.turns.map((t) => t.text), [
    'hidden step canonical event',
    'representative step canonical event',
  ]);
});

test('delete via stale desktop id archives the canonical harness row', () => {
  const rawId = 'same-raw-stale-delete';
  createSession({ id: rawId, kind: 'chat', channel: 'desktop', title: 'Delete canonical harness chat' });
  appendEvent({ sessionId: rawId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'canonical delete question' } });
  store.appendTurn(rawId, turn('user', '[background task stale-delete completed] synthetic report-back only'));

  const deleted = deleteUnifiedSession(`desktop:${rawId}`);
  assert.deepEqual(deleted, { ok: true, mode: 'archived' });
  assert.equal(getSession(rawId)?.metadata.archived, true);
  assert.equal(new SessionStore().exists(rawId), true, 'legacy ghost is not hard-deleted through the stale route');
  assert.equal(buildUnifiedSessionList({ includeArchived: true, limit: 500 }).some((s) => s.id === `desktop:${rawId}`), false);
});

test('patch dispatches to the right store', () => {
  // Harness pin lands in metadata.
  patchUnifiedSession(`harness:${discord.id}`, { pinned: true, tags: ['important'] });
  const row = getSession(discord.id);
  assert.equal(row!.metadata.pinned, true);
  assert.deepEqual(row!.metadata.tags, ['important']);

  // Desktop title rename lands on the record.
  const updated = patchUnifiedSession('desktop:chat-desktop', { title: 'Renamed chat' });
  assert.equal(updated!.title, 'Renamed chat');
});

test('patch on a collapsed workflow run updates every step session', () => {
  const stepA = createSession({ kind: 'workflow', channel: 'workflow', title: 'Patch Flow::a', metadata: { source: 'workflow', workflowName: 'Patch Flow', workflowRunId: 'run-patch-all', stepId: 'a' } });
  const stepB = createSession({ kind: 'workflow', channel: 'workflow', title: 'Patch Flow::b', metadata: { source: 'workflow', workflowName: 'Patch Flow', workflowRunId: 'run-patch-all', stepId: 'b' } });
  appendEvent({ sessionId: stepA.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'patch step a done' } });
  appendEvent({ sessionId: stepB.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'patch step b done' } });

  const updated = patchUnifiedSession(`harness:${stepB.id}`, {
    title: 'Renamed Patch Flow',
    pinned: true,
    tags: ['review'],
    archived: true,
  });

  assert.equal(updated?.title, 'Renamed Patch Flow');
  assert.equal(updated?.pinned, true);
  assert.deepEqual(updated?.tags, ['review']);
  assert.equal(updated?.archived, true);
  assert.equal(updated?.preview, 'patch step b done');
  for (const step of [stepA, stepB]) {
    const row = getSession(step.id);
    assert.equal(row?.metadata.workflowName, 'Renamed Patch Flow');
    assert.equal(row?.metadata.pinned, true);
    assert.equal(row?.metadata.archived, true);
    assert.deepEqual(row?.metadata.tags, ['review']);
  }
  assert.equal(buildUnifiedSessionList({ source: 'workflow' }).some((s) => s.title === 'Renamed Patch Flow'), false);
  assert.equal(buildUnifiedSessionList({ source: 'workflow', includeArchived: true }).filter((s) => s.title === 'Renamed Patch Flow').length, 1);
});

test('collapsed workflow summary aggregates legacy metadata across step sessions', () => {
  const runId = 'run-legacy-partial-metadata';
  const stepA = createSession({
    id: `workflow:${runId}:a`,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Legacy Partial Flow::a',
    metadata: {
      source: 'workflow',
      workflowName: 'Legacy Partial Flow',
      workflowRunId: runId,
      stepId: 'a',
      pinned: true,
      archived: true,
      tags: ['legacy'],
    },
  });
  appendEvent({ sessionId: stepA.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'legacy archived step' } });
  const stepZ = createSession({
    id: `workflow:${runId}:z`,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Legacy Partial Flow::z',
    metadata: {
      source: 'workflow',
      workflowRunId: runId,
      stepId: 'z',
      tags: ['newer'],
    },
  });
  appendEvent({ sessionId: stepZ.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'legacy newer step' } });

  assert.equal(buildUnifiedSessionList({ source: 'workflow', limit: 500 }).some((s) => s.title === 'Legacy Partial Flow'), false);

  const archived = buildUnifiedSessionList({ source: 'workflow', includeArchived: true, limit: 500 })
    .find((s) => s.title === 'Legacy Partial Flow');
  assert.ok(archived);
  assert.equal(archived.archived, true);
  assert.equal(archived.pinned, true);
  assert.equal(archived.tags.includes('legacy'), true);
  assert.equal(archived.tags.includes('newer'), true);

  const detail = getUnifiedSessionDetail(archived.id);
  assert.ok(detail);
  assert.equal(detail.session.archived, true);
  assert.equal(detail.session.pinned, true);
  assert.equal(detail.session.tags.includes('legacy'), true);
  assert.equal(detail.session.tags.includes('newer'), true);
});

test('delete = hard for desktop, archive for harness', () => {
  const harnessDel = deleteUnifiedSession(`harness:${discord.id}`);
  assert.deepEqual(harnessDel, { ok: true, mode: 'archived' });
  assert.equal(getSession(discord.id)!.metadata.archived, true, 'harness session archived, not deleted');

  store.appendTurn('chat-to-delete', turn('user', 'temp'));
  const desktopDel = deleteUnifiedSession('desktop:chat-to-delete');
  assert.deepEqual(desktopDel, { ok: true, mode: 'deleted' });
  assert.equal(new SessionStore().exists('chat-to-delete'), false);
});

test('delete on a collapsed workflow run archives every step session', () => {
  const stepA = createSession({ kind: 'workflow', channel: 'workflow', title: 'Delete Flow::a', metadata: { source: 'workflow', workflowName: 'Delete Flow', workflowRunId: 'run-delete-all', stepId: 'a' } });
  const stepB = createSession({ kind: 'workflow', channel: 'workflow', title: 'Delete Flow::b', metadata: { source: 'workflow', workflowName: 'Delete Flow', workflowRunId: 'run-delete-all', stepId: 'b' } });

  const deleted = deleteUnifiedSession(`harness:${stepB.id}`);

  assert.deepEqual(deleted, { ok: true, mode: 'archived' });
  assert.equal(getSession(stepA.id)?.metadata.archived, true);
  assert.equal(getSession(stepB.id)?.metadata.archived, true);
  assert.equal(buildUnifiedSessionList({ source: 'workflow' }).some((s) => s.title === 'Delete Flow'), false);
  assert.equal(buildUnifiedSessionList({ source: 'workflow', includeArchived: true }).filter((s) => s.title === 'Delete Flow').length, 1);
});

test('hard delete of a source-bound session becomes a bounded replay tombstone with typed no-redispatch truth', async () => {
  const bound = createSession({
    id: 'sess-delete-replay-tombstone',
    kind: 'chat',
    channel: 'desktop',
    userId: 'desktop',
    metadata: {
      source: 'desktop',
      channelId: 'delete-replay-root',
      userId: 'desktop',
    },
  });
  const first = claimSessionForAcceptedSource({
    kind: 'ordinary',
    entrySessionId: bound.id,
    durableSourceId: 'delete-replay-run',
    continuity: {
      provider: 'desktop',
      scopeId: null,
      conversationId: 'delete-replay-root',
      audienceId: 'desktop',
    },
    receipt: {
      requestId: 'delete-replay-request',
      runId: 'delete-replay-run',
      inputHash: 'delete-replay-input',
    },
  });
  const acceptedAttempt = beginRunAttempt(first.selection.sessionId, { runId: 'delete-replay-run' });
  const acceptedSource = recordRunAttemptUserInput(acceptedAttempt, {
    turn: 1,
    role: 'user',
    data: {
      text: 'perform the exact external effect once',
      displayText: 'perform the exact external effect once',
      runId: 'delete-replay-run',
    },
  }, { armRunInFlight: true });
  updateSession(first.selection.sessionId, { status: 'completed' });

  const deleted = deleteUnifiedSession(`harness:${first.selection.sessionId}`, true);
  assert.deepEqual(deleted, {
    ok: true,
    mode: 'archived',
    retainedForReplay: true,
    retentionDays: 14,
    authorityPayloadsDeleted: true,
    replayMode: 'terminal_or_typed_no_redispatch',
  });
  assert.equal(getSession(first.selection.sessionId)?.metadata.acceptedSourceReplayTombstone, true);
  const replay = claimSessionForAcceptedSource({
    kind: 'ordinary',
    entrySessionId: bound.id,
    durableSourceId: 'delete-replay-run',
    continuity: {
      provider: 'desktop',
      scopeId: null,
      conversationId: 'delete-replay-root',
      audienceId: 'desktop',
    },
    receipt: {
      requestId: 'delete-replay-request',
      runId: 'delete-replay-run',
      inputHash: 'delete-replay-input',
    },
  });
  assert.equal(replay.selection.sessionId, first.selection.sessionId);
  const authorityBodyCount = (openEventLog().prepare(`
    SELECT (
      (SELECT COUNT(*) FROM physical_dispatch_authority WHERE session_id = ?)
      + (SELECT COUNT(*) FROM physical_dispatch_authority_payload WHERE session_id = ?)
      + (SELECT COUNT(*) FROM physical_dispatch_authority_sealed WHERE session_id = ?)
    ) AS count
  `).get(first.selection.sessionId, first.selection.sessionId, first.selection.sessionId) as { count: number }).count;
  assert.equal(authorityBodyCount, 0, 'hard delete leaves no physical authority body or sealed dispatch bytes');
  let redispatches = 0;
  const recovery = await new ClementineGateway({
    async respond() {
      redispatches += 1;
      return { sessionId: first.selection.sessionId, text: 'must not redispatch' };
    },
  } as never).handleMessage({
    message: 'perform the exact external effect once',
    sessionId: first.selection.sessionId,
    channel: 'desktop',
    source: 'desktop',
    runId: 'delete-replay-run',
    failClosedOnUnsettledReplay: true,
  });
  assert.equal(redispatches, 0);
  assert.equal(recovery.text, PUBLIC_RUN_FAILURE_TEXT);
  const replayEvents = openEventLog().prepare(`
    SELECT type, COUNT(*) AS count FROM events
     WHERE session_id = ?
       AND (type = 'user_input_received'
         OR (type = 'conversation_completed' AND json_extract(data_json, '$.sourceUserSeq') = ?))
     GROUP BY type
  `).all(first.selection.sessionId, acceptedSource.seq) as Array<{ type: string; count: number }>;
  assert.equal(replayEvents.find((row) => row.type === 'user_input_received')?.count, 1);
  assert.equal(replayEvents.find((row) => row.type === 'conversation_completed')?.count, 1);

  const db = openEventLog();
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', first.selection.sessionId);
  assert.equal(reapStaleSessions(1), 0, 'fresh replay authority protects the tombstone during its horizon');
  db.prepare('UPDATE harness_chat_requests SET created_at = ? WHERE session_id = ?')
    .run('2000-01-01T00:00:00.000Z', first.selection.sessionId);
  const binding = db.prepare(`
    SELECT durable_source_digest, root_session_id, continuity_digest,
           session_id, disposition, selected_after_seq
      FROM accepted_source_session_bindings WHERE session_id = ?
  `).get(first.selection.sessionId) as {
    durable_source_digest: string;
    root_session_id: string;
    continuity_digest: string;
    session_id: string;
    disposition: string;
    selected_after_seq: number;
  };
  db.prepare('DELETE FROM accepted_source_session_bindings WHERE durable_source_digest = ?')
    .run(binding.durable_source_digest);
  db.prepare('UPDATE accepted_source_session_pointers SET updated_at = ? WHERE head_session_id = ?')
    .run('2000-01-01T00:00:00.000Z', first.selection.sessionId);
  db.prepare(`
    INSERT INTO accepted_source_session_bindings
      (durable_source_digest, root_session_id, continuity_digest, session_id,
       disposition, selected_after_seq, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    binding.durable_source_digest,
    binding.root_session_id,
    binding.continuity_digest,
    binding.session_id,
    binding.disposition,
    binding.selected_after_seq,
    '2000-01-01T00:00:00.000Z',
  );
  assert.equal(reapStaleSessions(1), 1, 'expired replay authority is reaped with its minimal tombstone');
  assert.equal(getSession(first.selection.sessionId), null);
});

test('hard delete truly removes an unbound harness session instead of returning a false deleted mode', () => {
  const unbound = createSession({
    id: 'sess-hard-delete-unbound',
    kind: 'chat',
    channel: 'desktop',
    userId: 'desktop',
    metadata: { source: 'desktop' },
  });
  appendEvent({
    sessionId: unbound.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'delete this unrelated unbound session' },
  });

  assert.deepEqual(deleteUnifiedSession(`harness:${unbound.id}`, true), {
    ok: true,
    mode: 'deleted',
    authorityPayloadsDeleted: true,
  });
  assert.equal(getSession(unbound.id), null);
  const remaining = openEventLog().prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ?')
    .get(unbound.id) as { count: number };
  assert.equal(remaining.count, 0);
});

// A2 (v2.3.0): a reopened chat must render a STILL-PENDING approval as the
// actionable card. The server attaches it as a synthetic assistant turn;
// resolved approvals attach nothing (no zombie cards).
test('session detail attaches pending approval cards and drops resolved ones', async () => {
  const approvalRegistry = await import('../runtime/harness/approval-registry.js');
  const origin = createSession({ kind: 'chat', channel: 'desktop', title: 'A2 reopen' });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'post the eod update' } });
  appendEvent({ sessionId: origin.id, turn: 1, role: 'Clem', type: 'conversation_completed', data: { reply: 'Queued — needs your approval.' } });
  const row = approvalRegistry.register({
    sessionId: origin.id,
    subject: 'Post the EOD update to #team',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'SLACK_SEND_MESSAGE', channel: '#team' },
    ttlMs: 60_000,
  });
  appendEvent({
    sessionId: origin.id, turn: 0, role: 'Clem', type: 'approval_requested',
    data: { tool: 'composio_execute_tool', subject: 'Post the EOD update to #team', approvalId: row.approvalId },
  });

  const detail = getUnifiedSessionDetail(`harness:${origin.id}`);
  assert.ok(detail);
  const cardTurns = detail!.turns.filter((t) => t.approval);
  assert.equal(cardTurns.length, 1, 'one pending approval card turn');
  assert.equal(cardTurns[0].approval!.approvalId, row.approvalId);
  assert.equal(cardTurns[0].approval!.subject, 'Post the EOD update to #team');

  // Resolve → the card disappears from subsequent reopens.
  approvalRegistry.resolve(row.approvalId, 'approved', 'a2-reopen-test');
  const after = getUnifiedSessionDetail(`harness:${origin.id}`);
  assert.equal(after!.turns.filter((t) => t.approval).length, 0, 'resolved approvals attach no card');
});

test('session detail restores each exact pending plan card and never revives non-approvable plans', () => {
  const origin = createSession({ kind: 'chat', channel: 'desktop', title: 'Plan reopen' });
  appendEvent({
    sessionId: origin.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Prepare the release brief.' },
  });
  const first = surfacePlan({
    plan: exactPlan(),
    originatingRequest: 'Prepare the release brief.',
    sessionId: origin.id,
  });
  appendEvent({
    sessionId: origin.id,
    turn: 1,
    role: 'Clem',
    type: 'conversation_completed',
    data: {
      reply: 'I drafted the first plan for review.',
      reason: 'plan_first',
      planProposalId: first.id,
    },
  });
  const second = surfacePlan({
    plan: exactPlan({ objective: 'Prepare the exact launch checklist.' }),
    originatingRequest: 'Also prepare the launch checklist.',
    sessionId: origin.id,
  });
  const asking = surfaceAskingPlan({
    plan: exactPlan({ needsUserInput: ['Which audience should receive the brief?'] }),
    originatingRequest: 'Prepare a second audience-specific brief.',
    sessionId: origin.id,
  });

  const detail = getUnifiedSessionDetail(`harness:${origin.id}`);
  assert.ok(detail);
  assert.deepEqual(
    detail!.turns.filter((item) => item.planProposalId).map((item) => item.planProposalId),
    [first.id, second.id],
    'each independently addressable approvable plan keeps its exact identity',
  );
  assert.equal(
    detail!.turns.filter((item) => item.planProposalId === first.id).length,
    1,
    'a current plan terminal becomes one actionable turn, never duplicate prose plus card',
  );
  assert.equal(
    detail!.turns.find((item) => item.planProposalId === first.id)?.text,
    'I drafted the first plan for review.',
    'the card stays on the original assistant turn in timeline order',
  );
  assert.equal(
    detail!.turns.some((item) => item.planProposalId === asking.id),
    false,
    'a plan that still needs input never regains an approve button',
  );

  rejectPlanProposal(first.id, 'test resolution');
  const after = getUnifiedSessionDetail(`harness:${origin.id}`);
  assert.deepEqual(
    after!.turns.filter((item) => item.planProposalId).map((item) => item.planProposalId),
    [second.id],
    'resolved plans disappear while their pending sibling remains exact',
  );

  const readOnly = createSession({ kind: 'workflow', channel: 'workflow', title: 'Read-only plan transcript' });
  const workflowPlan = surfacePlan({
    plan: exactPlan({ objective: 'A workflow-owned plan must stay in Inbox.' }),
    originatingRequest: 'Prepare a workflow-owned plan.',
    sessionId: readOnly.id,
  });
  assert.equal(
    getUnifiedSessionDetail(`harness:${readOnly.id}`)!.turns.some((item) => item.planProposalId === workflowPlan.id),
    false,
    'read-only workflow transcripts never paint an inline gate with no-op handlers',
  );
});

test('raw report-back titles heal at read time; synthetic first turns derive human titles', () => {
  // Already-persisted raw title (clipped mid-head, pre-fix data).
  store.appendTurn('chat-rawtitle', turn('user', 'anything'));
  store.setMeta('chat-rawtitle', { title: '[background task bg-mr440n9u-e1340' });

  // No stored title; the first user turn is the synthetic report-back.
  store.appendTurn('chat-synthetic', turn('user', '[workflow run 1781852780491-3f66 completed] Daily standup email\n\nSent to Nate.\n\n(This ran in the background and just finished — continue from here.)'));

  const sessions = buildUnifiedSessionList();
  const healed = sessions.find((s) => s.id === 'desktop:chat-rawtitle');
  assert.equal(healed?.title, 'Background task', 'stored raw title heals without migration');
  const synthetic = sessions.find((s) => s.id === 'desktop:chat-synthetic');
  assert.equal(synthetic?.title, 'Workflow run: Daily standup email', 'synthetic turn derives a human title');
});

// ── A collapsed run's status is the RUN's, and its steps are addressable ──
//
// The collapse used to hand the page the most-recent STEP's session id and
// status. A four-step run that emailed in step 2 then read "1 change" (step 4
// only), and a run whose step 3 had just finished wore a green "Completed"
// pill while step 4 was still executing.

function workflowStep(
  runId: string,
  stepId: string,
  status: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled',
) {
  const created = createSession({
    id: `workflow:${runId}:${stepId}`,
    kind: 'workflow',
    channel: 'workflow',
    title: `Status Flow ${runId}::${stepId}`,
    metadata: { source: 'workflow', workflowName: `Status Flow ${runId}`, workflowRunId: runId, stepId },
  });
  appendEvent({ sessionId: created.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: `${stepId} reply` } });
  if (status !== 'active') updateSession(created.id, { status });
  return created;
}

function collapsedRun(runId: string) {
  const found = buildUnifiedSessionList({ includeArchived: true, limit: 500 })
    .find((s) => s.title === `Status Flow ${runId}`);
  assert.ok(found, `collapsed row for ${runId}`);
  return found;
}

test('a collapsed run carries every step session, in order, addressable by the page', () => {
  const runId = 'run-steps-addressable';
  workflowStep(runId, 'a', 'completed');
  workflowStep(runId, 'b', 'completed');
  const row = collapsedRun(runId);
  assert.deepEqual(row.runSteps?.map((s) => s.id), [
    `harness:workflow:${runId}:a`,
    `harness:workflow:${runId}:b`,
  ], 'both steps, oldest first — the page unions their events rather than reading one');
  assert.deepEqual(row.runSteps?.map((s) => s.label), ['a', 'b']);
  // Detail must carry the same steps, whichever step id was addressed.
  const viaStepA = getUnifiedSessionDetail(`harness:workflow:${runId}:a`);
  assert.deepEqual(viaStepA?.session.runSteps?.map((s) => s.id), row.runSteps?.map((s) => s.id));
});

test('a run with a step still running never reports Completed', () => {
  const runId = 'run-step-still-running';
  workflowStep(runId, 'a', 'completed');
  workflowStep(runId, 'b', 'active');
  assert.equal(collapsedRun(runId).status, 'active');
  assert.equal(getUnifiedSessionDetail(`harness:workflow:${runId}:a`)?.session.status, 'active');
});

test('a paused or failed step outranks its completed siblings', () => {
  const paused = 'run-step-paused';
  workflowStep(paused, 'a', 'completed');
  workflowStep(paused, 'b', 'paused');
  assert.equal(collapsedRun(paused).status, 'paused');

  const failed = 'run-step-failed';
  workflowStep(failed, 'a', 'failed');
  workflowStep(failed, 'b', 'completed');
  assert.equal(collapsedRun(failed).status, 'failed', 'the newest step completing does not clear a failure');
});

test('Completed is reported only when every step completed', () => {
  const runId = 'run-all-complete';
  workflowStep(runId, 'a', 'completed');
  workflowStep(runId, 'b', 'completed');
  assert.equal(collapsedRun(runId).status, 'completed');
});

test('a collapsed run is dated from its first step, not its most recent one', () => {
  const runId = 'run-window-spans-steps';
  const first = workflowStep(runId, 'a', 'completed');
  const second = workflowStep(runId, 'b', 'completed');
  const row = collapsedRun(runId);
  assert.equal(row.createdAt, first.createdAt, 'elapsed measures the whole run');
  assert.ok(row.updatedAt >= second.updatedAt);
});

test('a chat carries no run steps to union', () => {
  const chat = buildUnifiedSessionList({ source: 'discord', includeArchived: true, limit: 500 })[0];
  assert.ok(chat);
  assert.equal(chat.runSteps, undefined);
});

test('a patched run comes back aggregated, not as the one step that was patched', () => {
  const runId = 'run-patch-keeps-aggregate';
  workflowStep(runId, 'a', 'completed');
  workflowStep(runId, 'b', 'active');
  const patched = patchUnifiedSession(`harness:workflow:${runId}:a`, { pinned: true });
  assert.ok(patched);
  assert.equal(patched.pinned, true);
  assert.equal(patched.status, 'active', 'pinning a finished step must not settle the run');
  assert.equal(patched.runSteps?.length, 2);
  patchUnifiedSession(`harness:workflow:${runId}:a`, { pinned: false });
});
