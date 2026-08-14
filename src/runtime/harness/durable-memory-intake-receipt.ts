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
import { extractAutoMemoryCandidates } from '../../memory/auto-capture.js';
import { openMemoryDb } from '../../memory/db.js';
import { reflectionCandidateHash } from '../../memory/reflection-candidates.js';
import {
  insertInternalEventInTransaction,
  openEventLog,
  publishCommittedInternalEvent,
  type EventRow,
} from './eventlog.js';
import { durableMemoryReceiptAllowsConversationOnly } from './durable-memory-receipt.js';
import { expectedTaskFor } from './resolution-ledger.js';

export const DURABLE_MEMORY_INTAKE_RECEIPT_PROTOCOL = 1 as const;

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
  protocol: typeof DURABLE_MEMORY_INTAKE_RECEIPT_PROTOCOL;
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

export type IssueDurableMemoryIntakeReceiptResult =
  | {
      status: 'issued' | 'replayed';
      receiptId: string;
      receiptEventId: string;
      receipt: DurableMemoryIntakeReceiptV1;
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
      receipt: DurableMemoryIntakeReceiptV1;
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
  receipt: DurableMemoryIntakeReceiptV1;
  receiptId: string;
  receiptJson: string;
  sourceTurn: number;
};

type DeriveResult =
  | { status: 'ok'; evidence: DerivedEvidence }
  | { status: 'missing' | 'ineligible' | 'conflict' | 'storage_error'; reason: string };

/** Re-read both stores. No caller-provided capture result or telemetry bit can
 * influence this decision. */
