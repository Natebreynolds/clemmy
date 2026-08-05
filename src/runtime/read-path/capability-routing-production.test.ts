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
// The corpus runner disables local embeddings by default. These suites are
// ABOUT the local semantic tier, so they turn it on and assert hard: a model
// that will not load means paraphrase retrieval is genuinely unavailable, and
// that must fail loudly rather than pass quietly.
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'on';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const { respondPreferHarness, _setBridgeImplsForTests } = await import('../harness/respond-bridge.js');
const {
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainRunForTest,
} = await import('../harness/claude-agent-brain.js');
const eventlog = await import('../harness/eventlog.js');
const composio = await import('../../tools/composio-tools.js');
const schemaCache = await import('../../tools/composio-schema-cache.js');
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
let teachSeq = 0;
async function teachOneVerifiedRead(): Promise<void> {
  const sessionId = `sess-teach-${(teachSeq += 1)}`;
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: 'teach' });
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: COLD_PHRASE, attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  schemaCache.rememberToolSchema(CALENDAR_SLUG, {
    type: 'object', properties: { timeMin: { type: 'string' }, timeMax: { type: 'string' } },
  });
  const exec = (async () => ({
    successful: true,
    data: { items: [{ id: 'evt-1', summary: 'Standup', start: '2026-08-06T09:00:00-07:00' }] },
  })) as never;
  await composio.runComposioExecuteForTestInSession(
    CALENDAR_SLUG, { timeMin: '2026-08-06', timeMax: '2026-08-07' }, exec, sessionId,
  );
}

/** What the brain build receives FROM INSIDE the turn. */
type SurfaceProbe = { pinned: string[]; matchCount: number; card: string };

function probeBridgeTurn(): { probes: SurfaceProbe[]; run: never; buildAgent: never } {
  const probes: SurfaceProbe[] = [];
  const run = (async (opts: { sessionId: string; buildAgent?: () => Promise<unknown> }) => {
    await opts.buildAgent?.();
    return { sessionId: opts.sessionId, steps: 1, lastTurn: 1, status: 'completed', text: 'ok' };
  }) as never;
  const buildAgent = (async (opts: {
    turnCandidates?: { pinnedTools?: string[]; matches?: unknown[] };
  }) => {
    probes.push({
      pinned: [...(opts?.turnCandidates?.pinnedTools ?? [])],
      matchCount: opts?.turnCandidates?.matches?.length ?? 0,
      card: candidates.renderCapabilityCandidateCard(opts?.turnCandidates as never),
    });
    return FAKE_AGENT;
  }) as never;
  return { probes, run, buildAgent };
}

test('a real chat turn resolves capability candidates before either brain builds its tool surface', async () => {
  await teachOneVerifiedRead();
  assert.equal(await candidates.warmCapabilityRetrieval(), true,
    'the bundled local retrieval model did not load');

  const { probes, run, buildAgent } = probeBridgeTurn();
  // The agent is built DURING the turn, which is exactly when the tool
  // surface is assembled — so this is the honest observation point.
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent, runConversation: run });

  let legacyCalls = 0;
  await respondPreferHarness(
    'home', { message: PARAPHRASE, sessionId: 'sess-paraphrase-turn' },
    async (req) => { legacyCalls += 1; return { text: 'legacy', sessionId: req.sessionId }; },
  );
  assert.equal(legacyCalls, 0, 'the turn fell out of the harness lane — this proves nothing about it');

  assert.equal(probes.length, 1, 'the turn did not reach the brain-building seam');
  assert.ok(probes[0]!.pinned.includes('composio_execute_tool'),
    'the proven capability’s carrier was not pinned for this turn — a real paraphrase still pays full discovery');
  assert.ok(probes[0]!.matchCount > 0, 'no advisory matches reached the MCP recall seam');
  assert.match(probes[0]!.card, /SCHEDULERCO_LIST_EVENTS/,
    'the advisory candidate card does not name the proven capability');
  assert.doesNotMatch(probes[0]!.card, /timeMin|2026-08/,
    'the candidate card leaked prior invocation arguments');
});

