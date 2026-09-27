/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/carrier-presentation-budget.integration.test.ts
 *
 * A result's inline presentation follows the EFFECTIVE inner tool, not the
 * carrier it travelled through. Real host_v1 runner, real carriers, the real
 * registered space_get / recall_tool_result handlers and a Space seeded
 * through the production space_save handler; the fake model only records the
 * requests it is sent, so every assertion reads what the model actually saw.
 *
 * Regression: a ~10.5k-char static Space read through call_tool reached the
 * model as a 4,000-char head/tail digest ("Dataset (complete JSON)" with the
 * middle omitted), and every recall of it through call_tool was clipped to
 * 4,000 again, so the model paged a recall of a recall.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { tool } from '@openai/agents';
import { z } from 'zod';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-carrier-presentation-'));
process.env.CLEMENTINE_HOME = home;
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });

const events = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest.js');
const ports = await import('./production-capability-ports.js');
const envelopes = await import('../../agents/capability-envelope.js');
const inner = await import('../../tools/inner-dispatch.js');
const { buildCallTool } = await import('../../tools/call-tool.js');
const { buildWorkCall } = await import('../../tools/work-call.js');
const { getLocalRuntimeTools } = await import('../../tools/local-runtime-tools.js');
const { registerSpaceTools } = await import('../../tools/space-tools.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');
const { PROMPT_INLINE_RECALLABLE_RESULT_CHARS, inlineResultBudgetForModel } = await import('./tool-output-format.js');
const { recordWindowRejection } = await import('./model-window-observations.js');

