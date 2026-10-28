/**
 * A conversation's stored state as it ages: full, then compacted, then what
 * memory kept.
 *
 * The stored state is the model-input history a later turn resumes from. The
 * transcript the owner reads lives in events and is never touched here.
 *
 * - full: as the last turn left it.
 * - compacted (idle 7 days): every message kept verbatim; a tool result keeps
 *   an excerpt and a pointer to the full result; reasoning and oversized
 *   call arguments go; the provider's response chain is cut. Resuming works.
 * - memory (idle 30 days): the conversation's memory (its summary, written by
 *   the owner's memory model) and its last few messages. A chat retires only
 *   once its memory exists; a workflow or execution step needs none.
 *
 * A call whose result carries a provenance receipt (the model-visible bytes a
 * later request is checked against) keeps its call and result whole: request
 * provenance fails closed on any form of that result it cannot reverse.
 *
 * Nothing is lowered while the conversation could still be picked up where it
 * stopped: a pending approval, an unfinished run, parked or recovery state, a
 * held publication, or a pin. A history the protocol inspector does not read
 * as valid is left for its own repair path. Every change is a compare-and-swap
 * on the exact stored text, and none moves the session's update time.
 */
import type { AgentInputItem } from '@openai/agents';
import { inspectConversationProtocol } from './conversation-protocol.js';
import { getSessionConversationState, getToolOutput, openEventLog } from './eventlog.js';

export const CONVERSATION_COMPACT_IDLE_DAYS = 7;
export const CONVERSATION_MEMORY_ONLY_IDLE_DAYS = 30;
/** How long a retired conversation keeps its step records after retiring:
 * long enough for the retire itself to be noticed, since a resumed chat
 * reads its memory and tail, never these. */
export const RETIRED_WORK_RECORD_GRACE_DAYS = 1;

/** A tool result keeps this much of its text, and a call this much of its
 * arguments. */
const RESULT_EXCERPT_CHARS = 400;
const RESULT_KEEP_WHOLE_CHARS = 600;
const ARGUMENTS_KEEP_WHOLE_CHARS = 2_000;
const MEMORY_TAIL_MESSAGES = 4;
const MEMORY_TAIL_MESSAGE_CHARS = 2_000;
const HELD_METADATA_KEYS = ['__interrupt_state', '__host_recovery_state', '__held_stop_publication_debt'] as const;

type ItemRecord = Record<string, unknown>;

function record(value: unknown): ItemRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ItemRecord : null;
}

function resultHandleIn(text: string): string | null {
  return text.match(/\brh_[A-Za-z0-9_-]{6,}\b/)?.[0] ?? null;
}

function excerptText(text: string, idleDays: number): string {
  if (text.length <= RESULT_KEEP_WHOLE_CHARS) return text;
  const handle = resultHandleIn(text);
  return `${text.slice(0, RESULT_EXCERPT_CHARS)}\n[${text.length - RESULT_EXCERPT_CHARS} more characters left out after this conversation sat idle ${idleDays} days${handle ? `; the full result is ${handle}` : ''}]`;
}

/** An effect-unknown result is protocol evidence, never shortened. */
function isProtocolSynthetic(text: string): boolean {
  return text.includes('"protocol"') && text.includes('"disposition"');
}

/**
 * The compacted form of a history: same messages, same call pairs, smaller
 * results. Pure; `changed` is false when nothing was larger than its keep.
 */
