import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-work-call-inner-schema-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const { buildCallTool } = await import('./call-tool.js');
const schemaCache = await import('./composio-schema-cache.js');

after(() => {
  schemaCache.resetToolSchemaCache();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('semantic admission sees exact Composio action args/schema while logical identity stays on the carrier', async () => {
  const slug = 'PROOF_LIST_TASKS';
  const exactActionSchema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  };
  schemaCache.rememberToolSchema(slug, exactActionSchema, Date.now());

  let observed: {
    targetName: string;
    targetArgs: unknown;
    targetInputSchema: unknown;
    evidenceArgs?: unknown;
    evidenceInputSchema?: unknown;
  } | undefined;
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['composio_execute_tool']),
    aroundResolvedDispatch: async (input) => {
      observed = input;
      return { successful: true, captured: true };
    },
  }) as unknown as {
    invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
  };

  const output = await callTool.invoke(
    { context: { sessionId: 'inner-schema-test' } },
    JSON.stringify({
      name: 'composio_execute_tool',
      args_json: JSON.stringify({
        tool_slug: slug,
        arguments: { query: 'alpha' },
      }),
    }),
    { toolCall: { callId: 'inner-schema-call' } },
  );

  assert.deepEqual(JSON.parse(String(output)), { successful: true, captured: true });
  assert.ok(observed);
  assert.equal(observed!.targetName, 'composio_execute_tool');
  assert.deepEqual(observed!.targetArgs, {
    tool_slug: slug,
    arguments: JSON.stringify({ query: 'alpha' }),
    connected_account_id: null,
  }, 'logical dispatch remains the trusted generic carrier contract');
  assert.deepEqual(observed!.evidenceArgs, { query: 'alpha' });
  assert.deepEqual(observed!.evidenceInputSchema, exactActionSchema,
    'evidence refinement receives the exact provider action schema, not the carrier schema');
  assert.notDeepEqual(observed!.targetInputSchema, exactActionSchema);
});

test('the count-only example in the work_call description is a VALID proposal (two-teeth pin)', async () => {
  // Tooth 1: the example must parse against the real proposal schema — schema
  // drift breaks this test, never the model's first call.
  const { WORK_CALL_COUNT_ONLY_EXAMPLE, WorkProposalSchema } = await import('./work-call.js');
  const parsed = WorkProposalSchema.safeParse(WORK_CALL_COUNT_ONLY_EXAMPLE);
  assert.equal(parsed.success, true, JSON.stringify(('error' in parsed && parsed.error) || null));
  // Tooth 2: the example must actually ride the tool description — a valid
  // constant nobody renders is a silent no-op.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./work-call.ts', import.meta.url), 'utf-8');
  assert.match(source, /JSON\.stringify\(WORK_CALL_COUNT_ONLY_EXAMPLE\)/, 'the example constant must be embedded in the work_call description');
  const sealed = WORK_CALL_COUNT_ONLY_EXAMPLE.universes[0];
  assert.equal(sealed.seal, 'complete_source_receipt', 'the example teaches the sealed-universe shape, not accepted_input');
  // Live 2026-08-11 run 5: the model proposed a compute op for drafting, then
  // composed in-model — an undischargeable requirement that blocked the writes
  // for 800s. The description must carry the composition rule; rewording it is
  // fine, deleting the teaching is not.
  assert.match(source, /compute ONLY for work a tool will perform/,
    'the description must teach that model-composed content is not a compute operation');
});

