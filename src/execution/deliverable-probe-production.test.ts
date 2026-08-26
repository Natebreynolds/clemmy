/** Run: node scripts/run-tests-isolated.mjs src/execution/deliverable-probe-production.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-deliverable-readback-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-deliverable-readback\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const authority = await import('../runtime/harness/accepted-turn-call-authority.js');
const attempts = await import('../runtime/harness/attempt-identity.js');
const brackets = await import('../runtime/harness/brackets.js');
const leases = await import('../runtime/harness/dispatch-lease.js');
const invocation = await import('../runtime/harness/host-tool-invocation.js');
const toolEffects = await import('../runtime/harness/tool-effect.js');
const contracts = await import('../runtime/harness/logical-call-contract.js');
const hostBindings = await import('../runtime/harness/host-call-capability-binding.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const adapters = await import('../runtime/harness/production-capability-adapter.js');
const productionCatalog = await import('../runtime/harness/production-capability-catalog.js');
const productionPorts = await import('../runtime/harness/production-capability-ports.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const isolated = await import('../runtime/harness/isolated-attested-transport.fixture.js');
const acceptedReadback = await import('../runtime/harness/accepted-source-readback.js');
const resultHandles = await import('../runtime/harness/result-handle.js');
const { probeSessionDeliverables } = await import('./deliverable-probe.js');

const SHEET_ID = 'sheet_background_exact_1234567890';
const OPERATION = 'GOOGLESHEETS_BATCH_GET';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactManifest() {
  const template = productionCatalog.productionCapabilityManifests()
    .find((candidate) => candidate.operationId === OPERATION);
  assert.ok(template);
  const next = productionCatalog.accountBoundSuccessorManifest({
    template: template!,
    accountId: 'acct:deliverable-readback:connected',
    observation: {
      definitionFingerprint: template!.definitionFingerprint,
      providerVersion: template!.providerVersion,
      operationVersion: template!.operationVersion,
      accountId: 'acct:deliverable-readback:connected',
    },
    successorId: 'cap:sheet-readback:deliverable:v1',
  });
  assert.equal('ok' in next, false);
  if ('ok' in next) throw new Error(next.reason);
  return next;
}

const manifest = exactManifest();
let providerBodies = 0;

function installExactSurfaces(options: { durableStore: boolean; drift?: boolean } = { durableStore: true }) {
  const store = manifestStores.createCapabilityManifestStore([], { durable: options.durableStore });
  manifestStores.installCapabilityManifestStore(store);
  if (!store.get(manifest.manifestId)) {
    assert.deepEqual(store.install(manifest), {
      ok: true,
      digest: manifests.capabilityManifestDigest(manifest),
    });
  }
  productionPorts.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  isolated.installIsolatedAttestedTransport(async (call) => {
    providerBodies += 1;
    assert.equal(call.operationId, OPERATION);
    assert.equal(call.accountId, manifest.accountId);
    assert.equal(call.args.spreadsheet_id, SHEET_ID);
    return {
      spreadsheetId: SHEET_ID,
      valueRanges: [{
        values: [
          ['name', 'status'],
          ['alpha', 'ready'],
          ['beta', 'ready'],
        ],
      }],
    };
  });
  isolated.registerShippedTestPort(manifest, Date.now());
  const port = productionPorts.resolveProductionPortsForManifest(manifest);
  assert.ok(port?.invoke);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  const observation = {
    definitionFingerprint: options.drift ? sha256('drifted-sheet-schema') : manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    accountId: manifest.accountId,
    observedAt: Date.now(),
  };
  factory.register(adapters.registeredCapabilityFromManifest({
    manifest,
    observation,
    invoke: port!.invoke,
  }));
  return { factory, port: port! };
}

function acceptedSource(id: string) {
  const session = eventlog.createSession({ id, kind: 'execution', userId: 'background-user' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create and populate the requested Google Sheet.' },
  });
  const armed = authority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest: sha256(`catalog:${id}`),
    bindingRevisionDigest: sha256(`binding:${id}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 4,
  });
  assert.equal(armed.status, 'armed');
  const parentLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::background-parent`,
  });
  return { session, source, parentLease };
}

async function executeExactReadback(input: ReturnType<typeof acceptedSource>): Promise<void> {
  const entry = catalogs.peekHostCapabilityCatalogFactory()?.get(manifest.manifestId);
  assert.ok(entry);
  const callId = 'model:deliverable-readback';
  const args = { spreadsheet_id: SHEET_ID, ranges: ['Sheet1!A1:Z1000'] };
  const acceptedTaskId = attempts.acceptedTaskIdFor(input.session.id, input.source.seq);
  const root = authority.acceptedTurnCallAuthorityFor(input.session.id, input.source.seq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = contracts.durableLogicalCallContract(acceptedTaskId, OPERATION, args);
  assert.ok(contract);
  const attestationBase = {
    sessionId: input.session.id,
    sourceUserSeq: input.source.seq,
    acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: callId,
    toolName: contract!.toolName,
    argumentDigest: contract!.argumentDigest,
    effect: 'read' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: manifest.manifestId,
    ...(manifest.externalDefinition?.providerInputSchemaDigest
      ? { providerInputSchemaDigest: manifest.externalDefinition.providerInputSchemaDigest }
      : {}),
    schemaFingerprint: manifest.definitionFingerprint,
    accountId: manifest.accountId,
    invokePortId: manifest.invokePortId,
    operationId: manifest.operationId,
    manifestId: manifest.manifestId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
  };
  const attestation = {
    ...attestationBase,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(attestationBase),
  };
  const context: brackets.HarnessRunContext = {
    sessionId: input.session.id,
    sourceUserSeq: input.source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(8),
    dispatchLease: input.parentLease,
  };
  const before = providerBodies;
  const result = await authority.withHostCallAttestation(attestation, () =>
    brackets.withHarnessRunContext(context, () => invocation.invokeHostToolCall({
      identity: {
        sessionId: input.session.id,
        sourceUserSeq: input.source.seq,
        modelCallId: callId,
        toolName: OPERATION,
        args,
        turn: 1,
      },
      parentLease: input.parentLease,
      effect: 'read',
      boundary: 'host_owned_external',
      trustedEffectCarrier: toolEffects.trustedRuntimeEffectCarrier('composio_execute_tool', {
        tool_slug: OPERATION,
        arguments: args,
      }),
      deadlineMs: 1_000,
      invoke: async () => ({
        successful: true,
        data: await productionPorts.resolveProductionPortsForManifest(manifest)!.invoke({
          nodeId: callId,
          role: 'readback',
          payload: SHEET_ID,
          identity: {
            sessionId: input.session.id,
            sourceUserSeq: input.source.seq,
            acceptedTaskId,
          },
          binding: entry!,
        }),
      }),
    })));
  assert.equal(providerBodies, before + 1);
  assert.equal((result.value as { data?: { id?: string } }).data?.id, SHEET_ID);
  leases.revokeDispatchLease(input.parentLease);
  assert.equal(authority.closeHostCallAuthority({
    sessionId: input.session.id,
    sourceUserSeq: input.source.seq,
    outcome: 'completed',
  }).status, 'closed');
}

function appendCreatedSheetReturn(
  input: ReturnType<typeof acceptedSource>,
  options: { includeSource: boolean } = { includeSource: true },
): void {
  eventlog.appendEvent({
    sessionId: input.session.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: {
      ...(options.includeSource ? { sourceUserSeq: input.source.seq } : {}),
      tool: 'GOOGLESHEETS_SHEET_FROM_JSON',
      callId: 'model:create-sheet',
      ok: true,
      preview: JSON.stringify({ spreadsheet_id: SHEET_ID }),
    },
  });
}

function physicalRows(sessionId: string): number {
  return (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatches WHERE session_id = ?
  `).get(sessionId) as { count: number }).count;
}

test.after(() => {
  try { isolated.installIsolatedAttestedTransport(null); } catch { /* isolated contract teardown */ }
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

