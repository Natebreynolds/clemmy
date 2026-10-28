/**
 * A conversation's stored state as it ages, on the live event log.
 *
 * The forms and the lowering itself live in conversation-state-tiers.ts, which
 * takes any connection: the storage decay worker compacts week-idle states
 * there, off the daemon's loop. This module is the live log's side of it:
 * which chat is remembered against which exact revision, retirement to that
 * memory, the hold check, and the repair that puts a provenance-bound result
 * back byte for byte from its retained output.
 */
import type { AgentInputItem } from '@openai/agents';
import { getSessionConversationState, getToolOutput, openEventLog } from './eventlog.js';
import {
  COMPACTED_RESULT_MARK, compactConversationState as compactStoredConversationState,
  listConversationLifecycleCandidates as listCandidates, lowerConversationState, memoryConversationItems,
  provenanceBoundCallIds as boundCallIds, type ConversationLifecycleCandidate, type ConversationLifecycleStep,
} from './conversation-state-tiers.js';
import { conversationHoldReason, decayRetiredTurnWorkRecords, record, type RetiredWorkRecordDecay } from './retired-work-records.js';

export {
  CONVERSATION_COMPACT_IDLE_DAYS, CONVERSATION_MEMORY_ONLY_IDLE_DAYS, RETIRED_TURN_IDLE_DAYS, RETIRED_WORK_RECORD_GRACE_DAYS,
  RETIRED_WORK_RECORD_PASS_BUDGET_MS, type RetiredWorkRecordDecay,
} from './retired-work-records.js';
export {
  compactConversationItems, compactIdleConversations, memoryConversationItems,
  type ConversationCompaction, type ConversationLifecycleCandidate, type ConversationLifecycleStep,
} from './conversation-state-tiers.js';

/** Sessions whose stored state sits at one of `fidelity` and has been idle
 *  since before `idleBefore`. */
export function listConversationLifecycleCandidates(input: Parameters<typeof listCandidates>[1]): ConversationLifecycleCandidate[] {
  return listCandidates(openEventLog(), input);
}

/** Calls of this session whose results carry a provenance receipt. */
export function provenanceBoundCallIds(sessionId: string): Set<string> {
  return boundCallIds(openEventLog(), sessionId);
}

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

/** Compact one idle conversation's stored state on the live log. */
export function compactConversationState(sessionId: string, nowMs = Date.now()): ConversationLifecycleStep {
  return compactStoredConversationState(openEventLog(), sessionId, nowMs);
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
  return lowerConversationState(openEventLog(), sessionId, {
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
