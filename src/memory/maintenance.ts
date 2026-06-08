import { statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import { embedMissingChunks, embedMissingFacts, isEmbeddingsEnabled } from './embeddings.js';
import { STATE_DIR, backupMemoryDb, reapStaleEpisodicPointers } from './db.js';
import { reindexVault } from './indexer.js';
import { tickMemoryMdRefresh } from './memory-md-builder.js';
import { tickIdentityMdRefresh } from './identity-md-builder.js';
import { tickAutoresearchObservatory } from '../autoresearch/observatory.js';
import { reapStaleToolOutputs, reapStaleSessions } from '../runtime/harness/eventlog.js';
import {
  reapStuckRecallRecordings,
  loadRecallMeetingSettings,
  buildAnalyzerPrompt,
  listAllRecallMeetingRecords,
  analysisPathFor,
  fileMeetingFromAnalysis,
} from '../integrations/recall/meeting-capture.js';
import { startCanonicalTranscriptBackfill } from '../integrations/recall/backfill.js';
import { createBackgroundTask } from '../execution/background-tasks.js';
import { checkAllSkillUpdates } from '../runtime/skill-installer.js';
import { addNotification } from '../runtime/notifications.js';

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

// v0.5.22 — tool_outputs reaper. The table grew unbounded (~10MB/day
// at observed rates) because the recall_tool_result store had no TTL.
// Runs once per hour: catches today's writes before the next tick,
// cheap (single DELETE with index on created_at). Each row is 4KB-200KB
// so even on a busy day the delete-set is bounded.
const EVENTLOG_REAPER_EVERY_N_TICKS = 240; // ~1h with a 15s tick
// Recall stuck-recording reaper. Some captures (notably the
// desktop-audio fallback, which isn't tied to a meeting window) never
// get the SDK's recording-ended event, so they hang in 'recording'
// forever — a perpetual "LIVE" ghost in the meetings panel with no
// analysis. Check every ~5 min; reapStuckRecallRecordings only
// finalizes records idle (no new transcript) for 60+ min, so a live
// call is never cut off. Cheap: a readdir + per-record timestamp check.
const RECALL_REAPER_EVERY_N_TICKS = 20; // ~5min with a 15s tick
// Meeting filing reconcile. Folds the analyzer-derived title + summary
// into each meeting's vault note so the existing reindex/embedding ticks
// make the high-signal content searchable (not just the raw transcript).
// Backfills existing meetings automatically on first run after update.
// Cheap: skips any note already newer than its analysis JSON (2 stats),
// so steady-state work is ~0 once everything is filed.
const MEETING_FILING_EVERY_N_TICKS = 8; // ~2min with a 15s tick
// Track the last calendar day on which we fired each nightly job so we
// don't re-fire 240 times across the matching minute window (15s ticks
// inside 3:00–3:00:59 would otherwise all match). PERSISTED to disk (Tier
// C4) so a daemon restart inside the 3:00–4:30 window can't double-fire:
// previously these were per-process `let`s that reset to '' on every boot.
interface MemoryMaintenanceState {
  lastNightlyFireDay?: string;
  lastSkillUpdateFireDay?: string;
  lastBackupDay?: string;
}
const MAINTENANCE_STATE_FILE = path.join(STATE_DIR, 'memory-maintenance-state.json');

function readMaintenanceState(): MemoryMaintenanceState {
  try {
    return JSON.parse(readFileSync(MAINTENANCE_STATE_FILE, 'utf-8')) as MemoryMaintenanceState;
  } catch {
    return {};
  }
}

function writeMaintenanceState(state: MemoryMaintenanceState): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(MAINTENANCE_STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'failed to persist memory-maintenance state');
  }
}

// Loaded once at module init, mutated + persisted on each nightly fire.
const maintenanceState: MemoryMaintenanceState = readMaintenanceState();

