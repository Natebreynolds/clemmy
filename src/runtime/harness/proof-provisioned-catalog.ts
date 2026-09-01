/**
 * PROVISION FROM PROOF — executable half.
 *
 * `hostDescriptorsFromResolutionProof` already lets the model CITE this
 * source's proven capabilities; without registered catalog entries those
 * citations bind nothing and the admitted graph falls back to the legacy
 * lane (live 2026-08-18 session-fixture-proof-provisioning: route=act fastPath=fanout_action,
 * 14 nodes, zero operationIds). This module registers the same proven
 * Composio operations as REAL host capabilities — manifest, independent
 * observation, schema-grounded argument compiler, attested-transport invoke —
 * so the admitted graph can execute collect → construct instead of labeling
 * it.
 *
 * Authority posture:
 *  - Proof supplies IDENTITY only. Every crossing still pays the attested
 *    transport, the crossing kernel, and construct admission. No entry is
 *    registered unless a provider transport is actually bound
 *    (productionProviderCrossingAllowed), so an unprovisioned live home keeps
 *    its legacy lane instead of gaining a typed lane that can only block.
 *  - No hardcoded pack ids and no placeholder accounts: operation ids,
 *    effects, and account identity come from the capability_resolution proof
 *    recorded at runtime; argument shapes come from the slug's cached
 *    provider schema. A slug with no cached schema is skipped (fail closed).
 */
import { createHash } from 'node:crypto';
import {
  validateDocumentedComposioManifestOperationSemantics,
} from '../../integrations/composio/operation-semantics.js';
import type {
  MutationVerificationContractV1,
  OperationVerificationContractV1,
  ReadbackVerificationContractV1,
} from './mutation-verification-contract.js';
import { readbackContractMatchesMutation } from './mutation-verification-contract.js';
import {
  attachSemanticContract,
  capabilityManifestDigest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import {
  canonicalResolvedCapabilityId,
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
  canonicalCatalogIdentityOf,
  catalogIdentitiesEqual,
  type CanonicalCatalogIdentityV1,
} from './host-capability-catalog-factory.js';
import {
  peekCapabilityManifestStore,
  resolveCapabilityManifestStore,
  type CapabilityManifestStore,
  type InstalledCapabilityManifest,
} from './capability-manifest-store.js';
import {
  compareAndSetIndependentCapabilityObservation,
  peekIndependentCapabilityObservation,
  registerIndependentCapabilityObservation,
} from './independent-capability-observation.js';
import { provenCapabilityEntriesForTurn } from './capability-resolution.js';
import {
  ensureToolSchema,
  getCachedToolSchema,
  liveComposioSchemaFingerprint,
  liveComposioOperationVersion,
  liveComposioOutputSchema,
} from '../../tools/composio-schema-cache.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import {
  revalidateSelectedComposioDefinitions,
  type SelectedComposioDefinition,
  type SelectedComposioRevalidationRefusalCode,
} from '../../integrations/composio/selected-definition-revalidation.js';
import {
  COMPOSIO_PROVIDER_SURFACE_VERSION,
  fingerprintComposioProviderDefinition,
} from '../../integrations/composio/provider-definition-identity.js';
import { requireAttestedTransport } from './implementation-artifacts/attested-transport.js';
import { executeSealed, productionProviderCrossingAllowed } from './production-capability-adapters.js';
import { refreshTypedExecutionReadiness } from '../semantic-boundary/configure-typed-execution-runtime.js';
import type { GraphNodeInvocationEnvelopeV1 } from './graph-node-envelope.js';
import type { BoundNodeCapability } from './graph-node-capability.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export {
  compileProofProviderArgs,
  createProofProviderForegroundPayloadValidator,
  validateProofProviderArguments,
} from './proof-provider-args.js';
import {
  compileProofProviderArgs,
  createProofProviderForegroundPayloadValidator,
} from './proof-provider-args.js';
import pino from 'pino';


const logger = pino({ name: 'clementine-next.proof-provisioned-catalog' });
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toolkitOf(slug: string): string {
  return slug.split('_')[0]?.toLowerCase() ?? '';
}

function currentProofManifestLineage(input: {
  store: CapabilityManifestStore;
  baseCapabilityId: string;
  operationId: string;
  accountId: string;
}): readonly InstalledCapabilityManifest[] {
  const operationId = input.operationId.trim().toLowerCase();
  return input.store.list().filter((installed) => {
    const manifest = installed.manifest;
    const verified = input.store.get(manifest.manifestId);
    return Boolean(verified && verified.digest === installed.digest)
      && manifest.lifecycle.state === 'current'
      && manifest.providerKind === 'composio'
      && manifest.providerIdentity === 'composio'
      && manifest.operationId.trim().toLowerCase() === operationId
      && manifest.accountId === input.accountId
      && (
        manifest.manifestId === input.baseCapabilityId
        || manifest.manifestId.startsWith(`${input.baseCapabilityId}:definition:`)
      );
  });
}

