/**
 * Run: npx tsx --test src/runtime/read-path/learned-read-loop.test.ts
 *
 * F0 suite A — the learned read loop, proven as PRODUCT BEHAVIOR through the
 * real seams:
 *
 *   governed dispatch wrapper (runComposioExecuteForTestInSession — the same
 *   gateway production uses, only its final network function replaced)
 *     -> durable receipt/evidence
 *     -> verified-settlement learning observer
 *     -> tool-choice memory / procedure store
 *     -> candidate retrieval used by the REAL JIT + MCP recall seams
 *     -> the brain's own tool surface
 *
 * No source scans, no export-existence checks, no Function.toString(). Every
 * assertion is a behavior a user would notice.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-f0-loop-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
// The corpus runner disables local embeddings by default. These suites are
// ABOUT the local semantic tier, so they turn it on and assert hard: a model
// that will not load means paraphrase retrieval is genuinely unavailable, and
// that must fail loudly rather than pass quietly.
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const composio = await import('../../tools/composio-tools.js');
const schemaCache = await import('../../tools/composio-schema-cache.js');
const jit = await import('../../agents/tool-jit.js');
const mcpScope = await import('../mcp-tool-scope.js');
const toolChoice = await import('../../memory/tool-choice-store.js');
const eventlog = await import('../harness/eventlog.js');
const candidates = await import('./capability-candidates.js');
const worker = await import('../../memory/learning-worker.js');

const CALENDAR_SLUG = 'SCHEDULERCO_LIST_EVENTS';
const COLD_PHRASE = "What's on my calendar tomorrow?";
const PARAPHRASE = 'Anything on deck tomorrow?';

/** The provider payload a verified read returns — replaced ONLY here. */
function calendarPayload() {
  return {
    successful: true,
    data: {
      items: [
        { id: 'evt-1', summary: 'Standup', start: '2026-08-06T09:00:00-07:00' },
        { id: 'evt-2', summary: 'Design review', start: '2026-08-06T11:30:00-07:00' },
      ],
    },
  };
}

/** Drive ONE governed read through the production gateway for a session. */
async function governedRead(sessionId: string, args: Record<string, unknown>): Promise<{ output: string; dispatches: number }> {
  // The live contract the capability binds to — production deposits this at
  // discovery time; the test owns the provider catalog the same way it owns
  // the network function.
  schemaCache.rememberToolSchema(CALENDAR_SLUG, {
    type: 'object', properties: { timeMin: { type: 'string' }, timeMax: { type: 'string' } },
  });
  let dispatches = 0;
  const exec = (async () => { dispatches += 1; return calendarPayload(); }) as never;
  const output = await composio.runComposioExecuteForTestInSession(CALENDAR_SLUG, args, exec, sessionId);
  await worker.drainPendingLearning();
  return { output, dispatches };
}

/** Record an accepted user turn the way production does, so learning has an
 *  exact {sessionId, sourceUserSeq} to bind to. */
function acceptSource(sessionId: string, text: string): { sourceUserSeq: number } {
  if (!eventlog.getSession(sessionId)) {
    eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: text.slice(0, 60) });
  }
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  const event = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text, attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  return { sourceUserSeq: event.seq };
}

// ─── A1: a verified successful read is LEARNED ───────────────────────────────

test('A1: one verified governed read teaches memory the exact capability for this scope', async () => {
  const sessionId = 'sess-a1-home';
  acceptSource(sessionId, COLD_PHRASE);
  const { output, dispatches } = await governedRead(sessionId, { timeMin: '2026-08-06', timeMax: '2026-08-07' });
  assert.equal(dispatches, 1, 'the cold turn made exactly one governed provider dispatch');
  assert.ok(output.length > 0);

  // PRODUCT BEHAVIOR: after a verified success, memory can serve this
  // capability back for a later prompt. Nothing in this assertion knows how
  // learning is implemented.
  const remembered = toolChoice.matchToolChoicesForStep(COLD_PHRASE, { limit: 5 });
  assert.ok(
    remembered.some((match) => match.identifier === CALENDAR_SLUG),
    'a verified successful read did not become a remembered capability — nothing learned from the settled turn',
  );
});

// ─── A2: the paraphrase RETRIEVES the capability (advisory, not authority) ───

