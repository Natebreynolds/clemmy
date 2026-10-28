/**
 * A conversation's stored state as it ages: full, then compacted, then what
 * memory kept. The forms, and the compare-and-swap that lowers a stored state
 * to one, against whatever connection the caller holds: the storage decay
 * worker compacts week-idle states on its own connection, off the daemon's
 * loop; retirement runs on the live log, where the memory a chat retires to
 * is read.
 *
 * The stored state is the model-input history a later turn resumes from. The
 * transcript the owner reads lives in events and is never touched here.
 *
 * - full: as the last turn left it.
 * - compacted (idle 7 days): every message kept verbatim; a tool result keeps
 *   an excerpt and a pointer to the full result; reasoning and oversized
 *   call arguments go; the provider's response chain is cut. Resuming works.
 * - memory (idle 30 days): the conversation's memory (its summary, written by
 *   the owner's memory model) and its last few messages.
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
 *
 * This module never imports config or the event log: the worker loads it.
 */
import type Database from 'better-sqlite3';
import type { AgentInputItem } from '@openai/agents';
import { inspectConversationProtocol } from './conversation-protocol.js';
import { CONVERSATION_COMPACT_IDLE_DAYS, conversationHoldReason, record, type ItemRecord } from './retired-work-records.js';

/** A tool result keeps this much of its text, and a call this much of its
 * arguments. */
const RESULT_EXCERPT_CHARS = 400;
const RESULT_KEEP_WHOLE_CHARS = 600;
const ARGUMENTS_KEEP_WHOLE_CHARS = 2_000;
const MEMORY_TAIL_MESSAGES = 4;
const MEMORY_TAIL_MESSAGE_CHARS = 2_000;

/** What a shortened result says; a repair pass finds the states that hold one. */
export const COMPACTED_RESULT_MARK = 'left out after this conversation sat idle';

function resultHandleIn(text: string): string | null {
  return text.match(/\brh_[A-Za-z0-9_-]{6,}\b/)?.[0] ?? null;
}