// Skill update poll. Installed skills (SKILL.md repos) drift behind
// their GitHub source; this surfaces "update available" without forcing
// the user to reinstall by hand. DETECTION ONLY — it never mutates an
// installed skill (applying an update is approval-gated, via the manual
// "Update" button). The check is one `git ls-remote` per unique repo,
// so it's cheap enough to run on a daily cadence + a nightly fire.
const SKILL_UPDATE_EVERY_N_TICKS = 5760; // ~24h with a 15s tick
const SKILL_UPDATE_NIGHTLY_HOUR = 4;     // 4:00 AM local (offset from autoresearch's 3:00)
const SKILL_UPDATE_NIGHTLY_MINUTE = 0;
let skillUpdateCheckInFlight = false;

// Tier C2 — nightly memory.db backup (default on; CLEMMY_MEMORY_BACKUP=off
// to disable). Fires once per local day at/after the backup hour, deduped
// via the persisted lastBackupDay. Retains the newest N snapshots.
const MEMORY_BACKUP_NIGHTLY_HOUR = 4;
const MEMORY_BACKUP_NIGHTLY_MINUTE = 30; // offset from skill-update's 4:00
const MEMORY_BACKUP_RETAIN = 7;

// Tier C3 — episodic_pointers TTL reaper cadence (~1h, same as the
// tool_outputs reaper it shadows).
const EPISODIC_REAPER_EVERY_N_TICKS = 240; // ~1h with a 15s tick

/**
 * Run the skill update poll out-of-band (the network calls shouldn't
 * block the daemon tick) and notify when updates land. Single-flighted
 * so an overlapping cadence + nightly fire can't double-run. The
 * notification id is keyed on the exact (name@remoteSha) set, so a
 * still-pending update doesn't re-ping the user every day — only a NEW
 * upstream commit produces a new id and a fresh notification.
 */
function runSkillUpdatePoll(reason: 'cadence' | 'nightly'): void {
  if (skillUpdateCheckInFlight) return;
  skillUpdateCheckInFlight = true;
  void checkAllSkillUpdates()
    .then((summary) => {
      const names = summary.updatesAvailable;
      if (names.length > 0) {
        const seed = names
          .map((n) => {
            const r = summary.results.find((x) => x.name === n);
            return `${n}@${(r?.remoteSha ?? '').slice(0, 12)}`;
          })
          .sort()
          .join(',');
        const id = `skill-updates-${createHash('sha1').update(seed).digest('hex').slice(0, 12)}`;
        addNotification({
          id,
          kind: 'system',
          read: false,
          createdAt: new Date().toISOString(),
          title: `${names.length} skill update${names.length === 1 ? '' : 's'} available`,
          body: `New upstream commits for: ${names.join(', ')}. Open Settings → Skills to review and update.`,
          metadata: { skills: names, source: 'skill-update-poll' },
        });
      }
      logger.info(
        { reason, updates: names.length, checked: summary.results.length },
        'skill update poll tick',
      );
    })
    .catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'skill update poll tick failed');
    })
    .finally(() => {
      skillUpdateCheckInFlight = false;
    });
}

/**
 * True at or after `hour`:`minute` local time. Used WITH a per-day fire-once
 * stamp so a nightly job still runs (catches up) on the first tick after the
 * machine wakes, instead of silently skipping the day when it was asleep across
 * the exact gate minute. Replaces the old `getHours()===H && getMinutes()===M`
 * exact-minute gate that lost the whole day on an intermittent laptop.
 */
