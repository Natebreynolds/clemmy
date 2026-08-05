/**
 * Run: npx tsx --test src/runtime/read-path/capability-routing-production.test.ts
 *
 * F2 production reachability. Suite A proved the loop works when something
 * calls it; this proves the PRODUCT calls it. A real chat turn goes through the
 * real bridge with only the model runtime replaced, and the assertions are made
 * from INSIDE the turn — at the moment the brain is being built — against the
 * same synchronous seams both brains use to assemble their tool surface.
 *
 * If retrieval were wired into one brain, or after the tool surface was
 * decided, or not at all, these assertions fail.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TEST_HOME = '/tmp/clemmy-test-capability-routing';
rmSync(TEST_HOME, { recursive: true, force: true });
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const { respondPreferHarness, _setBridgeImplsForTests } = await import('../harness/respond-bridge.js');
const eventlog = await import('../harness/eventlog.js');
const composio = await import('../../tools/composio-tools.js');
const jit = await import('../../agents/tool-jit.js');
const mcpScope = await import('../mcp-tool-scope.js');
const candidates = await import('./capability-candidates.js');

const CALENDAR_SLUG = 'SCHEDULERCO_LIST_EVENTS';
const COLD_PHRASE = "What's on my calendar tomorrow?";
const PARAPHRASE = 'Anything on deck tomorrow?';
const UNRELATED = 'what do you think about the plan for next quarter?';

const FAKE_AGENT = {} as never;
const okConfigure = (async () => ({ ok: true })) as never;

/** Teach the workspace one capability the way a real cold turn would. */
async function teachOneVerifiedRead(): Promise<void> {
  const sessionId = 'sess-teach';
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: 'teach' });
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: COLD_PHRASE, attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  const exec = (async () => ({
    successful: true,
    data: { items: [{ id: 'evt-1', summary: 'Standup', start: '2026-08-06T09:00:00-07:00' }] },
  })) as never;
  await composio.runComposioExecuteForTestInSession(
    CALENDAR_SLUG, { timeMin: '2026-08-06', timeMax: '2026-08-07' }, exec, sessionId,
  );
}

/** What the tool surface looks like FROM INSIDE the turn, at build time. */
type SurfaceProbe = { pinned: string[]; mcpMaxTools: number | undefined };

function probeBridgeTurn(): { probes: SurfaceProbe[]; run: never } {
  const probes: SurfaceProbe[] = [];
  const run = (async (opts: { sessionId: string; buildAgent?: () => Promise<unknown> }) => {
    await opts.buildAgent?.();
    return { sessionId: opts.sessionId, steps: 1, lastTurn: 1, status: 'completed', text: 'ok' };
  }) as never;
  return { probes, run };
}

test('a real chat turn resolves capability candidates before either brain builds its tool surface', async () => {
  await teachOneVerifiedRead();
  assert.equal(await candidates.warmCapabilityRetrieval(), true,
    'the bundled local retrieval model did not load');

  const { probes, run } = probeBridgeTurn();
  _setBridgeImplsForTests({
    configure: okConfigure,
    // The agent is built DURING the turn, which is exactly when the tool
    // surface is assembled — so this is the honest observation point.
    buildAgent: (async () => {
      probes.push({
        pinned: jit.recallPinnedBuiltinTools(PARAPHRASE),
        mcpMaxTools: mcpScope.resolveMcpToolScopeWithRecall({ userInput: PARAPHRASE }).maxTools,
      });
      return FAKE_AGENT;
    }) as never,
    runConversation: run,
  });

  let legacyCalls = 0;
  await respondPreferHarness(
    'home', { message: PARAPHRASE, sessionId: 'sess-paraphrase-turn' },
    async (req) => { legacyCalls += 1; return { text: 'legacy', sessionId: req.sessionId }; },
  );
  assert.equal(legacyCalls, 0, 'the turn fell out of the harness lane — this proves nothing about it');

  assert.equal(probes.length, 1, 'the turn did not reach the brain-building seam');
  assert.ok(probes[0]!.pinned.includes('composio_execute_tool'),
    'the proven capability’s carrier was not pinned for this turn — a real paraphrase still pays full discovery');
  assert.notEqual(probes[0]!.mcpMaxTools, 0,
    'candidate retrieval closed the connector surface — retrieval must be advisory');
});

test('ordinary chat reaches the same seam and pays nothing for it', async () => {
  const { probes, run } = probeBridgeTurn();
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: (async () => {
      probes.push({
        pinned: jit.recallPinnedBuiltinTools(UNRELATED),
        mcpMaxTools: mcpScope.resolveMcpToolScopeWithRecall({ userInput: UNRELATED }).maxTools,
      });
      return FAKE_AGENT;
    }) as never,
    runConversation: run,
  });

  await respondPreferHarness(
    'home', { message: UNRELATED, sessionId: 'sess-unrelated-turn' },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(probes.length, 1, 'the turn did not reach the brain-building seam');
  assert.equal(probes[0]!.pinned.includes('composio_execute_tool'), false,
    'an unrelated question pinned a connected-app carrier');
});
