/**
 * Durable reconstruction of the exact normalized request seen at the final
 * model-dispatch boundary.
 *
 * Raw request bytes are sealed in the host-owned encrypted payload store.
 * SQLite retains only content digests and immutable references to the durable
 * sources which contributed model-visible context. A restart projector opens
 * the sealed bytes, revalidates every reference, and recomputes the same
 * normalized request digest used by prompt-cache observation.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ModelRequest } from '@openai/agents';
import { openMemoryDb } from '../../memory/db.js';
import {
  persistAuthorityEncryptedPayload,
  readAuthorityEncryptedPayload,
  type AuthorityEncryptedPayloadReference,
} from './authority-encrypted-payload-store.js';
import {
  acceptedTurnSourceEventDigest,
  type AcceptedTurnSourceEventDigestInput,
} from './eventlog-schema.js';
import {
  conversationPreambleDeliveryRequest,
  listEvents,
  openEventLog,
} from './eventlog.js';
import {
  canonicalPromptCacheRequest,
  promptCacheNormalizedRequestDigest,
  PROMPT_CACHE_LAYER_ORDER,
  type CanonicalPromptCacheRequestV1,
  type PromptCacheLayerName,
  type PromptCacheRequestObservationV1,
} from './prompt-cache-observation.js';
import {
  canonicalModelResultJson,
  canonicalModelResultOutputBytes,
  hostModelResultReceiptDigest,
  hostModelResultReceiptFromRow,
  hostModelResultReceiptMatchesItem,
  hostModelResultReceiptRowsForCall,
  type HostModelResultReceiptRow,
} from './host-model-result-receipt.js';
import {
  describeLogicalModelResultProjection,
  logicalModelResultProjectionReceiptDigest,
  logicalModelResultProjectionReceiptFromRow,
  logicalModelResultProjectionReceiptMatchesItem,
  logicalModelResultProjectionReceiptRowsForCall,
} from './logical-model-result-projection-receipt.js';

export const MODEL_REQUEST_PROVENANCE_VERSION = 1 as const;
const SHA256 = /^[a-f0-9]{64}$/;
const MEMORY_PRIMER_MARKER = '[MEMORY PRIMER]';

interface RawEventRow {
  seq: number;
  id: string;
  session_id: string;
  turn: number;
  role: string;
  type: string;
  parent_event_id: string | null;
  data_json: string;
  created_at: string;
}

interface SourceRef {
  eventId: string;
  eventDigest: string;
  turn: number;
  visibleTextSha256: string;
}

interface PreambleRef {
  eventId: string;
  eventDigest: string;
  deliveryKey: string;
  visibleTextSha256: string;
}

interface MemoryRef {
  eventId: string;
  eventDigest: string;
  recallId: string;
  recallDigest: string;
  visibleTextSha256: string;
  visibleTextBytes: number;
}

interface EventRef {
  eventId: string;
  eventDigest: string;
  type: 'capability_discovered' | 'planning_catalog_disclosed';
  capabilityRefs: string[];
}

interface SettlementRef {
  sessionId: string;
  sourceUserSeq: number;
  visibleCallId: string;
  logicalToolCallId: string;
  settlementDigest: string;
  resultHandleId: string | null;
  resultHandleDigest: string | null;
  /** Added append-only in schema v69. Historical immutable v1 manifests may
   * omit these two fields; their projector still requires the exact current
   * receipt (or proves that the result predates accepted-model batches). Every
   * newly recorded accepted-batch result cites both fields. */
  projectionReceiptId?: string;
  projectionReceiptDigest?: string;
}

interface HostResultRef {
  receiptId: string;
  receiptDigest: string;
  sessionId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  batchOrdinal: number;
  batchId: string;
  callId: string;
  toolName: string;
  disposition: 'refused_pre_dispatch' | 'not_started' | 'user_rejected';
  outputBytes: number;
  outputSha256: string;
}

interface ToolSchemaRef {
  authorityDigest: string;
  authorityIdentityDigest: string;
  catalogSnapshotDigest: string | null;
  catalogSnapshotRowDigest: string | null;
  schemaDigests: Array<{ name: string; sha256: string }>;
}

export interface ModelRequestCacheEligibilityV1 {
  cacheEligible: boolean;
  policyRevision: string | null;
  issues: string[];
}

export interface ModelRequestProvenanceManifestV1 {
  version: typeof MODEL_REQUEST_PROVENANCE_VERSION;
  source: SourceRef;
  hostProjectionDigest: string;
  cacheEligibility: ModelRequestCacheEligibilityV1;
  layers: Record<PromptCacheLayerName, { bytes: number; sha256: string }>;
  preambles: PreambleRef[];
  verifiedMemory: MemoryRef[];
  disclosedRefs: EventRef[];
  settledResults: SettlementRef[];
  hostResults: HostResultRef[];
  toolSchemas: ToolSchemaRef;
}

export interface RecordModelRequestProvenanceInput {
  sessionId: string;
  sourceUserSeq: number;
  request: ModelRequest;
  /** Byte snapshot captured synchronously at the host boundary, before model
   * resolution yields and before codexOneStep constructs its request. */
  hostProjection: CanonicalPromptCacheRequestV1;
}

export interface RecordedModelRequestProvenance {
  recordId: string;
  sessionId: string;
  sourceUserSeq: number;
  requestOrdinal: number;
  normalizedRequestDigest: string;
  hostProjectionDigest: string;
  provenanceDigest: string;
  payloadReference: AuthorityEncryptedPayloadReference;
}

export type ModelRequestProjection =
  | {
      status: 'ok';
      record: RecordedModelRequestProvenance;
      boundary: PromptCacheRequestObservationV1['boundary'];
      cacheEligibility: ModelRequestCacheEligibilityV1;
      layers: Record<PromptCacheLayerName, string>;
      manifest: ModelRequestProvenanceManifestV1;
    }
  | { status: 'invalid'; reason: string };

export class ModelRequestProvenanceError extends Error {
  constructor(readonly code: string, options?: { cause?: unknown }) {
    super(`model request provenance refused: ${code}`, options);
    this.name = 'ModelRequestProvenanceError';
  }
}

/**
 * Fail-open is never a provenance strategy: if the host cannot durably
 * reconstruct a request, the bytes cannot cross the provider boundary.
 *
 * One optional layer has an exact, host-owned removal grammar. The automatic
 * turn primer is appended as one whole system input item whose content begins
 * with `MEMORY_PRIMER_MARKER`. When (and only when) that one item cannot be
 * proven, the host may remove the complete item and record the resulting exact
 * request. It may not edit the text, infer a boundary from prose elsewhere, or
 * use this recovery for database/encryption failures.
 */
const REMOVABLE_OPTIONAL_MEMORY_FAILURES: ReadonlySet<string> = new Set([
  'ambient_unproven_memory',
  'verified_memory_source_missing',
  'memory_projection_size_mismatch',
  'memory_projection_digest_mismatch',
]);

