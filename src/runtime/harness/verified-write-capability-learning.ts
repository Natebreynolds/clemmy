/**
 * Canonical verified-write learning and redemption.
 *
 * A prior mutation can nominate a capability for a later planning card only
 * after five independent durable facts agree:
 *   1. exactly one commit_effect receipt exists for the logical call;
 *   2. redeemEvidenceReceipt reopens that receipt and its backing settlement;
 *   3. the exact accepted task/source and immutable host-call binding agree;
 *   4. the accepted task reached a published `done` terminal whose adjudication
 *      still returns done; and
 *   5. the learned row contains identity only.
 *
 * This module never invokes a tool, consumes an approval, or copies arguments,
 * targets, templates, or consent from the old call.
 */
import {
  catalogSnapshotDigestOf,
  type CanonicalCatalogIdentityV1,
} from './host-capability-catalog-factory.js';
import {
  loadHostCallCapabilityBinding,
  type HostCallCapabilityBinding,
} from './host-call-capability-binding.js';
import { loadManifestState } from './obligation-store.js';
import { redeemEvidenceReceipt } from './evidence-receipts.js';
import {
  getTurnGraphEventForSource,
  listEvents,
  openEventLog,
  readAcceptedTaskTerminalPublication,
} from './eventlog.js';
import { presentationEventFromCompletionData } from './turn-outcome.js';
import { adjudicateTerminalForTaskSync } from './terminal-truth.js';
import {
  loadDurableAuthorizedLocalPlanningDefinition,
  observeCurrentLocalPlanningDefinition,
  type AuthorizedLocalPlanningDefinitionV1,
} from './local-planning-capability.js';
import {
  matchVerifiedWriteCapabilities,
  storeVerifiedWriteCapability,
  verifiedWriteAliasForPhrase,
  VERIFIED_WRITE_CAPABILITY_CLASS,
  VERIFIED_WRITE_LOCAL_PROVIDER,
  type StoredVerifiedWriteCapability,
  type VerifiedWriteCapabilityRecordV1,
  type VerifiedWriteEffect,
} from '../../memory/verified-write-capability-store.js';
import type { VerifiedWriteCapabilityOrigin } from '../../memory/verified-write-origin.js';
import { digestSchema } from '../../tools/tool-contract-store.js';

interface CommitReceiptRow {
  receipt_id: string;
  kind: string;
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  manifest_id: string;
  node_id: string;
  obligation: string;
  logical_tool_call_id: string;
  physical_dispatch_id: string;
}

interface ExpectedWorkBindingRow {
  accepted_task_id: string;
  contract_id: string;
  requirement_id: string;
  tool_name: string;
  effect_kind: string;
}

export interface CanonicalVerifiedWriteCapability {
  record: StoredVerifiedWriteCapability | VerifiedWriteCapabilityRecordV1;
  hostBinding: HostCallCapabilityBinding;
  /** Current host reobservation for a local envelope. Catalog manifests are
   * reconstructed by the production adapter at the planning boundary. */
  currentLocalDefinition?: AuthorizedLocalPlanningDefinitionV1;
}

/** Closed terminal predicate used by the canonical verifier. Keeping the
 * identity and adjudication checks in one pure gate makes missing, tampered,
 * blocked, and uncertain states impossible to accidentally treat alike. */
export function verifiedWriteTerminalGate(input: {
  origin: VerifiedWriteCapabilityOrigin;
  publicationStatus: string;
  acceptedTaskId?: string;
  terminalEventId?: string;
  presentationStatus?: string;
  adjudicatedStatus: string;
}): boolean {
  return input.publicationStatus === 'published'
    && input.acceptedTaskId === input.origin.acceptedTaskId
    && input.terminalEventId === input.origin.terminalEventId
    && input.presentationStatus === 'done'
    && input.adjudicatedStatus === 'done';
}

/** Compare a reobserved local registry row with both the identity-only record
 * and the old immutable host binding. No historical schema is promoted. */