export function isAtOrAfterDailyTime(now: Date, hour: number, minute: number): boolean {
  const h = now.getHours();
  return h > hour || (h === hour && now.getMinutes() >= minute);
}

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
    // Facts get the same incremental, circuit-broken backfill so the
    // conflict resolver's semantic findSimilarFacts has vectors to rank
    // against. Re-embeds facts whose content changed (Mem0 UPDATE).
    try {
      const factStats = await embedMissingFacts({ maxChunks: BACKFILL_BATCH });
      if (factStats.embedded > 0 || factStats.failed > 0) {
        logger.info({ stats: factStats }, 'fact embedding backfill tick');
      }
    } catch (err) {
      logger.warn({ err }, 'fact embedding backfill tick failed');
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

  // v0.5.22 — drop stale tool_outputs (default 14-day TTL). Without
  // this, harness.db grows ~10MB/day. The reaper itself is one indexed
  // DELETE; log only when rows were actually dropped.
  if (tickCount % EVENTLOG_REAPER_EVERY_N_TICKS === 0) {
    try {
      const deleted = reapStaleToolOutputs();
      if (deleted > 0) {
        logger.info({ deleted }, 'tool_outputs reaper tick');
      }
    } catch (err) {
      logger.warn({ err }, 'tool_outputs reaper tick failed');
    }
    // Reap terminal sessions (+ cascade their events) so harness.db doesn't
    // grow unbounded. Active/paused sessions are kept so the user can resume.
    try {
      const deletedSessions = reapStaleSessions();
      if (deletedSessions > 0) {
        logger.info({ deletedSessions }, 'sessions reaper tick');
      }
    } catch (err) {
      logger.warn({ err }, 'sessions reaper tick failed');
    }
  }

  // Tier C3 — episodic_pointers TTL reaper. Pointers outlive the tool
  // outputs they reference (eventlog reaper drops those at ~14d), so a
  // pointer past its TTL is a dead breadcrumb. Same always-on, indexed-
  // DELETE class as the tool_outputs reaper above. Tunable TTL.
  if (tickCount % EPISODIC_REAPER_EVERY_N_TICKS === 0) {
    try {
      const ttl = Number.parseInt(getRuntimeEnv('CLEMMY_EPISODIC_TTL_DAYS', '30') || '30', 10);
      const deleted = reapStaleEpisodicPointers({ maxAgeDays: Number.isFinite(ttl) && ttl > 0 ? ttl : 30 });
      if (deleted > 0) {
        logger.info({ deleted }, 'episodic_pointers reaper tick');
      }
    } catch (err) {
      logger.warn({ err }, 'episodic_pointers reaper tick failed');
    }
  }

  // Recall stuck-recording reaper — finalize abandoned 'recording'
  // records so they stop showing as live and get analyzed. Mirrors the
  // post-processing the /api/console/meetings/recall/complete route does
  // on a normal recording-ended: reindex the vault, queue the analyzer,
  // and (when there's a recordingId) kick the canonical-transcript
  // backfill.
  if (tickCount % RECALL_REAPER_EVERY_N_TICKS === 0) {
    try {
      const finalized = reapStuckRecallRecordings();
      if (finalized.length > 0) {
        const settings = loadRecallMeetingSettings();
        let reindexed = false;
        for (const { record, artifactPath } of finalized) {
          if (artifactPath && !reindexed) {
            try { reindexVault(); reindexed = true; } catch { /* maintenance reindex tick will retry */ }
          }
          if (record.recordingId) {
            startCanonicalTranscriptBackfill({ windowId: record.windowId, recordingId: record.recordingId });
          }
          if (artifactPath && settings.analyzeOnComplete) {
            createBackgroundTask({
              title: `Analyze meeting transcript: ${record.title || record.platform || record.id}`,
              prompt: buildAnalyzerPrompt(record, artifactPath),
              source: 'daemon',
              channel: 'electron:meeting-capture',
              maxMinutes: 30,
            });
          }
        }
        logger.info({ count: finalized.length }, 'recall stuck-recording reaper finalized abandoned captures');
      }
    } catch (err) {
      logger.warn({ err }, 'recall stuck-recording reaper tick failed');
    }
  }

  // Meeting filing — fold analyzer title + summary into vault notes so
  // they become searchable. Runs the reindex inline when it files
  // anything so the new content is queryable without waiting for the
  // separate reindex tick.
  if (tickCount % MEETING_FILING_EVERY_N_TICKS === 0) {
    try {
      const filed = tickMeetingFiling();
      if (filed > 0) {
        try { reindexVault(); } catch { /* reindex tick will retry */ }
        logger.info({ filed }, 'meeting filing tick folded analysis into vault');
      }
    } catch (err) {
      logger.warn({ err }, 'meeting filing tick failed');
    }
  }

  // Skill update poll — periodic ~24h cadence so a machine that's never
  // up at the nightly hour still gets checked. Out-of-band + single
  // flighted; detection only.
  if (tickCount % SKILL_UPDATE_EVERY_N_TICKS === 0) {
    runSkillUpdatePoll('cadence');
  }

  // Explicit nightly fire at 3:00 AM local. Independent of the periodic
  // cadence above — users want a guaranteed "fresh report when I wake
  // up." We check hour+minute, dedupe by calendar day so we fire ONCE
  // even though four 15s ticks land inside the matching minute.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (isAtOrAfterDailyTime(now, AUTORESEARCH_NIGHTLY_HOUR, AUTORESEARCH_NIGHTLY_MINUTE)) {
    if (maintenanceState.lastNightlyFireDay !== today) {
      maintenanceState.lastNightlyFireDay = today;
      writeMaintenanceState(maintenanceState);
      tickAutoresearchObservatory();
    }
  }

  // Guaranteed daily skill update check at 4:00 AM local (same
  // fire-once-per-day dedupe as autoresearch). Offset an hour so the two
  // nightly jobs don't pile onto the same tick.
  if (isAtOrAfterDailyTime(now, SKILL_UPDATE_NIGHTLY_HOUR, SKILL_UPDATE_NIGHTLY_MINUTE)) {
    if (maintenanceState.lastSkillUpdateFireDay !== today) {
      maintenanceState.lastSkillUpdateFireDay = today;
      writeMaintenanceState(maintenanceState);
      runSkillUpdatePoll('nightly');
    }
  }

  // Tier C2 — nightly memory.db backup at 4:30 AM local (default on).
  // Fire-once-per-day, persisted dedupe like the jobs above.
  if (isAtOrAfterDailyTime(now, MEMORY_BACKUP_NIGHTLY_HOUR, MEMORY_BACKUP_NIGHTLY_MINUTE)) {
    const backupEnabled = (getRuntimeEnv('CLEMMY_MEMORY_BACKUP', 'on') || 'on').toLowerCase() !== 'off';
    if (backupEnabled && maintenanceState.lastBackupDay !== today) {
      maintenanceState.lastBackupDay = today;
      writeMaintenanceState(maintenanceState);
      try {
        const result = backupMemoryDb({ retain: MEMORY_BACKUP_RETAIN });
        if (result) {
          logger.info({ backupPath: result.backupPath, bytes: result.bytes }, 'memory.db nightly backup written');
        } else {
          logger.warn('memory.db nightly backup returned no result');
        }
      } catch (err) {
        logger.warn({ err }, 'memory.db nightly backup failed');
      }
    }
  }
}

/**
 * For every meeting whose analysis JSON is newer than its filed vault
 * note (or never filed), fold the title + summary into the note. The
 * mtime comparison is the cheap idempotency guard: once a note is filed
 * it's newer than its analysis, so steady-state passes do ~no work and
 * re-analysis (which bumps the JSON mtime) re-files automatically.
 * Returns the number of notes actually rewritten.
 */
export function tickMeetingFiling(): number {
  let filed = 0;
  for (const record of listAllRecallMeetingRecords()) {
    const artifactPath = record.artifactPath;
    if (!artifactPath) continue;
    const analysisPath = analysisPathFor(record.id);
    let analysisMtime: number;
    let artifactMtime: number;
    try {
      analysisMtime = statSync(analysisPath).mtimeMs;
    } catch { continue; } // no analysis yet — nothing to fold in
    try {
      artifactMtime = statSync(artifactPath).mtimeMs;
    } catch { continue; } // note vanished — skip
    if (artifactMtime >= analysisMtime) continue; // already filed since last analysis
    try {
      if (fileMeetingFromAnalysis(record.id)) filed += 1;
    } catch { /* skip this one; next tick retries */ }
  }
  return filed;
}
