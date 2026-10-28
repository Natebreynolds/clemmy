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

import {
  CONVERSATION_COMPACT_IDLE_DAYS, CONVERSATION_MEMORY_ONLY_IDLE_DAYS, HELD_METADATA_KEYS, conversationHoldReason,
  decayRetiredTurnWorkRecords, record, type ItemRecord, type RetiredWorkRecordDecay,
} from './retired-work-records.js';

export {
  CONVERSATION_COMPACT_IDLE_DAYS, CONVERSATION_MEMORY_ONLY_IDLE_DAYS, RETIRED_TURN_IDLE_DAYS, RETIRED_WORK_RECORD_GRACE_DAYS,
  RETIRED_WORK_RECORD_PASS_BUDGET_MS, type RetiredWorkRecordDecay,
} from './retired-work-records.js';

/** A tool result keeps this much of its text, and a call this much of its
 * arguments. */
const RESULT_EXCERPT_CHARS = 400;
const RESULT_KEEP_WHOLE_CHARS = 600;
const ARGUMENTS_KEEP_WHOLE_CHARS = 2_000;
const MEMORY_TAIL_MESSAGES = 4;
const MEMORY_TAIL_MESSAGE_CHARS = 2_000;

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
  return conversationHoldReason(openEventLog(), sessionId);
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

/** The decay pass on the live event log; the storage decay worker runs the
 * same pass on its own connection. */
export function decayRetiredConversationWorkRecords(input: Parameters<typeof decayRetiredTurnWorkRecords>[1] = {}): RetiredWorkRecordDecay {
  return decayRetiredTurnWorkRecords(openEventLog(), input);
}
