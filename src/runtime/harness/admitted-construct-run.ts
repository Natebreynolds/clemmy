/**
 * Production admitted-graph executor for the collect→transform→create→
 * readback→verify path. Every crossing uses accepted-task, expected-work,
 * logical-call, physical-dispatch, artifact, and settlement ledgers.
 *
 * Dispatch invariant: only a newly inserted physical-dispatch reservation
 * may cross the provider boundary. A replayed or uncertain dispatch with no
 * authoritative result reconciles or stops — it never invokes again.
 */
import { createHash, randomUUID } from 'node:crypto';
import { runGraph, type NodeOutcome, type NodeRunner } from '../graph/graph-executor.js';
import { admitGraph, GRAPH_JOURNAL_SCHEMA_VERSION } from '../graph/graph-admission.js';
import { sealExecutionIdentity } from '../graph/graph-node-identity.js';
import { withNodeLeases, createLeaseManager, type LeaseStorePort } from '../graph/graph-lease.js';
import {
  reuseVerifierFor,
  type ArtifactRecord,
  type ArtifactStorePort,
} from '../graph/graph-artifacts.js';
import type { GraphJournalAdapter, GraphJournalEntry } from '../graph/graph-journal.js';
import type { TurnGraphIR, TurnGraphNode } from '../graph/turn-graph-ir.js';
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import { evaluateGoalEvidence } from '../graph/goal-evidence.js';
import { admitConstructPublish, admitConstructWrite } from '../graph/collect-construct-vertical.js';
import { redeemRawResult, toResultHandle, type ResultHandleAuthority } from './result-handle.js';
import { expectedTaskFor } from './resolution-ledger.js';
import {
  admitLogicalCall,
  beginPhysicalDispatch,
  logicalCallAuthorityState,
  physicalCrossingsForLogicalCall,
  settlePhysicalDispatch,
} from './dispatch-ledger.js';
import { commitLogicalCallSettlement } from './logical-call-settlement-store.js';
import { freezeActionExpectedWorkContract } from './expected-work-contract.js';
import {
  activateActionExpectedWork,
  admitExpectedWorkInvocation,
} from './expected-work-admission.js';
import { requireAcceptedTaskAuthority } from './accepted-task-authority.js';
import {
  bindArtifactSlot,
  claimArtifactSlot,
  createHostSealedArtifactContentContract,
  hostArtifactContentDigest,
  resolveArtifactRunScopeId,
  verifyHostSealedArtifactContentFromReadback,
} from './artifact-ledger.js';
import { commitTurnOutcome } from './delivery-committer.js';
import { heldExecutionTextForInternalReason, isHostAuthorityHeldReason } from './public-presentation.js';
import { turnOutcomeId, type TurnOutcome } from './turn-outcome.js';
import { appendEvent, getTurnGraphEventForSource, listEvents, openEventLog } from './eventlog.js';
import {
  bindAdmittedNodeCapability,
  catalogDigestOf,
  type BoundNodeCapability,
  type GraphNodeCapabilityReconcile,
  type HostCapabilityCatalog,
} from './graph-node-capability.js';
import {
  createHostCapabilityCatalogFactory,
  freezeCatalogSnapshotForSource,
  installHostCapabilityCatalogFactory,
  loadSealedNodeBinding,
  peekHostCapabilityCatalogFactory,
  persistSealedNodeBinding,
  resolveRuntimeCapabilityCatalog,
  sealBoundCapability,
} from './host-capability-catalog-factory.js';
import {
  attachSemanticContract,
  capabilityManifestDigest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import { peekCapabilityManifestStore, resolveCapabilityManifestStore } from './capability-manifest-store.js';
import { mintResolvedCallAuthority, type ResolvedCallAuthorityV1 } from './resolved-call-authority.js';
import { canonicalLogicalToolName } from './logical-call-contract.js';
import { readClaimLinkedSemanticInterpretation } from '../semantic-boundary/interpret-accepted-source.js';
import { requirePhysicalDispatchGrounding } from './physical-dispatch-grounding.js';
import { buildGraphNodeInvocationEnvelope } from './graph-node-envelope.js';
import { validateBoundCapabilityEdges } from '../graph/capability-edge-kinds.js';
import { compileSealedProviderArgs } from './production-capability-adapters.js';
import { registerIndependentCapabilityObservation, independentlyObserveCapability } from './independent-capability-observation.js';
import {
  authorizeTypedReconciliation,
  beginTypedPhysicalDispatch,
  loadPersistedCallAuthority,
  retainUncertainReconciliationMaterial,
  setSettlementStorageFault,
} from './dispatch-ledger.js';
import {
  canonicalGraphNodeLeaseKey,
  encodeCanonicalOwnerFence,
  readCanonicalGraphNodeLease,
} from './canonical-graph-node-lease.js';
import { derivePhysicalDispatchId } from './physical-crossing-identity.js';
import { claimPhysicalIo, physicalIoClaimed } from './physical-io-claim.js';
import { activationOwnerIsGone, mintActivationOwner } from './activation-liveness.js';
import { configureTypedExecutionRuntime, refreshTypedExecutionReadiness } from '../semantic-boundary/configure-typed-execution-runtime.js';

export interface ConstructProviderPorts {
  sourceRead: (digest: string) => Promise<unknown>;
  collectionRead: (digest: string) => Promise<{ records: Array<Record<string, unknown>> }>;
  transform: (records: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>>;
  create: (records: Array<Record<string, unknown>>) => Promise<{ id: string; handle: string; receipt?: string }>;
  reconcile?: GraphNodeCapabilityReconcile;
  readback: (id: string) => Promise<{ id: string; handle: string; content?: unknown }>;
}

export interface ConstructRunResult {
  status: 'success' | 'blocked' | 'failed' | 'uncertain';
  providerCalls: { sourceRead: number; collectionRead: number; transform: number; create: number; readback: number };
  artifactHandle?: string;
  createdId?: string;
  handles: Record<string, string>;
  published?: boolean;
  error?: string;
}

export type AdmittedGraphRunFault =
  | 'after_reservation'
  | 'after_provider_return'
  | 'before_receipt'
  | 'after_handle'
  | 'before_publication'
  | 'before_write'
  | 'after_write'
  | 'settlement_storage'
  | null;

const HOST_ONLY_KINDS = new Set([
  'turn_accepted',
  'policy_snapshot',
  'intent_authority',
  'context_resolve',
  'capability_resolve',
  'compose_reply',
  'compose_blocked',
  'verify',
  'publish',
]);

let testFault: AdmittedGraphRunFault = null;

export function setAdmittedGraphRunFault(fault: AdmittedGraphRunFault): void {
  testFault = fault;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function contentDigestOf(value: unknown): string {
  return hostArtifactContentDigest(value);
}

function asRecords(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (payload && typeof payload === 'object' && Array.isArray((payload as { records?: unknown }).records)) {
    return (payload as { records: Array<Record<string, unknown>> }).records;
  }
  return [];
}

function isIndependentReceipt(receipt: unknown, id: string, response: unknown): receipt is string {
  if (typeof receipt !== 'string' || !receipt.trim()) return false;
  if (receipt === `receipt:${id}`) return false;
  if (receipt === canonicalJson(response)) return false;
  return true;
}

interface NodeArtifact {
  nodeId: string;
  role: string;
  value: unknown;
  handle?: string;
  contentDigest?: string;
}

function sqliteLeaseStore(): LeaseStorePort {
  const db = openEventLog();
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_node_leases (
      lease_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      fence INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released INTEGER NOT NULL DEFAULT 0
    );
  `);
  const readRow = (key: string) => db.prepare(
    `SELECT owner, fence, revision, expires_at, released FROM graph_node_leases WHERE lease_key = ?`,
  ).get(key) as { owner: string; fence: number; revision: number; expires_at: number; released: number } | undefined;
  return {
    async read(key) {
      const row = readRow(key);
      if (!row) return undefined;
      return {
        owner: row.owner,
        fence: row.fence,
        revision: row.revision,
        expiresAt: row.expires_at,
        released: row.released === 1,
      };
    },
    async cas(key, expected, next) {
      const current = db.prepare(
        `SELECT fence, revision FROM graph_node_leases WHERE lease_key = ?`,
      ).get(key) as { fence: number; revision: number } | undefined;
      if (expected === undefined) {
        if (current) return false;
        db.prepare(
          `INSERT INTO graph_node_leases (lease_key, owner, fence, revision, expires_at, released)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(key, next.owner, next.fence, next.revision, next.expiresAt, next.released ? 1 : 0);
        return true;
      }
      if (!current || current.fence !== expected.fence || current.revision !== expected.revision) return false;
      const updated = db.prepare(
        `UPDATE graph_node_leases
            SET owner = ?, fence = ?, revision = ?, expires_at = ?, released = ?
          WHERE lease_key = ? AND fence = ? AND revision = ?`,
      ).run(next.owner, next.fence, next.revision, next.expiresAt, next.released ? 1 : 0, key, expected.fence, expected.revision);
      return updated.changes === 1;
    },
    transactSync(key, expected, now, work) {
      try {
        let fence = 'acquireOwner' in expected ? 0 : expected.fence;
        db.transaction(() => {
          const current = readRow(key);
          if ('acquireOwner' in expected) {
            const owner = expected.acquireOwner;
            if (!current) {
              db.prepare(
                `INSERT INTO graph_node_leases (lease_key, owner, fence, revision, expires_at, released)
                 VALUES (?, ?, 1, 1, ?, 0)`,
              ).run(key, owner, now + 30_000);
              fence = 1;
            } else if (
              !current.released
              && current.expires_at > now
              && current.owner !== owner
              && !activationOwnerIsGone(current.owner)
            ) {
              throw new Error('lease-mismatch');
            } else if (!current.released && current.expires_at > now && current.owner === owner) {
              fence = current.fence;
            } else {
              const nextFence = current.fence + 1;
              const updated = db.prepare(
                `UPDATE graph_node_leases
                    SET owner = ?, fence = ?, revision = revision + 1, expires_at = ?, released = 0
                  WHERE lease_key = ? AND fence = ? AND revision = ?`,
              ).run(owner, nextFence, now + 30_000, key, current.fence, current.revision);
              if (updated.changes !== 1) throw new Error('lease-cas-lost');
              fence = nextFence;
            }
          } else {
            if (
              !current
              || current.owner !== expected.owner
              || current.fence !== expected.fence
              || current.released === 1
              || current.expires_at <= now
            ) {
              throw new Error('lease-mismatch');
            }
            const updated = db.prepare(
              `UPDATE graph_node_leases
                  SET revision = revision + 1, expires_at = ?
                WHERE lease_key = ? AND owner = ? AND fence = ? AND released = 0`,
            ).run(now + 30_000, key, expected.owner, expected.fence);
            if (updated.changes !== 1) throw new Error('lease-cas-lost');
            fence = expected.fence;
          }
          work();
        }).immediate();
        return { ok: true, fence };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async transact(key, expected, now, work) {
      const sync = this.transactSync?.(key, expected, now, () => undefined);
      if (!sync?.ok) return sync ?? { ok: false, reason: 'lease transact unavailable' };
      await work();
      return { ok: true };
    },
  };
}

function durableJournal(identity: { sessionId: string; turn: number; sourceUserSeq: number }): {
  entries: GraphJournalEntry[];
  adapter: GraphJournalAdapter;
} {
  const db = openEventLog();
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_journal_entries (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      entry_json TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq, seq)
    );
  `);
  const prior = db.prepare(
    `SELECT entry_json FROM graph_journal_entries
      WHERE session_id = ? AND source_user_seq = ?
      ORDER BY seq ASC`,
  ).all(identity.sessionId, identity.sourceUserSeq) as Array<{ entry_json: string }>;
  const entries = prior.map((row) => JSON.parse(row.entry_json) as GraphJournalEntry);
  return {
    entries,
    adapter: {
      appendSync(entry) {
        const seq = (db.prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next
             FROM graph_journal_entries
            WHERE session_id = ? AND source_user_seq = ?`,
        ).get(identity.sessionId, identity.sourceUserSeq) as { next: number }).next;
        db.prepare(
          `INSERT INTO graph_journal_entries (session_id, source_user_seq, seq, entry_json)
           VALUES (?, ?, ?, ?)`,
        ).run(identity.sessionId, identity.sourceUserSeq, seq, JSON.stringify(entry));
        entries.push(entry);
      },
      async append(entry) {
        db.transaction(() => {
          const seq = (db.prepare(
            `SELECT COALESCE(MAX(seq), 0) + 1 AS next
               FROM graph_journal_entries
              WHERE session_id = ? AND source_user_seq = ?`,
          ).get(identity.sessionId, identity.sourceUserSeq) as { next: number }).next;
          db.prepare(
            `INSERT INTO graph_journal_entries (session_id, source_user_seq, seq, entry_json)
             VALUES (?, ?, ?, ?)`,
          ).run(identity.sessionId, identity.sourceUserSeq, seq, JSON.stringify(entry));
          entries.push(entry);
        }).immediate();
      },
    },
  };
}

