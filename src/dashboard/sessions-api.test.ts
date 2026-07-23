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
const { createSession, appendEvent, getSession } = await import('../runtime/harness/eventlog.js');

const turn = (role: 'user' | 'assistant', text: string) => ({ role, text, createdAt: new Date().toISOString() });

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