export function verifiedWriteLocalIdentityIsCurrent(input: {
  record: StoredVerifiedWriteCapability | VerifiedWriteCapabilityRecordV1;
  binding: Pick<HostCallCapabilityBinding,
    'bindingKind' | 'toolName' | 'effect'>;
  definition: AuthorizedLocalPlanningDefinitionV1;
}): boolean {
  const envelopeFingerprint = digestSchema({
    version: 1,
    provenance: input.definition.provenance,
    name: input.definition.name,
    carrier: input.definition.carrier,
    schemaFingerprint: input.definition.schemaFingerprint,
    registrySemanticsFingerprint: input.definition.registrySemanticsFingerprint,
  });
  const manifestDigest = digestSchema({
    version: 1,
    provenance: input.definition.provenance,
    capabilityRef: input.definition.capabilityRef,
    envelopeFingerprint: input.definition.envelopeFingerprint,
  });
  return input.record.bindingKind === 'local_envelope'
    && input.binding.bindingKind === 'local_envelope'
    && input.binding.toolName === input.record.operationId
    && input.binding.effect === input.record.effect
    && input.definition.provenance === 'authorized_local_registry'
    && input.definition.name === input.record.operationId
    && input.definition.carrier === 'work_call'
    && input.definition.destructive === false
    && input.definition.capabilityRef === input.record.capabilityRef
    && input.definition.descriptor.id === input.record.capabilityRef
    && input.definition.envelopeFingerprint === envelopeFingerprint
    && input.definition.descriptor.manifestDigest === manifestDigest
    && input.definition.envelopeFingerprint === input.record.localEnvelopeFingerprint
    && input.definition.accountIdentity === input.record.accountIdentity
    && input.definition.descriptor.effect === input.record.effect;
}

function readCommitRows(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId?: string;
}): CommitReceiptRow[] {
  try {
    const whereCall = input.logicalToolCallId === undefined
      ? ''
      : 'AND logical_tool_call_id = ?';
    return openEventLog().prepare(`
      SELECT receipt_id, kind, session_id, source_user_seq, accepted_task_id,
             manifest_id, node_id, obligation, logical_tool_call_id,
             physical_dispatch_id
        FROM host_write_receipts
       WHERE session_id = ? AND source_user_seq = ?
         AND obligation = 'commit_effect' AND kind = 'commit'
         ${whereCall}
       ORDER BY logical_tool_call_id ASC, receipt_id ASC
       LIMIT 65
    `).all(
      input.sessionId,
      input.sourceUserSeq,
      ...(input.logicalToolCallId === undefined ? [] : [input.logicalToolCallId]),
    ) as CommitReceiptRow[];
  } catch {
    return [];
  }
}

function acceptedPhrase(input: { sessionId: string; sourceUserSeq: number }): string | null {
  try {
    const matches = listEvents(input.sessionId, { types: ['user_input_received'] })
      .filter((event) => event.seq === input.sourceUserSeq && event.role === 'user');
    if (matches.length !== 1) return null;
    const data = matches[0]!.data;
    const display = typeof data.displayText === 'string' ? data.displayText.trim() : '';
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    return display || text || null;
  } catch {
    return null;
  }
}

function exactCatalogIdentityForBinding(
  binding: HostCallCapabilityBinding,
): CanonicalCatalogIdentityV1 | null {
  if (binding.bindingKind !== 'catalog_manifest') return null;
  try {
    const row = openEventLog().prepare(`
      SELECT snapshot_digest, snapshot_json
        FROM accepted_source_catalog_snapshots
       WHERE session_id = ? AND source_user_seq = ?
    `).get(binding.sessionId, binding.sourceUserSeq) as {
      snapshot_digest: string;
      snapshot_json: string;
    } | undefined;
    if (!row || row.snapshot_digest !== binding.catalogRevisionDigest) return null;
    const identities = JSON.parse(row.snapshot_json) as unknown;
    if (!Array.isArray(identities)
      || catalogSnapshotDigestOf(identities as CanonicalCatalogIdentityV1[]) !== row.snapshot_digest) return null;
    const matches = (identities as CanonicalCatalogIdentityV1[]).filter((identity) => Boolean(
      identity
      && typeof identity === 'object'
      && identity.capabilityId === binding.capabilityId
      && identity.manifestId === binding.manifestId
      && identity.manifestDigest === binding.manifestDigest
      && identity.operationId === binding.operationId
      && identity.schemaDigest === binding.schemaFingerprint
      && identity.account === binding.accountId
      && identity.effect === binding.effect
      && identity.invokePortId === binding.invokePortId
      && (identity.providerInputSchemaDigest ?? null) === (binding.providerInputSchemaDigest ?? null)
      && typeof identity.providerKind === 'string'
      && identity.providerKind.trim() === identity.providerKind
      && identity.providerKind.length > 0
    ));
    return matches.length === 1 ? matches[0]! : null;
  } catch {
    return null;
  }
}