export function compactConversationItems(
  items: readonly AgentInputItem[],
  idleDays = CONVERSATION_COMPACT_IDLE_DAYS,
  keepWhole: (callId: string) => boolean = () => false,
): {
  items: AgentInputItem[];
  changed: boolean;
} {
  let changed = false;
  const out: AgentInputItem[] = [];
  for (const item of items) {
    const value = record(item);
    if (!value) { out.push(item); continue; }
    if (typeof value.callId === 'string' && keepWhole(value.callId)) { out.push(item); continue; }
    if (value.type === 'reasoning') { changed = true; continue; }
    if (value.type === 'function_call' && typeof value.arguments === 'string'
      && value.arguments.length > ARGUMENTS_KEEP_WHOLE_CHARS) {
      changed = true;
      out.push({ ...value, arguments: JSON.stringify({ compacted: `${value.arguments.length} characters of arguments left out after this conversation sat idle ${idleDays} days` }) } as AgentInputItem);
      continue;
    }
    if (value.type === 'function_call_result') {
      const output = value.output;
      if (typeof output === 'string' && !isProtocolSynthetic(output)) {
        const next = excerptText(output, idleDays);
        if (next !== output) { changed = true; out.push({ ...value, output: next } as AgentInputItem); continue; }
      } else if (record(output)?.type === 'text' && typeof record(output)!.text === 'string') {
        const text = record(output)!.text as string;
        if (!isProtocolSynthetic(text)) {
          const next = excerptText(text, idleDays);
          if (next !== text) { changed = true; out.push({ ...value, output: { ...record(output)!, text: next } } as AgentInputItem); continue; }
        }
      } else if (output !== undefined && JSON.stringify(output).length > RESULT_KEEP_WHOLE_CHARS) {
        changed = true;
        out.push({ ...value, output: { type: 'text', text: `[a non-text result was left out after this conversation sat idle ${idleDays} days]` } } as AgentInputItem);
        continue;
      }
    }
    out.push(item);
  }
  return { items: out, changed };
}

function messageText(item: ItemRecord): string | null {
  if (item.role !== 'user' && item.role !== 'assistant') return null;
  if (item.type !== undefined && item.type !== 'message') return null;
  const content = item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map((part) => {
    const value = record(part);
    return value && typeof value.text === 'string' && (value.type === 'input_text' || value.type === 'output_text') ? value.text : '';
  }).filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

/** The memory form: what memory kept, then the last few messages as text. */
export function memoryConversationItems(items: readonly AgentInputItem[], memory: { summary: string; since: string; until: string } | null): AgentInputItem[] {
  const tail: AgentInputItem[] = [];
  for (let index = items.length - 1; index >= 0 && tail.length < MEMORY_TAIL_MESSAGES; index -= 1) {
    const value = record(items[index]);
    const text = value ? messageText(value) : null;
    if (!value || !text?.trim()) continue;
    const clipped = text.length > MEMORY_TAIL_MESSAGE_CHARS ? `${text.slice(0, MEMORY_TAIL_MESSAGE_CHARS)}…` : text;
    tail.unshift(value.role === 'assistant'
      ? { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: clipped }] } as AgentInputItem
      : { role: 'user', content: clipped } as AgentInputItem);
  }
  if (!memory) return tail;
  const note = {
    role: 'user',
    content: `[Earlier in this conversation (${memory.since.slice(0, 10)} to ${memory.until.slice(0, 10)}), as Clem's memory kept it]\n${memory.summary}`,
  } as AgentInputItem;
  return [note, ...tail];
}

export interface ConversationLifecycleCandidate {
  sessionId: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
  fidelity: 'full' | 'compacted' | 'memory';
}

/** Sessions whose stored state sits at one of `fidelity` and has been idle
 *  since before `idleBefore`. */
export function listConversationLifecycleCandidates(input: {
  idleBefore: string;
  fidelity: ReadonlyArray<'full' | 'compacted'>;
  kinds?: readonly string[];
  limit: number;
  newestFirst?: boolean;
  /** Only conversations with no memory noted since their last turn; one the
   * model gave nothing usable for is asked again once its noted day is
   * before `retryUnusableBefore`. */
  withoutMemory?: { retryUnusableBefore: string };
}): ConversationLifecycleCandidate[] {
  const db = openEventLog();
  const kinds = input.kinds ?? [];
  return db.prepare(`
    SELECT s.id AS sessionId, s.kind, s.created_at AS createdAt, s.updated_at AS updatedAt, c.fidelity
      FROM session_conversation_state c JOIN sessions s ON s.id = c.session_id
     WHERE c.fidelity IN (${input.fidelity.map(() => '?').join(', ')})
       AND s.updated_at < ?
       ${input.withoutMemory ? `AND (c.memory_episode_id IS NULL
         OR (c.memory_episode_id LIKE 'none:unusable-summary%' AND substr(c.memory_episode_id, 23) < ?))` : ''}
       ${kinds.length > 0 ? `AND s.kind IN (${kinds.map(() => '?').join(', ')})` : ''}
     ORDER BY s.updated_at ${input.newestFirst ? 'DESC' : 'ASC'}
     LIMIT ?
  `).all(...input.fidelity, input.idleBefore, ...(input.withoutMemory ? [input.withoutMemory.retryUnusableBefore] : []),
    ...kinds, Math.max(1, Math.min(1_000, Math.floor(input.limit)))) as ConversationLifecycleCandidate[];
}

