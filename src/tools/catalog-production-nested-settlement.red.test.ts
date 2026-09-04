/**
 * A nested_owned catalog live-read must settle the logical call so the host
 * can adopt it. Without that record the carrier returns a value, the host
 * fails closed on "nested-owned logical settlement is missing", and the whole
 * turn dies as bridge_runtime_failed.
 *
 * Live 2026-08-29 session-example-nested-settlement source 98339:
 * work_call → salesforce_sf_soql_query (reviewed CLI, catalog_manifest, read)
 * entered invoke, the production port returned, no logical_call_settlements
 * row, no physical_dispatch, host adopted nothing, user saw "run failed".
 *
 * Composio already settles inside the nested owner. The catalog production
 * port is the same class of terminal dispatcher and was skipping that write.
 *
 * Run: node scripts/run-tests-isolated.mjs src/tools/catalog-production-nested-settlement.red.test.ts
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-catalog-nested-settlement-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-catalog-nested-settlement\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { buildCallTool } = await import('./call-tool.js');
const { buildWorkCall } = await import('./work-call.js');
const innerDispatch = await import('./inner-dispatch.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const {
  withHarnessRunContext,
  ToolCallsCounter,
  wrapToolForHarness,
} = await import('../runtime/harness/brackets.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const {
  appendEvent,
  closeEventLog,
  createSession,
  openEventLog,
} = await import('../runtime/harness/eventlog.js');
const { acceptedTaskIdFor } = await import('../runtime/harness/attempt-identity.js');
const { durableLogicalCallContract } = await import('../runtime/harness/logical-call-contract.js');
const callAuthority = await import('../runtime/harness/accepted-turn-call-authority.js');
const hostBindings = await import('../runtime/harness/host-call-capability-binding.js');
const hostInvocation = await import('../runtime/harness/host-tool-invocation.js');
const dispatchLeases = await import('../runtime/harness/dispatch-lease.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const toolEffects = await import('../runtime/harness/tool-effect.js');
const modelBatches = await import('../runtime/harness/accepted-model-batch-checkpoint.js');
const projectionReceipts = await import('../runtime/harness/logical-model-result-projection-receipt.js');

type ToolLike = { invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

test.after(() => {
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  ports.clearProductionCapabilityPorts();
  closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

async function runNestedCatalogLiveRead(remappedCarrier: boolean): Promise<void> {
  const previousFactory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const operationId = remappedCarrier
    ? 'GOOGLESHEETS_VALUES_GET'
    : 'reviewed_cli_nested_settlement_read';
  const innerArgs = { query: "SELECT Email FROM User WHERE Name LIKE '%Alex Rivera%'" };
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:fixture:reviewed-cli:${operationId}`,
    providerKind: remappedCarrier ? 'composio' : 'reviewed_cli',
    operationId,
    providerIdentity: remappedCarrier ? 'composio' : '/usr/bin/fixture-cli',
    providerVersion: 'fixture-v1',
    operationVersion: '1',
    definitionFingerprint: 'e'.repeat(64),
    ...(remappedCarrier
      ? {
          externalDefinition: {
            version: 1 as const,
            providerInputSchemaDigest: 'f'.repeat(64),
            providerOutputSchemaObserved: true,
            providerOutputSchemaDigest: 'a'.repeat(64),
            semanticName: operationId,
            behaviorHints: {
              readOnly: true,
              destructive: false,
              idempotent: true,
              openWorld: false,
            },
          },
        }
      : {}),
    effect: 'read',
    accountId: remappedCarrier ? 'ca_cold_emitted_transport' : 'reviewed_cli:host',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    purpose: 'collect_records',
    provenance: {
      issuer: 'call-tool:reviewed-cli-nested-settlement',
      issuedAt: '2026-08-29T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
  });
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    ...(manifest.externalDefinition
      ? { providerInputSchemaDigest: manifest.externalDefinition.providerInputSchemaDigest }
      : {}),
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => {
      throw new Error('catalog entry invoke is not the production port');
    },
  });
  if (remappedCarrier) {
    // Live catalogs can legitimately expose the same provider operation
    // through more than one current account/transport. Reproduce the
    // conservative spelling-only classifier returning `unknown`: the exact
    // host attestation, not operation-name uniqueness, must retain effect and
    // port authority for this accepted call.
    const shadowManifest = capabilityManifests.attachSemanticContract({
      version: 1,
      manifestId: `cap:fixture:shadow-write:${operationId}`,
      providerKind: 'composio',
      operationId,
      providerIdentity: 'composio-shadow',
      providerVersion: 'fixture-shadow-v1',
      operationVersion: '1',
      definitionFingerprint: 'b'.repeat(64),
      effect: 'external_write',
      operationSemantics: { version: 1, reversibility: 'reversible' },
      destination: { family: 'fixture-shadow', posture: 'create_new' },
      accountId: 'ca_shadow_transport',
      idempotency: { required: true, policy: 'key_before_dispatch' },
      reconciliation: { supported: true, policy: 'exact_artifact' },
      outputContract: { kind: 'created_resource' },
      evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
      provenance: {
        issuer: 'call-tool:shadow-transport',
        issuedAt: '2026-09-04T00:00:00.000Z',
        trusted: true,
      },
      lifecycle: { state: 'current' },
    });
    factory.register({
      capabilityId: shadowManifest.manifestId,
      toolName: shadowManifest.operationId,
      schemaVersion: shadowManifest.operationVersion,
      schemaDigest: shadowManifest.definitionFingerprint,
      effect: shadowManifest.effect,
      destination: shadowManifest.destination,
      account: shadowManifest.accountId,
      manifestDigest: capabilityManifests.capabilityManifestDigest(shadowManifest),
      providerKind: shadowManifest.providerKind,
      liveFingerprint: shadowManifest.definitionFingerprint,
      manifest: shadowManifest,
      invoke: async () => {
        throw new Error('shadow catalog transport must never be selected');
      },
    });
  }
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
  const preparationOrder: string[] = [];
  const livePreparationProofs = new WeakSet<object>();
  let emittedTransportAccountCurrent = false;
  const registered = ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      admitPreparation() {
        preparationOrder.push('admit');
      },
      async prepareInvocation() {
        preparationOrder.push('prepare');
        // Reproduce the live source-daemon shape: the catalog/source client is
        // warm, while the emitted transport's private packaged-client snapshot
        // starts cold. The adapter preparation warms that exact owner.
        emittedTransportAccountCurrent = true;
        const proof = Object.freeze({});
        livePreparationProofs.add(proof);
        return proof;
      },
      async invokeWithPreparation(proof, work) {
        preparationOrder.push('consume');
        assert.ok(
          proof && typeof proof === 'object' && livePreparationProofs.has(proof as object),
          'the exact opaque preparation proof must reach the matching port',
        );
        livePreparationProofs.delete(proof as object);
        return work();
      },
      invoke: async (input) => {
        assert.equal(
          remappedCarrier,
          false,
          'a remapped work_call-compatible carrier must own the business body',
        );
        preparationOrder.push('business');
        assert.equal(
          emittedTransportAccountCurrent,
          true,
          'the emitted transport snapshot must be repaired before its business body',
        );
        return {
          records: [{ Email: 'alex.rivera@acme.example', query: input.payload }],
        };
      },
    },
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));

  const session = createSession({
    id: remappedCarrier
      ? 'sess-catalog-nested-settlement-remapped'
      : 'sess-catalog-nested-settlement-direct',
    kind: 'chat',
  });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Look up Alex Rivera\'s Acme email in Salesforce.' },
  });
  if (remappedCarrier) {
    appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'system',
      type: 'capability_resolution',
      data: {
        sourceUserSeq: source.seq,
        authoritativeForTask: true,
        registryAvailable: true,
        entries: [{
          intent: 'read the exact current spreadsheet values',
          kind: 'composio',
          identifier: operationId,
          status: 'proven',
          connection: 'active',
          accountIdentity: manifest.accountId,
          effectClass: 'read',
        }],
      },
    });
  }
  const catalogRevisionDigest = digest(`host-surface-catalog:${session.id}`);
  const bindingRevisionDigest = digest(`host-surface-binding:${session.id}`);
  const armed = callAuthority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest,
    bindingRevisionDigest,
    maxLogicalCalls: 8,
    maxParallelCalls: 4,
  });
  assert.equal(armed.status, 'armed');
  const parentLease = dispatchLeases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::host-parent`,
  });
  const callId = remappedCarrier
    ? 'call_catalog_nested_settlement_remapped'
    : 'call_catalog_nested_settlement_direct';
  const carrierName = remappedCarrier ? 'work_call' : 'call_tool';
  const carrierArgs = remappedCarrier
    ? {
        requirement_id: 'read_sheet_values',
        universe_item_id: null,
        universe_selector: null,
        seal_amendment: null,
        source_call_ids: null,
        source_record_ids: null,
        // Exact live V16 shape: the host has already normalized the model's
        // exact operation onto the trusted gateway before work_call runs. The
        // logical identity remains the carried exact operation, never the
        // gateway transport name.
        name: 'composio_execute_tool',
        args_json: JSON.stringify({
          tool_slug: operationId,
          arguments: JSON.stringify(innerArgs),
        }),
      }
    : {
        name: operationId,
        args_json: JSON.stringify(innerArgs),
      };
  // The accepted model frame keeps the model's original exact operation. Host
  // completion rewrites only the execution copy onto the trusted gateway.
  const modelCarrierArgs = remappedCarrier
    ? { ...carrierArgs, name: operationId, args_json: JSON.stringify(innerArgs) }
    : carrierArgs;
  const admittedBatch = modelBatches.admitAcceptedModelBatch({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    preHistory: [{ role: 'user', content: 'Look up Alex Rivera\'s Acme email in Salesforce.' } as never],
    frameHistory: [{
      type: 'function_call',
      callId,
      name: carrierName,
      arguments: JSON.stringify(modelCarrierArgs),
      status: 'completed',
    } as never],
    providerResponseId: `response:${callId}`,
  });
  assert.equal(admittedBatch.status, 'admitted', JSON.stringify(admittedBatch));
  if (admittedBatch.status !== 'admitted') throw new Error(admittedBatch.reason);
  const acceptedTaskId = acceptedTaskIdFor(session.id, source.seq);
  const root = callAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = durableLogicalCallContract(acceptedTaskId, carrierName, carrierArgs);
  assert.ok(contract);
  if (remappedCarrier) {
    assert.equal(
      toolEffects.classifyRuntimeToolEffect(carrierName, carrierArgs).effect,
      'unknown',
      'the regression must reproduce the live transport-only effect ambiguity',
    );
  }
  const attestationBase = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'read' as const,
    ...(remappedCarrier
      ? {
          bindingKind: 'catalog_manifest' as const,
          capabilityId: manifest.manifestId,
          schemaFingerprint: manifest.definitionFingerprint,
          accountId: manifest.accountId,
          invokePortId: manifest.invokePortId,
          operationId: manifest.operationId,
          manifestId: manifest.manifestId,
          manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
          providerInputSchemaDigest: manifest.externalDefinition!.providerInputSchemaDigest,
        }
      : {
          bindingKind: 'local_envelope' as const,
          capabilityId: carrierName,
          schemaFingerprint: digest('call-tool-schema'),
          accountId: '',
          invokePortId: `configured-wrapper:${digest('call-tool-schema')}`,
          operationId: carrierName,
          manifestId: '',
          manifestDigest: '',
        }),
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest,
    bindingRevisionDigest,
  };
  const attestation = {
    ...attestationBase,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(attestationBase),
  };
  let resolvedCarrierTarget = '';
  if (remappedCarrier) {
    innerDispatch._setInnerDispatchToolsForTests(new Map([['composio_execute_tool', {
      name: 'composio_execute_tool',
      invoke: async (_runContext: unknown, rawInput: string, details: unknown) => {
        // Mirror the real Agents SDK function-tool edge: schema parsing invokes
        // the harness callback immediately before execute, which is where the
        // nested host reserves its one business physical crossing.
        const parsedInput = JSON.parse(rawInput) as Record<string, unknown>;
        const parsedInputCallback = (
          details as Record<symbol, unknown>
        )[Symbol('openai.agents.functionToolParsedInputCallback')];
        if (typeof parsedInputCallback === 'function') parsedInputCallback(parsedInput);
        resolvedCarrierTarget = 'composio_execute_tool';
        preparationOrder.push('business');
        assert.equal(
          emittedTransportAccountCurrent,
          true,
          'the cold emitted transport must be refreshed before gateway business',
        );
        return { records: [{ Email: 'alex.rivera@acme.example', query: innerArgs }] };
      },
    } as never]]));
  }
  const carrier = wrapToolForHarness(
    (remappedCarrier
      ? buildWorkCall({
          requireHostPlan: true,
          reachableBuiltinNames: new Set(['composio_execute_tool']),
          catalogIdentifiers: [operationId],
          settlementLane: 'byo',
          hostPlanningReady: () => true,
        })
      : buildCallTool({ reachableBuiltinNames: new Set(['work_call']) })) as never,
  ) as unknown as ToolLike;

  try {
    const invoked = await callAuthority.withHostCallAttestation(attestation, () =>
      withHarnessRunContext({
        sessionId: session.id,
        sourceUserSeq: source.seq,
        turn: 1,
        counter: new ToolCallsCounter(10),
        dispatchLease: parentLease,
      }, () => hostInvocation.invokeHostToolCall({
        identity: {
          sessionId: session.id,
          sourceUserSeq: source.seq,
          modelCallId: callId,
          toolName: carrierName,
          args: carrierArgs,
          turn: 1,
        },
        parentLease,
        effect: 'read',
        boundary: 'nested_owned',
        deadlineMs: 3_000,
        invoke: ({ signal }) => withToolOutputContext(
          { sessionId: session.id, sourceUserSeq: source.seq, callId, toolName: carrierName },
          () => carrier.invoke!(
            { context: { sessionId: session.id } },
            JSON.stringify(carrierArgs),
            { toolCall: { callId }, signal },
          ) as Promise<unknown>,
        ),
      })),
    );

    assert.doesNotMatch(String(invoked.value), /not_reachable/, String(invoked.value));
    assert.match(String(invoked.value), /alex\.rivera@acme\.example/);
    if (remappedCarrier) {
      assert.equal(
        resolvedCarrierTarget,
        'composio_execute_tool',
        'the regression must traverse V15\'s normalized gateway path',
      );
    }
    assert.deepEqual(
      preparationOrder,
      ['admit', 'prepare', 'consume', 'business'],
      'catalog dispatch must acquire and consume preparation before entering the business body',
    );
    if (remappedCarrier) {
      const physicalRows = openEventLog().prepare(`
        SELECT relation, state
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ?
         ORDER BY ordinal
      `).all(session.id, source.seq) as Array<{ relation: string; state: string }>;
      assert.equal(
        physicalRows.length,
        1,
        `preparation must not freeze the business logical call with its own physical row: ${JSON.stringify(physicalRows)}`,
      );
      assert.notEqual(physicalRows[0]?.relation, 'probe');
      assert.equal(physicalRows[0]?.state, 'returned');
      const rootState = openEventLog().prepare(`
        SELECT state, close_reason
          FROM accepted_turn_call_authorities
         WHERE session_id = ? AND source_user_seq = ?
      `).get(session.id, source.seq) as { state: string; close_reason: string | null };
      assert.equal(
        rootState.state,
        'open',
        `transport classification must not poison the accepted root: ${JSON.stringify(rootState)}`,
      );
      assert.equal(rootState.close_reason, null);
    }

    const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedTaskId,
      logicalToolCallId: callId,
    });
    assert.equal(
      redeemed.status,
      'ok',
      `catalog production dispatch must settle the nested logical call — got ${JSON.stringify(redeemed)}`,
    );
    if (remappedCarrier) {
      const resultItem = {
        type: 'function_call_result',
        callId,
        name: carrierName,
        status: 'completed',
        output: {
          structuredContent: { value: invoked.value },
          content: [{ type: 'text', text: String(invoked.value) }],
        },
      } as never;
      const receipt = projectionReceipts.recordLogicalModelResultProjectionReceipt({
        admission: admittedBatch.admission,
        resultItem,
      });
      assert.equal(
        receipt.status,
        'recorded',
        `the accepted model-visible work_call must project through its exact inner settlement: ${JSON.stringify(receipt)}`,
      );
      if (receipt.status === 'recorded') {
        assert.equal(receipt.receipt.settlementIdentityKind, 'observer');
        assert.equal(receipt.receipt.settlementLogicalToolCallId, callId);
        assert.equal(receipt.receipt.settlementObserverCallId, callId);
      }
    }
  } finally {
    innerDispatch._setInnerDispatchToolsForTests(null);
    dispatchLeases.revokeDispatchLease(parentLease);
    ports.clearProductionCapabilityPorts();
    capabilityCatalogs.installHostCapabilityCatalogFactory(previousFactory);
  }
}

test('nested host catalog live-read settles a record the host can adopt', () => (
  runNestedCatalogLiveRead(false)
));

test('cold emitted transport is prepared once on the real work_call normalized gateway path', () => (
  runNestedCatalogLiveRead(true)
));