export type ModelRequestDispatchProvenance = {
  record: RecordedModelRequestProvenance;
  removedOptionalLayer: null | 'turn_memory_primer';
};

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ModelRequestProvenanceError('non_canonical_number');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') return 'null';
  if (typeof value !== 'object') throw new ModelRequestProvenanceError('non_canonical_value');
  if (ancestors.has(value)) throw new ModelRequestProvenanceError('cyclic_value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function digestJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

function eventDigest(row: RawEventRow): string {
  return digestJson({
    seq: row.seq,
    id: row.id,
    sessionId: row.session_id,
    turn: row.turn,
    role: row.role,
    type: row.type,
    parentEventId: row.parent_event_id,
    dataJson: row.data_json,
    createdAt: row.created_at,
  });
}

function acceptedSourceDigest(row: RawEventRow): string {
  return acceptedTurnSourceEventDigest({
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    turn: row.turn,
    role: row.role,
    type: row.type,
    parentEventId: row.parent_event_id,
    dataJson: row.data_json,
    createdAt: row.created_at,
  } satisfies AcceptedTurnSourceEventDigestInput);
}

function parseObject(json: string, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
    return value as Record<string, unknown>;
  } catch {
    throw new ModelRequestProvenanceError(code);
  }
}

function collectStrings(value: unknown, output: string[] = [], seen = new Set<object>()): string[] {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output, seen);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStrings(entry, output, seen);
    }
  }
  return output;
}

function visibleStringsFromLayers(layers: Record<PromptCacheLayerName, string>): string[] {
  let task: unknown;
  try {
    task = JSON.parse(layers.task) as unknown;
  } catch {
    throw new ModelRequestProvenanceError('task_layer_not_json');
  }
  return [layers.stablePolicy, layers.turnContext, layers.memoryContext, ...collectStrings(task)];
}

function memoryBearingStringsFromLayers(
  layers: Record<PromptCacheLayerName, string>,
): string[] {
  let task: unknown;
  try {
    task = JSON.parse(layers.task) as unknown;
  } catch {
    throw new ModelRequestProvenanceError('task_layer_not_json');
  }
  // Policy/rubric prose may name the marker while explaining the protocol.
  // Only the dedicated instruction layer and task strings whose exact content
  // begins with the marker are possible rendered memory blocks.
  return [
    layers.memoryContext,
    ...collectStrings(task).filter((text) => text.startsWith(MEMORY_PRIMER_MARKER)),
  ];
}

function containsText(strings: readonly string[], text: string): boolean {
  return Boolean(text) && strings.some((candidate) => candidate.includes(text));
}

function visibleMemoryPrimer(input: {
  strings: readonly string[];
  declaredBytes: number;
}): string | null {
  const starts: Array<{ text: string; at: number }> = [];
  for (const text of input.strings) {
    let at = 0;
    while ((at = text.indexOf(MEMORY_PRIMER_MARKER, at)) >= 0) {
      starts.push({ text, at });
      at += MEMORY_PRIMER_MARKER.length;
    }
  }
  if (starts.length !== 1 || !Number.isSafeInteger(input.declaredBytes) || input.declaredBytes <= 0) {
    return null;
  }
  const tail = starts[0]!.text.slice(starts[0]!.at);
  const bytes = Buffer.from(tail, 'utf8').subarray(0, input.declaredBytes);
  const primer = bytes.toString('utf8');
  return Buffer.byteLength(primer, 'utf8') === input.declaredBytes
    && primer.startsWith(MEMORY_PRIMER_MARKER)
    ? primer
    : null;
}

function visibleMemoryMarkerCount(strings: readonly string[]): number {
  return strings.reduce((sum, text) => {
    let count = 0;
    let at = 0;
    while ((at = text.indexOf(MEMORY_PRIMER_MARKER, at)) >= 0) {
      count += 1;
      at += MEMORY_PRIMER_MARKER.length;
    }
    return sum + count;
  }, 0);
}

interface VisibleFunctionResult {
  callId: string;
  toolName: string;
  callNamespace: string | null;
  outputBytes: number;
  outputSha256: string;
  item: Record<string, unknown>;
}

function visibleFunctionResults(
  value: unknown,
  output: VisibleFunctionResult[] = [],
  seen = new Set<object>(),
): VisibleFunctionResult[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (!Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (row.type === 'function_call_result') {
      const callId = typeof row.callId === 'string' ? row.callId.trim() : '';
      const toolName = typeof row.name === 'string' ? row.name.trim() : '';
      if (!callId || !toolName || row.status !== 'completed' || row.output === undefined) {
        throw new ModelRequestProvenanceError('function_result_identity_invalid');
      }
      const projection = describeLogicalModelResultProjection(row as never);
      if (!projection) {
        throw new ModelRequestProvenanceError('function_result_projection_invalid');
      }
      const outputJson = canonicalModelResultOutputBytes(row as never);
      output.push({
        callId,
        toolName,
        callNamespace: projection.callNamespace,
        outputBytes: Buffer.byteLength(outputJson, 'utf8'),
        outputSha256: sha256(outputJson),
        item: row,
      });
      return output;
    }
    for (const child of Object.values(row)) visibleFunctionResults(child, output, seen);
  } else {
    for (const child of value) visibleFunctionResults(child, output, seen);
  }
  return output;
}

function uniqueVisibleFunctionResults(value: unknown): VisibleFunctionResult[] {
  const results = visibleFunctionResults(value);
  if (new Set(results.map((result) => result.callId)).size !== results.length) {
    throw new ModelRequestProvenanceError('ambiguous_function_result');
  }
  return results.sort((left, right) => left.callId.localeCompare(right.callId));
}

function acceptedBatchAdmissionCountForResult(input: {
  db: ReturnType<typeof openEventLog>;
  sessionId: string;
  sourceUserSeq: number;
  result: VisibleFunctionResult;
}): number {
  return Number((input.db.prepare(`
    SELECT COUNT(*) AS n
      FROM accepted_model_batch_admissions admission
     WHERE admission.session_id = ? AND admission.source_user_seq = ?
       AND (
         SELECT COUNT(*)
           FROM json_each(admission.frame_history_json) item
          WHERE json_extract(item.value, '$.type') = 'function_call'
            AND json_extract(item.value, '$.callId') = ?
            AND json_extract(item.value, '$.name') = ?
            AND json_extract(item.value, '$.namespace') IS ?
       ) = 1
  `).get(
    input.sessionId,
    input.sourceUserSeq,
    input.result.callId,
    input.result.toolName,
    input.result.callNamespace,
  ) as { n: number }).n);
}

function rawEvent(db: ReturnType<typeof openEventLog>, eventId: string): RawEventRow | null {
  return (db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as RawEventRow | undefined) ?? null;
}

function sourceRow(db: ReturnType<typeof openEventLog>, sessionId: string, sourceUserSeq: number): RawEventRow {
  const row = db.prepare(
    `SELECT * FROM events WHERE session_id = ? AND seq = ? LIMIT 1`,
  ).get(sessionId, sourceUserSeq) as RawEventRow | undefined;
  if (
    !row
    || row.role !== 'user'
    || row.type !== 'user_input_received'
    || parseObject(row.data_json, 'accepted_source_data_invalid').synthetic === true
  ) throw new ModelRequestProvenanceError('accepted_source_missing');
  return row;
}