/** Calls of this session whose results carry a provenance receipt. */
export function provenanceBoundCallIds(sessionId: string): Set<string> {
  const rows = openEventLog().prepare(`
    SELECT call_id FROM logical_model_result_projection_receipts WHERE session_id = ?
    UNION SELECT call_id FROM host_model_result_receipts WHERE session_id = ?
  `).all(sessionId, sessionId) as Array<{ call_id: string }>;
  return new Set(rows.map((row) => row.call_id));
}

const COMPACTED_RESULT_MARK = 'left out after this conversation sat idle';

/**
 * Put back, byte for byte from the retained tool output, any result of a
 * provenance-bound call that an earlier compaction shortened. Null when there
 * is nothing to restore or an original is no longer retained.
 */
export function restoreProvenanceBoundResults(sessionId: string, items: readonly AgentInputItem[], bound: ReadonlySet<string>): {
  items: AgentInputItem[];
  restored: number;
  missing: number;
} {
  let restored = 0;
  let missing = 0;
  const out = items.map((item) => {
    const value = record(item);
    if (!value || value.type !== 'function_call_result' || typeof value.callId !== 'string' || !bound.has(value.callId)) return item;
    const output = value.output;
    const text = typeof output === 'string' ? output : record(output)?.type === 'text' ? record(output)!.text : null;
    if (typeof text !== 'string' || !text.includes(COMPACTED_RESULT_MARK)) return item;
    const retained = getToolOutput(sessionId, value.callId);
    if (!retained || retained.truncatedAtWrite) { missing += 1; return item; }
    restored += 1;
    return (typeof output === 'string'
      ? { ...value, output: retained.output }
      : { ...value, output: { ...record(output)!, text: retained.output } }) as AgentInputItem;
  });
  return { items: out, restored, missing };
}

/** Exact conversation revision whose transcript a memory job read. Event seq
 * also catches a new accepted message before its state snapshot is written. */
export interface ConversationMemorySnapshot {
  sessionId: string;
  createdAt: string;
  sessionUpdatedAt: string;
  stateJson: string;
  stateUpdatedAt: string;
  fidelity: 'full' | 'compacted' | 'memory';
  memoryEpisodeId: string | null;
  eventSeq: number;
}

export function captureConversationMemorySnapshot(sessionId: string): ConversationMemorySnapshot | null {
  return openEventLog().prepare(`
    SELECT s.id AS sessionId, s.created_at AS createdAt, s.updated_at AS sessionUpdatedAt,
           c.state_json AS stateJson, c.updated_at AS stateUpdatedAt, c.fidelity,
           c.memory_episode_id AS memoryEpisodeId,
           COALESCE((SELECT MAX(e.seq) FROM events e WHERE e.session_id = s.id), 0) AS eventSeq
      FROM sessions s JOIN session_conversation_state c ON c.session_id = s.id
     WHERE s.id = ?
  `).get(sessionId) as ConversationMemorySnapshot | undefined ?? null;
}

/** Publish memory only for the revision summarized. The synchronous factory
 * writes its episode after the revision check while the harness write lock is
 * held; a late summary cannot overwrite memory or mark a newer turn remembered.
 * The memory database is separate: an episode write surviving a later harness
 * failure is harmless retained evidence, never a marker that suppresses retry. */
