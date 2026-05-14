import { loadMemoryContext } from './vault.js';
import { loadSessionBrief, renderSessionContinuity } from './session-briefs.js';
import { formatSearchHits, searchVault, searchVaultAsync } from './search.js';
import type { AssembledPromptContext } from '../types.js';

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
 */
export async function assemblePromptContextAsync(sessionId: string, message: string, transcript: string): Promise<AssembledPromptContext> {
  const brief = loadSessionBrief(sessionId);
  const memoryContext = {
    ...loadMemoryContext(),
    sessionBrief: renderSessionContinuity(brief),
  };
  const hits = await searchVaultAsync(buildSearchQuery(memoryContext, message, transcript), 6);
  return {
    memoryContext,
    retrievalText: formatSearchHits(hits, 2400),
  };
}

/**
 * Sync variant for code paths that cannot await. Skips the embedding
 * rerank step.
 */
export function assemblePromptContext(sessionId: string, message: string, transcript: string): AssembledPromptContext {
  const brief = loadSessionBrief(sessionId);
  const memoryContext = {
    ...loadMemoryContext(),
    sessionBrief: renderSessionContinuity(brief),
  };
  const hits = searchVault(buildSearchQuery(memoryContext, message, transcript), 6);
  return {
    memoryContext,
    retrievalText: formatSearchHits(hits, 2400),
  };
}