function authorityIdentity(db: ReturnType<typeof openEventLog>, sessionId: string, sourceUserSeq: number): {
  authorityDigest: string;
  identityDigest: string;
} {
  const row = db.prepare(`
    SELECT accepted_task_id, authority_protocol, authority_kind,
           source_event_id, source_event_digest, source_turn,
           engine_version, surface_version, surface_digest,
           effect_ceiling, effect_bounds_json, max_logical_calls,
           max_parallel_calls, catalog_revision_digest,
           binding_revision_digest, graph_event_id, graph_hash,
           authority_digest, opened_at
      FROM accepted_turn_call_authorities
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as Record<string, unknown> | undefined;
  if (!row || typeof row.authority_digest !== 'string' || !SHA256.test(row.authority_digest)) {
    throw new ModelRequestProvenanceError('tool_schema_authority_missing');
  }
  return { authorityDigest: row.authority_digest, identityDigest: digestJson(row) };
}

function catalogSnapshot(db: ReturnType<typeof openEventLog>, sessionId: string, sourceUserSeq: number): {
  digest: string;
  rowDigest: string;
} | null {
  const row = db.prepare(`
    SELECT snapshot_digest, snapshot_json
      FROM accepted_source_catalog_snapshots
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as { snapshot_digest: string; snapshot_json: string } | undefined;
  if (!row) return null;
  if (!SHA256.test(row.snapshot_digest)) {
    throw new ModelRequestProvenanceError('catalog_snapshot_invalid');
  }
  return { digest: row.snapshot_digest, rowDigest: digestJson(row) };
}

function schemaRefs(request: ModelRequest): Array<{ name: string; sha256: string }> {
  if (!Array.isArray(request.tools)) throw new ModelRequestProvenanceError('tool_schema_surface_invalid');
  return request.tools.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ModelRequestProvenanceError('tool_schema_surface_invalid');
    }
    const row = candidate as unknown as Record<string, unknown>;
    const name = typeof row.name === 'string' && row.name.trim()
      ? row.name.trim()
      : `tool#${index}`;
    return { name, sha256: digestJson(row) };
  });
}

/**
 * Prompt-cache eligibility and request reconstructibility are deliberately
 * separate predicates. An omitted optional system prompt produces one exact,
 * canonical request shape, but there is no stable policy prefix to cache.
 * Every other observation issue still denotes an ambiguous or malformed
 * normalized request and therefore fails closed at provenance admission.
 */
function reconstructibleCacheEligibility(input: {
  observation: PromptCacheRequestObservationV1;
  layers: Record<PromptCacheLayerName, string>;
}): ModelRequestCacheEligibilityV1 {
  const { observation, layers } = input;
  const recomputedDigest = promptCacheNormalizedRequestDigest({
    boundary: observation.boundary,
    layers,
  });
  const recomputedInputBytes = PROMPT_CACHE_LAYER_ORDER
    .filter((name) => name !== 'transport')
    .reduce((sum, name) => sum + Buffer.byteLength(layers[name], 'utf8'), 0);
  const layersMatch = PROMPT_CACHE_LAYER_ORDER.every((name) => (
    observation.layers[name]?.bytes === Buffer.byteLength(layers[name], 'utf8')
    && observation.layers[name]?.sha256 === sha256(layers[name])
  ));
  if (
    observation.boundary === 'invalid'
    || observation.normalizedRequestDigest !== recomputedDigest
    || observation.normalizedInputBytes !== recomputedInputBytes
    || !layersMatch
  ) throw new ModelRequestProvenanceError('request_not_canonical');

  if (observation.issues.length === 0) {
    if (
      !observation.cacheEligible
      || !layers.stablePolicy
      || observation.policyRevision !== observation.layers.stablePolicy.sha256
    ) throw new ModelRequestProvenanceError('request_not_canonical');
    return {
      cacheEligible: true,
      policyRevision: observation.policyRevision,
      issues: [],
    };
  }

  const exactNoSystemInstructions = observation.boundary === 'whole_instructions'
    && layers.stablePolicy === ''
    && observation.layers.stablePolicy.bytes === 0
    && observation.layers.stablePolicy.sha256 === sha256('')
    && observation.cacheEligible === false
    && observation.policyRevision === null
    && observation.issues.length === 1
    && observation.issues[0] === 'empty_stable_policy';
  if (!exactNoSystemInstructions) {
    throw new ModelRequestProvenanceError('request_not_canonical');
  }
  return {
    cacheEligible: false,
    policyRevision: null,
    issues: ['empty_stable_policy'],
  };
}

function projectedCacheEligibility(input: {
  boundary: Exclude<PromptCacheRequestObservationV1['boundary'], 'invalid'>;
  layers: Record<PromptCacheLayerName, string>;
}): ModelRequestCacheEligibilityV1 {
  if (input.boundary === 'whole_instructions' && input.layers.stablePolicy === '') {
    return {
      cacheEligible: false,
      policyRevision: null,
      issues: ['empty_stable_policy'],
    };
  }
  if (!input.layers.stablePolicy) {
    throw new ModelRequestProvenanceError('request_not_canonical');
  }
  return {
    cacheEligible: true,
    policyRevision: sha256(input.layers.stablePolicy),
    issues: [],
  };
}