test('host-planned work_call JSON schema is the execution envelope, not the authoring proposal', async () => {
  const { z } = await import('zod');
  const {
    HostPlannedWorkCallInputSchema,
    WorkCallInputSchema,
    normalizeWorkCallInputForFrozenCardinality,
    workCallInputFromHostPlan,
  } = await import('./work-call.js');
  const planned = z.toJSONSchema(HostPlannedWorkCallInputSchema) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const authoring = z.toJSONSchema(WorkCallInputSchema) as {
    properties?: Record<string, unknown>;
  };
  assert.equal('proposal' in (planned.properties ?? {}), false, 'plan_task already owns topology');
  assert.equal((planned.required ?? []).includes('proposal'), false);
  assert.equal('proposal' in (authoring.properties ?? {}), true, 'the authoring carrier still accepts a first-call proposal');
  assert.equal((planned.required ?? []).includes('universe_item_id'), false,
    'a host-frozen once requirement does not require an each-only null placeholder');
  assert.ok(
    JSON.stringify(planned).length * 2 < JSON.stringify(authoring).length,
    'removing the topology union must shrink the advertised grammar, not just hide the field name',
  );
  const lifted = workCallInputFromHostPlan({
    requirement_id: 'read_source',
    universe_item_id: null,
    name: 'salesforce_sf_soql_query',
    args_json: '{"query":"SELECT Id FROM Opportunity"}',
  });
  assert.equal(lifted.proposal, null);
  assert.equal(lifted.universe_selector, null);
  assert.equal(lifted.seal_amendment, null);

  // Live 2026-08-29, sess-mob-481c… source 100106: GLM emitted the
  // nullable once-only slot as the JSON string "null" three times. Every
  // provider payload was otherwise valid, but the cardinality wall correctly
  // read that string as a universe member and refused before dispatch.
  const providerPayload = JSON.stringify({
    tool_slug: 'PROOF_CREATE_RECORD',
    arguments: {
      subject: 'null',
      recipient: 'person@example.test',
    },
  });
  const liveShaped = HostPlannedWorkCallInputSchema.safeParse({
    requirement_id: 'create-record',
    universe_item_id: 'null',
    universe_selector: null,
    seal_amendment: null,
    name: 'composio_execute_tool',
    args_json: providerPayload,
  });
  assert.equal(liveShaped.success, true);
  if (!liveShaped.success) return;
  const transported = workCallInputFromHostPlan(liveShaped.data);
  assert.equal(transported.universe_item_id, 'null',
    'transport parsing alone cannot reinterpret a possible each-member id');
  const repaired = normalizeWorkCallInputForFrozenCardinality(transported, {
    operations: [{ id: 'create-record', cardinality: { kind: 'once' } }],
  });
  assert.equal(repaired.universe_item_id, null,
    'the exact transport sentinel becomes absence only under frozen once authority');
  assert.equal(repaired.args_json, providerPayload,
    'normalization must never inspect or rewrite the provider payload');

  const omitted = HostPlannedWorkCallInputSchema.safeParse({
    requirement_id: 'create-record',
    name: 'composio_execute_tool',
    args_json: providerPayload,
  });
  assert.equal(omitted.success, true, 'the preferred once-call envelope simply omits each-only controls');
  if (omitted.success) {
    assert.equal(workCallInputFromHostPlan(omitted.data).universe_item_id, null);
  }

  for (const realMember of ['null', 'NULL', 'null-1', 'record:null']) {
    const preserved = normalizeWorkCallInputForFrozenCardinality({
      proposal: null,
      requirement_id: 'write-each',
      universe_item_id: realMember,
      universe_selector: null,
      seal_amendment: null,
      name: 'proof_write',
      args_json: '{}',
    }, {
      operations: [{ id: 'write-each', cardinality: { kind: 'each' } }],
    });
    assert.equal(preserved.universe_item_id, realMember,
      `each-member ${realMember} must remain cardinality evidence`);
  }
});

test('the collect-then-construct example is a VALID once-write proposal and rides the description', async () => {
  const {
    WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE,
    WorkProposalSchema,
  } = await import('./work-call.js');
  const parsed = WorkProposalSchema.safeParse(WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE);
  assert.equal(parsed.success, true, JSON.stringify(('error' in parsed && parsed.error) || null));
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./work-call.ts', import.meta.url), 'utf-8');
  assert.match(
    source,
    /JSON\.stringify\(WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE\)/,
    'the collect-then-construct example must ride the work_call description',
  );
  assert.equal(WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE.operations[1]?.cardinality.kind, 'once');
  assert.equal(WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE.universes.length, 0);
});

