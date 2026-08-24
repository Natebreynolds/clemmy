/**
 * Durable, source-bound semantic-learning intake.
 *
 * The harness event log remains the only execution/result/terminal authority.
 * This module reads committed `conversation_completed` events and their exact
 * logical settlements/result handles, then writes an idempotent projection to
 * the memory database. It never runs a model and never participates in task
 * completion. Missing projection rows remain discoverable from the canonical
 * terminal cursor after restart; there is no process-local producer queue.
 */
import { createHash } from 'node:crypto';
import { openMemoryDb } from './db.js';
import { canonicalRef, upsertResourcePointer, type UpsertResourceInput } from './source-map.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { redeemSuccessfulSettlementResultForHost } from '../runtime/harness/result-handle.js';
import { verifyCanonicalDocumentedCreateResult } from '../runtime/harness/documented-create-result-evidence.js';
import { digestToolOutput } from '../runtime/harness/tool-output-digest.js';
import { presentationEventFromCompletionData } from '../runtime/harness/turn-outcome.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';

const TERMINAL_SCAN_LIMIT = 24;
const SELECTED_SOURCE_MAX_CHARS = 3_000;
const SHARD_CONTENT_MAX_CHARS = 2_000;
const MIN_UNSTRUCTURED_CHARS = 800;

export type MemoryLearningDisposition =
  | 'structured_task_evidence'
  | 'resource_pointer'
  | 'unstructured'
  | 'control'
  | 'failed'
  | 'write_ack'
  | 'empty'
  | 'unavailable';

interface TerminalRow {
  terminal_event_rowid: number;
  terminal_event_id: string;
  session_id: string;
  data_json: string;
}

interface TerminalSource {
  terminalEventRowid: number;
  terminalEventId: string;
  terminalDigest: string;
  sessionId: string;
  sourceUserSeq: number;
}

interface SettlementRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  logical_tool_call_id: string;
  tool_name: string;
  outcome_kind: string;
  mutating: number;
  result_handle_id: string | null;
  settled_at: string;
  resolved_tool: string | null;
  effect_kind: string | null;
}

interface ResourceProjection {
  pointer: UpsertResourceInput;
  ref: string;
}

interface ClassifiedMember {
  ordinal: number;
  logicalToolCallId: string;
  resultHandleId: string | null;
  resultDigest: string | null;
  toolName: string;
  resolvedTool: string | null;
  outcomeKind: string;
  effectKind: string | null;
  disposition: MemoryLearningDisposition;
  sourceTextDigest: string | null;
  sourceTextChars: number | null;
  selectionDigest: string | null;
  selectionChars: number | null;
  selectedText: string | null;
  resource: ResourceProjection | null;
}

export interface MemoryLearningMemberReceipt {
  memberId: string;
  batchId: string;
  ordinal: number;
  logicalToolCallId: string;
  resultHandleId: string | null;
  resultDigest: string | null;
  toolName: string;
  resolvedTool: string | null;
  outcomeKind: string;
  effectKind: string | null;
  disposition: MemoryLearningDisposition;
  sourceTextDigest: string | null;
  sourceTextChars: number | null;
  selectionDigest: string | null;
  selectionChars: number | null;
  resourceRef: string | null;
}

export interface MemoryLearningShardSource {
  memberOrdinal: number;
  start: number;
  end: number;
  sliceDigest: string;
}

export interface MemoryLearningShardManifest {
  version: 1;
  sources: MemoryLearningShardSource[];
}