function buildManifest(input: {
  sessionId: string;
  sourceUserSeq: number;
  request: ModelRequest;
  hostProjection: CanonicalPromptCacheRequestV1;
  observation: PromptCacheRequestObservationV1;
  layers: Record<PromptCacheLayerName, string>;
}): ModelRequestProvenanceManifestV1 {
  const db = openEventLog();
  const expected = input.hostProjection;
  if (
    expected.observation.normalizedRequestDigest !== input.observation.normalizedRequestDigest
    || PROMPT_CACHE_LAYER_ORDER.some((name) => expected.layers[name] !== input.layers[name])
  ) {
    throw new ModelRequestProvenanceError('ambient_request_mutation');
  }
  const cacheEligibility = reconstructibleCacheEligibility({
    observation: input.observation,
    layers: input.layers,
  });
  const expectedCacheEligibility = reconstructibleCacheEligibility(expected);
  if (canonicalJson(cacheEligibility) !== canonicalJson(expectedCacheEligibility)) {
    throw new ModelRequestProvenanceError('ambient_request_mutation');
  }

  const source = sourceRow(db, input.sessionId, input.sourceUserSeq);
  const sourceData = parseObject(source.data_json, 'accepted_source_data_invalid');
  const acceptedText = typeof sourceData.text === 'string' ? sourceData.text : '';
  const visible = visibleStringsFromLayers(input.layers);
  if (!acceptedText || !containsText(visible, acceptedText)) {
    throw new ModelRequestProvenanceError('accepted_input_not_visible');
  }

  const preambles: PreambleRef[] = [];
  for (const event of listEvents(input.sessionId, { types: ['conversation_preamble'] })) {
    if (event.data.sourceUserSeq !== input.sourceUserSeq) continue;
    const delivery = conversationPreambleDeliveryRequest(event);
    if (!containsText(visible, delivery.text)) continue;
    preambles.push({
      eventId: event.id,
      eventDigest: delivery.eventDigest,
      deliveryKey: delivery.deliveryKey,
      visibleTextSha256: sha256(delivery.text),
    });
  }

  const verifiedMemory: MemoryRef[] = [];
  const memoryLayer = memoryBearingStringsFromLayers(input.layers);
  const visibleMemoryCount = visibleMemoryMarkerCount(memoryLayer);
  // Join on the SOURCE identity, never on `turn`.
  //
  // `turn` is not stable across one exchange: live 2026-08-28 a single request
  // wrote user_input_received at turn 1 and its primer at turn 2, so this
  // lookup found nothing, and a primer that was correct in every respect
  // (injected, real recallId, matching hash, real memory_recall_runs row) read
  // as absent. Every other store here joins on session_id + source_user_seq.
  //
  // The seq fallback covers primers written before this field existed: use
  // only the earliest legacy (identity-less) primer after the source event and
  // before the session's next accepted user source.
  const memoryEvent = (db.prepare(`
    SELECT * FROM events
     WHERE session_id = ?
       AND type = 'turn_memory_primer'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
     ORDER BY seq DESC LIMIT 1
  `).get(input.sessionId, input.sourceUserSeq) as RawEventRow | undefined)
    ?? (db.prepare(`
    SELECT primer.* FROM events AS primer
     WHERE primer.session_id = ?
       AND primer.type = 'turn_memory_primer'
       AND primer.seq >= ?
       AND json_extract(primer.data_json, '$.sourceUserSeq') IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM events AS next_source
          WHERE next_source.session_id = primer.session_id
            AND next_source.role = 'user'
            AND next_source.type = 'user_input_received'
            AND next_source.seq > ?
            AND next_source.seq < primer.seq
       )
     ORDER BY primer.seq ASC LIMIT 1
  `).get(
    input.sessionId,
    input.sourceUserSeq,
    input.sourceUserSeq,
  ) as RawEventRow | undefined);
  if (visibleMemoryCount > 0) {
    if (!memoryEvent) throw new ModelRequestProvenanceError('ambient_unproven_memory');
    const data = parseObject(memoryEvent.data_json, 'memory_event_invalid');
    const recallId = typeof data.recallId === 'string' ? data.recallId.trim() : '';
    const visibleTextSha256 = typeof data.visibleTextSha256 === 'string'
      ? data.visibleTextSha256
      : '';
    if (data.injected !== true || !recallId || !SHA256.test(visibleTextSha256)) {
      throw new ModelRequestProvenanceError('ambient_unproven_memory');
    }
    const recall = openMemoryDb().prepare(`
      SELECT id, objective, surface, answerability, candidate_refs_json,
             created_at, expires_at, session_id
        FROM memory_recall_runs WHERE id = ?
    `).get(recallId) as Record<string, unknown> | undefined;
    if (!recall || recall.session_id !== input.sessionId) {
      throw new ModelRequestProvenanceError('verified_memory_source_missing');
    }
    if (visibleMemoryCount !== 1) {
      throw new ModelRequestProvenanceError('ambiguous_memory_projection');
    }
    const declaredBytes = Number(data.injectedBytes);
    const text = visibleMemoryPrimer({ strings: memoryLayer, declaredBytes });
    if (!text) throw new ModelRequestProvenanceError('memory_projection_size_mismatch');
    if (sha256(text) !== visibleTextSha256) {
      throw new ModelRequestProvenanceError('memory_projection_digest_mismatch');
    }
    verifiedMemory.push({
      eventId: memoryEvent.id,
      eventDigest: eventDigest(memoryEvent),
      recallId,
      recallDigest: digestJson(recall),
      visibleTextSha256: sha256(text),
      visibleTextBytes: Buffer.byteLength(text, 'utf8'),
    });
  } else if (memoryEvent) {
    // The primer is optional model context, not accepted-source authority. A
    // durable event may truthfully say it was prepared while a later exact host
    // projection omits it (for example after the narrow recovery below). There
    // are no model-visible primer bytes to cite in that request, so retain an
    // empty verifiedMemory manifest instead of converting absence into a gate.
    parseObject(memoryEvent.data_json, 'memory_event_invalid');
  }

  const disclosedRefs: EventRef[] = [];
  const disclosureRows = db.prepare(`
    SELECT * FROM events
     WHERE session_id = ?
       AND type IN ('capability_discovered','planning_catalog_disclosed')
       AND json_extract(data_json, '$.sourceUserSeq') = ?
     ORDER BY seq ASC
  `).all(input.sessionId, input.sourceUserSeq) as RawEventRow[];
  for (const row of disclosureRows) {
    const data = parseObject(row.data_json, 'disclosure_event_invalid');
    const refs = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === 'string' && value.startsWith('cap:')) refs.add(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(visit);
    };
    visit(data);
    disclosedRefs.push({
      eventId: row.id,
      eventDigest: eventDigest(row),
      type: row.type as EventRef['type'],
      capabilityRefs: [...refs].sort(),
    });
  }

  const settledResults: SettlementRef[] = [];
  const hostResults: HostResultRef[] = [];
  for (const result of uniqueVisibleFunctionResults(input.request.input)) {
    const settlements = db.prepare(`
      SELECT session_id, source_user_seq, logical_tool_call_id,
             protocol_version, semantic_digest, execution_kind, outcome_kind,
             outcome_evidence, provider_status, outcome_detail, business_call,
             mutating, requirement_id, continues_requirement, recovery_action,
             retry_same_candidate, eliminates_candidate, discovery_epoch_requested,
             requires_reconciliation, progress_key_digest, progress_claimed,
             physical_crossing_count, physical_crossings_digest, observer_lane,
             observer_call_id, settlement_event_id, settled_at, result_handle_id
        FROM logical_call_settlements
       WHERE session_id = ?
         AND (logical_tool_call_id = ? OR observer_call_id = ?)
       ORDER BY source_user_seq, logical_tool_call_id
    `).all(input.sessionId, result.callId, result.callId) as Record<string, unknown>[];
    if (settlements.length > 1) {
      throw new ModelRequestProvenanceError('ambiguous_tool_result_settlement');
    }
    const settlement = settlements[0];
    if (!settlement) {
      const receiptRows = hostModelResultReceiptRowsForCall(db, input.sessionId, result.callId);
      if (receiptRows.length !== 1) {
        throw new ModelRequestProvenanceError('ambient_unsettled_tool_result');
      }
      const receiptRow = receiptRows[0]!;
      const receipt = hostModelResultReceiptFromRow(receiptRow);
      const receiptSource = sourceRow(db, input.sessionId, receipt.sourceUserSeq);
      if (
        receipt.sourceUserSeq > input.sourceUserSeq
        || receipt.sourceEventId !== receiptSource.id
        || receipt.callId !== result.callId
        || receipt.toolName !== result.toolName
        || receipt.outputBytes !== result.outputBytes
        || receipt.outputSha256 !== result.outputSha256
        || !hostModelResultReceiptMatchesItem(receipt, result.item as never)
      ) throw new ModelRequestProvenanceError('host_result_projection_mismatch');
      hostResults.push({
        receiptId: receipt.receiptId,
        receiptDigest: hostModelResultReceiptDigest(receiptRow),
        sessionId: receipt.sessionId,
        sourceUserSeq: receipt.sourceUserSeq,
        sourceEventId: receipt.sourceEventId,
        batchOrdinal: receipt.batchOrdinal,
        batchId: receipt.batchId,
        callId: receipt.callId,
        toolName: receipt.toolName,
        disposition: receipt.disposition,
        outputBytes: receipt.outputBytes,
        outputSha256: receipt.outputSha256,
      });
      continue;
    }
    const resultHandleId = typeof settlement.result_handle_id === 'string'
      ? settlement.result_handle_id
      : null;
    const resultHandle = resultHandleId
      ? db.prepare(`
          SELECT handle_id, scope_kind, session_id, source_user_seq,
                 accepted_task_id, logical_tool_call_id, physical_dispatch_id,
                 continuation_chain_id, tool_name, argument_digest,
                 base_argument_digest, raw_location, raw_payload_sha256,
                 raw_byte_count, rejection_reason, success, record_path,
                 record_count, envelope_meta_json, completeness,
                 projected_records_json, status_code, continuation_ref,
                 cursor_sha256, cursor_repeated, created_at
            FROM durable_result_handles WHERE handle_id = ?
        `).get(resultHandleId) as Record<string, unknown> | undefined
      : undefined;
    if (resultHandleId && !resultHandle) {
      throw new ModelRequestProvenanceError('settled_result_handle_missing');
    }
    const settlementSourceUserSeq = Number(settlement.source_user_seq);
    const settlementLogicalToolCallId = String(settlement.logical_tool_call_id);
    const projectionRows = logicalModelResultProjectionReceiptRowsForCall(
      db,
      input.sessionId,
      result.callId,
    );
    if (projectionRows.length > 1) {
      throw new ModelRequestProvenanceError('logical_result_projection_ambiguous');
    }
    const projectionReceipt = projectionRows[0]
      ? logicalModelResultProjectionReceiptFromRow(projectionRows[0])
      : null;
    if (projectionReceipt) {
      if (
        projectionReceipt.sessionId !== input.sessionId
        || projectionReceipt.sourceUserSeq !== settlementSourceUserSeq
        || projectionReceipt.sourceUserSeq > input.sourceUserSeq
        || projectionReceipt.callId !== result.callId
        || projectionReceipt.toolName !== result.toolName
        || projectionReceipt.callNamespace !== result.callNamespace
        || projectionReceipt.settlementLogicalToolCallId !== settlementLogicalToolCallId
        || projectionReceipt.settlementSemanticDigest !== settlement.semantic_digest
        || !logicalModelResultProjectionReceiptMatchesItem(
          projectionReceipt,
          result.item as never,
        )
      ) throw new ModelRequestProvenanceError('logical_result_projection_mismatch');
    } else if (acceptedBatchAdmissionCountForResult({
      db,
      sessionId: input.sessionId,
      sourceUserSeq: settlementSourceUserSeq,
      result,
    }) !== 0) {
      // A current accepted batch cannot cross the provider boundary until the
      // exact transformed result item has its append-only v69 receipt. Legacy
      // histories with no accepted batch retain their settlement provenance.
      throw new ModelRequestProvenanceError('logical_result_projection_missing');
    }
    settledResults.push({
      sessionId: String(settlement.session_id),
      sourceUserSeq: settlementSourceUserSeq,
      visibleCallId: result.callId,
      logicalToolCallId: settlementLogicalToolCallId,
      settlementDigest: digestJson(settlement),
      resultHandleId,
      resultHandleDigest: resultHandle ? digestJson(resultHandle) : null,
      ...(projectionReceipt
        ? {
            projectionReceiptId: projectionReceipt.receiptId,
            projectionReceiptDigest: projectionReceipt.receiptDigest,
          }
        : {}),
    });
  }

  const authority = authorityIdentity(db, input.sessionId, input.sourceUserSeq);
  const snapshot = catalogSnapshot(db, input.sessionId, input.sourceUserSeq);
  return {
    version: MODEL_REQUEST_PROVENANCE_VERSION,
    source: {
      eventId: source.id,
      eventDigest: acceptedSourceDigest(source),
      turn: source.turn,
      visibleTextSha256: sha256(acceptedText),
    },
    hostProjectionDigest: expected.observation.normalizedRequestDigest,
    cacheEligibility,
    layers: input.observation.layers,
    preambles,
    verifiedMemory,
    disclosedRefs,
    settledResults,
    hostResults,
    toolSchemas: {
      authorityDigest: authority.authorityDigest,
      authorityIdentityDigest: authority.identityDigest,
      catalogSnapshotDigest: snapshot?.digest ?? null,
      catalogSnapshotRowDigest: snapshot?.rowDigest ?? null,
      schemaDigests: schemaRefs(input.request),
    },
  };
}

