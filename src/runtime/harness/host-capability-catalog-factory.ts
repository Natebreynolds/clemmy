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
  return {
    capabilityId: entry.capabilityId,
    manifestId: entry.manifest.manifestId,
    manifestDigest: entry.manifestDigest,
    operationId: entry.manifest.operationId,
    schemaVersion: entry.schemaVersion,
    schemaDigest: entry.schemaDigest,
    providerKind: entry.providerKind ?? entry.manifest.providerKind,
    providerVersion: entry.manifest.providerVersion,
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
  const graphDestination = input.graph.classification?.goalConstraints?.destination;
  const writeNode = effectRank(nodeEffect) >= effectRank('local_write');
  if (writeNode && graphDestination?.binding && !destinationBindingMatches(graphDestination.binding, capability)) {
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

export function freezeCatalogSnapshotForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): FrozenCatalogSnapshotResult {
  const factory = installed;
  if (!factory) return { ok: false, reason: 'missing_factory' };
  const live = factory.snapshot();
  const liveIdentities = live.flatMap((entry) => {
    const identity = canonicalCatalogIdentityOf(entry);
    return identity ? [{ identity, entry }] : [];
  });
  const db = openEventLog();
  const existing = db.prepare(`
    SELECT snapshot_digest, snapshot_json FROM accepted_source_catalog_snapshots
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as {
    snapshot_digest: string;
    snapshot_json: string;
  } | undefined;
  if (!existing) {
    const identities = liveIdentities.map((item) => item.identity);
    const digest = catalogSnapshotDigestOf(identities);
    db.prepare(`
      INSERT INTO accepted_source_catalog_snapshots
        (session_id, source_user_seq, snapshot_digest, snapshot_json)
      VALUES (?, ?, ?, ?)
    `).run(input.sessionId, input.sourceUserSeq, digest, JSON.stringify(identities));
    const entries = liveIdentities.map((item) => copyRegisteredCapability(item.entry));
    const frozen = createHostCapabilityCatalogFactory(entries);
    return { ok: true, digest, catalog: frozen.catalog(), entries };
  }
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
  const reconstructed: RegisteredHostCapability[] = [];
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
    reconstructed.push(copyRegisteredCapability(match.entry));
  }
  const frozen = createHostCapabilityCatalogFactory(reconstructed);
  return { ok: true, digest: existing.snapshot_digest, catalog: frozen.catalog(), entries: reconstructed };
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
    schemaDigest: input.binding.schemaDigest,
    argumentDigest: input.argumentDigest,
    account: input.binding.account,
    effect: input.binding.effect,
    destination: input.binding.destination,
  };
  return { ...sealed, bindingDigest: bindingDigestOf(sealed) };
}
