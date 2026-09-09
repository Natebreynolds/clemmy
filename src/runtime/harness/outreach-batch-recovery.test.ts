/** Production host replay of the 3.17 draft batch; all provider bodies are local fixtures. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-outreach-batch-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state', 'machine-id'), 'outreach-batch-fixture\n');
const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { installIsolatedAttestedTransport } = await import('./isolated-attested-transport.fixture.js');
const stores = await import('./capability-manifest-store.js');
const connected = await import('./connected-goal-catalog.js');
const client = await import('../../integrations/composio/client.js');
const inner = await import('../../tools/inner-dispatch.js');
const composioTools = await import('../../tools/composio-tools.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
const topology = await import('../graph/work-topology.js');
const contracts = await import('./expected-work-contract.js');
const workAdmission = await import('./expected-work-admission.js');
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  inner._setInnerDispatchToolsForTests(null);
  installIsolatedAttestedTransport(null);
  client.__test__.setComposioApiKeyOverride(null);
  client.__test__.setComposioClient(null);
  client.__test__.setConnectedAccountsLoader(null);
  connected.installConnectedRegistryPort(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  stores.installCapabilityManifestStore(null);
  semanticPorts.installTurnSemanticModelPort(null);
  eventlog.closeEventLog();
  rmSync(fixtureHome, { recursive: true, force: true });
});

for (const { count, limit, native = false, planned = false } of [{ count: 10, limit: 128 }, { count: 50, limit: 128 }, { count: 10, limit: 2 }, { count: 3, limit: 4, native: true }, { count: 3, limit: 2, native: true }, { count: 3, limit: 2, native: true, planned: true }]) test(`${count} authorized ${native ? 'native' : 'provider'} drafts queue through eight slots with activation budget ${limit}${planned ? ' and accepted Plan' : ''}`, async () => {
  const bodies: unknown[] = [];
  const provider = async (call: unknown) => {
    bodies.push(call);
    return { successful: true, data: { id: `local-draft-${bodies.length}` } };
  };
  installIsolatedAttestedTransport(provider);
  const schema = { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' },
    to_recipients: { type: 'array', items: { type: 'string' } } }, required: ['subject', 'body', 'to_recipients'] };
  const rawTool = { slug: 'OUTLOOK_CREATE_DRAFT', name: 'Create an Outlook draft',
    description: 'Create a standalone email draft without sending it.', toolkit: { slug: 'outlook' },
    inputParameters: schema, outputParameters: { type: 'object' }, version: '1' };
  client.__test__.setComposioApiKeyOverride('fixture-key');
  client.__test__.setConnectedAccountsLoader(async () => [{ id: 'fixture-outlook', status: 'ACTIVE',
    user_id: 'fixture-user', toolkit: { slug: 'outlook' }, email: 'owner@example.test' }] as never);
  client.__test__.setComposioClient({ client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({ withOptions: () => ({ tools: { execute: provider } }) }),
    tools: { getRawComposioTools: async () => [rawTool], execute: provider },
  } as never);
  globalThis.fetch = async (input) => {
    if (String(input).startsWith('https://backend.composio.dev/api/v3/tools?')) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    throw new Error('Network is disabled in this replay');
  };
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  stores.installCapabilityManifestStore(stores.createCapabilityManifestStore());
  connected.installConnectedRegistryPort(() => ({ connectedToolkits: ['outlook'], tools: [{ slug: rawTool.slug, schema }] }));
  const gateway = composioTools.getComposioRuntimeTools().find(tool => tool.name === 'composio_execute_tool')!;
  inner._setInnerDispatchToolsForTests(new Map(native
    ? [['write_file', { name: 'write_file', invoke: provider } as never]]
    : [['composio_execute_tool', gateway as never]]));
  const session = eventlog.createSession({ id: `outreach-${count}-drafts-${limit}-${native}-${planned}`, kind: 'chat' });
  const text = native
    ? `Create ${count} local email drafts as separate files under ${fixtureHome}, one per contact1@example.test through contact${count}@example.test. Do not send anything.`
    : `Create ${count} separate Outlook drafts, one per contact1@example.test through contact${count}@example.test. Do not send anything.`;
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('No plan or semantic compiler in this Normal replay'); },
    async judgeAccountSelection(input) { return { verdict: 'default_compatible', proposalDigest: input.proposalDigest,
      modelIdentity: 'fixture-reviewer' }; },
  });
  const primed = await semantic.primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(primed.ok, JSON.stringify(primed));
  if (!primed.ok) return;
  let step = 0;
  const call = (callId: string, name: string, args: unknown) => ({ type: 'function_call', callId, name, arguments: JSON.stringify(args) });
  const model = {
    async getResponse(request: { input: Array<{ callId?: string; output?: { text?: string } }> }) {
      step += 1;
      let output: unknown[];
      if (step === 1) output = [call('discover-draft', 'tool_search', { query: native ? 'write_file' : 'OUTLOOK_CREATE_DRAFT', limit: 3 })];
      else if (step === 2) {
        const discovery = JSON.parse(request.input.find(x => x.callId === 'discover-draft' && x.output)?.output?.text ?? '{}');
        const found = discovery.results?.find((x: { name: string }) => x.name === (native ? 'write_file' : rawTool.slug));
        const ref = native ? found?.capabilityVariants?.find((v: { capabilityRef: string }) => v.capabilityRef.endsWith(':create'))?.capabilityRef : found?.capabilityRef;
        assert.ok(ref, JSON.stringify(discovery));
        if (planned) {
          const workTopology = { version: 1 as const,
            operations: [{ id: 'draft_email', effect: 'local_write' as const, coverage: null,
              dependsOn: [], dataFrom: [], cardinality: { kind: 'each' as const, universeId: 'contacts' } }],
            universes: [{ id: 'contacts', seal: 'accepted_input' as const,
              members: Array.from({ length: count }, (_, i) => `contact-${i+1}`) }] };
          const destination = { posture: 'create_new' as const, family: 'file', handleRequired: true };
          const admitted = await semantic.admitAndCompilePrimaryModelProposal({
            identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
            surface: 'direct', planningCatalogAuthority: primed.planning.authority,
            proposal: { version: 1, relation: 'new_goal', targetGoal: null,
              goal: { objective: text, criteria: [{ id: 'drafts', statement: `Exactly ${count} separate drafts are saved.` }],
                openSlots: [], candidates: [{ kind: 'capability', id: ref }] },
              work: { construct: 'fanout', cardinality: null, destinations: [destination], destination,
                requestedEffect: 'local_write', topology: workTopology, topologyHash: topology.workTopologyDigest(workTopology),
                operations: [{ id: 'draft_email', role: 'destination', requestedEffect: 'local_write', capabilityRef: ref,
                  dependsOn: [], evidence: ['local_commit_receipt'] }],
                deliverables: [{ id: 'drafts', kind: 'file' }], evidenceRequirements: ['local_commit_receipt'] },
              slotAnswers: [], rationale: 'Use the exact discovered local writer for each contact.' },
          });
          assert.ok(admitted.ok, JSON.stringify(admitted));
          const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
          const frozen = contracts.freezePrimaryModelExpectedWorkContract(identity);
          assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
          const activated = workAdmission.activateActionExpectedWork(identity);
          assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
        }

        output = Array.from({ length: count }, (_, i) => call(`draft-${i+1}`, 'work_call', { requirement_id: planned ? 'draft_email' : ref,
          universe_item_id: planned ? `contact-${i+1}` : null, universe_selector: null, seal_amendment: null, source_call_ids: null, source_record_ids: null,
          name: native ? 'write_file' : 'composio_execute_tool', args_json: JSON.stringify(native
            ? { path: path.join(fixtureHome, `draft-${i+1}.eml`), mode: 'create', content: `To: contact${i+1}@example.test\nSubject: Monday\nCan we meet Monday?` }
            : { tool_slug: rawTool.slug,
            arguments: JSON.stringify({ subject: `Draft ${i+1}`, body: 'Can we meet Monday?', to_recipients: [`contact${i+1}@example.test`] }) }) }));
      } else output = [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture complete.' }] }];
      return { responseId: `outreach-${step}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
    },
    async *getStreamedResponse(request: never) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  const agent = await buildOrchestratorAgent({ userInput: text, sessionId: session.id, sourceUserSeq: source.seq,
    hostFreshPlanning: primed.planning, allowToolJit: true, model: model as never });
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('Legacy SDK loop'); } });
  const counter = new brackets.ToolCallsCounter(limit);
  const attempt = brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq,
    turn: 1, counter, behaviorScopeId: `${session.id}::turn:1` },
    () => hostRunRunner(runner as never, agent as never, [{ role: 'user', content: text }] as never,
      { maxTurns: 5, hostTurnEngine: 'host_v1', hostJudgeCompletion: false,
        toolExecution: { maxFunctionToolConcurrency: 8 }, context: { sessionId: session.id, sourceUserSeq: source.seq } } as never));
  if (limit === 2) {
    await assert.rejects(attempt, error => error instanceof brackets.ToolCallsLimitExceeded,
      'an activation boundary must checkpoint the completed write and untouched siblings, not fail receipt commit');
    assert.equal(bodies.length, 1);
    return;
  }
  const outcome = await attempt;
  const results = outcome.history.filter((x: unknown) => (x as { type?: string }).type === 'function_call_result');
  assert.equal(bodies.length, count, JSON.stringify(results.map(x => {
    const row = x as { callId?: string; output?: { text?: string } };
    return { callId: row.callId, text: row.output?.text?.slice(0, 750) };
  })));
  assert.equal(counter.calls, count + 1, 'one charge per logical call, including native transport mirrors');
  assert.equal(step, 3, 'one discovery, one batch, one answer; no model repair is needed');
  assert.equal(outcome.serializedRecoveryState, undefined);
  const settled = eventlog.openEventLog().prepare(`SELECT outcome_kind FROM logical_call_settlements
    WHERE session_id = ? AND logical_tool_call_id LIKE 'draft-%'`).all(session.id);
  assert.equal(settled.length, count);
  assert.ok(settled.every((row: unknown) => (row as { outcome_kind: string }).outcome_kind === 'succeeded'));
});
