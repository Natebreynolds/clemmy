/** LIVE05 source155374: selected schema lost JSON encoding instructions; the
 * primary copied a workflow_get display line into workflow-level inputs.
 * Real discovery -> model request -> native carrier -> producer -> settlement.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-input-contract-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true',
  HARNESS_TOOL_BRACKETS: 'on', CLEMMY_COMPLETION_REVIEW: 'off', OPENAI_AGENTS_DISABLE_TRACING: '1' });
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'workflow-input-contract\n');
const savedFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; throw new Error('No external requests in input-contract fixture'); };
const events = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const { discoveryGovernor } = await import('./discovery-governor.js');
const { buildScopedLocalToolSearch } = await import('../../tools/local-runtime-tools.js');
const { buildWorkCall } = await import('../../tools/work-call.js');
const { hostRunRunner, settledSourceArtifacts } = await import('./host-turn-runner.js');
const { readWorkflow } = await import('../../memory/workflow-store.js');
const { DEFAULT_TOOL_RESULT_MAX_CHARS } = await import('./tool-output-format.js');

after(() => { catalogs.installHostCapabilityCatalogFactory(null); manifests.installCapabilityManifestStore(null);
  events.closeEventLog(); globalThis.fetch = savedFetch; rmSync(home, { recursive: true, force: true }); });

// Locate the actual tool result regardless of SDK output text wrapping. This
// reads model request data, never manufactures a replacement schema.
function disclosedBody(value: unknown): any | undefined {
  if (typeof value === 'string') { try { return disclosedBody(JSON.parse(value)); } catch { return undefined; } }
  if (!value || typeof value !== 'object') return undefined;
  if (!Array.isArray(value) && 'schemas' in value && (value as any).schemas?.workflow_create) return value;
  for (const child of Object.values(value)) { const found = disclosedBody(child); if (found) return found; }
  return undefined;
}
const call = (callId: string, name: string, args: unknown) => ({ type: 'function_call', callId, name, arguments: JSON.stringify(args) });

test('selected production workflow inputs instructions reach the primary; example creates once and observed shorthand remains a typed non-write', async () => {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  const session = events.createSession({ kind: 'chat' });
  const prompt = 'Create one manual workflow named Input contract fixture. It drafts a summary from runtime text. Save it without running.';
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  discoveryGovernor.initializeTask({ ...identity, knownCapability: false, claimKeyVersion: 'exact_request_v1' });
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok);
  if (!primed.ok) throw new Error('Fixture planning catalog did not prime');
  const search = brackets.wrapToolForHarness(buildScopedLocalToolSearch(new Set(['workflow_create']), 'work_call', undefined, undefined,
    candidates => semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates })) as never);
  const work = brackets.wrapToolForHarness(buildWorkCall({ requireHostPlan: true, reachableBuiltinNames: new Set(['workflow_create']),
    firstClassNames: new Set(), catalogIdentifiers: ['workflow_create'], settlementLane: 'byo', hostPlanningReady: () => true }) as never);
  let requests = 0;
  let example = '';
  let ref = '';
  let seenDescription = '';
  const malformed = 'text: string — Text supplied at runtime to summarize.';
  const model = {
    async getResponse(request: unknown) {
      requests++;
      let output: unknown[];
      if (requests === 1) output = [call('input-contract-search', 'tool_search', { query: 'workflow_create', role_key: null, limit: 1, account_selection: null })];
      else if (requests === 2) {
        const body = disclosedBody(request);
        assert.ok(body, 'real discovery output must reach the next actual primary request: ' + JSON.stringify(request));
        const schema = body.schemas.workflow_create;
        seenDescription = schema.properties.inputs.description;
        assert.match(seenDescription, /JSON-encoded string/);
        assert.match(seenDescription, /structured steps\[\]\.inputs/);
        example = /Example JSON text: (\{.+\})\./.exec(seenDescription)?.[1] ?? '';
        assert.deepEqual(JSON.parse(example), { text: { type: 'string', description: 'Text supplied at runtime to summarize' } });
        assert.ok(schema.properties.inputs.anyOf.some((branch: any) => branch.type === 'string'));
        const steps = schema.properties.steps;
        const array = steps.type === 'array' ? steps : steps.anyOf.find((branch: any) => branch.type === 'array');
        assert.ok(array.items.properties.inputs.anyOf.some((branch: any) => branch.type === 'object'), 'step binding stays structured');
        const row = body.results.find((item: any) => item.name === 'workflow_create');
        assert.equal(row.carrier, 'work_call');
        assert.equal(row.effect, 'local_write');
        assert.equal(row.example.args.name, 'workflow_create');
        ref = row.capabilityRef;
        assert.equal(row.example.args.requirement_id, ref);
        assert.ok(JSON.stringify(body).length <= DEFAULT_TOOL_RESULT_MAX_CHARS);
        output = [write('input-contract-malformed', malformed)];
      } else if (requests === 3) {
        assert.match(JSON.stringify(request), /Invalid workflow inputs schema JSON/);
        assert.equal(readWorkflow('input-contract-fixture'), null, 'malformed display shorthand must not create anything');
        output = [write('input-contract-valid', example)];
      } else output = [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The manual workflow is saved.' }] }];
      return { responseId: `input-contract-${requests}`, output, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2,
        requests: 1, inputTokensDetails: [], outputTokensDetails: [] } };
    },
    async *getStreamedResponse(request: unknown) { const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  function write(id: string, inputs: string) {
    return call(id, 'work_call', { requirement_id: ref, source_call_ids: null, source_record_ids: null,
      universe_item_id: null, universe_selector: null, seal_amendment: null, name: 'workflow_create', args_json: JSON.stringify({
        name: 'Input contract fixture', description: 'Summarize supplied text.', inputs,
        steps: [{ id: 'summarize', prompt: 'Summarize {{input.text}}.', sideEffect: 'read',
          inputs: { text: { type: 'string', required: true, from: 'input.text' } } }], allowSends: false }) });
  }
  const agent = { model, tools: [search, work] };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [search, work],
    activeToolNames: ['tool_search', 'work_call'], policyHash: 'input-contract-fixture',
    budget: { maxUncachedTokens: 200_000, maxModelCalls: 6, maxToolCalls: 6, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) throw new Error('Fixture capability envelope did not seal');
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope); envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner cannot own this turn'); } });
  const result = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(6),
    behaviorScopeId: `${session.id}::turn:1` }, () => hostRunRunner(runner as never, agent as never,
    [{ type: 'message', role: 'user', content: prompt }] as never,
    { maxTurns: 6, hostTurnEngine: 'host_v1', judgeCompletion: false, context: identity } as never));
  assert.equal(result.terminal, undefined, JSON.stringify(result.terminal));
  assert.equal(requests, 4);
  assert.ok(seenDescription);
  const rows = events.openEventLog().prepare(`SELECT l.tool_name, s.outcome_kind, s.outcome_detail, s.mutating, s.physical_crossing_count
    FROM logical_call_settlements s JOIN logical_tool_calls l
      ON l.session_id=s.session_id AND l.source_user_seq=s.source_user_seq AND l.logical_tool_call_id=s.logical_tool_call_id
    WHERE s.session_id=? AND s.source_user_seq=? AND l.tool_name='workflow_create' ORDER BY s.rowid`)
    .all(session.id, source.seq) as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map(row => row.outcome_kind), ['invalid_arguments', 'succeeded']);
  assert.equal(rows[0]?.outcome_detail, 'host_reported:invalid_inputs');
  assert.ok(rows.every(row => row.physical_crossing_count === 0), 'zero provider crossings');
  const saved = readWorkflow('input-contract-fixture'); assert.ok(saved);
  assert.deepEqual(saved.data.inputs, JSON.parse(example));
  assert.equal(saved.data.steps[0]?.inputs?.text?.from, 'input.text');
  assert.equal(saved.data.trigger.manual, true);
  assert.equal(settledSourceArtifacts(identity).count, 1, 'one actual revision, no invented refusal artifact');
  assert.equal(events.getTurnGraphEventForSource(session.id, source.seq), null, 'no Plan gate introduced');
  assert.equal(externalCalls, 0);
});
