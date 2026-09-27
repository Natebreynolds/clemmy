/**
 * The readers of a retained result never read a copy of a copy.
 *
 * A recall that travelled through `call_tool` is recorded under the carrier's
 * name, with the inner reader only in `effectiveTool` and the carrier's
 * `{name,args_json}` envelope. Every reader addressed at THAT recall's call id
 * must reach the original producer's bytes: recall pages the producer,
 * tool_output_query queries the producer, and file_query searches the producer
 * instead of refusing a presentation-only reader.
 *
 * Drives the real host runner, the real call_tool carrier, the real event-log
 * hooks and the real registered reader handlers in an isolated home.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/retained-reader-lineage.integration.test.ts
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const lineageHome = mkdtempSync(path.join(os.tmpdir(), 'clem-reader-lineage-'));
process.env.CLEMENTINE_HOME = lineageHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
// Readers are host code: the same answers with Jev off and no Jev key.
process.env.CLEMMY_JEV = 'off';
mkdirSync(path.join(lineageHome, 'state'), { recursive: true });
writeFileSync(path.join(lineageHome, 'state', 'machine-id'), 'machine-reader-lineage\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const capabilityCatalogs = await import('./host-capability-catalog-factory.js');
const capabilityManifestStores = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const writeCapabilityStore = await import('../../memory/verified-write-capability-store.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const { attachEventLogHooks } = await import('./hooks.js');
const { spaceStore } = await import('../../spaces/store.js');
const { closeWorkspaceDb } = await import('../../spaces/workspace-db.js');

after(() => {
  writeCapabilityStore.closeVerifiedWriteCapabilityStoreForTests();
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  capabilityManifestStores.installCapabilityManifestStore(null);
  closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(lineageHome, { recursive: true, force: true });
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{ usage?: Record<string, unknown>; output?: unknown[]; responseId?: string }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = response.output ?? [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (item as { type?: string }).type === 'function_call') ? 'tool_calls' : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'lineage-response',
      usage: {
        inputTokens: Number(response.usage?.inputTokens ?? 0),
        outputTokens: Number(response.usage?.outputTokens ?? 0),
        totalTokens: Number(response.usage?.totalTokens ?? 0),
      },
      output,
    },
  } as never;
}

function stubModel(responses: unknown[][]) {
  let call = 0;
  return {
    calls: () => call,
    async getResponse() {
      const output = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output,
        responseId: `lineage-response-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

const textMessage = (text: string) => ({
  type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }],
});
const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call', callId, name, arguments: JSON.stringify(args),
});

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own the turn');
  };
  return runner;
}

function historyResult(history: unknown[], callId: string): string {
  const result = history.find((item) => item && typeof item === 'object'
    && (item as { type?: unknown }).type === 'function_call_result'
    && (item as { callId?: unknown }).callId === callId) as { output?: unknown } | undefined;
  assert.ok(result, `missing actual result for ${callId}`);
  const output = result.output;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && typeof (output as { text?: unknown }).text === 'string') {
    return (output as { text: string }).text;
  }
  throw new Error(`Expected model-visible text for ${callId}, got ${JSON.stringify(output)}`);
}

test('recall, query and search addressed at a carrier-dispatched recall all read the original producer', async () => {
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const slug = 'lineage-orchard-board';
  // A fictional board large enough that its middle is far past a small recall
  // slice. The distinctive phrase lives in the LAST row, so only a reader that
  // reaches the producer (not the recall's 1,500-char copy) can find it.
  const rows = Array.from({ length: 40 }, (_, index) => ({
    plot: `Plot ${index + 1}`,
    variety: index % 2 === 0 ? 'Honeycrisp' : 'Gala',
    note: `Routine pruning check number ${index + 1} completed without findings.`,
  }));
  rows.push({ plot: 'Plot 41', variety: 'Northern Spy', note: 'Quartzfeather irrigation valve replaced.' });
  spaceStore.save({ id: slug, title: 'Orchard plot board', initialData: { rows },
    viewContent: '<!doctype html><html><body><p>Orchard plots</p></body></html>' });
  const session = eventlog.createSession({ id: 'reader-lineage-session', kind: 'chat' });
  const objective = 'Read my saved orchard board and tell me which plot had its irrigation valve replaced.';
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: objective } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);

  const model = stubModel([
    [toolCall('lineage-space', 'call_tool', { name: 'space_get', args_json: JSON.stringify({ slug }) })],
    [toolCall('lineage-recall', 'call_tool', { name: 'recall_tool_result',
      args_json: JSON.stringify({ call_id: 'lineage-space', max_chars: 1500 }) })],
    [toolCall('lineage-recall-of-recall', 'recall_tool_result', { call_id: 'lineage-recall', offset: 3000, max_chars: 2000 })],
    [toolCall('lineage-query-of-recall', 'tool_output_query', { call_id: 'lineage-recall', fields: ['plot', 'note'],
      filter_field: 'variety', filter_equals: 'Northern Spy' })],
    [toolCall('lineage-search-of-recall', 'call_tool', { name: 'file_query',
      args_json: JSON.stringify({ call_id: 'lineage-recall', query: 'Quartzfeather irrigation valve' }) })],
    [textMessage('Plot 41 had its irrigation valve replaced.')],
  ]);
  const agent = await buildOrchestratorAgent({ userInput: objective, ...identity,
    hostFreshPlanning: primed.planning, allowedToolNames: ['space_get', 'recall_tool_result', 'tool_output_query', 'file_query', 'tool_search'], allowToolJit: true,
    mcpToolScope: { authority: 'none', reason: 'Reader lineage integration has no external authority',
      allowedServerSlugs: [], toolPatterns: [], maxTools: 0 }, model: model as never });
  // The production loop attaches the event-log hooks to the runner; they write
  // the top-level lifecycle rows every reader resolves lineage from.
  const runner = throwingRunner();
  const detach = attachEventLogHooks(runner as never, { getSessionId: () => session.id, getTurn: () => source.turn });
  const outcome = await brackets.withHarnessRunContext({ ...identity,
    counter: new brackets.ToolCallsCounter(12), behaviorScopeId: `${session.id}::source:${source.seq}` },
    () => hostRunRunner(runner as never, agent as never,
      [{ type: 'message', role: 'user', content: objective }] as never,
      { maxTurns: 8, hostTurnEngine: 'host_v1', context: identity } as never));
  detach();
  const history = outcome.history as unknown[];

  // The carrier really recorded the recall under call_tool.
  const recallCall = eventlog.listEvents(session.id, { types: ['tool_called'] })
    .find((event) => event.data.callId === 'lineage-recall' && event.data.accounting !== 'transport_mirror');
  assert.ok(recallCall, 'the carrier-dispatched recall has a durable lifecycle');
  assert.equal(recallCall.data.tool, 'call_tool');
  assert.equal(recallCall.data.effectiveTool, 'recall_tool_result');

  const producer = eventlog.getToolOutput(session.id, 'lineage-space');
  assert.ok(producer && producer.output.length > 4_000, 'the producer is larger than the recall copy');

  const recallOfRecall = historyResult(history, 'lineage-recall-of-recall');
  assert.match(recallOfRecall, new RegExp(`Recalled chars 3000–5000 of ${producer.output.length}\\b`),
    'recall on the recall id pages the producer, not the recall text');
  assert.ok(recallOfRecall.includes(producer.output.slice(3000, 3100)), 'the slice is the producer bytes at that offset');

  // The producer is prose with a pseudo-call before its dataset; the query
  // reaches the dataset records, not the recall header's JSON hint.
  const query = historyResult(history, 'lineage-query-of-recall');
  assert.match(query, /Plot 41/);
  assert.match(query, /Quartzfeather irrigation valve replaced/);
  assert.doesNotMatch(query, /No JSON value could be recovered|None of/);

  const search = historyResult(history, 'lineage-search-of-recall');
  assert.match(search, /Quartzfeather irrigation valve replaced/);
  assert.doesNotMatch(search, /presentation-only|cannot be used/);
});

test('a text result digested on the real carrier path names recall and file_query, never the record query', async () => {
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const slug = 'lineage-orchard-notes';
  // A saved view is text with no structured records in it, longer than any
  // presentation budget a carrier can give it, so the read is digested.
  const paragraphs = Array.from({ length: 800 }, (_, index) =>
    `<p>Walk ${index + 1}: the east rows were checked for frost damage and the mulch was topped up.</p>`).join('\n');
  spaceStore.save({ id: slug, title: 'Orchard walk notes', initialData: { rows: [] },
    viewContent: `<!doctype html><html><head><style>body{margin:0}</style></head><body>\n${paragraphs}\n</body></html>` });
  const session = eventlog.createSession({ id: 'reader-digest-session', kind: 'chat' });
  const objective = 'Read the saved orchard walk notes view.';
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: objective } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  const model = stubModel([
    [toolCall('digest-view', 'call_tool', { name: 'space_get_view',
      args_json: JSON.stringify({ slug, grep: null, around: null }) })],
    [textMessage('The notes record eight hundred orchard walks.')],
  ]);
  const agent = await buildOrchestratorAgent({ userInput: objective, ...identity,
    hostFreshPlanning: primed.planning, allowedToolNames: ['space_get_view', 'recall_tool_result', 'tool_output_query', 'file_query', 'tool_search'],
    allowToolJit: true,
    mcpToolScope: { authority: 'none', reason: 'Reader digest integration has no external authority',
      allowedServerSlugs: [], toolPatterns: [], maxTools: 0 }, model: model as never });
  const runner = throwingRunner();
  const detach = attachEventLogHooks(runner as never, { getSessionId: () => session.id, getTurn: () => source.turn });
  const outcome = await brackets.withHarnessRunContext({ ...identity,
    counter: new brackets.ToolCallsCounter(6), behaviorScopeId: `${session.id}::source:${source.seq}` },
    () => hostRunRunner(runner as never, agent as never,
      [{ type: 'message', role: 'user', content: objective }] as never,
      { maxTurns: 4, hostTurnEngine: 'host_v1', context: identity } as never));
  detach();
  const visible = historyResult(outcome.history as unknown[], 'digest-view');
  const footer = visible.slice(visible.lastIndexOf('[digest:'));
  assert.match(footer, /\[digest: space_get_view returned/, visible.slice(-1500));
  assert.match(footer, /recall_tool_result \{"call_id":"digest-view"/);
  assert.match(footer, /file_query \{"call_id":"digest-view"/);
  assert.doesNotMatch(footer, /tool_output_query/);
  assert.match(footer, /still pending\.\]/, 'the footer is whole, never cut mid call id');
});
