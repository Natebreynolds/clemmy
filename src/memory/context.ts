import { loadMemoryContext } from './vault.js';
import { formatSearchHits, searchVault } from './search.js';
import type { AssembledPromptContext } from '../types.js';

export function assemblePromptContext(message: string, transcript: string): AssembledPromptContext {
  const memoryContext = loadMemoryContext();
  const searchQuery = [
    message,
    transcript,
    memoryContext.workingMemory?.slice(0, 400) ?? '',
  ].filter(Boolean).join(' ').slice(0, 1200);
  const hits = searchVault(searchQuery, 6);
  const retrievalText = formatSearchHits(hits, 2400);

  return {
    memoryContext,
    retrievalText,
  };
}
