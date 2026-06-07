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
createSession({ kind: 'workflow', channel: 'workflow', title: 'My Flow::step-1', metadata: { source: 'workflow', workflowName: 'My Flow', workflowRunId: 'run-xyz', stepId: 'step-1' } });
createSession({ kind: 'workflow', channel: 'workflow', title: 'My Flow::step-2', metadata: { source: 'workflow', workflowName: 'My Flow', workflowRunId: 'run-xyz', stepId: 'step-2' } });

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
});

test('pinned sessions sort first', () => {
  patchUnifiedSession(`desktop:chat-desktop`, { pinned: true });
  const sessions = buildUnifiedSessionList();
  assert.equal(sessions[0].origin, 'desktop', 'pinned desktop chat is first');
  assert.equal(sessions[0].pinned, true);
  // Reset for later tests.
  patchUnifiedSession(`desktop:chat-desktop`, { pinned: false });
});

test('q filter matches title and desktop transcript; source filter narrows', () => {
  assert.equal(buildUnifiedSessionList({ q: 'SEO audit' }).length, 1);
  assert.equal(buildUnifiedSessionList({ q: 'discord' }).length, 1);
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
  assert.equal(wfDetail!.continueHint, null);
});

test('detail returns null for unknown / malformed ids', () => {
  assert.equal(getUnifiedSessionDetail('desktop:nope'), null);
  assert.equal(getUnifiedSessionDetail('harness:nope'), null);
  assert.equal(getUnifiedSessionDetail('garbage'), null);
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

test('delete = hard for desktop, archive for harness', () => {
  const harnessDel = deleteUnifiedSession(`harness:${discord.id}`);
  assert.deepEqual(harnessDel, { ok: true, mode: 'archived' });
  assert.equal(getSession(discord.id)!.metadata.archived, true, 'harness session archived, not deleted');

  store.appendTurn('chat-to-delete', turn('user', 'temp'));
  const desktopDel = deleteUnifiedSession('desktop:chat-to-delete');
  assert.deepEqual(desktopDel, { ok: true, mode: 'deleted' });
  assert.equal(new SessionStore().exists('chat-to-delete'), false);
});
