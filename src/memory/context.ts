import { loadMemoryContext } from './vault.js';
import { loadSessionBrief, renderSessionContinuity } from './session-briefs.js';
import { loadWorkingMemoryForSession } from './working-memory.js';
import { formatSearchHits, searchVault, searchVaultAsync } from './search.js';
import { getRecallObjective } from './focus.js';
import { SessionStore } from './session-store.js';
import type { AssembledPromptContext } from '../types.js';
import { classifyMessageIntent, memoryBudgetFor } from '../assistant/message-intent.js';

/**
 * Gentle recency half-life (days) for chat vault recall. The decay is FLOORED
 * (see recall.ts RECENCY_FLOOR) so a freshly-referenced item edges out a stale
 * one without burying strong older notes. 30 days = a soft tiebreaker.
 */
const CHAT_RECALL_RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Chat cross-session seed window. The chat path has same-session continuity
 * (transcript + session brief) but — unlike the harness's seedCrossSessionPrefix
 * — no PRIOR-session seed, so a user who starts a fresh session (or moves from
 * another surface that shares a userId) lands blind beyond global facts/focus.
 * This carries the tail of the SAME user's single most-recent OTHER session,
 * but only within a tight 30-min window (matching the harness staleness model)
 * so it reads as "you were just here," not random history. History ONLY — never
 * the Active Task pin (that stays origin-keyed, not cross-session). Scoped by
 * userId so it never crosses users.
 */
const PRIOR_SESSION_SEED_WINDOW_MS = 30 * 60 * 1000;

function buildPriorSessionSeed(currentSessionId: string): string | undefined {
  try {
    const store = new SessionStore();
    const userId = store.get(currentSessionId)?.userId;
    if (!userId) return undefined;
    const sibling = store.listByUser(userId, 8).find(
      (s) => s.id !== currentSessionId
        && s.turns.length > 0
        && Date.now() - Date.parse(s.updatedAt) <= PRIOR_SESSION_SEED_WINDOW_MS,
    );
    if (!sibling) return undefined;
    const tail = store.recentTranscript(sibling.id, 4);
    if (!tail.trim()) return undefined;
    const mins = Math.max(1, Math.round((Date.now() - Date.parse(sibling.updatedAt)) / 60000));
    return `Prior session (your other recent conversation ~${mins}m ago — context only; the user may be continuing it here):\n${tail.slice(0, 700)}`;
  } catch {
    return undefined;
  }
}

function mergeContinuity(brief: string | undefined, seed: string | undefined): string | undefined {
  return [brief, seed].filter(Boolean).join('\n\n') || undefined;
}

function buildSearchQuery(memoryContext: { workingMemory?: string; sessionBrief?: string }, message: string, transcript: string): string {
  return [
    message,
    transcript,
    memoryContext.workingMemory?.slice(0, 400) ?? '',
    memoryContext.sessionBrief?.slice(0, 300) ?? '',
  ].filter(Boolean).join(' ').slice(0, 1200);
}

/**
 * Async prompt context assembly. Adds embedding rerank to the vault
 * recall when an OpenAI API key is configured; otherwise the FTS-only
 * path runs (same cost as before). Prefer this from anywhere that
 * already has an `await` available, like `assistant/core.ts respond()`.
 *
 * The memory budget is driven by the message-intent classifier:
 * casual / meta messages skip vault search and working memory; lookup
 * and action messages get the full retrieval pass.
 */
export async function assemblePromptContextAsync(sessionId: string, message: string, transcript: string): Promise<AssembledPromptContext> {
  const intent = classifyMessageIntent(message);
  const budget = memoryBudgetFor(intent.intent);
  const brief = budget.loadSessionBrief ? loadSessionBrief(sessionId) : undefined;
  const memoryContext = {
    ...loadMemoryContext(),
    workingMemory: budget.loadWorkingMemory ? loadWorkingMemoryForSession(sessionId) : undefined,
    sessionBrief: mergeContinuity(
      brief ? renderSessionContinuity(brief) : undefined,
      budget.loadSessionBrief ? buildPriorSessionSeed(sessionId) : undefined,
    ),
  };
  const hits = budget.vaultSearchTopK > 0
    ? await searchVaultAsync(buildSearchQuery(memoryContext, message, transcript), {
        limit: budget.vaultSearchTopK,
        objective: getRecallObjective(message),
        recencyHalfLifeDays: CHAT_RECALL_RECENCY_HALF_LIFE_DAYS,
      })
    : [];
  return {
    memoryContext,
    retrievalText: formatSearchHits(hits, budget.vaultFormatBytes || 0),
  };
}