after(() => {
  inner._setInnerDispatchToolsForTests(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  ports.clearProductionCapabilityPorts();
  schemas.resetToolSchemaCache();
  events.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

type Handler = (input: Record<string, unknown>) => Promise<unknown> | unknown;
const spaceHandlers: Record<string, Handler> = {};
registerSpaceTools({ tool(name: string, _d: string, _p: unknown, h: Handler) { spaceHandlers[name] = h; } } as never);
const handlerText = (result: unknown): string =>
  (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';

const SLUG = 'fixture-reads-budget';
const MIDDLE_EVIDENCE = 'MIDDLE-EVIDENCE-top-cpc-term-7f3a';

/** Seed a static Space through the production space_save handler. Its
 * space_get text is ~10.5k chars and carries evidence in the middle, the part
 * a head/tail digest drops. */
async function seedSpace(slug: string, rowCount: number): Promise<string> {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    term: i === Math.floor(rowCount / 2) ? MIDDLE_EVIDENCE : `fixture term ${i}`,
    cpc: Number((1 + i * 0.37).toFixed(2)),
    volume: 1000 + i * 17,
    note: `Keyword row ${i} for the fixture comparison table.`,
  }));
  const document = {
    meta: { title: 'Fixture comparison', rows: rows.length },
    rows,
    _mobile: { headline: [{ label: 'Rows', value: String(rows.length) }] },
  };
  const saved = handlerText(await spaceHandlers.space_save!({
    slug,
    title: 'Fixture reads budget',
    objective: 'Hold a fixture comparison table for presentation-budget pins.',
    view_html: '<html><body><main id="app">Fixture</main></body></html>',
    initial_data_json: JSON.stringify(document),
  }));
  assert.match(saved, /Created workspace/);
  const whole = handlerText(await spaceHandlers.space_get!({ slug }));
  const at = whole.indexOf(MIDDLE_EVIDENCE);
  assert.ok(at > 4_000 && at < whole.length - 2_000, 'the evidence sits in the middle of the read');
  return whole;
}

const wholeSpaceRead = await seedSpace(SLUG, 88);
assert.ok(wholeSpaceRead.length > 10_000 && wholeSpaceRead.length < 12_000,
  `fixture Space read is ~10.5k chars (got ${wholeSpaceRead.length})`);
const LARGE_SLUG = 'fixture-reads-budget-large';
const largeSpaceRead = await seedSpace(LARGE_SLUG, 130);

let serial = 0;

/** Drive one real host_v1 turn. The fake model emits `calls` one per request
 * and then answers; returns the text of each tool result it was sent. */
async function runHostTurn(input: {
  agentTool: unknown;
  toolName: string;
  calls: Array<{ callId: string; args: Record<string, unknown> }>;
  routedModelId?: string;
}): Promise<{ results: Map<string, string>; sessionId: string }> {
  serial += 1;
  const session = events.createSession({ id: `sess-carrier-presentation-${serial}`, kind: 'chat' });
  const text = 'Read the fixture comparison and report the top terms.';
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const requests: unknown[] = [];
  const model = {
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
    },
    async getResponse(request: unknown) {
      requests.push(request);
      const next = input.calls[requests.length - 1];
      return {
        responseId: `response-${requests.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: next
          ? [{ type: 'function_call', callId: next.callId, name: input.toolName, arguments: JSON.stringify(next.args) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Read.' }] }],
      };
    },
  };
  const agent = { model, tools: [input.agentTool] };
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId: session.id, universeTools: [input.agentTool as never], activeToolNames: [input.toolName],
    policyHash: `carrier-presentation-${serial}`,
    budget: { maxUncachedTokens: 100000, maxModelCalls: 6, maxToolCalls: 6, maxElapsedMs: 60000 },
  });
  assert.ok(sealed.ok, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error('unsealed');
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('legacy runner forbidden'); } });
  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(6), behaviorScopeId: `${session.id}::turn:1`,
    recallBudget: new brackets.RecallBudget(10, 500_000, session.id),
    ...(input.routedModelId ? { routedModelId: input.routedModelId } : {}),
  }, () => hostRunRunner(runner as never, agent as never, [{ role: 'user', content: text }] as never, {
    maxTurns: 6, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq },
  } as never));
  assert.equal(outcome.finalOutput, 'Read.', JSON.stringify(outcome.terminal));
  const results = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const item = value as { type?: unknown; callId?: unknown; output?: unknown };
    if (item.type === 'function_call_result' && typeof item.callId === 'string') {
      const output = item.output as { text?: unknown } | string;
      results.set(item.callId, typeof output === 'string' ? output : String(output?.text ?? ''));
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(requests.at(-1));
  return { results, sessionId: session.id };
}

function realLocalTool(name: string) {
  const found = getLocalRuntimeTools().find((candidate) => candidate.name === name);
  assert.ok(found, `${name} is a registered local tool`);
  return brackets.wrapToolForHarness(found as never);
}

function realCallTool(reachable: readonly string[]) {
  return brackets.wrapToolForHarness(buildCallTool({
    reachableBuiltinNames: new Set(reachable), firstClassNames: new Set(['call_tool']), deniedNames: new Set(),
    mcpToolScope: null, controlOnlyBuiltins: true, admitBuiltinAcquisition: async () => ({ ok: true }),
  }) as never);
}

test('a Space read through the real call_tool carrier arrives whole', async () => {
  inner._setInnerDispatchToolsForTests(null);
  const { results } = await runHostTurn({
    agentTool: realCallTool(['space_get']),
    toolName: 'call_tool',
    calls: [{ callId: 'carrier-space-read', args: { name: 'space_get', args_json: JSON.stringify({ slug: SLUG }) } }],
  });
  const shown = results.get('carrier-space-read');
  assert.ok(shown, 'the model received the carrier result');
  assert.equal(shown, wholeSpaceRead, 'the carrier presents the inner read byte-for-byte');
  assert.ok(shown.includes(MIDDLE_EVIDENCE));
  assert.doesNotMatch(shown, /middle omitted/);
});

test('the same Space read called directly produces the identical presentation', async () => {
  const { results } = await runHostTurn({
    agentTool: realLocalTool('space_get'),
    toolName: 'space_get',
    calls: [{ callId: 'direct-space-read', args: { slug: SLUG } }],
  });
  assert.equal(results.get('direct-space-read'), wholeSpaceRead);
});

test('on a small window the carrier and the direct call present the same bounded read', async () => {
  const smallWindowModel = 'fixture-small-window-model';
  recordWindowRejection(smallWindowModel, 32_001);
  const budget = inlineResultBudgetForModel(smallWindowModel);
  assert.equal(budget, 11_200);
  // A read over the small-window budget and under the default one, so the
  // window alone decides.
  assert.ok(largeSpaceRead.length > budget && largeSpaceRead.length < 20_000, `got ${largeSpaceRead.length}`);
  const carrier = await runHostTurn({
    agentTool: realCallTool(['space_get']), toolName: 'call_tool', routedModelId: smallWindowModel,
    calls: [{ callId: 'small-window-read', args: { name: 'space_get', args_json: JSON.stringify({ slug: LARGE_SLUG }) } }],
  });
  const direct = await runHostTurn({
    agentTool: realLocalTool('space_get'), toolName: 'space_get', routedModelId: smallWindowModel,
    calls: [{ callId: 'small-window-read', args: { slug: LARGE_SLUG } }],
  });
  const normalize = (value: string) => value.replace(/nonce=[0-9a-f-]{36}/g, 'nonce=N');
  const viaCarrier = carrier.results.get('small-window-read')!;
  const viaDirect = direct.results.get('small-window-read')!;
  assert.ok(viaCarrier.length <= budget && viaCarrier.length > PROMPT_INLINE_RECALLABLE_RESULT_CHARS,
    `bounded by the window budget, above the keyhole (got ${viaCarrier.length})`);
  assert.equal((viaCarrier.match(/middle omitted/g) ?? []).length, 1, 'digested once, never a digest of a digest');
  assert.equal(normalize(viaCarrier), normalize(viaDirect));
});

test('recall_tool_result through call_tool is never re-clipped by the carrier', async () => {
  const { results } = await runHostTurn({
    agentTool: realCallTool(['space_get', 'recall_tool_result']),
    toolName: 'call_tool',
    calls: [
      { callId: 'recall-source', args: { name: 'space_get', args_json: JSON.stringify({ slug: SLUG }) } },
      { callId: 'recall-through-carrier', args: {
        name: 'recall_tool_result', args_json: JSON.stringify({ call_id: 'recall-source', max_chars: 12_000 }) } },
    ],
  });
  const recalled = results.get('recall-through-carrier');
  assert.ok(recalled);
  assert.match(recalled, new RegExp(`^Recalled chars 0–${wholeSpaceRead.length} of ${wholeSpaceRead.length}`));
  assert.ok(recalled.endsWith(wholeSpaceRead), 'the whole requested slice reaches the model');
  assert.doesNotMatch(recalled, /middle omitted|recall_tool_result \{"call_id":"recall-through-carrier"/,
    'no digest, and no footer asking the model to recall its own recall');
});

test('a provider result through the real work_call carrier keeps the 4,000-char keyhole and its digest', async () => {
  const operationId = 'GOOGLESHEETS_VALUES_GET';
  const accountId = 'ca_presentationfixture';
  const schema = { type: 'object', additionalProperties: false, properties: { city: { type: 'string' } }, required: ['city'] };
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  ports.clearProductionCapabilityPorts();
  schemas.rememberToolSchema(operationId, schema);
  const manifest = manifests.attachSemanticContract({ version: 1, manifestId: 'cap:presentation:read', providerKind: 'composio', operationId,
    providerIdentity: 'composio', providerVersion: '1', operationVersion: '1', definitionFingerprint: 'b'.repeat(64),
    externalDefinition: { version: 1, providerInputSchemaDigest: digestSchema(schema), semanticName: operationId,
      behaviorHints: { readOnly: true, destructive: false, idempotent: true, openWorld: false } },
    effect: 'read', accountId, idempotency: { required: false, policy: 'none' }, reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' }, evidenceContract: { kinds: ['receipt'], readbackRequired: false },
    provenance: { issuer: 'presentation:test', issuedAt: '2026-09-26T00:00:00.000Z', trusted: true }, lifecycle: { state: 'current' } });
  const refuse = async () => { throw new Error('read must cross its exact SDK carrier'); };
  factory.register({ capabilityId: manifest.manifestId, toolName: operationId, schemaVersion: '1', schemaDigest: manifest.definitionFingerprint,
    effect: 'read', account: accountId, manifestDigest: manifests.capabilityManifestDigest(manifest), providerKind: 'composio',
    providerInputSchemaDigest: digestSchema(schema), liveFingerprint: manifest.definitionFingerprint, manifest, invoke: refuse as never });
  assert.deepEqual(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
    invoke: refuse as never, admitPreparation() {}, prepareInvocation: async () => ({}), invokeWithPreparation: async (_proof, work) => work(),
  }), { ok: true });
  // Same size and shape of text as the Space read: only the origin differs.
  const providerText = wholeSpaceRead.replaceAll('Workspace', 'Provider sheet');
  inner._setInnerDispatchToolsForTests(new Map([['composio_execute_tool', tool({
    name: 'composio_execute_tool', description: 'Injected provider body.',
    parameters: z.object({ tool_slug: z.string(), arguments: z.string().nullable(), connected_account_id: z.string().nullable() }),
    execute: async () => providerText,
  }) as never]]));
  try {
    const { results } = await runHostTurn({
      agentTool: brackets.wrapToolForHarness(buildWorkCall({
        reachableBuiltinNames: new Set(['composio_execute_tool']), firstClassNames: new Set(),
        requireHostPlan: true, hostPlanningReady: () => true,
      }) as never),
      toolName: 'work_call',
      calls: [{ callId: 'provider-read', args: {
        requirement_id: 'read_records', name: 'composio_execute_tool',
        args_json: JSON.stringify({ tool_slug: operationId, arguments: JSON.stringify({ city: 'Seattle' }), connected_account_id: accountId }),
      } }],
    });
    const shown = results.get('provider-read');
    assert.ok(shown);
    assert.ok(shown.length <= PROMPT_INLINE_RECALLABLE_RESULT_CHARS, `provider result stays in the keyhole (got ${shown.length})`);
    assert.match(shown, /middle omitted/, 'the keyhole is a head/tail digest');
    assert.match(shown, /recall_tool_result/, 'the digest names the lossless recall');
    assert.equal(shown.includes(MIDDLE_EVIDENCE), false);
  } finally {
    inner._setInnerDispatchToolsForTests(null);
    catalogs.installHostCapabilityCatalogFactory(null);
    ports.clearProductionCapabilityPorts();
  }
});
