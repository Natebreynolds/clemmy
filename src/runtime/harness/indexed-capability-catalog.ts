/**
 * Turn-time retrieval over the connect-time capability index.
 *
 * The index is provisioning-derived retrieval. A hit is not authority,
 * availability, a trusted manifest, a current observation, or a bindable
 * catalog entry. Dispatch still requires an adapter-attested contract,
 * a fresh observation, and live revalidation.
 */
import { createHash } from 'node:crypto';
import pino from 'pino';
import {
  searchCapabilityOperations,
  type CapabilityOperationHit,
} from '../../memory/capability-index.js';
import type { HostCapabilityDescriptorV1 } from '../semantic-boundary/turn-semantic-proposal.js';
import {
  peekCatalogSnapshotForSource,
  peekHostCapabilityCatalogFactory,
  canonicalCatalogIdentityOf,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import {
  provenCapabilityEntriesForTurn,
  resolveTurnCapabilities,
  type CapabilityResolutionEntry,
} from './capability-resolution.js';
import {
  peekCapabilityManifestStore,
  type CapabilityManifestStore,
  type InstalledCapabilityManifest,
} from './capability-manifest-store.js';
import {
  observationMatchesManifest,
  peekProductionCapabilityAdapter,
} from './production-capability-adapter.js';
import {
  independentlyObserveCapability,
  observationIsFresh,
} from './independent-capability-observation.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import { canonicalVerifiedReadReceipt } from '../read-path/verified-read-origin-authority.js';
import {
  peekConnectedToolkits,
  selectToolkitConnection,
} from '../../integrations/composio/client.js';
import {
  resolveCanonicalVerifiedWriteCapabilities,
  type CanonicalVerifiedWriteCapability,
} from './verified-write-capability-learning.js';
import type { AuthorizedLocalPlanningDefinitionV1 } from './local-planning-capability.js';
import { loadDurableAuthorizedLocalPlanningDefinition } from './local-planning-capability.js';
import type { VerifiedWriteCapabilityRecordV1 } from '../../memory/verified-write-capability-store.js';

const INDEX_SHORTLIST = 24;
const logger = pino({ name: 'clementine-next.indexed-capability-catalog' });

type VerifiedWriteResolver = (
  objective: string,
) => Promise<CanonicalVerifiedWriteCapability[]>;
let verifiedWriteResolver: VerifiedWriteResolver = resolveCanonicalVerifiedWriteCapabilities;

/** Isolated-test seam for the planning materializer. Production always uses
 * the canonical receipt/binding/terminal verifier above this seam. */
export function _setVerifiedWriteResolverForTests(
  resolver: VerifiedWriteResolver | null,
): void {
  verifiedWriteResolver = resolver ?? resolveCanonicalVerifiedWriteCapabilities;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function capabilityIdOf(identifier: string): string {
  return `cap:resolved:${identifier.trim().toLowerCase()}`;
}

function destinationFamilyOf(carrier: string): string {
  return carrier.trim().toLowerCase();
}

function descriptorFromHit(hit: CapabilityOperationHit): HostCapabilityDescriptorV1 {
  const write = hit.effectClass === 'write';
  const identifier = hit.identifier.trim();
  const family = destinationFamilyOf(hit.carrier);
  return {
    id: capabilityIdOf(identifier),
    effect: write ? 'external_write' : 'read',
    purpose: write ? 'persist_collection' : 'collect_records',
    acceptedInputKinds: write ? ['evidence', 'records'] : ['evidence'],
    producedOutputKinds: write ? ['evidence', 'created_resource'] : ['evidence', 'records'],
    applicableDeliverableKinds: write ? ['evidence', family || 'artifact'] : ['evidence'],
    inputShape: write ? 'records' : 'evidence',
    outputShape: write ? 'created_resource' : 'records',
    outputKind: write ? 'created_resource' : 'records',
    deliverableKind: write ? (family || 'artifact') : 'records',
    destinationPosture: write ? 'create_new' : null,
    evidenceKinds: write ? ['receipt', 'readback'] : ['payload'],
    handleRequired: write,
    readbackRequired: write,
    accountScope: hit.accountIdentity ?? 'runtime',
    manifestDigest: sha256(JSON.stringify({
      v: 1,
      kind: 'capability_index',
      identifier,
      carrier: hit.carrier,
      effect: hit.effectClass,
      provenance: hit.effectProvenance,
    })),
    advisoryRoles: write ? ['create', 'destination'] : ['source', 'collection', 'collect'],
  };
}

export function hostDescriptorsFromCapabilityIndex(objective: string): HostCapabilityDescriptorV1[] {
  try {
    return searchCapabilityOperations(objective, { limit: INDEX_SHORTLIST })
      .filter((hit) => hit.effectClass === 'read' || hit.effectClass === 'write')
      .map(descriptorFromHit);
  } catch {
    return [];
  }
}

function catalogEntryIsAttested(entry: RegisteredHostCapability): boolean {
  return Boolean(
    entry.capabilityId.trim()
    && entry.toolName.trim()
    && entry.schemaDigest.trim()
    && entry.manifestDigest?.trim()
    && entry.manifest
    && typeof entry.invoke === 'function',
  );
}

function proofKindMatchesCarrier(
  kind: string,
  carrierKind: CapabilityOperationHit['carrierKind'],
): boolean {
  return (kind === 'composio' && carrierKind === 'composio')
    || (kind === 'mcp' && carrierKind === 'mcp')
    || (kind === 'cli' && carrierKind === 'cli');
}

function proofKindMatchesProvider(kind: string, providerKind: string): boolean {
  return (kind === 'composio' && providerKind === 'composio')
    || (kind === 'mcp' && providerKind === 'native_mcp')
    || (kind === 'cli' && providerKind === 'reviewed_cli');
}

function proofEffectMatchesManifest(
  effectClass: string | undefined,
  effect: CapabilityManifestV1['effect'],
): boolean {
  if (effectClass === 'read') {
    return effect === 'read' || effect === 'compute' || effect === 'host_only';
  }
  if (effectClass === 'write') {
    return effect === 'local_write' || effect === 'external_write' || effect === 'admin';
  }
  return false;
}

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function currentComposioAccountForProof(proof: CapabilityResolutionEntry): string | null {
  let connections: ReturnType<typeof peekConnectedToolkits>;
  try {
    connections = peekConnectedToolkits();
  } catch {
    return null;
  }
  if (connections.length === 0) return null;
  const hint = proof.accountIdentity?.trim() ?? '';
  if (hint) {
    // Foreground discovery records the current connection id; learned memory
    // records a stable mailbox identity. Accept either only through the same
    // pure current-snapshot selector used at foreground planning.
    const exactConnection = connections.filter((candidate) => candidate.connectionId === hint);
    if (exactConnection.length > 0) {
      const exact = selectToolkitConnection(proof.identifier, exactConnection);
      if (exact.kind === 'resolved' && exact.connectionId === hint) return hint;
      return null;
    }
  }
  const selected = selectToolkitConnection(
    proof.identifier,
    connections,
    hint || undefined,
  );
  return selected.kind === 'resolved' ? selected.connectionId : null;
}

function currentAccountForProof(proof: CapabilityResolutionEntry): string | null | undefined {
  if (proof.kind === 'composio') return currentComposioAccountForProof(proof);
  const account = proof.accountIdentity?.trim() ?? '';
  return account && account !== 'runtime' ? account : undefined;
}

function currentManifestsForProof(
  store: CapabilityManifestStore,
  proof: CapabilityResolutionEntry,
): InstalledCapabilityManifest[] {
  const base = store.list().filter((installed) => {
    const manifest = currentCapabilityManifest(installed.manifest);
    return Boolean(
      manifest
      && normalized(manifest.operationId) === normalized(proof.identifier)
      && proofKindMatchesProvider(proof.kind, manifest.providerKind)
      && proofEffectMatchesManifest(proof.effectClass, manifest.effect),
    );
  });
  const proofAccount = proof.accountIdentity?.trim() ?? '';
  // A foreground host resolution may already carry the exact current account
  // id. That is an identity match, not a memory alias, and needs no second
  // connection lookup merely to read an already-revalidated catalog row.
  if (proofAccount) {
    const exact = base.filter((installed) => installed.manifest.accountId === proofAccount);
    if (exact.length > 0) return exact;
  }
  const currentAccount = currentAccountForProof(proof);
  if (proof.kind === 'composio' && currentAccount === null) {
    // Connected-goal proof predates account-aware foreground disclosure. It
    // may select a single already-installed current account, never choose
    // among several accounts by store order.
    return proofAccount ? [] : base;
  }
  return currentAccount === undefined
    ? base
    : base.filter((installed) => installed.manifest.accountId === currentAccount);
}

/** A learned mutation identity never gets provider/name heuristics. It may
 * nominate only an already-installed manifest whose four routing dimensions
 * and content-addressed capability id are byte-for-byte current. */
export function currentManifestsForVerifiedWrite(
  store: CapabilityManifestStore,
  learned: VerifiedWriteCapabilityRecordV1,
): InstalledCapabilityManifest[] {
  if (learned.bindingKind !== 'catalog_manifest') return [];
  return store.list().filter((installed) => {
    const manifest = currentCapabilityManifest(installed.manifest);
    return Boolean(
      manifest
      && manifest.manifestId === learned.capabilityRef
      && manifest.providerKind === learned.providerKind
      && manifest.operationId === learned.operationId
      && manifest.effect === learned.effect
      && manifest.accountId === learned.accountIdentity,
    );
  });
}

function indexDoesNotContradictProof(
  proof: CapabilityResolutionEntry,
  hits: readonly CapabilityOperationHit[],
): boolean {
  const account = proof.accountIdentity?.trim() ?? '';
  const exact = hits.filter((hit) => (
    normalized(hit.identifier) === normalized(proof.identifier)
    && proofKindMatchesCarrier(proof.kind, hit.carrierKind)
    && (!hit.accountIdentity || !account || hit.accountIdentity === account)
  ));
  // The index is nomination-only, so absence and inferred classifications do
  // not veto a receipt-backed proof. A provider-declared/host-curated opposite
  // effect is real drift, however, and must prevent automatic supply.
  return !exact.some((hit) => (
    (hit.effectProvenance === 'declared' || hit.effectProvenance === 'curated')
    && (hit.effectClass === 'read' || hit.effectClass === 'write')
    && hit.effectClass !== proof.effectClass
  ));
}

function canonicalLearnedProofs(input: {
  sessionId: string;
  objective: string;
}): CapabilityResolutionEntry[] {
  let entries: readonly CapabilityResolutionEntry[] = [];
  try {
    entries = resolveTurnCapabilities(input.objective, { sessionId: input.sessionId }).entries;
  } catch {
    return [];
  }
  return entries.flatMap((proof) => {
    if (
      proof.status !== 'proven'
      || proof.connection === 'missing'
      || (proof.effectClass !== 'read' && proof.effectClass !== 'unknown')
      || !proof.verifiedReadOrigin
    ) return [];
    const receipt = canonicalVerifiedReadReceipt({
      origin: proof.verifiedReadOrigin,
      identifier: proof.identifier,
      ...(proof.accountIdentity ? { accountIdentity: proof.accountIdentity } : {}),
    });
    if (!receipt) return [];
    const receiptAccount = receipt.scope?.accountIdentity?.trim() ?? '';
    return [{
      ...proof,
      // The canonical receipt—not lexical naming or the connect-time index—
      // proves this was a settled read. Reviewed CLI inventory intentionally
      // carries `unknown`, so requiring lexical read classification here would
      // make a real receipt-backed CLI success impossible to supply.
      effectClass: 'read' as const,
      // Some legacy choice rows omitted non-email MCP/CLI account identities.
      // The canonical receipt is the stronger source and restores that exact
      // binding for current-manifest matching; it never comes from prose.
      ...(receiptAccount ? { accountIdentity: receiptAccount } : {}),
    }];
  });
}

function catalogEntryMatchesInstalledManifest(
  entry: RegisteredHostCapability,
  installed: InstalledCapabilityManifest,
): boolean {
  const manifest = currentCapabilityManifest(installed.manifest);
  const identity = canonicalCatalogIdentityOf(entry);
  if (!manifest || !identity) return false;
  try {
    return installed.digest === capabilityManifestDigest(manifest)
      && entry.manifest !== undefined
      && capabilityManifestDigest(entry.manifest) === installed.digest
      && identity.capabilityId === manifest.manifestId
      && identity.manifestId === manifest.manifestId
      && identity.manifestDigest === installed.digest
      && identity.operationId === manifest.operationId
      && identity.schemaVersion === manifest.operationVersion
      && identity.schemaDigest === manifest.definitionFingerprint
      && identity.liveFingerprint === manifest.definitionFingerprint
      && identity.providerKind === manifest.providerKind
      && identity.providerVersion === manifest.providerVersion
      && identity.account === manifest.accountId
      && identity.effect === manifest.effect
      && identity.invokePortId === manifest.invokePortId
      && (identity.reconcilePortId ?? '') === (manifest.reconcilePortId ?? '')
      && identity.argumentCompiler.id === manifest.argumentCompiler.id
      && identity.argumentCompiler.version === manifest.argumentCompiler.version;
  } catch {
    return false;
  }
}

/** The same proof the adapter's own keep-branch demands before it reuses a
 * still-callable row: a FRESH independent observation of exactly this
 * operation/account whose bytes match the installed manifest. An unchanged
 * manifest whose provider now refuses the account/operation has no such
 * observation, and a byte-exact row must not outlive that refusal. */
function installedManifestHasFreshIndependentObservation(
  installed: InstalledCapabilityManifest,
): boolean {
  const manifest = currentCapabilityManifest(installed.manifest);
  if (!manifest) return false;
  let observation: ReturnType<typeof independentlyObserveCapability>;
  try {
    observation = independentlyObserveCapability(manifest.operationId, manifest.accountId);
  } catch {
    return false;
  }
  return Boolean(
    observation
    && observation.origin === 'independent'
    && observationIsFresh(observation)
    && observationMatchesManifest(manifest, {
      definitionFingerprint: observation.definitionFingerprint,
      providerVersion: observation.providerVersion,
      operationVersion: observation.operationVersion,
      accountId: observation.accountId,
      observedAt: observation.observedAt,
    }).ok,
  );
}

export function catalogEntriesForAcceptedSource(input: {
  sessionId: string;
  sourceUserSeq: number;
  objective?: string;
}): RegisteredHostCapability[] {
  void input.objective;
  const proofs = provenCapabilityEntriesForTurn(input)
    .filter((entry) => entry.kind === 'composio' || entry.kind === 'cli' || entry.kind === 'mcp');
  const selectedIds = new Set(proofs.map((entry) => capabilityIdOf(entry.identifier)));
  // PEEK, never persist: this runs from pre-model preparation (deterministic
  // compile, bind enumeration) BEFORE foreground tool_search can disclose
  // anything. Persisting here durably froze an empty snapshot that every
  // later plan admission was refused against (2026-08-26 gauntlet). The
  // snapshot is frozen by plan admission / the execution owner, never by prep.
  const frozen = peekCatalogSnapshotForSource({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  const snapshot = frozen.ok
    ? [...frozen.entries]
    : (peekHostCapabilityCatalogFactory()?.snapshot() ?? []);
  // Production carrier IDs need not use the legacy cap:resolved convention
  // (native MCP is content-addressed; reviewed CLI may be versioned). Extend
  // the current-source selection only when one exact attested live row matches
  // operation/provider/effect/account. Ambiguity never falls back to order.
  for (const proof of proofs) {
    const candidates = snapshot.filter((entry) => {
      const manifest = entry.manifest;
      const proofAccount = proof.accountIdentity?.trim() ?? '';
      return Boolean(
        manifest
        && normalized(manifest.operationId) === normalized(proof.identifier)
        && proofKindMatchesProvider(proof.kind, manifest.providerKind)
        && proofEffectMatchesManifest(proof.effectClass, manifest.effect)
        && (!proofAccount || proofAccount === 'runtime' || manifest.accountId === proofAccount),
      );
    });
    if (candidates.length === 1) selectedIds.add(candidates[0]!.capabilityId);
  }
  return snapshot.filter((entry) => {
    if (entry.effect === 'host_only') return catalogEntryIsAttested(entry);
    return catalogEntryIsAttested(entry) && selectedIds.has(entry.capabilityId);
  });
}

/**
 * Rehydrate a request-relevant capability that this host already proved.
 *
 * A current request re-resolves durable Tool Memory and accepts only a
 * canonical verified-read receipt. Neither that receipt nor the optional
 * connect-time index may create a manifest, port, observation, or catalog row.
 * The receipt nominates an operation; the provider-neutral production adapter
 * may then reopen exactly one already-installed current manifest and its
 * independently observed port. That turns in-memory catalog membership back
 * into a cache instead of making every new turn rediscover a capability that
 * already succeeded. Index rows remain ranking/contradiction evidence only.
 *
 * Returned `registered` ids are current live catalog identities. They can
 * enter the planning card, but remain planning supply: selected plan
 * admission still revalidates account/schema/effect before freezing any
 * executable authority.
 */
export async function registerIndexedCapabilitiesForTurn(input: {
  sessionId: string;
  sourceUserSeq: number;
  objective: string;
}): Promise<{
  registered: string[];
  descriptors: HostCapabilityDescriptorV1[];
  localDefinitions: AuthorizedLocalPlanningDefinitionV1[];
}> {
  // Keep unknown-effect rows as nominations (real reviewed-CLI inventory is
  // intentionally unknown). Only known-effect rows become advisory semantic
  // descriptors; neither form contributes execution authority.
  const indexed = searchCapabilityOperations(input.objective, { limit: INDEX_SHORTLIST });
  const descriptors = indexed
    .filter((hit) => hit.effectClass === 'read' || hit.effectClass === 'write')
    .map(descriptorFromHit);
  const learnedWrites = await verifiedWriteResolver(input.objective);
  const localByRef = new Map<string, AuthorizedLocalPlanningDefinitionV1>();
  const ambiguousLocalRefs = new Set<string>();
  for (const candidate of learnedWrites) {
    if (candidate.record.bindingKind !== 'local_envelope' || !candidate.currentLocalDefinition) continue;
    const ref = candidate.currentLocalDefinition.capabilityRef;
    if (ambiguousLocalRefs.has(ref)) continue;
    const prior = localByRef.get(ref);
    if (
      prior
      && JSON.stringify(prior) !== JSON.stringify(candidate.currentLocalDefinition)
    ) {
      // Two HISTORICAL rows cannot choose among conflicting current local
      // identities. This is an abstention, never store-order selection.
      // Each candidate reobserves against its OWN origin.sourceUserSeq, so an
      // object that was legitimately created and then edited yields two valid
      // but different definitions and lands here.
      localByRef.delete(ref);
      ambiguousLocalRefs.add(ref);
      continue;
    }
    localByRef.set(ref, candidate.currentLocalDefinition);
  }
  // EXACT-SOURCE RECOVERY. The abstention above is right to refuse a choice
  // between two histories, but it must not discard an authority THIS source
  // holds. When the accepted source has its own durable local definition for an
  // abstained ref, that is not a tie — it is the current answer, and historical
  // disagreement is irrelevant to it.
  //
  // SCOPE — do not overstate this. It only RELOADS a durable current-source row
  // that already exists; it cannot create one. So it is neither what made warm
  // native writes fail nor what fixes them. An earlier revision of this comment
  // claimed that lineage (citing C11 edit 135472 / Space create 135561) and was
  // wrong: on a warm turn there was no current-source row for it to find in the
  // first place. The actual cause was that priming staged indexed definitions in
  // memory without publishing this source's durable `capability_discovered` row,
  // so the direct call path had nothing to resolve and the turn detoured into
  // plan_task — corrected at the priming site in
  // admit-and-compile-accepted-source.ts, not here.
  //
  // What this block is worth on its own: once such a row exists, an unrelated
  // historical tie must not hide it from the warm catalog.
  for (const ref of ambiguousLocalRefs) {
    try {
      const exact = await loadDurableAuthorizedLocalPlanningDefinition({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        capabilityRef: ref,
      });
      if (exact.ok && exact.definition.capabilityRef === ref) {
        localByRef.set(ref, exact.definition);
      }
    } catch {
      // Recovery is additive: a failed exact-source read leaves the abstention
      // in place. It must never invent an authority the source does not hold.
    }
  }
  const localDefinitions = [...localByRef.values()];
  const store = peekCapabilityManifestStore();
  const adapter = peekProductionCapabilityAdapter();
  const factory = peekHostCapabilityCatalogFactory();
  if (!store || !adapter || !factory) {
    return { registered: [], descriptors, localDefinitions };
  }

  const selected = new Map<string, InstalledCapabilityManifest>();
  for (const proof of canonicalLearnedProofs(input)) {
    if (!indexDoesNotContradictProof(proof, indexed)) continue;
    const matches = currentManifestsForProof(store, proof);
    // One learned operation may have several current versions/accounts. Memory
    // never chooses by insertion order; explicit lifecycle/account resolution
    // must reduce it to one exact manifest or the turn falls back to discovery.
    if (matches.length !== 1) continue;
    selected.set(matches[0]!.manifest.manifestId, matches[0]!);
  }
  for (const learned of learnedWrites) {
    const matches = currentManifestsForVerifiedWrite(store, learned.record);
    // Account/effect/provider/version ambiguity can only send the turn back to
    // foreground discovery. A historical success never picks by row order.
    if (matches.length !== 1) continue;
    selected.set(matches[0]!.manifest.manifestId, matches[0]!);
  }
  const manifestIds = new Set(selected.keys());
  logger.debug({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    manifestIds: [...manifestIds],
    present: [...manifestIds].filter((manifestId) => Boolean(factory.get(manifestId))),
  }, 'indexed_catalog_prime_selected');
  if (manifestIds.size === 0) return { registered: [], descriptors, localDefinitions };

  // Cross-turn supply must prove the catalog identity was rebuilt from the
  // installed manifest rather than accept stale account/schema/port bytes. A
  // live row that already matches the installed manifest byte-for-byte IS
  // that proof, so it is kept exactly as registered. Forgetting it and letting
  // the adapter re-register the same manifest rebuilt the row in a different
  // registration shape (optional identity keys differ between the direct
  // proof-provisioned registration and the adapter's), and any snapshot
  // frozen against the original bytes — a resumed source whose recovery had
  // just rehydrated them, or another session sharing this process — then
  // refused with identity_mismatch (hard-cut resume, 2026-08-31). Equality
  // stays exact; nothing persisted is rewritten. Revoked/superseded manifests
  // are never selected above (they have no current manifest), so they are
  // still evicted by readiness refresh and re-proved at every crossing.
  // Byte-match alone is not enough: an UNCHANGED manifest whose provider now
  // refuses the account/operation shows up as a missing or stale independent
  // observation, not as a changed manifest. Keeping such a row would let a
  // refused capability outlive its refusal, so the skip demands exactly what
  // the adapter's keep-branch demands — a fresh, independent, manifest-
  // matching observation (recovery reproof and proof provisioning register
  // one). Anything less takes forget+refresh, which re-observes and evicts.
  const alreadySupplied = new Set<string>();
  for (const manifestId of manifestIds) {
    const current = factory.get(manifestId);
    const installed = selected.get(manifestId);
    if (
      current
      && installed
      && catalogEntryIsAttested(current)
      && catalogEntryMatchesInstalledManifest(current, installed)
      && installedManifestHasFreshIndependentObservation(installed)
    ) alreadySupplied.add(manifestId);
  }
  // Scoped refresh is essential: a turn nominated these exact manifests, so
  // unrelated stale catalog entries cannot be forgotten as collateral work.
  // Only rows that are absent or drift from the installed manifest are
  // forgotten first, so the adapter cannot reuse their stale bytes.
  const rebuild = new Set([...manifestIds].filter((manifestId) => !alreadySupplied.has(manifestId)));
  for (const manifestId of rebuild) factory.forget(manifestId);
  let refreshed: ReturnType<typeof adapter.refresh> = { registered: 0, refused: [] };
  if (rebuild.size > 0) {
    try {
      refreshed = adapter.refresh(rebuild);
    } catch {
      return { registered: [...alreadySupplied], descriptors, localDefinitions };
    }
  }
  const refused = new Set(refreshed.refused.map((entry) => entry.manifestId));
  const registered = [...manifestIds].filter((manifestId) => {
    if (alreadySupplied.has(manifestId)) return true;
    const current = factory.get(manifestId);
    const installed = selected.get(manifestId);
    return Boolean(
      !refused.has(manifestId)
      && current
      && installed
      && catalogEntryIsAttested(current)
      && catalogEntryMatchesInstalledManifest(current, installed),
    );
  });
  return { registered, descriptors, localDefinitions };
}
