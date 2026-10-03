import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cloud-tools-'));
process.env.CLEMENTINE_HOME = home;
// A set-up cloud browser is the browser these operations belong to.
mkdirSync(path.join(home, 'state', 'browserbase'), { recursive: true });
writeFileSync(path.join(home, 'state', 'browserbase', 'resources.json'), JSON.stringify({ version: 1, revision: 1, resources: [],
  policy: { projectId: '00000000-0000-4000-8000-000000000001', idleSeconds: 300, sessionTimeoutSeconds: 1800 } }));
test.after(() => rmSync(home, { recursive: true, force: true }));
const { CLOUD_BROWSER_PARAMETERS, parseCloudBrowserArguments } = await import('./cloud-browser-contract.js');
const reviewed = await import('../runtime/harness/reviewed-local-tool-transport.js');
const planning = await import('../runtime/harness/local-planning-capability.js');
const { createReviewedCloudBrowserStorageAdapter, reviewedLocalStorageCarrier } = await import('../runtime/harness/reviewed-local-storage-carrier.js');
const { capabilityManifestDigest } = await import('../runtime/harness/capability-manifest.js');
const { isDirectComposioActionSlug } = await import('../execution/workflow-direct-call.js');
const { executeCloudBrowserTool } = await import('./cloud-browser-tools.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { isHostPreDispatchRefusal } = await import('../runtime/harness/host-pre-dispatch-refusal.js');
const { registerToolSearchTool } = await import('./tool-search-tool.js');
const { deriveOrchestratorDiscoveryNames, actionTopologyRoleFor } = await import('./tool-registry.js');

test('ordinary cloud browser requests disclose exact task operations with usable work_call references', async () => {
  let search!: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, handler: typeof search) { search = handler; } } as never, {
    allowedNames: deriveOrchestratorDiscoveryNames(), candidateSources: [],
    dispatchCarrierForName: name => actionTopologyRoleFor(name) === 'control' ? 'call_tool' : 'work_call',
    async discloseForPlanning(disclosures) {
      return Object.fromEntries(disclosures.flatMap(candidate => {
        const definitions = planning.inspectAuthorizedLocalPlanningDisclosureCandidates(candidate);
        return definitions?.length ? [[candidate.name, definitions[0]!.capabilityRef]] : [];
      }));
    },
  });
  for (const [query, expected] of [
    ['start a cloud browser', 'cloud_browser_start'],
    ['read cloud browser page', 'cloud_browser_read'],
    ['list cloud browser tabs', 'cloud_browser_tabs'],
    ['navigate cloud browser page to website', 'cloud_browser_navigate'],
    ['cloud_browser_resources', 'cloud_browser_resources'],
  ]) {
    const body = JSON.parse((await search({ query, role_key: 'cloud-browser-task', limit: 8, cursor: null, account_selection: null })).content[0]!.text);
    const row = body.results.find((candidate: { name: string }) => candidate.name === expected);
    assert.ok(row, `${query}: ${body.results.map((candidate: { name: string }) => candidate.name).join(', ')}`);
    assert.ok(row.capabilityRef, query);
    assert.equal(row.planningRefStatus, undefined);
    assert.equal(row.carrier, 'work_call');
    assert.equal(row.example.args.name, expected);
    assert.equal(row.example.args.requirement_id, row.capabilityRef);
    assert.ok(body.schemas[expected!], 'the first search page contains the callable schema');
  }
});