function proofDefinitionSuccessorId(input: {
  baseCapabilityId: string;
  predecessorId: string;
  operationId: string;
  accountId: string;
  semanticDefinitionFingerprint: string;
}): string {
  // Include the predecessor as well as the new definition. A provider can
  // legitimately move v1 -> v2 -> v1; reusing the first manifest id after it
  // was superseded would make the durable store reject the restamp as an
  // identity mismatch.
  const revision = sha256(JSON.stringify({
    version: 1,
    provider: 'composio',
    operation: input.operationId.trim().toLowerCase(),
    account: input.accountId,
    predecessor: input.predecessorId,
    definition: input.semanticDefinitionFingerprint,
  })).slice(0, 24);
  return `${input.baseCapabilityId}:definition:${revision}`;
}

function schemaKeys(schema: Record<string, unknown>): { required: string[]; properties: string[] } {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  return { required, properties };
}

function looksLikeIdentifier(key: string): boolean {
  return /(?:^id$|_id$|id$|uri$|url$|handle$|ref$)/i.test(key);
}

function looksLikePage(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return /^(limit|count|page|offset|cursor|top|skip|max_results|page_size|pagesize)$/.test(normalized);
}

/**
 * Structural roles from the frozen schema. A sibling write in the same
 * toolkit does not collapse every read to readback — that made unique
 * retrieve bind miss every connected mailbox/calendar (live 2026-08-21).
 */
export function advisoryRolesForProofEntry(input: {
  effect: 'read' | 'external_write';
  schema: Record<string, unknown>;
  siblingWriteInToolkit: boolean;
}): string[] {
  if (input.effect === 'external_write') return ['create', 'destination'];
  const { required, properties } = schemaKeys(input.schema);
  const keys = [...required, ...properties];
  const pageShaped = keys.some(looksLikePage);
  const idRequired = required.some(looksLikeIdentifier);
  const roles: string[] = [];
  if (pageShaped || !idRequired) {
    roles.push('source', 'collection', 'collect');
  }
  roles.push('lookup');
  if (input.siblingWriteInToolkit || idRequired) {
    roles.push('readback');
  }
  return [...new Set(roles)];
}

export interface ProofProvisionResult {
  registered: string[];
  refusal?: {
    code: 'selected_definition_not_proven' | SelectedComposioRevalidationRefusalCode;
    identifier: string;
  };
}

/**
 * Register this source's proven Composio operations as executable catalog
 * capabilities. Idempotent per capabilityId; returns the ids registered this
 * call. Registers nothing when no provider transport is bound or the proof
 * covers no schema-compilable operation — the legacy lane stays authoritative.
 */
