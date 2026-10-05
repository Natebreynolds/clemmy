/**
 * Exact host evidence for acknowledgement-only durable-memory actions.
 *
 * The model, lane adapter, and memory_signals_captured telemetry are not
 * authority. The host independently replays deterministic admission against
 * the accepted user source and then proves the exact episode + auto-capture
 * candidate rows before binding one content-addressed receipt to the accepted
 * task graph.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  autoCaptureProvenanceFromAcceptedEvent,
  automaticMemoryOriginsForCapture,
  selectAutoMemoryCandidates,
  isEligibleAutoCaptureSourceProvenance,
} from '../../memory/auto-capture.js';
import { openMemoryDb } from '../../memory/db.js';
import {
  automaticMemoryCandidateIdentity, automaticMemoryDecisionDigest, automaticMemoryEnvelopeDigest,
  parseAutomaticMemoryEnvelope, resolveAutomaticMemoryDestination, type AutomaticMemoryEnvelope,
} from '../../memory/memory-destination.js';
import type { MemoryScope } from '../../memory/memory-scope.js';
import {
  insertInternalEventInTransaction,
  openEventLog,
  publishCommittedInternalEvent,
  type EventRow,
} from './eventlog.js';
import { durableMemoryReceiptAllowsConversationOnly } from './durable-memory-receipt.js';
import { expectedTaskFor } from './resolution-ledger.js';

export const DURABLE_MEMORY_INTAKE_RECEIPT_PROTOCOL = 2 as const;

interface MemoryEpisodeEvidenceRow {
  id: string;
  kind: string;
  source_app: string | null;
  session_id: string | null;
  call_id: string | null;
  source_uri: string | null;
  content_hash: string;
  evidence_excerpt: string | null;
  status: string;
  subtype: string | null;
  metadata_json: string;
}

interface MemoryCandidateEvidenceRow {
  id: number;
  episode_id: string | null;
  session_id: string;
  call_id: string;
  candidate_hash: string;
  kind: string;
  text: string;
  importance: number;
  status: string;
  source_type: string | null;
  intake_reason: string | null;
  trust_level: number | null;
  authority: string | null;
  source_uri: string | null;
  pin: number;
  destination_json: string | null;
  resulting_fact_id: number | null;
  reason: string | null;
}

interface HostReceiptRow {
  receipt_id: string;
  protocol_version: number;
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  source_event_id: string;
  source_message_digest: string;
  episode_id: string;
  call_id: string;
  episode_content_hash: string;
  candidate_count: number;
  candidate_digest: string;
  evidence_digest: string;
  receipt_json: string;
  receipt_event_id: string;
  issued_at: string;
}

interface HostAuthorityRow {
  accepted_task_id: string;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  state: 'armed' | 'manifested_verifying' | 'terminal' | 'conflict';
  manifest_id: string | null;
  expected_work_required: number;
  work_contract_id: string | null;
  host_completion_receipt_id: string | null;
  host_completion_event_id: string | null;
  backstop_event_id: string | null;
  revision: number;
}

export interface DurableMemoryIntakeReceiptV1 {
  protocol: 1;
  kind: 'durable_memory_intake';
  identity: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
  };
  graph: {
    graphEventId: string;
    graphId: string;
    graphHash: string;
  };
  source: {
    eventId: string;
    eventIdentity: string;
    messageDigest: string;
  };
  memory: {
    episodeId: string;
    callId: string;
    episodeContentHash: string;
    sourceUri: string;
  };
  candidates: Array<{
    id: number;
    hash: string;
    kind: string;
    textDigest: string;
    intakeReason: string;
    pinned: boolean;
  }>;
  candidateDigest: string;
  evidenceDigest: string;
}

/** V1 recorded intake only. V2 is a bounded source/destination/storage proof,
 * not a claim that every semantic requirement of a memory task was fulfilled. */
export interface DurableMemoryIntakeReceiptV2 extends Omit<DurableMemoryIntakeReceiptV1, 'protocol' | 'candidates'> {
  protocol: typeof DURABLE_MEMORY_INTAKE_RECEIPT_PROTOCOL;
  candidates: Array<DurableMemoryIntakeReceiptV1['candidates'][number] & {
    destination: {
      envelope: AutomaticMemoryEnvelope;
      envelopeDigest: string;
      decisionDigest: string;
      scope: MemoryScope;
      claimTextDigest: string;
    };
    fact: {
      id: number;
      active: true;
      contentDigest: string;
      updatedAt: string;
      scope: MemoryScope;
      evidence: Array<{ ordinal: number; excerptDigest: string; createdAt: string }>;
    };
  }>;
}

export type IssueDurableMemoryIntakeReceiptResult =
  | {
      status: 'issued' | 'replayed';
      receiptId: string;
      receiptEventId: string;
      receipt: DurableMemoryIntakeReceiptV2;
    }
  | {
      status: 'ineligible' | 'missing' | 'conflict' | 'storage_error';
      reason: string;
    };