function excerptText(text: string, idleDays: number): string {
  if (text.length <= RESULT_KEEP_WHOLE_CHARS) return text;
  const handle = resultHandleIn(text);
  return `${text.slice(0, RESULT_EXCERPT_CHARS)}\n[${text.length - RESULT_EXCERPT_CHARS} more characters ${COMPACTED_RESULT_MARK} ${idleDays} days${handle ? `; the full result is ${handle}` : ''}]`;
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
      out.push({ ...value, arguments: JSON.stringify({ compacted: `${value.arguments.length} characters of arguments ${COMPACTED_RESULT_MARK} ${idleDays} days` }) } as AgentInputItem);
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
        out.push({ ...value, output: { type: 'text', text: `[a non-text result was ${COMPACTED_RESULT_MARK} ${idleDays} days]` } } as AgentInputItem);
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
export function listConversationLifecycleCandidates(db: Database.Database, input: {
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
export function provenanceBoundCallIds(db: Database.Database, sessionId: string): Set<string> {
  const rows = db.prepare(`
    SELECT call_id FROM logical_model_result_projection_receipts WHERE session_id = ?
    UNION SELECT call_id FROM host_model_result_receipts WHERE session_id = ?
  `).all(sessionId, sessionId) as Array<{ call_id: string }>;
  return new Set(rows.map((row) => row.call_id));
}

export type ConversationLifecycleStep = 'changed' | 'unchanged' | 'held' | 'raced' | 'invalid' | 'missing';

function idleDaysOf(updatedAt: string, nowMs: number): number {
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / 86_400_000)) : CONVERSATION_COMPACT_IDLE_DAYS;
}

/**
 * Lower one stored state to `fidelity`, built from its current items. The
 * state's text is read only once nothing holds the conversation: a held one
 * costs its session row, never a parse. `holds` counts the reasons.
 */
export function lowerConversationState(db: Database.Database, sessionId: string, input: {
  fidelity: 'compacted' | 'memory';
  nowMs: number;
  build: (items: AgentInputItem[], session: { updatedAt: string; createdAt: string }) => AgentInputItem[] | null;
  memoryEpisodeId?: string | null;
  holds?: Record<string, number>;
}): ConversationLifecycleStep {
  return db.transaction((): ConversationLifecycleStep => {
    const session = db.prepare('SELECT created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE id = ?')
      .get(sessionId) as { createdAt: string; updatedAt: string } | undefined;
    const tier = db.prepare('SELECT memory_episode_id AS memoryEpisodeId FROM session_conversation_state WHERE session_id = ?')
      .get(sessionId) as { memoryEpisodeId: string | null } | undefined;
    if (!session || !tier) return 'missing';
    // Retirement's selected episode must still belong to this state when the
    // write lock is acquired, rather than a previous turn of the same chat.
    if (input.memoryEpisodeId != null && tier.memoryEpisodeId !== input.memoryEpisodeId) return 'raced';
    const reason = conversationHoldReason(db, sessionId);
    if (reason !== null) {
      if (input.holds) input.holds[reason] = (input.holds[reason] ?? 0) + 1;
      return 'held';
    }
    const stored = db.prepare('SELECT state_json AS stateJson, memory_episode_id AS memoryEpisodeId FROM session_conversation_state WHERE session_id = ?')
      .get(sessionId) as { stateJson: string; memoryEpisodeId: string | null } | undefined;
    if (!stored) return 'missing';
    let state: ItemRecord | null = null;
    try { state = record(JSON.parse(stored.stateJson)); } catch { return 'invalid'; }
    if (!state) return 'invalid';
    const items = Array.isArray(state.items) ? state.items as AgentInputItem[] : [];
    if (inspectConversationProtocol(items).status !== 'valid') return 'invalid';
    const next = input.build(items, session);
    if (!next) return 'unchanged';
    if (inspectConversationProtocol(next).status !== 'valid') return 'invalid';
    // The provider's response chain cannot continue a rewritten history.
    const nextState = { items: next, updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : session.updatedAt };
    const written = db.prepare(`UPDATE session_conversation_state
        SET state_json = ?, fidelity = ?, memory_episode_id = ?, compacted_at = ?
        WHERE session_id = ? AND state_json = ?`)
      .run(JSON.stringify(nextState), input.fidelity, input.memoryEpisodeId ?? stored.memoryEpisodeId,
        new Date(input.nowMs).toISOString(), sessionId, stored.stateJson);
    return written.changes === 1 ? 'changed' : 'raced';
  }).immediate();
}

/** Compact one idle conversation's stored state. */
export function compactConversationState(db: Database.Database, sessionId: string, nowMs = Date.now(), holds?: Record<string, number>): ConversationLifecycleStep {
  const bound = provenanceBoundCallIds(db, sessionId);
  return lowerConversationState(db, sessionId, { fidelity: 'compacted', nowMs, holds, build: (items, session) => {
    const compacted = compactConversationItems(items, idleDaysOf(session.updatedAt, nowMs), (callId) => bound.has(callId));
    // Marked compacted even when nothing was large: the tier is the record.
    return compacted.items;
  } });
}

export interface ConversationCompaction {
  /** Week-idle full states the pass examined. */
  examined: number;
  compacted: number;
  /** Kept whole because something could still pick the conversation up. */
  held: number;
  /** The same, by what holds them. */
  heldBy: Record<string, number>;
  /** Histories the protocol inspector does not read as valid, left for repair. */
  invalid: number;
  /** No week-idle full state was left unexamined when the pass stopped. */
  caughtUp: boolean;
}

/** Stored states one pass compacts at most; the backlog clears over passes. */
export const CONVERSATION_COMPACTION_PASS_LIMIT = 25;
const CONVERSATION_COMPACTION_PASS_BUDGET_MS = 500;

/**
 * One pass: compact what has been idle a week, oldest first. A held or
 * invalid state stays listed, so the list runs well past the pass's own
 * limit and those standing at the front never hide the rest.
 */
export function compactIdleConversations(db: Database.Database, input: { nowMs?: number; limit?: number; budgetMs?: number } = {}): ConversationCompaction {
  const nowMs = input.nowMs ?? Date.now();
  const limit = Math.max(1, input.limit ?? CONVERSATION_COMPACTION_PASS_LIMIT);
  const deadline = performance.now() + (input.budgetMs ?? CONVERSATION_COMPACTION_PASS_BUDGET_MS);
  const idleBefore = new Date(nowMs - CONVERSATION_COMPACT_IDLE_DAYS * 86_400_000).toISOString();
  const listed = limit * 20;
  const candidates = listConversationLifecycleCandidates(db, { idleBefore, fidelity: ['full'], limit: listed });
  const result: ConversationCompaction = { examined: 0, compacted: 0, held: 0, heldBy: {}, invalid: 0, caughtUp: candidates.length < listed };
  for (const candidate of candidates) {
    if (result.compacted >= limit || performance.now() > deadline) { result.caughtUp = false; break; }
    result.examined += 1;
    const step = compactConversationState(db, candidate.sessionId, nowMs, result.heldBy);
    if (step === 'changed') result.compacted += 1;
    else if (step === 'held') result.held += 1;
    else if (step === 'invalid') result.invalid += 1;
  }
  return result;
}
