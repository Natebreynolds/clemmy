/**
 * Shared runtime capability catalog factory.
 *
 * Primary, Claude, resume, fallover, daemon, chat, webhook, Discord, and Slack
 * all resolve through this factory. Semantic roles are advisory ranking only.
 * A missing or incomplete binding cannot authorize dispatch.
 */
import { createHash } from 'node:crypto';
import { openEventLog } from './eventlog.js';
import { canonicalLogicalToolName } from './logical-call-contract.js';
import type { RuntimeToolEffect } from './tool-effect.js';
import type { TurnGraphIR, TurnGraphNode } from '../graph/turn-graph-ir.js';
import type { CapabilityProviderKind } from './capability-manifest.js';
import {
  peekCapabilityManifestStore,
  resolveCurrentSuccessorManifest,
} from './capability-manifest-store.js';
import {
  type BindAdmittedNodeCapabilityInput,
  type BoundNodeCapability,
  type GraphNodeCapabilityReconcile,
  type GraphNodeCapabilityInvoke,
  type HostCapabilityCatalog,
} from './graph-node-capability.js';

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

export interface SealedNodeBinding {
  nodeId: string;
  capabilityId: string;
  /** Exact provider operation identity as observed in the trusted manifest. */
  providerOperationId: string;
  /** Canonical logical-call identity used by admission/settlement ledgers. */
  logicalToolName: string;
  /** @deprecated Raw provider operation identity; retained for row compatibility. */
  toolName: string;
  schemaVersion: string;
  /** Exact provider input-schema digest, distinct from schemaDigest once the
   * latter closes the full input+output+version/account definition. */
  providerInputSchemaDigest?: string;
  schemaDigest: string;
  argumentDigest: string;
  account?: string;
  effect: RegisteredHostCapability['effect'];
  destination?: { family: string; posture: string };
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
  return sha256(JSON.stringify({
    nodeId: binding.nodeId,
    capabilityId: binding.capabilityId,
    providerOperationId: binding.providerOperationId,
    logicalToolName: binding.logicalToolName,
    toolName: binding.toolName,
    schemaVersion: binding.schemaVersion,
    providerInputSchemaDigest: binding.providerInputSchemaDigest ?? null,
    schemaDigest: binding.schemaDigest,
    argumentDigest: binding.argumentDigest,
    account: binding.account ?? null,
    effect: binding.effect,
    destination: binding.destination ?? null,
  }));
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

export function createHostCapabilityCatalogFactory(
  initial: readonly RegisteredHostCapability[] = [],
): HostCapabilityCatalogFactory {
  const byId = new Map<string, RegisteredHostCapability>();
  for (const capability of initial) byId.set(capability.capabilityId, capability);
  const factory: HostCapabilityCatalogFactory = {
    register(capability) {
      if (!complete(capability)) {
        throw new Error(`registered capability ${capability.capabilityId} is incomplete`);
      }
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
  const trusted = registered.filter((entry) => complete(entry) && Boolean(entry.manifestDigest?.trim()));
  if (named.length !== 1) return null;
  const store = peekCapabilityManifestStore();
  const successorId = store
    ? resolveCurrentSuccessorManifest(store, named[0])?.manifest.manifestId
    : undefined;
  const capability = trusted.find((entry) => entry.capabilityId === (successorId ?? named[0]))
    ?? trusted.find((entry) => entry.capabilityId === named[0]);
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

export function installHostCapabilityCatalogFactory(
  factory: HostCapabilityCatalogFactory | null,
): void {
  installed = factory;
}

export function peekHostCapabilityCatalogFactory(): HostCapabilityCatalogFactory | null {
  return installed;
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
  return factory.snapshot().flatMap((entry) => {
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
    if (!match) return { ok: false, reason: 'identity_mismatch' };
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
  };
  return { ...sealed, bindingDigest: bindingDigestOf(sealed) };
}
