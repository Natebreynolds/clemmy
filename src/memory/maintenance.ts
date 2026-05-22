import pino from 'pino';
import { embedMissingChunks, isEmbeddingsEnabled } from './embeddings.js';
import { reindexVault } from './indexer.js';
import { tickMemoryMdRefresh } from './memory-md-builder.js';
import { tickIdentityMdRefresh } from './identity-md-builder.js';
import { tickAutoresearchObservatory } from '../autoresearch/observatory.js';

/**
 * Memory maintenance for the daemon tick.
 *
 * The daemon owns its own tick cadence (currently 15s). We layer two
 * independent jobs on top of that with their own multipliers:
 *
 *   reindex   — every N ticks (~60s). Walks the vault, compares mtimes,
 *               re-chunks only changed files. Sub-millisecond when nothing
 *               changed; sub-100ms even for moderate change volume.
 *
 *   backfill  — every M ticks (~120s) when OPENAI_API_KEY is set. Embeds
 *               at most BACKFILL_BATCH chunks per pass so the API budget
 *               and event loop both stay sane. A 5k-chunk cold-start vault
 *               takes ~25 passes (~50 minutes) to fully embed — by design,
 *               so we never block the daemon for long.
 *
 * Logs are intentionally quiet: only when work actually happened. The
 * dashboard + doctor surface live counts; this module just keeps them
 * fresh in the background.
 */

const logger = pino({ name: 'clementine-next.memory.maintenance' });

const REINDEX_EVERY_N_TICKS = 4;     // ~60s with a 15s tick
const BACKFILL_EVERY_N_TICKS = 8;    // ~120s with a 15s tick
const BACKFILL_BATCH = 200;          // chunks per pass — caps API spend per tick
// MEMORY.md is read into the agent's instructions on every turn. The
// auto-generated section is small (<= 6KB) and the source data
// (consolidated_facts table) changes whenever the agent calls
// memory_remember. Rebuilding every ~30 min is responsive without
// thrashing — and the builder no-ops when content hasn't changed,
// so churn is bounded by actual fact write activity.
const MEMORY_MD_EVERY_N_TICKS = 120; // ~30min with a 15s tick

// Autoresearch has TWO triggers:
//   1) the periodic ~6h cadence so the report stays fresh during the day;
//   2) an explicit nightly fire at 3:00 local time so users wake up to a
//      fresh report regardless of whether the daemon tick happened to
//      land in their window earlier.
// Both call the same tickAutoresearchObservatory; the writer is a
// no-op when content matches, so double-firing in the same minute is
// safe — the second call detects the duplicate and exits.
const AUTORESEARCH_EVERY_N_TICKS = 1440; // ~6h with a 15s tick
const AUTORESEARCH_NIGHTLY_HOUR = 3;     // 3:00 AM local
const AUTORESEARCH_NIGHTLY_MINUTE = 0;
// Track the last calendar day on which we fired the nightly run so we
// don't re-fire 240 times across the matching minute window (15s ticks
// inside 3:00–3:00:59 would otherwise all match). Reset per-process —
// the dedupe inside writeReport handles cross-restart safety.
let lastNightlyFireDay = '';

export async function processMemoryMaintenance(tickCount: number): Promise<void> {
  if (tickCount % REINDEX_EVERY_N_TICKS === 0) {
    try {
      const stats = reindexVault();
      // Only log when something actually changed — keeps the log clean.
      if (stats.changed > 0 || stats.removed > 0 || stats.errors > 0) {
        logger.info({ stats }, 'vault reindex tick');
      }
    } catch (err) {
      logger.warn({ err }, 'vault reindex tick failed');
    }
  }

  if (tickCount % BACKFILL_EVERY_N_TICKS === 0 && isEmbeddingsEnabled()) {
    try {
      const stats = await embedMissingChunks({ maxChunks: BACKFILL_BATCH });
      if (stats.embedded > 0 || stats.failed > 0) {
        logger.info({ stats }, 'embedding backfill tick');
      }
    } catch (err) {
      logger.warn({ err }, 'embedding backfill tick failed');
    }
  }

  if (tickCount % MEMORY_MD_EVERY_N_TICKS === 0) {
    // No-op if the rendered auto section matches what's already on
    // disk, so this is safe to fire every 30 min even on quiet days.
    tickMemoryMdRefresh();
    // IDENTITY.md auto section is driven by the user_profile, which
    // changes far less often than facts — but it's cheap to check and
    // the no-op path is fast (one stat + one string compare), so we
    // ride along on the same cadence rather than introducing a new
    // multiplier.
    tickIdentityMdRefresh();
  }

  // Autoresearch observatory — periodic cadence (~6h). Reads yesterday's
  // tool-events + workflow runs, writes a daily report to the vault
  // for human review. Pure read of trace data. Hot path: same file
  // exists and content unchanged → no-op (bounded by report dedupe
  // inside writeReport). Cold path: ~50-200ms for a busy day.
  if (tickCount % AUTORESEARCH_EVERY_N_TICKS === 0) {
    tickAutoresearchObservatory();
  }

  // Explicit nightly fire at 3:00 AM local. Independent of the periodic
  // cadence above — users want a guaranteed "fresh report when I wake
  // up." We check hour+minute, dedupe by calendar day so we fire ONCE
  // even though four 15s ticks land inside the matching minute.
  const now = new Date();
  if (now.getHours() === AUTORESEARCH_NIGHTLY_HOUR && now.getMinutes() === AUTORESEARCH_NIGHTLY_MINUTE) {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (lastNightlyFireDay !== today) {
      lastNightlyFireDay = today;
      tickAutoresearchObservatory();
    }
  }
}