function validPayloadReference(value: unknown): value is AuthorityEncryptedPayloadReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<AuthorityEncryptedPayloadReference>;
  return row.version === 1
    && row.payloadKind === 'model_request_snapshot'
    && typeof row.payloadId === 'string'
    && typeof row.bindingDigest === 'string' && SHA256.test(row.bindingDigest)
    && typeof row.plaintextSha256 === 'string' && SHA256.test(row.plaintextSha256)
    && Number.isSafeInteger(row.plaintextBytes) && Number(row.plaintextBytes) >= 0
    && Number.isSafeInteger(row.chunkCount) && Number(row.chunkCount) >= 0
    && typeof row.sealedFileSha256 === 'string' && SHA256.test(row.sealedFileSha256)
    && Number.isSafeInteger(row.sealedFileBytes) && Number(row.sealedFileBytes) > 0;
}

export function recordModelRequestProvenance(
  input: RecordModelRequestProvenanceInput,
): RecordedModelRequestProvenance {
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0
  ) throw new ModelRequestProvenanceError('identity_invalid');
  const db = openEventLog();
  const requestOrdinal = Number((db.prepare(`
    SELECT COALESCE(MAX(request_ordinal), 0) + 1 AS next_ordinal
      FROM model_request_provenance
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as { next_ordinal: number }).next_ordinal);
  if (!Number.isSafeInteger(requestOrdinal) || requestOrdinal <= 0) {
    throw new ModelRequestProvenanceError('request_ordinal_invalid');
  }
  const canonical = canonicalPromptCacheRequest(input.request);
  const manifest = buildManifest({ ...input, ...canonical });
  const provenanceJson = canonicalJson(manifest);
  const provenanceDigest = sha256(provenanceJson);
  const recordId = `model-request:${randomUUID()}`;
  const bindingDigest = digestJson({
    protocol: 'model_request_provenance_v1',
    recordId,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    requestOrdinal,
    normalizedRequestDigest: canonical.observation.normalizedRequestDigest,
    hostProjectionDigest: manifest.hostProjectionDigest,
    provenanceDigest,
  });
  const payloadBytes = Buffer.from(canonicalJson({
    version: MODEL_REQUEST_PROVENANCE_VERSION,
    boundary: canonical.observation.boundary,
    layers: canonical.layers,
  }), 'utf8');
  const payloadReference = persistAuthorityEncryptedPayload({
    payloadKind: 'model_request_snapshot',
    bindingDigest,
    bytes: payloadBytes,
  });
  try {
    db.prepare(`
      INSERT INTO model_request_provenance
        (record_id, session_id, source_user_seq, source_event_id,
         request_ordinal, protocol_version, boundary,
         normalized_request_digest, host_projection_digest,
         provenance_digest, provenance_json, payload_id,
         payload_binding_digest, payload_reference_json, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordId,
      input.sessionId,
      input.sourceUserSeq,
      manifest.source.eventId,
      requestOrdinal,
      canonical.observation.boundary,
      canonical.observation.normalizedRequestDigest,
      manifest.hostProjectionDigest,
      provenanceDigest,
      provenanceJson,
      payloadReference.payloadId,
      bindingDigest,
      canonicalJson(payloadReference),
      new Date().toISOString(),
    );
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: model_request_provenance.session_id')) {
      throw new ModelRequestProvenanceError('request_ordinal_conflict');
    }
    throw error;
  }
  return {
    recordId,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    requestOrdinal,
    normalizedRequestDigest: canonical.observation.normalizedRequestDigest,
    hostProjectionDigest: manifest.hostProjectionDigest,
    provenanceDigest,
    payloadReference,
  };
}

