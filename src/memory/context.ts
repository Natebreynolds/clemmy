import { loadMemoryContext } from './vault.js';
import { loadSessionBrief, renderSessionContinuity } from './session-briefs.js';
import { loadWorkingMemoryForSession } from './working-memory.js';
import { getRecallObjective } from './focus.js';
import { appendFactRecallTrace } from './recall-trace.js';
import { formatSearchHits, searchVault } from './search.js';
import { buildUnifiedTurnPrimer } from './turn-primer.js';
import { SessionStore } from './session-store.js';
import type { AssembledPromptContext } from '../types.js';
import { classifyMessageIntent, memoryBudgetFor } from '../assistant/message-intent.js';
import {
  getSession as getHarnessSession,
  listSessions as listHarnessSessions,
} from '../runtime/harness/eventlog.js';
import {
  isPureAsyncOutcomeLegacyGhost,
  pullRecentTurnsForHarnessHistory,
  renderTranscriptTurns,
} from '../runtime/harness/session-transcript.js';

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
const PRIOR_SESSION_SEED_PAGE_SIZE = 100;

interface PriorSessionSeedCandidate {
  id: string;
  updatedAt: string;
  transcript: string;
  source: 'legacy' | 'harness';
}

function userIdForPriorSessionSeed(store: SessionStore, currentSessionId: string): string | undefined {
  try {
    const harnessUserId = getHarnessSession(currentSessionId)?.userId ?? undefined;
    if (harnessUserId) return harnessUserId;
  } catch {
    // Try legacy below.
  }
  try {
    const legacy = store.get(currentSessionId);
    if (legacy.userId) return legacy.userId;
  } catch {
    return undefined;
  }
  return undefined;
}

function legacyPriorSessionCandidates(
  store: SessionStore,
  currentSessionId: string,
  userId: string,
): PriorSessionSeedCandidate[] {
  return store.listByUser(userId, 8)
    .filter((s) => s.id !== currentSessionId && s.turns.length > 0)
    .filter((s) => {
      try {
        return !(getHarnessSession(s.id) && isPureAsyncOutcomeLegacyGhost(s));
      } catch {
        return true;
      }
    })
    .map((s) => ({ id: s.id, updatedAt: s.updatedAt, transcript: store.recentTranscript(s.id, 4).trim(), source: 'legacy' as const }))
    .filter((candidate) => candidate.transcript.length > 0);
}

function harnessPriorSessionCandidates(
  currentSessionId: string,
  userId: string,
): PriorSessionSeedCandidate[] {
  const out: PriorSessionSeedCandidate[] = [];
  try {
    for (let offset = 0; ; offset += PRIOR_SESSION_SEED_PAGE_SIZE) {
      const page = listHarnessSessions({ kind: 'chat', status: 'any', limit: PRIOR_SESSION_SEED_PAGE_SIZE, offset });
      for (const row of page) {
        if (row.id === currentSessionId || row.userId !== userId) continue;
        const updatedMs = Date.parse(row.updatedAt);
        if (!Number.isFinite(updatedMs) || Date.now() - updatedMs > PRIOR_SESSION_SEED_WINDOW_MS) continue;
        const turns = pullRecentTurnsForHarnessHistory(row.id, 4);
        const transcript = renderTranscriptTurns(turns).trim();
        if (transcript) out.push({ id: row.id, updatedAt: row.updatedAt, transcript, source: 'harness' });
        if (out.length >= 8) return out;
      }
      if (page.length < PRIOR_SESSION_SEED_PAGE_SIZE) break;
      const oldestMs = Date.parse(page[page.length - 1]?.updatedAt ?? '');
      if (Number.isFinite(oldestMs) && Date.now() - oldestMs > PRIOR_SESSION_SEED_WINDOW_MS) break;
    }
  } catch {
    // Best-effort only; legacy candidates still work.
  }
  return out;
}

function buildPriorSessionSeed(currentSessionId: string): string | undefined {
  try {
    const store = new SessionStore();
    const userId = userIdForPriorSessionSeed(store, currentSessionId);
    if (!userId) return undefined;
    const sibling = canonicalPriorSessionSeedCandidates([
      ...legacyPriorSessionCandidates(store, currentSessionId, userId),
      ...harnessPriorSessionCandidates(currentSessionId, userId),
    ])
      .filter((candidate) => Date.now() - Date.parse(candidate.updatedAt) <= PRIOR_SESSION_SEED_WINDOW_MS)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!sibling) return undefined;
    const mins = Math.max(1, Math.round((Date.now() - Date.parse(sibling.updatedAt)) / 60000));
    return `Prior session (your other recent conversation ~${mins}m ago — context only; the user may be continuing it here):\n${sibling.transcript.slice(0, 700)}`;
  } catch {
    return undefined;
  }
}

function canonicalPriorSessionSeedCandidates(candidates: PriorSessionSeedCandidate[]): PriorSessionSeedCandidate[] {
  const byId = new Map<string, PriorSessionSeedCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.id);
    if (!existing || (existing.source === 'legacy' && candidate.source === 'harness')) {
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()];
}

function mergeContinuity(brief: string | undefined, seed: string | undefined): string | undefined {
  return [brief, seed].filter(Boolean).join('\n\n') || undefined;
}

/**
 * Async prompt context assembly for the legacy/direct assistant lane. Archival
 * recall deliberately goes through the same evidence-backed full-memory primer
 * as the flagship harnesses; this lane is still reachable as a channel and
 * workflow fallback, so vault-only recall here would make reliability depend on
 * which runtime happened to answer the turn.
 *
 * The memory budget is driven by the message-intent classifier:
 * casual / meta messages skip vault search and working memory; lookup
 * and action messages get the full retrieval pass.
 */
export async function assemblePromptContextAsync(sessionId: string, message: string, _transcript: string): Promise<AssembledPromptContext> {
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
  const objective = getRecallObjective(message) ?? message;
  const primer = budget.vaultSearchTopK > 0
    ? await buildUnifiedTurnPrimer({
        query: objective,
        surface: 'legacy_assistant_primer',
        limit: budget.vaultSearchTopK,
        maxChars: budget.vaultFormatBytes,
        timeoutMs: 1_500,
        sessionId,
      })
    : null;
  let retrievalText = primer?.text ?? '';
  if (!retrievalText && primer && ['timeout', 'error', 'disabled'].includes(primer.status)) {
    // The shared ranker can be unavailable during cold model load, provider
    // failure, or an operator kill-switch. Preserve a bounded lexical vault
    // safety net so a recorded meeting is still discoverable; label it
    // explicitly so neither the model nor health UI mistakes it for full recall.
    const fallbackHits = searchVault(objective, budget.vaultSearchTopK);
    const formatted = formatSearchHits(fallbackHits, budget.vaultFormatBytes);
    const included = formatted.match(/^- /gm)?.length ?? 0;
    retrievalText = formatted
      ? `[MEMORY PRIMER DEGRADED — vault-only lexical fallback after unified ${primer.status}]\n${formatted}`
      : '';
    appendFactRecallTrace({
      surface: 'turn_memory_primer',
      query: objective,
      mode: `legacy_assistant_fallback_${primer.status}`,
      sessionId,
      facts: [],
      includedCount: included,
      omittedCount: Math.max(0, fallbackHits.length - included),
      candidateCount: fallbackHits.length,
    });
  }
  return {
    memoryContext,
    retrievalText,
    recallId: primer?.recallId,
  };
}