export function noteConversationMemory(
  sessionId: string,
  episode: string | (() => string),
  expected: ConversationMemorySnapshot,
): boolean {
  if (expected.sessionId !== sessionId) return false;
  const db = openEventLog();
  return db.transaction(() => {
    const current = captureConversationMemorySnapshot(sessionId);
    if (!current || current.createdAt !== expected.createdAt
      || current.sessionUpdatedAt !== expected.sessionUpdatedAt || current.stateJson !== expected.stateJson
      || current.stateUpdatedAt !== expected.stateUpdatedAt || current.fidelity !== expected.fidelity
      || current.memoryEpisodeId !== expected.memoryEpisodeId || current.eventSeq !== expected.eventSeq) return false;
    const episodeId = typeof episode === 'function' ? episode() : episode;
    return db.prepare(`UPDATE session_conversation_state SET memory_episode_id = ?
      WHERE session_id = ? AND state_json = ? AND updated_at = ? AND fidelity = ? AND memory_episode_id IS ?`)
      .run(episodeId, sessionId, expected.stateJson, expected.stateUpdatedAt, expected.fidelity, expected.memoryEpisodeId).changes === 1;
  }).immediate();
}

/** Why this conversation must keep its state as it is, or null. */
export function conversationLifecycleHold(sessionId: string): string | null {
  const db = openEventLog();
  const row = db.prepare('SELECT metadata_json FROM sessions WHERE id = ?').get(sessionId) as { metadata_json: string } | undefined;
  if (!row) return 'session_missing';
  let metadata: ItemRecord | null = null;
  try { metadata = record(JSON.parse(row.metadata_json)); } catch { return 'metadata_unreadable'; }
  if (!metadata) return 'metadata_unreadable';
  if (metadata.pinned === true) return 'pinned';
  for (const key of HELD_METADATA_KEYS) if (metadata[key] !== undefined && metadata[key] !== null) return key;
  const checkpoints = record(metadata.__source_approval_checkpoints);
  if (checkpoints && Object.values(checkpoints).some((entry) => record(record(entry)?.checkpoint) !== null)) return 'approval_checkpoint';
  if (db.prepare("SELECT 1 FROM pending_approvals WHERE session_id = ? AND status = 'pending' LIMIT 1").get(sessionId)) return 'pending_approval';
  if (db.prepare('SELECT 1 FROM run_attempts WHERE session_id = ? AND finished_at IS NULL LIMIT 1').get(sessionId)) return 'unfinished_run';
  return null;
}

export type ConversationLifecycleStep = 'changed' | 'unchanged' | 'held' | 'raced' | 'invalid' | 'missing';

function idleDaysOf(updatedAt: string, nowMs: number): number {
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / 86_400_000)) : CONVERSATION_COMPACT_IDLE_DAYS;
}

function lower(sessionId: string, input: {
  fidelity: 'compacted' | 'memory';
  nowMs: number;
  build: (items: AgentInputItem[], session: { updatedAt: string; createdAt: string }) => AgentInputItem[] | null;
  memoryEpisodeId?: string | null;
}): ConversationLifecycleStep {
  const db = openEventLog();
  return db.transaction((): ConversationLifecycleStep => {
    const session = db.prepare('SELECT created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE id = ?')
      .get(sessionId) as { createdAt: string; updatedAt: string } | undefined;
    const stored = getSessionConversationState(sessionId, db);
    if (!session || !stored) return 'missing';
    // Retirement's selected episode must still belong to this state when the
    // write lock is acquired, rather than a previous turn of the same chat.
    if (input.memoryEpisodeId != null && stored.memoryEpisodeId !== input.memoryEpisodeId) return 'raced';
    if (conversationLifecycleHold(sessionId)) return 'held';
    const items = Array.isArray(stored.state.items) ? stored.state.items as AgentInputItem[] : [];
    if (inspectConversationProtocol(items).status !== 'valid') return 'invalid';
    const next = input.build(items, session);
    if (!next) return 'unchanged';
    if (inspectConversationProtocol(next).status !== 'valid') return 'invalid';
    // The provider's response chain cannot continue a rewritten history.
    const state = { items: next, updatedAt: typeof stored.state.updatedAt === 'string' ? stored.state.updatedAt : session.updatedAt };
    const written = db.prepare(`UPDATE session_conversation_state
        SET state_json = ?, fidelity = ?, memory_episode_id = ?, compacted_at = ?
        WHERE session_id = ? AND state_json = ?`)
      .run(JSON.stringify(state), input.fidelity, input.memoryEpisodeId ?? stored.memoryEpisodeId,
        new Date(input.nowMs).toISOString(), sessionId, stored.stateJson);
    return written.changes === 1 ? 'changed' : 'raced';
  }).immediate();
}

