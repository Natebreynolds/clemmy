/** Real host_v1 carriers with injected provider bodies; no live account or model calls. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { tool } from '@openai/agents';
import { z } from 'zod';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-annotated-output-'));
process.env.CLEMENTINE_HOME = home;
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest.js');
const ports = await import('./production-capability-ports.js');
const envelopes = await import('../../agents/capability-envelope.js');
const inner = await import('../../tools/inner-dispatch.js');
const { buildWorkCall } = await import('../../tools/work-call.js');
const { buildCallTool } = await import('../../tools/call-tool.js');
const { hostRunRunner, HostRecoveryState, acceptedObjectiveForSource, _setHostObjectiveJudgeForTests } = await import('./host-turn-runner.js');
const steering = await import('./steer-notes.js');
const { getToolOutputContext, withToolOutputContext } = await import('./tool-output-context.js');
const { formatRecallableToolText, exactToolOutputForInvocation } = await import('./tool-output-format.js');
const { formatComposioExecuteOutput } = await import('../../tools/composio-tools.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');
const { redeemSuccessfulSettlementResultForHost } = await import('./result-handle.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
after(() => { _setHostObjectiveJudgeForTests(null); inner._setInnerDispatchToolsForTests(null); catalogs.installHostCapabilityCatalogFactory(null);
  ports.clearProductionCapabilityPorts(); schemas.resetToolSchemaCache(); events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

const sourcePayload = () => ({ data: { items: Array.from({ length: 25 }, (_, i) => ({
  postId: `row-${i}`, likes: 2, shares: 0, views: 113, missing: null,
  text: `Retained post ${i}`, media: 'provider bytes '.repeat(900),
  sharedPost: { text: `Actual nested caption ${i}`, value: 3 },
})) }, successful: true, error: null });

for (const variant of ['annotated_composio', 'unformatted_native', 'steering'] as const) test(`real host carrier preserves exact output through ${variant}`, async (t) => {
  const external = variant !== 'unformatted_native';
  const steered = variant === 'steering';
  const session = events.createSession({ id: `sess-host-output-${variant}`, kind: 'chat' });
  const text = 'Read the current source and report the actual available values.';
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const operationId = 'GOOGLESHEETS_VALUES_GET';
  const accountId = 'ca_outputfixture';
  const schema = { type: 'object', additionalProperties: false, properties: { city: { type: 'string' } }, required: ['city'] };
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  ports.clearProductionCapabilityPorts();
  if (external) {
    schemas.rememberToolSchema(operationId, schema);
    const manifest = manifests.attachSemanticContract({ version: 1, manifestId: 'cap:output:read', providerKind: 'composio', operationId,
      providerIdentity: 'composio', providerVersion: '1', operationVersion: '1', definitionFingerprint: 'a'.repeat(64),
      externalDefinition: { version: 1, providerInputSchemaDigest: digestSchema(schema), semanticName: operationId,
        behaviorHints: { readOnly: true, destructive: false, idempotent: true, openWorld: false } },
      effect: 'read', accountId, idempotency: { required: false, policy: 'none' }, reconciliation: { supported: false, policy: 'none' },
      outputContract: { kind: 'records' }, evidenceContract: { kinds: ['receipt'], readbackRequired: false },
      provenance: { issuer: 'host-output:test', issuedAt: '2026-09-08T00:00:00.000Z', trusted: true }, lifecycle: { state: 'current' } });
    const invoke = async () => { throw new Error('read must cross its exact SDK carrier'); };
    factory.register({ capabilityId: manifest.manifestId, toolName: operationId, schemaVersion: '1', schemaDigest: manifest.definitionFingerprint,
      effect: 'read', account: accountId, manifestDigest: manifests.capabilityManifestDigest(manifest), providerKind: 'composio',
      providerInputSchemaDigest: digestSchema(schema), liveFingerprint: manifest.definitionFingerprint, manifest, invoke: invoke as never });
    assert.deepEqual(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
      invoke: invoke as never, admitPreparation() {}, prepareInvocation: async () => ({}), invokeWithPreparation: async (_proof, work) => work(),
    }), { ok: true });
  }
  const payload = sourcePayload();
  const raw = external ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  const annotation = `[account-route] Using the exact account frozen by the accepted host plan (${accountId}).`;
  let retainedContext: ReturnType<typeof getToolOutputContext>;
  let bodies = 0;
  const notes = [
    `First governing instruction: ${'Complete owner context. '.repeat(130)} DECISIVE OWNER TAIL AFTER 2000.`,
    ...Array.from({ length: 5 }, (_, i) => `Ordered owner instruction ${i + 2}: preserve this exact request context.`),
  ];
  let noteSeqs: number[] = [];
  const trigger = 'retain_steering_checkpoint';
  let judgeCalls = 0;
  if (steered) {
    _setHostObjectiveJudgeForTests(async (objective) => {
      judgeCalls += 1;
      let previous = -1;
      for (const note of notes) { const at = objective.indexOf(note); assert.ok(at > previous); previous = at; }
      return { done: true, reason: 'Complete effective owner objective was received.' };
    });
    t.after(() => _setHostObjectiveJudgeForTests(null));
  }

  const execute = () => {
    bodies += 1;
    if (steered) {
      noteSeqs = notes.map((note) => steering.appendSteerNote(session.id, note).seq);
      events.openEventLog().exec(`CREATE TEMP TRIGGER ${trigger} BEFORE INSERT ON accepted_model_batch_checkpoints
        WHEN NEW.session_id = '${session.id}' BEGIN SELECT RAISE(ABORT, 'retain complete steering fixture'); END`);
    }
    retainedContext = getToolOutputContext();
    assert.ok(retainedContext?.settlementNonce && retainedContext.callId);
    assert.equal(retainedContext.sessionId, session.id);
    return external
      ? formatComposioExecuteOutput(payload, { toolName: 'composio_execute_tool', hostAnnotations: [annotation] })
      : raw;
  };
  const injected = external
    ? tool({ name: 'composio_execute_tool', description: 'Injected provider body.',
        parameters: z.object({ tool_slug: z.string(), arguments: z.string().nullable(), connected_account_id: z.string().nullable() }),
        execute: async (args) => { assert.equal(args.tool_slug, operationId); assert.equal(args.connected_account_id, accountId);
          assert.deepEqual(JSON.parse(args.arguments!), { city: 'Seattle' }); return execute(); } })
    : tool({ name: 'harness_status', description: 'Injected status body.', parameters: z.object({}), execute: async () => execute() });
  inner._setInnerDispatchToolsForTests(new Map([[injected.name, injected as never]]));
  const carrierName = external ? 'work_call' : 'call_tool';
  const carrier = brackets.wrapToolForHarness(external
    ? buildWorkCall({ reachableBuiltinNames: new Set(['composio_execute_tool']), firstClassNames: new Set(), requireHostPlan: true, hostPlanningReady: () => true }) as never
    : buildCallTool({ reachableBuiltinNames: new Set(['harness_status']), firstClassNames: new Set(['call_tool']), deniedNames: new Set(),
        mcpToolScope: null, controlOnlyBuiltins: true, admitBuiltinAcquisition: async () => ({ ok: true }) }) as never);
  const args = external
    ? { requirement_id: 'read_records', name: 'composio_execute_tool', args_json: JSON.stringify({ tool_slug: operationId, arguments: JSON.stringify({ city: 'Seattle' }), connected_account_id: accountId }) }
    : { name: 'harness_status', args_json: '{}' };
  const requests: any[] = [];
  const model = {
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
    },
    async getResponse(request: unknown) { requests.push(request); return { responseId: `response-${requests.length}`,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: requests.length === 1
        ? [{ type: 'function_call', callId: 'source-read', name: carrierName, arguments: JSON.stringify(args) }]
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Current values read.' }] }] }; },
  };
  const agent = { model, tools: [carrier] };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [carrier], activeToolNames: [carrierName],
    policyHash: 'host-output-control', budget: { maxUncachedTokens: 100000, maxModelCalls: 3, maxToolCalls: 3, maxElapsedMs: 60000 } });
  assert.ok(sealed.ok); if (!sealed.ok) return;
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope); envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('legacy runner forbidden'); } });
  const run = (state: unknown) => brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(3), behaviorScopeId: `${session.id}::turn:1` },
    () => hostRunRunner(runner as never, agent as never, state as never,
      { maxTurns: 3, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq }, hostJudgeCompletion: steered,
        callModelInputFilter: ({ modelData }: any) => {
          assert.equal(JSON.stringify(modelData.input).includes('DECISIVE OWNER TAIL'), false,
            'user steering is not embedded in canonical provider output before result filtering');
          return modelData;
        },
      } as never));
  let outcome;
  try { outcome = await run([{ role: 'user', content: text }]); }
  finally { events.openEventLog().exec(`DROP TRIGGER IF EXISTS ${trigger}`); }
  if (steered) {
    assert.ok(outcome.serializedRecoveryState, 'the actual accepted tool checkpoint must transfer recovery ownership');
    assert.equal(requests.length, 1);
    const recovered = HostRecoveryState.fromString(outcome.serializedRecoveryState);
    assert.equal(JSON.stringify(recovered.history).includes('DECISIVE OWNER TAIL'), false);
    events.closeEventLog();
    outcome = await run(recovered);
    for (let retry = 0; outcome.serializedRecoveryState && retry < 3; retry += 1) {
      outcome = await run(HostRecoveryState.fromString(outcome.serializedRecoveryState));
    }
  }
  assert.equal(outcome.finalOutput, 'Current values read.', JSON.stringify(outcome.terminal));
  assert.equal(bodies, 1); assert.equal(requests.length, 2);
  const projections: { text: string; value: any }[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { try { const parsed = JSON.parse(value); if (parsed.__clementine?.kind === 'structured_projection_v1') projections.push({ text: value, value: parsed }); else visit(parsed); } catch {} }
    else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
  };
  visit(requests[1]); assert.equal(projections.length, 1, 'actual next request retains parseable JSON and complete metadata');
  const shown = projections[0]!;
  assert.equal(shown.value.data.items.length, 25);
  for (const row of shown.value.data.items) assert.deepEqual([row.likes, row.shares, row.views, row.missing, row.sharedPost.value], [2, 0, 113, null, 3]);
  if (external) assert.deepEqual(shown.value.__clementine.hostAnnotations, [annotation]);
  const context = retainedContext!;
  assert.equal(events.getToolOutputForInvocation(session.id, context.callId!, context.settlementNonce!)?.output, raw);
  assert.equal(exactToolOutputForInvocation({ ...context, toolName: context.toolName!, compactResult: shown.text }), raw);
  assert.equal(await withToolOutputContext(context, () => formatRecallableToolText(shown.text)), shown.text,
    'formatting an authenticated projection again is byte-identical');
  assert.equal(exactToolOutputForInvocation({ ...context, toolName: context.toolName!, settlementNonce: '11111111-1111-4111-8111-111111111111', compactResult: shown.text }), shown.text,
    'a foreign invocation cannot redeem copied host metadata');
  const settled = redeemSuccessfulSettlementResultForHost({ sessionId: session.id, sourceUserSeq: source.seq,
    acceptedTaskId: acceptedTaskIdFor(session.id, source.seq), logicalToolCallId: 'source-read' });
  assert.equal(settled.status, 'ok', JSON.stringify(settled));
  if (settled.status === 'ok') assert.deepEqual(typeof settled.value.rawPayload === 'string' ? JSON.parse(settled.value.rawPayload) : settled.value.rawPayload, payload);
  assert.equal(events.listEvents(session.id, { types: ['turn_graph_compiled', 'approval_requested'] }).length, 0);
  if (steered) {
    const actualUserStrings: string[] = [];
    const collect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const row = value as { role?: unknown; content?: unknown };
      if (row.role === 'user' && typeof row.content === 'string') actualUserStrings.push(row.content);
      for (const child of Object.values(value)) collect(child);
    };
    collect(requests[1]);
    const delivered = actualUserStrings.find((value) => value.includes('MID-RUN MESSAGE FROM THE USER'));
    assert.ok(delivered);
    let previous = -1;
    for (const note of notes) { const at = delivered.indexOf(note); assert.ok(at > previous); previous = at; }
    assert.equal(shown.text.includes('DECISIVE OWNER TAIL'), false, 'owner guidance is outside the tool-result budget');
    assert.equal(JSON.stringify(outcome.history).includes('DECISIVE OWNER TAIL'), false, 'canonical checkpoint history remains unchanged');
    assert.equal(judgeCalls, 1);
    events.closeEventLog();
    const adopted = steering.adoptedSteerNotesForSource({ sessionId: session.id, sourceUserSeq: source.seq });
    assert.deepEqual(adopted.map((note) => [note.seq, note.text]), noteSeqs.map((seq, i) => [seq, notes[i]]));
    assert.equal(steering.takeUndeliveredSteerNotes(session.id, source.seq).length, 0);
    const objective = acceptedObjectiveForSource({ sessionId: session.id, sourceUserSeq: source.seq });
    for (const note of notes) assert.ok(objective?.includes(note));
  }

});
