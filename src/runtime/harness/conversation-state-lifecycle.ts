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
 * Nothing is lowered while the conversation could still be picked up where it
 * stopped: a pending approval, an unfinished run, parked or recovery state, a
 * held publication, or a pin. A history the protocol inspector does not read
 * as valid is left for its own repair path. Every change is a compare-and-swap
 * on the exact stored text, and none moves the session's update time.
 */
import type { AgentInputItem } from '@openai/agents';
import { inspectConversationProtocol } from './conversation-protocol.js';
import { getSessionConversationState, openEventLog } from './eventlog.js';

export const CONVERSATION_COMPACT_IDLE_DAYS = 7;
export const CONVERSATION_MEMORY_ONLY_IDLE_DAYS = 30;

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
export function compactConversationItems(items: readonly AgentInputItem[], idleDays = CONVERSATION_COMPACT_IDLE_DAYS): {
  items: AgentInputItem[];
  changed: boolean;
} {
  let changed = false;
  const out: AgentInputItem[] = [];
  for (const item of items) {
    const value = record(item);
    if (!value) { out.push(item); continue; }
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
  /** Only conversations with no memory noted since their last turn. */
  withoutMemory?: boolean;
}): ConversationLifecycleCandidate[] {
  const db = openEventLog();
  const kinds = input.kinds ?? [];
  return db.prepare(`
    SELECT s.id AS sessionId, s.kind, s.created_at AS createdAt, s.updated_at AS updatedAt, c.fidelity
      FROM session_conversation_state c JOIN sessions s ON s.id = c.session_id
     WHERE c.fidelity IN (${input.fidelity.map(() => '?').join(', ')})
       AND s.updated_at < ?
       ${input.withoutMemory ? 'AND c.memory_episode_id IS NULL' : ''}
       ${kinds.length > 0 ? `AND s.kind IN (${kinds.map(() => '?').join(', ')})` : ''}
     ORDER BY s.updated_at ${input.newestFirst ? 'DESC' : 'ASC'}
     LIMIT ?
  `).all(...input.fidelity, input.idleBefore, ...kinds, Math.max(1, Math.min(1_000, Math.floor(input.limit)))) as ConversationLifecycleCandidate[];
}

/** Note the memory kept for this conversation. A later turn writes a new
 * snapshot and clears it, so a resumed conversation is remembered again. */
export function noteConversationMemory(sessionId: string, episodeId: string): void {
  openEventLog().prepare('UPDATE session_conversation_state SET memory_episode_id = ? WHERE session_id = ?').run(episodeId, sessionId);
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
  return lower(sessionId, { fidelity: 'compacted', nowMs, build: (items, session) => {
    const compacted = compactConversationItems(items, idleDaysOf(session.updatedAt, nowMs));
    // Marked compacted even when nothing was large: the tier is the record.
    return compacted.items;
  } });
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