function deriveExactEvidence(input: {
  sessionId: string;
  sourceUserSeq: number;
}): DeriveResult {
  if (!input.sessionId || !Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) {
    return { status: 'conflict', reason: 'accepted source identity is invalid' };
  }
  try {
    const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
    if (expected.status !== 'ok') {
      return {
        status: expected.status === 'missing' ? 'missing' : 'conflict',
        reason: expected.reason,
      };
    }
    if (expected.graph.classification.route !== 'act') {
      return { status: 'ineligible', reason: 'accepted graph is not an action turn' };
    }
    const eventDb = openEventLog();
    const source = eventDb.prepare(`
      SELECT id, turn, data_json
        FROM events
       WHERE session_id = ? AND seq = ? AND type = 'user_input_received'
    `).get(input.sessionId, input.sourceUserSeq) as {
      id: string;
      turn: number;
      data_json: string;
    } | undefined;
    if (!source) return { status: 'missing', reason: 'accepted user source is missing' };
    let sourceData: unknown;
    try { sourceData = JSON.parse(source.data_json); } catch {
      return { status: 'conflict', reason: 'accepted user source is malformed' };
    }
    if (!record(sourceData)) return { status: 'conflict', reason: 'accepted user source is malformed' };
    const message = acceptedSourceText(sourceData);
    if (!message) return { status: 'conflict', reason: 'accepted user source has no display text' };
    const normalizedMessage = normalizeMessage(message);
    const graphInputHash = expected.graph.source?.inputHash;
    let captureMessage = digest(normalizedMessage) === graphInputHash
      ? normalizedMessage
      : '';
    let candidates = captureMessage
      ? extractAutoMemoryCandidates(captureMessage, 3)
      : [];
    // Ordinary non-memory actions remain ineligible without demanding a
    // memory episode. Only a graph whose semantic input differs from the full
    // accepted sentence needs the episode-backed fresh-clause recovery below.
    if (captureMessage && candidates.length === 0) {
      return { status: 'ineligible', reason: 'accepted graph input produced no durable memory candidates' };
    }
    const sourceEventIdentity = `user-source:${input.sourceUserSeq}`;
    const callId = `auto-capture:${sourceEventIdentity}`;
    const sourceUri = `conversation://${encodeURIComponent(input.sessionId)}/${encodeURIComponent(callId)}`;
    const memoryDb = openMemoryDb();
    const episodes = memoryDb.prepare(`
      SELECT id, kind, source_app, session_id, call_id, source_uri,
             content_hash, evidence_excerpt, status, subtype, metadata_json
        FROM memory_episodes
       WHERE session_id = ? AND call_id = ?
       ORDER BY id
    `).all(input.sessionId, callId) as MemoryEpisodeEvidenceRow[];
    if (episodes.length !== 1) {
      return {
        status: episodes.length === 0 ? 'missing' : 'conflict',
        reason: `exact auto-capture episode count is ${episodes.length}`,
      };
    }
    const episode = episodes[0]!;
    // A compound clarification answer keeps the complete conversational
    // sentence in the immutable accepted event, while the verified turn graph
    // and auto-memory admission intentionally operate on only the independent
    // fresh clause. Bind that narrower capture to the graph's content address
    // instead of re-learning (or requiring) the declined parent clause. The
    // episode bytes are never sufficient on their own: they must hash to the
    // accepted graph semantic input and remain an exact substring of the
    // accepted user message.
    const normalizedEpisodeMessage = normalizeMessage(episode.evidence_excerpt ?? '');
    captureMessage ||= normalizedEpisodeMessage
        && normalizedMessage.includes(normalizedEpisodeMessage)
        && digest(normalizedEpisodeMessage) === graphInputHash
        ? normalizedEpisodeMessage
        : '';
    if (!captureMessage) {
      return {
        status: 'conflict',
        reason: 'auto-capture episode is not bound to the accepted graph semantic input',
      };
    }
    candidates = extractAutoMemoryCandidates(captureMessage, 3);
    if (candidates.length === 0) {
      return { status: 'ineligible', reason: 'accepted graph input produced no durable memory candidates' };
    }
    let metadata: unknown;
    try { metadata = JSON.parse(episode.metadata_json); } catch {
      return { status: 'conflict', reason: 'auto-capture episode metadata is malformed' };
    }
    const expectedMetadata = { candidateCount: candidates.length, sourceEventId: sourceEventIdentity };
    const expectedContentHash = digest(captureMessage);
    if (
      episode.kind !== 'user_turn'
      || episode.source_app !== 'Conversation'
      || episode.session_id !== input.sessionId
      || episode.call_id !== callId
      || episode.source_uri !== sourceUri
      || episode.subtype !== 'auto_capture'
      || episode.status !== 'available'
      || episode.evidence_excerpt !== captureMessage
      || episode.content_hash !== expectedContentHash
      || !isDeepStrictEqual(metadata, expectedMetadata)
    ) {
      return { status: 'conflict', reason: 'auto-capture episode does not exactly match the accepted source' };
    }
    const rows = memoryDb.prepare(`
      SELECT id, episode_id, session_id, call_id, candidate_hash, kind, text,
             importance, status, source_type, intake_reason, trust_level,
             authority, source_uri, pin
        FROM memory_reflection_candidates
       WHERE session_id = ? AND call_id = ?
       ORDER BY id
    `).all(input.sessionId, callId) as MemoryCandidateEvidenceRow[];
    if (rows.length !== candidates.length) {
      return {
        status: rows.length === 0 ? 'missing' : 'conflict',
        reason: `exact auto-capture candidate count is ${rows.length}, expected ${candidates.length}`,
      };
    }
    const expectedByHash = new Map(candidates.map((candidate) => [
      reflectionCandidateHash(candidate.content),
      candidate,
    ]));
    const normalizedRows: DurableMemoryIntakeReceiptV1['candidates'] = [];
    for (const row of rows) {
      const candidate = expectedByHash.get(row.candidate_hash);
      if (
        !candidate
        || row.episode_id !== episode.id
        || row.session_id !== input.sessionId
        || row.call_id !== callId
        || row.candidate_hash !== reflectionCandidateHash(row.text)
        || row.kind !== candidate.kind
        || row.text !== candidate.content.trim()
        || row.importance !== 5
        || !['pending', 'promoted', 'rejected', 'expired'].includes(row.status)
        || row.source_type !== 'auto_capture'
        || row.intake_reason !== candidate.reason
        || row.trust_level !== 1
        || row.authority !== 'user'
        || row.source_uri !== sourceUri
        || row.pin !== (candidate.pin ? 1 : 0)
      ) {
        return { status: 'conflict', reason: 'an auto-capture candidate row is not exact' };
      }
      normalizedRows.push({
        id: row.id,
        hash: row.candidate_hash,
        kind: row.kind,
        textDigest: digest(row.text),
        intakeReason: row.intake_reason,
        pinned: row.pin === 1,
      });
    }
    normalizedRows.sort((left, right) => left.hash.localeCompare(right.hash) || left.id - right.id);
    if (!durableMemoryReceiptAllowsConversationOnly({
      message: captureMessage,
      candidates,
      queuedCandidateCount: rows.length,
      episodeId: episode.id,
    })) {
      return {
        status: 'ineligible',
        reason: 'accepted source is not an acknowledgement-only durable-memory action',
      };
    }
    const candidateDigest = digest(canonicalize(normalizedRows));
    const evidenceDigest = digest(canonicalize({
      sourceEventId: source.id,
      sourceMessageDigest: digest(normalizedMessage),
      episodeId: episode.id,
      callId,
      episodeContentHash: episode.content_hash,
      candidateDigest,
    }));
    const receipt: DurableMemoryIntakeReceiptV1 = {
      protocol: DURABLE_MEMORY_INTAKE_RECEIPT_PROTOCOL,
      kind: 'durable_memory_intake',
      identity: {
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: expected.expectation.acceptedTaskId,
      },
      graph: {
        graphEventId: expected.expectation.graphEventId,
        graphId: expected.expectation.graphId,
        graphHash: expected.expectation.graphHash,
      },
      source: {
        eventId: source.id,
        eventIdentity: sourceEventIdentity,
        messageDigest: digest(normalizedMessage),
      },
      memory: {
        episodeId: episode.id,
        callId,
        episodeContentHash: episode.content_hash,
        sourceUri,
      },
      candidates: normalizedRows,
      candidateDigest,
      evidenceDigest,
    };
    const receiptJson = canonicalize(receipt);
    return {
      status: 'ok',
      evidence: {
        receipt,
        receiptJson,
        receiptId: `memory-intake:v1:${digest(receiptJson)}`,
        sourceTurn: source.turn,
      },
    };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
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

/** Mint once, only from exact host-observed durable evidence. */
export function issueDurableMemoryIntakeReceipt(input: {
  sessionId: string;
  sourceUserSeq: number;
}): IssueDurableMemoryIntakeReceiptResult {
  const derived = deriveExactEvidence(input);
  if (derived.status !== 'ok') return derived;
  let mirror: EventRow | null = null;
  try {
    const db = openEventLog();
    const tx = db.transaction((): IssueDurableMemoryIntakeReceiptResult => {
      const existing = db.prepare(`
        SELECT * FROM durable_memory_intake_receipts
         WHERE session_id = ? AND source_user_seq = ?
      `).get(input.sessionId, input.sourceUserSeq) as HostReceiptRow | undefined;
      if (existing) {
        if (!exactReceiptRow(existing, derived.evidence)) {
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
          receipt: derived.evidence.receipt,
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
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  if (derived.status !== 'ok') return derived;
  try {
    const row = readReceiptRow(input.sessionId, input.sourceUserSeq);
    if (!row) return { status: 'missing', reason: 'durable memory host receipt is missing' };
    if (!exactReceiptRow(row, derived.evidence)) {
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
    if (!exactReceiptEvent(row, derived.evidence)) {
      return { status: 'conflict', reason: 'durable memory host receipt event is missing or tampered' };
    }
    return {
      status: 'redeemed',
      receiptId: row.receipt_id,
      receiptEventId: row.receipt_event_id,
      receipt: derived.evidence.receipt,
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