test('default background Sheet probe redeems one exact source read and restart replay adds zero crossings', async () => {
  eventlog.resetEventLog();
  providerBodies = 0;
  installExactSurfaces();
  const origin = acceptedSource('background-deliverable-positive');
  await executeExactReadback(origin);
  appendCreatedSheetReturn(origin);

  const bound = hostBindings.loadHostCallCapabilityBinding({
    db: eventlog.openEventLog(),
    sessionId: origin.session.id,
    sourceUserSeq: origin.source.seq,
    logicalToolCallId: 'model:deliverable-readback',
  });
  assert.equal(bound.status, 'ok', bound.status === 'ok' ? undefined : bound.reason);
  const settled = resultHandles.redeemAuthoritativeResultPayload({
    kind: 'successful_settlement',
    sessionId: origin.session.id,
    sourceUserSeq: origin.source.seq,
    acceptedTaskId: attempts.acceptedTaskIdFor(origin.session.id, origin.source.seq),
    logicalToolCallId: 'model:deliverable-readback',
  });
  assert.equal(settled.status, 'ok', settled.status === 'ok' ? undefined : settled.reason);
  if (settled.status === 'ok') {
    assert.equal((settled.value.rawPayload as { data?: { id?: string } }).data?.id, SHEET_ID);
    assert.ok(settled.value.physicalDispatchId);
  }

  const exact = acceptedReadback.redeemAcceptedSourceReadback({
    sessionId: origin.session.id,
    sourceUserSeq: origin.source.seq,
    resourceId: SHEET_ID,
  });
  assert.equal(exact.status, 'ok', exact.status === 'unavailable' ? exact.reason : undefined);

  const first = await probeSessionDeliverables(
    origin.session.id,
    'Create and populate the requested Google Sheet with the data rows.',
  );
  assert.equal(first.failures.length, 0, first.summary);
  assert.match(first.evidenceText, /3 rows/);
  assert.equal(providerBodies, 1, 'one provider body produced the settled readback');
  assert.equal(physicalRows(origin.session.id), 1, 'one provider crossing has one physical start');

  // Process-like restart: rebuild every process-global exact surface from the
  // durable manifest while retaining the event/settlement database.
  eventlog.closeEventLog();
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  productionPorts.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  installExactSurfaces({ durableStore: true });

  const replay = await probeSessionDeliverables(
    origin.session.id,
    'Create and populate the requested Google Sheet with the data rows.',
  );
  assert.equal(replay.failures.length, 0, replay.summary);
  assert.equal(providerBodies, 1, 'settlement redemption never re-enters the provider body');
  assert.equal(physicalRows(origin.session.id), 1, 'restart replay adds zero physical starts');
});