export interface TerminalLearningIntakeSummary {
  terminalsScanned: number;
  batchesCreated: number;
  batchesReplayed: number;
  membersCreated: number;
  structuredMembers: number;
  resourcePointers: number;
  unstructuredMembers: number;
  shardsCreated: number;
  skippedTerminals: number;
  failures: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function completedTerminal(row: TerminalRow): TerminalSource | null {
  let data: unknown;
  try {
    data = JSON.parse(row.data_json);
  } catch {
    return null;
  }
  let presentation: ReturnType<typeof presentationEventFromCompletionData>;
  try {
    presentation = presentationEventFromCompletionData(data);
  } catch {
    return null;
  }
  if (
    !presentation
    || presentation.status !== 'done'
    || presentation.identity.sessionId !== row.session_id
  ) return null;
  const sourceUserSeq = positiveInteger(presentation.identity.sourceUserSeq);
  if (!sourceUserSeq) return null;
  return {
    terminalEventRowid: row.terminal_event_rowid,
    terminalEventId: row.terminal_event_id,
    terminalDigest: sha256(closedCanonicalJson({
      eventId: row.terminal_event_id,
      eventRowid: row.terminal_event_rowid,
      sessionId: row.session_id,
      data,
    })),
    sessionId: row.session_id,
    sourceUserSeq,
  };
}

function isCanonicalTypedTerminal(source: TerminalSource): boolean {
  const priorRows = openEventLog().prepare(`
    SELECT rowid AS terminal_event_rowid,
           id AS terminal_event_id,
           session_id,
           data_json
      FROM events
     WHERE session_id = ?
       AND type = 'conversation_completed'
       AND rowid < ?
     ORDER BY rowid ASC
  `).all(source.sessionId, source.terminalEventRowid) as TerminalRow[];
  for (const prior of priorRows) {
    let data: unknown;
    try { data = JSON.parse(prior.data_json); } catch { continue; }
    try {
      const presentation = presentationEventFromCompletionData(data);
      if (
        presentation
        && presentation.identity.sessionId === source.sessionId
        && presentation.identity.sourceUserSeq === source.sourceUserSeq
      ) return false;
    } catch { /* malformed typed rows cannot own the canonical source */ }
  }
  return true;
}

function scanCursor(): number {
  const row = openMemoryDb().prepare(
    'SELECT terminal_event_rowid FROM memory_learning_scan_state WHERE id = 1',
  ).get() as { terminal_event_rowid: number } | undefined;
  return row?.terminal_event_rowid ?? 0;
}

function advanceScanCursor(rowid: number): void {
  openMemoryDb().prepare(`
    UPDATE memory_learning_scan_state
       SET terminal_event_rowid = MAX(terminal_event_rowid, ?), updated_at = ?
     WHERE id = 1
  `).run(rowid, new Date().toISOString());
}

function terminalRows(afterRowid: number, limit: number): TerminalRow[] {
  return openEventLog().prepare(`
    SELECT rowid AS terminal_event_rowid,
           id AS terminal_event_id,
           session_id,
           data_json
      FROM events
     WHERE rowid > ? AND type = 'conversation_completed'
     ORDER BY rowid ASC
     LIMIT ?
  `).all(afterRowid, Math.max(1, limit)) as TerminalRow[];
}

function taskSettlements(source: TerminalSource): SettlementRow[] {
  return openEventLog().prepare(`
    SELECT s.session_id, s.source_user_seq, l.accepted_task_id,
           s.logical_tool_call_id, l.tool_name, s.outcome_kind, s.mutating,
           s.result_handle_id, s.settled_at,
           o.resolved_tool, o.effect_kind
      FROM logical_call_settlements s
      JOIN logical_tool_calls l
        ON l.session_id = s.session_id
       AND l.source_user_seq = s.source_user_seq
       AND l.logical_tool_call_id = s.logical_tool_call_id
      LEFT JOIN accepted_task_operations o
        ON o.session_id = s.session_id
       AND o.source_user_seq = s.source_user_seq
       AND o.logical_tool_call_id = s.logical_tool_call_id
     WHERE s.session_id = ? AND s.source_user_seq = ?
     ORDER BY s.settled_at ASC, s.logical_tool_call_id ASC
  `).all(source.sessionId, source.sourceUserSeq) as SettlementRow[];
}

function toolTail(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().split('__').at(-1) ?? '';
}

function controlResult(row: SettlementRow): boolean {
  // A resolved business operation wins over its carrier (`work_call`). Only a
  // bare host/control result is excluded here.
  if (row.resolved_tool?.trim()) return false;
  const name = toolTail(row.tool_name);
  return name === 'plan_task'
    || name === 'tool_search'
    || name === 'call_tool'
    || name === 'work_call'
    || name === 'run_worker'
    || name === 'draft_plan'
    || name.startsWith('background_task')
    || name.startsWith('execution_')
    || name.startsWith('memory_');
}

function containsRecordCollection(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Array.isArray(value)) {
    const objects = value.filter((entry) => record(entry) !== null);
    if (objects.length >= 2) return true;
    return value.some((entry) => containsRecordCollection(entry, depth + 1));
  }
  const obj = record(value);
  if (!obj) return false;
  return Object.values(obj).some((entry) => containsRecordCollection(entry, depth + 1));
}