function exactWholeTurnMemoryPrimerIndex(request: ModelRequest): number | null {
  if (!Array.isArray(request.input)) return null;
  const canonical = canonicalPromptCacheRequest(request);
  const memoryStrings = memoryBearingStringsFromLayers(canonical.layers);
  if (visibleMemoryMarkerCount(memoryStrings) !== 1) return null;

  let match: number | null = null;
  for (const [index, candidate] of request.input.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as unknown as Record<string, unknown>;
    const keys = Object.keys(item);
    if (
      keys.some((key) => key !== 'type' && key !== 'role' && key !== 'content')
      || (item.type !== undefined && item.type !== 'message')
      || item.role !== 'system'
      || typeof item.content !== 'string'
      || !item.content.startsWith(MEMORY_PRIMER_MARKER)
      || visibleMemoryMarkerCount([item.content]) !== 1
    ) continue;
    if (match !== null) return null;
    match = index;
  }
  return match;
}

function removeExactWholeTurnMemoryPrimer(request: ModelRequest): boolean {
  const index = exactWholeTurnMemoryPrimerIndex(request);
  if (index === null || !Array.isArray(request.input)) return false;
  const sanitizedInput = request.input.filter((_, candidateIndex) => candidateIndex !== index);
  const sanitized = { ...request, input: sanitizedInput };
  const canonical = canonicalPromptCacheRequest(sanitized);
  if (visibleMemoryMarkerCount(memoryBearingStringsFromLayers(canonical.layers)) !== 0) return false;
  request.input = sanitizedInput;
  return true;
}

/**
 * Record the exact provider-bound request or throw before model I/O.
 *
 * This function intentionally mutates `request.input` in one case only: after
 * the original request has already matched the caller's synchronous host
 * projection, one complete, grammar-identified automatic primer item may be
 * removed when its durable source linkage is unprovable. The sanitized request
 * is then canonicalized and durably recorded before returning. Every other
 * provenance, database, encryption, or persistence failure is terminal at this
 * boundary and propagates to the caller.
 */
export function recordModelRequestDispatchProvenance(
  input: RecordModelRequestProvenanceInput,
): ModelRequestDispatchProvenance {
  try {
    return {
      record: recordModelRequestProvenance(input),
      removedOptionalLayer: null,
    };
  } catch (error) {
    if (!(error instanceof ModelRequestProvenanceError)) {
      throw new ModelRequestProvenanceError('provenance_record_unavailable', { cause: error });
    }
    if (
      !REMOVABLE_OPTIONAL_MEMORY_FAILURES.has(error.code)
      || !removeExactWholeTurnMemoryPrimer(input.request)
    ) throw error;
  }

  try {
    return {
      record: recordModelRequestProvenance({
        ...input,
        hostProjection: canonicalPromptCacheRequest(input.request),
      }),
      removedOptionalLayer: 'turn_memory_primer',
    };
  } catch (error) {
    if (error instanceof ModelRequestProvenanceError) throw error;
    throw new ModelRequestProvenanceError('provenance_record_unavailable', { cause: error });
  }
}

function parseManifest(json: string): ModelRequestProvenanceManifestV1 {
  const value = parseObject(json, 'provenance_manifest_invalid') as unknown as ModelRequestProvenanceManifestV1;
  if (
    value.version !== MODEL_REQUEST_PROVENANCE_VERSION
    || !value.source || !SHA256.test(value.source.eventDigest)
    || !SHA256.test(value.hostProjectionDigest)
    || !value.cacheEligibility
    || typeof value.cacheEligibility.cacheEligible !== 'boolean'
    || (value.cacheEligibility.policyRevision !== null
      && (typeof value.cacheEligibility.policyRevision !== 'string'
        || !SHA256.test(value.cacheEligibility.policyRevision)))
    || !Array.isArray(value.cacheEligibility.issues)
    || value.cacheEligibility.issues.some((issue) => typeof issue !== 'string')
    || !value.layers
    || !Array.isArray(value.preambles)
    || !Array.isArray(value.verifiedMemory)
    || !Array.isArray(value.disclosedRefs)
    || !Array.isArray(value.settledResults)
    || !Array.isArray(value.hostResults)
    || !value.toolSchemas
  ) throw new ModelRequestProvenanceError('provenance_manifest_invalid');
  return value;
}

