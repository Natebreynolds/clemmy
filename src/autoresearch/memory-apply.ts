/**
 * Memory-refinement APPLY — the "auto research for memory" P1 layer.
 *
 * This is the FIRST place the loop actually mutates the store, so it is
 * deliberately narrow: it applies ONLY the provably-safe class surfaced by the
 * detectors — synthetic smoke-test pollution matched by EXACT signature
 * (memory-detectors.ts: SYNTHETIC_JUNK_SIGNATURES). Everything that could touch
 * genuine user knowledge (near-dup merges, contradiction supersession, recall
 * fixes) stays behind P2/P3 human approval and is NEVER auto-applied here.
 *
 * Safety properties (all four hold):
 *   - SOFT delete (active=0) → fully recoverable via reactivateFact / the
 *     restore route for 30 days; the row, embedding and provenance survive.
 *   - CAPPED per run (default 25) → bounded blast radius even on a bad day.
 *   - PINNED-EXEMPT → user-pinned facts are never eligible.
 *   - AUDITED → every prune is written to the hygiene audit log (kind:
 *     'autoclean') so the owner can see and undo exactly what ran.
 *
 * Kill-switch: CLEMMY_MEMORY_AUTOCLEAN=off disables it everywhere (nightly +
 * manual). Default-ON because the class is provably non-user-knowledge.
 */
import { getRuntimeEnv } from '../config.js';
import { openMemoryDb } from '../memory/db.js';
import { deleteFact } from '../memory/facts.js';
import { appendHygieneAudit } from '../memory/hygiene-audit.js';
import { SYNTHETIC_JUNK_SIGNATURES } from './memory-detectors.js';

const DEFAULT_CAP = 25;
const MAX_CAP = 100;

export interface AutoCleanResult {
  /** Whether the pass actually executed (false when disabled / cap 0). */
  ran: boolean;
  /** How many facts were pruned (soft-deleted), or would be in a dry run. */
  pruned: number;
  ids: number[];
  examples: Array<{ id: number; content: string; signature: string }>;
  cap: number;
  dryRun: boolean;
  /** Set when the pass did not run (e.g. 'disabled'). */
  reason?: string;
}

export function autoCleanEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_MEMORY_AUTOCLEAN', 'on') || 'on').toLowerCase() !== 'off';
}

function trunc(s: string, n = 100): string {
  const c = s.replace(/\s+/g, ' ').trim();
  return c.length > n ? c.slice(0, n) + '…' : c;
}

/**
 * Soft-delete the provably-synthetic test-junk class. Idempotent (re-running
 * after a clean store is a no-op), capped, audited, reversible.
 *
 * @param opts.maxPrune  per-run cap (clamped to [0, 100], default 25)
 * @param opts.dryRun    when true, computes the candidate set without mutating
 * @param opts.nowIso    timestamp for the audit entry (injectable for tests)
 */
export function autoCleanSafeMemory(
  opts: { maxPrune?: number; dryRun?: boolean; nowIso?: string } = {},
): AutoCleanResult {
  const cap = Math.max(0, Math.min(MAX_CAP, opts.maxPrune ?? DEFAULT_CAP));
  const dryRun = opts.dryRun === true;
  const result: AutoCleanResult = { ran: false, pruned: 0, ids: [], examples: [], cap, dryRun };

  if (!autoCleanEnabled()) { result.reason = 'disabled'; return result; }
  if (cap === 0) { result.reason = 'cap-zero'; return result; }

  const db = openMemoryDb();
  const like = SYNTHETIC_JUNK_SIGNATURES.map(() => 'LOWER(content) LIKE ?').join(' OR ');
  const rows = db.prepare(
    `SELECT id, content FROM consolidated_facts
     WHERE active = 1 AND pinned = 0 AND (${like})
     ORDER BY id ASC LIMIT ?`,
  ).all(...SYNTHETIC_JUNK_SIGNATURES.map((s) => `%${s}%`), cap) as { id: number; content: string }[];

  result.ran = true;
  for (const row of rows) {
    const lc = row.content.toLowerCase();
    const sig = SYNTHETIC_JUNK_SIGNATURES.find((s) => lc.includes(s)) ?? 'synthetic';
    if (dryRun) {
      result.ids.push(row.id);
      result.pruned += 1;
      if (result.examples.length < 10) result.examples.push({ id: row.id, content: trunc(row.content), signature: sig });
      continue;
    }
    if (deleteFact(row.id)) {
      result.ids.push(row.id);
      result.pruned += 1;
      if (result.examples.length < 10) result.examples.push({ id: row.id, content: trunc(row.content), signature: sig });
    }
  }

  if (result.pruned > 0 && !dryRun) {
    appendHygieneAudit({
      at: opts.nowIso ?? new Date().toISOString(),
      kind: 'autoclean',
      ids: result.ids,
      detail: { pruned: result.pruned, cap, class: 'synthetic-test-junk', signatures: [...SYNTHETIC_JUNK_SIGNATURES] },
    });
  }
  return result;
}