test('work_call inherits the proven-resolution remap by construction (two-teeth pin)', async () => {
  // The 2026-08-18 consumption fix lives in buildCallTool; work_call consumes
  // it only because its dispatcher IS buildCallTool. Tooth 1: the forwarding
  // must survive refactors — a work_call that resolves names itself would
  // silently regress the proven-slug remap for every carrier built on it.
  const { readFileSync } = await import('node:fs');
  const workCallSource = readFileSync(new URL('./work-call.ts', import.meta.url), 'utf-8');
  assert.match(
    workCallSource,
    /buildCallTool\(\{\s*\.\.\.dispatcherOptions/,
    'work_call must construct its dispatcher through buildCallTool — the proven-resolution remap lives there',
  );
  // Tooth 2: the remap itself must still be consumed inside that dispatcher.
  const callToolSource = readFileSync(new URL('./call-tool.ts', import.meta.url), 'utf-8');
  assert.match(
    callToolSource,
    /provenComposioSlugForTurn/,
    "the dispatcher must consume the turn's proven resolution at the decision point",
  );
});

test('a bound collection admits generated current catalog sources independent of carrier name', async () => {
  const {
    evaluateSourceStrategyWorkCarrier,
    sealedSourceStrategyWorkCarrierFromCatalog,
  } = await import('./work-call.js');
  const manifests = await import('../runtime/harness/capability-manifest.js');
  const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');

  const cases = [
    { providerKind: 'reviewed_cli', selectorKind: 'cli', marker: 'b' },
    { providerKind: 'native_mcp', selectorKind: 'mcp', marker: 'c' },
    { providerKind: 'composio', selectorKind: 'composio', marker: 'd' },
  ] as const;
  const generated = cases.map(({ providerKind, selectorKind, marker }) => {
    const operationId = `generated_${providerKind}_source_${marker.repeat(8)}`;
    const accountId = `${providerKind}:account:${marker.repeat(8)}`;
    const definitionFingerprint = marker.repeat(64);
    const sourceSchemaFingerprint = marker.repeat(32);
    const manifest = manifests.attachSemanticContract({
      version: 1,
      manifestId: `cap:generated:${providerKind}:${marker.repeat(16)}`,
      providerKind,
      operationId,
      providerIdentity: `${providerKind}:fixture`,
      providerVersion: `provider-${marker}`,
      operationVersion: `operation-${marker}`,
      definitionFingerprint,
      effect: 'read',
      accountId,
      idempotency: { required: false, policy: 'none' },
      reconciliation: { supported: false, policy: 'none' },
      outputContract: { kind: 'records' },
      purpose: 'collect_records',
      acceptedInputKinds: ['arguments'],
      producedOutputKinds: ['records'],
      applicableDeliverableKinds: ['records'],
      evidenceContract: { kinds: ['payload'], readbackRequired: false },
      provenance: {
        issuer: `host:generated-${providerKind}-fixture:v1`,
        issuedAt: '2026-08-27T00:00:00.000Z',
        trusted: true,
      },
      lifecycle: { state: 'current' },
      advisoryRoles: ['source', 'collection'],
      argumentCompiler: { id: `compile:${providerKind}:fixture:v1`, version: '1' },
      invokePortId: `port:${providerKind}:fixture:${marker.repeat(8)}`,
    });
    const manifestDigest = manifests.capabilityManifestDigest(manifest);
    const registered = {
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      account: manifest.accountId,
      providerKind: manifest.providerKind,
      sourceSchemaFingerprint,
      manifestDigest,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: async () => ({ records: [] }),
    };
    const current = catalogs.createHostCapabilityCatalogFactory([registered])
      .get(manifest.manifestId);
    assert.ok(current);
    const carrier = current
      ? sealedSourceStrategyWorkCarrierFromCatalog({
          entry: current,
          attestation: {
            bindingKind: 'catalog_manifest',
            capabilityId: manifest.manifestId,
            schemaFingerprint: manifest.definitionFingerprint,
            accountId: manifest.accountId,
            invokePortId: manifest.invokePortId,
            operationId: manifest.operationId,
            manifestId: manifest.manifestId,
            manifestDigest,
            effect: 'read',
          },
        })
      : null;
    assert.ok(carrier, `${providerKind} must project the same sealed source facts`);
    const capabilityId = `capability:${selectorKind}:${operationId}`;
    const binding = {
      version: 1,
      primary: { capabilityId, accountIdentity: accountId, schemaFingerprint: sourceSchemaFingerprint },
      equivalentFallbacks: [],
      topology: 'single_aggregate_read_then_single_artifact_write',
      topologyDigest: marker.repeat(64),
      destination: { family: 'workbook', posture: 'create_new' },
      effect: 'external_write',
    } as const;
    const admitted = evaluateSourceStrategyWorkCarrier({
      requirement: { role: 'collection', effect: 'read' },
      binding,
      bindingRequired: true,
      carrier,
    });
    assert.deepEqual(admitted, { status: 'admitted', capabilityId, match: 'primary' });
    return { carrier, binding, registered, manifest, manifestDigest };
  });

  const reviewed = generated[0]!;
  assert.equal(reviewed.carrier?.capability.capabilityId.startsWith('capability:cli:'), true,
    'the reviewed CLI source is supplied by manifest facts, not a shell or CLI target-name exception');

  const missing = evaluateSourceStrategyWorkCarrier({
    requirement: { role: 'collection', effect: 'read' },
    binding: reviewed.binding,
    bindingRequired: true,
    carrier: null,
  });
  assert.equal(missing.status, 'refused', 'an unsealed shell/HTTP/process substitute stays outside the binding');

  const staleSchema = evaluateSourceStrategyWorkCarrier({
    requirement: { role: 'collection', effect: 'read' },
    binding: {
      ...reviewed.binding,
      primary: { ...reviewed.binding.primary, schemaFingerprint: 'e'.repeat(32) },
    },
    bindingRequired: true,
    carrier: reviewed.carrier,
  });
  assert.equal(staleSchema.status, 'refused', 'schema drift cannot inherit a prior source binding');

  const unknownEffect = evaluateSourceStrategyWorkCarrier({
    requirement: { role: 'collection', effect: 'unknown' },
    binding: reviewed.binding,
    bindingRequired: true,
    carrier: reviewed.carrier,
  });
  assert.equal(unknownEffect.status, 'refused', 'unknown effects do not become reads through a catalog carrier');

  const writeEffect = evaluateSourceStrategyWorkCarrier({
    requirement: { role: 'collection', effect: 'external_write' },
    binding: reviewed.binding,
    bindingRequired: true,
    carrier: reviewed.carrier,
  });
  assert.equal(writeEffect.status, 'refused', 'a known write cannot inherit source-read authority');

  const copiedEntry = { ...reviewed.registered };
  assert.equal(sealedSourceStrategyWorkCarrierFromCatalog({
    entry: copiedEntry,
    attestation: {
      bindingKind: 'catalog_manifest',
      capabilityId: reviewed.manifest.manifestId,
      schemaFingerprint: reviewed.manifest.definitionFingerprint,
      accountId: reviewed.manifest.accountId,
      invokePortId: reviewed.manifest.invokePortId,
      operationId: reviewed.manifest.operationId,
      manifestId: reviewed.manifest.manifestId,
      manifestDigest: reviewed.manifestDigest,
      effect: 'read',
    },
  }), null, 'a catalog-shaped copy without the factory currentness attestation is inert');
});
