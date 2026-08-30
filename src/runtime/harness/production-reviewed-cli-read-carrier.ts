/**
 * Production carrier and crossing for explicitly reviewed CLI reads.
 *
 * This module contains no executable names, subcommands, vendor mappings, or
 * verb inference. It translates the one generic reviewed descriptor contract
 * into the shared live-read carrier. The physical crossing lives in the
 * storage-free reviewed-cli-read-transport leaf.
 */
import type { CapabilityOperationRow } from '../../memory/capability-index.js';
import type { CapabilityManifestV1 } from './capability-manifest.js';
import {
  attestLiveReadDefinition,
  materializeLiveReadCapability,
  type AttestedLiveReadCapability,
  type AttestedLiveReadCapabilityIdentity,
  type LiveCapabilityCarrier,
  type LiveCapabilityDefinition,
  type LiveCapabilityObservationResult,
  type LiveCapabilityReference,
  type MaterializeLiveReadCapabilityResult,
} from './live-capability-materializer.js';
import {
  productionPortIdentityFromManifest,
  registerProductionCapabilityPort,
  resolveProductionPortsForManifest,
} from './production-capability-ports.js';
import {
  isShippedInvoke,
  loadShippedImplementations,
} from './shipped-implementation-identity.js';
import { isolatedTestContractActive } from './isolated-test-contract.js';
import {
  adoptObservedCapabilityIdentity,
  type IndependentCapabilityObservation,
} from './independent-capability-observation.js';
import {
  REVIEWED_CLI_ARGUMENT_COMPILER_ID,
  REVIEWED_CLI_READ_ACCOUNT,
  REVIEWED_CLI_READ_CARRIER,
  currentReviewedCliDescriptor,
  listReviewedCliReadDescriptors,
  reviewedCliDescriptorDigest,
  reviewedCliInputSchema,
  type ReviewedCliReadDescriptorV1,
} from './reviewed-cli-read-config.js';
import {
  REVIEWED_CLI_OUTPUT_SCHEMA,
  executeReviewedCliRead,
  observeReviewedCliReadTransport,
} from './reviewed-cli-read-transport.js';

export {
  ReviewedCliProcessError,
  executeReviewedCliRead,
  observeReviewedCliReadTransport,
} from './reviewed-cli-read-transport.js';
export type {
  ReviewedCliProcessOutcomeV1,
} from './reviewed-cli-read-transport.js';

const REVIEWED_CLI_CARRIER_IDENTITY = Object.freeze({
  kind: 'cli' as const,
  name: REVIEWED_CLI_READ_CARRIER,
});

interface ReviewedCliSnapshotEntry {
  descriptor: ReviewedCliReadDescriptorV1;
  definition: LiveCapabilityDefinition;
}

export interface ProductionReviewedCliReadCarrier {
  carrier: LiveCapabilityCarrier;
  materialize(
    objective: string,
    expectedIdentity?: AttestedLiveReadCapabilityIdentity,
    publicationGuard?: () => boolean,
  ): Promise<MaterializeLiveReadCapabilityResult>;
  refreshIndependentObservation(input: {
    operationId: string;
    accountId: string;
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
  }): Promise<IndependentCapabilityObservation | null>;
}

function descriptorDefinition(
  descriptor: ReviewedCliReadDescriptorV1,
  observedAt: number,
): LiveCapabilityDefinition {
  const descriptorDigest = reviewedCliDescriptorDigest(descriptor);
  return Object.freeze({
    operationId: descriptor.operationId,
    providerKind: 'reviewed_cli' as const,
    providerIdentity: descriptor.executableRealpath,
    providerVersion: descriptor.binarySha256,
    operationVersion: descriptorDigest,
    accountId: REVIEWED_CLI_READ_ACCOUNT,
    effect: 'read',
    effectAttestation: 'host_reviewed' as const,
    inputSchema: reviewedCliInputSchema(descriptor),
    outputSchema: REVIEWED_CLI_OUTPUT_SCHEMA,
    outputSchemaAttestation: 'host_reviewed' as const,
    observedAt,
    invoke: Object.freeze({
      portId: `port:reviewed-cli:v1:${descriptorDigest}`,
      argumentCompiler: Object.freeze({
        id: REVIEWED_CLI_ARGUMENT_COMPILER_ID,
        version: descriptorDigest,
      }),
    }),
  });
}