const TEXT_KEYS = new Set([
  'body', 'content', 'description', 'document', 'html', 'markdown', 'message',
  'notes', 'summary', 'text', 'transcript',
]);

function collectUnstructuredStrings(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === 'string')) {
      return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    }
    return value.flatMap((entry) => collectUnstructuredStrings(entry, depth + 1));
  }
  const obj = record(value);
  if (!obj) return [];
  const preferred = Object.entries(obj)
    .filter(([key]) => TEXT_KEYS.has(key.toLowerCase()))
    .flatMap(([, nested]) => collectUnstructuredStrings(nested, depth + 1));
  if (preferred.length > 0) return preferred;
  const longStrings = Object.values(obj)
    .filter((nested): nested is string => typeof nested === 'string' && nested.trim().length >= 300);
  return longStrings;
}

function unstructuredText(value: unknown): string | null {
  const strings = collectUnstructuredStrings(value)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (strings.length === 0) return null;
  const joined = strings.join('\n\n');
  return joined.length >= MIN_UNSTRUCTURED_CHARS ? joined : null;
}

function resourceProjection(
  row: SettlementRow,
  rawPayload: unknown,
): ResourceProjection | null {
  const verified = verifyCanonicalDocumentedCreateResult({ value: rawPayload });
  if (verified.status !== 'verified') return null;
  if (
    verified.value.binding.acceptedTaskId !== row.accepted_task_id
    || verified.value.binding.logicalToolCallId !== row.logical_tool_call_id
    || verified.value.binding.effect !== 'external_write'
  ) return null;
  const operation = verified.value.binding.operationId.trim();
  const app = (operation.split('_')[0] || 'provider').toLowerCase();
  const providerId = verified.value.created.id;
  const kind = app === 'googlesheets' ? 'sheet' : 'resource';
  const name = app === 'googlesheets'
    ? `Google Sheet ${providerId}`
    : `${app} ${providerId}`;
  const pointer: UpsertResourceInput = {
    app,
    kind,
    name,
    providerId,
    ref: verified.value.created.handle,
    whatsHere: 'Created artifact from a verified provider receipt',
    whenToUse: 'Return to the artifact created by this accepted task',
    trust: 0.95,
    source: 'reactive',
  };
  return {
    pointer,
    ref: pointer.ref ?? canonicalRef(app, kind, providerId, name),
  };
}