/** Compact one idle conversation's stored state. */
export function compactConversationState(sessionId: string, nowMs = Date.now()): ConversationLifecycleStep {
  const bound = provenanceBoundCallIds(sessionId);
  return lower(sessionId, { fidelity: 'compacted', nowMs, build: (items, session) => {
    const compacted = compactConversationItems(items, idleDaysOf(session.updatedAt, nowMs), (callId) => bound.has(callId));
    // Marked compacted even when nothing was large: the tier is the record.
    return compacted.items;
  } });
}

/** Compacted states that may hold a shortened provenance-bound result. */
export function listCompactedSessionsNeedingRepair(limit: number): string[] {
  return (openEventLog().prepare(`
    SELECT c.session_id FROM session_conversation_state c
     WHERE c.fidelity = 'compacted' AND instr(c.state_json, ?) > 0
       AND (EXISTS (SELECT 1 FROM logical_model_result_projection_receipts p WHERE p.session_id = c.session_id)
         OR EXISTS (SELECT 1 FROM host_model_result_receipts h WHERE h.session_id = c.session_id))
     LIMIT ?
  `).all(COMPACTED_RESULT_MARK, Math.max(1, Math.min(1_000, Math.floor(limit)))) as Array<{ session_id: string }>)
    .map((row) => row.session_id);
}

/**
 * Restore every provenance-bound result an earlier compaction shortened in
 * this session's stored state. The tier stays; only those results change.
 */
export function repairCompactedProvenanceResults(sessionId: string): { restored: number; missing: number } {
  const db = openEventLog();
  return db.transaction(() => {
    const stored = getSessionConversationState(sessionId, db);
    if (!stored || stored.fidelity !== 'compacted' || !Array.isArray(stored.state.items)) return { restored: 0, missing: 0 };
    const repaired = restoreProvenanceBoundResults(sessionId, stored.state.items as AgentInputItem[], provenanceBoundCallIds(sessionId));
    if (repaired.restored > 0) {
      db.prepare('UPDATE session_conversation_state SET state_json = ? WHERE session_id = ? AND state_json = ?')
        .run(JSON.stringify({ ...stored.state, items: repaired.items }), sessionId, stored.stateJson);
    }
    return { restored: repaired.restored, missing: repaired.missing };
  }).immediate();
}

/** Retire one idle conversation's stored state to what memory kept. */
export function retireConversationStateToMemory(sessionId: string, input: {
  memory: { episodeId: string; summary: string } | null;
  nowMs?: number;
}): ConversationLifecycleStep {
  const nowMs = input.nowMs ?? Date.now();
  return lower(sessionId, {
    fidelity: 'memory',
    nowMs,
    memoryEpisodeId: input.memory?.episodeId ?? null,
    build: (items, session) => memoryConversationItems(items, input.memory
      ? { summary: input.memory.summary, since: session.createdAt, until: session.updatedAt }
      : null),
  });
}

/** A finished turn of a long-lived session keeps its working records this
 * many days: the same bar a chat meets when it retires to its memory. */
export const RETIRED_TURN_IDLE_DAYS = CONVERSATION_MEMORY_ONLY_IDLE_DAYS;
/** A decay pass runs on the daemon's own loop, so it works this long and
 * stops; the backlog clears over the passes that follow, never in one. */
export const RETIRED_WORK_RECORD_PASS_BUDGET_MS = 250;