function freshSnapshot(): readonly ReviewedCliSnapshotEntry[] {
  return Object.freeze(listReviewedCliReadDescriptors().map((configured) => {
    const descriptor = currentReviewedCliDescriptor(configured);
    if (!descriptor) {
      throw new Error(`reviewed CLI descriptor ${configured.descriptorId} no longer matches its executable bytes`);
    }
    return Object.freeze({ descriptor, definition: descriptorDefinition(descriptor, Date.now()) });
  }));
}

function cloneDefinition(definition: LiveCapabilityDefinition): LiveCapabilityDefinition {
  return JSON.parse(JSON.stringify(definition)) as LiveCapabilityDefinition;
}

function observationFromSnapshot(
  snapshot: readonly ReviewedCliSnapshotEntry[] | null,
  reference: LiveCapabilityReference,
): LiveCapabilityObservationResult {
  if (!snapshot) return 'missing';
  const matches = snapshot.filter((entry) => (
    entry.definition.operationId === reference.identifier
    && entry.definition.accountId === reference.accountId
  ));
  if (matches.length === 0) return 'missing';
  if (matches.length !== 1) return 'ambiguous';
  return cloneDefinition(matches[0]!.definition);
}

function rowForDescriptor(descriptor: ReviewedCliReadDescriptorV1): CapabilityOperationRow {
  return {
    identifier: descriptor.operationId,
    carrierKind: 'cli',
    carrier: REVIEWED_CLI_READ_CARRIER,
    displayName: descriptor.displayName,
    description: descriptor.description,
    effectClass: 'read',
    effectProvenance: 'curated',
    accountIdentity: REVIEWED_CLI_READ_ACCOUNT,
    parentIdentifier: descriptor.descriptorId,
  };
}

function definitionMatchesAttestation(input: {
  descriptor: ReviewedCliReadDescriptorV1;
  reference: LiveCapabilityReference;
  expected: AttestedLiveReadCapability;
}): { ok: true; observedAt: number } | { ok: false } {
  const attested = attestLiveReadDefinition({
    carrier: REVIEWED_CLI_CARRIER_IDENTITY,
    reference: input.reference,
    definition: descriptorDefinition(input.descriptor, Date.now()),
    now: Date.now(),
  });
  if (!attested.ok) return { ok: false };
  const actual = attested.attestation;
  return actual.definitionFingerprint === input.expected.definitionFingerprint
    && actual.providerIdentity === input.expected.providerIdentity
    && actual.providerVersion === input.expected.providerVersion
    && actual.operationVersion === input.expected.operationVersion
    && actual.accountId === input.expected.accountId
    && actual.invoke.portId === input.expected.invoke.portId
    && actual.invoke.argumentCompiler.id === input.expected.invoke.argumentCompiler.id
    && actual.invoke.argumentCompiler.version === input.expected.invoke.argumentCompiler.version
    ? { ok: true, observedAt: actual.observedAt }
    : { ok: false };
}

