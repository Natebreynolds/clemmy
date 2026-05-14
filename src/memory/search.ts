import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { VAULT_DIR } from './vault.js';
import { recall, recallHybrid, recallIndexSize } from './recall.js';
import { reindexVault } from './indexer.js';
import type { MemorySearchHit } from '../types.js';

/**
 * Vault search.
 *
 * Primary path is the SQLite FTS5 index via `recall`. Two safety nets:
 *  1. If the index is empty (first boot, never reindexed, or DB reset) we
 *     run a one-shot incremental index synchronously so the very first
 *     search returns useful hits.
 *  2. If FTS still returns nothing — or if anything in the DB path throws —
 *     we fall back to the original grep-style ranker. The vault on disk
 *     is the source of truth, so we always have a recovery path.
 *
 * Callers (`context.ts`, `tools/memory-tools.ts`) get all of this for free
 * because the exported signature is unchanged.
 */

const logger = pino({ name: 'clementine-next.memory.search' });

const MAX_FILE_BYTES = 100_000;

let lazyIndexAttempted = false;

function ensureIndexLazily(): void {
  if (lazyIndexAttempted) return;
  lazyIndexAttempted = true;
  if (recallIndexSize() > 0) return;
  if (!existsSync(VAULT_DIR)) return;

  try {
    const stats = reindexVault(VAULT_DIR);
    logger.info({ stats }, 'lazy vault index built');
  } catch (err) {
    logger.warn({ err }, 'lazy index failed; falling back to legacy search');
  }
}

/**
 * Sync FTS-only search. Use for code paths that can't await — kept around
 * mostly so legacy callers don't change shape. New callers should prefer
 * `searchVaultAsync` which adds the embedding rerank when available.
 */
export function searchVault(query: string, limit = 5): MemorySearchHit[] {
  try {
    ensureIndexLazily();
    const hits = recall(query, { limit });
    if (hits.length > 0) return hits;
  } catch (err) {
    logger.warn({ err }, 'recall failed; using legacy search');
  }
  return searchVaultLegacy(query, limit);
}

/**
 * Async search. Runs FTS5 then — when OPENAI_API_KEY is configured — does
 * an embedding rerank over the candidate pool with reciprocal rank fusion.
 * Silently falls back to FTS-only when embeddings are off or fail.
 */
export async function searchVaultAsync(query: string, limit = 5): Promise<MemorySearchHit[]> {
  try {
    ensureIndexLazily();
    const hits = await recallHybrid(query, { limit });
    if (hits.length > 0) return hits;
  } catch (err) {
    logger.warn({ err }, 'hybrid recall failed; using legacy search');
  }
  return searchVaultLegacy(query, limit);
}

export function formatSearchHits(hits: MemorySearchHit[], maxChars = 2000): string {
  if (hits.length === 0) return '';

  const parts: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const piece = `- ${hit.title} (${hit.filePath})\n  ${hit.snippet}`;
    if (used + piece.length > maxChars) break;
    parts.push(piece);
    used += piece.length;
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Legacy grep-style search. Kept as a safety net behind the FTS path.
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }

  return results;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function scoreContent(queryTerms: string[], content: string): number {
  const lower = content.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    const occurrences = lower.split(term).length - 1;
    if (occurrences > 0) {
      score += occurrences * 3;
      if (lower.includes(`# ${term}`) || lower.includes(`## ${term}`)) {
        score += 4;
      }
    }
  }

  return score;
}

function buildSnippet(content: string, queryTerms: string[], maxChars = 280): string {
  const lower = content.toLowerCase();
  let index = -1;
  for (const term of queryTerms) {
    index = lower.indexOf(term);
    if (index >= 0) break;
  }

  if (index < 0) {
    return content.trim().replace(/\s+/g, ' ').slice(0, maxChars);
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + 200);
  return content.slice(start, end).trim().replace(/\s+/g, ' ');
}

export function searchVaultLegacy(query: string, limit = 5): MemorySearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const hits: MemorySearchHit[] = [];
  const files = walk(VAULT_DIR);

  for (const filePath of files) {
    let content = '';
    try {
      content = readFileSync(filePath, 'utf-8').slice(0, MAX_FILE_BYTES);
    } catch {
      continue;
    }

    const score = scoreContent(terms, content);
    if (score <= 0) continue;

    hits.push({
      filePath,
      title: path.basename(filePath, '.md'),
      snippet: buildSnippet(content, terms),
      score,
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