export type RedeemDurableMemoryIntakeReceiptResult =
  | {
      status: 'redeemed';
      receiptId: string;
      receiptEventId: string;
      receipt: DurableMemoryIntakeReceiptV2;
    }
  | {
      status: 'missing' | 'ineligible' | 'conflict' | 'storage_error';
      reason: string;
    };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (!record(value)) throw new Error('durable memory receipt contains non-canonical JSON');
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedReason(value: unknown): string {
  return String(value instanceof Error ? value.message : value).replace(/\s+/g, ' ').slice(0, 300);
}

function normalizeMessage(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function acceptedSourceText(data: Record<string, unknown>): string {
  for (const candidate of [data.displayText, data.text, data.message]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
}

function readAuthority(
  sessionId: string,
  sourceUserSeq: number,
): HostAuthorityRow | undefined {
  return openEventLog().prepare(`
    SELECT accepted_task_id, graph_event_id, graph_id, graph_hash, state,
           manifest_id, expected_work_required, work_contract_id,
           host_completion_receipt_id, host_completion_event_id,
           backstop_event_id, revision
      FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as HostAuthorityRow | undefined;
}

function readReceiptRow(sessionId: string, sourceUserSeq: number): HostReceiptRow | undefined {
  return openEventLog().prepare(`
    SELECT * FROM durable_memory_intake_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as HostReceiptRow | undefined;
}

type DerivedEvidence = {
  receipt: DurableMemoryIntakeReceiptV2;
  receiptId: string;
  receiptJson: string;
  sourceTurn: number;
};

type DeriveResult =
  | { status: 'ok'; evidence: DerivedEvidence }
  | { status: 'missing' | 'ineligible' | 'conflict' | 'storage_error'; reason: string };

interface VerifiedIntake {
  source: { id: string; turn: number };
  message: string;
  captureMessage: string;
  callId: string;
  sourceUri: string;
  episode: MemoryEpisodeEvidenceRow;
  candidates: ReturnType<typeof selectAutoMemoryCandidates>;
  rows: Array<MemoryCandidateEvidenceRow & { envelope: AutomaticMemoryEnvelope }>;
}

type IntakeResult = { status: 'ok'; intake: VerifiedIntake }
  | { status: 'missing' | 'ineligible' | 'conflict' | 'storage_error'; reason: string };

/** Re-derive the frozen queue identities from the actual owner event and its
 * retained context. Candidate hashes alone are not authorization. */
function readVerifiedIntake(input: { sessionId: string; sourceUserSeq: number }, graphInputHash?: string, completionOnly = false): IntakeResult {
  if (!input.sessionId || !Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) {
    return { status: 'conflict', reason: 'accepted source identity is invalid' };
  }
  try {
    const source = openEventLog().prepare(`SELECT id, session_id, seq, turn, role, type, data_json
      FROM events WHERE session_id = ? AND seq = ?`).get(input.sessionId, input.sourceUserSeq) as {
        id: string; session_id: string; seq: number; turn: number; role: string; type: string; data_json: string;
      } | undefined;
    if (!source) return { status: 'missing', reason: 'accepted user source is missing' };
    const data: unknown = JSON.parse(source.data_json);
    if (!record(data)) return { status: 'conflict', reason: 'accepted user source is malformed' };
    const sourceEventId = `user-source:${input.sourceUserSeq}`;
    const provenance = autoCaptureProvenanceFromAcceptedEvent({ sessionId: source.session_id,
      id: source.id, seq: source.seq, role: source.role, type: source.type, data });
    if (source.type !== 'user_input_received' || !isEligibleAutoCaptureSourceProvenance(provenance, { sessionId: input.sessionId, sourceEventId })) {
      return { status: 'ineligible', reason: 'accepted source is not genuine user memory authority' };
    }
    const message = acceptedSourceText(data);
    if (!message) return { status: 'conflict', reason: 'accepted user source has no display text' };
    const normalizedMessage = normalizeMessage(message);
    const callId = `auto-capture:${sourceEventId}`;
    const sourceUri = `conversation://${encodeURIComponent(input.sessionId)}/${encodeURIComponent(callId)}`;
    const fullSourceIsGraphInput = !graphInputHash || digest(message.trim()) === graphInputHash;
    // Negative classification must precede storage lookup: ordinary work does
    // not need an automatic-memory episode. The nonempty source identity only
    // supplies this pure predicate's structural argument; a true result grants
    // no authority and still requires every episode/candidate/fact check below.
    // A narrowed graph input cannot borrow this full-source classification.
    if (completionOnly && fullSourceIsGraphInput) {
      const sourceCandidates = selectAutoMemoryCandidates(normalizedMessage, 3);
      if (!durableMemoryReceiptAllowsConversationOnly({ message: normalizedMessage, candidates: sourceCandidates,
        queuedCandidateCount: sourceCandidates.length, episodeId: callId })) {
        return { status: 'ineligible', reason: 'accepted source is not an acknowledgement-only durable-memory action' };
      }
    }
    const db = openMemoryDb();
    const episodes = db.prepare('SELECT * FROM memory_episodes WHERE session_id = ? AND call_id = ?')
      .all(input.sessionId, callId) as MemoryEpisodeEvidenceRow[];
    if (episodes.length !== 1) return { status: episodes.length ? 'conflict' : 'missing', reason: `exact auto-capture episode count is ${episodes.length}` };
    const episode = episodes[0]!;
    // A graph-bound fresh clause can narrow extraction, never the owner bytes
    // used to interpret its destination. Raw source text remains in each origin.
    const excerpt = normalizeMessage(episode.evidence_excerpt ?? '');
    const captureMessage = fullSourceIsGraphInput ? normalizedMessage
      : excerpt && normalizedMessage.includes(excerpt) && digest(excerpt) === graphInputHash ? excerpt : '';
    if (!captureMessage) return { status: 'conflict', reason: 'auto-capture episode is not bound to the accepted graph semantic input' };
    // recordMemoryEpisode normalizes and retains only its prescribed 2,000
    // character excerpt. Full source/claim authority remains in the origin;
    // an unavailable long narrowed clause cannot be recovered from this prefix.
    const expectedExcerpt = captureMessage.slice(0, 2000);
    const candidates = selectAutoMemoryCandidates(captureMessage, 3);
    if (!candidates.length) return { status: 'ineligible', reason: 'accepted input produced no durable memory candidates' };
    if (episode.kind !== 'user_turn' || episode.source_app !== 'Conversation'
      || episode.session_id !== input.sessionId || episode.call_id !== callId
      || episode.source_uri !== sourceUri || episode.subtype !== 'auto_capture' || episode.status !== 'available'
      || episode.evidence_excerpt !== expectedExcerpt || episode.content_hash !== digest(expectedExcerpt)
      || !isDeepStrictEqual(JSON.parse(episode.metadata_json), { candidateCount: candidates.length, sourceEventId })) {
      return { status: 'conflict', reason: 'auto-capture episode does not exactly match the accepted source' };
    }
    // Ineligible means another task shape may use ordinary verification. An
    // admitted acknowledgement-only memory instruction with missing storage
    // proof instead remains a verification gap, never that fallback door.
    if (completionOnly && !durableMemoryReceiptAllowsConversationOnly({ message: captureMessage, candidates,
      queuedCandidateCount: candidates.length, episodeId: episode.id })) {
      return { status: 'ineligible', reason: 'accepted source is not an acknowledgement-only durable-memory action' };
    }
    const origins = automaticMemoryOriginsForCapture({ message: captureMessage, sessionId: input.sessionId,
      sourceEventId, sourceProvenance: provenance }, candidates);
    if (origins.some(origin => !origin || !origin.source.context
      || origin.source.context.sessionId !== input.sessionId || origin.source.context.sourceUserSeq !== input.sourceUserSeq)) {
      return { status: 'missing', reason: 'automatic intake lacks exact retained accepted-source context' };
    }
    const expected = new Map(origins.map((origin, index) => [automaticMemoryCandidateIdentity(origin!), { origin: origin!, candidate: candidates[index]! }]));
    if (expected.size !== candidates.length) return { status: 'conflict', reason: 'automatic intake has ambiguous claim identity' };
    const rows = db.prepare('SELECT * FROM memory_reflection_candidates WHERE session_id = ? AND call_id = ? ORDER BY id')
      .all(input.sessionId, callId) as MemoryCandidateEvidenceRow[];
    if (rows.length !== candidates.length) return { status: rows.length ? 'conflict' : 'missing',
      reason: `exact auto-capture candidate count is ${rows.length}, expected ${candidates.length}` };
    const verified: VerifiedIntake['rows'] = [];
    for (const row of rows) {
      const admission = expected.get(row.candidate_hash);
      if (!admission || row.destination_json === null) return { status: 'missing', reason: 'legacy or unbound candidate is not fresh completion evidence' };
      const envelope = parseAutomaticMemoryEnvelope(row.destination_json);
      const candidate = admission.candidate;
      if (!isDeepStrictEqual(envelope.origin, admission.origin)
        || row.candidate_hash !== automaticMemoryCandidateIdentity(envelope.origin)
        || row.episode_id !== episode.id || row.session_id !== input.sessionId || row.call_id !== callId
        || row.kind !== candidate.kind || row.text !== candidate.content.trim() || row.importance !== 5
        || !['pending', 'promoted', 'rejected', 'expired'].includes(row.status)
        || row.source_type !== 'auto_capture' || row.intake_reason !== candidate.reason
        || row.trust_level !== 1 || row.authority !== 'user' || row.source_uri !== sourceUri
        || row.pin !== (candidate.pin ? 1 : 0)) return { status: 'conflict', reason: 'an automatic candidate differs from its frozen accepted origin' };
      verified.push({ ...row, envelope });
      expected.delete(row.candidate_hash);
    }
    return { status: 'ok', intake: { source, message, captureMessage, callId, sourceUri, episode, candidates, rows: verified } };
  } catch (error) { return { status: 'storage_error', reason: boundedReason(error) }; }
}

function canonicalResult(intake: VerifiedIntake, row: VerifiedIntake['rows'][number]) {
  const db = openMemoryDb();
  const destination = resolveAutomaticMemoryDestination(row.envelope);
  const fact = Number.isSafeInteger(row.resulting_fact_id) && Number(row.resulting_fact_id) > 0
    ? db.prepare('SELECT id, content, active, updated_at FROM consolidated_facts WHERE id = ?').get(row.resulting_fact_id) as
      { id: number; content: string; active: number; updated_at: string } | undefined : undefined;
  const links = fact ? db.prepare(`SELECT ordinal, excerpt, created_at FROM fact_evidence
    WHERE fact_id = ? AND episode_id = ? AND source_uri = ? ORDER BY ordinal`)
    .all(fact.id, intake.episode.id, intake.sourceUri) as Array<{ ordinal: number; excerpt: string; created_at: string }> : [];
  // Everywhere is represented by no scope row. Read the actual store directly;
  // neither today's session metadata nor a scope-cache fallback is evidence.
  const hasScopes = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_scopes'").get());
  if (fact && !hasScopes) throw new Error('canonical memory scope store is unavailable');
  const scopeRow = fact ? db.prepare("SELECT scope_project_id, scope_agent_key FROM memory_scopes WHERE target_kind = 'fact' AND target_id = ?")
    .get(String(fact.id)) as { scope_project_id: string | null; scope_agent_key: string | null } | undefined : undefined;
  const scope: MemoryScope = { projectId: scopeRow?.scope_project_id ?? null, agentKey: scopeRow?.scope_agent_key ?? null };
  const complete = Boolean(fact && fact.content.length <= 12000);
  const scopeMatches = destination.status === 'resolved' && isDeepStrictEqual(scope, destination.scope);
  const verified = row.status === 'promoted' && destination.status === 'resolved'
    && fact?.active === 1 && links.length > 0 && complete && scopeMatches;
  return { destination, fact, links, scope, complete, scopeMatches, verified };
}

/** Re-read both stores; pending intake never occupies the host completion slot. */
function deriveExactEvidence(input: { sessionId: string; sourceUserSeq: number }): DeriveResult {
  try {
    return openMemoryDb().transaction((): DeriveResult => {
      const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
      if (expected.status !== 'ok') return { status: expected.status === 'missing' ? 'missing' : 'conflict', reason: expected.reason };
      if (expected.graph.classification.route !== 'act') return { status: 'ineligible', reason: 'accepted graph is not an action turn' };
      const graphInputHash = expected.graph.source?.inputHash;
      if (!graphInputHash || !/^[a-f0-9]{64}$/.test(graphInputHash)) return { status: 'conflict', reason: 'accepted graph lacks its exact input digest' };
      const loaded = readVerifiedIntake(input, graphInputHash, true);
      if (loaded.status !== 'ok') return loaded;
      const intake = loaded.intake;
      if (!durableMemoryReceiptAllowsConversationOnly({ message: intake.captureMessage, candidates: intake.candidates,
        queuedCandidateCount: intake.rows.length, episodeId: intake.episode.id })) {
        return { status: 'ineligible', reason: 'accepted source is not an acknowledgement-only durable-memory action' };
      }
      const normalizedRows: DurableMemoryIntakeReceiptV2['candidates'] = [];
      for (const row of intake.rows) {
        const result = canonicalResult(intake, row);
        const decisionDigest = automaticMemoryDecisionDigest(row.envelope);
        if (!result.verified || !result.fact || result.destination.status !== 'resolved' || !decisionDigest) {
          return { status: 'missing', reason: 'automatic consolidation is pending, unresolved, inactive, unlinked or outside its exact destination' };
        }
        normalizedRows.push({ id: row.id, hash: row.candidate_hash, kind: row.kind, textDigest: digest(row.text),
          intakeReason: row.intake_reason!, pinned: row.pin === 1,
          destination: { envelope: row.envelope, envelopeDigest: automaticMemoryEnvelopeDigest(row.envelope),
            decisionDigest, scope: result.destination.scope, claimTextDigest: digest(result.destination.claimText) },
          fact: { id: result.fact.id, active: true, contentDigest: digest(result.fact.content), updatedAt: result.fact.updated_at,
            scope: result.scope, evidence: result.links.map(link => ({ ordinal: link.ordinal, excerptDigest: digest(link.excerpt), createdAt: link.created_at })) },
        });
      }
      normalizedRows.sort((left, right) => left.hash.localeCompare(right.hash) || left.id - right.id);
      const candidateDigest = digest(canonicalize(normalizedRows));
      const sourceMessageDigest = digest(intake.message);
      const evidenceDigest = digest(canonicalize({ sourceEventId: intake.source.id, sourceMessageDigest,
        episodeId: intake.episode.id, callId: intake.callId, episodeContentHash: intake.episode.content_hash, candidateDigest }));
      const receipt: DurableMemoryIntakeReceiptV2 = { protocol: DURABLE_MEMORY_INTAKE_RECEIPT_PROTOCOL, kind: 'durable_memory_intake',
        identity: { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, acceptedTaskId: expected.expectation.acceptedTaskId },
        graph: { graphEventId: expected.expectation.graphEventId, graphId: expected.expectation.graphId, graphHash: expected.expectation.graphHash },
        source: { eventId: intake.source.id, eventIdentity: `user-source:${input.sourceUserSeq}`, messageDigest: sourceMessageDigest },
        memory: { episodeId: intake.episode.id, callId: intake.callId, episodeContentHash: intake.episode.content_hash, sourceUri: intake.sourceUri },
        candidates: normalizedRows, candidateDigest, evidenceDigest };
      const receiptJson = canonicalize(receipt);
      return { status: 'ok', evidence: { receipt, receiptJson, receiptId: `memory-intake:v2:${digest(receiptJson)}`, sourceTurn: intake.source.turn } };
    })();
  } catch (error) { return { status: 'storage_error', reason: boundedReason(error) }; }
}

/** The reason the automatic layer gives a statement nobody has judged yet:
 *  it was volunteered for background review, not stated as something to keep. */
export const VOLUNTEERED_FOR_REVIEW_REASON = 'owner statement — model decides durability';

/** Whether this source's verified intake holds a claim the owner stated as
 *  something to keep (a remember request, a correction, a preference or a
 *  standing instruction), rather than only statements volunteered for review. */
export function verifiedIntakeHasOwnerStatedMemory(input: { sessionId: string; sourceUserSeq: number }): boolean {
  try {
    const loaded = readVerifiedIntake(input);
    return loaded.status === 'ok'
      && loaded.intake.rows.some(row => row.intake_reason !== null && row.intake_reason !== VOLUNTEERED_FOR_REVIEW_REASON);
  } catch { return false; }
}

export function verifiedMemoryIntakeContext(input: { sessionId: string; sourceUserSeq: number }): string | null {
  const loaded = readVerifiedIntake(input);
  if (loaded.status !== 'ok' || loaded.intake.rows.some(row => !['pending', 'promoted'].includes(row.status))) return null;
  // The notice stops a duplicate save of what the owner stated to keep. A
  // statement volunteered for background review was not, so an ordinary
  // question carries no memory notice.
  if (!loaded.intake.rows.some(row => row.intake_reason !== null && row.intake_reason !== VOLUNTEERED_FOR_REVIEW_REASON)) return null;
  return '[Verified memory intake] The automatic layer has durably queued these exact accepted claims and their original context. Do not duplicate those claims through memory_remember solely to save them again while consolidation is pending. Destination or canonical-fact qualification may still be unresolved; this intake is not saved-memory or completion proof. Report pending work accurately and continue any separate requested work.';
}

/** Current storage evidence only: exact source, reviewed destination, active
 * fact and evidence link. Semantic completeness remains a separate review. */
export function verifiedMemoryConsolidationEvidence(input: { sessionId: string; sourceUserSeq: number }) {
  try {
    return openMemoryDb().transaction(() => {
      const loaded = readVerifiedIntake(input);
      if (loaded.status !== 'ok') return null;
      return loaded.intake.rows.map(row => {
        const result = canonicalResult(loaded.intake, row);
        return { candidateId: row.id, candidate: row.text, status: row.status, disposition: row.reason ?? null,
          verified: result.verified, sourceLinked: result.links.length > 0,
          destinationStatus: result.destination.status, scopeMatches: result.scopeMatches,
          originDigest: row.envelope.originDigest, decisionDigest: automaticMemoryDecisionDigest(row.envelope),
          fact: result.fact ? { id: result.fact.id, active: result.fact.active === 1, content: result.fact.content.slice(0, 12000),
            contentComplete: result.complete, contentDigest: digest(result.fact.content), updatedAt: result.fact.updated_at, scope: result.scope } : null };
      });
    })();
  } catch { return null; }
}

function exactReceiptRow(
  row: HostReceiptRow,
  evidence: DerivedEvidence,
): boolean {
  const receipt = evidence.receipt;
  return row.receipt_id === evidence.receiptId
    && row.protocol_version === DURABLE_MEMORY_INTAKE_RECEIPT_PROTOCOL
    && row.session_id === receipt.identity.sessionId
    && row.source_user_seq === receipt.identity.sourceUserSeq
    && row.accepted_task_id === receipt.identity.acceptedTaskId
    && row.graph_event_id === receipt.graph.graphEventId
    && row.graph_id === receipt.graph.graphId
    && row.graph_hash === receipt.graph.graphHash
    && row.source_event_id === receipt.source.eventId
    && row.source_message_digest === receipt.source.messageDigest
    && row.episode_id === receipt.memory.episodeId
    && row.call_id === receipt.memory.callId
    && row.episode_content_hash === receipt.memory.episodeContentHash
    && row.candidate_count === receipt.candidates.length
    && row.candidate_digest === receipt.candidateDigest
    && row.evidence_digest === receipt.evidenceDigest
    && row.receipt_json === evidence.receiptJson;
}

/** Keep the issued proof immutable while tolerating additive corroboration.
 * Updated timestamps are not fact identity. Every original source-link ordinal
 * and excerpt must still exist, and all content/scope/origin/decision fields
 * remain exact. A later unrelated fact cannot redeem the original receipt. */
function compatibleReceiptEvidence(row: HostReceiptRow, current: DerivedEvidence): DerivedEvidence | null {
  try {
    if (row.protocol_version !== DURABLE_MEMORY_INTAKE_RECEIPT_PROTOCOL) return null;
    const old: unknown = JSON.parse(row.receipt_json);
    if (!record(old) || !Array.isArray(old.candidates) || old.candidates.length !== current.receipt.candidates.length) return null;
    const candidates: DurableMemoryIntakeReceiptV2['candidates'] = [];
    for (const [index, candidate] of current.receipt.candidates.entries()) {
      const previous: unknown = old.candidates[index];
      if (!record(previous) || !record(previous.fact) || typeof previous.fact.updatedAt !== 'string'
        || !previous.fact.updatedAt || !Array.isArray(previous.fact.evidence) || !previous.fact.evidence.length) return null;
      const links: DurableMemoryIntakeReceiptV2['candidates'][number]['fact']['evidence'] = [];
      for (const link of previous.fact.evidence) {
        if (!record(link) || !Number.isSafeInteger(link.ordinal) || typeof link.excerptDigest !== 'string'
          || typeof link.createdAt !== 'string' || !link.createdAt
          || !candidate.fact.evidence.some(now => now.ordinal === link.ordinal && now.excerptDigest === link.excerptDigest)) return null;
        links.push({ ordinal: Number(link.ordinal), excerptDigest: link.excerptDigest, createdAt: link.createdAt });
      }
      candidates.push({ ...candidate, fact: { ...candidate.fact, updatedAt: previous.fact.updatedAt, evidence: links } });
    }
    const candidateDigest = digest(canonicalize(candidates));
    const receipt = { ...current.receipt, candidates, candidateDigest, evidenceDigest: digest(canonicalize({
      sourceEventId: current.receipt.source.eventId, sourceMessageDigest: current.receipt.source.messageDigest,
      episodeId: current.receipt.memory.episodeId, callId: current.receipt.memory.callId,
      episodeContentHash: current.receipt.memory.episodeContentHash, candidateDigest })) };
    const receiptJson = canonicalize(receipt);
    const evidence = { receipt, receiptJson, receiptId: `memory-intake:v2:${digest(receiptJson)}`, sourceTurn: current.sourceTurn };
    return exactReceiptRow(row, evidence) ? evidence : null;
  } catch { return null; }
}

function exactReceiptEvent(
  row: HostReceiptRow,
  evidence: DerivedEvidence,
): boolean {
  const events = openEventLog().prepare(`
    SELECT * FROM events
     WHERE session_id = ? AND type = 'durable_memory_intake_receipt'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
     ORDER BY seq
  `).all(row.session_id, row.source_user_seq) as Array<{
    id: string;
    session_id: string;
    seq: number;
    turn: number;
    role: EventRow['role'];
    type: EventRow['type'];
    parent_event_id: string | null;
    data_json: string;
    created_at: string;
  }>;
  if (events.length !== 1 || events[0]!.id !== row.receipt_event_id) return false;
  let data: unknown;
  try { data = JSON.parse(events[0]!.data_json); } catch { return false; }
  return record(data)
    && data.receiptId === evidence.receiptId
    && data.sourceUserSeq === evidence.receipt.identity.sourceUserSeq
    && data.acceptedTaskId === evidence.receipt.identity.acceptedTaskId
    && isDeepStrictEqual(data.receipt, evidence.receipt);
}

/** Once normalized authority exists, loss of its evidence is a conflict.
 * It cannot re-enter the ordinary non-memory completion fallback. */
function boundReceiptFailure(input: { sessionId: string; sourceUserSeq: number },
  failure: Exclude<DeriveResult, { status: 'ok' }>): Exclude<DeriveResult, { status: 'ok' }> {
  if (failure.status === 'storage_error' || failure.status === 'conflict') return failure;
  try {
    return readReceiptRow(input.sessionId, input.sourceUserSeq)
      ? { status: 'conflict', reason: `bound memory receipt lost current qualification: ${failure.reason}` } : failure;
  } catch (error) { return { status: 'storage_error', reason: boundedReason(error) }; }
}

/** Mint once, only from exact host-observed durable evidence. */
export function issueDurableMemoryIntakeReceipt(input: {
  sessionId: string;
  sourceUserSeq: number;
}): IssueDurableMemoryIntakeReceiptResult {
  const derived = deriveExactEvidence(input);
  if (derived.status !== 'ok') return boundReceiptFailure(input, derived);
  let mirror: EventRow | null = null;
  try {
    const db = openEventLog();
    const tx = db.transaction((): IssueDurableMemoryIntakeReceiptResult => {
      const existing = db.prepare(`
        SELECT * FROM durable_memory_intake_receipts
         WHERE session_id = ? AND source_user_seq = ?
      `).get(input.sessionId, input.sourceUserSeq) as HostReceiptRow | undefined;
      if (existing) {
        const compatible = compatibleReceiptEvidence(existing, derived.evidence);
        if (!compatible) {
          return { status: 'conflict', reason: 'a different host receipt already claims this accepted source' };
        }
        const authority = db.prepare(`
          SELECT accepted_task_id, graph_event_id, graph_id, graph_hash, state,
                 manifest_id, expected_work_required, work_contract_id,
                 host_completion_receipt_id, host_completion_event_id,
                 backstop_event_id, revision
            FROM accepted_task_authority
           WHERE session_id = ? AND source_user_seq = ?
        `).get(input.sessionId, input.sourceUserSeq) as HostAuthorityRow | undefined;
        if (
          !authority
          || authority.host_completion_receipt_id !== existing.receipt_id
          || authority.host_completion_event_id !== existing.receipt_event_id
          || authority.manifest_id !== existing.receipt_id
          || authority.backstop_event_id !== existing.receipt_event_id
          || (authority.state !== 'manifested_verifying' && authority.state !== 'terminal')
        ) {
          return { status: 'conflict', reason: 'persisted host receipt is not bound to its accepted task' };
        }
        return {
          status: 'replayed',
          receiptId: existing.receipt_id,
          receiptEventId: existing.receipt_event_id,
          receipt: compatible.receipt,
        };
      }
      const authority = db.prepare(`
        SELECT accepted_task_id, graph_event_id, graph_id, graph_hash, state,
               manifest_id, expected_work_required, work_contract_id,
               host_completion_receipt_id, host_completion_event_id,
               backstop_event_id, revision
          FROM accepted_task_authority
         WHERE session_id = ? AND source_user_seq = ?
      `).get(input.sessionId, input.sourceUserSeq) as HostAuthorityRow | undefined;
      const receipt = derived.evidence.receipt;
      if (!authority) return { status: 'missing', reason: 'accepted task authority is missing' };
      if (
        authority.accepted_task_id !== receipt.identity.acceptedTaskId
        || authority.graph_event_id !== receipt.graph.graphEventId
        || authority.graph_id !== receipt.graph.graphId
        || authority.graph_hash !== receipt.graph.graphHash
      ) {
        return { status: 'conflict', reason: 'accepted task authority does not match the receipt graph' };
      }
      if (
        authority.state !== 'armed'
        || authority.expected_work_required !== 1
        || authority.work_contract_id !== null
        || authority.manifest_id !== null
        || authority.host_completion_receipt_id !== null
        || authority.host_completion_event_id !== null
      ) {
        return { status: 'conflict', reason: 'accepted task is not an uncontracted armed host action' };
      }
      const crossings = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM logical_tool_calls
            WHERE session_id = ? AND source_user_seq = ?) AS logical_n,
          (SELECT COUNT(*) FROM physical_dispatches
            WHERE session_id = ? AND source_user_seq = ?) AS dispatch_n
      `).get(
        input.sessionId,
        input.sourceUserSeq,
        input.sessionId,
        input.sourceUserSeq,
      ) as { logical_n: number; dispatch_n: number };
      if (crossings.logical_n !== 0 || crossings.dispatch_n !== 0) {
        return { status: 'conflict', reason: 'host-only memory completion cannot coexist with tool work' };
      }
      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.sessionId,
        turn: derived.evidence.sourceTurn,
        role: 'system',
        type: 'durable_memory_intake_receipt',
        data: {
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: receipt.identity.acceptedTaskId,
          receiptId: derived.evidence.receiptId,
          receipt,
        },
      });
      db.prepare(`
        INSERT INTO durable_memory_intake_receipts
          (receipt_id, protocol_version, session_id, source_user_seq,
           accepted_task_id, graph_event_id, graph_id, graph_hash,
           source_event_id, source_message_digest, episode_id, call_id,
           episode_content_hash, candidate_count, candidate_digest,
           evidence_digest, receipt_json, receipt_event_id, issued_at)
        VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        derived.evidence.receiptId,
        input.sessionId,
        input.sourceUserSeq,
        receipt.identity.acceptedTaskId,
        receipt.graph.graphEventId,
        receipt.graph.graphId,
        receipt.graph.graphHash,
        receipt.source.eventId,
        receipt.source.messageDigest,
        receipt.memory.episodeId,
        receipt.memory.callId,
        receipt.memory.episodeContentHash,
        receipt.candidates.length,
        receipt.candidateDigest,
        receipt.evidenceDigest,
        derived.evidence.receiptJson,
        mirror.id,
        mirror.createdAt,
      );
      const updated = db.prepare(`
        UPDATE accepted_task_authority
           SET state = 'manifested_verifying', manifest_id = ?,
               host_completion_receipt_id = ?, host_completion_event_id = ?,
               backstop_event_id = ?, revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND state = 'armed' AND expected_work_required = 1
           AND work_contract_id IS NULL AND manifest_id IS NULL
           AND host_completion_receipt_id IS NULL
           AND host_completion_event_id IS NULL
           AND revision = ?
      `).run(
        derived.evidence.receiptId,
        derived.evidence.receiptId,
        mirror.id,
        mirror.id,
        mirror.createdAt,
        input.sessionId,
        input.sourceUserSeq,
        authority.revision,
      );
      if (updated.changes !== 1) throw new Error('durable memory host receipt lost its authority CAS');
      return {
        status: 'issued',
        receiptId: derived.evidence.receiptId,
        receiptEventId: mirror.id,
        receipt,
      };
    });
    const result = tx.immediate();
    if (result.status === 'issued' && mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/** Re-derive the memory evidence and redeem only the exact normalized receipt
 * currently bound to the accepted task. */
export function redeemDurableMemoryIntakeReceipt(input: {
  sessionId: string;
  sourceUserSeq: number;
}): RedeemDurableMemoryIntakeReceiptResult {
  const derived = deriveExactEvidence(input);
  if (derived.status !== 'ok') return boundReceiptFailure(input, derived);
  try {
    const row = readReceiptRow(input.sessionId, input.sourceUserSeq);
    if (!row) return { status: 'missing', reason: 'durable memory host receipt is missing' };
    const compatible = compatibleReceiptEvidence(row, derived.evidence);
    if (!compatible) {
      return { status: 'conflict', reason: 'durable memory host receipt no longer matches exact evidence' };
    }
    const authority = readAuthority(input.sessionId, input.sourceUserSeq);
    if (
      !authority
      || authority.accepted_task_id !== row.accepted_task_id
      || authority.graph_event_id !== row.graph_event_id
      || authority.graph_id !== row.graph_id
      || authority.graph_hash !== row.graph_hash
      || authority.expected_work_required !== 1
      || authority.work_contract_id !== null
      || authority.manifest_id !== row.receipt_id
      || authority.host_completion_receipt_id !== row.receipt_id
      || authority.host_completion_event_id !== row.receipt_event_id
      || authority.backstop_event_id !== row.receipt_event_id
      || (authority.state !== 'manifested_verifying' && authority.state !== 'terminal')
    ) {
      return { status: 'conflict', reason: 'durable memory host receipt is not exact accepted-task authority' };
    }
    const db = openEventLog();
    const crossings = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM logical_tool_calls
          WHERE session_id = ? AND source_user_seq = ?) AS logical_n,
        (SELECT COUNT(*) FROM physical_dispatches
          WHERE session_id = ? AND source_user_seq = ?) AS dispatch_n
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      input.sessionId,
      input.sourceUserSeq,
    ) as { logical_n: number; dispatch_n: number };
    if (crossings.logical_n !== 0 || crossings.dispatch_n !== 0) {
      return { status: 'conflict', reason: 'durable memory host receipt has competing tool work' };
    }
    if (!exactReceiptEvent(row, compatible)) {
      return { status: 'conflict', reason: 'durable memory host receipt event is missing or tampered' };
    }
    return {
      status: 'redeemed',
      receiptId: row.receipt_id,
      receiptEventId: row.receipt_event_id,
      receipt: compatible.receipt,
    };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/** Issue if needed, then independently redeem. This is the only fast-path
 * completion probe used by provider lanes and terminal preparation. */
export function prepareDurableMemoryIntakeHostCompletion(input: {
  sessionId: string;
  sourceUserSeq: number;
}): RedeemDurableMemoryIntakeReceiptResult {
  const issued = issueDurableMemoryIntakeReceipt(input);
  if ('reason' in issued) {
    return { status: issued.status, reason: issued.reason };
  }
  return redeemDurableMemoryIntakeReceipt(input);
}
