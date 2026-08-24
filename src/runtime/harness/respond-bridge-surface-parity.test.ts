/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/respond-bridge-surface-parity.test.ts */
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-test-respond-bridge-parity-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  respondPreferHarness,
  _setBridgeImplsForTests,
} = await import('./respond-bridge.js');
const {
  beginRunAttempt,
  createSession,
  listEvents,
  recordRunAttemptUserInput,
  resetEventLog,
} = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');

const SURFACES = ['home', 'dashboard', 'webhook', 'cli', 'cron'] as const;
const CHAT_SURFACES = ['home', 'dashboard', 'webhook', 'cli', 'discord', 'slack'] as const;

beforeEach(() => {
  resetEventLog();
  _setBridgeImplsForTests({});
  for (const surface of SURFACES) delete process.env[`CLEMMY_HARNESS_${surface.toUpperCase()}`];
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  delete process.env.CLEMMY_TURN_ENGINE;
  process.env.AUTH_MODE = 'api_key';
});

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function assertBlockedTerminal(sessionId: string, res: { stoppedReason?: string; raw?: unknown }) {
  assert.equal(res.stoppedReason, 'blocked');
  const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, `${sessionId} must have exactly one durable terminal`);
  assert.equal((terminals[0]?.data.presentation as { status?: string })?.status, 'blocked');
  assert.equal((res.raw as { terminalCommitted?: boolean })?.terminalCommitted, true);
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
}

test('blocked preflight is the same across home, web, webhook, gateway, and cron', async () => {
  for (const surface of SURFACES) {
    const sessionId = `parity-block-${surface}`;
    createSession({ id: sessionId, kind: 'chat' });
    process.env[`CLEMMY_HARNESS_${surface.toUpperCase()}`] = 'off';
    let legacyCalled = 0;
    const res = await respondPreferHarness(surface, { message: 'hi', sessionId }, async (req) => {
      legacyCalled += 1;
      return { text: 'legacy', sessionId: req.sessionId };
    });
    assert.equal(legacyCalled, 0, `${surface} must not fall back`);
    assertBlockedTerminal(sessionId, res);
    delete process.env[`CLEMMY_HARNESS_${surface.toUpperCase()}`];
  }
});

test('legacy break-glass cannot own a fresh effect-capable chat surface', async () => {
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  for (const surface of CHAT_SURFACES) {
    const sessionId = `parity-no-fresh-legacy-${surface}`;
    process.env[`CLEMMY_HARNESS_${surface.toUpperCase()}`] = 'off';
    let legacyCalled = 0;
    const res = await respondPreferHarness(surface, { message: 'send the update', sessionId }, async (req) => {
      legacyCalled += 1;
      return { text: 'legacy', sessionId: req.sessionId };
    });
    assert.equal(legacyCalled, 0, `${surface} must never enter fresh legacy execution`);
    assertBlockedTerminal(sessionId, res);
    delete process.env[`CLEMMY_HARNESS_${surface.toUpperCase()}`];
  }
});

test('explicit legacy or unknown fresh engine configuration blocks before any brain runs', async () => {
  for (const configuredValue of ['legacy_sdk', 'future-engine']) {
    const sessionId = `parity-invalid-fresh-engine-${configuredValue}`;
    process.env.CLEMMY_TURN_ENGINE = configuredValue;
    let legacyCalled = 0;
    let runCalls = 0;
    _setBridgeImplsForTests({
      configure: (async () => ({ ok: true })) as never,
      runConversation: (async () => {
        runCalls += 1;
        throw new Error('brain must not run');
      }) as never,
    });
    const res = await respondPreferHarness('home', { message: 'send the update', sessionId }, async (req) => {
      legacyCalled += 1;
      return { text: 'legacy', sessionId: req.sessionId };
    });
    assert.equal(legacyCalled, 0);
    assert.equal(runCalls, 0);
    assertBlockedTerminal(sessionId, res);
  }
});

test('uncertain and blocked committed terminals stay blocked on every surface including Claude', async () => {
  const lanes = [
    ...SURFACES.map((surface) => ({ surface, label: surface, status: 'uncertain' as const })),
    { surface: 'home' as const, label: 'claude', status: 'blocked' as const },
    { surface: 'home' as const, label: 'primary', status: 'uncertain' as const },
  ];
  for (const lane of lanes) {
    const sessionId = `parity-uncertain-${lane.label}`;
    createSession({ id: sessionId, kind: 'chat' });
    const attempt = beginRunAttempt(sessionId, { runId: `run:${sessionId}` });
    const source = recordRunAttemptUserInput(attempt, {
      turn: 1,
      role: 'user',
      data: { text: 'continue' },
    });
    commitTurnOutcome({
      version: 2,
      id: turnOutcomeId({ sessionId, turn: 1, sourceUserSeq: source.seq }),
      identity: { sessionId, turn: 1, sourceUserSeq: source.seq },
      status: lane.status,
      resumable: true,
      presentation: { kind: 'blocked', text: 'The run stopped without a verified write.' },
    }, { metadata: { transport: 'parity' } });
    if (lane.label === 'claude') {
      process.env.AUTH_MODE = 'claude_oauth';
      process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
    }
    let brainCalls = 0;
    let legacyCalled = 0;
    _setBridgeImplsForTests({
      claudeAgentBrain: (async (_surface, req) => {
        brainCalls += 1;
        return { text: 'claude-ran', sessionId: req.sessionId, stoppedReason: 'success' };
      }) as never,
    });
    const res = await respondPreferHarness(
      lane.surface,
      { message: 'continue', sessionId, sourceUserSeq: source.seq },
      async (req) => {
        legacyCalled += 1;
        return { text: 'legacy', sessionId: req.sessionId };
      },
    );
    assert.equal(brainCalls, 0, `${lane.label} must not redispatch`);
    assert.equal(legacyCalled, 0, `${lane.label} must not fall back`);
    assert.equal(res.stoppedReason, 'blocked', `${lane.label} maps uncertain/blocked to blocked`);
    assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
    delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
    process.env.AUTH_MODE = 'api_key';
  }
});
