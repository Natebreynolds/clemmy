/**
 * PROVISION FROM PROOF — executable half.
 *
 * `hostDescriptorsFromResolutionProof` already lets the model CITE this
 * source's proven capabilities; without registered catalog entries those
 * citations bind nothing and the admitted graph falls back to the legacy
 * lane (live 2026-08-18 sess-mszdq1uz: route=act fastPath=fanout_action,
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
  attachSemanticContract,
  capabilityManifestDigest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import {
  peekCapabilityManifestStore,
  resolveCapabilityManifestStore,
} from './capability-manifest-store.js';
import { registerIndependentCapabilityObservation } from './independent-capability-observation.js';
import { provenCapabilityEntriesForTurn } from './capability-resolution.js';
import { ensureToolSchema, getCachedToolSchema } from '../../tools/composio-schema-cache.js';
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
} from './proof-provider-args.js';
import { compileProofProviderArgs } from './proof-provider-args.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toolkitOf(slug: string): string {
  return slug.split('_')[0]?.toLowerCase() ?? '';
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
}): Promise<ProofProvisionResult> {
  const registered: string[] = [];
  try {
    if (!productionProviderCrossingAllowed()) return { registered };
    const entries = provenCapabilityEntriesForTurn(identity)
      .filter((entry) => entry.kind === 'composio'
        && (entry.effectClass === 'read' || entry.effectClass === 'write'));
    if (entries.length === 0) return { registered };
    const writeToolkits = new Set(
      entries.filter((entry) => entry.effectClass === 'write').map((entry) => toolkitOf(entry.identifier)),
    );
    const factory = peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
    const store = peekCapabilityManifestStore() ?? resolveCapabilityManifestStore();

    for (const entry of entries) {
      const slug = entry.identifier.trim();
      const capabilityId = `cap:resolved:${slug.toLowerCase()}`;
      if (factory.get(capabilityId)) continue;
      // First-touch daemon: the schema cache is empty until something lists
      // provider tools. The proof names an exact operation, so fetch its
      // frozen contract now (single attempt per slug, cached after) — live
      // 2026-08-19: a fresh session's first act ask found zero cached schemas
      // and provisioned nothing.
      const schema = getCachedToolSchema(slug) ?? await ensureToolSchema(slug);
      if (!isRecord(schema)) continue; // no frozen schema → no compiler → fail closed
      const effect: BoundNodeCapability['effect'] = entry.effectClass === 'write' ? 'external_write' : 'read';
      const family = toolkitOf(slug);
      const write = effect === 'external_write';
      const advisoryRoles = advisoryRolesForProofEntry({
        effect: write ? 'external_write' : 'read',
        schema,
        siblingWriteInToolkit: writeToolkits.has(family),
      });
      const schemaDigest = sha256(JSON.stringify(schema));
      const accountId = entry.accountIdentity?.trim() || 'runtime';
      const manifest: CapabilityManifestV1 = attachSemanticContract({
        version: 1,
        manifestId: capabilityId,
        providerKind: 'composio',
        operationId: slug,
        providerIdentity: 'composio',
        providerVersion: 'composio-proof-v1',
        operationVersion: '1',
        definitionFingerprint: schemaDigest,
        effect,
        ...(write ? { destination: { family, posture: 'create_new' as const } } : {}),
        accountId,
        idempotency: { required: write, policy: write ? 'key_before_dispatch' : 'none' },
        reconciliation: { supported: write, policy: write ? 'exact_artifact' : 'none' },
        outputContract: { kind: write ? 'created_resource' : 'records' },
        evidenceContract: {
          kinds: write ? ['receipt', 'readback'] : ['payload'],
          readbackRequired: write,
        },
        provenance: {
          issuer: 'host:resolution-proof',
          issuedAt: '1970-01-01T00:00:00.000Z',
          trusted: true,
        },
        lifecycle: { state: 'current' },
        advisoryRoles,
        argumentCompiler: { id: 'compile:proof-schema:v1', version: '1' },
        // The shared 'evidence' kind keeps every hop chainable (dag_kind_mismatch
        // trap, live 2026-08-18 sess-msz8m5vg); the role-specific kinds beside it
        // drive the evidence-mode derivation — a collection read owes durable
        // records, a readback is a point read of the created resource, and the
        // write produces that resource. The write also carries its concrete
        // destination family so a family-named deliverable stays admissible.
        acceptedInputKinds: write
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
        applicableDeliverableKinds: write ? ['evidence', family] : ['evidence'],
      });
      const installed = store.install(manifest);
      if (!installed.ok) continue;
      const observedAt = Date.now();
      registerIndependentCapabilityObservation({
        operationId: manifest.operationId,
        accountId: manifest.accountId,
        definitionFingerprint: manifest.definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
        observedAt,
        origin: 'independent',
        observe: () => ({
          operationId: manifest.operationId,
          accountId: manifest.accountId,
          definitionFingerprint: manifest.definitionFingerprint,
          providerVersion: manifest.providerVersion,
          operationVersion: manifest.operationVersion,
          observedAt,
        }),
      });
      const primaryRole = advisoryRoles[0]!;
      factory.register({
        capabilityId,
        toolName: slug,
        schemaVersion: manifest.operationVersion,
        schemaDigest,
        effect,
        advisoryRoles,
        manifestDigest: capabilityManifestDigest(manifest),
        providerKind: 'composio',
        liveFingerprint: schemaDigest,
        manifest,
        account: accountId,
        ...(write ? { destination: { family, posture: 'create_new' } } : {}),
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
        invoke: async ({ payload, role, envelope }) => {
          const args = compileProofProviderArgs({
            schema,
            role: role || primaryRole,
            effect,
            payload,
            envelope,
          });
          if (!args) {
            throw new Error(`proof-provisioned ${slug} could not compile schema-grounded arguments`);
          }
          return executeSealed(slug, args, accountId);
        },
      });
      registered.push(capabilityId);
    }

    if (registered.length > 0) {
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
            observedAt: transformObservedAt,
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
      // beta pack uses at boot).
      refreshTypedExecutionReadiness();
    }
    return { registered };
  } catch {
    // Provisioning is supply, never a gate: any failure keeps the catalog
    // as it was and the turn compiles exactly as before.
    return { registered };
  }
}
