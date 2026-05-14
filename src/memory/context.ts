import { loadMemoryContext } from './vault.js';
import { loadSessionBrief, renderSessionContinuity } from './session-briefs.js';
import { loadWorkingMemoryForSession } from './working-memory.js';
import { formatSearchHits, searchVault, searchVaultAsync } from './search.js';
import type { AssembledPromptContext } from '../types.js';
import { classifyMessageIntent, memoryBudgetFor } from '../assistant/message-intent.js';

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
    sessionBrief: brief ? renderSessionContinuity(brief) : undefined,
  };
  const hits = budget.vaultSearchTopK > 0
    ? await searchVaultAsync(buildSearchQuery(memoryContext, message, transcript), budget.vaultSearchTopK)
    : [];
  return {
    memoryContext,
    retrievalText: formatSearchHits(hits, budget.vaultFormatBytes || 0),
  };
}

/**
 * Sync variant for code paths that cannot await. Skips the embedding
 * rerank step. Same intent-driven memory budget as the async path.
 */
export function assemblePromptContext(sessionId: string, message: string, transcript: string): AssembledPromptContext {
  const intent = classifyMessageIntent(message);
  const budget = memoryBudgetFor(intent.intent);
  const brief = budget.loadSessionBrief ? loadSessionBrief(sessionId) : undefined;
  const memoryContext = {
    ...loadMemoryContext(),
    workingMemory: budget.loadWorkingMemory ? loadWorkingMemoryForSession(sessionId) : undefined,
    sessionBrief: brief ? renderSessionContinuity(brief) : undefined,
  };
  const hits = budget.vaultSearchTopK > 0
    ? searchVault(buildSearchQuery(memoryContext, message, transcript), budget.vaultSearchTopK)
    : [];
  return {
    memoryContext,
    retrievalText: formatSearchHits(hits, budget.vaultFormatBytes || 0),
  };
}
