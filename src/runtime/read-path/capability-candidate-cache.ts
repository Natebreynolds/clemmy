/**
 * The request-scoped handoff between candidate retrieval and the tool surface.
 *
 * Retrieval is asynchronous (a local model embed) but the seams that build a
 * turn's tool surface are synchronous and live in both brains. Rather than
 * thread an await through every one of them, the shared bridge resolves
 * candidates ONCE for the accepted turn and leaves them here; the JIT and MCP
 * recall seams read what is already there. A turn with nothing cached behaves
 * exactly as it did before — this only ever adds candidates.
 *
 * Deliberately tiny and dependency-free: it holds advisory names for the
 * lifetime of a turn, not state anything is allowed to act on later.
 */
import type { StepToolChoiceMatch } from '../../memory/tool-choice-store.js';

export type CachedTurnCandidates = {
  pinnedTools: string[];
  matches: StepToolChoiceMatch[];
};

/** A handful of concurrent turns, and short enough that a stale entry cannot
 *  outlive the request that produced it. */
const MAX_ENTRIES = 8;
const TTL_MS = 60_000;

const entries = new Map<string, { value: CachedTurnCandidates; at: number }>();

function key(userInput: string): string {
  return userInput.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function cacheTurnCandidates(userInput: string, value: CachedTurnCandidates): void {
  const k = key(userInput);
  if (!k) return;
  entries.delete(k);
  entries.set(k, { value, at: Date.now() });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function cachedTurnCandidates(userInput: string | null | undefined): CachedTurnCandidates | null {
  const k = key(userInput ?? '');
  if (!k) return null;
  const entry = entries.get(k);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) { entries.delete(k); return null; }
  return entry.value;
}

export function _resetTurnCandidateCacheForTest(): void {
  entries.clear();
}
