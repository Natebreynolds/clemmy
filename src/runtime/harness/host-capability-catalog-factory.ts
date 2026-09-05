/**
 * Shared runtime capability catalog factory.
 *
 * Primary, Claude, resume, fallover, daemon, chat, webhook, Discord, and Slack
 * all resolve through this factory. Semantic roles are advisory ranking only.
 * A missing or incomplete binding cannot authorize dispatch.
 */
import { createHash } from 'node:crypto';
import pino from 'pino';
import { openEventLog } from './eventlog.js';
import { canonicalLogicalToolName } from './logical-call-contract.js';
import {
  catalogOperationIdentitiesEqual,
} from './runtime-tool-identity.js';
import type { RuntimeToolEffect } from './tool-effect.js';
import type { TurnGraphIR, TurnGraphNode } from '../graph/turn-graph-ir.js';
import {
  capabilityManifestDigest,
  parseCapabilityManifestOperationSemantics,
  validateCapabilityManifestV1,
  type CapabilityProviderKind,
} from './capability-manifest.js';
import {
  parseMutationVerificationRecipe,
  type MutationVerificationRecipeV1,
} from './mutation-verification-contract.js';
import {
  parseAsyncReadContinuationRecipe,
  type AsyncReadContinuationRecipeV1,
} from './async-read-continuation-contract.js';
import {
  peekCapabilityManifestStore,
  type CapabilityManifestStore,
  type InstalledCapabilityManifest,
} from './capability-manifest-store.js';
import {
  type BindAdmittedNodeCapabilityInput,
  type BoundNodeCapability,
  type GraphNodeCapabilityReconcile,
  type GraphNodeCapabilityInvoke,
  type HostCapabilityCatalog,
} from './graph-node-capability.js';
import {
  sealedNodeBindingDigestOf,
  type SealedNodeBindingDigestInput,
} from './sealed-node-binding-digest.js';
import { currentAcceptedSourceCatalogManifestScope } from './accepted-source-catalog-scope.js';

export type {
  GraphNodeCapabilityInvoke,
  GraphNodeCapabilityReconcile,
};

export const EFFECT_RANK: Record<string, number> = {
  none: 0,
  read: 1,
  compute: 1,
  host_only: 1,
  unknown: 2,
  local_write: 3,
  external_write: 4,
  admin: 5,
};

export type ForegroundCapabilityPayloadValidation =
  | { ok: true }
  | { ok: false; repair: string; schemaAvailable: boolean; repairKey?: string };

export interface RegisteredHostCapability {
  capabilityId: string;
  toolName: string;
  schemaVersion: string;
  schemaDigest: string;
  effect: RuntimeToolEffect | 'none' | 'compute' | 'host_only';
  destination?: { family: string; posture: string };
  account?: string;
  /** Advisory labels for ranking. They never authorize execution. */
  advisoryRoles?: readonly string[];
  manifestDigest?: string;
  providerKind?: CapabilityProviderKind;
  /** Selector-visible input-schema fingerprint for source matching. This is
   * distinct from `liveFingerprint`, the 64-hex workflow definition authority. */
  sourceSchemaFingerprint?: string;
  /** Full canonical digest of the exact provider input schema. Present only
   * when the catalog entry was materialized under a current provider lease. */
  providerInputSchemaDigest?: string;
  liveFingerprint?: string;
  delegatedFrom?: string;
  manifest?: import('./capability-manifest.js').CapabilityManifestV1;
  idempotency?: {
    supported: true;
    keyFor(input: { nodeId: string; acceptedTaskId: string; payload: unknown }): string;
  };
  reconcile?: GraphNodeCapabilityReconcile;
  /** Optional denial-only validator for a foreground payload explicitly
   * authored as provider arguments. It may refuse before a physical crossing;
   * it cannot rewrite arguments, select a capability, or authorize dispatch.
   * Semantic graph payloads continue through the capability's sealed compiler. */
  validateForegroundPayload?: (payload: unknown) => ForegroundCapabilityPayloadValidation;
  invoke: GraphNodeCapabilityInvoke;
  implementationDigest?: string;
  invokeImplementationDigest?: string;
  reconcileImplementationDigest?: string;
}

export interface CanonicalCatalogIdentityV1 {
  capabilityId: string;
  manifestId: string;
  manifestDigest: string;
  operationId: string;
  schemaVersion: string;
  schemaDigest: string;
  providerKind: string;
  providerVersion: string;
  sourceSchemaFingerprint?: string;
  providerInputSchemaDigest?: string;
  liveFingerprint: string;
  account: string;
  effect: string;
  destination: { family: string; posture: string } | null;
  idempotency: { required: boolean; policy: string } | null;
  reconciliation: { supported: boolean; policy: string } | null;
  invokePortId: string;
  reconcilePortId?: string;
  implementationDigest?: string;
  invokeImplementationDigest?: string;
  reconcileImplementationDigest?: string;
  argumentCompiler: { id: string; version: string };
}

export interface SealedNodeBinding extends SealedNodeBindingDigestInput {
  bindingDigest: string;
}

export interface HostCapabilityCatalogFactory {
  register(capability: RegisteredHostCapability): void;
  forget(capabilityId: string): void;
  clear(): void;
  catalog(): HostCapabilityCatalog;
  snapshot(): readonly RegisteredHostCapability[];
  get(capabilityId: string): RegisteredHostCapability | undefined;
}