/** Tables whose rows are a turn's working records, keyed by session and turn. */
const TURN_WORKING_RECORD_TABLES = ['accepted_model_batch_admissions', 'durable_result_handles', 'model_request_provenance', 'logical_call_settlements'] as const;
/** The same, plus the retained outputs a conversation keys by session alone. */
const CONVERSATION_WORKING_RECORD_TABLES = [...TURN_WORKING_RECORD_TABLES, 'tool_outputs', 'tool_output_invocations'] as const;
/** Where a conversation's turns are named. */
const TURN_SOURCES = ['accepted_turn_call_authorities', ...TURN_WORKING_RECORD_TABLES, 'write_evidence_bindings', 'evidence_receipts', 'async_read_refinement_intents'] as const;
/** The result handle index covers authoritative handles only, and every
 * session-bound handle is one: a lookup says so, or it scans the table. */
const HANDLE_SCOPE = "scope_kind = 'authoritative' AND ";
const turnScope = (table: string, alias: string) => (table === 'durable_result_handles' ? `${alias}.${HANDLE_SCOPE}` : '');

export interface RetiredWorkRecordDecay {
  /** Conversations retired to memory whose working records went. */
  sessions: number;
  /** Finished turns of long-lived sessions (a watch, a workflow, a workspace) whose working records went. */
  turns: number;
  admissions: number;
  checkpoints: number;
  /** Stored histories no record references any more. */
  objects: number;
  handles: number;
  settlements: number;
  provenance: number;
  toolOutputs: number;
  /** Retired conversations and turns kept whole because something could still pick them up. */
  held: number;
  /** The same, by what holds them. */
  heldBy: Record<string, number>;
}

/** Where the last pass stopped, so each pass continues the walk instead of
 * re-examining the front of the list; a walk that reaches the end starts
 * over on the next pass. */
const walk = { conversation: '', turn: 0 };

/** The working records of a conversation retired to its memory, and of a
 * finished turn of a long-lived session: the batch admissions and checkpoints
 * (with their result receipts), the call settlements with their evidence, the
 * result handles, the request provenance, and the retained tool outputs every
 * turn wrote while it ran. A retired chat resumes from its memory and tail,
 * and a new turn starts its own records, so these are working copies once the
 * grace window after retiring has passed. A watch, a workflow or a workspace
 * never retires as a whole: it runs turn after turn, and a turn whose call
 * authority closed thirty days ago with no run still open is done. The
 * transcript in events, the calls and dispatches themselves, and the memory
 * stay. Nothing goes while the session is held (a pin, a pending approval, an
 * unfinished run); the retirement is recorded first, under the writer lock,
 * and every append-only guard reads that record. */