test('missing accepted-source attribution blocks readiness with zero body and zero physical row', async () => {
  eventlog.resetEventLog();
  providerBodies = 0;
  installExactSurfaces({ durableStore: false });
  const origin = acceptedSource('background-deliverable-missing-source');
  appendCreatedSheetReturn(origin, { includeSource: false });
  const result = await probeSessionDeliverables(
    origin.session.id,
    'Populate the Google Sheet with all rows.',
  );
  assert.equal(result.failures.length, 1);
  assert.match(result.evidenceText, /UNVERIFIED \(BLOCKING\)/);
  assert.equal(providerBodies, 0);
  assert.equal(physicalRows(origin.session.id), 0);
  leases.revokeDispatchLease(origin.parentLease);
});

test('live catalog drift cannot turn a settled source read into provider redispatch', async () => {
  eventlog.resetEventLog();
  providerBodies = 0;
  installExactSurfaces();
  const origin = acceptedSource('background-deliverable-drift');
  await executeExactReadback(origin);
  appendCreatedSheetReturn(origin);
  assert.equal(providerBodies, 1);
  assert.equal(physicalRows(origin.session.id), 1);

  installExactSurfaces({ durableStore: true, drift: true });
  const result = await probeSessionDeliverables(
    origin.session.id,
    'Populate the Google Sheet with all rows.',
  );
  assert.equal(result.failures.length, 1);
  assert.match(result.evidenceText, /UNVERIFIED \(BLOCKING\)/);
  assert.equal(providerBodies, 1, 'drift refusal performs zero additional provider bodies');
  assert.equal(physicalRows(origin.session.id), 1, 'drift refusal performs zero additional physical starts');
});