function classifySettlement(row: SettlementRow, ordinal: number): ClassifiedMember {
  const base: ClassifiedMember = {
    ordinal,
    logicalToolCallId: row.logical_tool_call_id,
    resultHandleId: row.result_handle_id,
    resultDigest: null,
    toolName: row.tool_name,
    resolvedTool: row.resolved_tool,
    outcomeKind: row.outcome_kind,
    effectKind: row.effect_kind,
    disposition: 'unavailable',
    sourceTextDigest: null,
    sourceTextChars: null,
    selectionDigest: null,
    selectionChars: null,
    selectedText: null,
    resource: null,
  };
  if (controlResult(row)) return { ...base, disposition: 'control' };
  if (row.outcome_kind !== 'succeeded' && row.outcome_kind !== 'empty_result') {
    return { ...base, disposition: 'failed' };
  }
  if (row.outcome_kind === 'empty_result') return { ...base, disposition: 'empty' };
  if (!row.result_handle_id) return base;

  const redeemed = redeemSuccessfulSettlementResultForHost({
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    acceptedTaskId: row.accepted_task_id,
    logicalToolCallId: row.logical_tool_call_id,
  });
  if (redeemed.status !== 'ok') return base;
  base.resultHandleId = redeemed.value.resultHandleId;
  base.resultDigest = redeemed.value.rawPayloadSha256;

  const resource = resourceProjection(row, redeemed.value.rawPayload);
  if (resource) {
    return { ...base, disposition: 'resource_pointer', resource };
  }
  if (row.mutating === 1 || row.effect_kind === 'external_write' || row.effect_kind === 'local_write') {
    return { ...base, disposition: 'write_ack' };
  }
  if (redeemed.value.handle.recordCount > 0 || containsRecordCollection(redeemed.value.rawPayload)) {
    return { ...base, disposition: 'structured_task_evidence' };
  }

  const text = unstructuredText(redeemed.value.rawPayload);
  if (!text) return { ...base, disposition: 'structured_task_evidence' };
  const effectiveTool = row.resolved_tool ?? row.tool_name;
  const selected = text.length > SELECTED_SOURCE_MAX_CHARS
    ? digestToolOutput(text, {
        maxChars: SELECTED_SOURCE_MAX_CHARS,
        toolName: effectiveTool,
        callId: row.logical_tool_call_id,
      })
    : text;
  return {
    ...base,
    disposition: 'unstructured',
    sourceTextDigest: sha256(text),
    sourceTextChars: text.length,
    selectionDigest: sha256(selected),
    selectionChars: selected.length,
    selectedText: selected,
  };
}

function balancedSegments(length: number): Array<{ start: number; end: number }> {
  if (length <= 0) return [];
  const count = Math.max(1, Math.ceil(length / SHARD_CONTENT_MAX_CHARS));
  const size = Math.ceil(length / count);
  const out: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < length; start += size) {
    out.push({ start, end: Math.min(length, start + size) });
  }
  return out;
}

function shardManifests(members: ClassifiedMember[]): MemoryLearningShardManifest[] {
  const manifests: MemoryLearningShardManifest[] = [];
  let sources: MemoryLearningShardSource[] = [];
  let usedChars = 0;
  const flush = (): void => {
    if (sources.length === 0) return;
    manifests.push({ version: 1, sources });
    sources = [];
    usedChars = 0;
  };
  for (const member of members) {
    if (member.disposition !== 'unstructured' || !member.selectedText) continue;
    for (const segment of balancedSegments(member.selectedText.length)) {
      const chars = segment.end - segment.start;
      if (usedChars > 0 && usedChars + chars > SHARD_CONTENT_MAX_CHARS) flush();
      const slice = member.selectedText.slice(segment.start, segment.end);
      sources.push({
        memberOrdinal: member.ordinal,
        start: segment.start,
        end: segment.end,
        sliceDigest: sha256(slice),
      });
      usedChars += chars;
    }
  }
  flush();
  return manifests;
}

function memberDescriptor(member: ClassifiedMember): Record<string, unknown> {
  return {
    ordinal: member.ordinal,
    logicalToolCallId: member.logicalToolCallId,
    resultHandleId: member.resultHandleId,
    resultDigest: member.resultDigest,
    toolName: member.toolName,
    resolvedTool: member.resolvedTool,
    outcomeKind: member.outcomeKind,
    effectKind: member.effectKind,
    disposition: member.disposition,
    sourceTextDigest: member.sourceTextDigest,
    sourceTextChars: member.sourceTextChars,
    selectionDigest: member.selectionDigest,
    selectionChars: member.selectionChars,
    resourceRef: member.resource?.ref ?? null,
  };
}