export function decayRetiredConversationWorkRecords(input: {
  nowMs?: number;
  graceDays?: number;
  limit?: number;
  turnLimit?: number;
  /** Wall-clock work per pass; what is left waits for the next pass. */
  budgetMs?: number;
} = {}): RetiredWorkRecordDecay {
  const db = openEventLog();
  const nowMs = input.nowMs ?? Date.now();
  const graceDays = input.graceDays ?? RETIRED_WORK_RECORD_GRACE_DAYS;
  const budgetMs = input.budgetMs ?? RETIRED_WORK_RECORD_PASS_BUDGET_MS;
  const started = performance.now();
  // Conversations take the first half of the budget, turns the rest.
  let deadline = started + budgetMs / 2;
  const outOfTime = () => performance.now() > deadline;
  const retiredBefore = new Date(nowMs - graceDays * 86_400_000).toISOString();
  const turnsOpenedBefore = new Date(nowMs - (RETIRED_TURN_IDLE_DAYS + graceDays) * 86_400_000).toISOString();
  const result: RetiredWorkRecordDecay = { sessions: 0, turns: 0, admissions: 0, checkpoints: 0, objects: 0, handles: 0, settlements: 0, provenance: 0, toolOutputs: 0, held: 0, heldBy: {} };
  const hold = (sessionId: string): boolean => {
    const reason = conversationLifecycleHold(sessionId);
    if (reason === null) return false;
    result.held += 1;
    result.heldBy[reason] = (result.heldBy[reason] ?? 0) + 1;
    return true;
  };
  const shed = turnWorkRecordShedder(db, new Date(nowMs).toISOString(), result);

  const limit = Math.max(1, input.limit ?? 300);
  const conversations = db.prepare(`
    SELECT state.session_id AS sessionId
      FROM session_conversation_state state
     WHERE state.fidelity = 'memory'
       AND state.compacted_at IS NOT NULL
       AND state.compacted_at < ?
       AND state.session_id > ?
       AND (${CONVERSATION_WORKING_RECORD_TABLES.map((table) => `EXISTS (SELECT 1 FROM ${table} w WHERE ${turnScope(table, 'w')}w.session_id = state.session_id)`).join(' OR ')})
     ORDER BY state.session_id
     LIMIT ?
  `).all(retiredBefore, walk.conversation, limit) as Array<{ sessionId: string }>;
  walk.conversation = conversations.length < limit ? '' : conversations[conversations.length - 1]!.sessionId;
  const fidelityOf = db.prepare('SELECT fidelity FROM session_conversation_state WHERE session_id = ?');
  const turnsOf = db.prepare(`SELECT DISTINCT source_user_seq AS seq FROM (${TURN_SOURCES.map((table) => `SELECT source_user_seq FROM ${table} WHERE ${turnScope(table, table)}session_id = ? AND source_user_seq IS NOT NULL`).join(' UNION ALL ')}) ORDER BY seq`);
  const deleteConversationOutputs = ['tool_outputs', 'tool_output_invocations'].map((table) => db.prepare(`DELETE FROM ${table} WHERE session_id = ?`));
  // Each turn goes in its own transaction, the fidelity rechecked under the
  // writer lock every time; a pass that runs out of time leaves the rest of a
  // conversation for the next one, which finds it still a candidate.
  const stillRetired = () => (fidelityOf.get(sessionId) as { fidelity?: string } | undefined)?.fidelity === 'memory';
  let sessionId = '';
  conversations: for (const candidate of conversations) {
    sessionId = candidate.sessionId;
    if (outOfTime()) { walk.conversation = sessionId; break; }
    if (hold(sessionId)) continue;
    for (const { seq } of turnsOf.all(...TURN_SOURCES.map(() => sessionId)) as Array<{ seq: number }>) {
      if (outOfTime()) { walk.conversation = sessionId; break conversations; }
      db.transaction(() => { if (stillRetired()) shed(sessionId, seq); }).immediate();
    }
    db.transaction(() => {
      if (!stillRetired()) return;
      // An output whose call left no record goes with its conversation.
      for (const statement of deleteConversationOutputs) result.toolOutputs += statement.run(sessionId).changes;
      result.sessions += 1;
    }).immediate();
  }

  deadline = started + budgetMs;
  const turnLimit = Math.max(1, input.turnLimit ?? 300);
  const turns = db.prepare(`
    SELECT a.rowid AS row, a.session_id AS sessionId, a.source_user_seq AS seq
      FROM accepted_turn_call_authorities a
     WHERE a.rowid > ?
       AND a.state IN ('closed', 'conflict')
       AND a.opened_at < ?
       AND NOT EXISTS (SELECT 1 FROM session_conversation_state c WHERE c.session_id = a.session_id)
       AND NOT EXISTS (SELECT 1 FROM retired_turn_work_records r WHERE r.session_id = a.session_id AND r.source_user_seq = a.source_user_seq)
       AND NOT EXISTS (SELECT 1 FROM run_attempts ra WHERE ra.session_id = a.session_id AND ra.source_user_seq = a.source_user_seq AND ra.finished_at IS NULL)
       AND (${TURN_WORKING_RECORD_TABLES.map((table) => `EXISTS (SELECT 1 FROM ${table} w WHERE ${turnScope(table, 'w')}w.session_id = a.session_id AND w.source_user_seq = a.source_user_seq)`).join(' OR ')})
     ORDER BY a.rowid
     LIMIT ?
  `).all(walk.turn, turnsOpenedBefore, turnLimit) as Array<{ row: number; sessionId: string; seq: number }>;
  walk.turn = turns.length < turnLimit ? 0 : turns[turns.length - 1]!.row;
  const openRun = db.prepare('SELECT 1 FROM run_attempts WHERE session_id = ? AND source_user_seq = ? AND finished_at IS NULL LIMIT 1');
  const heldSessions = new Set<string>();
  for (const turn of turns) {
    if (outOfTime()) { walk.turn = turn.row - 1; break; }
    if (heldSessions.has(turn.sessionId)) { result.held += 1; continue; }
    if (hold(turn.sessionId)) { heldSessions.add(turn.sessionId); continue; }
    db.transaction(() => {
      // Rechecked under the writer lock: a run may have started since.
      if (openRun.get(turn.sessionId, turn.seq)) return;
      shed(turn.sessionId, turn.seq);
      result.turns += 1;
    }).immediate();
  }

  if (result.sessions > 0 || result.turns > 0) {
    result.objects = db.prepare(`
      DELETE FROM accepted_model_history_objects_v1
       WHERE NOT EXISTS (SELECT 1 FROM accepted_model_batch_checkpoints c WHERE c.history_object_digest = accepted_model_history_objects_v1.digest)
         AND NOT EXISTS (SELECT 1 FROM accepted_model_batch_admissions a WHERE a.pre_history_object_digest = accepted_model_history_objects_v1.digest)
         AND NOT EXISTS (SELECT 1 FROM accepted_model_batch_admissions a WHERE a.frame_history_object_digest = accepted_model_history_objects_v1.digest)
    `).run().changes;
  }
  return result;
}

