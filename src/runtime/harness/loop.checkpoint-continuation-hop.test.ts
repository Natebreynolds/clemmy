/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/loop.checkpoint-continuation-hop.test.ts
 *
 * A committed recovered frame must not wait for the next restart tick.
 *
 * After host checkpoint recovery commits a recovered frame's results it hands
 * back a 'continue' checkpoint (`hold: recovery_pending`). That checkpoint is
 * adopted by the NEXT runConversation activation, which used to mean the
 * resumed run answered "still owned by Clem's recovery system" and the work
 * waited for the periodic/restart owner (hard-cut journey, 2026-08-31).
 * runConversation now takes that next activation once in the same call, but
 * ONLY for a ready continuation of the exact identified source. These pins
 * hold the predicate that decides the hop; the hard-cut journey subtest holds
 * the connection end to end.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-continuation-hop-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const { createSession, appendEvent, closeEventLog } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { HostRecoveryState } = await import('./host-turn-runner.js');
const { checkpointContinuationIsReady } = await import('./loop.js');
import type { AgentInputItem } from '@openai/agents';

test.after(() => {
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const HELD = {
  status: 'held' as const,
  hold: { owner: 'host' as const, wake: 'recovery' as const, reason: 'recovery_pending' as const },
};

function sourceFor(id: string): { sessionId: string; sourceUserSeq: number; session: InstanceType<typeof HarnessSession> } {
  const session = createSession({ id, kind: 'chat' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Search the newest local model articles and build the calendar' },
  });
  const loaded = HarnessSession.load(session.id);
  assert.ok(loaded);
  return { sessionId: session.id, sourceUserSeq: source.seq, session: loaded };
}

const HISTORY = [
  { role: 'user', content: 'Search the newest local model articles and build the calendar' },
] as unknown as AgentInputItem[];

function continueCheckpoint(sessionId: string, sourceUserSeq: number): string {
  const blob = new HostRecoveryState(
    sessionId,
    sourceUserSeq,
    'continue',
    HISTORY,
    [],
    [],
    undefined,
    undefined,
    'host_v1',
    undefined,
    4,
    {
      sessionId,
      sourceUserSeq,
      acceptedTaskId: `task:${sessionId}:${sourceUserSeq}`,
      batchOrdinal: 3,
      batchId: 'b'.repeat(64),
      authorityDigest: 'c'.repeat(64),
    },
  ).toString();
  assert.equal(HostRecoveryState.fromString(blob).phase, 'continue', 'fixture blob must round-trip');
  return blob;
}

function admitCheckpoint(sessionId: string, sourceUserSeq: number): string {
  const blob = new HostRecoveryState(
    sessionId,
    sourceUserSeq,
    'admit',
    HISTORY,
    [{ type: 'function_call', callId: 'call-1', name: 'tool_search', arguments: '{}' }] as unknown as AgentInputItem[],
    [],
    undefined,
    undefined,
    'host_v1',
    undefined,
    2,
  ).toString();
  assert.equal(HostRecoveryState.fromString(blob).phase, 'admit', 'fixture blob must round-trip');
  return blob;
}

test('a ready continue checkpoint for the exact identified source is taken in the same call', () => {
  const { sessionId, sourceUserSeq, session } = sourceFor('continuation-hop-ready');
  session.saveRecoveryState(continueCheckpoint(sessionId, sourceUserSeq));
  assert.equal(checkpointContinuationIsReady(HELD, { sessionId, sourceUserSeq }), true);
});

test('only a recovery-owned hold hops; ordinary results and peer holds never do', () => {
  const { sessionId, sourceUserSeq, session } = sourceFor('continuation-hop-not-a-hold');
  session.saveRecoveryState(continueCheckpoint(sessionId, sourceUserSeq));
  assert.equal(checkpointContinuationIsReady({ status: 'completed' }, { sessionId, sourceUserSeq }), false);
  assert.equal(checkpointContinuationIsReady({
    status: 'held',
    hold: { owner: 'host', wake: 'peer', reason: 'peer_in_progress' },
  }, { sessionId, sourceUserSeq }), false);
});

test('a caller that did not identify the source never hops (it would accept a new source)', () => {
  const { sessionId, sourceUserSeq, session } = sourceFor('continuation-hop-unidentified');
  session.saveRecoveryState(continueCheckpoint(sessionId, sourceUserSeq));
  assert.equal(checkpointContinuationIsReady(HELD, { sessionId }), false);
  assert.equal(checkpointContinuationIsReady(HELD, { sessionId, sourceUserSeq: sourceUserSeq + 1 }), false);
  assert.equal(checkpointContinuationIsReady(HELD, { sessionId: 'someone-else', sourceUserSeq }), false);
});

test('admit/finalize checkpoints keep their in-activation re-entry; a missing or foreign blob never hops', () => {
  const { sessionId, sourceUserSeq, session } = sourceFor('continuation-hop-other-phases');
  session.saveRecoveryState(admitCheckpoint(sessionId, sourceUserSeq));
  assert.equal(checkpointContinuationIsReady(HELD, { sessionId, sourceUserSeq }), false);
  session.clearRecoveryState();
  assert.equal(checkpointContinuationIsReady(HELD, { sessionId, sourceUserSeq }), false);
  session.saveRecoveryState('{"not":"a host checkpoint"}');
  assert.equal(checkpointContinuationIsReady(HELD, { sessionId, sourceUserSeq }), false);
});