test('A2: a natural paraphrase retrieves the learned capability into the real JIT surface', async () => {
  const sessionId = 'sess-a2-home';
  acceptSource(sessionId, COLD_PHRASE);
  await governedRead(sessionId, { timeMin: '2026-08-06', timeMax: '2026-08-07' });

  // The paraphrase shares ONE token with what the user actually said and names
  // neither the provider nor the operation. Lexical retrieval cannot bridge it.
  const lexicalOnly = toolChoice.matchToolChoicesForStep(PARAPHRASE, { limit: 5 });
  assert.equal(lexicalOnly.some((m) => m.identifier === CALENDAR_SLUG), false,
    'this test no longer proves the semantic tier — the paraphrase now matches lexically');

  assert.equal(await candidates.warmCapabilityRetrieval(), true,
    'the bundled local retrieval model did not load — semantic candidates are unavailable');
  const resolved = await candidates.resolveTurnCapabilityCandidates({ userInput: PARAPHRASE });
  assert.equal(resolved.semanticApplied, true, 'the semantic tier did not run for this turn');
  assert.ok(resolved.candidates.some((c) => c.identifier === CALENDAR_SLUG && c.via === 'semantic'),
    'the paraphrase retrieved no candidate — the learned capability is not reachable on a later turn');

  // Reachability is the point: the carrier must survive JIT pruning so the
  // brain can actually call what retrieval surfaced.
  const surface = [
    { name: 'composio_execute_tool', description: 'execute a connected app tool' },
    ...Array.from({ length: 40 }, (_, i) => ({ name: `filler_tool_${i}`, description: 'unrelated' })),
  ];
  const selection = await jit.selectToolsForTurn({
    userInput: PARAPHRASE, tools: surface, recallPinned: resolved.pinnedTools,
  });
  assert.equal(selection.exposed.has('composio_execute_tool'), true,
    'the retrieved capability’s carrier was pruned from the turn — the brain cannot reach it');

  // Retrieval is ADVISORY: it may not narrow what the brain is allowed to pick.
  const scope = mcpScope.resolveMcpToolScopeWithRecall({
    userInput: PARAPHRASE, learnedMatches: resolved.matches,
  });
  assert.notEqual(scope.maxTools, 0, 'a retrieved candidate closed the connector surface');
});

// ─── A3: the exact repeat is an exact alias hit ──────────────────────────────

test('A3: repeating the paraphrase resolves through an exact learned alias', async () => {
  const sessionId = 'sess-a3-home';
  acceptSource(sessionId, PARAPHRASE);
  await governedRead(sessionId, { timeMin: '2026-08-06', timeMax: '2026-08-07' });

  const exact = toolChoice.matchToolChoicesForStep(PARAPHRASE, { limit: 5 });
  assert.ok(exact.some((match) => match.identifier === CALENDAR_SLUG),
    'the exact repeat of a phrase that already succeeded is not an alias hit');
});

// ─── A4: only VERIFIED success learns ────────────────────────────────────────

test('A4: failure, ambiguity, and unverified payloads never learn', async () => {
  const cases: Array<[string, unknown]> = [
    ['provider failure', { successful: false, error: 'upstream 500' }],
    ['empty unverified', { successful: true, data: null }],
    ['queued async', { successful: true, data: { status: 'queued', jobId: 'j-1' } }],
  ];
  for (const [label, payload] of cases) {
    const sessionId = `sess-a4-${label.replace(/\W+/g, '-')}`;
    const phrase = `check the ${label} calendar situation`;
    acceptSource(sessionId, phrase);
    const exec = (async () => payload) as never;
    await composio.runComposioExecuteForTestInSession('SCHEDULERCO_UNVERIFIED', { q: label }, exec, sessionId);
    await worker.drainPendingLearning();
    const learned = toolChoice.matchToolChoicesForStep(phrase, { limit: 5 });
    assert.equal(learned.some((match) => match.identifier === 'SCHEDULERCO_UNVERIFIED'), false,
      `${label} was learned as a proven capability — only verified success may teach`);
  }
});

// ─── A5: historical concrete arguments are never replayed ───────────────────

test('A5: a learned procedure never replays a resolved historical date', async () => {
  const sessionId = 'sess-a5-home';
  acceptSource(sessionId, COLD_PHRASE);
  await governedRead(sessionId, { timeMin: '2026-08-06T00:00:00-07:00', timeMax: '2026-08-07T00:00:00-07:00' });

  const procedure = toolChoice.resolveToolProcedureForIdentifier(CALENDAR_SLUG);
  const serialized = JSON.stringify(procedure ?? {});
  assert.equal(/2026-08-06T00:00:00/.test(serialized), false,
    'a concrete resolved date from the learning turn is stored as replayable argument state');
});

// ─── A6: ordinary unrelated chat pays nothing ───────────────────────────────

test('A6: unrelated ordinary chat retrieves no candidate and adds no catalog work', async () => {
  const sessionId = 'sess-a6-home';
  acceptSource(sessionId, COLD_PHRASE);
  await governedRead(sessionId, { timeMin: '2026-08-06', timeMax: '2026-08-07' });

  const unrelated = 'what do you think about the plan for next quarter?';
  const pinned = jit.recallPinnedBuiltinTools(unrelated);
  assert.equal(pinned.includes(CALENDAR_SLUG), false,
    'an unrelated question pinned a calendar capability — retrieval is not bounded');
  const matches = toolChoice.matchToolChoicesForStep(unrelated, { limit: 5 });
  assert.equal(matches.some((match) => match.identifier === CALENDAR_SLUG), false,
    'an unrelated question matched the learned calendar capability');

  // The semantic tier is the one that could over-reach, so it is checked WARM.
  await candidates.warmCapabilityRetrieval();
  const resolved = await candidates.resolveTurnCapabilityCandidates({ userInput: unrelated });
  assert.equal(resolved.candidates.length, 0,
    'ordinary chat retrieved a capability candidate — the semantic floor is too low');
  assert.deepEqual(resolved.pinnedTools, [],
    'ordinary chat pinned tool schemas it will never use');
});