function validateManifestSources(input: {
  manifest: ModelRequestProvenanceManifestV1;
  layers: Record<PromptCacheLayerName, string>;
  sessionId: string;
  sourceUserSeq: number;
}): void {
  const db = openEventLog();
  const visible = visibleStringsFromLayers(input.layers);
  const source = sourceRow(db, input.sessionId, input.sourceUserSeq);
  const sourceData = parseObject(source.data_json, 'accepted_source_data_invalid');
  const acceptedText = typeof sourceData.text === 'string' ? sourceData.text : '';
  if (
    source.id !== input.manifest.source.eventId
    || acceptedSourceDigest(source) !== input.manifest.source.eventDigest
    || sha256(acceptedText) !== input.manifest.source.visibleTextSha256
    || !containsText(visible, acceptedText)
  ) throw new ModelRequestProvenanceError('accepted_source_projection_mismatch');

  for (const ref of input.manifest.preambles) {
    const event = listEvents(input.sessionId, { types: ['conversation_preamble'] })
      .find((candidate) => candidate.id === ref.eventId);
    if (!event) throw new ModelRequestProvenanceError('preamble_source_missing');
    const delivery = conversationPreambleDeliveryRequest(event);
    if (
      delivery.eventDigest !== ref.eventDigest
      || delivery.deliveryKey !== ref.deliveryKey
      || sha256(delivery.text) !== ref.visibleTextSha256
      || !containsText(visible, delivery.text)
    ) throw new ModelRequestProvenanceError('preamble_projection_mismatch');
  }

  const memoryLayer = memoryBearingStringsFromLayers(input.layers);
  const visibleMemoryCount = visibleMemoryMarkerCount(memoryLayer);
  if (visibleMemoryCount !== input.manifest.verifiedMemory.length) {
    throw new ModelRequestProvenanceError('memory_projection_count_mismatch');
  }
  for (const ref of input.manifest.verifiedMemory) {
    const event = rawEvent(db, ref.eventId);
    if (!event || eventDigest(event) !== ref.eventDigest) {
      throw new ModelRequestProvenanceError('memory_event_mismatch');
    }
    const data = parseObject(event.data_json, 'memory_event_invalid');
    const visibleText = visibleMemoryPrimer({ strings: memoryLayer, declaredBytes: ref.visibleTextBytes });
    const recall = openMemoryDb().prepare(`
      SELECT id, objective, surface, answerability, candidate_refs_json,
             created_at, expires_at, session_id
        FROM memory_recall_runs WHERE id = ?
    `).get(ref.recallId) as Record<string, unknown> | undefined;
    if (
      data.injected !== true
      || data.recallId !== ref.recallId
      || Number(data.injectedBytes) !== ref.visibleTextBytes
      || data.visibleTextSha256 !== ref.visibleTextSha256
      || !recall
      || digestJson(recall) !== ref.recallDigest
      || !visibleText
      || sha256(visibleText) !== ref.visibleTextSha256
      || Buffer.byteLength(visibleText, 'utf8') !== ref.visibleTextBytes
    ) throw new ModelRequestProvenanceError('verified_memory_projection_mismatch');
  }

  for (const ref of input.manifest.disclosedRefs) {
    const event = rawEvent(db, ref.eventId);
    if (!event || event.type !== ref.type || eventDigest(event) !== ref.eventDigest) {
      throw new ModelRequestProvenanceError('disclosed_ref_mismatch');
    }
  }

  const projectedTask = JSON.parse(input.layers.task) as Record<string, unknown>;
  const results = uniqueVisibleFunctionResults(projectedTask.input);
  const resultsByCallId = new Map(results.map((result) => [result.callId, result]));
  const citedCallIds = [
    ...input.manifest.settledResults.map((ref) => ref.visibleCallId),
    ...input.manifest.hostResults.map((ref) => ref.callId),
  ];
  if (
    results.length !== citedCallIds.length
    || new Set(citedCallIds).size !== citedCallIds.length
  ) {
    throw new ModelRequestProvenanceError('tool_result_count_mismatch');
  }
  for (const ref of input.manifest.settledResults) {
    const result = resultsByCallId.get(ref.visibleCallId);
    if (!result) {
      throw new ModelRequestProvenanceError('settled_result_not_visible');
    }
    const settlement = db.prepare(`
      SELECT session_id, source_user_seq, logical_tool_call_id,
             protocol_version, semantic_digest, execution_kind, outcome_kind,
             outcome_evidence, provider_status, outcome_detail, business_call,
             mutating, requirement_id, continues_requirement, recovery_action,
             retry_same_candidate, eliminates_candidate, discovery_epoch_requested,
             requires_reconciliation, progress_key_digest, progress_claimed,
             physical_crossing_count, physical_crossings_digest, observer_lane,
             observer_call_id, settlement_event_id, settled_at, result_handle_id
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(ref.sessionId, ref.sourceUserSeq, ref.logicalToolCallId) as Record<string, unknown> | undefined;
    if (!settlement || digestJson(settlement) !== ref.settlementDigest) {
      throw new ModelRequestProvenanceError('settlement_source_mismatch');
    }
    if (ref.resultHandleId) {
      const handle = db.prepare(`
        SELECT handle_id, scope_kind, session_id, source_user_seq,
               accepted_task_id, logical_tool_call_id, physical_dispatch_id,
               continuation_chain_id, tool_name, argument_digest,
               base_argument_digest, raw_location, raw_payload_sha256,
               raw_byte_count, rejection_reason, success, record_path,
               record_count, envelope_meta_json, completeness,
               projected_records_json, status_code, continuation_ref,
               cursor_sha256, cursor_repeated, created_at
          FROM durable_result_handles WHERE handle_id = ?
      `).get(ref.resultHandleId) as Record<string, unknown> | undefined;
      if (!handle || digestJson(handle) !== ref.resultHandleDigest) {
        throw new ModelRequestProvenanceError('result_handle_source_mismatch');
      }
    }
    const projectionRows = logicalModelResultProjectionReceiptRowsForCall(
      db,
      ref.sessionId,
      ref.visibleCallId,
    );
    if (projectionRows.length > 1) {
      throw new ModelRequestProvenanceError('logical_result_projection_ambiguous');
    }
    const projectionReceipt = projectionRows[0]
      ? logicalModelResultProjectionReceiptFromRow(projectionRows[0])
      : null;
    const manifestCitesProjection = ref.projectionReceiptId !== undefined
      || ref.projectionReceiptDigest !== undefined;
    if (
      manifestCitesProjection
      && (
        typeof ref.projectionReceiptId !== 'string'
        || typeof ref.projectionReceiptDigest !== 'string'
        || !SHA256.test(ref.projectionReceiptId)
        || !SHA256.test(ref.projectionReceiptDigest)
      )
    ) throw new ModelRequestProvenanceError('logical_result_projection_ref_invalid');
    if (projectionReceipt) {
      if (
        projectionReceipt.sessionId !== ref.sessionId
        || projectionReceipt.sourceUserSeq !== ref.sourceUserSeq
        || projectionReceipt.sourceUserSeq > input.sourceUserSeq
        || projectionReceipt.callId !== ref.visibleCallId
        || projectionReceipt.toolName !== result.toolName
        || projectionReceipt.callNamespace !== result.callNamespace
        || projectionReceipt.settlementLogicalToolCallId !== ref.logicalToolCallId
        || projectionReceipt.settlementSemanticDigest !== settlement.semantic_digest
        || !logicalModelResultProjectionReceiptMatchesItem(
          projectionReceipt,
          result.item as never,
        )
        || (manifestCitesProjection
          && (
            ref.projectionReceiptId !== projectionReceipt.receiptId
            || ref.projectionReceiptDigest !== projectionReceipt.receiptDigest
          ))
      ) throw new ModelRequestProvenanceError('logical_result_projection_source_mismatch');
    } else if (
      manifestCitesProjection
      || acceptedBatchAdmissionCountForResult({
        db,
        sessionId: ref.sessionId,
        sourceUserSeq: ref.sourceUserSeq,
        result,
      }) !== 0
    ) {
      throw new ModelRequestProvenanceError('logical_result_projection_source_missing');
    }
  }

  for (const ref of input.manifest.hostResults) {
    const result = resultsByCallId.get(ref.callId);
    if (!result) throw new ModelRequestProvenanceError('host_result_not_visible');
    const settlements = db.prepare(`
      SELECT 1 FROM logical_call_settlements
       WHERE session_id = ?
         AND (logical_tool_call_id = ? OR observer_call_id = ?)
       LIMIT 1
    `).all(ref.sessionId, ref.callId, ref.callId);
    if (settlements.length > 0) {
      throw new ModelRequestProvenanceError('host_result_superseded_by_settlement');
    }
    const logical = db.prepare(`
      SELECT 1 FROM logical_tool_calls
       WHERE session_id = ? AND logical_tool_call_id = ?
       LIMIT 1
    `).get(ref.sessionId, ref.callId);
    if (logical) throw new ModelRequestProvenanceError('host_result_has_business_identity');
    const rows = hostModelResultReceiptRowsForCall(db, ref.sessionId, ref.callId);
    if (rows.length !== 1) throw new ModelRequestProvenanceError('host_result_source_ambiguous');
    const row = rows[0]!;
    const receipt = hostModelResultReceiptFromRow(row);
    const receiptSource = sourceRow(db, ref.sessionId, ref.sourceUserSeq);
    if (
      ref.sessionId !== input.sessionId
      || ref.sourceUserSeq > input.sourceUserSeq
      || ref.receiptId !== receipt.receiptId
      || ref.receiptDigest !== hostModelResultReceiptDigest(row)
      || ref.sourceEventId !== receipt.sourceEventId
      || receiptSource.id !== receipt.sourceEventId
      || ref.batchOrdinal !== receipt.batchOrdinal
      || ref.batchId !== receipt.batchId
      || ref.callId !== receipt.callId
      || ref.toolName !== receipt.toolName
      || ref.disposition !== receipt.disposition
      || ref.outputBytes !== receipt.outputBytes
      || ref.outputSha256 !== receipt.outputSha256
      || result.toolName !== receipt.toolName
      || result.outputBytes !== receipt.outputBytes
      || result.outputSha256 !== receipt.outputSha256
      || !hostModelResultReceiptMatchesItem(receipt, result.item as never)
    ) throw new ModelRequestProvenanceError('host_result_source_mismatch');
  }

  const authority = authorityIdentity(db, input.sessionId, input.sourceUserSeq);
  if (
    authority.authorityDigest !== input.manifest.toolSchemas.authorityDigest
    || authority.identityDigest !== input.manifest.toolSchemas.authorityIdentityDigest
  ) throw new ModelRequestProvenanceError('tool_schema_authority_mismatch');
  // The accepted-source snapshot may legitimately be frozen after an earlier
  // request was recorded. Absence in that earlier manifest is historical and
  // cannot be invalidated by the later append. Once a request cites a snapshot,
  // however, restart projection requires that exact immutable row.
  if (input.manifest.toolSchemas.catalogSnapshotDigest !== null) {
    const snapshot = catalogSnapshot(db, input.sessionId, input.sourceUserSeq);
    if (
      !snapshot
      || snapshot.digest !== input.manifest.toolSchemas.catalogSnapshotDigest
      || snapshot.rowDigest !== input.manifest.toolSchemas.catalogSnapshotRowDigest
    ) throw new ModelRequestProvenanceError('tool_schema_catalog_mismatch');
  } else if (input.manifest.toolSchemas.catalogSnapshotRowDigest !== null) {
    throw new ModelRequestProvenanceError('tool_schema_catalog_mismatch');
  }
  const catalog = JSON.parse(input.layers.catalog) as { tools?: unknown };
  const schemas = schemaRefs({ tools: catalog.tools } as ModelRequest);
  if (canonicalJson(schemas) !== canonicalJson(input.manifest.toolSchemas.schemaDigests)) {
    throw new ModelRequestProvenanceError('tool_schema_bytes_mismatch');
  }
}

/** Reopen, authenticate, and independently rebuild one exact normalized model
 * request after the eventlog and memory stores have been closed/reopened. */
export function projectModelRequestProvenance(recordId: string): ModelRequestProjection {
  try {
    const db = openEventLog();
    const row = db.prepare(`
      SELECT record_id, session_id, source_user_seq, source_event_id,
             request_ordinal, protocol_version, boundary,
             normalized_request_digest, host_projection_digest,
             provenance_digest, provenance_json, payload_id,
             payload_binding_digest, payload_reference_json
        FROM model_request_provenance WHERE record_id = ?
    `).get(recordId) as Record<string, unknown> | undefined;
    if (!row || row.protocol_version !== MODEL_REQUEST_PROVENANCE_VERSION) {
      return { status: 'invalid', reason: 'record_missing' };
    }
    const manifest = parseManifest(String(row.provenance_json));
    const provenanceJson = canonicalJson(manifest);
    if (
      sha256(provenanceJson) !== row.provenance_digest
      || manifest.hostProjectionDigest !== row.host_projection_digest
    ) throw new ModelRequestProvenanceError('provenance_digest_mismatch');
    const reference = JSON.parse(String(row.payload_reference_json)) as unknown;
    if (
      !validPayloadReference(reference)
      || reference.payloadId !== row.payload_id
      || reference.bindingDigest !== row.payload_binding_digest
    ) throw new ModelRequestProvenanceError('payload_reference_invalid');
    const opened = readAuthorityEncryptedPayload({
      reference,
      payloadKind: 'model_request_snapshot',
      bindingDigest: String(row.payload_binding_digest),
    });
    if (opened.status !== 'ok') throw new ModelRequestProvenanceError(`payload_${opened.status}`);
    const payload = parseObject(opened.bytes.toString('utf8'), 'payload_invalid');
    if (payload.version !== MODEL_REQUEST_PROVENANCE_VERSION) {
      throw new ModelRequestProvenanceError('payload_version_invalid');
    }
    const boundary = payload.boundary;
    if (boundary !== 'whole_instructions' && boundary !== 'layered') {
      throw new ModelRequestProvenanceError('payload_boundary_invalid');
    }
    if (!payload.layers || typeof payload.layers !== 'object' || Array.isArray(payload.layers)) {
      throw new ModelRequestProvenanceError('payload_layers_invalid');
    }
    const candidate = payload.layers as Record<string, unknown>;
    const layers = Object.fromEntries(PROMPT_CACHE_LAYER_ORDER.map((name) => {
      const value = candidate[name];
      if (typeof value !== 'string') throw new ModelRequestProvenanceError('payload_layers_invalid');
      return [name, value];
    })) as Record<PromptCacheLayerName, string>;
    if (Object.keys(candidate).length !== PROMPT_CACHE_LAYER_ORDER.length) {
      throw new ModelRequestProvenanceError('ambient_unlogged_layer');
    }
    const digest = promptCacheNormalizedRequestDigest({ boundary, layers });
    if (
      digest !== row.normalized_request_digest
      || digest !== manifest.hostProjectionDigest
    ) throw new ModelRequestProvenanceError('normalized_request_digest_mismatch');
    for (const name of PROMPT_CACHE_LAYER_ORDER) {
      const expected = manifest.layers[name];
      if (
        !expected
        || expected.bytes !== Buffer.byteLength(layers[name], 'utf8')
        || expected.sha256 !== sha256(layers[name])
      ) throw new ModelRequestProvenanceError('layer_digest_mismatch');
    }
    const cacheEligibility = projectedCacheEligibility({ boundary, layers });
    if (canonicalJson(cacheEligibility) !== canonicalJson(manifest.cacheEligibility)) {
      throw new ModelRequestProvenanceError('cache_eligibility_mismatch');
    }
    validateManifestSources({
      manifest,
      layers,
      sessionId: String(row.session_id),
      sourceUserSeq: Number(row.source_user_seq),
    });
    return {
      status: 'ok',
      record: {
        recordId: String(row.record_id),
        sessionId: String(row.session_id),
        sourceUserSeq: Number(row.source_user_seq),
        requestOrdinal: Number(row.request_ordinal),
        normalizedRequestDigest: digest,
        hostProjectionDigest: String(row.host_projection_digest),
        provenanceDigest: String(row.provenance_digest),
        payloadReference: reference,
      },
      boundary,
      cacheEligibility,
      layers,
      manifest,
    };
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof ModelRequestProvenanceError ? error.code : 'projection_failed',
    };
  }
}
