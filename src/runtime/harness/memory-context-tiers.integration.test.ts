/**
 * Memory context in three tiers, end to end through the production host turn.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/memory-context-tiers.integration.test.ts
 *
 * A chat turn is driven through runConversation (host_v1) with the real
 * orchestrator agent and a recording brain, so what is asserted is the exact
 * ModelRequest the wire adapters receive:
 *   - the memory core (identity, profile, autonomy, enforced rules) sits
 *     before the prompt-cache boundary and is byte-identical across sessions
 *     and requests;
 *   - request-ranked memory reaches the model once, as one tail built by the
 *     shared ranker, instead of per-block rankers plus a separate primer;
 *   - when the ranker gives no signal (switched off, failing, out of time)
 *     the per-block rendering stands in, and when it finds nothing only the
 *     counts pointer is sent;
 *   - the owner's clock is stated once, last in the per-turn context;
 *   - the accepted request's memory record (version 2) names every section
 *     sent, by tier, and the console reads it back without memory text.
 * Each later tier adds its own pins below.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-tiers-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: HOME,
  CLEMMY_TEST_ISOLATED_HOME: '1',
  MCP_AUTO_IMPORT_ENABLED: 'false',
  EMBEDDINGS_DISABLED: 'true',
  OPENAI_AGENTS_DISABLE_TRACING: '1',
  CLEMMY_COMPLETION_REVIEW: 'off',
  AUTH_MODE: 'codex_oauth',
  MODEL_ROUTING_MODE: 'off',
  CLEMMY_MODEL_ROLES: '[]',
  HARNESS_TOOL_BRACKETS: 'on',
  CLEMMY_TOOL_JIT: 'on',
  CLEMMY_CODEX_TOOL_SEARCH: 'on',
  CLEMMY_SEMANTIC_RECALL: 'off',
  CLEMMY_DEBATE_MODE: 'off',
  CLEMMY_JEV: 'off',
});
delete process.env.TYPESAFE_API_KEY;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-memory-tiers\n');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('no network in the memory-tiers fixture'); };

const eventlog = await import('./eventlog.js');
const { runConversation } = await import('./loop.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { rememberFact } = await import('../../memory/facts.js');
const turnPrimer = await import('../../memory/turn-primer.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
const {
  CACHE_BREAK_SENTINEL,
  CACHE_MEMORY_CORE_SENTINEL,
} = await import('./model-wire-registry.js');

semanticPorts.installTurnSemanticModelPort({
  async interpret() { throw new Error('no hidden work plan in this fixture'); },
} as never);

// A dispatch-enforced rule (compiled to a deterministic sender contract) and
// an ordinary project fact.
const DISPATCH_RULE = 'Email sending constraint: ALWAYS send email via the Outlook mailbox owner@example.com. NEVER send from any other connected mailbox unless explicitly directed in the current conversation.';
rememberFact({ kind: 'constraint', content: DISPATCH_RULE });
rememberFact({ kind: 'project', content: 'The quokka ledger lives in the finance workspace and closes on the fifth business day.' });
rememberFact({ kind: 'project', content: 'Invoices are reviewed on Tuesdays by the operations desk.' });
// A rule only the prompt enforces (no deterministic contract) and a personal
// fact: neither belongs to the memory core.
const PROMPT_ONLY_RULE = 'Never quote competitor pricing figures in anything written for a client.';
rememberFact({ kind: 'constraint', content: PROMPT_ONLY_RULE });
rememberFact({ kind: 'user', content: 'The owner has a daughter named Wren who turns nine in October.' });

after(() => {
  semanticPorts.installTurnSemanticModelPort(null);
  eventlog.closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(HOME, { recursive: true, force: true });
});

export type Frame = { system: string; input: unknown[]; tools: string[] };

/** A brain that answers in one frame and keeps what it was sent. */
function recordingBrain(label: string) {
  const frames: Frame[] = [];
  return {
    frames,
    async getResponse(rawRequest: unknown) {
      const request = rawRequest as { systemInstructions?: string; input?: unknown; tools?: Array<{ name?: string }> };
      frames.push({
        system: request.systemInstructions ?? '',
        input: Array.isArray(request.input) ? request.input : [],
        tools: (request.tools ?? []).map((tool) => tool.name ?? ''),
      });
      return {
        responseId: `${label}-${frames.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output: [{
          type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: `Here is what I found (${label}).` }],
        }],
      };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
}

async function hostTurn(label: string, request: string) {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: label });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `memory-tiers-${label}:${session.id}` });
  const accepted = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text: request, taskMode: { version: 1, kind: 'normal' },
  } }, { armRunInFlight: true });
  const brain = recordingBrain(label);
  const result = await runConversation({ sessionId: session.id, sourceUserSeq: accepted.seq, input: request,
    reuseRecordedUserInput: true, runAttemptId: attempt.attemptId, turnEngine: 'host_v1', maxSteps: 1, maxTurns: 4,
    toolCallsPerTurn: 8, judgeCompletion: false,
    buildAgent: async (context) => buildOrchestratorAgent({ sessionId: context.sessionId,
      sourceUserSeq: context.sourceUserSeq, hostFreshPlanning: context.hostFreshPlanning, userInput: request,
      allowToolJit: true, model: brain as never }),
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } }) as never,
  });
  const trace = eventlog.listEvents(session.id);
  assert.equal(result.status, 'completed', `${label}: the turn completes: ${JSON.stringify(trace.map((event) => event.type).slice(-20))}`);
  assert.ok(brain.frames.length > 0, `${label}: the brain was called`);
  return { sessionId: session.id, sourceUserSeq: accepted.seq, frames: brain.frames, trace };
}

function stableHalf(system: string): string {
  const at = system.indexOf(CACHE_BREAK_SENTINEL);
  assert.ok(at > 0, 'the request carries one cache boundary');
  return system.slice(0, at);
}

test('the memory core rides in the cached prefix, byte-identical across sessions and requests', async () => {
  const first = await hostTurn('core-a', 'What closes on the fifth business day?');
  const second = await hostTurn('core-b', 'Draft a short note about the weekly planning meeting.');
  const a = stableHalf(first.frames[0]!.system);
  const b = stableHalf(second.frames[0]!.system);
  assert.equal(a, b, 'two sessions with different requests share one cached prefix, memory core included');
  const coreAt = a.indexOf(CACHE_MEMORY_CORE_SENTINEL);
  assert.ok(coreAt > 0, 'the core follows the rubric, behind its own marker');
  const core = a.slice(coreAt);
  assert.match(core, /# Persistent Context/);
  assert.match(core, /## Autonomy/);
  assert.match(core, /## Standing Policies\n\*\*Dispatch-enforced constraints\*\*/);
  assert.equal(core.split('ALWAYS send email via the Outlook mailbox owner@example.com').length - 1, 1,
    'the enforced rule is stated once, in the core');
  assert.doesNotMatch(core, /Today is \d{4}|Right now it is/, 'no clock in the core');
  assert.doesNotMatch(core, /quokka ledger/, 'no request-ranked fact in the core');
  const dynamic = first.frames[0]!.system.slice(first.frames[0]!.system.indexOf(CACHE_BREAK_SENTINEL));
  assert.doesNotMatch(dynamic, /## Autonomy|## Standing Policies|# Persistent Context/,
    'nothing from the core is repeated after the boundary');
  assert.doesNotMatch(dynamic, /ALWAYS send email via the Outlook mailbox owner@example\.com/,
    'the enforced rule is not repeated after the boundary');
});

/** Every text the request carries, instructions and input items alike. */
function requestText(frame: Frame): string {
  return [frame.system, ...frame.input.map((item) => JSON.stringify(item))].join('\n');
}

/** The system input item that carries the ranked tail, if any. */
function tailItem(frame: Frame): string | undefined {
  for (const item of frame.input) {
    const row = item as { role?: string; content?: unknown };
    const text = typeof row.content === 'string'
      ? row.content
      : Array.isArray(row.content) ? row.content.map((part) => (part as { text?: string }).text ?? '').join('') : '';
    if (row.role === 'system' && text.includes('## Relevant To This Request')) return text;
  }
  return undefined;
}

test('request-ranked memory arrives once, as one bounded tail from the shared ranker', async () => {
  const run = await hostTurn('tail', 'When does the quokka ledger close each month?');
  const frame = run.frames[0]!;
  const tail = tailItem(frame);
  assert.ok(tail, `the ranked tail rides the request: ${requestText(frame).slice(-3000)}`);
  assert.match(tail!, /quokka ledger lives in the finance workspace/, 'the relevant fact is in it');
  assert.match(tail!, /\[ref fact:\d+\]/, 'each line names the ref to reopen');
  assert.match(tail!, /memory_recall_all searches all of it/, 'a counts pointer widens it');
  const { countActiveFacts } = await import('../../memory/facts.js');
  const shownFacts = new Set([...tail!.matchAll(/\[ref fact:(\d+)\]/g)].map((match) => match[1])).size;
  const beyond = Number(/_Memory on file beyond this view: (\d+) facts?/.exec(tail!)?.[1]);
  assert.equal(beyond, countActiveFacts() - shownFacts, 'the pointer counts only the facts the tail does not show');
  const ranked = tail!.slice(0, tail!.indexOf('_Memory on file beyond this view'));
  assert.ok(ranked.trim().length <= 1_200, `the ranked part stays within its budget (${ranked.trim().length})`);
  assert.doesNotMatch(tail!, /owner@example\.com/, 'a rule the core already carries is not repeated');
  const all = requestText(frame);
  for (const retired of ['## Persistent Facts', '## Recently Learned', '## Data Landscape', '## Remembered Tool Choices', '[MEMORY PRIMER]']) {
    assert.equal(all.includes(retired), false, `no separately ranked block: ${retired}`);
  }
  const recorded = run.trace.filter((event) => event.type === 'turn_memory_primer').at(-1)?.data as Record<string, unknown>;
  assert.equal(recorded?.source, 'unified', 'the shared ranker produced it');
  assert.equal(recorded?.injected, true);
});

/** The system input item that carries memory from the turn's tail. */
function memoryItem(frame: Frame, marker: string): string | undefined {
  for (const item of frame.input) {
    const row = item as { role?: string; content?: unknown };
    const text = typeof row.content === 'string'
      ? row.content
      : Array.isArray(row.content) ? row.content.map((part) => (part as { text?: string }).text ?? '').join('') : '';
    if (row.role === 'system' && text.includes(marker)) return text;
  }
  return undefined;
}

async function assertNoSignalFallback(label: string, arrange: () => void, restore: () => void) {
  arrange();
  let run: Awaited<ReturnType<typeof hostTurn>>;
  try {
    run = await hostTurn(label, 'When does the quokka ledger close each month?');
  } finally {
    restore();
  }
  const frame = run.frames[0]!;
  const all = requestText(frame);
  const fallback = memoryItem(frame, '## Persistent Facts');
  assert.ok(fallback, `${label}: the per-block rendering stands in: ${all.slice(-2500)}`);
  assert.match(fallback!, /Invoices are reviewed on Tuesdays/, `${label}: Persistent Facts ranked as before`);
  assert.equal(fallback!.split('quokka ledger lives in the finance workspace').length - 1, 1,
    `${label}: the request's fact is in the fallback once, whichever block lists it`);
  assert.doesNotMatch(fallback!, /owner@example\.com/, `${label}: the core's rule is not repeated`);
  assert.equal(all.includes('## Relevant To This Request'), false, `${label}: no ranked tail without a ranker`);
  const cacheBoundary = frame.system.indexOf(CACHE_BREAK_SENTINEL);
  assert.equal(frame.system.slice(cacheBoundary).includes('## Persistent Facts'), false,
    `${label}: the fallback rides with the tail, not in the instructions`);
}

test('no signal: with the ranker switched off, the per-block memory stands in', async () => {
  const previous = process.env.CLEMMY_UNIFIED_TURN_PRIMER;
  await assertNoSignalFallback('ranker-off',
    () => { process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off'; },
    () => { if (previous === undefined) delete process.env.CLEMMY_UNIFIED_TURN_PRIMER; else process.env.CLEMMY_UNIFIED_TURN_PRIMER = previous; });
});

test('no signal: when the ranker fails, the per-block memory stands in', async () => {
  await assertNoSignalFallback('ranker-error',
    () => turnPrimer._setUnifiedTurnPrimerRecallForTest(async () => { throw new Error('ranker unavailable'); }),
    () => turnPrimer._setUnifiedTurnPrimerRecallForTest(null));
});

test('no signal: when the ranker runs out of time, the per-block memory stands in', async () => {
  await assertNoSignalFallback('ranker-timeout',
    () => turnPrimer._setUnifiedTurnPrimerRecallForTest(async () => await new Promise(() => { /* never answers */ })),
    () => turnPrimer._setUnifiedTurnPrimerRecallForTest(null));
});

test('an empty ranked result sends only the counts pointer', async () => {
  turnPrimer._setUnifiedTurnPrimerRecallForTest(async (objective) => ({
    objective, hits: [], perStore: {}, answerability: 'insufficient', purpose: 'ambient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 1 },
  }));
  let run: Awaited<ReturnType<typeof hostTurn>>;
  try {
    run = await hostTurn('ranker-empty', 'When does the quokka ledger close each month?');
  } finally {
    turnPrimer._setUnifiedTurnPrimerRecallForTest(null);
  }
  const frame = run.frames[0]!;
  const pointer = memoryItem(frame, '_Memory on file beyond this view');
  assert.ok(pointer, `the pointer is sent: ${requestText(frame).slice(-2000)}`);
  assert.match(pointer!, /^_Memory on file beyond this view: \d+ facts?[^\n]*memory_recall_all searches all of it for this request\._$/,
    'the pointer alone: nothing ranked, no per-block rendering');
  const all = requestText(frame);
  for (const absent of ['## Relevant To This Request', '## Persistent Facts', '[MEMORY PRIMER]', 'quokka ledger lives']) {
    assert.equal(all.includes(absent), false, `nothing ranked rides the empty turn: ${absent}`);
  }
});

test('the clock is stated once in the request, last in the per-turn memory', async () => {
  const run = await hostTurn('clock', 'Draft a short note about the weekly planning meeting.');
  const system = run.frames[0]!.system;
  assert.equal(system.split('Right now it is').length - 1, 1, 'one clock in the whole request');
  assert.doesNotMatch(system, /Today is \d{4}|## Now\n/, 'no second clock');
  assert.match(system.trimEnd(), /## Right Now\nRight now it is \w+day, \d{4}-\d{2}-\d{2}, \d{2}:\d{2} \(.+\)\. Use this for any date\/time math, never invent or guess\.$/,
    'the clock closes the per-turn memory, next to the message');
});

test('the accepted request records what memory it sent, by tier, and the console reads it back', async () => {
  const run = await hostTurn('manifest', 'When does the quokka ledger close each month?');
  const row = run.trace.filter((event) => event.type === 'guardrail_tripped'
    && (event.data as { kind?: string }).kind === 'model_memory_context').at(-1)?.data as Record<string, unknown> | undefined;
  assert.ok(row, 'the accepted request recorded its memory');
  assert.equal(row!.version, 2);
  const manifest = row!.manifest as Array<{ section: string; tier: string; tokens: number; bytes: number; refs: Array<{ type: string; id: string }> }>;
  const tiers = new Set(manifest.map((entry) => entry.tier));
  assert.deepEqual([...tiers].sort(), ['core', 'now', 'relevant'], JSON.stringify(manifest));
  assert.ok(manifest.some((entry) => entry.tier === 'core' && entry.section === 'Standing Policies' && entry.refs.some((ref) => ref.type === 'policy')));
  assert.ok(manifest.some((entry) => entry.tier === 'relevant' && entry.section === 'Relevant To This Request' && entry.refs.length > 0),
    JSON.stringify(manifest));
  assert.equal(manifest.filter((entry) => entry.section === 'Memory Pointer').length, 1, 'each section is listed once');
  assert.ok(manifest.some((entry) => entry.tier === 'now' && entry.section === 'Right Now'));
  const { renderMemoryCore } = await import('../../agents/harness-context.js');
  assert.equal(row!.coreSha, renderMemoryCore().sha256, 'the record names the content-addressed core');
  const totals = row!.totals as Record<string, number>;
  assert.equal(totals.tokens, totals.coreTokens + totals.relevantTokens + totals.nowTokens);
  const { acceptedModelMemoryEvidence } = await import('./model-memory-evidence.js');
  assert.match(acceptedModelMemoryEvidence({ sessionId: run.sessionId, sourceUserSeq: run.sourceUserSeq })!,
    /## Relevant To This Request/, 'a reviewer sees the ranked tail the model saw');

  const express = (await import('express')).default;
  const { createServer } = await import('node:http');
  const { registerConsoleRoutes } = await import('../../dashboard/console-routes.js');
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, { getRuntime: () => ({ listPendingApprovals: () => [] }) } as never, { serveLegacyAtRoot: false });
  const server = await new Promise<import('node:http').Server>((resolve) => { const s = createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const res = await originalFetch(`http://127.0.0.1:${port}/api/console/sessions/${encodeURIComponent(run.sessionId)}/memory-sent`);
    assert.equal(res.status, 200);
    const body = await res.json() as { sourceUserSeq: number; version: number; coreSha: string; manifest: unknown[]; totals: Record<string, number> };
    assert.equal(body.sourceUserSeq, run.sourceUserSeq);
    assert.equal(body.version, 2);
    assert.equal(body.coreSha, row!.coreSha);
    assert.deepEqual(body.manifest, manifest);
    assert.equal(JSON.stringify(body).includes('quokka'), false, 'sizes and refs, never memory text');
    const named = await originalFetch(`http://127.0.0.1:${port}/api/console/sessions/${encodeURIComponent(run.sessionId)}/memory-sent?sourceUserSeq=${run.sourceUserSeq}`);
    assert.equal(named.status, 200);
    const missing = await originalFetch(`http://127.0.0.1:${port}/api/console/sessions/no-such-session/memory-sent`);
    assert.equal(missing.status, 404);
    const bad = await originalFetch(`http://127.0.0.1:${port}/api/console/sessions/${encodeURIComponent(run.sessionId)}/memory-sent?sourceUserSeq=abc`);
    assert.equal(bad.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** The primer record of the turn, as the host logged it. */
function primerRecord(run: Awaited<ReturnType<typeof hostTurn>>): Record<string, unknown> {
  return (run.trace.filter((event) => event.type === 'turn_memory_primer').at(-1)?.data ?? {}) as Record<string, unknown>;
}

// Regression: a turn whose ranker was skipped on purpose (budget, opt-out)
// once reached the model with none of the request-ranked memory it had
// before the tail replaced the per-block sections.
for (const [label, request] of [
  ['skip-casual', 'thanks, that is perfect'],
  ['skip-conversation', 'make the subject line punchier'],
] as const) {
  test(`a turn the ranker skips for its intent still carries the owner's rules and facts (${label})`, async () => {
    const run = await hostTurn(label, request);
    assert.equal(primerRecord(run).skippedReason, 'intent_budget', 'the ranker was not run for this intent');
    const frame = run.frames[0]!;
    const all = requestText(frame);
    const fallback = memoryItem(frame, '## Persistent Facts');
    assert.ok(fallback, `the per-block rendering stands in for the ranker: ${all.slice(-2500)}`);
    assert.match(fallback!, /\*\*Prompt-only instructions/, 'the prompt-only group is listed');
    assert.ok(fallback!.includes(PROMPT_ONLY_RULE), 'the prompt-only rule reaches the model');
    assert.match(fallback!, /daughter named Wren/, 'a remembered fact reaches the model');
    assert.doesNotMatch(fallback!, /owner@example\.com/, 'the core\'s rule is not repeated');
    assert.equal(all.split(PROMPT_ONLY_RULE).length - 1, 1, 'the rule is stated once');
    const memorySent = run.trace.filter((event) => event.type === 'guardrail_tripped'
      && (event.data as { kind?: string }).kind === 'model_memory_context').at(-1)?.data as { manifest?: Array<{ section: string; tier: string }> } | undefined;
    assert.ok(memorySent?.manifest?.some((entry) => entry.section === 'Persistent Facts' && entry.tier === 'relevant'),
      'the memory record names what stood in');
  });
}

test('a request that declines memory still carries the standing policies it is held to, and no facts', async () => {
  const run = await hostTurn('skip-opt-out',
    'Do not use memory for this request. Draft a client note comparing our pricing with a competitor.');
  assert.equal(primerRecord(run).skippedReason, 'explicit_request_opt_out');
  const frame = run.frames[0]!;
  const all = requestText(frame);
  const policies = memoryItem(frame, '## Persistent Facts');
  assert.ok(policies, `the request's standing policies are sent: ${all.slice(-2500)}`);
  assert.ok(policies!.includes(PROMPT_ONLY_RULE), 'the prompt-only rule still applies');
  for (const absent of ['daughter named Wren', 'quokka ledger', 'Invoices are reviewed', '## Recently Learned',
    '## Relevant To This Request', 'memory_recall_all searches all of it']) {
    assert.equal(all.includes(absent), false, `no remembered fact or recall invitation: ${absent}`);
  }
  assert.ok(stableHalf(frame.system).includes('ALWAYS send email via the Outlook mailbox owner@example.com'),
    'the enforced rule stays in the core');
});