let installed: HostCapabilityCatalogFactory | null = null;

interface CallableManifestIdentityAttestationV1 {
  readonly manifestDigest: string;
  readonly providerVersion: string;
  readonly liveFingerprint: string;
  readonly invokePortId: string;
  readonly reconcilePortId: string | null;
  readonly argumentCompiler: { readonly id: string; readonly version: string };
}

/** Registration-time copy of bytes which otherwise live only inside the
 * mutable manifest object. It is deliberately module-private: consumers may
 * verify this attestation, but cannot restamp a stale callable row. */
const callableManifestIdentityAttestations = new WeakMap<
RegisteredHostCapability,
CallableManifestIdentityAttestationV1
>();

function attestCallableManifestIdentity(entry: RegisteredHostCapability): void {
  const manifest = entry.manifest;
  if (!manifest || !validateCapabilityManifestV1(manifest).ok) return;
  callableManifestIdentityAttestations.set(entry, {
    manifestDigest: entry.manifestDigest ?? '',
    providerVersion: manifest.providerVersion,
    liveFingerprint: entry.liveFingerprint ?? '',
    invokePortId: manifest.invokePortId,
    reconcilePortId: manifest.reconcilePortId ?? null,
    argumentCompiler: {
      id: manifest.argumentCompiler.id,
      version: manifest.argumentCompiler.version,
    },
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function effectRank(effect: string | undefined): number {
  if (!effect) return EFFECT_RANK.unknown;
  return EFFECT_RANK[effect] ?? EFFECT_RANK.unknown;
}

export function bindingEffectFitsCeiling(input: {
  bindingEffect: string;
  nodeEffect: string;
  graphCeiling: string;
}): boolean {
  return input.bindingEffect === input.nodeEffect
    && effectRank(input.nodeEffect) <= effectRank(input.graphCeiling);
}

export function canonicalCatalogIdentityOf(
  entry: RegisteredHostCapability,
): CanonicalCatalogIdentityV1 | null {
  if (!complete(entry) || !entry.manifestDigest?.trim() || !entry.manifest) return null;
  const persistedProviderSchemaDigest = entry.manifest.externalDefinition?.providerInputSchemaDigest;
  if (
    entry.providerInputSchemaDigest
    && persistedProviderSchemaDigest
    && entry.providerInputSchemaDigest !== persistedProviderSchemaDigest
  ) return null;
  const providerInputSchemaDigest = entry.providerInputSchemaDigest
    ?? persistedProviderSchemaDigest;
  return {
    capabilityId: entry.capabilityId,
    manifestId: entry.manifest.manifestId,
    manifestDigest: entry.manifestDigest,
    operationId: entry.manifest.operationId,
    schemaVersion: entry.schemaVersion,
    schemaDigest: entry.schemaDigest,
    providerKind: entry.providerKind ?? entry.manifest.providerKind,
    providerVersion: entry.manifest.providerVersion,
    ...(entry.sourceSchemaFingerprint
      ? { sourceSchemaFingerprint: entry.sourceSchemaFingerprint }
      : {}),
    ...(providerInputSchemaDigest
      ? { providerInputSchemaDigest }
      : {}),
    liveFingerprint: entry.liveFingerprint ?? entry.schemaDigest,
    account: entry.account ?? entry.manifest.accountId,
    effect: String(entry.effect),
    destination: entry.destination ?? entry.manifest.destination ?? null,
    idempotency: entry.manifest.idempotency ?? null,
    reconciliation: entry.manifest.reconciliation ?? null,
    invokePortId: entry.manifest.invokePortId,
    ...(entry.manifest.reconcilePortId ? { reconcilePortId: entry.manifest.reconcilePortId } : {}),
    ...(entry.implementationDigest ? { implementationDigest: entry.implementationDigest } : {}),
    ...(entry.invokeImplementationDigest ? { invokeImplementationDigest: entry.invokeImplementationDigest } : {}),
    ...(entry.reconcileImplementationDigest ? { reconcileImplementationDigest: entry.reconcileImplementationDigest } : {}),
    argumentCompiler: {
      id: entry.manifest.argumentCompiler.id,
      version: entry.manifest.argumentCompiler.version,
    },
  };
}

export function catalogSnapshotDigestOf(
  identities: readonly CanonicalCatalogIdentityV1[],
): string {
  return sha256(JSON.stringify(
    [...identities].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
  ));
}

function copyRegisteredCapability(entry: RegisteredHostCapability): RegisteredHostCapability {
  return {
    ...entry,
    invoke: entry.invoke,
    ...(entry.reconcile ? { reconcile: entry.reconcile } : {}),
  };
}

export function catalogIdentitiesEqual(
  left: CanonicalCatalogIdentityV1,
  right: CanonicalCatalogIdentityV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function bindingDigestOf(binding: Omit<SealedNodeBinding, 'bindingDigest'>): string {
  return sealedNodeBindingDigestOf(binding);
}

export function destinationBindingMatches(
  binding: {
    manifestId: string;
    manifestDigest: string;
    accountId: string;
    operationId: string;
    schemaVersion: string;
    definitionFingerprint: string;
    effect: string;
    posture: string;
  },
  capability: RegisteredHostCapability,
): boolean {
  return binding.manifestId === (capability.manifest?.manifestId ?? capability.capabilityId)
    && binding.manifestDigest === (capability.manifestDigest ?? '')
    && binding.accountId === (capability.account ?? capability.manifest?.accountId ?? '')
    && binding.operationId === (capability.manifest?.operationId ?? capability.toolName)
    && binding.schemaVersion === capability.schemaVersion
    && binding.definitionFingerprint === capability.schemaDigest
    && binding.effect === String(capability.effect)
    && binding.posture === (capability.destination?.posture ?? '');
}

function complete(capability: RegisteredHostCapability): boolean {
  return Boolean(
    capability.capabilityId.trim()
    && capability.toolName.trim()
    && capability.schemaVersion.trim()
    && capability.schemaDigest.trim()
    && capability.effect,
  );
}

/** Exact positive attestation for a callable snapshot row. Consumers that use
 * manifest facts to lower risk must not accept a merely well-shaped/stale row. */
export function isCurrentCallableCatalogEntry(
  entry: RegisteredHostCapability,
): entry is RegisteredHostCapability & {
  manifest: import('./capability-manifest.js').CapabilityManifestV1;
  manifestDigest: string;
} {
  const manifest = entry.manifest;
  if (!manifest || !validateCapabilityManifestV1(manifest).ok) return false;
  const attested = callableManifestIdentityAttestations.get(entry);
  if (!attested) return false;
  return complete(entry)
    && typeof entry.invoke === 'function'
    && entry.capabilityId === manifest.manifestId
    && entry.toolName === manifest.operationId
    && entry.schemaVersion === manifest.operationVersion
    && entry.schemaDigest === manifest.definitionFingerprint
    && entry.effect === manifest.effect
    && entry.providerKind === manifest.providerKind
    && (entry.account ?? '') === manifest.accountId
    && JSON.stringify(entry.destination ?? null) === JSON.stringify(manifest.destination ?? null)
    && entry.manifestDigest === capabilityManifestDigest(manifest)
    && attested.manifestDigest === entry.manifestDigest
    && attested.providerVersion === manifest.providerVersion
    && attested.liveFingerprint === manifest.definitionFingerprint
    && entry.liveFingerprint === attested.liveFingerprint
    && attested.invokePortId === manifest.invokePortId
    && attested.reconcilePortId === (manifest.reconcilePortId ?? null)
    && attested.argumentCompiler.id === manifest.argumentCompiler.id
    && attested.argumentCompiler.version === manifest.argumentCompiler.version;
}

export function createHostCapabilityCatalogFactory(
  initial: readonly RegisteredHostCapability[] = [],
): HostCapabilityCatalogFactory {
  const byId = new Map<string, RegisteredHostCapability>();
  for (const capability of initial) {
    attestCallableManifestIdentity(capability);
    byId.set(capability.capabilityId, capability);
  }
  const factory: HostCapabilityCatalogFactory = {
    register(capability) {
      if (!complete(capability)) {
        throw new Error(`registered capability ${capability.capabilityId} is incomplete`);
      }
      attestCallableManifestIdentity(capability);
      byId.set(capability.capabilityId, capability);
    },
    forget(capabilityId) { byId.delete(capabilityId); },
    clear() { byId.clear(); },
    snapshot() { return [...byId.values()]; },
    get(capabilityId) { return byId.get(capabilityId); },
    catalog() {
      return {
        bind(input: BindAdmittedNodeCapabilityInput): BoundNodeCapability | null {
          return bindFromRegistry(input, [...byId.values()]);
        },
      };
    },
  };
  return factory;
}

function bindFromRegistry(
  input: BindAdmittedNodeCapabilityInput,
  registered: readonly RegisteredHostCapability[],
): BoundNodeCapability | null {
  const named = (input.node as TurnGraphNode).capabilities
    ?.flatMap((requirement) => requirement.names ?? [])
    ?? [];
  const trusted = registered.filter(isCurrentCallableCatalogEntry);
  if (named.length !== 1) return null;
  const store = peekCapabilityManifestStore();
  const durable = store ? resolveExplicitCurrentManifest(store, named[0]!) : null;
  // Once a durable owner exists, its explicit successor chain is exclusive.
  // A copied predecessor row must never become a fallback when the successor
  // is missing, revoked, corrupt, or simply not callable in this catalog.
  if (store && !durable) return null;
  const capability = trusted.find((entry) => (
    entry.capabilityId === (durable?.manifest.manifestId ?? named[0])
    && (!durable || entry.manifestDigest === durable.digest)
  ));
  if (!capability) return null;
  const nodeEffect = 'effect' in input.node && input.node.effect && typeof input.node.effect === 'object'
    ? String((input.node.effect as { kind?: string }).kind ?? 'unknown')
    : 'unknown';
  const ceiling = input.graph.effectCeiling ?? 'unknown';
  if (!bindingEffectFitsCeiling({
    bindingEffect: capability.effect,
    nodeEffect,
    graphCeiling: String(ceiling),
  })) {
    return null;
  }
  // A turn may admit more than one write, and each planned write carries its
  // OWN exact binding. Reading only the singular destination refused every
  // planned write except the first — including the write into the destination
  // this same turn had just created (live 2026-08-26: the sheet was created,
  // then its header row was refused before dispatch). Matching against the full
  // bound set is still an exact identity match per capability, so this admits
  // nothing the plan did not already bind.
  const goalConstraints = input.graph.classification?.goalConstraints;
  const graphDestinations = goalConstraints?.destinations?.length
    ? goalConstraints.destinations
    : (goalConstraints?.destination ? [goalConstraints.destination] : []);
  const boundDestinations = graphDestinations.filter((entry) => Boolean(entry?.binding));
  const writeNode = effectRank(nodeEffect) >= effectRank('local_write');
  if (
    writeNode
    && boundDestinations.length > 0
    && !boundDestinations.some((entry) => destinationBindingMatches(entry.binding!, capability))
  ) {
    return null;
  }
  return {
    capabilityId: capability.capabilityId,
    toolName: capability.toolName,
    schemaVersion: capability.schemaVersion,
    schemaDigest: capability.schemaDigest,
    args: { capabilityId: capability.capabilityId },
    account: capability.account,
    effect: capability.effect,
    destination: capability.destination,
    manifestDigest: capability.manifestDigest,
    providerKind: capability.providerKind,
    liveFingerprint: capability.liveFingerprint ?? capability.schemaDigest,
    delegatedFrom: capability.delegatedFrom,
    manifest: capability.manifest,
    reconcile: capability.reconcile,
    invoke: capability.invoke,
  };
}

function resolveExplicitCurrentManifest(
  store: CapabilityManifestStore,
  manifestId: string,
): InstalledCapabilityManifest | null {
  const seen = new Set<string>();
  let cursor = manifestId;
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const installed = store.get(cursor);
    if (!installed) return null;
    const lifecycle = installed.manifest.lifecycle;
    if (lifecycle.state === 'current') return installed;
    if (lifecycle.state !== 'superseded' || !lifecycle.supersededBy) return null;
    cursor = lifecycle.supersededBy;
  }
  return null;
}

export function installHostCapabilityCatalogFactory(
  factory: HostCapabilityCatalogFactory | null,
): void {
  installed = factory;
}

export function peekHostCapabilityCatalogFactory(): HostCapabilityCatalogFactory | null {
  return installed;
}

/**
 * The one canonical host id for a proof-resolved provider operation.
 *
 * When a capability's live definition drifts from its installed manifest it is
 * re-registered under a SUCCESSOR id (`<base>:definition:<24 hex>`) and the
 * base id is explicitly forgotten (see registerProofProvisionedCapabilities).
 * The disclosure path minted the base name lexically from the slug, so the
 * host handed the model a name its own catalog no longer held. Plan admission
 * compares ids by exact string, missed, and refused "…is absent from the
 * current host catalog" — then the retry re-ran discovery, re-minted the same
 * absent base name, and refused identically. Live 2026-08-28: 22 such refusals
 * in three minutes across both calendar reads, a deterministic loop whose only
 * exit was killing the turn.
 *
 * Both the disclosure mint and the rehydration check call THIS function, so
 * the boundary invariant is unchanged in kind: a descriptor id must still be
 * exactly what its provider + operation + account tuple resolves to. What
 * changed is that "resolves to" now consults both callable and durable current
 * lineages instead of assuming the base spelling.
 *
 * Resolution is scoped to this exact base id, and to the account when one is
 * known — never a global prefix scan, which would let an unrelated operation's
 * successor answer for this one. An account-scoped ambiguity returns a
 * deterministic non-callable token so even a still-live legacy base cannot be
 * selected by insertion order.
 */
export function canonicalResolvedCapabilityId(
  identifier: string,
  accountIdentity?: string | null,
  providerKind?: string | null,
): string {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  const base = `cap:resolved:${normalizedIdentifier}`;
  const factory = peekHostCapabilityCatalogFactory();
  const prefix = `${base}:definition:`;
  const normalizedProvider = providerKind?.trim().toLowerCase() || null;
  const normalizedAccount = accountIdentity?.trim() || null;
  const rows = new Map<string, {
    capabilityId: string;
    account: string;
    providerKind: string;
  }>();
  const manifestStore = peekCapabilityManifestStore();
  for (const entry of factory?.snapshot() ?? []) {
    if (entry.capabilityId !== base && !entry.capabilityId.startsWith(prefix)) continue;
    const durable = manifestStore?.get(entry.capabilityId);
    if (durable && durable.manifest.lifecycle.state !== 'current') continue;
    rows.set(entry.capabilityId, {
      capabilityId: entry.capabilityId,
      account: entry.account ?? entry.manifest?.accountId ?? '',
      providerKind: String(entry.providerKind ?? entry.manifest?.providerKind ?? '').toLowerCase(),
    });
  }
  // A durable current manifest may be awaiting callable re-publication after
  // restart. It still occupies this identity family: treating the family as
  // empty would let another account/provider claim its legacy base id, and
  // the subsequent install would fail with identity_mismatch.
  for (const installed of manifestStore?.list() ?? []) {
    const manifest = installed.manifest;
    const verified = manifestStore?.get(manifest.manifestId);
    if (!verified || verified.digest !== installed.digest) continue;
    if (manifest.lifecycle.state !== 'current') continue;
    if (manifest.manifestId !== base && !manifest.manifestId.startsWith(prefix)) continue;
    rows.set(manifest.manifestId, {
      capabilityId: manifest.manifestId,
      account: manifest.accountId,
      providerKind: String(manifest.providerKind).toLowerCase(),
    });
  }
  const family = [...rows.values()];
  if (family.length === 0) return base;
  const providerScoped = normalizedProvider
    ? family.filter((entry) => entry.providerKind === normalizedProvider)
    : family;
  if (normalizedAccount) {
    const exact = providerScoped.filter((entry) => entry.account === normalizedAccount);
    if (exact.length === 1) return exact[0]!.capabilityId;
    if (exact.length > 1) {
      // This token is deliberately not a catalog identity. A duplicate
      // current lineage is corruption/unfinished coordination, never license
      // to pick whichever row happens to sort first.
      return `${base}:definition:ambiguous-${sha256(JSON.stringify({
        provider: normalizedProvider ?? '*',
        account: normalizedAccount,
      })).slice(0, 24)}`;
    }
    return accountPartitionedResolvedCapabilityId(
      normalizedIdentifier,
      normalizedAccount,
      normalizedProvider ?? 'runtime',
    );
  }
  return providerScoped.length === 1 ? providerScoped[0]!.capabilityId : base;
}

/**
 * Deterministic staging/current identity for an additional connected account.
 *
 * The first provider/operation/account tuple retains the historical base id.
 * Once that family is occupied, a different account (or provider using the
 * same operation spelling) receives this parallel id. The account value is
 * hashed rather than exposed, while provider + operation + account remain the
 * complete partition key.
 */
export function accountPartitionedResolvedCapabilityId(
  identifier: string,
  accountIdentity: string,
  providerKind: string,
): string {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  const base = `cap:resolved:${normalizedIdentifier}`;
  const discriminator = sha256(JSON.stringify({
    version: 1,
    provider: providerKind.trim().toLowerCase() || 'runtime',
    operation: normalizedIdentifier,
    account: accountIdentity.trim() || 'runtime',
  })).slice(0, 24);
  return `${base}:definition:account-${discriminator}`;
}

/**
 * Current callable capability resolution, shared by reads and mutations.
 *
 * A proven read binds on three facts and nothing else: the sealed manifest
 * says read, the row is a current callable catalog entry for that operation,
 * and — when the proof names an account — it is that account. Only a REVOKED
 * manifest (a disconnect) still refuses.
 *
 * Everything this function used to check beyond that was the WRITE bar
 * (durable-store digest identity, lineage occupancy, successor arithmetic)
 * applied to reads, and each of those checks killed a live read this
 * fortnight: 2026-08-29 GOOGLESHEETS_BATCH_GET (two current spellings),
 * workflow:1788024507349 (two transports of one read), 2026-09-01
 * SLACK_FETCH_CONVERSATION_HISTORY (store digest drift). A read has no
 * idempotency key, no reconciliation, no exact artifact: there is nothing
 * for that identity arithmetic to protect. Owner, 2026-09-01: "simplify read
 * vs write once and for all".
 *
 * Two current rows for one operation in one account are two transports of
 * one read: the proven capability id wins, else the first by id. Several
 * accounts with no proof of which one is the only ambiguity left, and that
 * is an input question, not a catalog one. Mutations require the caller's
 * exact effect and retain the same sealed manifest/account/port identity.
 * Resolution is not write authority: consent and physical settlement remain
 * at the existing dispatch boundary.
 */
export function resolveProvenLiveCatalogEntry(input: {
  capabilityId: string;
  effectiveName: string;
  accountIdentity?: string | null;
  effect?: RegisteredHostCapability['effect'];
}): RegisteredHostCapability | null {
  const factory = peekHostCapabilityCatalogFactory();
  if (!factory || !input.effectiveName.trim()) return null;
  const store = peekCapabilityManifestStore();
  const account = input.accountIdentity?.trim() || null;
  const effect = input.effect ?? 'read';
  const matches = factory.snapshot()
    .filter((entry): entry is RegisteredHostCapability & {
      manifest: import('./capability-manifest.js').CapabilityManifestV1;
      manifestDigest: string;
    } => (
      isCurrentCallableCatalogEntry(entry)
      && entry.effect === effect
      && entry.manifest.effect === effect
      && store?.get(entry.capabilityId)?.manifest.lifecycle.state !== 'revoked'
      && (
        catalogOperationIdentitiesEqual(entry.manifest.operationId, input.effectiveName)
        || catalogOperationIdentitiesEqual(entry.toolName, input.effectiveName)
      )
      && (!account || entry.account === account)
    ))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  if (matches.length === 0) return null;
  const proven = matches.find((entry) => entry.capabilityId === input.capabilityId);
  if (proven) return proven;
  if (account) return matches[0]!;
  const accounts = new Set(matches.map((entry) => entry.account ?? ''));
  return accounts.size === 1 ? matches[0]! : null;
}

export function resolveRuntimeCapabilityCatalog(
  explicit?: HostCapabilityCatalog,
): HostCapabilityCatalog | undefined {
  return explicit ?? installed?.catalog();
}

export type FrozenCatalogSnapshotResult =
  | {
      ok: true;
      digest: string;
      catalog: HostCapabilityCatalog;
      entries: readonly RegisteredHostCapability[];
    }
  | { ok: false; reason: 'missing_factory' | 'corrupt_snapshot' | 'identity_mismatch' };

interface LiveCatalogIdentity {
  identity: CanonicalCatalogIdentityV1;
  entry: RegisteredHostCapability;
}

function liveCatalogIdentities(factory: HostCapabilityCatalogFactory): LiveCatalogIdentity[] {
  const scope = currentAcceptedSourceCatalogManifestScope();
  return factory.snapshot().flatMap((entry) => {
    const externallyScoped = (entry.providerKind ?? entry.manifest?.providerKind) === 'composio';
    if (
      scope
      && externallyScoped
      && !scope.manifestIds.has(entry.manifest?.manifestId ?? entry.capabilityId)
      && !scope.operationIds.has((entry.manifest?.operationId ?? entry.toolName).toUpperCase())
    ) return [];
    const identity = canonicalCatalogIdentityOf(entry);
    return identity ? [{ identity, entry }] : [];
  });
}

function frozenResultFrom(
  digest: string,
  items: readonly LiveCatalogIdentity[],
): Extract<FrozenCatalogSnapshotResult, { ok: true }> {
  const entries = items.map((item) => copyRegisteredCapability(item.entry));
  const frozen = createHostCapabilityCatalogFactory(entries);
  return { ok: true, digest, catalog: frozen.catalog(), entries };
}

const logger = pino({ name: 'clementine-next.host-capability-catalog-factory' });
const IDENTITY_MISMATCH_LOG_CAP = 256;
const loggedIdentityMismatches = new Set<string>();

/**
 * Diagnostic only — never changes the refusal. Equality stays byte-exact; this
 * names WHICH identity component drifted for one persisted capabilityId so a
 * registration-path drift (a row rebuilt in a different shape) is legible
 * instead of an opaque `identity_mismatch`. Deduplicated per
 * (capabilityId, persisted bytes, live bytes) and capped, because peek runs
 * from pre-model preparation on every turn.
 */
function logCatalogSnapshotIdentityMismatch(
  persisted: CanonicalCatalogIdentityV1,
  liveIdentities: readonly LiveCatalogIdentity[],
): void {
  try {
    const live = liveIdentities.find((item) => item.identity.capabilityId === persisted.capabilityId);
    const persistedDigest = sha256(JSON.stringify(persisted));
    const liveDigest = live ? sha256(JSON.stringify(live.identity)) : null;
    const key = `${persisted.capabilityId}|${persistedDigest}|${liveDigest ?? (liveIdentities.length === 0 ? 'empty' : 'missing')}`;
    if (loggedIdentityMismatches.has(key)) return;
    if (loggedIdentityMismatches.size >= IDENTITY_MISMATCH_LOG_CAP) loggedIdentityMismatches.clear();
    loggedIdentityMismatches.add(key);
    const persistedRecord = persisted as unknown as Record<string, unknown>;
    const liveRecord = live ? (live.identity as unknown as Record<string, unknown>) : null;
    const changedKeys = liveRecord
      ? [...new Set([...Object.keys(persistedRecord), ...Object.keys(liveRecord)])]
        .filter((k) => JSON.stringify(persistedRecord[k]) !== JSON.stringify(liveRecord[k]))
      : null;
    logger.warn({
      capabilityId: persisted.capabilityId,
      liveMissing: !live,
      liveCount: liveIdentities.length,
      persistedKeys: Object.keys(persistedRecord),
      liveKeys: liveRecord ? Object.keys(liveRecord) : null,
      changedKeys,
      persistedDigest,
      liveDigest,
    }, 'catalog_snapshot_identity_mismatch');
  } catch {
    // A diagnostic must never turn a refusal into a throw.
  }
}

/** Reconstruct one persisted snapshot row against the live factory, or say
 * exactly why it cannot be trusted. Shared by replay, peek, and the
 * plan-admission absorb below so every reader applies identical checks. */
function reconstructPersistedSnapshot(
  existing: { snapshot_digest: string; snapshot_json: string },
  liveIdentities: readonly LiveCatalogIdentity[],
):
  | { ok: true; persisted: CanonicalCatalogIdentityV1[]; items: LiveCatalogIdentity[] }
  | { ok: false; reason: 'corrupt_snapshot' | 'identity_mismatch' } {
  let persisted: CanonicalCatalogIdentityV1[];
  try {
    persisted = JSON.parse(existing.snapshot_json) as CanonicalCatalogIdentityV1[];
  } catch {
    return { ok: false, reason: 'corrupt_snapshot' };
  }
  if (!Array.isArray(persisted)) return { ok: false, reason: 'corrupt_snapshot' };
  if (catalogSnapshotDigestOf(persisted) !== existing.snapshot_digest) {
    return { ok: false, reason: 'corrupt_snapshot' };
  }
  const items: LiveCatalogIdentity[] = [];
  for (const identity of persisted) {
    const match = liveIdentities.find((item) => catalogIdentitiesEqual(item.identity, identity));
    if (!match) {
      logCatalogSnapshotIdentityMismatch(identity, liveIdentities);
      return { ok: false, reason: 'identity_mismatch' };
    }
    if (
      identity.invokePortId
      && match.entry.manifest?.invokePortId
      && identity.invokePortId !== match.entry.manifest.invokePortId
    ) {
      return { ok: false, reason: 'identity_mismatch' };
    }
    items.push({ identity, entry: match.entry });
  }
  return { ok: true, persisted, items };
}

function readPersistedSnapshotRow(input: {
  sessionId: string;
  sourceUserSeq: number;
}): { snapshot_digest: string; snapshot_json: string } | undefined {
  return openEventLog().prepare(`
    SELECT snapshot_digest, snapshot_json FROM accepted_source_catalog_snapshots
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as {
    snapshot_digest: string;
    snapshot_json: string;
  } | undefined;
}

export type PersistedCatalogSnapshotManifestIdsResult =
  | {
      ok: true;
      manifestIds: readonly string[];
      identities: readonly CanonicalCatalogIdentityV1[];
    }
  | { ok: false; reason: 'missing_snapshot' | 'corrupt_snapshot' };

/**
 * Return only the manifest ids already frozen for an accepted source. This is
 * restart materialization input, not catalog authority: the caller must
 * independently reconstruct current definitions/ports and then re-run the
 * ordinary byte-exact snapshot comparison before using any entry.
 */
export function persistedCatalogSnapshotManifestIdsForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): PersistedCatalogSnapshotManifestIdsResult {
  const row = readPersistedSnapshotRow(input);
  if (!row) return { ok: false, reason: 'missing_snapshot' };
  let identities: unknown;
  try {
    identities = JSON.parse(row.snapshot_json) as unknown;
  } catch {
    return { ok: false, reason: 'corrupt_snapshot' };
  }
  if (
    !Array.isArray(identities)
    || catalogSnapshotDigestOf(identities as CanonicalCatalogIdentityV1[])
      !== row.snapshot_digest
  ) return { ok: false, reason: 'corrupt_snapshot' };
  const manifestIds: string[] = [];
  const capabilityIds = new Set<string>();
  for (const value of identities) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'corrupt_snapshot' };
    }
    const identity = value as Record<string, unknown>;
    if (
      typeof identity.capabilityId !== 'string'
      || !identity.capabilityId.trim()
      || capabilityIds.has(identity.capabilityId)
      || typeof identity.manifestId !== 'string'
      || !identity.manifestId.trim()
    ) return { ok: false, reason: 'corrupt_snapshot' };
    capabilityIds.add(identity.capabilityId);
    manifestIds.push(identity.manifestId);
  }
  return {
    ok: true,
    manifestIds: [...new Set(manifestIds)].sort(),
    identities: identities as CanonicalCatalogIdentityV1[],
  };
}

export function freezeCatalogSnapshotForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): FrozenCatalogSnapshotResult {
  const factory = installed;
  if (!factory) return { ok: false, reason: 'missing_factory' };
  const liveIdentities = liveCatalogIdentities(factory);
  const db = openEventLog();
  const existing = readPersistedSnapshotRow(input);
  if (!existing) {
    const identities = liveIdentities.map((item) => item.identity);
    const digest = catalogSnapshotDigestOf(identities);
    db.prepare(`
      INSERT INTO accepted_source_catalog_snapshots
        (session_id, source_user_seq, snapshot_digest, snapshot_json)
      VALUES (?, ?, ?, ?)
    `).run(input.sessionId, input.sourceUserSeq, digest, JSON.stringify(identities));
    return frozenResultFrom(digest, liveIdentities);
  }
  const reconstructed = reconstructPersistedSnapshot(existing, liveIdentities);
  if (!reconstructed.ok) return reconstructed;
  return frozenResultFrom(existing.snapshot_digest, reconstructed.items);
}

/**
 * Read the accepted-source catalog view WITHOUT persisting it.
 *
 * Pre-model preparation (interpretation, deterministic compile, planning-card
 * enumeration) runs before foreground tool_search can disclose anything, so a
 * persist here durably froze an EMPTY snapshot and every later plan admission
 * was refused against it (2026-08-26 gauntlet: 31 frozen-mismatch refusals,
 * snapshot_json '[]' for every act turn). Preparation peeks; only plan
 * admission and execution owners persist, via the functions below.
 */
export function peekCatalogSnapshotForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): FrozenCatalogSnapshotResult {
  const factory = installed;
  if (!factory) return { ok: false, reason: 'missing_factory' };
  const liveIdentities = liveCatalogIdentities(factory);
  const existing = readPersistedSnapshotRow(input);
  if (!existing) {
    const digest = catalogSnapshotDigestOf(liveIdentities.map((item) => item.identity));
    return frozenResultFrom(digest, liveIdentities);
  }
  const reconstructed = reconstructPersistedSnapshot(existing, liveIdentities);
  if (!reconstructed.ok) return reconstructed;
  return frozenResultFrom(existing.snapshot_digest, reconstructed.items);
}

/**
 * The one seam where the frozen snapshot may GROW: plan admission, after this
 * turn's tool_search disclosures were re-proven and registered into the live
 * factory. The snapshot exists to pin what admission validated — so it is
 * taken (or extended monotonically, append-only by capabilityId) exactly
 * here. Everything already persisted must still match live identity; nothing
 * is ever removed or replaced. Callers must not use this once graph authority
 * exists for the source — after that the ordinary write-once replay applies.
 */
export function freezeCatalogSnapshotForPlanAdmission(input: {
  sessionId: string;
  sourceUserSeq: number;
}): FrozenCatalogSnapshotResult {
  const factory = installed;
  if (!factory) return { ok: false, reason: 'missing_factory' };
  const liveIdentities = liveCatalogIdentities(factory);
  const db = openEventLog();
  const existing = readPersistedSnapshotRow(input);
  if (!existing) return freezeCatalogSnapshotForSource(input);
  const reconstructed = reconstructPersistedSnapshot(existing, liveIdentities);
  if (!reconstructed.ok) return reconstructed;
  const persistedIds = new Set(reconstructed.persisted.map((identity) => identity.capabilityId));
  const absorbed = liveIdentities.filter((item) => !persistedIds.has(item.identity.capabilityId));
  if (absorbed.length === 0) {
    return frozenResultFrom(existing.snapshot_digest, reconstructed.items);
  }
  const union = [...reconstructed.items, ...absorbed];
  const identities = union.map((item) => item.identity);
  const digest = catalogSnapshotDigestOf(identities);
  db.prepare(`
    UPDATE accepted_source_catalog_snapshots
       SET snapshot_digest = ?, snapshot_json = ?
     WHERE session_id = ? AND source_user_seq = ?
  `).run(digest, JSON.stringify(identities), input.sessionId, input.sourceUserSeq);
  return frozenResultFrom(digest, union);
}

export function persistSealedNodeBinding(input: {
  sessionId: string;
  sourceUserSeq: number;
  binding: SealedNodeBinding;
}): boolean {
  const db = openEventLog();
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO graph_node_bindings
      (session_id, source_user_seq, node_id, binding_json, binding_digest)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.sourceUserSeq,
    input.binding.nodeId,
    JSON.stringify(input.binding),
    input.binding.bindingDigest,
  );
  if (inserted.changes === 1) return true;
  const existing = loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, input.binding.nodeId);
  return existing?.bindingDigest === input.binding.bindingDigest;
}

export function loadSealedNodeBinding(
  sessionId: string,
  sourceUserSeq: number,
  nodeId: string,
): SealedNodeBinding | null {
  try {
    const row = openEventLog().prepare(
      `SELECT binding_json, binding_digest FROM graph_node_bindings
        WHERE session_id = ? AND source_user_seq = ? AND node_id = ?`,
    ).get(sessionId, sourceUserSeq, nodeId) as { binding_json: string; binding_digest: string } | undefined;
    if (!row) return null;
    const binding = JSON.parse(row.binding_json) as SealedNodeBinding;
    if (
      !binding.providerOperationId?.trim()
      || !binding.logicalToolName?.trim()
      || binding.providerOperationId !== binding.toolName
      || canonicalLogicalToolName(binding.providerOperationId) !== binding.logicalToolName
    ) return null;
    if (binding.bindingDigest !== row.binding_digest) return null;
    if (binding.verification !== undefined && !parseMutationVerificationRecipe(binding.verification)) return null;
    const asyncRead = binding.asyncRead === undefined
      ? null
      : parseAsyncReadContinuationRecipe(binding.asyncRead);
    if (binding.asyncRead !== undefined && !asyncRead) return null;
    if (
      asyncRead
      && (
        binding.verification !== undefined
        ||
        binding.providerOperationId !== asyncRead.owner.operationId
        || binding.schemaVersion !== asyncRead.owner.schemaVersion
        || binding.providerInputSchemaDigest !== asyncRead.owner.providerInputSchemaDigest
        || binding.account !== asyncRead.owner.account
        || binding.effect !== 'read'
        || (() => {
          const {
            bindingDigest: _bindingDigest,
            asyncRead: _asyncRead,
            ...baseBinding
          } = binding;
          return bindingDigestOf(baseBinding) !== asyncRead.ownerBindingDigest;
        })()
      )
    ) return null;
    if (
      binding.operationSemantics !== undefined
      && !parseCapabilityManifestOperationSemantics(binding.operationSemantics)
    ) return null;
    if (bindingDigestOf(binding) !== binding.bindingDigest) return null;
    return binding;
  } catch {
    return null;
  }
}

export function sealBoundCapability(input: {
  nodeId: string;
  binding: BoundNodeCapability;
  argumentDigest: string;
  /** Receives the base binding digest so the recipe can bind its owner without
   * creating a digest cycle. The final binding digest covers the recipe. */
  verification?: (baseBindingDigest: string) => MutationVerificationRecipeV1 | null;
  asyncRead?: (baseBindingDigest: string) => AsyncReadContinuationRecipeV1 | null;
}): SealedNodeBinding {
  const providerOperationId = input.binding.manifest?.operationId ?? input.binding.toolName;
  const logicalToolName = canonicalLogicalToolName(providerOperationId);
  if (!logicalToolName) {
    throw new Error(`capability ${input.binding.capabilityId} has no canonical logical identity`);
  }
  const sealed: Omit<SealedNodeBinding, 'bindingDigest'> = {
    nodeId: input.nodeId,
    capabilityId: input.binding.capabilityId,
    providerOperationId,
    logicalToolName,
    toolName: providerOperationId,
    schemaVersion: input.binding.schemaVersion,
    ...(input.binding.manifest?.externalDefinition?.providerInputSchemaDigest
      ? {
          providerInputSchemaDigest:
            input.binding.manifest.externalDefinition.providerInputSchemaDigest,
        }
      : {}),
    schemaDigest: input.binding.schemaDigest,
    argumentDigest: input.argumentDigest,
    account: input.binding.account,
    effect: input.binding.effect,
    destination: input.binding.destination,
    ...(input.binding.manifest?.operationSemantics
      ? { operationSemantics: input.binding.manifest.operationSemantics }
      : {}),
  };
  const baseBindingDigest = bindingDigestOf(sealed);
  const verification = input.verification?.(baseBindingDigest) ?? null;
  const asyncRead = input.asyncRead?.(baseBindingDigest) ?? null;
  if (!verification && !asyncRead) return { ...sealed, bindingDigest: baseBindingDigest };
  const withRecipes = {
    ...sealed,
    ...(verification ? { verification } : {}),
    ...(asyncRead ? { asyncRead } : {}),
  };
  return { ...withRecipes, bindingDigest: bindingDigestOf(withRecipes) };
}