test('ordinary chat reaches the same seam and pays nothing for it', async () => {
  const { probes, run, buildAgent } = probeBridgeTurn();
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent, runConversation: run });

  await respondPreferHarness(
    'home', { message: UNRELATED, sessionId: 'sess-unrelated-turn' },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(probes.length, 1, 'the turn did not reach the brain-building seam');
  assert.equal(probes[0]!.pinned.includes('composio_execute_tool'), false,
    'an unrelated question pinned a connected-app carrier');
  assert.equal(probes[0]!.card, '', 'ordinary chat carries a candidate card it does not need');
});

test('an ESTABLISHED session still receives its candidates — delivery is bound to the turn, not to a phrase key', async () => {
  await teachOneVerifiedRead();
  assert.equal(await candidates.warmCapabilityRetrieval(), true);

  // A real multi-turn session: earlier user inputs exist, so the brains rank
  // tools against a JOINED conversation query, not the bare message. Anything
  // keyed on the literal phrase misses here.
  const sessionId = 'sess-established';
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: 'established' });
  for (const prior of ['morning!', 'thanks, that helped']) {
    const attempt = eventlog.beginRunAttempt(sessionId, {});
    eventlog.recordRunAttemptUserInput(attempt, {
      turn: 1, role: 'user', data: { text: prior, attemptId: attempt.attemptId, source: 'home' },
    }, { armRunInFlight: true });
    eventlog.finishRunAttempt({ sessionId, attemptId: attempt.attemptId }, 'completed');
  }

  const probes: Array<{ pinned: string[] }> = [];
  const run = (async (opts: { sessionId: string; buildAgent?: () => Promise<unknown> }) => {
    await opts.buildAgent?.();
    return { sessionId: opts.sessionId, steps: 1, lastTurn: 1, status: 'completed', text: 'ok' };
  }) as never;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: (async (opts: { turnCandidates?: { pinnedTools?: string[] } }) => {
      probes.push({ pinned: [...(opts?.turnCandidates?.pinnedTools ?? [])] });
      return FAKE_AGENT;
    }) as never,
    runConversation: run,
  });

  await respondPreferHarness(
    'home', { message: PARAPHRASE, sessionId },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(probes.length, 1, 'the turn did not reach the brain-building seam');
  assert.ok(probes[0]!.pinned.includes('composio_execute_tool'),
    'the established session lost its candidates — delivery depends on a phrase-keyed side channel');
});

test('the Claude lane receives the same turn-bound candidates as the Codex lane', async () => {
  await teachOneVerifiedRead();
  assert.equal(await candidates.warmCapabilityRetrieval(), true);
  const resolved = await candidates.resolveTurnCapabilityCandidates({ userInput: PARAPHRASE });
  assert.ok(resolved.candidates.some((c) => c.identifier === CALENDAR_SLUG), 'no candidate to deliver');

  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const seen: Array<{ tools: string[] | undefined; systemAppend: string }> = [];
  setClaudeAgentSdkBrainRunForTest((async (options: {
    allowedLocalMcpTools?: string[]; systemAppend?: string;
  }) => {
    seen.push({ tools: options.allowedLocalMcpTools, systemAppend: options.systemAppend ?? '' });
    return {
      text: 'ok', sessionId: 'sess-claude-lane', model: 'claude-test',
      toolUses: [], successfulToolUses: [],
    };
  }) as never);
  try {
    await respondViaClaudeAgentSdkBrain('home', {
      message: PARAPHRASE,
      sessionId: 'sess-claude-lane',
      turnCandidates: resolved,
    });
  } finally {
    setClaudeAgentSdkBrainRunForTest(null);
    delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  }

  assert.equal(seen.length, 1, 'the Claude transport was never invoked');
  assert.match(seen[0]!.systemAppend, new RegExp(CALENDAR_SLUG),
    'the Claude lane never saw the advisory candidate card');
  assert.doesNotMatch(seen[0]!.systemAppend, /timeMin|2026-08/,
    'the candidate card leaked prior invocation arguments into the Claude lane');
  if (seen[0]!.tools) {
    assert.ok(seen[0]!.tools.includes('composio_execute_tool'),
      'the Claude lane pruned the carrier the candidate needs');
  }
});