function memberManifest(members: ClassifiedMember[]): string {
  return closedCanonicalJson(members.map(memberDescriptor));
}

function expectedMemberId(batchId: string, member: ClassifiedMember): string {
  return `memory-member:v1:${sha256(closedCanonicalJson({
    batchId,
    ordinal: member.ordinal,
    logicalToolCallId: member.logicalToolCallId,
    resultHandleId: member.resultHandleId,
    resultDigest: member.resultDigest,
  }))}`;
}

interface ExpectedLearningShard {
  ordinal: number;
  manifestJson: string;
  manifestHash: string;
  shardId: string;
  reflectionCallId: string;
}

function expectedLearningShards(
  batchId: string,
  manifests: MemoryLearningShardManifest[],
): ExpectedLearningShard[] {
  return manifests.map((manifest, ordinal) => {
    const manifestJson = closedCanonicalJson(manifest);
    const manifestHash = sha256(manifestJson);
    const shardId = `memory-shard:v1:${sha256(closedCanonicalJson({
      batchId,
      ordinal,
      shardManifestHash: manifestHash,
    }))}`;
    return {
      ordinal,
      manifestJson,
      manifestHash,
      shardId,
      reflectionCallId: `terminal-learning:${shardId}`,
    };
  });
}

function verifyStoredBatchProjection(
  batchId: string,
  members: ClassifiedMember[],
  expectedShards: ExpectedLearningShard[],
  manifestJson: string,
): void {
  const db = openMemoryDb();
  const storedMembers = db.prepare(`
    SELECT member_id, ordinal, logical_tool_call_id, result_handle_id,
           result_digest, tool_name, resolved_tool, outcome_kind, effect_kind,
           disposition, source_text_digest, source_text_chars,
           selection_digest, selection_chars, resource_ref
      FROM memory_learning_members
     WHERE batch_id = ?
     ORDER BY ordinal
  `).all(batchId) as Array<Record<string, unknown>>;
  const storedMemberManifest = closedCanonicalJson(storedMembers.map((row) => ({
    ordinal: Number(row.ordinal),
    logicalToolCallId: String(row.logical_tool_call_id),
    resultHandleId: row.result_handle_id === null ? null : String(row.result_handle_id),
    resultDigest: row.result_digest === null ? null : String(row.result_digest),
    toolName: String(row.tool_name),
    resolvedTool: row.resolved_tool === null ? null : String(row.resolved_tool),
    outcomeKind: String(row.outcome_kind),
    effectKind: row.effect_kind === null ? null : String(row.effect_kind),
    disposition: String(row.disposition),
    sourceTextDigest: row.source_text_digest === null ? null : String(row.source_text_digest),
    sourceTextChars: row.source_text_chars === null ? null : Number(row.source_text_chars),
    selectionDigest: row.selection_digest === null ? null : String(row.selection_digest),
    selectionChars: row.selection_chars === null ? null : Number(row.selection_chars),
    resourceRef: row.resource_ref === null ? null : String(row.resource_ref),
  })));
  const storedMemberIds = storedMembers.map((row) => String(row.member_id));
  const expectedMemberIds = members.map((member) => expectedMemberId(batchId, member));
  if (
    storedMemberManifest !== manifestJson
    || closedCanonicalJson(storedMemberIds) !== closedCanonicalJson(expectedMemberIds)
  ) throw new Error('stored terminal learning members contradict their canonical source manifest');

  const storedShards = db.prepare(`
    SELECT shard_id, ordinal, manifest_json, manifest_hash, reflection_call_id
      FROM memory_learning_shards
     WHERE batch_id = ?
     ORDER BY ordinal
  `).all(batchId) as Array<{
    shard_id: string;
    ordinal: number;
    manifest_json: string;
    manifest_hash: string;
    reflection_call_id: string;
  }>;
  const comparableStored = storedShards.map((row) => ({
    ordinal: row.ordinal,
    manifestJson: row.manifest_json,
    manifestHash: row.manifest_hash,
    shardId: row.shard_id,
    reflectionCallId: row.reflection_call_id,
  }));
  if (
    closedCanonicalJson(comparableStored) !== closedCanonicalJson(expectedShards)
    || storedShards.some((row) => sha256(row.manifest_json) !== row.manifest_hash)
  ) throw new Error('stored terminal learning shards contradict their canonical source manifest');
}

