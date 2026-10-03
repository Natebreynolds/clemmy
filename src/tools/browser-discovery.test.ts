import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-browser-discovery-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { registerToolSearchTool } = await import('./tool-search-tool.js');
const { deriveOrchestratorDiscoveryNames, actionTopologyRoleFor } = await import('./tool-registry.js');
const planning = await import('../runtime/harness/local-planning-capability.js');
const reviewed = await import('../runtime/harness/reviewed-local-tool-transport.js');
const { reviewedLocalStorageCarrier, createReviewedBrowserStorageAdapter } = await import('../runtime/harness/reviewed-local-storage-carrier.js');
const { capabilityManifestDigest } = await import('../runtime/harness/capability-manifest.js');
const { rankCatalogEntriesLexically } = await import('../agents/tool-catalog.js');
const workflowReceipts = await import('../execution/workflow-call-receipts.js');
const hostRefusals = await import('../runtime/harness/host-pre-dispatch-refusal.js');

async function search(query: string) {
  let handler!: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as never, {
    allowedNames: deriveOrchestratorDiscoveryNames(), dispatchCarrierForName: name => actionTopologyRoleFor(name) === 'control' ? 'call_tool' : 'work_call', candidateSources: [],
    async discloseForPlanning(disclosures) {
      return Object.fromEntries(disclosures.flatMap(candidate => {
        const definitions = planning.inspectAuthorizedLocalPlanningDisclosureCandidates(candidate);
        return definitions?.length ? [[candidate.name, definitions[0]!.capabilityRef]] : [];
      }));
    },
  });
  return JSON.parse((await handler({ query, role_key: 'browser-task', limit: 8, account_selection: null, cursor: null })).content[0]!.text);
}

test('a leading topic cannot turn a tool-family name into action precedence', () => {
  const ranked = rankCatalogEntriesLexically('assets screenshot render html', [
    ...Array.from({ length: 9 }, (_, index) => ({ name: `assets_${index}`, oneLiner: 'List current assets in the project.' })),
    { name: 'page_preview', oneLiner: 'Render an HTML screenshot; applies to assets and local pages.' },
  ]);
  assert.equal(ranked[0]!.name, 'page_preview');
});

test('ordinary browser requests disclose usable exact typed operations with carrier examples', async () => {
  for (const [query, expected] of [
    ['open a browser', 'browser_open'], ['open a new blank browser tab', 'browser_open'],
    ['read this browser page', 'browser_read'], ['navigate browser tab to website URL', 'browser_navigate'],
    ['list local Chrome browser pages', 'browser_tabs'],
  ]) {
    const body = await search(query!);
    assert.equal(body.results[0].name, expected, `${query}: ${body.results.map((row: { name: string }) => row.name).join(', ')}`);
    const row = body.results[0];
    assert.ok(row.capabilityRef, query);
    assert.equal(row.planningRefStatus, undefined);
    assert.equal(row.carrier, 'work_call');
    assert.equal(row.example.tool, 'work_call');
    assert.equal(row.example.args.name, expected);
    assert.equal(row.example.args.requirement_id, row.capabilityRef);
    assert.ok(body.schemas[expected!], 'complete current argument schema is on the first page');
  }
  const raw = await search('browser_harness_run');
  assert.equal(raw.results[0].planningRefStatus, 'unsupported_unmaterialized');
  assert.equal(raw.results[0].example, undefined, 'arbitrary code must not acquire typed browser authority');
  const setup = await search('browser_harness_setup');
  assert.equal(setup.results[0].planningRefStatus, 'dispatch_now');
  assert.equal(setup.results[0].carrier, 'call_tool', 'setup is its guarded host control, not browser business authority');
});

test('typed browser reviewed contracts match the actual configured planning surface and host selection', async () => {
  for (const name of ['browser_tabs', 'browser_read', 'browser_open', 'browser_navigate']) {
    const observed = reviewed.observeReviewedLocalTool(name);
    assert.ok(observed, name);
    const configured = await planning.observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
    assert.equal(configured.ok, true, name);
    if (!configured.ok) continue;
    assert.deepEqual(observed.schema, configured.schema, name);
    assert.equal(observed.definition.envelopeFingerprint, configured.definition.envelopeFingerprint, name);
    const read = name === 'browser_read' || name === 'browser_tabs';
    assert.equal(observed.definition.descriptor.effect, read ? 'read' : 'local_write');
    assert.equal(observed.execution.idempotency, read ? 'read_only' : 'never_redispatch');
    const manifest = reviewed.reviewedLocalCapabilityManifest(observed)!;
    assert.deepEqual(manifest.reconciliation, { supported: false, policy: read ? 'none' : 'uncertain_if_absent' });
    assert.ok(reviewedLocalStorageCarrier.select({ operationId: name, accountId: reviewed.REVIEWED_LOCAL_ACCOUNT }));
    assert.equal(reviewedLocalStorageCarrier.select({ operationId: name, accountId: 'foreign-account' }), null);
  }
  assert.equal(reviewed.observeReviewedLocalTool('browser_harness_run'), null);
});

