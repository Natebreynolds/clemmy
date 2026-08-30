/**
 * Governing NEXT-TAG provider-neutral matrix — carrier/blank-state cohort.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/journeys/provider-neutral-northstar-matrix.acceptance.test.ts
 *
 * This is journey evidence for matrix rows 7 and 16, not a component import
 * audit. Every scenario begins without a manifest, resolution, catalog entry,
 * or invocation port. Three real production adapter contracts enumerate live
 * MCP-, reviewed-CLI-, and gateway-shaped carriers. Exactly one definition is
 * materialized through the shared definition boundary and then crosses the
 * durable workflow call kernel. The same activation is reopened and must
 * redeem its settlement without a second provider body.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CapabilityOperationRow } from '../memory/capability-index.js';
import type {
  LiveCapabilityCarrier,
  LiveCapabilityDefinition,
  LiveCapabilityPortRegistrar,
} from '../runtime/harness/live-capability-materializer.js';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-provider-neutral-northstar-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-provider-neutral-northstar\n');

const capabilityIndex = await import('../memory/capability-index.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const materializer = await import('../runtime/harness/live-capability-materializer.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const shipped = await import('../runtime/harness/shipped-implementation-identity.js');
const acquisition = await import('../runtime/harness/production-live-read-acquisition-registry.js');
const workflowKernel = await import('../runtime/harness/workflow-read-only-call-kernel.js');

type CarrierKind = 'mcp' | 'cli' | 'composio';
type MemoryTemperature = 'cold' | 'warm';

const CARRIER_KINDS = ['mcp', 'cli', 'composio'] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function generated(seed: number, label: string): string {
  return `${label}_${sha256(`${seed}\0${label}`).slice(0, 14)}`.toLowerCase();
}

function providerKind(kind: CarrierKind): LiveCapabilityDefinition['providerKind'] {
  if (kind === 'mcp') return 'native_mcp';
  if (kind === 'cli') return 'reviewed_cli';
  return 'composio';
}

interface DefinitionState {
  operationId: string;
  accountId: string;
  providerIdentity: string;
  providerVersion: string;
  operationVersion: string;
  fieldName: string;
  portId: string;
  compilerId: string;
  observedAt: number;
  objective: string;
}

interface CarrierFixture {
  carrier: LiveCapabilityCarrier;
  definition: DefinitionState;
  counts: {
    enumerate: number;
    refresh: number;
    observe: number;
    invoke: number;
  };
  rows(): CapabilityOperationRow[];
  registerPort: LiveCapabilityPortRegistrar;
}

function operationRow(input: {
  carrierKind: CarrierKind;
  carrierName: string;
  definition: DefinitionState;
  matching: boolean;
}): CapabilityOperationRow {
  const objective = input.matching
    ? input.definition.objective
    : generated(Number.parseInt(sha256(input.definition.operationId).slice(0, 8), 16), 'unrelated');
  return {
    identifier: input.definition.operationId,
    carrierKind: input.carrierKind,
    carrier: input.carrierName,
    displayName: `Read ${objective}`,
    description: `Return ${objective} from the current connected source.`,
    effectClass: 'read',
    effectProvenance: 'declared',
    accountIdentity: input.definition.accountId,
  };
}

function makeCarrier(input: {
  seed: number;
  kind: CarrierKind;
  target: boolean;
  reverseEnumeration: boolean;
}): CarrierFixture {
  const carrierName = generated(input.seed, `${input.kind}_carrier`);
  const objective = generated(input.seed, 'objective');
  const definition: DefinitionState = {
    // Substitution keeps the logical operation and argument vocabulary equal
    // across carrier kinds. Name permutations happen between generated seeds.
    operationId: generated(input.seed, 'operation'),
    accountId: generated(input.seed, `${input.kind}_account`),
    providerIdentity: generated(input.seed, `${input.kind}_provider`),
    providerVersion: '1',
    operationVersion: '1',
    fieldName: generated(input.seed, 'input_field'),
    portId: generated(input.seed, `${input.kind}_port`),
    compilerId: generated(input.seed, `${input.kind}_compiler`),
    observedAt: Date.now() - 100,
    objective: input.target ? objective : generated(input.seed, `${input.kind}_other_objective`),
  };
  const distractors: DefinitionState[] = [0, 1].map((ordinal) => ({
    ...definition,
    operationId: generated(input.seed, `${input.kind}_distractor_${ordinal}`),
    accountId: generated(input.seed, `${input.kind}_distractor_account_${ordinal}`),
    portId: generated(input.seed, `${input.kind}_distractor_port_${ordinal}`),
    compilerId: generated(input.seed, `${input.kind}_distractor_compiler_${ordinal}`),
    objective: generated(input.seed, `${input.kind}_distractor_objective_${ordinal}`),
  }));
  const definitions = [definition, ...distractors];
  const counts = { enumerate: 0, refresh: 0, observe: 0, invoke: 0 };
  const rows = (): CapabilityOperationRow[] => {
    const values = definitions.map((candidate) => operationRow({
      carrierKind: input.kind,
      carrierName,
      definition: candidate,
      matching: candidate === definition,
    }));
    return input.reverseEnumeration ? values.reverse() : values;
  };
  const carrier: LiveCapabilityCarrier = {
    identity: { kind: input.kind, name: carrierName },
    async enumerate() {
      counts.enumerate += 1;
      return rows();
    },
    async refresh() {
      counts.refresh += 1;
    },
    observe(reference) {
      counts.observe += 1;
      const matches = definitions.filter((candidate) => (
        candidate.operationId === reference.identifier
        && candidate.accountId === reference.accountId
      ));
      if (matches.length === 0) return 'missing';
      if (matches.length !== 1) return 'ambiguous';
      const current = matches[0]!;
      return {
        operationId: current.operationId,
        providerKind: providerKind(input.kind),
        providerIdentity: current.providerIdentity,
        providerVersion: current.providerVersion,
        operationVersion: current.operationVersion,
        accountId: current.accountId,
        effect: 'read',
        effectAttestation: input.kind === 'cli' ? 'host_reviewed' : 'carrier_declared',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { [current.fieldName]: { type: 'string' } },
          required: [current.fieldName],
        },
        observedAt: current.observedAt,
        invoke: {
          portId: current.portId,
          argumentCompiler: { id: current.compilerId, version: current.operationVersion },
        },
      };
    },
  };

  const registerPort: LiveCapabilityPortRegistrar = ({ manifest, attestation }) => {
    const fresh = () => ({
      operationId: attestation.reference.identifier,
      accountId: attestation.accountId,
      definitionFingerprint: attestation.definitionFingerprint,
      providerVersion: attestation.providerVersion,
      operationVersion: attestation.operationVersion,
      observedAt: Date.now(),
    });
    // The isolated shipped observer remains the independent source of the
    // crossing-time identity. Neither the manifest nor the index is echoed.
    shipped.loadShippedImplementations().registerIsolatedObservation(fresh());
    const registeredObservation = observations.registerIndependentCapabilityObservation({
      ...fresh(),
      origin: 'independent',
      observe: fresh,
    });
    if (!registeredObservation.ok) return { ok: false, reason: registeredObservation.reason };
    return ports.registerFixtureCapabilityPort(
      ports.productionPortIdentityFromManifest(manifest),
      {
        observe: () => ({
          definitionFingerprint: attestation.definitionFingerprint,
          providerVersion: attestation.providerVersion,
          operationVersion: attestation.operationVersion,
          accountId: attestation.accountId,
          observedAt: Date.now(),
        }),
        invoke: async ({ payload }) => {
          counts.invoke += 1;
          return {
            successful: true,
            data: {
              records: [{ ordinal: 1, value: (payload as Record<string, unknown>)[definition.fieldName] }],
              exhausted: true,
            },
          };
        },
      },
    );
  };
  return { carrier, definition, counts, rows, registerPort };
}

function distractorEntry(seed: number, ordinal: number): catalogs.RegisteredHostCapability {
  const operationId = generated(seed, `catalog_distractor_${ordinal}`);
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: generated(seed, `manifest_distractor_${ordinal}`),
    providerKind: 'local_registry',
    operationId,
    providerIdentity: generated(seed, 'catalog_distractor_provider'),
    providerVersion: '1',
    operationVersion: '1',
    definitionFingerprint: sha256(`${seed}\0catalog-distractor\0${ordinal}`),
    effect: 'read',
    accountId: generated(seed, `catalog_distractor_account_${ordinal}`),
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'result' },
    purpose: 'invoke_live_read',
    acceptedInputKinds: ['arguments'],
    producedOutputKinds: ['result'],
    applicableDeliverableKinds: ['result'],
    evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: {
      issuer: 'journey:provider-neutral-northstar',
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    argumentCompiler: { id: generated(seed, `catalog_distractor_compiler_${ordinal}`), version: '1' },
    invokePortId: generated(seed, `catalog_distractor_port_${ordinal}`),
  });
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => {
      throw new Error('catalog distractor must not execute');
    },
  };
}

interface CanonicalKernelObservation {
  logical: Array<{ state: string; outcome_kind: string | null }>;
  businessPhysical: Array<{ state: string; relation: string; execution_site: string | null }>;
  settlement: Array<{
    execution_kind: string;
    outcome_kind: string;
    business_call: number;
    mutating: number;
    host_crossing_count: number;
  }>;
  resultHandles: Array<{
    scope_kind: string;
    tool_name: string;
    argument_digest_bytes: number;
    argument_digest_bound: number;
    raw_payload_sha256: string;
    raw_byte_count: number;
    success: number;
    record_count: number;
    completeness: string;
    rejection_reason: string | null;
  }>;
  /** Workflow reads evidence their result with one immutable settlement event
   * joined to one authoritative result handle. The separate
   * `evidence_receipts` table is a foreground manifested-task projection and
   * must stay empty rather than fabricating a host manifest for this workflow. */
  readEvidenceTuples: Array<{
    protocol_version: number;
    event_type: string;
    execution_kind: string;
    outcome_kind: string;
    outcome_evidence: string;
    recovery_action: string;
    business_call: number;
    mutating: number;
    dispatch_state: string;
    result_handle_bound: number;
    handle_scope: string;
    handle_success: number;
  }>;
  hostEvidenceReceiptCount: number;
  approvalCount: number;
  writeEvidenceCount: number;
  result: unknown;
}