export async function registerProofProvisionedCapabilities(identity: {
  sessionId: string;
  sourceUserSeq: number;
}, options: {
  /** Foreground plan_task publishes only refs selected from its exact
   * disclosure ledger. Legacy/proof lanes omit this and retain their existing
   * whole-proof provisioning behavior. */
  allowedIdentifiers?: readonly string[];
  /** Discovery-time schema digests for that selected subset. Each selected
   * operation must match one forced exact-slug provider refresh before any
   * catalog/manifest entry is published. */
  expectedSchemaDigests?: readonly { identifier: string; schemaDigest: string }[];
  /** Exact selected Composio refs from both the initial live card and later
   * foreground disclosures. Only allowedIdentifiers are newly published, but
   * every row here pays the same final provider proof before freeze. */
  selectedDefinitions?: readonly SelectedComposioDefinition[];
  /** Exact host-derived verifier definitions selected from adapter-authored
   * contracts. These identifiers may be absent from the model-facing
   * capability-resolution proof, but only when exactly one selected/proven
   * mutation on the same account requires the declared readback contract. */
  hostDerivedVerificationIdentifiers?: readonly string[];
  /** Optional caller-owned liveness fence for bounded foreground discovery.
   * Provider refresh may finish after its deadline, but no manifest, catalog
   * entry, port, or compiler may publish after this predicate turns false. */
  publicationGuard?: () => boolean;
  /** Restart-only: after independent current-definition readiness, retain the
   * exact registration shape that byte-matches the already-frozen source
   * identity. This chooses between two independently re-proven shapes (direct
   * selected-definition registration and production-adapter registration); it
   * never copies optional identity fields from the persisted snapshot. */
  recoveryExpectedIdentities?: readonly CanonicalCatalogIdentityV1[];
} = {}): Promise<ProofProvisionResult> {
  const registered: string[] = [];
  try {
    if (options.publicationGuard && !options.publicationGuard()) return { registered };
    if (!productionProviderCrossingAllowed()) {
      const selected = options.selectedDefinitions?.[0]?.identifier.trim()
        || options.allowedIdentifiers?.[0]?.trim();
      return selected
        ? {
            registered,
            refusal: { code: 'selected_connection_refresh_unavailable', identifier: selected },
          }
        : { registered };
    }
    const allowed = options.allowedIdentifiers
      ? new Set(options.allowedIdentifiers.map((value) => value.trim().toLowerCase()).filter(Boolean))
      : null;
    const expectedSchemaDigests = new Map(
      (options.expectedSchemaDigests ?? []).map((entry) => [
        entry.identifier.trim().toLowerCase(),
        entry.schemaDigest.trim().toLowerCase(),
      ]),
    );
    const proofEntries = provenCapabilityEntriesForTurn(identity)
      .filter((entry) => entry.kind === 'composio'
        && (entry.effectClass === 'read' || entry.effectClass === 'write')
        && (!allowed || allowed.has(entry.identifier.trim().toLowerCase())));
    const selectedDefinitionByIdentifier = new Map(
      (options.selectedDefinitions ?? []).map((entry) => [
        entry.identifier.trim().toLowerCase(),
        entry,
      ]),
    );
    const derivedVerificationIdentifiers = new Set(
      (options.hostDerivedVerificationIdentifiers ?? [])
        .map((identifier) => identifier.trim().toLowerCase())
        .filter(Boolean),
    );
    const derivedEntries: typeof proofEntries = [];
    for (const identifier of derivedVerificationIdentifiers) {
      if (!allowed?.has(identifier)) {
        return {
          registered,
          refusal: { code: 'selected_definition_not_proven', identifier },
        };
      }
      const selectedVerifier = selectedDefinitionByIdentifier.get(identifier);
      const verifierDeclaration = selectedVerifier?.verificationContract;
      if (!selectedVerifier || !verifierDeclaration || !('readback' in verifierDeclaration)) {
        return {
          registered,
          refusal: { code: 'selected_definition_not_proven', identifier },
        };
      }
      const owners = proofEntries.filter((entry) => {
        if (entry.effectClass !== 'write') return false;
        const selectedOwner = selectedDefinitionByIdentifier.get(entry.identifier.trim().toLowerCase());
        const ownerDeclaration = selectedOwner?.verificationContract;
        return Boolean(
          selectedOwner
          && ownerDeclaration
          && 'mutation' in ownerDeclaration
          && selectedOwner.accountIdentity.trim() === selectedVerifier.accountIdentity.trim()
          && readbackContractMatchesMutation(ownerDeclaration.mutation, verifierDeclaration.readback),
        );
      });
      if (owners.length === 0) {
        return {
          registered,
          refusal: { code: 'selected_definition_not_proven', identifier },
        };
      }
      derivedEntries.push({
        intent: `host-derived verification for ${owners.map((owner) => owner.identifier).sort().join(',')}`,
        kind: 'composio',
        identifier: selectedVerifier.identifier,
        status: 'proven',
        connection: 'active',
        accountIdentity: selectedVerifier.accountIdentity,
        effectClass: 'read',
      });
    }
    const entries = [...proofEntries];
    const proofEntryIdentifiers = new Set(entries.map((entry) => entry.identifier.trim().toLowerCase()));
    for (const entry of derivedEntries) {
      if (!proofEntryIdentifiers.has(entry.identifier.trim().toLowerCase())) entries.push(entry);
    }
    if (allowed) {
      const entryByIdentifier = new Map(
        entries.map((entry) => [entry.identifier.trim().toLowerCase(), entry]),
      );
      for (const selected of allowed) {
        if (!entryByIdentifier.has(selected)) {
          return {
            registered,
            refusal: { code: 'selected_definition_not_proven', identifier: selected },
          };
        }
        const expectedSchemaDigest = expectedSchemaDigests.get(selected);
        if (
          !options.selectedDefinitions
          && (!expectedSchemaDigest || !/^[a-f0-9]{64}$/.test(expectedSchemaDigest))
        ) {
          return {
            registered,
            refusal: { code: 'selected_definition_digest_invalid', identifier: selected },
          };
        }
      }
    }

    const selectedDefinitions = options.selectedDefinitions
      ? [...options.selectedDefinitions]
      : allowed
        ? entries.map((entry) => ({
            identifier: entry.identifier.trim(),
            schemaDigest: expectedSchemaDigests.get(entry.identifier.trim().toLowerCase()) ?? '',
            accountIdentity: entry.accountIdentity?.trim() || 'runtime',
          }))
        : [];
    if (allowed && options.selectedDefinitions) {
      const selectedByIdentifier = new Map(selectedDefinitions.map((entry) => [
        entry.identifier.trim().toLowerCase(),
        entry,
      ]));
      for (const identifier of allowed) {
        const selected = selectedByIdentifier.get(identifier);
        const proof = entries.find((entry) => entry.identifier.trim().toLowerCase() === identifier);
        if (!selected || !proof || selected.accountIdentity.trim() !== (proof.accountIdentity?.trim() || 'runtime')) {
          return {
            registered,
            refusal: { code: 'selected_definition_not_proven', identifier },
          };
        }
      }
    }

    // Primary-plan authority is two phase across the complete selected
    // Composio set (initial card plus staged disclosures): verify everything,
    // then publish only the staged/proven subset.
    const revalidated = await revalidateSelectedComposioDefinitions(selectedDefinitions);
    if (options.publicationGuard && !options.publicationGuard()) return { registered };
    if (!revalidated.ok) {
      return { registered, refusal: revalidated.refusal };
    }
    const selectedSchemas = revalidated.definitions;
    if (entries.length === 0) {
      const selected = allowed?.values().next().value;
      if (selected) {
        return {
          registered,
          refusal: { code: 'selected_definition_not_proven', identifier: selected },
        };
      }
      return { registered };
    }
    const writeToolkits = new Set(
      entries.filter((entry) => entry.effectClass === 'write').map((entry) => toolkitOf(entry.identifier)),
    );
    const factory = peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
    const store = peekCapabilityManifestStore() ?? resolveCapabilityManifestStore();

    for (const entry of entries) {
      if (options.publicationGuard && !options.publicationGuard()) return { registered };
      const slug = entry.identifier.trim();
      const baseCapabilityId = `cap:resolved:${slug.toLowerCase()}`;
      // First-touch daemon: the schema cache is empty until something lists
      // provider tools. The proof names an exact operation, so fetch its
      // frozen contract now (single attempt per slug, cached after) — live
      // 2026-08-19: a fresh session's first act ask found zero cached schemas
      // and provisioned nothing.
      const selectedSchema = allowed
        ? selectedSchemas.get(slug.toLowerCase())
        : undefined;
      const schema = allowed
        ? selectedSchema?.schema ?? null
        : getCachedToolSchema(slug) ?? await ensureToolSchema(slug);
      if (!isRecord(schema)) continue; // no frozen schema → no compiler → fail closed
      const schemaDigest = selectedSchema?.schemaDigest ?? digestSchema(schema);
      const sourceSchemaFingerprint = selectedSchema?.fingerprint
        ?? liveComposioSchemaFingerprint(slug);
      const operationVersion = selectedSchema?.providerOperationVersion
        ?? liveComposioOperationVersion(slug);
      const outputSchema = selectedSchema
        ? selectedSchema.outputSchema
        : liveComposioOutputSchema(slug);
      if (!operationVersion || outputSchema === undefined) {
        if (allowed?.has(slug.toLowerCase())) {
          return {
            registered,
            refusal: {
              code: 'selected_definition_operation_version_unavailable',
              identifier: slug,
            },
          };
        }
        continue;
      }
      const effect: BoundNodeCapability['effect'] = entry.effectClass === 'write' ? 'external_write' : 'read';
      const family = toolkitOf(slug);
      const write = effect === 'external_write';
      const operationSemantics = selectedSchema
        && Object.prototype.hasOwnProperty.call(selectedSchema, 'operationSemantics')
        ? selectedSchema.operationSemantics ?? null
        : selectedSchema
          ? null
          : validateDocumentedComposioManifestOperationSemantics({
              operationId: slug,
              inputSchema: schema,
            });
      const atomicContentCommit = operationSemantics?.atomicInputContent;
      const verification: OperationVerificationContractV1 | null = selectedSchema
        && Object.prototype.hasOwnProperty.call(selectedSchema, 'verificationContract')
        ? selectedSchema.verificationContract ?? null
        : null;
      const mutationVerification: MutationVerificationContractV1 | null = verification
        && 'mutation' in verification ? verification.mutation : null;
      const readbackVerification: ReadbackVerificationContractV1 | null = verification
        && 'readback' in verification ? verification.readback : null;
      const advisoryRoles = advisoryRolesForProofEntry({
        effect: write ? 'external_write' : 'read',
        schema,
        siblingWriteInToolkit: writeToolkits.has(family),
      });
      const accountId = entry.accountIdentity?.trim() || 'runtime';
      const invokePortId = selectedSchema?.invokePortId
        ?? `port:${baseCapabilityId}:${slug}`;
      const definitionFingerprint = selectedSchema?.definitionFingerprint
        ?? fingerprintComposioProviderDefinition({
          operationId: slug,
          operationVersion,
          accountId,
          invokePortId,
          inputSchema: schema,
          outputSchema,
        });
      if (!definitionFingerprint) continue;
      const currentLineage = currentProofManifestLineage({
        store,
        baseCapabilityId,
        operationId: slug,
        accountId,
      });
      if (currentLineage.length > 1) {
        return {
          registered,
          refusal: {
            code: 'selected_definition_identity_conflict',
            identifier: slug,
          },
        };
      }
      const currentInstalled = currentLineage[0];
      const outputSchemaDigest = outputSchema ? digestSchema(outputSchema) : undefined;
      const currentDefinition = currentInstalled?.manifest;
      const currentMatches = Boolean(
        currentDefinition
        && currentDefinition.operationId === slug
        && currentDefinition.providerVersion === COMPOSIO_PROVIDER_SURFACE_VERSION
        && currentDefinition.operationVersion === operationVersion
        && currentDefinition.definitionFingerprint === definitionFingerprint
        && currentDefinition.accountId === accountId
        && currentDefinition.invokePortId === invokePortId
        && currentDefinition.externalDefinition?.providerInputSchemaDigest === schemaDigest
        && currentDefinition.externalDefinition?.providerOutputSchemaObserved === true
        && (currentDefinition.externalDefinition?.providerOutputSchemaDigest ?? null)
          === (outputSchemaDigest ?? null)
        && JSON.stringify(currentDefinition.externalDefinition?.verification ?? null)
          === JSON.stringify(verification)
        && JSON.stringify(currentDefinition.operationSemantics ?? null)
          === JSON.stringify(operationSemantics)
      );
      const semanticDefinitionFingerprint = sha256(JSON.stringify({
        definitionFingerprint,
        verification,
        operationSemantics,
      }));
      const capabilityId = currentMatches
        ? currentDefinition!.manifestId
        : currentInstalled
          ? proofDefinitionSuccessorId({
              baseCapabilityId,
              predecessorId: currentInstalled.manifest.manifestId,
              operationId: slug,
              accountId,
              semanticDefinitionFingerprint,
            })
          : canonicalResolvedCapabilityId(slug.toLowerCase(), accountId, 'composio');
      const manifest: CapabilityManifestV1 = attachSemanticContract({
        version: 1,
        manifestId: capabilityId,
        providerKind: 'composio',
        operationId: slug,
        providerIdentity: 'composio',
        providerVersion: COMPOSIO_PROVIDER_SURFACE_VERSION,
        operationVersion,
        definitionFingerprint,
        externalDefinition: {
          version: 1,
          providerInputSchemaDigest: schemaDigest,
          providerOutputSchemaObserved: true,
          ...(outputSchemaDigest
            ? { providerOutputSchemaDigest: outputSchemaDigest }
            : {}),
          semanticName: slug,
          ...(verification ? { verification } : {}),
          behaviorHints: {
            readOnly: !write,
            destructive: !write
              || atomicContentCommit
              || operationSemantics?.reversibility === 'ordinary_non_destructive'
              ? false
              : null,
            idempotent: null,
            openWorld: null,
          },
        },
        effect,
        ...(operationSemantics ? { operationSemantics } : {}),
        ...(write
          ? {
              destination: {
                family: mutationVerification?.resourceFamily ?? family,
                posture: mutationVerification?.target.source === 'provider_arguments'
                  ? 'named_existing' as const
                  : 'create_new' as const,
              },
            }
          : readbackVerification
            ? {
                destination: {
                  family: readbackVerification.resourceFamily,
                  posture: 'named_existing' as const,
                },
              }
            : {}),
        accountId,
        idempotency: { required: write, policy: write ? 'key_before_dispatch' : 'none' },
        reconciliation: { supported: write, policy: write ? 'exact_artifact' : 'none' },
        outputContract: {
          kind: mutationVerification?.producedHandleKind
            ?? (write ? 'created_resource' : 'records'),
        },
        ...(readbackVerification ? { purpose: 'verify_created_resource' } : {}),
        ...(mutationVerification
          ? {
              readbackContract: {
                required: true,
                contentDigestRequired: mutationVerification.proof === 'exact_content_v1',
              },
            }
          : {}),
        evidenceContract: {
          kinds: atomicContentCommit
            ? [...atomicContentCommit.evidence]
            : write ? ['receipt', 'readback'] : ['payload'],
          readbackRequired: write && !atomicContentCommit,
        },
        provenance: {
          issuer: 'host:resolution-proof',
          issuedAt: '1970-01-01T00:00:00.000Z',
          trusted: true,
        },
        lifecycle: { state: 'current' },
        advisoryRoles,
        argumentCompiler: { id: 'compile:proof-schema:v1', version: '1' },
        invokePortId,
        // The shared 'evidence' kind keeps every hop chainable (dag_kind_mismatch
        // trap, live 2026-08-18 session-fixture-remap-a); the role-specific kinds beside it
        // drive the evidence-mode derivation — a collection read owes durable
        // records, a readback is a point read of the created resource, and the
        // write produces that resource. The write also carries its concrete
        // destination family so a family-named deliverable stays admissible.
        acceptedInputKinds: readbackVerification
          ? ['evidence', readbackVerification.acceptedHandleKind]
          : write
          ? ['evidence', 'records']
          : (advisoryRoles.includes('collection') || advisoryRoles.includes('source') || advisoryRoles.includes('lookup'))
            ? ['evidence']
            : advisoryRoles.includes('readback')
              ? ['evidence', 'created_resource']
              : ['evidence'],
        producedOutputKinds: write
          ? ['evidence', 'created_resource']
          : (advisoryRoles.includes('collection') || advisoryRoles.includes('source') || advisoryRoles.includes('lookup'))
            ? ['evidence', 'records']
            : advisoryRoles.includes('readback')
              ? ['evidence', 'locator']
              : ['evidence', 'records'],
        applicableDeliverableKinds: write
          ? ['evidence', mutationVerification?.resourceFamily ?? family]
          : readbackVerification
            ? ['evidence', readbackVerification.resourceFamily]
            : ['evidence'],
      });
      const installed = currentInstalled && !currentMatches
        ? store.supersede(currentInstalled.manifest.manifestId, manifest)
        : store.install(manifest);
      if (!installed.ok) continue;
      if (options.publicationGuard && !options.publicationGuard()) return { registered };
      if (currentInstalled && currentInstalled.manifest.manifestId !== capabilityId) {
        // Retire only the exact predecessor in this account lineage. Forgetting
        // the lexical base globally removed another account's still-current
        // callable and caused the live A -> B -> A publication failure.
        factory.forget(currentInstalled.manifest.manifestId);
      }
      const observedAt = Date.now();
      const observation = {
        operationId: manifest.operationId,
        accountId: manifest.accountId,
        definitionFingerprint: manifest.definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
        observedAt,
        origin: 'independent',
        // Recompute the instant on every observation, exactly as the local
        // transform registration below already does. Capturing the
        // registration instant made an otherwise-current capability age out
        // of the 60-second freshness window and get evicted mid-plan — the
        // composio branch never received the fix its sibling documents.
        observe: () => ({
          operationId: manifest.operationId,
          accountId: manifest.accountId,
          definitionFingerprint: manifest.definitionFingerprint,
          providerVersion: manifest.providerVersion,
          operationVersion: manifest.operationVersion,
          observedAt: Date.now(),
        }),
      } as const;
      const registeredObservation = registerIndependentCapabilityObservation(observation);
      let observationReady = registeredObservation.ok;
      if (!registeredObservation.ok && registeredObservation.reason === 'identity_exists') {
        const expected = peekIndependentCapabilityObservation(
          manifest.operationId,
          manifest.accountId,
        );
        observationReady = Boolean(
          expected
          && compareAndSetIndependentCapabilityObservation({ expected, next: observation }).ok,
        );
      }
      if (!observationReady) {
        return {
          registered,
          refusal: {
            code: 'selected_definition_identity_conflict',
            identifier: slug,
          },
        };
      }
      const primaryRole = advisoryRoles[0]!;
      const validateForegroundPayload = createProofProviderForegroundPayloadValidator({
        operationId: slug,
        schema,
      });
      if (!validateForegroundPayload) continue;
      factory.register({
        capabilityId,
        toolName: slug,
        schemaVersion: manifest.operationVersion,
        schemaDigest: definitionFingerprint,
        effect,
        advisoryRoles,
        manifestDigest: capabilityManifestDigest(manifest),
        providerKind: 'composio',
        providerInputSchemaDigest: schemaDigest,
        ...(sourceSchemaFingerprint ? { sourceSchemaFingerprint } : {}),
        liveFingerprint: definitionFingerprint,
        manifest,
        account: accountId,
        ...(manifest.destination ? { destination: manifest.destination } : {}),
        ...(write
          ? {
              reconcile: async (input) => {
                try {
                  return await requireAttestedTransport().reconcile({
                    artifactId: input.artifactId ?? '',
                    accountId,
                    operationId: slug,
                  });
                } catch {
                  // Read-only probe: an unavailable transport proves nothing —
                  // report not-found so the crossing fails toward admission,
                  // never toward a second invoke.
                  return { exists: false };
                }
              },
            }
          : {}),
        validateForegroundPayload,
        invoke: async ({ payload, role, envelope, nodeId, identity, authority }) => {
          let authorityOwnsPayload = false;
          try {
            authorityOwnsPayload = Boolean(
              authority
              && authority.acceptedSource.sessionId === identity.sessionId
              && authority.acceptedSource.sourceUserSeq === identity.sourceUserSeq
              && authority.acceptedTaskId === identity.acceptedTaskId
              && authority.nodeId === nodeId
              && authority.operationId === manifest.operationId
              && authority.capabilityRef === manifest.manifestId
              && authority.manifestId === manifest.manifestId
              && authority.manifestDigest === capabilityManifestDigest(manifest)
              && authority.accountId === manifest.accountId
              && authority.resolvedEffect === manifest.effect
              && authority.operationVersion === manifest.operationVersion
              && authority.liveFingerprint === manifest.definitionFingerprint
              && authority.invokePortId === manifest.invokePortId
              // Generic proof manifests are minted over this exact payload
              // serialization before the catalog invoke is reachable.
              && authority.canonicalArgs.digest === JSON.stringify(payload ?? null)
            );
          } catch {
            authorityOwnsPayload = false;
          }
          const args = compileProofProviderArgs({
            schema,
            role: role || primaryRole,
            effect,
            payload,
            envelope,
            // The payload crosses only when this accepted source's minted call
            // authority owns the exact node, manifest, account, effect, and
            // serialized payload. None can be nominated by a payload field.
            acceptAuthorityBoundPayload: authorityOwnsPayload,
            authorityBoundPayloadKind: role === 'foreground'
              ? 'provider_arguments'
              : 'semantic',
          });
          if (!args) {
            throw new Error(`proof-provisioned ${slug} could not compile schema-grounded arguments`);
          }
          return executeSealed(slug, args, accountId, {
            manifestId: manifest.manifestId,
            manifestDigest: capabilityManifestDigest(manifest),
            providerKind: manifest.providerKind,
            providerIdentity: manifest.providerIdentity,
            providerVersion: manifest.providerVersion,
            operationVersion: manifest.operationVersion,
            definitionFingerprint: manifest.definitionFingerprint,
            providerInputSchemaDigest:
              manifest.externalDefinition!.providerInputSchemaDigest,
            providerOutputSchemaObserved: true,
            providerOutputSchemaDigest:
              manifest.externalDefinition!.providerOutputSchemaDigest ?? null,
            invokePortId: manifest.invokePortId,
            argumentCompiler: { ...manifest.argumentCompiler },
          });
        },
      });
      registered.push(capabilityId);
    }

    if (registered.length > 0) {
      if (options.publicationGuard && !options.publicationGuard()) return { registered };
      // The collect→construct shortlist needs a host projection between the
      // collection and the create. This is host-owned compute (no provider,
      // no account) — identity projection of the collected records.
      const transformId = 'cap:resolved:host_transform';
      if (!factory.get(transformId)) {
        const transformDigest = sha256('cap:resolved:host_transform:v1');
        const transformManifest = attachSemanticContract({
          version: 1,
          manifestId: transformId,
          providerKind: 'local_registry',
          operationId: 'host_transform',
          providerIdentity: 'local_registry',
          providerVersion: 'tool-registry-v1',
          operationVersion: '1',
          definitionFingerprint: transformDigest,
          effect: 'host_only',
          accountId: 'host:runtime',
          idempotency: { required: false, policy: 'none' },
          reconciliation: { supported: false, policy: 'none' },
          outputContract: { kind: 'records' },
          evidenceContract: { kinds: ['payload'], readbackRequired: false },
          provenance: {
            issuer: 'host:resolution-proof',
            issuedAt: '1970-01-01T00:00:00.000Z',
            trusted: true,
          },
          lifecycle: { state: 'current' },
          advisoryRoles: ['transform', 'extract'],
          acceptedInputKinds: ['evidence', 'records'],
          producedOutputKinds: ['evidence', 'records'],
          applicableDeliverableKinds: ['evidence'],
        });
        store.install(transformManifest);
        const transformObservedAt = Date.now();
        registerIndependentCapabilityObservation({
          operationId: transformManifest.operationId,
          accountId: transformManifest.accountId,
          definitionFingerprint: transformManifest.definitionFingerprint,
          providerVersion: transformManifest.providerVersion,
          operationVersion: transformManifest.operationVersion,
          observedAt: transformObservedAt,
          origin: 'independent',
          observe: () => ({
            operationId: transformManifest.operationId,
            accountId: transformManifest.accountId,
            definitionFingerprint: transformManifest.definitionFingerprint,
            providerVersion: transformManifest.providerVersion,
            operationVersion: transformManifest.operationVersion,
            // This is a deterministic shipped host-local callable, so the
            // observer re-reads the same frozen identity at observation time.
            // Capturing the registration instant here made the otherwise
            // current local transform age out after the 60-second freshness
            // window in long-lived plans.
            observedAt: Date.now(),
          }),
        });
        factory.register({
          capabilityId: transformId,
          toolName: 'host_transform',
          schemaVersion: '1',
          schemaDigest: transformDigest,
          effect: 'host_only',
          advisoryRoles: ['transform', 'extract'],
          manifestDigest: capabilityManifestDigest(transformManifest),
          providerKind: 'local_registry',
          liveFingerprint: transformDigest,
          manifest: transformManifest,
          account: 'host:runtime',
          invoke: async ({ payload }) => {
            if (Array.isArray(payload)) return payload;
            if (isRecord(payload) && Array.isArray(payload.records)) return payload.records;
            return [];
          },
        });
        registered.push(transformId);
      }
      if (!peekHostCapabilityCatalogFactory()) installHostCapabilityCatalogFactory(factory);
      // Readiness gates every typed physical crossing on exact ports for the
      // now-required manifests; the refresh reconstructs them (same seam the
      // beta pack uses at boot). Scoped to exactly what this call registered:
      // an unscoped refresh here treats every OTHER "current" manifest this
      // long-running daemon has ever installed as required too, and forgets
      // (from the live factory) any of them whose independent observation has
      // aged past its freshness window — live 2026-08-26, a fresh, correctly
      // proven and selected write still refused "no longer matches the frozen
      // host catalog" with a completely empty frozen snapshot, because that
      // sweep collaterally wiped unrelated residue from earlier sessions. This
      // capability's own freshness is still fully enforced below; only the
      // OTHERS' staleness stops mattering to a call that never asked about them.
      const directRegistrations = new Map(registered.flatMap((capabilityId) => {
        const entry = factory.get(capabilityId);
        return entry ? [[capabilityId, entry] as const] : [];
      }));
      refreshTypedExecutionReadiness(registered);
      if (options.recoveryExpectedIdentities) {
        for (const expected of options.recoveryExpectedIdentities) {
          if (!registered.includes(expected.capabilityId)) continue;
          const candidates = [
            directRegistrations.get(expected.capabilityId),
            factory.get(expected.capabilityId),
          ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
          const exact = candidates.find((entry) => {
            const identity = canonicalCatalogIdentityOf(entry);
            return Boolean(identity && catalogIdentitiesEqual(identity, expected));
          });
          if (exact) factory.register(exact);
        }
      }
    }
    return { registered };
  } catch (error) {
    // Provisioning is supply, never a gate: any failure keeps the catalog as
    // it was and the turn compiles exactly as before. But it must never be
    // SILENT. This catch swallowed the only evidence of why a proven,
    // disclosed capability failed to register, and admission then refused the
    // turn with "planning catalog no longer matches the frozen host catalog"
    // — a message describing the symptom of a cause nobody could see (live
    // 2026-08-26: 29 identical refusals, five capability_discovered events,
    // an empty snapshot, and no diagnostic anywhere).
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        registered: registered.length,
        requested: options?.allowedIdentifiers?.length ?? 0,
      },
      'proof-provisioned capability registration failed — the frozen catalog will be missing these capabilities',
    );
    return { registered };
  }
}