test('production host browser adapter revalidates sealed identity before mock dispatch and throws structured failures', async () => {
  const observed = reviewed.observeReviewedLocalTool('browser_open')!;
  assert.ok(observed);
  const manifest = reviewed.reviewedLocalCapabilityManifest(observed)!;
  const call = { operationId: 'browser_open', args: {}, accountId: reviewed.REVIEWED_LOCAL_ACCOUNT,
    expected: { manifestId: observed.manifestId, manifestDigest: capabilityManifestDigest(manifest),
      providerKind: 'local_registry', providerIdentity: reviewed.REVIEWED_LOCAL_PROVIDER_IDENTITY,
      providerVersion: reviewed.REVIEWED_LOCAL_PROVIDER_VERSION, operationVersion: reviewed.REVIEWED_LOCAL_OPERATION_VERSION,
      definitionFingerprint: observed.definition.envelopeFingerprint, invokePortId: observed.invokePortId,
      argumentCompiler: { ...reviewed.REVIEWED_LOCAL_ARGUMENT_COMPILER } } };
  let calls = 0;
  const adapter = createReviewedBrowserStorageAdapter(async () => {
    calls++;
    return { code: 0, stdout: 'CLEM_BROWSER_OPERATION_V1:' + JSON.stringify({ ok: true, result: { target_id: 'created', url: 'about:blank', title: '' }, target_id: 'created', browser_id: 'a'.repeat(64), effect: 'confirmed' }), stderr: '' };
  });
  const value = await adapter.execute(call) as Record<string, unknown>;
  assert.equal(value.ok, true);
  assert.deepEqual(value.handle, { session_name: 'default', browser_id: 'a'.repeat(64), target_id: 'created' });
  await assert.rejects(adapter.execute({ ...call, args: { code: 'not permitted' } }), /arguments exceed/);
  await assert.rejects(adapter.execute({ ...call, accountId: 'foreign' }), /identity changed/);
  assert.equal(calls, 1);
  const failed = createReviewedBrowserStorageAdapter(async () => ({ code: 1, stdout: '', stderr: 'Disconnected', dispatched: true }));
  await assert.rejects(failed.execute(call), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(JSON.parse(error.message).receipt.effect, 'uncertain');
    return true;
  });
  const before = createReviewedBrowserStorageAdapter(async () => ({ code: -1, stdout: '', stderr: 'Missing interpreter', dispatched: false }));
  await assert.rejects(before.execute(call), error => hostRefusals.isHostPreDispatchRefusal(error));
  assert.deepEqual(await adapter.reconcile({ operationId: call.operationId, accountId: call.accountId, artifactId: 'browser:old', expected: call.expected }), { exists: false });
});

test('the durable workflow mutation guard cannot replay an interrupted exact browser navigation', async () => {
  const observed = reviewed.observeReviewedLocalTool('browser_navigate')!;
  const manifest = reviewed.reviewedLocalCapabilityManifest(observed)!;
  assert.deepEqual(manifest.reconciliation, { supported: false, policy: 'uncertain_if_absent' });
  const args = { browser_id: 'a'.repeat(64), target_id: 'exact-target', url: 'https://example.com/' };
  const input = { workflowSlug: 'browser-no-replay', runId: 'interrupted-navigation', stepId: 'navigate', tool: 'browser_navigate',
    account: { identity: manifest.accountId, connectionId: args.browser_id }, args };
  const call = { operationId: 'browser_navigate', args, accountId: reviewed.REVIEWED_LOCAL_ACCOUNT,
    expected: { manifestId: observed.manifestId, manifestDigest: capabilityManifestDigest(manifest),
      providerKind: 'local_registry', providerIdentity: reviewed.REVIEWED_LOCAL_PROVIDER_IDENTITY,
      providerVersion: reviewed.REVIEWED_LOCAL_PROVIDER_VERSION, operationVersion: reviewed.REVIEWED_LOCAL_OPERATION_VERSION,
      definitionFingerprint: observed.definition.envelopeFingerprint, invokePortId: observed.invokePortId,
      argumentCompiler: { ...reviewed.REVIEWED_LOCAL_ARGUMENT_COMPILER } } };
  let calls = 0;
  const adapter = createReviewedBrowserStorageAdapter(async () => {
    calls++;
    assert.equal(workflowReceipts.inspectWorkflowCallMutation(input).status, 'ambiguous', 'durable started boundary precedes CDP');
    return { code: null, stdout: '', stderr: 'Connection ended after Page.navigate', termination: 'timeout', dispatched: true };
  });
  const once = () => workflowReceipts.executeWorkflowCallMutation(input, () => adapter.execute(call));
  await assert.rejects(once(), error => error instanceof workflowReceipts.WorkflowCallMutationAmbiguousError);
  assert.equal(workflowReceipts.inspectWorkflowCallMutation(input).status, 'ambiguous');
  await assert.rejects(once(), error => error instanceof workflowReceipts.WorkflowCallMutationAmbiguousError);
  assert.equal(calls, 1, 'an uncertain browser mutation is never replayed to manufacture a success');
});