function canonicalKernelObservation(
  sessionId: string,
  result: unknown,
): CanonicalKernelObservation {
  const db = eventlog.openEventLog();
  return {
    logical: db.prepare(`
      SELECT state, outcome_kind
        FROM logical_tool_calls
       WHERE session_id = ?
       ORDER BY logical_tool_call_id
    `).all(sessionId) as CanonicalKernelObservation['logical'],
    businessPhysical: db.prepare(`
      SELECT state, relation, execution_site
        FROM physical_dispatches
       WHERE session_id = ? AND relation != 'probe'
       ORDER BY ordinal
    `).all(sessionId) as CanonicalKernelObservation['businessPhysical'],
    settlement: db.prepare(`
      SELECT execution_kind, outcome_kind, business_call, mutating,
             host_crossing_count
        FROM logical_call_settlements
       WHERE session_id = ?
       ORDER BY logical_tool_call_id
    `).all(sessionId) as CanonicalKernelObservation['settlement'],
    resultHandles: db.prepare(`
      SELECT h.scope_kind, h.tool_name,
             length(h.argument_digest) AS argument_digest_bytes,
             CASE WHEN h.argument_digest = l.argument_digest
                    AND h.argument_digest = p.argument_digest
                  THEN 1 ELSE 0 END AS argument_digest_bound,
             h.raw_payload_sha256, h.raw_byte_count, h.success,
             h.record_count, h.completeness, h.rejection_reason
        FROM durable_result_handles h
        JOIN logical_tool_calls l
          ON l.session_id = h.session_id
         AND l.source_user_seq = h.source_user_seq
         AND l.logical_tool_call_id = h.logical_tool_call_id
        JOIN physical_dispatches p
          ON p.session_id = h.session_id
         AND p.source_user_seq = h.source_user_seq
         AND p.logical_tool_call_id = h.logical_tool_call_id
         AND p.physical_dispatch_id = h.physical_dispatch_id
       WHERE h.session_id = ?
       ORDER BY h.logical_tool_call_id
    `).all(sessionId) as CanonicalKernelObservation['resultHandles'],
    readEvidenceTuples: db.prepare(`
      SELECT s.protocol_version,
             e.type AS event_type,
             s.execution_kind,
             s.outcome_kind,
             s.outcome_evidence,
             s.recovery_action,
             s.business_call,
             s.mutating,
             json_extract(e.data_json, '$.dispatchState') AS dispatch_state,
             CASE WHEN s.result_handle_id = h.handle_id
                    AND json_extract(e.data_json, '$.resultHandleId') = h.handle_id
                  THEN 1 ELSE 0 END AS result_handle_bound,
             h.scope_kind AS handle_scope,
             h.success AS handle_success
        FROM logical_call_settlements s
        JOIN events e ON e.id = s.settlement_event_id
        JOIN durable_result_handles h ON h.handle_id = s.result_handle_id
       WHERE s.session_id = ?
       ORDER BY s.logical_tool_call_id
    `).all(sessionId) as CanonicalKernelObservation['readEvidenceTuples'],
    hostEvidenceReceiptCount: (db.prepare(`
      SELECT COUNT(*) AS n FROM evidence_receipts WHERE session_id = ?
    `).get(sessionId) as { n: number }).n,
    approvalCount: (db.prepare(`
      SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?
    `).get(sessionId) as { n: number }).n,
    writeEvidenceCount: (db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM write_evidence_bindings WHERE session_id = ?)
        + (SELECT COUNT(*) FROM write_evidence_dispatch_outcomes WHERE session_id = ?)
        + (SELECT COUNT(*) FROM write_evidence_proofs WHERE session_id = ?) AS n
    `).get(sessionId, sessionId, sessionId) as { n: number }).n,
    result,
  };
}

function resetAuthoritySurfaces() {
  eventlog.resetEventLog();
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  const store = manifestStores.createCapabilityManifestStore([], { durable: false });
  const factory = catalogs.createHostCapabilityCatalogFactory();
  manifestStores.installCapabilityManifestStore(store);
  catalogs.installHostCapabilityCatalogFactory(factory);
  return { store, factory };
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  const normalized = ((offset % values.length) + values.length) % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
}

async function runBlankCarrierScenario(input: {
  seed: number;
  memory: MemoryTemperature;
  targetKind: CarrierKind;
  order: number;
}): Promise<{
  observation: CanonicalKernelObservation;
  carrierCounts: Record<CarrierKind, CarrierFixture['counts']>;
}> {
  const { store, factory } = resetAuthoritySurfaces();
  const objective = generated(input.seed, 'objective');
  const fixtures = new Map<CarrierKind, CarrierFixture>(CARRIER_KINDS.map((kind, ordinal) => [
    kind,
    makeCarrier({
      seed: input.seed,
      kind,
      target: kind === input.targetKind,
      reverseEnumeration: (input.order + ordinal) % 2 === 1,
    }),
  ]));
  const target = fixtures.get(input.targetKind)!;

  assert.equal(store.list().length, 0, 'blank state seeded a manifest');
  assert.equal(factory.snapshot().length, 0, 'blank state seeded a catalog row');
  assert.equal(ports.listProductionCapabilityPorts().length, 0, 'blank state seeded an invoke port');

  if (input.memory === 'warm') {
    // Advisory index memory is intentionally present without any authority
    // surface. Index-only discovery still cannot be a passing result below.
    capabilityIndex.recordCapabilityOperations([operationRow({
      carrierKind: input.targetKind,
      carrierName: target.carrier.identity.name,
      definition: target.definition,
      matching: true,
    })]);
    assert.equal(store.list().length, 0);
    assert.equal(factory.snapshot().length, 0);
    assert.equal(ports.listProductionCapabilityPorts().length, 0);
  }

  const adapters = CARRIER_KINDS.map((kind) => {
    const fixture = fixtures.get(kind)!;
    return acquisition.createAttestedLiveReadCarrierAdapter({
      adapterId: `${kind}:${fixture.carrier.identity.name}`,
      carrier: fixture.carrier,
      materialize: (requestedObjective, expectedIdentity) => (
        materializer.materializeLiveReadCapability({
          objective: requestedObjective,
          carrier: fixture.carrier,
          expectedIdentity,
          registerPort: fixture.registerPort,
          store,
          factory,
          refreshIndependentObservation: async (expected) => {
            shipped.loadShippedImplementations().registerIsolatedObservation({
              ...expected,
              observedAt: Date.now(),
            });
            return observations.independentlyObserveCapability(
              expected.operationId,
              expected.accountId,
            );
          },
        })
      ),
    });
  });
  const orderedAdapters = rotate(adapters, input.order);
  if (input.order % 2 === 1) orderedAdapters.reverse();
  const registry = acquisition.createProductionLiveReadAcquisitionRegistry({
    configuredAdapters: () => orderedAdapters,
    store,
    factory,
  });
  const installed = await registry.acquire({
    requirementId: generated(input.seed, 'requirement'),
    objective: `retrieve ${objective}`,
    effect: 'read',
  });
  assert.equal(installed.status, 'installed', JSON.stringify(installed));
  if (installed.status !== 'installed') throw new Error(JSON.stringify(installed));
  assert.equal(installed.manifest.operationId, target.definition.operationId);
  assert.equal(installed.manifest.providerKind, providerKind(input.targetKind));
  assert.equal(installed.manifest.accountId, target.definition.accountId);
  assert.equal(store.list().filter((entry) => entry.manifest.lifecycle.state === 'current').length, 1);
  assert.equal(factory.snapshot().length, 1);
  assert.equal(ports.listProductionCapabilityPorts().length, 1);
  assert.ok(target.counts.enumerate >= 2, 'index-only discovery bypassed the live enumerator');
  assert.ok(target.counts.refresh >= 1, 'materialization did not refresh the exact live definition');
  assert.ok(target.counts.observe >= 3, 'materialization did not re-read the live definition');
  assert.equal(target.counts.invoke, 0, 'metadata materialization performed business I/O');

  // Rebuild the catalog with unrelated current rows in a different order for
  // every scenario. Exact operation identity, never insertion order, must bind.
  const selected = factory.snapshot()[0]!;
  const distractors = [distractorEntry(input.seed, 0), distractorEntry(input.seed, 1)];
  const catalogEntries = rotate([selected, ...distractors], input.order);
  if (input.order % 2 === 0) catalogEntries.reverse();
  catalogs.installHostCapabilityCatalogFactory(
    catalogs.createHostCapabilityCatalogFactory(catalogEntries),
  );

  const sessionId = generated(input.seed, 'workflow_session');
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  const args = { [target.definition.fieldName]: generated(input.seed, 'argument_value') };
  const armed = workflowKernel.acquireWorkflowReadOnlyOperationAuthority({
    sessionId,
    workflowId: generated(input.seed, 'workflow'),
    runId: generated(input.seed, 'run'),
    runOccurrenceId: generated(input.seed, 'occurrence'),
    nodeId: generated(input.seed, 'node'),
    requirementId: generated(input.seed, 'requirement'),
    logicalCapabilityId: generated(input.seed, 'logical_capability'),
    operationId: target.definition.operationId,
    args,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  if (armed.status !== 'armed') throw new Error(armed.reason);
  const first = await workflowKernel.executeWorkflowReadOnlyCall({
    activationId: armed.activationId,
    invocationPlan: armed.invocationPlan,
    args,
  });
  assert.equal(first.status, 'completed', JSON.stringify(first));
  if (first.status !== 'completed') throw new Error(JSON.stringify(first));
  const afterReopen = await workflowKernel.executeWorkflowReadOnlyCall({
    activationId: armed.activationId,
    invocationPlan: armed.invocationPlan,
    args,
  });
  assert.equal(afterReopen.status, 'replayed', JSON.stringify(afterReopen));
  if (afterReopen.status !== 'replayed') throw new Error(JSON.stringify(afterReopen));
  assert.deepEqual(afterReopen.result, first.result);
  assert.equal(target.counts.invoke, 1, 'durable replay repeated the provider effect');
  assert.equal(
    [...fixtures.values()].reduce((total, fixture) => total + fixture.counts.invoke, 0),
    1,
    'a non-selected carrier crossed business I/O',
  );

  return {
    observation: canonicalKernelObservation(sessionId, first.result),
    carrierCounts: Object.fromEntries(
      CARRIER_KINDS.map((kind) => [kind, fixtures.get(kind)!.counts]),
    ) as Record<CarrierKind, CarrierFixture['counts']>,
  };
}

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

test('matrix rows 7 and 16: blank MCP, CLI, and gateway carriers materialize and cross one canonical kernel', {
  timeout: 180_000,
}, async (t) => {
  for (const seed of [17, 29]) {
    for (const memory of ['cold', 'warm'] as const) {
      let carrierBaseline: CanonicalKernelObservation | null = null;
      for (const [ordinal, targetKind] of CARRIER_KINDS.entries()) {
        await t.test(`seed=${seed} memory=${memory} carrier=${targetKind}`, async () => {
          const result = await runBlankCarrierScenario({
            seed,
            memory,
            targetKind,
            order: seed + ordinal + (memory === 'warm' ? 1 : 0),
          });
          assert.deepEqual(result.observation.logical, [{ state: 'settled', outcome_kind: 'succeeded' }]);
          assert.deepEqual(result.observation.businessPhysical, [{
            state: 'returned',
            relation: 'primary',
            // Workflow physical rows intentionally carry no foreground-host
            // execution-site label; their activation root owns the surface.
            execution_site: null,
          }]);
          assert.deepEqual(result.observation.settlement, [{
            execution_kind: 'provider_execution',
            outcome_kind: 'succeeded',
            business_call: 1,
            mutating: 0,
            host_crossing_count: 0,
          }]);
          assert.equal(result.observation.resultHandles.length, 1);
          assert.deepEqual(result.observation.resultHandles.map((handle) => ({
            scope_kind: handle.scope_kind,
            tool_name: handle.tool_name,
            argument_digest_bytes: handle.argument_digest_bytes,
            argument_digest_bound: handle.argument_digest_bound,
            raw_payload_digest_bytes: handle.raw_payload_sha256.length,
            raw_byte_count: handle.raw_byte_count,
            success: handle.success,
            record_count: handle.record_count,
            completeness: handle.completeness,
            rejection_reason: handle.rejection_reason,
          })), [{
            scope_kind: 'authoritative',
            tool_name: generated(seed, 'operation'),
            argument_digest_bytes: 64,
            argument_digest_bound: 1,
            raw_payload_digest_bytes: 64,
            raw_byte_count: Buffer.byteLength(JSON.stringify(result.observation.result), 'utf8'),
            success: 1,
            record_count: 1,
            completeness: 'complete',
            rejection_reason: null,
          }]);
          assert.deepEqual(result.observation.readEvidenceTuples, [{
            protocol_version: 1,
            event_type: 'tool_attempt_settled',
            execution_kind: 'provider_execution',
            outcome_kind: 'succeeded',
            outcome_evidence: 'structured',
            recovery_action: 'settle',
            business_call: 1,
            mutating: 0,
            dispatch_state: 'dispatched',
            result_handle_bound: 1,
            handle_scope: 'authoritative',
            handle_success: 1,
          }]);
          assert.equal(result.observation.hostEvidenceReceiptCount, 0,
            'workflow receipt truth must not fabricate a foreground manifested-task receipt');
          assert.equal(result.observation.approvalCount, 0);
          assert.equal(result.observation.writeEvidenceCount, 0);
          for (const kind of CARRIER_KINDS) {
            assert.ok(result.carrierCounts[kind].enumerate >= 1,
              `${kind} enumerator was not observed in the global exact-one decision`);
          }
          if (!carrierBaseline) carrierBaseline = result.observation;
          else assert.deepEqual(
            result.observation,
            carrierBaseline,
            'equivalent carriers changed canonical calls, receipts, or outcome',
          );
        });
      }
    }
  }
});