test('all cloud operations disclose an exact callable schema and nonreplayable mutation manifest', async () => {
  for (const name of Object.keys(CLOUD_BROWSER_PARAMETERS)) {
    const observed = reviewed.observeReviewedLocalTool(name);
    assert.ok(observed, name);
    const configured = await planning.observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
    assert.equal(configured.ok, true, name);
    if (!configured.ok) continue;
    assert.deepEqual(observed.schema, configured.schema, name);
    assert.equal(observed.definition.envelopeFingerprint, configured.definition.envelopeFingerprint, name);
    const read = name === 'cloud_browser_tabs' || name === 'cloud_browser_read' || name === 'cloud_browser_status' || name === 'cloud_browser_resources';
    const manifest = reviewed.reviewedLocalCapabilityManifest(observed)!;
    assert.deepEqual(manifest.reconciliation, { supported: false, policy: read ? 'none' : 'uncertain_if_absent' });
    assert.ok(reviewedLocalStorageCarrier.select({ operationId: name, accountId: reviewed.REVIEWED_LOCAL_ACCOUNT }));
    assert.equal(isDirectComposioActionSlug(name), false, 'native cloud tools cannot be misrouted to Composio');
  }
  assert.equal(reviewed.observeReviewedLocalTool('cloud_browser_stop'), null, 'resource cleanup remains a host control, never a task completion capability');
});
test('model arguments cannot smuggle a conversation, socket, script or changed credential into a cloud operation', () => {
  const exact = { resource_id: 'resource-exact', expected_version: 2, target_id: 'page-exact', url: 'https://example.com' };
  assert.equal(parseCloudBrowserArguments('cloud_browser_navigate', exact).url, 'https://example.com/');
  for (const field of ['conversationId', 'connectUrl', 'apiKey', 'code', 'providerSessionId']) {
    assert.throws(() => parseCloudBrowserArguments('cloud_browser_navigate', { ...exact, [field]: 'foreign' }));
  }
  for (const url of ['javascript:alert(1)', 'file:///tmp/file', 'https://user:pass@example.com']) {
    assert.throws(() => parseCloudBrowserArguments('cloud_browser_navigate', { ...exact, url }));
  }
  assert.throws(() => parseCloudBrowserArguments('cloud_browser_read', { resource_id: 'r', expected_version: 2, target_id: 'p', max_chars: 16001 }));
  assert.throws(() => parseCloudBrowserArguments('cloud_browser_start', { recording: true }), 'recording consent is an owner UI choice');
});
test('cloud adapter refuses stale identity before dispatch and never reconciles a lost mutation by replay', async () => {
  const observed = reviewed.observeReviewedLocalTool('cloud_browser_navigate')!;
  const manifest = reviewed.reviewedLocalCapabilityManifest(observed)!;
  const call = { operationId: 'cloud_browser_navigate', accountId: reviewed.REVIEWED_LOCAL_ACCOUNT,
    args: { resource_id: 'r', expected_version: 2, target_id: 'p', url: 'https://example.com/' },
    expected: { manifestId: observed.manifestId, manifestDigest: capabilityManifestDigest(manifest),
      providerKind: 'local_registry', providerIdentity: reviewed.REVIEWED_LOCAL_PROVIDER_IDENTITY,
      providerVersion: reviewed.REVIEWED_LOCAL_PROVIDER_VERSION, operationVersion: reviewed.REVIEWED_LOCAL_OPERATION_VERSION,
      definitionFingerprint: observed.definition.envelopeFingerprint, invokePortId: observed.invokePortId,
      argumentCompiler: { ...reviewed.REVIEWED_LOCAL_ARGUMENT_COMPILER } } };
  let dispatches = 0;
  const adapter = createReviewedCloudBrowserStorageAdapter(async () => { dispatches++; throw new Error('Lost mutation settlement'); });
  await assert.rejects(adapter.execute({ ...call, accountId: 'other-account' }), /identity changed/);
  await assert.rejects(adapter.execute({ ...call, args: { ...call.args, code: 'widened' } }), /arguments exceed/);
  assert.equal(dispatches, 0);
  await assert.rejects(adapter.execute(call), /Lost mutation/);
  assert.equal(dispatches, 1);
  assert.deepEqual(await adapter.reconcile({ operationId: call.operationId, accountId: call.accountId, expected: call.expected, artifactId: 'lost' }), { exists: false });
  assert.equal(dispatches, 1);
});
test('cloud task binding comes from the host and repeated start rejoins the same accepted source', async () => {
  const created: unknown[] = [];
  const dispatched: unknown[] = [];
  const resource = { id: 'owned', pages: Array.from({ length: 100 }, (_, i) => ({ targetId: `page-${i}`, title: 'Retained display metadata '.repeat(20), url: 'https://example.com/' })) };
  const service = { create: async (input: unknown) => { created.push(input); return resource; }, agentOperation: async (...input: unknown[]) => { dispatched.push(input); return { resource, result: { text: 'exact requested page evidence' }, receipt: { targetId: 'exact-page' } }; } };
  await assert.rejects(executeCloudBrowserTool('cloud_browser_start', {}, service as never), isHostPreDispatchRefusal);
  await withToolOutputContext({ sessionId: 'chat-a', sourceUserSeq: 7, callId: 'first' }, () => executeCloudBrowserTool('cloud_browser_start', {}, service as never));
  await withToolOutputContext({ sessionId: 'chat-a', sourceUserSeq: 7, callId: 'repair' }, () => executeCloudBrowserTool('cloud_browser_start', {}, service as never));
  assert.deepEqual(created[0], created[1], 'call repair cannot buy a second session');
  assert.equal((created[0] as { recording: boolean }).recording, false);
  const value = await withToolOutputContext({ sessionId: 'chat-a', sourceUserSeq: 7 }, () => executeCloudBrowserTool('cloud_browser_read', { resource_id: 'owned', expected_version: 3, target_id: 'exact-page', max_chars: 1234 }, service as never));
  assert.deepEqual(dispatched[0], ['owned', 'chat-a', { operation: 'read', expectedVersion: 3, args: { targetId: 'exact-page', maxChars: 1234 } }, undefined]);
  assert.deepEqual(value, { resource: { id: 'owned', pageCount: 100, pagesOmitted: true }, result: { text: 'exact requested page evidence' }, receipt: { targetId: 'exact-page' } }, 'retained dock metadata never rides beside every read, but requested evidence stays intact');
});