function graphNamesCapability(input: {
  sessionId: string;
  sourceUserSeq: number;
  nodeId: string;
  capabilityRef: string;
}): boolean {
  try {
    const graph = getTurnGraphEventForSource(input.sessionId, input.sourceUserSeq)?.data.graph;
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return false;
    const nodes = (graph as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) return false;
    const matchingNodes = nodes.filter((raw) => (
      raw && typeof raw === 'object' && !Array.isArray(raw)
      && (raw as Record<string, unknown>).id === input.nodeId
    ));
    if (matchingNodes.length !== 1) return false;
    const capabilities = (matchingNodes[0] as Record<string, unknown>).capabilities;
    if (!Array.isArray(capabilities)) return false;
    const names = capabilities.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const row = raw as Record<string, unknown>;
      if (row.kind !== 'tool' || row.resolution !== 'explicit' || !Array.isArray(row.names)) return [];
      return row.names.filter((name): name is string => typeof name === 'string');
    });
    return names.filter((name) => name === input.capabilityRef).length === 1;
  } catch {
    return false;
  }
}

function effectMatchesManifestNode(
  effect: VerifiedWriteEffect,
  nodeEffect: string,
): boolean {
  return effect === 'admin'
    ? nodeEffect === 'external_write'
    : effect === nodeEffect;
}

