/**
 * Stage 3(c) pins: the gated local MCP lane types its refusals.
 *
 * Live defect (Aug 8-10 forensics, callId-joined): every governor denial DID
 * bind, but the gated lane returned the refusal as ordinary success-shaped
 * text — no isError on the wire, and the transport_mirror ledger row stamped
 * ok:1 (36 of 36 denials success-shaped on the mirror). The model had to read
 * the sentence to learn nothing happened, and every health metric counted
 * denials as wins.
 *
 * Both pins FAIL on the pre-fix code. The Stage-6 follow-up (directive-carrying
 * refusals rendered via renderTypedRefusalForModel with surviving candidates)
 * lands with recovery consumption; this closes the wire/ledger typing hole.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'gated-refusal-typing-test-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TOOL_GUARDRAIL = 'off';
process.env.CLEMMY_EXECUTION_GATE = 'off';
process.env.CLEMMY_GROUNDING_GATE = 'off';
process.env.CLEMMY_GOAL_FIDELITY_GATE = 'off';
process.env.CLEMMY_CONFIRM_FIRST = 'off';
process.env.CLEMENTINE_MCP_GATED_MUTATIONS = 'on';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { appendEvent, createSession, listEvents } = await import('../runtime/harness/eventlog.js');
const { registerGatedMutatingTools } = await import('./gated-mutating-tools.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');

type Handler = (input: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function mockServer(): { server: unknown; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (...args: unknown[]) => {
      const name = typeof args[0] === 'string' ? (args[0] as string) : '';
      const handler = args.find((a) => typeof a === 'function') as Handler | undefined;
      if (name && handler) handlers.set(name, handler);
    },
  };
  return { server, handlers };
}

const REFUSAL_TEXT =
  'Tool call refused by harness: discovery budget denied (category_budget_exhausted) on tool_search. '
  + 'Use the schema already returned for this task.';

function register(sessionId: string, invokeText: string): Map<string, Handler> {
  process.env.CLEMENTINE_MCP_SESSION_ID = sessionId;
  // Durable settlement requires the accepted-source identity plus a persisted
  // turn graph for the accepted task (authority spine).
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'find me the right tool' },
  });
  const shadow = recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: source.turn },
  });
  if (!shadow) throw new Error('fixture could not persist a turn graph');
  const { server, handlers } = mockServer();
  registerGatedMutatingTools(server as never, {
    sessionId,
    sourceUserSeq: source.seq,
    runScopeId: `${sessionId}::brain:test`,
    directOrchestrator: true,
    runtimeToolsForTest: [{
      name: 'composio_search_tools',
      invoke: async () => invokeText,
    }],
  });
  return handlers;
}

test('a harness refusal carries isError on the wire (was success-shaped text)', async () => {
  const sess = createSession({ kind: 'chat' });
  const handlers = register(sess.id, REFUSAL_TEXT);
  const handler = handlers.get('composio_search_tools');
  assert.ok(handler, 'fixture tool registered');
  const result = await handler({ queries: [{ use_case: 'anything' }] });
  assert.equal(result.isError, true, `refusal reached the model success-shaped: ${JSON.stringify(result).slice(0, 200)}`);
  assert.match(result.content[0]?.text ?? '', /refused by harness/i);
});

test('the transport_mirror ledger row records a refusal as ok:false (was ok:1)', async () => {
  const sess = createSession({ kind: 'chat' });
  const handlers = register(sess.id, REFUSAL_TEXT);
  await handlers.get('composio_search_tools')!({ queries: [{ use_case: 'anything' }] });
  const mirror = listEvents(sess.id).filter((event) =>
    event.type === 'tool_returned'
    && event.data.accounting === 'transport_mirror'
    && event.data.tool === 'composio_search_tools');
  assert.ok(mirror.length >= 1, 'mirror row exists');
  for (const row of mirror) {
    assert.equal(row.data.ok, false, `mirror stamped a refusal ok:${String(row.data.ok)}`);
  }
});

test('ordinary successful text keeps its shape: no isError, mirror ok stays true', async () => {
  const sess = createSession({ kind: 'chat' });
  const handlers = register(sess.id, 'Found 3 tools: OUTLOOK_CREATE_DRAFT, …');
  const result = await handlers.get('composio_search_tools')!({ queries: [{ use_case: 'draft' }] });
  assert.notEqual(result.isError, true, 'a real answer must not be error-shaped');
  const mirror = listEvents(sess.id).filter((event) =>
    event.type === 'tool_returned' && event.data.accounting === 'transport_mirror');
  assert.ok(mirror.length >= 1);
  assert.equal(mirror[0]!.data.ok, true);
});

test('provider-dispatch refusal shapes are typed too', async () => {
  const sess = createSession({ kind: 'chat' });
  const handlers = register(
    sess.id,
    '[provider-dispatch:not-started:ambiguous-account] ⚠️ NEEDS-YOUR-CHOICE (outlook): You have 2 outlook accounts connected.',
  );
  const result = await handlers.get('composio_search_tools')!({ queries: [{ use_case: 'x' }] });
  assert.equal(result.isError, true, 'not-started dispatch refusals are failures, not answers');
});

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