/** Deletes one turn's working records, children before the rows they
 * reference, after recording the turn as retired. */
function turnWorkRecordShedder(db: ReturnType<typeof openEventLog>, retiredAt: string, counts: RetiredWorkRecordDecay): (sessionId: string, seq: number) => void {
  const record = db.prepare('INSERT OR IGNORE INTO retired_turn_work_records (session_id, source_user_seq, retired_at) VALUES (?, ?, ?)');
  const evidence = [
    'DELETE FROM write_evidence_proofs WHERE session_id = ? AND source_user_seq = ?',
    'DELETE FROM write_evidence_bindings WHERE session_id = ? AND source_user_seq = ?',
    'DELETE FROM evidence_receipts WHERE session_id = ? AND source_user_seq = ?',
    'DELETE FROM async_read_refinement_intents WHERE session_id = ? AND source_user_seq = ?',
    `DELETE FROM workflow_paginated_read_pages WHERE result_handle_id IN (SELECT handle_id FROM durable_result_handles WHERE ${HANDLE_SCOPE}session_id = ? AND source_user_seq = ?)`,
  ].map((sql) => db.prepare(sql));
  const settlements = db.prepare('DELETE FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ?');
  const handles = db.prepare(`DELETE FROM durable_result_handles WHERE ${HANDLE_SCOPE}session_id = ? AND source_user_seq = ?`);
  const provenance = db.prepare('DELETE FROM model_request_provenance WHERE session_id = ? AND source_user_seq = ?');
  const outputs = ['tool_outputs', 'tool_output_invocations'].map((table) => db.prepare(
    `DELETE FROM ${table} WHERE session_id = ? AND call_id IN (SELECT logical_tool_call_id FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?)`));
  const checkpoints = db.prepare('SELECT COUNT(*) AS n FROM accepted_model_batch_checkpoints WHERE session_id = ? AND source_user_seq = ?');
  const admissions = db.prepare('DELETE FROM accepted_model_batch_admissions WHERE session_id = ? AND source_user_seq = ?');
  return (sessionId, seq) => {
    record.run(sessionId, seq, retiredAt);
    for (const statement of evidence) statement.run(sessionId, seq);
    counts.settlements += settlements.run(sessionId, seq).changes;
    counts.handles += handles.run(sessionId, seq).changes;
    counts.provenance += provenance.run(sessionId, seq).changes;
    for (const statement of outputs) counts.toolOutputs += statement.run(sessionId, sessionId, seq).changes;
    counts.checkpoints += (checkpoints.get(sessionId, seq) as { n: number }).n;
    counts.admissions += admissions.run(sessionId, seq).changes;
  };
}