/** Reopen every durable authority named by a learned write row. */
export async function canonicalVerifiedWriteCapability(
  record: StoredVerifiedWriteCapability | VerifiedWriteCapabilityRecordV1,
): Promise<CanonicalVerifiedWriteCapability | null> {
  const origin = record.origin;
  if (
    record.klass !== VERIFIED_WRITE_CAPABILITY_CLASS
    || origin.acceptedTaskId !== `task:${origin.sessionId}#${origin.sourceUserSeq}`
  ) return null;
  const phrase = acceptedPhrase(origin);
  const alias = phrase ? verifiedWriteAliasForPhrase(phrase) : null;
  if (
    !alias
    || alias.aliasDigest !== record.aliasDigest
    || JSON.stringify(alias.terms) !== JSON.stringify(record.terms)
  ) return null;

  const terminal = readAcceptedTaskTerminalPublication(origin.sessionId, origin.sourceUserSeq);
  const presentation = terminal.status === 'published'
    ? presentationEventFromCompletionData(terminal.event.data)
    : null;
  const adjudicated = adjudicateTerminalForTaskSync({
    sessionId: origin.sessionId,
    sourceUserSeq: origin.sourceUserSeq,
  });
  if (!verifiedWriteTerminalGate({
    origin,
    publicationStatus: terminal.status,
    ...(terminal.status === 'published'
      ? {
          acceptedTaskId: terminal.acceptedTaskId,
          terminalEventId: terminal.terminalEventId,
        }
      : {}),
    ...(presentation ? { presentationStatus: presentation.status } : {}),
    adjudicatedStatus: adjudicated.status,
  })) return null;

  const receipts = readCommitRows({
    sessionId: origin.sessionId,
    sourceUserSeq: origin.sourceUserSeq,
    logicalToolCallId: origin.logicalToolCallId,
  });
  if (receipts.length !== 1) return null;
  const receipt = receipts[0]!;
  if (
    receipt.receipt_id !== origin.receiptId
    || receipt.kind !== 'commit'
    || receipt.obligation !== 'commit_effect'
    || receipt.session_id !== origin.sessionId
    || receipt.source_user_seq !== origin.sourceUserSeq
    || receipt.accepted_task_id !== origin.acceptedTaskId
    || receipt.logical_tool_call_id !== origin.logicalToolCallId
  ) return null;
  const redeemed = redeemEvidenceReceipt(origin.sessionId, origin.receiptId, {
    expectKind: 'commit',
    sourceUserSeq: origin.sourceUserSeq,
    physicalAttemptId: receipt.physical_dispatch_id,
  });
  if (!redeemed.ok) return null;

  const loadedBinding = loadHostCallCapabilityBinding({
    db: openEventLog(),
    sessionId: origin.sessionId,
    sourceUserSeq: origin.sourceUserSeq,
    logicalToolCallId: origin.logicalToolCallId,
  });
  if (
    loadedBinding.status !== 'ok'
    || loadedBinding.binding.acceptedTaskId !== origin.acceptedTaskId
    || loadedBinding.binding.durableBindingDigest !== origin.hostBindingDigest
    || loadedBinding.binding.bindingKind !== record.bindingKind
    || loadedBinding.binding.effect !== record.effect
    || (record.bindingKind === 'catalog_manifest'
      && (
        loadedBinding.binding.capabilityId !== record.capabilityRef
        || loadedBinding.binding.operationId !== record.operationId
      ))
    || (record.bindingKind === 'local_envelope'
      && loadedBinding.binding.toolName !== record.operationId)
  ) return null;
  const binding = loadedBinding.binding;

  const manifestState = loadManifestState(origin.sessionId, origin.sourceUserSeq);
  if (manifestState.status !== 'ok' || manifestState.manifest.manifestId !== receipt.manifest_id) return null;
  const nodes = manifestState.manifest.nodes.filter((node) => node.nodeId === receipt.node_id);
  if (nodes.length !== 1) return null;
  const node = nodes[0]!;
  if (
    !node.obligations.includes('commit_effect')
    || node.resolvedTool !== record.operationId
    || !effectMatchesManifestNode(record.effect, node.effectKind)
  ) return null;

  let work: ExpectedWorkBindingRow | undefined;
  let acceptedOperations: Array<{
    resolved_tool: string;
    operation_id: string;
    graph_node_id: string;
    effect_kind: string;
  }> = [];
  try {
    work = openEventLog().prepare(`
      SELECT accepted_task_id, contract_id, requirement_id, tool_name, effect_kind
        FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      origin.sessionId,
      origin.sourceUserSeq,
      origin.logicalToolCallId,
    ) as ExpectedWorkBindingRow | undefined;
    acceptedOperations = openEventLog().prepare(`
      SELECT resolved_tool, operation_id, graph_node_id, effect_kind
        FROM accepted_task_operations
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
         AND operation_id = ?
       LIMIT 2
    `).all(
      origin.sessionId,
      origin.sourceUserSeq,
      origin.logicalToolCallId,
      node.operationId,
    ) as Array<{
      resolved_tool: string;
      operation_id: string;
      graph_node_id: string;
      effect_kind: string;
    }>;
  } catch {
    return null;
  }
  if (
    !work
    || work.accepted_task_id !== origin.acceptedTaskId
    || work.requirement_id !== node.operationId
    || work.tool_name !== node.resolvedTool
    || work.effect_kind !== record.effect
    || acceptedOperations.length !== 1
    || acceptedOperations[0]!.resolved_tool !== node.resolvedTool
    || acceptedOperations[0]!.effect_kind !== record.effect
  ) return null;

  if (record.bindingKind === 'catalog_manifest') {
    const identity = exactCatalogIdentityForBinding(binding);
    if (
      !identity
      || record.capabilityRef !== binding.capabilityId
      || record.providerKind !== identity.providerKind
      || record.operationId !== binding.operationId
      || record.accountIdentity !== binding.accountId
      || record.localEnvelopeFingerprint !== null
    ) return null;
    return { record, hostBinding: binding };
  }

  if (
    binding.bindingKind !== 'local_envelope'
    || record.providerKind !== VERIFIED_WRITE_LOCAL_PROVIDER
    || record.accountIdentity !== 'local_registry:host'
    || !graphNamesCapability({
      sessionId: origin.sessionId,
      sourceUserSeq: origin.sourceUserSeq,
      nodeId: acceptedOperations[0]!.graph_node_id,
      capabilityRef: record.capabilityRef,
    })
  ) return null;
  const observed = await loadDurableAuthorizedLocalPlanningDefinition({
    sessionId: origin.sessionId,
    sourceUserSeq: origin.sourceUserSeq,
    capabilityRef: record.capabilityRef,
  });
  if (
    !observed.ok
    || !verifiedWriteLocalIdentityIsCurrent({
      record,
      binding,
      definition: observed.definition,
    })
  ) return null;
  return { record, hostBinding: binding, currentLocalDefinition: observed.definition };
}

function originFor(input: {
  sessionId: string;
  sourceUserSeq: number;
  terminalEventId: string;
  receipt: CommitReceiptRow;
  binding: HostCallCapabilityBinding;
}): VerifiedWriteCapabilityOrigin {
  return {
    version: 1,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.receipt.accepted_task_id,
    logicalToolCallId: input.receipt.logical_tool_call_id,
    receiptId: input.receipt.receipt_id,
    hostBindingDigest: input.binding.durableBindingDigest,
    terminalEventId: input.terminalEventId,
  };
}

export type LearnVerifiedWriteCapabilitiesResult =
  | { status: 'learned' | 'replayed'; records: StoredVerifiedWriteCapability[] }
  | { status: 'not_proven'; reason: string };

/** Materialize identity-only rows after the exact terminal is durable. */
export async function learnVerifiedWriteCapabilitiesForAcceptedTask(input: {
  sessionId: string;
  sourceUserSeq: number;
}): Promise<LearnVerifiedWriteCapabilitiesResult> {
  const phrase = acceptedPhrase(input);
  const alias = phrase ? verifiedWriteAliasForPhrase(phrase) : null;
  if (!alias) return { status: 'not_proven', reason: 'accepted source has no privacy-bounded intent terms' };
  const terminal = readAcceptedTaskTerminalPublication(input.sessionId, input.sourceUserSeq);
  if (terminal.status !== 'published') {
    return { status: 'not_proven', reason: 'accepted task has no published terminal adjudication' };
  }
  const presentation = presentationEventFromCompletionData(terminal.event.data);
  if (!presentation || presentation.status !== 'done') {
    return { status: 'not_proven', reason: 'accepted task terminal is not done' };
  }
  if (adjudicateTerminalForTaskSync(input).status !== 'done') {
    return { status: 'not_proven', reason: 'accepted task evidence no longer adjudicates done' };
  }
  const receipts = readCommitRows(input);
  if (receipts.length === 0 || receipts.length > 64) {
    return { status: 'not_proven', reason: 'accepted task has no bounded commit-effect receipt set' };
  }

  const records: StoredVerifiedWriteCapability[] = [];
  let inserted = 0;
  for (const receipt of receipts) {
    const loaded = loadHostCallCapabilityBinding({
      db: openEventLog(),
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      logicalToolCallId: receipt.logical_tool_call_id,
    });
    if (loaded.status !== 'ok') continue;
    const binding = loaded.binding;
    let record: VerifiedWriteCapabilityRecordV1 | null = null;
    if (binding.bindingKind === 'catalog_manifest') {
      const identity = exactCatalogIdentityForBinding(binding);
      if (!identity || !['local_write', 'external_write', 'admin'].includes(binding.effect)) continue;
      record = {
        version: 1,
        klass: VERIFIED_WRITE_CAPABILITY_CLASS,
        aliasDigest: alias.aliasDigest,
        terms: alias.terms,
        origin: originFor({ ...input, terminalEventId: terminal.terminalEventId, receipt, binding }),
        bindingKind: 'catalog_manifest',
        providerKind: identity.providerKind,
        capabilityRef: binding.capabilityId,
        operationId: binding.operationId,
        effect: binding.effect as VerifiedWriteEffect,
        accountIdentity: binding.accountId,
        localEnvelopeFingerprint: null,
      };
    } else {
      const manifestState = loadManifestState(input.sessionId, input.sourceUserSeq);
      const node = manifestState.status === 'ok'
        ? manifestState.manifest.nodes.find((candidate) => candidate.nodeId === receipt.node_id)
        : undefined;
      if (!node || node.effectKind !== 'local_write') continue;
      let acceptedOperation: {
        graph_node_id: string;
        resolved_tool: string;
        effect_kind: string;
      } | undefined;
      try {
        const rows = openEventLog().prepare(`
          SELECT graph_node_id, resolved_tool, effect_kind
            FROM accepted_task_operations
           WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
             AND operation_id = ?
           LIMIT 2
        `).all(
          input.sessionId,
          input.sourceUserSeq,
          receipt.logical_tool_call_id,
          node.operationId,
        ) as Array<{
          graph_node_id: string;
          resolved_tool: string;
          effect_kind: string;
        }>;
        acceptedOperation = rows.length === 1 ? rows[0] : undefined;
      } catch {
        acceptedOperation = undefined;
      }
      if (
        !acceptedOperation
        || acceptedOperation.resolved_tool !== node.resolvedTool
        || acceptedOperation.effect_kind !== 'local_write'
      ) continue;
      const current = await observeCurrentLocalPlanningDefinition({
        name: node.resolvedTool,
        carrier: 'work_call',
      });
      if (!current.ok || !graphNamesCapability({
        ...input,
        nodeId: acceptedOperation.graph_node_id,
        capabilityRef: current.definition.capabilityRef,
      })) continue;
      const observed = await loadDurableAuthorizedLocalPlanningDefinition({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        capabilityRef: current.definition.capabilityRef,
      });
      if (!observed.ok) continue;
      record = {
        version: 1,
        klass: VERIFIED_WRITE_CAPABILITY_CLASS,
        aliasDigest: alias.aliasDigest,
        terms: alias.terms,
        origin: originFor({ ...input, terminalEventId: terminal.terminalEventId, receipt, binding }),
        bindingKind: 'local_envelope',
        providerKind: VERIFIED_WRITE_LOCAL_PROVIDER,
        capabilityRef: observed.definition.capabilityRef,
        operationId: observed.definition.name,
        effect: 'local_write',
        accountIdentity: observed.definition.accountIdentity,
        localEnvelopeFingerprint: observed.definition.envelopeFingerprint,
      };
    }
    const canonical = record ? await canonicalVerifiedWriteCapability(record) : null;
    if (!canonical) continue;
    const stored = storeVerifiedWriteCapability({ record });
    if (!stored.stored) continue;
    if (stored.inserted) inserted += 1;
    records.push(stored.record);
  }
  if (records.length === 0) return { status: 'not_proven', reason: 'no commit receipt closed a canonical host capability identity' };
  return { status: inserted === 0 ? 'replayed' : 'learned', records };
}

const backfilled = new Set<string>();

/** Crash-gap repair: a terminal may commit immediately before the separate
 * capability-only row. The next planning turn backfills recent exact terminal
 * writes without replaying their calls. */
export async function backfillRecentVerifiedWriteCapabilities(limit = 64): Promise<void> {
  let rows: Array<{ session_id: string; source_user_seq: number }> = [];
  try {
    rows = openEventLog().prepare(`
      SELECT DISTINCT authority.session_id, authority.source_user_seq
        FROM accepted_task_authority AS authority
        JOIN host_write_receipts AS receipt
          ON receipt.session_id = authority.session_id
         AND receipt.source_user_seq = authority.source_user_seq
         AND receipt.obligation = 'commit_effect'
         AND receipt.kind = 'commit'
       WHERE authority.state = 'terminal'
       ORDER BY authority.updated_at DESC
       LIMIT ?
    `).all(Math.max(1, Math.min(limit, 256))) as Array<{ session_id: string; source_user_seq: number }>;
  } catch {
    return;
  }
  for (const row of rows) {
    const key = `${row.session_id}#${row.source_user_seq}`;
    if (backfilled.has(key)) continue;
    const learned = await learnVerifiedWriteCapabilitiesForAcceptedTask({
      sessionId: row.session_id,
      sourceUserSeq: row.source_user_seq,
    });
    if (learned.status === 'learned' || learned.status === 'replayed') backfilled.add(key);
  }
}

/** Retrieve and canonically revalidate request-relevant learned write rows. */
export async function resolveCanonicalVerifiedWriteCapabilities(
  objective: string,
): Promise<CanonicalVerifiedWriteCapability[]> {
  await backfillRecentVerifiedWriteCapabilities();
  const candidates = matchVerifiedWriteCapabilities(objective, { limit: 8 });
  const verified: CanonicalVerifiedWriteCapability[] = [];
  for (const candidate of candidates) {
    const canonical = await canonicalVerifiedWriteCapability(candidate);
    if (canonical) verified.push(canonical);
  }
  return verified;
}

export const __test__ = {
  exactCatalogIdentityForBinding,
  graphNamesCapability,
  resetBackfillCache() { backfilled.clear(); },
};