function acceptedTaskId(rows: SettlementRow[]): string | null {
  const ids = [...new Set(rows.map((row) => row.accepted_task_id).filter(Boolean))];
  return ids.length === 1 ? ids[0]! : null;
}

function createBatch(
  source: TerminalSource,
  rows: SettlementRow[],
): { replayed: boolean; members: ClassifiedMember[]; shardCount: number; pointerCount: number } {
  const taskId = acceptedTaskId(rows);
  if (!taskId) throw new Error('terminal settlements do not bind exactly one accepted task');
  const members = rows.map(classifySettlement);
  const manifestJson = memberManifest(members);
  const manifestHash = sha256(manifestJson);
  const batchId = `memory-batch:v1:${sha256(closedCanonicalJson({
    acceptedTaskId: taskId,
    terminalEventId: source.terminalEventId,
    terminalDigest: source.terminalDigest,
    memberManifestHash: manifestHash,
  }))}`;
  const shardDescriptors = expectedLearningShards(batchId, shardManifests(members));
  const db = openMemoryDb();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT batch_id, terminal_digest, member_manifest_hash, member_count, shard_count
        FROM memory_learning_batches
       WHERE session_id = ? AND source_user_seq = ?
         AND accepted_task_id = ? AND terminal_event_id = ?
    `).get(source.sessionId, source.sourceUserSeq, taskId, source.terminalEventId) as {
      batch_id: string;
      terminal_digest: string;
      member_manifest_hash: string;
      member_count: number;
      shard_count: number;
    } | undefined;
    if (existing) {
      if (
        existing.batch_id !== batchId
        || existing.terminal_digest !== source.terminalDigest
        || existing.member_manifest_hash !== manifestHash
        || existing.member_count !== members.length
        || existing.shard_count !== shardDescriptors.length
      ) throw new Error('canonical terminal learning replay changed its source manifest');
      verifyStoredBatchProjection(batchId, members, shardDescriptors, manifestJson);
      return { replayed: true, members, shardCount: shardDescriptors.length, pointerCount: 0 };
    }

    db.prepare(`
      INSERT INTO memory_learning_batches
        (batch_id, session_id, source_user_seq, accepted_task_id,
         terminal_event_id, terminal_event_rowid, terminal_digest,
         member_manifest_hash, member_count, shard_count, status,
         created_at, updated_at, completed_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      batchId,
      source.sessionId,
      source.sourceUserSeq,
      taskId,
      source.terminalEventId,
      source.terminalEventRowid,
      source.terminalDigest,
      manifestHash,
      members.length,
      shardDescriptors.length,
      shardDescriptors.length === 0 ? 'completed' : 'pending',
      now,
      now,
      shardDescriptors.length === 0 ? now : null,
    );

    let pointerCount = 0;
    const insertMember = db.prepare(`
      INSERT INTO memory_learning_members
        (member_id, batch_id, ordinal, logical_tool_call_id, result_handle_id,
         result_digest, tool_name, resolved_tool, outcome_kind, effect_kind,
         disposition, source_text_digest, source_text_chars, selection_digest,
         selection_chars, resource_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const member of members) {
      let resourceRef = member.resource?.ref ?? null;
      if (member.resource) {
        const pointer = upsertResourcePointer(member.resource.pointer);
        resourceRef = pointer.ref;
        pointerCount += 1;
      }
      const memberId = expectedMemberId(batchId, member);
      insertMember.run(
        memberId,
        batchId,
        member.ordinal,
        member.logicalToolCallId,
        member.resultHandleId,
        member.resultDigest,
        member.toolName,
        member.resolvedTool,
        member.outcomeKind,
        member.effectKind,
        member.disposition,
        member.sourceTextDigest,
        member.sourceTextChars,
        member.selectionDigest,
        member.selectionChars,
        resourceRef,
        now,
      );
    }

    const insertShard = db.prepare(`
      INSERT INTO memory_learning_shards
        (shard_id, batch_id, ordinal, manifest_json, manifest_hash,
         reflection_call_id, status, attempts, lease_token, lease_expires_at,
         next_attempt_at, last_error, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL, ?, ?, NULL)
    `);
    for (const shard of shardDescriptors) {
      insertShard.run(
        shard.shardId,
        batchId,
        shard.ordinal,
        shard.manifestJson,
        shard.manifestHash,
        shard.reflectionCallId,
        now,
        now,
        now,
      );
    }
    return { replayed: false, members, shardCount: shardDescriptors.length, pointerCount };
  }).immediate();
}

/**
 * Discover canonical completed terminals and materialize deterministic memory
 * intake receipts. This function performs no model/embedding work.
 */
export function discoverTerminalLearningBatches(
  limit = TERMINAL_SCAN_LIMIT,
): TerminalLearningIntakeSummary {
  const summary: TerminalLearningIntakeSummary = {
    terminalsScanned: 0,
    batchesCreated: 0,
    batchesReplayed: 0,
    membersCreated: 0,
    structuredMembers: 0,
    resourcePointers: 0,
    unstructuredMembers: 0,
    shardsCreated: 0,
    skippedTerminals: 0,
    failures: 0,
  };
  const rows = terminalRows(scanCursor(), limit);
  for (const row of rows) {
    summary.terminalsScanned += 1;
    const source = completedTerminal(row);
    if (!source || !isCanonicalTypedTerminal(source)) {
      summary.skippedTerminals += 1;
      advanceScanCursor(row.terminal_event_rowid);
      continue;
    }
    const settlements = taskSettlements(source);
    // A terminal published before any canonical settlement, or a terminal
    // whose work failed/blocked without a result, cannot teach semantic memory.
    // The terminal itself is still consumed deterministically as zero intake.
    if (settlements.length === 0) {
      summary.skippedTerminals += 1;
      advanceScanCursor(row.terminal_event_rowid);
      continue;
    }
    try {
      const created = createBatch(source, settlements);
      if (created.replayed) summary.batchesReplayed += 1;
      else {
        summary.batchesCreated += 1;
        summary.membersCreated += created.members.length;
        summary.structuredMembers += created.members.filter((member) => (
          member.disposition === 'structured_task_evidence'
        )).length;
        summary.unstructuredMembers += created.members.filter((member) => (
          member.disposition === 'unstructured'
        )).length;
        summary.resourcePointers += created.pointerCount;
        summary.shardsCreated += created.shardCount;
      }
      advanceScanCursor(row.terminal_event_rowid);
    } catch {
      // Do not advance beyond a source that failed projection. The immutable
      // terminal remains the durable retry queue and newer terminals cannot
      // silently hide it.
      summary.failures += 1;
      break;
    }
  }
  return summary;
}

export function listMemoryLearningMemberReceipts(batchId?: string): MemoryLearningMemberReceipt[] {
  const rows = (batchId
    ? openMemoryDb().prepare(`
        SELECT * FROM memory_learning_members WHERE batch_id = ? ORDER BY ordinal
      `).all(batchId)
    : openMemoryDb().prepare(`
        SELECT * FROM memory_learning_members ORDER BY created_at, ordinal
      `).all()) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    memberId: String(row.member_id),
    batchId: String(row.batch_id),
    ordinal: Number(row.ordinal),
    logicalToolCallId: String(row.logical_tool_call_id),
    resultHandleId: row.result_handle_id === null ? null : String(row.result_handle_id),
    resultDigest: row.result_digest === null ? null : String(row.result_digest),
    toolName: String(row.tool_name),
    resolvedTool: row.resolved_tool === null ? null : String(row.resolved_tool),
    outcomeKind: String(row.outcome_kind),
    effectKind: row.effect_kind === null ? null : String(row.effect_kind),
    disposition: String(row.disposition) as MemoryLearningDisposition,
    sourceTextDigest: row.source_text_digest === null ? null : String(row.source_text_digest),
    sourceTextChars: row.source_text_chars === null ? null : Number(row.source_text_chars),
    selectionDigest: row.selection_digest === null ? null : String(row.selection_digest),
    selectionChars: row.selection_chars === null ? null : Number(row.selection_chars),
    resourceRef: row.resource_ref === null ? null : String(row.resource_ref),
  }));
}

/** Deterministically rebuild the exact selected source used by a shard. */
export function selectedLearningSource(member: MemoryLearningMemberReceipt): string | null {
  if (
    member.disposition !== 'unstructured'
    || !member.resultHandleId
    || !member.resultDigest
    || !member.sourceTextDigest
    || !member.selectionDigest
  ) return null;
  const batch = openMemoryDb().prepare(`
    SELECT session_id, source_user_seq, accepted_task_id
      FROM memory_learning_batches WHERE batch_id = ?
  `).get(member.batchId) as {
    session_id: string;
    source_user_seq: number;
    accepted_task_id: string;
  } | undefined;
  if (!batch) return null;
  const redeemed = redeemSuccessfulSettlementResultForHost({
    sessionId: batch.session_id,
    sourceUserSeq: batch.source_user_seq,
    acceptedTaskId: batch.accepted_task_id,
    logicalToolCallId: member.logicalToolCallId,
  });
  if (
    redeemed.status !== 'ok'
    || redeemed.value.resultHandleId !== member.resultHandleId
    || redeemed.value.rawPayloadSha256 !== member.resultDigest
  ) return null;
  const text = unstructuredText(redeemed.value.rawPayload);
  if (!text || sha256(text) !== member.sourceTextDigest) return null;
  const selected = text.length > SELECTED_SOURCE_MAX_CHARS
    ? digestToolOutput(text, {
        maxChars: SELECTED_SOURCE_MAX_CHARS,
        toolName: member.resolvedTool ?? member.toolName,
        callId: member.logicalToolCallId,
      })
    : text;
  return sha256(selected) === member.selectionDigest ? selected : null;
}

export function memoryLearningQueueStats(): {
  batchesPending: number;
  batchesCompleted: number;
  batchesDeadLetter: number;
  shardsPending: number;
  shardsProcessing: number;
  shardsCompleted: number;
  shardsDeadLetter: number;
} {
  const db = openMemoryDb();
  const count = (table: string, status: string): number => Number((db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE status = ?`,
  ).get(status) as { count: number }).count);
  return {
    batchesPending: count('memory_learning_batches', 'pending'),
    batchesCompleted: count('memory_learning_batches', 'completed'),
    batchesDeadLetter: count('memory_learning_batches', 'dead_letter'),
    shardsPending: count('memory_learning_shards', 'pending'),
    shardsProcessing: count('memory_learning_shards', 'processing'),
    shardsCompleted: count('memory_learning_shards', 'completed'),
    shardsDeadLetter: count('memory_learning_shards', 'dead_letter'),
  };
}

export const _testOnlyLearningIntake = {
  completedTerminal,
  containsRecordCollection,
  unstructuredText,
};
