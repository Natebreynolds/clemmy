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
} = await import('../runtime/harness/eventlog.js');
const { acceptedTaskIdFor } = await import('../runtime/harness/attempt-identity.js');
const { durableLogicalCallContract } = await import('../runtime/harness/logical-call-contract.js');
const callAuthority = await import('../runtime/harness/accepted-turn-call-authority.js');
const hostBindings = await import('../runtime/harness/host-call-capability-binding.js');
const hostInvocation = await import('../runtime/harness/host-tool-invocation.js');
const dispatchLeases = await import('../runtime/harness/dispatch-lease.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');

type ToolLike = { invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

test.after(() => {
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  ports.clearProductionCapabilityPorts();
  closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

test('nested host catalog live-read settles a record the host can adopt', async () => {
  const previousFactory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const operationId = 'reviewed_cli_nested_settlement_read';
  const innerArgs = { query: "SELECT Email FROM User WHERE Name LIKE '%Alex Rivera%'" };
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:fixture:reviewed-cli:${operationId}`,
    providerKind: 'reviewed_cli',
    operationId,
    providerIdentity: '/usr/bin/fixture-cli',
    providerVersion: 'fixture-v1',
    operationVersion: '1',
    definitionFingerprint: 'e'.repeat(64),
    effect: 'read',
    accountId: 'reviewed_cli:host',
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
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => {
      throw new Error('catalog entry invoke is not the production port');
    },
  });
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
  const registered = ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: async (input) => ({
        records: [{ Email: 'alex.rivera@acme.example', query: input.payload }],
      }),
    },
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));

  const session = createSession({ id: 'sess-catalog-nested-settlement', kind: 'chat' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Look up Alex Rivera\'s Acme email in Salesforce.' },
  });
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
  const callId = 'call_catalog_nested_settlement';
  const carrierArgs = {
    name: operationId,
    args_json: JSON.stringify(innerArgs),
  };
  const acceptedTaskId = acceptedTaskIdFor(session.id, source.seq);
  const root = callAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = durableLogicalCallContract(acceptedTaskId, 'call_tool', carrierArgs);
  assert.ok(contract);
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
    bindingKind: 'local_envelope' as const,
    capabilityId: 'call_tool',
    schemaFingerprint: digest('call-tool-schema'),
    accountId: '',
    invokePortId: `configured-wrapper:${digest('call-tool-schema')}`,
    operationId: 'call_tool',
    manifestId: '',
    manifestDigest: '',
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
  const callTool = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['work_call']) }) as never,
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
          toolName: 'call_tool',
          args: carrierArgs,
          turn: 1,
        },
        parentLease,
        effect: 'read',
        boundary: 'nested_owned',
        deadlineMs: 3_000,
        invoke: ({ signal }) => withToolOutputContext(
          { sessionId: session.id, sourceUserSeq: source.seq, callId, toolName: 'call_tool' },
          () => callTool.invoke!(
            { context: { sessionId: session.id } },
            JSON.stringify(carrierArgs),
            { toolCall: { callId }, signal },
          ) as Promise<unknown>,
        ),
      })),
    );

    assert.doesNotMatch(String(invoked.value), /not_reachable/, String(invoked.value));
    assert.match(String(invoked.value), /alex\.rivera@acme\.example/);

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
  } finally {
    dispatchLeases.revokeDispatchLease(parentLease);
    ports.clearProductionCapabilityPorts();
    capabilityCatalogs.installHostCapabilityCatalogFactory(previousFactory);
  }
});