export function createProductionReviewedCliReadCarrier(): ProductionReviewedCliReadCarrier {
  let snapshot: readonly ReviewedCliSnapshotEntry[] | null = null;
  const expectedByOperation = new Map<string, AttestedLiveReadCapability>();
  const carrier: LiveCapabilityCarrier = {
    identity: REVIEWED_CLI_CARRIER_IDENTITY,
    async enumerate() {
      snapshot = freshSnapshot();
      return snapshot.map((entry) => rowForDescriptor(entry.descriptor));
    },
    async refresh() {
      snapshot = freshSnapshot();
    },
    observe(reference) {
      return observationFromSnapshot(snapshot, reference);
    },
  };

  const registerPort = ({
    manifest,
    attestation,
  }: {
    manifest: CapabilityManifestV1;
    attestation: AttestedLiveReadCapability;
  }): { ok: true } | { ok: false; reason: string } => {
    const matches = snapshot?.filter((entry) => (
      entry.descriptor.operationId === attestation.reference.identifier
      && entry.descriptor.accountId === attestation.accountId
    )) ?? [];
    if (matches.length !== 1) return { ok: false, reason: 'the reviewed descriptor is not uniquely current' };
    const descriptor = matches[0]!.descriptor;
    const matched = definitionMatchesAttestation({
      descriptor,
      reference: attestation.reference,
      expected: attestation,
    });
    if (!matched.ok) return { ok: false, reason: 'the reviewed descriptor changed before port registration' };
    expectedByOperation.set(`${attestation.reference.identifier}\0${attestation.accountId}`, attestation);
    const existing = resolveProductionPortsForManifest(manifest);
    if (existing) {
      const expectedArgv = [descriptor.executableRealpath, ...descriptor.argvPrefix];
      if (
        !isShippedInvoke(existing.invoke)
        || typeof existing.observe !== 'function'
        || !Array.isArray(existing.argv)
        || existing.argv.length !== expectedArgv.length
        || existing.argv.some((token, index) => token !== expectedArgv[index])
      ) {
        return { ok: false, reason: 'the exact reviewed CLI port is not a shipped implementation' };
      }
      return { ok: true };
    }
    let shipped: ReturnType<typeof loadShippedImplementations>;
    try {
      shipped = loadShippedImplementations();
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (isolatedTestContractActive()) {
      shipped.bindIsolatedTransport((call) => executeReviewedCliRead(call));
    }
    const invoke = shipped.invokeForSealedManifest(manifest);
    const registered = registerProductionCapabilityPort(
      productionPortIdentityFromManifest(manifest),
      Object.freeze({
        invoke,
        argv: Object.freeze([descriptor.executableRealpath, ...descriptor.argvPrefix]),
        observe: () => {
          const current = currentReviewedCliDescriptor(descriptor);
          if (!current) return 'mismatched';
          const currentMatch = definitionMatchesAttestation({
            descriptor: current,
            reference: attestation.reference,
            expected: attestation,
          });
          if (!currentMatch.ok) return 'mismatched';
          return {
            definitionFingerprint: attestation.definitionFingerprint,
            providerVersion: attestation.providerVersion,
            operationVersion: attestation.operationVersion,
            accountId: attestation.accountId,
            observedAt: currentMatch.observedAt,
            reviewedCli: {
              argv: Object.freeze([current.executableRealpath, ...current.argvPrefix]),
              executableRealpath: current.executableRealpath,
              binaryFingerprint: current.binarySha256,
              shell: false as const,
            },
          };
        },
      }),
    );
    return registered.ok ? { ok: true } : { ok: false, reason: registered.reason };
  };

  const refreshIndependentObservation = async (expected: {
    operationId: string;
    accountId: string;
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
  }): Promise<IndependentCapabilityObservation | null> => {
    const attestation = expectedByOperation.get(`${expected.operationId}\0${expected.accountId}`);
    if (!attestation) return null;
    await carrier.refresh({ identifier: expected.operationId, accountId: expected.accountId });
    const live = carrier.observe({ identifier: expected.operationId, accountId: expected.accountId });
    if (live === 'missing' || live === 'ambiguous') return null;
    const matches = snapshot?.filter((entry) => (
      entry.descriptor.operationId === expected.operationId
      && entry.descriptor.accountId === expected.accountId
    )) ?? [];
    if (matches.length !== 1 || !definitionMatchesAttestation({
      descriptor: matches[0]!.descriptor,
      reference: { identifier: expected.operationId, accountId: expected.accountId },
      expected: attestation,
    }).ok) return null;
    const liveObservation = observeReviewedCliReadTransport(
      expected.operationId,
      expected.accountId,
    );
    if (
      !liveObservation
      || liveObservation.definitionFingerprint !== expected.definitionFingerprint
      || liveObservation.providerVersion !== expected.providerVersion
      || liveObservation.operationVersion !== expected.operationVersion
    ) return null;
    // Isolated proofs seed the fake transport. Production must seed the
    // attested transport the same way: NODE_TEST_CONTEXT is absent on the
    // daemon, and a refresh that cannot re-observe CLI bytes used to return
    // independent_observation_missing after a unique reviewed CLI nominated.
    loadShippedImplementations().registerIsolatedObservation(liveObservation);
    // Do not refresh-then-adopt: production transport refresh deletes the
    // seeded observation first, and a stale shipped artifact that cannot
    // re-read CLI bytes then returns null. Adopt the seeded live identity.
    return adoptObservedCapabilityIdentity(expected);
  };

  return Object.freeze({
    carrier,
    refreshIndependentObservation,
    materialize(
      objective: string,
      expectedIdentity?: AttestedLiveReadCapabilityIdentity,
      publicationGuard?: () => boolean,
    ): Promise<MaterializeLiveReadCapabilityResult> {
      return materializeLiveReadCapability({
        objective,
        carrier,
        registerPort,
        refreshIndependentObservation,
        ...(expectedIdentity ? { expectedIdentity } : {}),
        ...(publicationGuard ? { publicationGuard } : {}),
      });
    },
  });
}