async function awaitPeerCanonicalOutcome(
  identity: { sessionId: string; turn: number; sourceUserSeq: number },
  timeoutMs = 30_000,
): Promise<ConstructRunResult | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const terminals = listEvents(identity.sessionId, { types: ['conversation_completed'] });
    const match = [...terminals].reverse().find((event) => (
      event.turn === identity.turn
      && event.data.sourceUserSeq === identity.sourceUserSeq
    ));
    if (match) {
      const outcome = match.data.turnOutcome as {
        status?: string;
      } | undefined;
      const presentation = match.data.presentation as {
        text?: string;
        status?: string;
      } | undefined;
      const status = outcome?.status ?? String(match.data.status ?? '');
      const text = presentation?.text
        ?? (typeof match.data.reply === 'string' ? match.data.reply : '')
        ?? '';
      if (status === 'done' && text) {
        return {
          status: 'success',
          providerCalls: { sourceRead: 0, collectionRead: 0, transform: 0, create: 0, readback: 0 },
          artifactHandle: text,
          handles: {},
          published: true,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

function nextAttemptIdFromHistory(entries: readonly GraphJournalEntry[]): () => string {
  let max = 0;
  for (const entry of entries) {
    if (!('attemptId' in entry) || typeof entry.attemptId !== 'string') continue;
    const match = entry.attemptId.match(/(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return () => `construct-attempt-${(max += 1)}`;
}

function expectedEffectForBinding(
  binding: BoundNodeCapability,
): 'read' | 'compute' | 'local_write' | 'external_write' | 'admin' | 'unknown' {
  if (binding.effect === 'none' || binding.effect === 'host_only') return 'compute';
  return binding.effect === 'read'
    || binding.effect === 'compute'
    || binding.effect === 'local_write'
    || binding.effect === 'external_write'
    || binding.effect === 'admin'
    ? binding.effect
    : 'unknown';
}

function expectedWorkProposalFromGraph(
  graph: TurnGraphIR,
  bindings: ReadonlyMap<string, BoundNodeCapability>,
) {
  const ops = graph.nodes.filter((node) => node.operationId);
  if (ops.length === 0) return null;
  return {
    version: 1 as const,
    operations: ops.map((node) => {
      const binding = bindings.get(node.id);
      const observed = binding ? expectedEffectForBinding(binding) : undefined;
      const write = node.effect.kind === 'external_write'
        || node.effect.kind === 'local_write'
        || node.effect.kind === 'admin'
        || observed === 'local_write'
        || observed === 'external_write'
        || observed === 'admin';
      const dependsOn = graph.edges
        .filter((edge) => edge.target === node.id && ops.some((candidate) => candidate.id === edge.source))
        .map((edge) => edge.source);
      const effect = observed && observed !== 'unknown'
        ? observed
        : write
          ? node.effect.kind
          : node.capabilityRole === 'transform' || node.capabilityRole === 'extract'
            ? 'compute' as const
            : 'read' as const;
      return {
        id: node.id,
        effect,
        ...(effect === 'read' ? { coverage: 'single' as const } : {}),
        dependsOn,
        dataFrom: effect === 'read' ? [] : dependsOn,
        cardinality: { kind: 'once' as const },
      };
    }),
    universes: [],
  };
}

function authorityFromRow(row: {
  session_id: string | null;
  source_user_seq: number | null;
  accepted_task_id: string | null;
  logical_tool_call_id: string | null;
  physical_dispatch_id: string | null;
  tool_name: string;
  argument_digest?: string;
}): ResultHandleAuthority | undefined {
  if (
    !row.session_id
    || row.source_user_seq == null
    || !row.accepted_task_id
    || !row.logical_tool_call_id
    || !row.physical_dispatch_id
  ) return undefined;
  return {
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    acceptedTaskId: row.accepted_task_id,
    logicalToolCallId: row.logical_tool_call_id,
    physicalDispatchId: row.physical_dispatch_id,
    toolName: row.tool_name,
    ...(row.argument_digest ? { canonicalArgumentDigest: row.argument_digest } : {}),
  };
}

function loadVerifiedAdmittedGraph(identity: {
  sessionId: string;
  turn: number;
  sourceUserSeq: number;
}): { ok: true; graph: TurnGraphIR } | { ok: false; reason: string } {
  const event = getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq);
  const durableGraph = turnGraphFromShadowEvent(event);
  const provenance = event?.data.semanticProvenanceDigest;
  const linked = readClaimLinkedSemanticInterpretation(identity.sessionId, identity.sourceUserSeq);
  if (
    !event
    || !durableGraph
    || typeof provenance !== 'string'
    || !/^[a-f0-9]{64}$/i.test(provenance)
    || !linked
    || linked.record.validationOutcome !== 'admitted'
    || durableGraph.identity.sessionId !== identity.sessionId
    || durableGraph.identity.sourceUserSeq !== identity.sourceUserSeq
    || durableGraph.identity.turn !== identity.turn
    || durableGraph.graphId !== event.data.graphId
    || durableGraph.compiler.graphHash !== event.data.graphHash
    || durableGraph.compiler.policyHash !== event.data.policyHash
    || event.data.semanticProvenanceDigest !== provenance
  ) {
    return { ok: false, reason: 'durable_graph_authority_mismatch' };
  }
  return { ok: true, graph: durableGraph };
}

export async function runAdmittedConstructVertical(input: {
  graph: TurnGraphIR;
  // No `providers` shorthand: building a catalog from in-process callbacks is a
  // fixture concern, and accepting it here let a test seam reach the production
  // entry point. Callers pass an already-bound catalog.
  capabilityCatalog?: HostCapabilityCatalog;
  priorHandles?: Record<string, string>;
  identity?: { sessionId: string; turn: number; sourceUserSeq: number };
}): Promise<ConstructRunResult> {
  return runAdmittedTurnGraph({
    graph: input.graph,
    identity: input.identity,
    priorHandles: input.priorHandles,
    capabilityCatalog: input.capabilityCatalog,
  });
}

export async function runAdmittedSourceGraph(identity: {
  sessionId: string;
  turn: number;
  sourceUserSeq: number;
}): Promise<ConstructRunResult> {
  return runAdmittedTurnGraph({ identity });
}

export async function runAdmittedTurnGraph(input: {
  graph?: TurnGraphIR;
  identity?: { sessionId: string; turn: number; sourceUserSeq: number };
  priorHandles?: Record<string, string>;
  capabilityCatalog?: HostCapabilityCatalog;
}): Promise<ConstructRunResult> {
  const providerCalls = { sourceRead: 0, collectionRead: 0, transform: 0, create: 0, readback: 0 };
  const empty = (): ConstructRunResult => ({
    status: 'blocked',
    providerCalls,
    handles: { ...(input.priorHandles ?? {}) },
    error: 'durable_graph_authority_mismatch',
  });
  if (input.identity) {
    const loaded = loadVerifiedAdmittedGraph(input.identity);
    if (!loaded.ok) {
      return { ...empty(), error: loaded.reason };
    }
    if (
      input.graph
      && (
        input.graph.graphId !== loaded.graph.graphId
        || input.graph.compiler.graphHash !== loaded.graph.compiler.graphHash
      )
    ) {
      return empty();
    }
    input = { ...input, graph: loaded.graph };
  }
  const graph = input.graph;
  if (!graph) return empty();
  input = { ...input, graph };
  const handles: Record<string, string> = { ...(input.priorHandles ?? {}) };
  const artifacts = new Map<string, NodeArtifact>();
  const artifactRecords = new Map<string, ArtifactRecord>();
  const persistArtifactRecord = (record: ArtifactRecord): void => {
    artifactRecords.set(record.ref, record);
    try {
      const db = openEventLog();
      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_artifact_records (
          ref TEXT PRIMARY KEY,
          record_json TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT OR REPLACE INTO graph_artifact_records (ref, record_json) VALUES (?, ?)`,
      ).run(record.ref, JSON.stringify(record));
    } catch {
      // Durable artifact records are best-effort beside the result-handle store.
    }
  };
  const loadArtifactRecord = (ref: string): ArtifactRecord | undefined => {
    const cached = artifactRecords.get(ref);
    if (cached) return cached;
    try {
      const row = openEventLog().prepare(
        `SELECT record_json FROM graph_artifact_records WHERE ref = ?`,
      ).get(ref) as { record_json: string } | undefined;
      if (!row) return undefined;
      const record = JSON.parse(row.record_json) as ArtifactRecord;
      artifactRecords.set(ref, record);
      return record;
    } catch {
      return undefined;
    }
  };
  let lastBlockReason = '';
  let published = false;
  let publishedHandle: string | undefined;
  let commitError: string | undefined;
  const identity = input.identity;
  const frozenCatalog = identity
    ? freezeCatalogSnapshotForSource({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
      })
    : null;
  if (frozenCatalog && !frozenCatalog.ok && frozenCatalog.reason !== 'missing_factory') {
    return {
      status: 'blocked',
      providerCalls,
      handles,
      error: `catalog_snapshot:${frozenCatalog.reason}`,
    };
  }
  const catalog = (frozenCatalog && frozenCatalog.ok ? frozenCatalog.catalog : undefined)
    ?? resolveRuntimeCapabilityCatalog(input.capabilityCatalog);
  const boundCapabilities = new Map<string, BoundNodeCapability>();
  const admissionRef = { digest: graph.compiler.graphHash, attemptByNode: new Map<string, string>() };
  const expected = identity ? expectedTaskFor(identity.sessionId, identity.sourceUserSeq) : null;
  const acceptedTaskId = expected && expected.status === 'ok' ? expected.expectation.acceptedTaskId : '';
  const acceptedText = identity
    ? String(listEvents(identity.sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === identity.sourceUserSeq)?.data.text ?? '')
    : '';

  const rememberArtifact = (nodeId: string, role: string, value: unknown, handle?: string): NodeArtifact => {
    const artifact: NodeArtifact = {
      nodeId,
      role,
      value,
      ...(handle ? { handle } : {}),
      contentDigest: contentDigestOf(value),
    };
    artifacts.set(nodeId, artifact);
    if (handle) handles[nodeId] = handle;
    return artifact;
  };

  const predecessorsOf = (nodeId: string): NodeArtifact[] => graph.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => artifacts.get(edge.source))
    .filter((artifact): artifact is NodeArtifact => Boolean(artifact));

  const envelopeFor = (
    node: TurnGraphNode,
    binding: BoundNodeCapability,
    callIdentity: { sessionId: string; sourceUserSeq: number; acceptedTaskId: string },
  ) => {
    const linked = identity
      ? readClaimLinkedSemanticInterpretation(identity.sessionId, identity.sourceUserSeq)
      : null;
    const raw = linked?.record.raw && typeof linked.record.raw === 'object'
      ? linked.record.raw as {
          goal?: { objective?: string; criteria?: Array<{ id: string; statement: string }> };
        }
      : {};
    return buildGraphNodeInvocationEnvelope({
      graph,
      node,
      binding,
      identity: callIdentity,
      goal: {
        objective: raw.goal?.objective ?? acceptedText,
        revision: graph.classification.goalIdentity?.revision ?? 0,
        criteria: raw.goal?.criteria ?? [],
      },
      predecessors: predecessorsOf(node.id).map((prior) => ({
        nodeId: prior.nodeId,
        role: prior.role,
        artifactRef: prior.handle,
        contentDigest: prior.contentDigest,
        value: prior.value,
      })),
    });
  };

  const recordsFrom = (nodeId: string): Array<Record<string, unknown>> => {
    const preds = predecessorsOf(nodeId);
    const transformed = preds.filter((prior) => prior.role === 'transform' || prior.role === 'extract');
    const collected = preds.filter((prior) => prior.role === 'collection' || prior.role === 'collect');
    const chosen = transformed.length > 0 ? transformed : collected;
    const merged: Array<Record<string, unknown>> = [];
    for (const prior of chosen) merged.push(...asRecords(prior.value));
    return merged;
  };

  const createdFrom = (nodeId: string): { id: string; handle: string; receipt?: string; contentDigest?: string } | undefined => {
    for (const prior of predecessorsOf(nodeId)) {
      const direct = prior.value as { id?: string; handle?: string; receipt?: string; writtenDigest?: string };
      const nested = (prior.value as { created?: { id?: string; handle?: string; receipt?: string; writtenDigest?: string } }).created;
      const candidate = typeof direct?.id === 'string' && typeof direct.handle === 'string' ? direct : nested;
      if (candidate && typeof candidate.id === 'string' && typeof candidate.handle === 'string') {
        return {
          id: candidate.id,
          handle: candidate.handle,
          receipt: candidate.receipt,
          contentDigest: typeof candidate.writtenDigest === 'string' ? candidate.writtenDigest : prior.contentDigest,
        };
      }
    }
    return undefined;
  };

  if (identity && acceptedTaskId) {
    try {
      const priorRows = openEventLog().prepare(
        `SELECT logical_tool_call_id, raw_location, session_id, source_user_seq,
                accepted_task_id, physical_dispatch_id, tool_name, argument_digest, raw_payload_json
           FROM durable_result_handles
          WHERE session_id = ? AND source_user_seq = ? AND scope_kind = 'authoritative'
            AND raw_location IS NOT NULL`,
      ).all(identity.sessionId, identity.sourceUserSeq) as Array<{
        logical_tool_call_id: string;
        raw_location: string;
        session_id: string;
        source_user_seq: number;
        accepted_task_id: string;
        physical_dispatch_id: string;
        tool_name: string;
        argument_digest: string;
        raw_payload_json: string | null;
      }>;
      for (const row of priorRows) {
        const nodeId = row.logical_tool_call_id.startsWith('logical:')
          ? row.logical_tool_call_id.slice('logical:'.length)
          : row.logical_tool_call_id;
        const authority = authorityFromRow(row);
        const redeemed = redeemRawResult(row.raw_location, authority);
        if (redeemed.status !== 'ok') continue;
        const value = redeemed.value;
        if (!handles[nodeId]) handles[nodeId] = row.raw_location;
        const node = graph.nodes.find((candidate) => candidate.id === nodeId);
        rememberArtifact(nodeId, node?.capabilityRole ?? '', value, row.raw_location);
        if (row.raw_payload_json && !loadArtifactRecord(row.raw_location)) {
          persistArtifactRecord({
            ref: row.raw_location,
            contentDigest: sha256(row.raw_payload_json),
            storeId: 'durable_result_handles',
            storeContract: 'durable_result_handles@1',
            byteLength: Buffer.byteLength(row.raw_payload_json, 'utf8'),
            mediaType: 'application/json',
            scopeDigest: sha256(identity.sessionId),
            producedBy: {
              admissionDigest: admissionRef.digest,
              nodeId,
              attemptId: row.physical_dispatch_id,
            },
            commitId: row.physical_dispatch_id,
          });
        }
      }
    } catch {
      // Prior handles are best-effort hydration through exact authority.
    }
  } else {
    for (const [nodeId, location] of Object.entries(handles)) {
      const redeemed = redeemRawResult(location);
      if (redeemed.status !== 'ok') continue;
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      rememberArtifact(nodeId, node?.capabilityRole ?? '', redeemed.value, location);
    }
  }

  const commitTerminal = (outcome: TurnOutcome): void => {
    if (!identity) return;
    commitTurnOutcome(outcome);
  };

  const terminalIdentity = identity ? {
    sessionId: identity.sessionId,
    turn: identity.turn,
    sourceUserSeq: identity.sourceUserSeq,
  } : undefined;

  const requireExactWorkBinding = (inputBinding: {
    logicalToolCallId: string;
    requirementId: string;
    toolName: string;
    argumentDigest: string;
  }): void => {
    if (!identity || !acceptedTaskId) return;
    const logicalToolName = canonicalLogicalToolName(inputBinding.toolName);
    const row = openEventLog().prepare(`
      SELECT b.requirement_id, b.tool_name, b.argument_digest,
             b.accepted_task_id, b.contract_id,
             a.work_contract_id, a.expected_work_required
        FROM accepted_task_authority a
        LEFT JOIN expected_work_call_bindings b
          ON b.session_id = a.session_id
         AND b.source_user_seq = a.source_user_seq
         AND b.logical_tool_call_id = ?
       WHERE a.session_id = ? AND a.source_user_seq = ?
    `).get(
      inputBinding.logicalToolCallId,
      identity.sessionId,
      identity.sourceUserSeq,
    ) as {
      requirement_id: string | null;
      tool_name: string | null;
      argument_digest: string | null;
      accepted_task_id: string | null;
      contract_id: string | null;
      work_contract_id: string | null;
      expected_work_required: number;
    } | undefined;
    if (
      !row
      || row.expected_work_required !== 1
      || !row.work_contract_id
      || row.contract_id !== row.work_contract_id
      || row.accepted_task_id !== acceptedTaskId
      || row.requirement_id !== inputBinding.requirementId
      // Expected-work and logical-call ledgers intentionally store the
      // canonical logical identity. Provider manifests retain their exact
      // operation spelling separately in the sealed node binding.
      || !logicalToolName
      || row.tool_name !== logicalToolName
      || row.argument_digest !== inputBinding.argumentDigest
    ) {
      throw new Error(`expected-work binding is not exact for ${inputBinding.requirementId}`);
    }
  };

  const logicalArgsFor = (
    node: TurnGraphNode,
    binding: BoundNodeCapability,
    payload: unknown,
  ): Record<string, unknown> => ({
    nodeId: node.id,
    capabilityId: binding.capabilityId,
    schemaVersion: binding.schemaVersion,
    schemaDigest: binding.schemaDigest,
    digest: sha256(JSON.stringify(payload ?? null)),
    ...(node.capabilityRole === 'readback' && typeof payload === 'string'
      ? { resourceId: payload }
      : {}),
  });

  const writeJudgeForSource = (): { identity: string; digest: string } | null => {
    if (!identity) return null;
    const linked = readClaimLinkedSemanticInterpretation(identity.sessionId, identity.sourceUserSeq);
    if (!linked || linked.record.validationOutcome !== 'admitted') return null;
    const judgeIdentity = typeof linked.record.judgeIdentity === 'string' ? linked.record.judgeIdentity : '';
    const judgeDigest = typeof linked.record.judgeDigest === 'string' ? linked.record.judgeDigest : '';
    if (!judgeIdentity.trim() || !judgeDigest.trim()) return null;
    return { identity: judgeIdentity, digest: judgeDigest };
  };

  const groundingForNode = (
    node: TurnGraphNode,
    binding: BoundNodeCapability,
  ): {
    identity: string;
    receiptDigest: string;
    proposalDigest: string;
    catalogDigest: string;
  } => {
    if (!identity) {
      throw new Error('call_authority_refused:grounding_receipt_missing');
    }
    return requirePhysicalDispatchGrounding({
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      nodeId: node.id,
      binding,
    });
  };

  const requireCallAuthority = (
    node: TurnGraphNode,
    binding: BoundNodeCapability,
    envelope: ReturnType<typeof buildGraphNodeInvocationEnvelope>,
    payload: unknown,
    crossing: { physicalDispatchId: string; ordinal: number; relation: 'primary' | 'retry' | 'poll' | 'probe' | 'child'; retryOf?: string },
  ): ResolvedCallAuthorityV1 | null => {
    if (!identity || !acceptedTaskId) return null;
    const manifest = binding.manifest
      ?? (binding.manifestDigest
        ? peekCapabilityManifestStore()?.byDigest(binding.manifestDigest)?.manifest
        : undefined);
    if (!manifest) throw new Error('call_authority_refused:unknown_manifest');
    const observed = independentlyObserveCapability(manifest.operationId, manifest.accountId);
    if (!observed || observed.origin !== 'independent') {
      throw new Error('call_authority_refused:independent_observation_unavailable');
    }
    if (
      observed.operationId !== manifest.operationId
      || observed.accountId !== manifest.accountId
      || observed.definitionFingerprint !== manifest.definitionFingerprint
      || observed.operationVersion !== manifest.operationVersion
    ) {
      throw new Error('call_authority_refused:stale_fingerprint');
    }
    const logicalArgs = logicalArgsFor(node, binding, payload);
    const compiledArgs = compileSealedProviderArgs(manifest, envelope, payload);
    const grounding = groundingForNode(node, binding);
    const linked = readClaimLinkedSemanticInterpretation(identity.sessionId, identity.sourceUserSeq);
    const event = getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq);
    if (
      !linked?.eventId
      || typeof event?.data.semanticProvenanceDigest !== 'string'
      || !graph.compiler.graphHash
      || !binding.capabilityId
    ) {
      throw new Error('call_authority_refused:incomplete_identity');
    }
    const lease = readCanonicalGraphNodeLease({
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      graphId: graph.graphId,
      nodeId: node.id,
    });
    if (!lease || lease.released || lease.expiresAt <= Date.now()) {
      throw new Error('call_authority_refused:canonical graph/node lease is not live');
    }
    const ownerFence = encodeCanonicalOwnerFence(lease);
    const minted = mintResolvedCallAuthority({
      acceptedSource: { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq },
      acceptedTaskId,
      goalRevision: graph.classification.goalIdentity?.revision ?? 0,
      graphId: graph.graphId,
      graphHash: graph.compiler.graphHash,
      nodeId: node.id,
      operationId: manifest.operationId,
      capabilityRef: binding.capabilityId,
      manifest,
      canonicalArgumentDigest: '',
      canonicalArgs: compiledArgs,
      logicalArgs,
      logicalCallId: `logical:${node.id}`,
      claimEventId: linked.eventId,
      semanticProvenanceDigest: event.data.semanticProvenanceDigest,
      liveFingerprint: observed.definitionFingerprint,
      liveProviderVersion: observed.providerVersion,
      liveAccountId: observed.accountId,
      nodeEffect: node.effect?.kind ?? 'unknown',
      graphCeiling: String(graph.effectCeiling ?? 'unknown'),
      graphDestination: graph.classification.goalConstraints?.destination,
      policySnapshotDigest: graph.compiler.policyHash,
      catalogSnapshotDigest: grounding.catalogDigest
        || ((frozenCatalog && frozenCatalog.ok ? frozenCatalog.digest : undefined)
          ?? catalogDigestOf(catalog)),
      writeJudge: writeJudgeForSource(),
      groundingIdentity: grounding.identity,
      groundingReceiptDigest: grounding.receiptDigest,
      proposalDigest: grounding.proposalDigest,
      physicalDispatchId: crossing.physicalDispatchId,
      ordinal: crossing.ordinal,
      relation: crossing.relation,
      ...(crossing.retryOf ? { retryOf: crossing.retryOf } : {}),
      ownerFence,
      observation: observed,
    });
    if (!minted.ok) {
      throw new Error(`call_authority_refused:${minted.reason}`);
    }
    if (
      minted.authority.accountId !== manifest.accountId
      || minted.authority.operationId !== manifest.operationId
      || minted.authority.liveFingerprint !== manifest.definitionFingerprint
      || minted.authority.invokePortId !== manifest.invokePortId
    ) {
      throw new Error('call_authority_refused:stale_fingerprint');
    }
    return minted.authority;
  };

  const dispatch = async (
    node: TurnGraphNode,
    payload: unknown,
    mutate: boolean,
  ): Promise<unknown> => {
    const role = node.capabilityRole ?? '';
    const binding = boundCapabilities.get(node.id);
    if (!binding) throw new Error(`node ${node.id} has no preflighted capability binding`);
    const countInvoke = (): void => {
      if (role === 'source' || role === 'lookup') providerCalls.sourceRead += 1;
      else if (role === 'collection' || role === 'collect') providerCalls.collectionRead += 1;
      else if (role === 'transform' || role === 'extract') providerCalls.transform += 1;
      else if (role === 'destination' || role === 'create') providerCalls.create += 1;
      else if (role === 'readback') providerCalls.readback += 1;
    };
    if (!identity || !acceptedTaskId) {
      const existing = handles[node.id];
      if (existing) {
        const redeemed = redeemRawResult(existing);
        if (redeemed.status === 'ok') return redeemed.value;
      }
      if (mutate && (testFault === 'after_reservation' || testFault === 'before_write')) {
        throw new Error('forced crash after reservation');
      }
      countInvoke();
      const value = await binding.invoke({
        nodeId: node.id,
        role,
        payload,
        envelope: envelopeFor(node, binding, { sessionId: 'unscoped', sourceUserSeq: 0, acceptedTaskId: '' }),
        identity: { sessionId: 'unscoped', sourceUserSeq: 0, acceptedTaskId: '' },
        binding,
      });
      const stored = toResultHandle(value);
      rememberArtifact(node.id, role, value, stored.rawLocation ?? undefined);
      if (mutate && testFault === 'after_provider_return') throw new Error('forced crash after provider return');
      if (mutate && testFault === 'before_receipt') throw new Error('forced crash before receipt');
      if (mutate && (testFault === 'after_handle' || testFault === 'after_write')) {
        throw new Error('forced crash after handle');
      }
      return value;
    }
    const logicalToolCallId = `logical:${node.id}`;
    const envelope = envelopeFor(node, binding, {
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      acceptedTaskId,
    });
    const preexistingForMint = physicalCrossingsForLogicalCall(
      identity.sessionId,
      identity.sourceUserSeq,
      logicalToolCallId,
    );
    const startedForMint = preexistingForMint.find((crossing) => !crossing.settled);
    const persistedForMint = startedForMint
      ? loadPersistedCallAuthority({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          physicalDispatchId: startedForMint.physicalDispatchId,
        })
      : { ok: false as const, reason: 'none' };
    if (startedForMint && !persistedForMint.ok) {
      throw new Error(`reconciliation_required: reserved crossing has no reconstructable authority (${persistedForMint.reason})`);
    }
    const mintedAuthority = persistedForMint.ok
      ? persistedForMint.authority
      : requireCallAuthority(node, binding, envelope, payload, {
          physicalDispatchId: derivePhysicalDispatchId({
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
            graphId: graph.graphId,
            nodeId: node.id,
            logicalCallId: `logical:${node.id}`,
            ordinal: 1,
            relation: 'primary',
          }),
          ordinal: 1,
          relation: 'primary',
        });
    const args = logicalArgsFor(node, binding, payload);
    const hostOnly = mintedAuthority?.resolvedEffect === 'host_only'
      || binding.effect === 'host_only';
    const reconcileStartedDispatch = async (started: {
      physicalDispatchId: string;
      ordinal: number;
      relation: 'primary' | 'retry' | 'poll' | 'probe' | 'child';
      retryOf?: string;
    }): Promise<unknown> => {
      if (!mutate || !binding.reconcile) {
        throw new Error('reconciliation_required: started provider I/O has no exact recovery probe');
      }
      const persistedAuthority = loadPersistedCallAuthority({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        physicalDispatchId: started.physicalDispatchId,
      });
      if (!persistedAuthority.ok) {
        throw new Error(`reconciliation_required: ${persistedAuthority.reason}`);
      }
      const authorized = authorizeTypedReconciliation({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        physicalDispatchId: started.physicalDispatchId,
        authority: persistedAuthority.authority,
        accountId: binding.account ?? binding.manifest?.accountId ?? '',
        operationId: binding.manifest?.operationId ?? binding.toolName,
        operationVersion: binding.manifest?.operationVersion ?? binding.schemaVersion,
        schemaFingerprint: binding.liveFingerprint ?? binding.schemaDigest,
        reconcilePortId: binding.manifest?.reconcilePortId
          ?? persistedAuthority.authority.reconcilePortId
          ?? '',
      });
      if (!authorized.ok) {
        throw new Error(`reconciliation_required: ${authorized.reason}`);
      }
      let recovered: Awaited<ReturnType<NonNullable<BoundNodeCapability['reconcile']>>>;
      try {
        recovered = await binding.reconcile({
          destination: binding.destination,
          intendedDigest: contentDigestOf(payload),
          artifactId: typeof payload === 'string' && !/^[a-f0-9]{64}$/i.test(payload)
            ? payload
            : typeof (payload as { id?: unknown })?.id === 'string'
              ? String((payload as { id: string }).id)
              : undefined,
          authority: authorized.authority,
          physicalDispatchId: started.physicalDispatchId,
          accountId: authorized.authority.accountId,
          operationId: authorized.authority.operationId,
          operationVersion: authorized.authority.operationVersion,
          schemaFingerprint: authorized.authority.liveFingerprint,
          reconcilePortId: authorized.authority.reconcilePortId ?? '',
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`reconciliation_required: recovery probe failed (${reason})`);
      }
      const id = recovered.id;
      const handle = recovered.handle;
      if (
        recovered.exists !== true
        || typeof id !== 'string'
        || !id.trim()
        || id !== id.trim()
        || typeof handle !== 'string'
        || !handle.trim()
        || handle !== handle.trim()
        || !isIndependentReceipt(recovered.receipt, id, recovered)
      ) {
        throw new Error('reconciliation_required: recovery probe returned no exact artifact identity and receipt');
      }
      // `reconciled_present` needs proof the remote artifact holds the exact
      // intended bytes. A provider that returns the content proves it directly;
      // one that returns only a content digest proves it without moving the
      // bytes at all. Anything else is not evidence and stays uncertain.
      const intendedDigest = contentDigestOf(payload);
      const provenByContent = recovered.content !== undefined
        && contentDigestOf(recovered.content) === intendedDigest;
      const provenByDigest = typeof recovered.contentDigest === 'string'
        && recovered.contentDigest === intendedDigest;
      if (!provenByContent && !provenByDigest) {
        throw new Error('reconciliation_required: recovered artifact content does not match the sealed intended bytes');
      }
      const value = {
        id,
        handle,
        receipt: recovered.receipt,
        ...(recovered.content !== undefined ? { content: recovered.content } : {}),
      };
      const crossingIdentity = {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId,
        logicalToolCallId,
        physicalDispatchId: started.physicalDispatchId,
        ordinal: started.ordinal,
        relation: started.relation,
        ...(started.retryOf ? { retryOf: started.retryOf } : {}),
      };
      const settled = settlePhysicalDispatch({
        identity: crossingIdentity,
        tool: authorized.authority.operationId,
        outcome: 'returned',
        authorityDigest: authorized.authority.authorityDigest,
      });
      if (settled.status !== 'inserted' && settled.status !== 'replayed') {
        throw new Error(`reconciliation_required: recovered crossing could not settle (${settled.status})`);
      }
      const resultHandle = toResultHandle(value, {
        authority: {
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedTaskId,
          logicalToolCallId,
          physicalDispatchId: started.physicalDispatchId,
          toolName: binding.toolName,
          args,
        },
      });
      rememberArtifact(node.id, role, value, resultHandle.rawLocation ?? undefined);
      if (!resultHandle.rawLocation) {
        throw new Error('reconciliation_required: recovered result has no authoritative raw handle');
      }
      const payloadJson = canonicalJson(value);
      persistArtifactRecord({
        ref: resultHandle.rawLocation,
        contentDigest: sha256(payloadJson),
        storeId: 'durable_result_handles',
        storeContract: 'durable_result_handles@1',
        byteLength: Buffer.byteLength(payloadJson, 'utf8'),
        mediaType: 'application/json',
        scopeDigest: sha256(identity.sessionId),
        producedBy: {
          admissionDigest: admissionRef.digest,
          nodeId: node.id,
          attemptId: admissionRef.attemptByNode.get(node.id) ?? started.physicalDispatchId,
        },
        commitId: started.physicalDispatchId,
      });
      const committed = commitLogicalCallSettlement({
        identity: {
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedTaskId,
          logicalToolCallId,
        },
        contract: { toolName: binding.toolName, args },
        execution: { kind: 'provider_execution' },
        result: { payload: value },
        outcome: {
          kind: 'succeeded',
          evidence: 'nominal',
          providerStatus: 'reconciled',
          directive: {
            action: 'settle',
            retrySameCandidate: false,
            eliminatesCandidate: false,
            opensDiscoveryEpoch: false,
            requiresReconciliation: false,
          },
        },
        recovery: { businessCall: true, mutating: true, requirementId: node.id },
        observer: { lane: 'agents_runner', turn: identity.turn },
      });
      if (committed.status !== 'committed' && committed.status !== 'replayed') {
        throw new Error(`reconciliation_required: recovered logical call could not settle (${committed.status})`);
      }
      return value;
    };
    const priorState = logicalCallAuthorityState({
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      acceptedTaskId,
      logicalToolCallId,
    });
    if (priorState.status === 'settled') {
      const logical = openEventLog().prepare(`
        SELECT argument_digest FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(identity.sessionId, identity.sourceUserSeq, logicalToolCallId) as {
        argument_digest: string;
      } | undefined;
      requireExactWorkBinding({
        logicalToolCallId,
        requirementId: node.id,
        toolName: binding.toolName,
        argumentDigest: logical?.argument_digest ?? '',
      });
      const returned = physicalCrossingsForLogicalCall(
        identity.sessionId,
        identity.sourceUserSeq,
        logicalToolCallId,
      ).find((crossing) => crossing.outcome === 'returned');
      const row = openEventLog().prepare(
        `SELECT raw_location, physical_dispatch_id, tool_name, raw_payload_json
           FROM durable_result_handles
          WHERE session_id = ? AND source_user_seq = ?
            AND logical_tool_call_id = ?
            AND raw_location IS NOT NULL
          ORDER BY rowid DESC LIMIT 1`,
      ).get(identity.sessionId, identity.sourceUserSeq, logicalToolCallId) as {
        raw_location: string;
        physical_dispatch_id: string;
        tool_name: string;
        raw_payload_json: string | null;
      } | undefined;
      const existing = handles[node.id] ?? row?.raw_location;
      if (existing) {
        const redeemed = redeemRawResult(existing, {
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedTaskId,
          logicalToolCallId,
          physicalDispatchId: returned?.physicalDispatchId ?? row?.physical_dispatch_id ?? '',
          toolName: binding.toolName,
          args,
        });
        if (redeemed.status === 'ok') {
          rememberArtifact(node.id, role, redeemed.value, existing);
          return redeemed.value;
        }
      }
      throw new Error('settled logical call has no authoritative result');
    }
    const admitted = admitLogicalCall({
      identity: {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId,
        logicalToolCallId: mintedAuthority?.logicalCallId ?? logicalToolCallId,
      },
      tool: binding.toolName,
      args,
    });
    if (admitted.status !== 'inserted' && admitted.status !== 'replayed') {
      throw new Error(`logical call refused: ${admitted.status} ${'reason' in admitted ? admitted.reason : ''}`);
    }
    const preexistingCrossings = physicalCrossingsForLogicalCall(
      identity.sessionId,
      identity.sourceUserSeq,
      logicalToolCallId,
    );
    if (preexistingCrossings.length === 0) {
      const hostSealedEffect = expectedEffectForBinding(binding);
      const workAdmission = admitExpectedWorkInvocation({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        logicalToolCallId: mintedAuthority?.logicalCallId ?? logicalToolCallId,
        requirementId: node.id,
        tool: binding.toolName,
        args,
        ...(hostSealedEffect !== 'unknown'
          ? { hostSealedEffect }
          : {}),
      });
      if (workAdmission.status !== 'bound' && workAdmission.status !== 'replayed') {
        const detail = workAdmission.status === 'refused'
          ? `${workAdmission.kind}: ${workAdmission.reason}`
          : workAdmission.status;
        throw new Error(`expected-work admission refused ${node.id}: ${detail}`);
      }
    } else {
      requireExactWorkBinding({
        logicalToolCallId,
        requirementId: node.id,
        toolName: binding.toolName,
        argumentDigest: admitted.identity.argumentDigest,
      });
    }
    const crossings = preexistingCrossings;
    const returned = crossings.find((crossing) => crossing.outcome === 'returned');
    if (returned) {
      const existing = handles[node.id];
      if (existing) {
        const redeemed = redeemRawResult(existing, {
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedTaskId,
          logicalToolCallId,
          physicalDispatchId: returned.physicalDispatchId,
          toolName: binding.toolName,
        });
        if (redeemed.status === 'ok') return redeemed.value;
      }
      throw new Error('replayed dispatch has a returned crossing but no authoritative result');
    }
    const started = crossings.find((crossing) => !crossing.settled);
    if (started) {
      const ioStarted = physicalIoClaimed({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        physicalDispatchId: started.physicalDispatchId,
      });
      if (ioStarted) {
        return reconcileStartedDispatch(started);
      }
    }
    if (identity) groundingForNode(node, binding);
    const persistedReservation = started
      ? loadPersistedCallAuthority({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          physicalDispatchId: started.physicalDispatchId,
        })
      : { ok: false as const, reason: 'none' };
    const authorityForReserve = persistedReservation.ok ? persistedReservation.authority : mintedAuthority;
    const physicalDispatchId = started?.physicalDispatchId
      ?? authorityForReserve?.physicalDispatchId
      ?? derivePhysicalDispatchId({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        graphId: graph.graphId,
        nodeId: node.id,
        logicalCallId: logicalToolCallId,
        ordinal: started?.ordinal ?? 1,
        relation: started?.relation ?? 'primary',
      });
    const crossing = authorityForReserve
      ? beginTypedPhysicalDispatch({
          authority: authorityForReserve,
          identity: {
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
            acceptedTaskId,
            logicalToolCallId: authorityForReserve.logicalCallId,
            physicalDispatchId: authorityForReserve.physicalDispatchId,
            ordinal: authorityForReserve.ordinal,
            ...(authorityForReserve.retryOf ? { retryOf: authorityForReserve.retryOf } : {}),
          },
          relation: authorityForReserve.relation,
          ledgerArgs: args,
          ...(hostOnly ? { executionSite: 'host' as const } : {}),
        })
      : beginPhysicalDispatch({
          identity: {
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
            acceptedTaskId,
            logicalToolCallId,
            physicalDispatchId,
            ordinal: started?.ordinal ?? 1,
          },
          tool: binding.toolName,
          args,
          ...(hostOnly ? { executionSite: 'host' as const } : {}),
        });
    if (crossing.status !== 'inserted') {
      if (crossing.status === 'replayed') {
        const existing = handles[node.id];
        if (existing) {
          const redeemed = redeemRawResult(existing, {
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
            acceptedTaskId,
            logicalToolCallId,
            physicalDispatchId: crossing.identity.physicalDispatchId,
            toolName: binding.toolName,
            args,
          });
          if (redeemed.status === 'ok') return redeemed.value;
        }
        if (physicalIoClaimed({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          physicalDispatchId: crossing.identity.physicalDispatchId,
        })) {
          return reconcileStartedDispatch({
            physicalDispatchId: crossing.identity.physicalDispatchId,
            ordinal: crossing.identity.ordinal,
            relation: crossing.identity.relation ?? 'primary',
            ...(crossing.identity.retryOf ? { retryOf: crossing.identity.retryOf } : {}),
          });
        }
        // Reservation exists but I/O never started — this inserted reservation
        // still authorizes the first invoke.
      } else {
        throw new Error(`physical dispatch refused: ${crossing.status} ${'reason' in crossing ? crossing.reason : ''}`);
      }
    }
    if (mutate && (testFault === 'after_reservation' || testFault === 'before_write')) {
      throw new Error('forced crash after reservation');
    }
    if (!hostOnly) {
      // A provider crossing with no resolved call authority has nothing binding
      // it to an account, schema, effect or argument digest. It does not get to
      // claim I/O by default.
      if (!authorityForReserve) {
        throw new Error('reconciliation_required: provider crossing has no resolved call authority');
      }
      // Ownership is the lease this activation holds now, not the one frozen
      // into a reservation that may predate a legitimate takeover.
      const liveLease = readCanonicalGraphNodeLease({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        graphId: graph.graphId,
        nodeId: node.id,
      });
      if (!liveLease || liveLease.released || liveLease.expiresAt <= Date.now()) {
        throw new Error('reconciliation_required: canonical graph/node lease is not live');
      }
      const claim = claimPhysicalIo({
        identity: {
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          physicalDispatchId: crossing.identity.physicalDispatchId,
        },
        authority: authorityForReserve,
        currentOwnerFence: encodeCanonicalOwnerFence(liveLease),
      });
      if (!claim.claimed) {
        throw new Error(`reconciliation_required: provider crossing is already owned (${claim.reason})`);
      }
    }
    countInvoke();
    let value: unknown;
    try {
      value = await binding.invoke({
        nodeId: node.id,
        role,
        payload,
        envelope,
        identity: { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedTaskId },
        binding,
        ...(mintedAuthority ? { authority: mintedAuthority } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (hostOnly) {
        throw new Error(`host_only execution failed: ${reason}`);
      }
      throw new Error(`reconciliation_required: provider outcome is unknown (${reason})`);
    }
    if (mutate && testFault === 'settlement_storage') {
      setSettlementStorageFault(true);
    }
    const settled = settlePhysicalDispatch({
      identity: crossing.identity,
      tool: mintedAuthority?.operationId ?? binding.toolName,
      outcome: 'returned',
      ...(mintedAuthority ? { authorityDigest: mintedAuthority.authorityDigest } : {}),
    });
    if (mutate && testFault === 'settlement_storage') {
      setSettlementStorageFault(false);
    }
    if (settled.status !== 'inserted' && settled.status !== 'replayed') {
      retainUncertainReconciliationMaterial({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        physicalDispatchId: crossing.identity.physicalDispatchId,
      });
      throw new Error(`settlement_failed: physical dispatch could not settle (${settled.status})`);
    }
    const handle = toResultHandle(value, {
      authority: {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId,
        logicalToolCallId,
        physicalDispatchId: crossing.identity.physicalDispatchId,
        toolName: binding.toolName,
        args,
      },
    });
    rememberArtifact(node.id, role, value, handle.rawLocation ?? undefined);
    if (mutate && testFault === 'after_provider_return') throw new Error('forced crash after provider return');
    if (mutate && testFault === 'before_receipt') throw new Error('forced crash before receipt');
    if (handle.rawLocation) {
      const payloadJson = canonicalJson(value);
      persistArtifactRecord({
        ref: handle.rawLocation,
        contentDigest: sha256(payloadJson),
        storeId: 'durable_result_handles',
        storeContract: 'durable_result_handles@1',
        byteLength: Buffer.byteLength(payloadJson, 'utf8'),
        mediaType: 'application/json',
        scopeDigest: sha256(identity.sessionId),
        producedBy: {
          admissionDigest: admissionRef.digest,
          nodeId: node.id,
          attemptId: admissionRef.attemptByNode.get(node.id) ?? crossing.identity.physicalDispatchId,
        },
        commitId: crossing.identity.physicalDispatchId,
      });
    }
    const logicalSettled = commitLogicalCallSettlement({
      identity: {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId,
        logicalToolCallId,
      },
      contract: { toolName: binding.toolName, args },
      execution: { kind: hostOnly ? 'local_execution' : 'provider_execution' },
      result: { payload: value },
      outcome: {
        kind: 'succeeded',
        evidence: 'nominal',
        providerStatus: 'ok',
        directive: {
          action: 'settle',
          retrySameCandidate: false,
          eliminatesCandidate: false,
          opensDiscoveryEpoch: false,
          requiresReconciliation: false,
        },
      },
      recovery: { businessCall: true, mutating: mutate, requirementId: node.id },
      observer: { lane: 'agents_runner', turn: identity.turn },
    });
    if (logicalSettled.status !== 'committed' && logicalSettled.status !== 'replayed') {
      throw new Error(`settlement_failed: logical call could not settle (${logicalSettled.status})`);
    }
    if (mutate && (testFault === 'after_handle' || testFault === 'after_write')) {
      throw new Error('forced crash after handle');
    }
    return value;
  };

  const runNode = async (node: Parameters<NodeRunner['run']>[0]): Promise<NodeOutcome> => {
    const graphNode = graph.nodes.find((candidate) => candidate.id === node.id);
    const role = graphNode?.capabilityRole ?? (
      'capabilityRole' in node ? String((node as { capabilityRole?: string }).capabilityRole ?? '') : ''
    );
    if (HOST_ONLY_KINDS.has(node.kind) && node.kind !== 'verify' && node.kind !== 'publish') {
      const passed = predecessorsOf(node.id).find((prior) => prior.role === 'verify');
      if (passed) rememberArtifact(node.id, 'verify', passed.value, passed.handle);
      return { status: 'completed', outputRef: passed?.handle };
    }
    // 'lookup' is the single direct read of a single_act — same dispatch
    // contract as 'source' (verify and publish already accept its artifact);
    // refusing it at the role table blocked the shape everywhere else admits.
    if (node.kind === 'retrieve' && (role === 'source' || role === 'lookup')) {
      const value = await dispatch(graphNode!, node.id, false);
      rememberArtifact(node.id, role, value, handles[node.id]);
      return { status: 'completed', outputRef: handles[node.id], evidenceRefs: [handles[node.id] ?? node.id] };
    }
    if (node.kind === 'retrieve' && (role === 'collection' || role === 'collect')) {
      const value = await dispatch(graphNode!, predecessorsOf(node.id)[0]?.value ?? node.id, false);
      rememberArtifact(node.id, role, value, handles[node.id]);
      return { status: 'completed', outputRef: handles[node.id] };
    }
    if (node.kind === 'retrieve' && role === 'readback') {
      const created = createdFrom(node.id);
      if (!created) return { status: 'blocked', reason: 'create has no exact id' };
      const value = await dispatch(graphNode!, created.id, false) as { id: string; handle: string; content?: unknown };
      if (value.id !== created.id) return { status: 'blocked', reason: 'dishonest readback id' };
      if (value.content === undefined) return { status: 'blocked', reason: 'readback content missing' };
      const intended = created.contentDigest;
      const observed = contentDigestOf(value.content);
      if (intended && observed !== intended) {
        return { status: 'blocked', reason: 'readback content digest does not match the intended written artifact' };
      }
      if (identity && acceptedTaskId) {
        const binding = boundCapabilities.get(graphNode!.id);
        if (!binding || !verifyHostSealedArtifactContentFromReadback({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          verificationLogicalToolCallId: `logical:${graphNode!.id}`,
          readToolName: binding.toolName,
          readArgs: logicalArgsFor(graphNode!, binding, created.id),
          returnedResourceId: value.id,
          readContent: value.content,
        })) {
          return { status: 'blocked', reason: 'readback did not satisfy the host-sealed content contract' };
        }
      }
      rememberArtifact(node.id, role, value, handles[node.id]);
      return { status: 'completed', outputRef: handles[node.id] };
    }
    if (node.kind === 'execute' && (role === 'transform' || role === 'extract')) {
      const incoming = recordsFrom(node.id);
      const next = await dispatch(graphNode!, incoming, false);
      const value = Array.isArray(next) ? { records: next } : next;
      rememberArtifact(node.id, role, value, handles[node.id]);
      return { status: 'completed', outputRef: handles[node.id] };
    }
    if (node.kind === 'execute' && (role === 'destination' || role === 'create')) {
      const records = recordsFrom(node.id);
      const transformPrior = predecessorsOf(node.id).find((prior) => (
        prior.role === 'transform' || prior.role === 'extract'
      ));
      if (!transformPrior?.contentDigest) {
        return { status: 'blocked', reason: 'create requires predecessor-bound transform lineage' };
      }
      const downstreamOfPriorSink = predecessorsOf(node.id).some((prior) => (
        prior.role === 'destination'
        || prior.role === 'create'
        || prior.role === 'readback'
      ));
      if (!downstreamOfPriorSink) {
        const gate = admitConstructWrite({
          graph: graph,
          observation: {
            collectedCount: new Set(records.map((record) => JSON.stringify(record))).size,
            projectionPresent: Object.keys(records[0] ?? {}),
            records,
            lineagePresent: true,
          },
        });
        if (!gate.ok) return { status: 'blocked', reason: gate.reason };
      }
      let artifactRunScopeId: string | undefined;
      if (identity && acceptedTaskId) {
        const readbackNodes = graph.edges
          .filter((edge) => edge.source === node.id)
          .map((edge) => graph.nodes.find((candidate) => candidate.id === edge.target))
          .filter((candidate): candidate is TurnGraphNode => candidate?.capabilityRole === 'readback');
        const createBinding = boundCapabilities.get(node.id);
        const readbackNode = readbackNodes.length === 1 ? readbackNodes[0] : undefined;
        const readbackBinding = readbackNode ? boundCapabilities.get(readbackNode.id) : undefined;
        const sealedCreate = loadSealedNodeBinding(identity.sessionId, identity.sourceUserSeq, node.id);
        const sealedReadback = readbackNode
          ? loadSealedNodeBinding(identity.sessionId, identity.sourceUserSeq, readbackNode.id)
          : null;
        if (
          !createBinding
          || !readbackNode
          || !readbackBinding
          || !sealedCreate
          || !sealedReadback
          || (createBinding.effect !== 'external_write' && createBinding.effect !== 'local_write')
          || readbackBinding.effect !== 'read'
        ) return { status: 'blocked', reason: 'create/readback bindings do not form one sealed write-then-read contract' };
        const intendedContentDigest = contentDigestOf(records);
        const contentContract = createHostSealedArtifactContentContract({
          acceptedTaskId,
          graphId: graph.graphId,
          graphHash: graph.compiler.graphHash,
          lineageNodeId: transformPrior.nodeId,
          createNodeId: node.id,
          readbackNodeId: readbackNode.id,
          lineageContentDigest: intendedContentDigest,
          intendedContentDigest,
          createBindingDigest: sealedCreate.bindingDigest,
          readbackBindingDigest: sealedReadback.bindingDigest,
          createEffect: createBinding.effect,
          readbackEffect: 'read',
        });
        artifactRunScopeId = resolveArtifactRunScopeId(
          identity.sessionId,
          acceptedTaskId,
          identity.sourceUserSeq,
        );
        const claim = claimArtifactSlot(identity.sessionId, {
          kind: 'resource',
          provider: 'graph',
          slotKey: `construct-destination:${node.id}`,
          createShape: 'create_new',
        }, `logical:${node.id}`, artifactRunScopeId, contentContract);
        if (!claim.acquired) {
          if (claim.artifact.resourceId && claim.artifact.uri && claim.artifact.status === 'bound') {
            const existing = handles[node.id];
            const redeemed = existing ? redeemRawResult(existing) : null;
            const reused = redeemed?.status === 'ok'
              ? redeemed.value as { id?: string; handle?: string; receipt?: string }
              : null;
            if (
              !reused
              || reused.id !== claim.artifact.resourceId
              || reused.handle !== claim.artifact.uri
              || !isIndependentReceipt(reused.receipt, reused.id, reused)
            ) {
              return { status: 'blocked', reason: 'bound artifact has no authoritative independent receipt' };
            }
            rememberArtifact(node.id, role, {
              ...reused,
              writtenDigest: intendedContentDigest,
            }, existing);
            return { status: 'completed', outputRef: handles[node.id] };
          }
          if (handles[node.id]) {
            const redeemed = redeemRawResult(handles[node.id]);
            if (redeemed.status === 'ok') {
              rememberArtifact(node.id, role, redeemed.value, handles[node.id]);
              return { status: 'completed', outputRef: handles[node.id] };
            }
          }
          if (claim.artifact.status !== 'pending') {
            return { status: 'blocked', reason: 'artifact slot claim refused; reconciliation required' };
          }
          // The dispatch seam now owns both safe pending cases: an unstarted
          // reservation may perform its first invoke, while started I/O may
          // only run the exact capability's read-only recovery probe.
        }
      }
      const value = await dispatch(graphNode!, records, true) as { id: string; handle: string; receipt?: string };
      if (!isIndependentReceipt(value.receipt, value.id, value)) {
        return { status: 'blocked', reason: 'create did not return an independent provider receipt' };
      }
      const stored = { ...value, receipt: value.receipt, writtenDigest: contentDigestOf(records) };
      rememberArtifact(node.id, role, stored, handles[node.id]);
      if (identity && acceptedTaskId) {
        bindArtifactSlot(identity.sessionId, `construct-destination:${node.id}`, {
          resourceId: value.id,
          uri: value.handle,
        }, `logical:${node.id}`, artifactRunScopeId);
        appendEvent({
          sessionId: identity.sessionId,
          turn: identity.turn,
          role: 'system',
          type: 'external_write',
          data: {
            sourceUserSeq: identity.sourceUserSeq,
            callId: `logical:${node.id}`,
            canonicalCallId: `logical:${node.id}`,
            toolName: 'write_file',
            preDispatch: false,
            resourceId: value.id,
            receipt: value.receipt,
          },
        });
      }
      return { status: 'completed', outputRef: handles[node.id] };
    }
    if (node.kind === 'verify') {
      const incoming = predecessorsOf(node.id);
      if (incoming.length === 0) return { status: 'blocked', reason: 'verify has no predecessor artifacts' };
      if (incoming.some((prior) => !artifacts.has(prior.nodeId))) {
        return { status: 'blocked', reason: 'required predecessor artifact is missing' };
      }
      const writeBound = graph.nodes.some((candidate) => (
        candidate.capabilityRole === 'destination'
        || candidate.capabilityRole === 'create'
        || candidate.effect?.kind === 'external_write'
        || candidate.effect?.kind === 'local_write'
      )) || Boolean(graph.classification.goalConstraints?.destination)
        || (graph.classification.goalConstraints?.destinations?.length ?? 0) > 0;
      if (!writeBound) {
        const retrieved = incoming.find((prior) => (
          prior.role === 'source' || prior.role === 'collection' || prior.role === 'collect' || prior.role === 'lookup'
        ));
        const records = retrieved ? asRecords(retrieved.value) : [];
        const verdict = evaluateGoalEvidence({
          graph,
          observation: {
            collectedCount: records.length,
            projectionPresent: Object.keys(records[0] ?? {}),
            records,
            sourceLocated: Boolean(retrieved),
            lineagePresent: Boolean(retrieved?.contentDigest),
            artifactHandle: retrieved?.handle,
          },
        });
        if (verdict.status !== 'done') {
          return { status: 'blocked', reason: verdict.status === 'awaiting' ? verdict.reason : verdict.reason };
        }
        rememberArtifact(node.id, 'verify', { ok: true, retrieved: retrieved?.value }, retrieved?.handle);
        return { status: 'completed' };
      }
      const createdRows = incoming
        .filter((prior) => prior.role === 'destination' || prior.role === 'create' || (prior.value as { writtenDigest?: string }).writtenDigest)
        .map((prior) => ({
          role: prior.role,
          nodeId: prior.nodeId,
          value: prior.value as { id?: string; handle?: string; receipt?: string; writtenDigest?: string },
        }))
        .filter((row) => typeof row.value.id === 'string');
      const created = createdRows[0]?.value;
      const readbacks = incoming
        .filter((prior) => prior.role === 'readback' || (prior.value as { content?: unknown }).content !== undefined)
        .map((prior) => prior.value as { id?: string; handle?: string; content?: unknown });
      const readback = readbacks[0];
      const recordSets = recordsFrom(node.id);
      const lineagePresent = incoming.some((prior) => prior.role === 'transform' || prior.role === 'extract' || prior.contentDigest);
      const intendedDigest = created && 'writtenDigest' in created
        ? String(created.writtenDigest ?? '')
        : incoming.find((prior) => prior.role === 'destination' || prior.role === 'create')?.contentDigest;
      const readbackDigest = readback?.content !== undefined ? contentDigestOf(readback.content) : undefined;
      const contentMatches = Boolean(
        readback?.content !== undefined
        && intendedDigest
        && readbackDigest === intendedDigest,
      );
      const admittedSinks = graph.classification.goalConstraints?.destinations
        ?? (graph.classification.goalConstraints?.destination
          ? [graph.classification.goalConstraints.destination]
          : []);
      const claimedCreateIds = new Set<string>();
      const sinks = (admittedSinks.length > 0 ? admittedSinks : createdRows.map((row, index) => ({
        family: `sink-${index}`,
        handleRequired: false,
      }))).map((sink, index) => {
        const written = createdRows[index]?.value
          ?? createdRows.find((row) => row.value.id && !claimedCreateIds.has(row.value.id))?.value;
        if (written?.id) claimedCreateIds.add(written.id);
        const observed = written
          ? readbacks.find((entry) => entry.id === written.id)
          : undefined;
        const intended = written?.writtenDigest;
        const observedDigest = observed?.content !== undefined ? contentDigestOf(observed.content) : undefined;
        const matched = Boolean(observed?.content !== undefined && intended && observedDigest === intended);
        return {
          family: sink.family,
          createdArtifactId: written?.id,
          createReceiptId: written?.receipt,
          readbackVerified: Boolean(written?.id) && observed?.id === written?.id && matched,
          readbackContent: matched ? observed?.content : undefined,
          artifactHandle: observed?.handle ?? written?.handle,
        };
      });
      const verdict = evaluateGoalEvidence({
        graph: graph,
        observation: {
          collectedCount: new Set(recordSets.map((record) => JSON.stringify(record))).size,
          projectionPresent: Object.keys(recordSets[0] ?? {}),
          records: recordSets,
          createdArtifactId: created?.id,
          createReceiptId: created?.receipt,
          lineagePresent,
          readbackVerified: readback?.id === created?.id && contentMatches,
          readbackContent: contentMatches ? readback?.content : undefined,
          artifactHandle: readback?.handle ?? created?.handle,
          ...(sinks.length > 0 ? { sinks } : {}),
        },
      });
      if (verdict.status !== 'done') {
        return { status: 'blocked', reason: verdict.status === 'awaiting' ? verdict.reason : verdict.reason };
      }
      const publish = admitConstructPublish({
        graph: graph,
        observation: {
          collectedCount: recordSets.length,
          projectionPresent: Object.keys(recordSets[0] ?? {}),
          records: recordSets,
          createdArtifactId: created?.id,
          createReceiptId: created?.receipt,
          lineagePresent,
          readbackVerified: true,
          readbackContent: readback?.content,
          artifactHandle: readback?.handle ?? created?.handle,
          ...(sinks.length > 0 ? { sinks } : {}),
        },
      });
      if (!publish.ok) return { status: 'blocked', reason: publish.reason };
      rememberArtifact(node.id, 'verify', { ok: true, created, readback }, undefined);
      return { status: 'completed' };
    }
    if (node.kind === 'publish') {
      const incoming = predecessorsOf(node.id);
      const verified = incoming.find((prior) => prior.role === 'verify');
      const writeBound = graph.nodes.some((candidate) => (
        candidate.capabilityRole === 'destination'
        || candidate.capabilityRole === 'create'
        || candidate.effect?.kind === 'external_write'
        || candidate.effect?.kind === 'local_write'
      )) || Boolean(graph.classification.goalConstraints?.destination)
        || (graph.classification.goalConstraints?.destinations?.length ?? 0) > 0;
      if (!writeBound) {
        const retrieved = incoming.find((prior) => (
          prior.role === 'source' || prior.role === 'collection' || prior.role === 'collect' || prior.role === 'lookup'
        ))?.value
          ?? (verified?.value as { retrieved?: unknown } | undefined)?.retrieved;
        // An internal result-handle location is durable evidence addressing,
        // never a user-facing answer: presenting it delivers raw tool protocol.
        const presentational = (candidate: string | undefined): string | undefined => (
          candidate && !candidate.startsWith('tool_output:') ? candidate : undefined
        );
        const handle = incoming.map((prior) => presentational(prior.handle)).find(Boolean)
          ?? (retrieved && typeof retrieved === 'object' && typeof (retrieved as { handle?: unknown }).handle === 'string'
            ? presentational(String((retrieved as { handle: string }).handle))
            : undefined);
        const text = handle
          ?? (typeof retrieved === 'string' ? retrieved : canonicalJson(retrieved ?? verified?.value ?? ''));
        if (testFault === 'before_publication') throw new Error('forced crash before publication');
        if (identity) {
          const committed = commitTurnOutcome({
            version: 2,
            id: turnOutcomeId({
              sessionId: identity.sessionId,
              turn: identity.turn,
              sourceUserSeq: identity.sourceUserSeq,
            }),
            identity: {
              sessionId: identity.sessionId,
              turn: identity.turn,
              sourceUserSeq: identity.sourceUserSeq,
            },
            status: 'done',
            resumable: false,
            presentation: { kind: 'answer', text },
            evidenceRefs: handle
              ? [{ kind: 'artifact', id: handle, uri: handle }]
              : [{ kind: 'source', id: contentDigestOf(retrieved ?? text) }],
          }, { terminalJudgeDisposition: 'deliver' });
          if (committed.presentation.status !== 'done') {
            const detail = String(
              committed.event.data.verificationDetail
                ?? committed.event.data.blockedReason
                ?? committed.presentation.text,
            );
            return {
              status: 'blocked',
              reason: `durable terminal is ${committed.presentation.status}: ${detail}`,
            };
          }
        }
        published = true;
        publishedHandle = text;
        rememberArtifact(node.id, 'publish', { handle: publishedHandle }, publishedHandle);
        return { status: 'completed', outputRef: publishedHandle };
      }
      const created = createdFrom(node.id)
        ?? (verified?.value as { created?: { id: string; handle: string; receipt?: string } } | undefined)?.created;
      const readback = incoming
        .map((prior) => prior.value as { handle?: string; content?: unknown; id?: string })
        .find((value) => value && value.content !== undefined)
        ?? (verified?.value as { readback?: { handle: string; id: string; content?: unknown } } | undefined)?.readback;
      if (!created || !readback) return { status: 'blocked', reason: 'publish requires create and readback' };
      if (testFault === 'before_publication') throw new Error('forced crash before publication');
      if (identity) {
        const committed = commitTurnOutcome({
          version: 2,
          id: turnOutcomeId({
            sessionId: identity.sessionId,
            turn: identity.turn,
            sourceUserSeq: identity.sourceUserSeq,
          }),
          identity: {
            sessionId: identity.sessionId,
            turn: identity.turn,
            sourceUserSeq: identity.sourceUserSeq,
          },
          status: 'done',
          resumable: false,
          presentation: { kind: 'answer', text: readback.handle ?? created.handle },
          evidenceRefs: [
            { kind: 'artifact', id: created.id, uri: readback.handle ?? created.handle },
            { kind: 'external_receipt', id: created.receipt ?? created.id },
          ],
        }, { terminalJudgeDisposition: 'deliver' });
        if (committed.presentation.status !== 'done') {
          const detail = String(
            committed.event.data.verificationDetail
              ?? committed.event.data.blockedReason
              ?? committed.presentation.text,
          );
          return {
            status: 'blocked',
            reason: `durable terminal is ${committed.presentation.status}: ${detail}`,
          };
        }
      }
      published = true;
      publishedHandle = readback.handle ?? created.handle;
      rememberArtifact(node.id, 'publish', { handle: publishedHandle }, publishedHandle);
      return { status: 'completed', outputRef: publishedHandle };
    }
    if (role) {
      return { status: 'blocked', reason: `unknown node role: ${role}` };
    }
    return { status: 'blocked', reason: `unknown node role: ${node.kind}` };
  };

  const runner: NodeRunner = {
    edgeSatisfied(edge, outcome) {
      if (edge.when === 'evidence_sufficient') return outcome.status === 'completed';
      if (edge.when === 'evidence_insufficient') return outcome.status === 'blocked';
      return undefined;
    },
    async run(node, context): Promise<NodeOutcome> {
      if (context?.attemptId) admissionRef.attemptByNode.set(node.id, context.attemptId);
      try {
        const outcome = await runNode(node);
        if (outcome.status === 'blocked') lastBlockReason = `${node.id}:${outcome.reason ?? 'blocked'}`;
        return outcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('lease unavailable') && identity) {
          const peer = await awaitPeerCanonicalOutcome(identity);
          if (peer?.artifactHandle) {
            published = true;
            publishedHandle = peer.artifactHandle;
            lastBlockReason = '';
            return { status: 'completed', outputRef: peer.artifactHandle };
          }
          lastBlockReason = `${node.id}:in_progress:${message}`;
          return { status: 'blocked', reason: lastBlockReason };
        }
        lastBlockReason = `${node.id}:${message}`;
        return { status: 'blocked', reason: lastBlockReason };
      }
    },
  };

  const executable = {
    graphId: graph.graphId,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      joinMode: node.joinMode,
      capabilityRole: node.capabilityRole,
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      when: edge.when,
    })),
  };

  const unresolved: string[] = [];
  for (const node of graph.nodes) {
    if (HOST_ONLY_KINDS.has(node.kind) && !node.capabilityRole) continue;
    if (!node.capabilityRole) continue;
    const bound = bindAdmittedNodeCapability({
      node,
      graph: graph,
      identity: identity && acceptedTaskId
        ? { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedTaskId }
        : undefined,
      acceptedText,
      catalog,
    });
    if (!bound.ok) {
      unresolved.push(`${node.id}:${bound.reason}`);
      continue;
    }
    if (expectedEffectForBinding(bound.binding) === 'unknown') {
      unresolved.push(`${node.id}:capability effect is not exact`);
      continue;
    }
    boundCapabilities.set(node.id, bound.binding);
    if (identity && acceptedTaskId) {
      const sealed = sealBoundCapability({
        nodeId: node.id,
        binding: bound.binding,
        argumentDigest: sha256(JSON.stringify({ nodeId: node.id, capabilityId: bound.binding.capabilityId })),
      });
      if (!persistSealedNodeBinding({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        binding: sealed,
      })) {
        unresolved.push(`${node.id}:sealed capability binding conflicts with the accepted source`);
      }
    }
  }
  const producedByNode = new Map<string, readonly string[]>();
  const acceptedByNode = new Map<string, readonly string[]>();
  for (const [nodeId, binding] of boundCapabilities) {
    const produced = binding.manifest?.producedOutputKinds ?? [];
    const accepted = binding.manifest?.acceptedInputKinds ?? [];
    if (produced.length === 0 || accepted.length === 0) {
      unresolved.push(`${nodeId}:missing capability kind metadata`);
      continue;
    }
    producedByNode.set(nodeId, produced);
    acceptedByNode.set(nodeId, accepted);
  }
  const executableNodeIds = new Set(
    graph.nodes.filter((node) => Boolean(node.capabilityRole)).map((node) => node.id),
  );
  unresolved.push(...validateBoundCapabilityEdges({
    edges: graph.edges,
    producedByNode,
    acceptedByNode,
    executableNodeIds,
  }));
  if (unresolved.length > 0) {
    lastBlockReason = unresolved.join('; ');
    if (identity && terminalIdentity) {
      commitTerminal({
        version: 2,
        id: turnOutcomeId(terminalIdentity),
        identity: terminalIdentity,
        status: 'blocked',
        resumable: false,
        presentation: { kind: 'blocked', text: lastBlockReason },
      });
    }
    return { status: 'blocked', providerCalls, handles, error: lastBlockReason };
  }

  if (identity && expected?.status === 'ok') {
    try {
      const authority = requireAcceptedTaskAuthority({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
      });
      if (authority.acceptedTaskId !== acceptedTaskId) {
        throw new Error('accepted task authority does not match the persisted graph');
      }
      const proposal = expectedWorkProposalFromGraph(graph, boundCapabilities);
      if (!proposal) throw new Error('typed action graph has no expected work operations');
      const frozen = freezeActionExpectedWorkContract({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        proposal,
      });
      if (frozen.status !== 'fixed' && frozen.status !== 'replayed') {
        throw new Error(`expected-work freeze ${frozen.status}: ${'reason' in frozen ? frozen.reason : 'unavailable'}`);
      }
      const activated = activateActionExpectedWork({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
      });
      if (activated.status !== 'activated' && activated.status !== 'replayed') {
        throw new Error(`expected-work activation ${activated.status}: ${'reason' in activated ? activated.reason : 'unavailable'}`);
      }
    } catch (error) {
      lastBlockReason = error instanceof Error ? error.message : String(error);
      return { status: 'blocked', providerCalls, handles, error: lastBlockReason };
    }
  }

  const sealed = sealExecutionIdentity(executable, {
    tenant: identity?.sessionId ?? 'test',
    workspace: identity?.sessionId ?? 'test',
    accountScopeDigest: sha256(identity?.sessionId ?? 'test'),
    authorityDigest: graph.compiler.policyHash,
    schemaUniverseDigest: graph.compiler.graphHash,
    effectCeiling: graph.effectCeiling === 'read' ? 'read' : 'write',
    bindingRevisionDigest: (frozenCatalog && frozenCatalog.ok ? frozenCatalog.digest : undefined)
      ?? catalogDigestOf(catalog),
    budgetVersion: 'admitted-graph-v1',
    nodes: Object.fromEntries(executable.nodes.map((node) => {
      const sealed = identity
        ? loadSealedNodeBinding(identity.sessionId, identity.sourceUserSeq, node.id)
        : null;
      return [node.id, {
        semanticDigest: sha256(node.id + node.kind + (sealed?.bindingDigest ?? '')),
        runner: { name: 'admitted-graph', version: '1', artifactDigest: sha256('admitted-graph-v1') },
        effectClass: node.kind === 'retrieve' || node.kind === 'verify'
          || node.capabilityRole === 'transform' || node.capabilityRole === 'extract'
          ? 'read' as const
          : 'write' as const,
      }];
    })),
  });
  const admission = admitGraph({
    graph: executable,
    compilerVersion: graph.compiler.version,
    policyHash: graph.compiler.policyHash,
    catalogHash: graph.compiler.graphHash,
    // STRUCTURAL bounds replace step budgets on the typed lane (plan: The
    // 3-Minute Graph). Concurrency 8 lets sibling read waves overlap (the
    // executor Promise.alls each wave; write ordering stays DAG-enforced);
    // the wall clock is a five-minute structural ceiling, not a step fight.
    budget: { maxNodes: 64, maxWaves: 16, maxConcurrency: 8, maxElapsedMs: 300_000, maxExpansions: 0 },
    ...(sealed.ok
      ? { identity: sealed.identity, mode: identity ? 'production' as const : 'semantic' as const }
      : { mode: 'structural_test_only' as const }),
  });
  if (admission.ok) admissionRef.digest = admission.admission.admissionDigest;
  if (!admission.ok) {
    lastBlockReason = admission.errors.join('; ');
    if (identity && terminalIdentity) {
      commitTerminal({
        version: 2,
        id: turnOutcomeId(terminalIdentity),
        identity: terminalIdentity,
        status: 'failed',
        resumable: false,
        presentation: { kind: 'error', text: lastBlockReason },
      });
    }
    return { status: 'failed', providerCalls, handles, error: lastBlockReason };
  }
  const journal = identity
    ? durableJournal(identity)
    : (() => {
        const entries: GraphJournalEntry[] = [];
        return {
          entries,
          adapter: {
            appendSync(entry: GraphJournalEntry) { entries.push(entry); },
            async append(entry: GraphJournalEntry) { entries.push(entry); },
          },
        };
      })();
  // Names its host and pid so a successor can prove this activation is gone
  // instead of waiting out a dead owner's lease TTL.
  const activationOwner = mintActivationOwner();
  const activationId = `construct-${activationOwner}`;
  if (!journal.entries.some((entry) => entry.type === 'run_header')) {
    await journal.adapter.append({
      type: 'run_header',
      admissionDigest: admission.admission.admissionDigest,
      journalSchemaVersion: GRAPH_JOURNAL_SCHEMA_VERSION,
      activationId,
    } as GraphJournalEntry);
  }
  const leaseKeyOf = (nodeId: string): string => canonicalGraphNodeLeaseKey({
    sessionId: identity?.sessionId ?? 'test',
    sourceUserSeq: identity?.sourceUserSeq ?? 0,
    graphId: graph.graphId,
    nodeId,
  });
  const leaseManager = createLeaseManager({
    owner: activationOwner,
    store: sqliteLeaseStore(),
    clock: () => Date.now(),
    // TTL must outlive a single node's longest crossing (never the whole
    // run — leases renew per node). 90s covers slow provider writes.
    ttlMs: Number(process.env.CLEMENTINE_GRAPH_LEASE_TTL_MS ?? 90_000),
  });
  const artifactPort: ArtifactStorePort = {
    async record(ref) { return loadArtifactRecord(ref); },
    async stat(ref) {
      const record = loadArtifactRecord(ref);
      if (!record) return undefined;
      return { contentDigest: record.contentDigest, byteLength: record.byteLength, storeId: record.storeId };
    },
  };
  const journalAdapter = withNodeLeases(journal.adapter, leaseManager, leaseKeyOf);
  let result: Awaited<ReturnType<typeof runGraph>>;
  try {
    result = await runGraph(executable, {
      runner,
      admission: admission.admission,
      clock: () => Date.now(),
      resumeEntries: journal.entries,
      attemptIds: nextAttemptIdFromHistory(journal.entries),
      journalAdapter,
      reuseVerifier: reuseVerifierFor(artifactPort, admission.admission),
    });
  } finally {
    await journalAdapter.releaseAll();
  }
  const publishId = graph.nodes.find((node) => node.kind === 'publish')?.id ?? '';
  const verifyIds = graph.nodes.filter((node) => node.kind === 'verify').map((node) => node.id);
  const allVerifiesJoined = verifyIds.every((id) => result.completed.includes(id) || result.blocked.includes(id));
  if (verifyIds.length > 1 && !allVerifiesJoined && result.status === 'completed') {
    lastBlockReason = 'not every verify sink joined';
  }
  const error = lastBlockReason
    || (result.blocked.length > 0 ? `blocked:${result.blocked.join(',')}` : undefined)
    || (result.failed.length > 0 ? `failed:${result.failed.join(',')}` : undefined)
    || result.haltReason
    || result.stalledDetail;
  const created = [...artifacts.values()]
    .map((artifact) => artifact.value as { id?: string; handle?: string })
    .find((value) => value && typeof value.id === 'string' && typeof value.handle === 'string');
  const success = published && Boolean(publishedHandle)
    && (result.completed.includes(publishId) || Boolean(publishedHandle));
  const uncertain = /reconcil|settlement_failed|storage_error/i.test(error ?? lastBlockReason ?? '');
  const leaseRejoin = (error ?? lastBlockReason).includes('lease unavailable')
    || (error ?? lastBlockReason).includes('in_progress:');
  const writeFreeIncomplete = !published
    && providerCalls.create === 0
    && !uncertain
    && (testFault !== null || (error ?? '').includes('forced crash'));
  if (identity && terminalIdentity && !published && !leaseRejoin && !writeFreeIncomplete) {
    const awaiting = error?.includes('needs_input') || result.paused.length > 0;
    try {
      commitTerminal(
        awaiting
          ? {
              version: 2,
              id: turnOutcomeId(terminalIdentity),
              identity: terminalIdentity,
              status: 'needs_input',
              resumable: true,
              needs: { kind: 'continue' },
              presentation: { kind: 'continue', text: error ?? 'awaiting input' },
            }
          : uncertain
            ? {
                version: 2,
                id: turnOutcomeId(terminalIdentity),
                identity: terminalIdentity,
                status: 'uncertain',
                resumable: true,
                presentation: {
                  kind: 'blocked',
                  text: isHostAuthorityHeldReason(error ?? '')
                    ? heldExecutionTextForInternalReason(error ?? 'reconciliation required', 'uncertain')
                    : (error ?? 'reconciliation required'),
                },
              }
          : result.failed.length > 0
            ? {
                version: 2,
                id: turnOutcomeId(terminalIdentity),
                identity: terminalIdentity,
                status: 'failed',
                resumable: false,
                presentation: { kind: 'error', text: error ?? 'graph failed' },
              }
            : {
                version: 2,
                id: turnOutcomeId(terminalIdentity),
                identity: terminalIdentity,
                status: 'blocked',
                resumable: false,
                presentation: {
                  kind: 'blocked',
                  text: isHostAuthorityHeldReason(error ?? '')
                    ? heldExecutionTextForInternalReason(error ?? 'graph blocked', 'blocked')
                    : (error ?? 'graph blocked'),
                },
              },
      );
    } catch (caught) {
      commitError = caught instanceof Error ? caught.message : String(caught);
    }
  }
  return {
    status: success
      ? 'success'
      : uncertain
        ? 'uncertain'
        : writeFreeIncomplete || leaseRejoin
          ? 'failed'
          : result.failed.length > 0 && !result.blocked.length ? 'failed' : 'blocked',
    providerCalls,
    artifactHandle: success ? publishedHandle : undefined,
    createdId: created?.id,
    handles,
    published: success,
    ...(!success || commitError
      ? { error: commitError ?? error ?? `graph status ${result.status}` }
      : {}),
  };
}
