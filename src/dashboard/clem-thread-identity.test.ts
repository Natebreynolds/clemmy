/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/clem-thread-identity.test.ts
 *
 * Her thread is one conversation: a message the owner sends from the desktop
 * continues it. Live 2026-10-01 her thread was created without a desktop
 * chat's identity and the chat route split the owner's first message into a
 * new conversation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-thread-identity-'));
process.env.CLEMENTINE_HOME = TMP;
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const { productionClemThread, CLEM_THREAD_ID } = await import('./from-clem-runtime.js');
const { selectSessionForAcceptedSource } = await import('../runtime/harness/accepted-source-session-branch.js');
const { createSession, getSession } = await import('../runtime/harness/eventlog.js');

const desktopMessage = (id: string) => selectSessionForAcceptedSource({
  entrySessionId: CLEM_THREAD_ID,
  durableSourceId: id,
  continuity: { provider: 'desktop', scopeId: null, conversationId: CLEM_THREAD_ID, audienceId: 'desktop' },
  kind: 'ordinary',
});

test('a desktop message to her thread continues her thread', () => {
  productionClemThread.ensure();
  const selection = desktopMessage('run-1');
  assert.equal(selection.sessionId, CLEM_THREAD_ID, JSON.stringify(selection));
  assert.equal(getSession(CLEM_THREAD_ID)?.metadata?.pinned, true);
});
