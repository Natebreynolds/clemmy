/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/clem-thread-heal.test.ts
 *
 * A thread written before it carried a desktop chat's identity (live
 * 2026-10-01) is healed in place, keeping the owner's own pin choice, and the
 * owner's next desktop message continues it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-thread-heal-'));
process.env.CLEMENTINE_HOME = TMP;
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const { productionClemThread, CLEM_THREAD_ID } = await import('./from-clem-runtime.js');
const { selectSessionForAcceptedSource } = await import('../runtime/harness/accepted-source-session-branch.js');
const { createSession, getSession } = await import('../runtime/harness/eventlog.js');

test('an old thread is healed in place and the next desktop message continues it', () => {
  createSession({ id: CLEM_THREAD_ID, kind: 'chat', title: 'Clem', metadata: { source: 'clem_thread', pinned: false } });
  productionClemThread.ensure();
  const meta = getSession(CLEM_THREAD_ID)?.metadata as Record<string, unknown>;
  assert.equal(meta.source, 'desktop');
  assert.equal(meta.channelId, CLEM_THREAD_ID);
  assert.equal(meta.pinned, false, 'a pin the owner removed stays removed');
  const selection = selectSessionForAcceptedSource({
    entrySessionId: CLEM_THREAD_ID,
    durableSourceId: 'run-1',
    continuity: { provider: 'desktop', scopeId: null, conversationId: CLEM_THREAD_ID, audienceId: 'desktop' },
    kind: 'ordinary',
  });
  assert.equal(selection.sessionId, CLEM_THREAD_ID, JSON.stringify(selection));
});
