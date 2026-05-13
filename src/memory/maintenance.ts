import pino from 'pino';
import { embedMissingChunks, isEmbeddingsEnabled } from './embeddings.js';
import { reindexVault } from './indexer.js';

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
}
