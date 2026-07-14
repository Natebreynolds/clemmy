import { statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import { embedMissingChunks, embedMissingFacts, isEmbeddingsEnabled } from './embeddings.js';
import { STATE_DIR, backupMemoryDb, reapStaleEpisodicPointers, purgeSoftDeletedFacts } from './db.js';
import { reindexVault } from './indexer.js';
import { tickMemoryMdRefresh } from './memory-md-builder.js';
import { tickIdentityMdRefresh } from './identity-md-builder.js';
import { tickAutoresearchObservatory } from '../autoresearch/observatory.js';
import { mergeParaphrases } from './memory-merge.js';
import { syncFactEntityLinks, syncFactResourceLinks } from './relations.js';
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
import { recoverPendingLocalAudioDeletions } from '../integrations/local-meetings/meeting-capture.js';
import { createBackgroundTask } from '../execution/background-tasks.js';
import { checkAllSkillUpdates } from '../runtime/skill-installer.js';
import { addNotification, reapStaleNotifications } from '../runtime/notifications.js';
import { reapExpiredGoals } from '../agents/plan-proposals.js';
import { reapStaleCheckIns } from '../agents/check-ins.js';
import { previousLocalDayKey, runTaskLedgerHygiene } from '../tasks/task-ledger-hygiene.js';
import { runReportOnlyCurator } from './curator.js';

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
 *   backfill  — every M ticks (~120s) when an embedding provider is available.
 *               Embeds at most BACKFILL_BATCH rows per store per pass so the
 *               provider budget and event loop both stay sane. A 5k-chunk
 *               cold-start vault takes ~25 passes (~50 minutes) to fully embed
 *               — by design, so we never block the daemon for long.
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

// Procedural-memory self-heal (Wave 2). Re-applies the cross-service / async-
// task-post guard across the tool-choice store and invalidates (recoverable)
// any active choice that's provably mis-bound — heals pollution that predates
// the write-time guard or slipped through its fail-open path. One Composio
// toolkit-list call + a store scan, so ~6h is plenty (new pollution is already
// blocked at write time).
const TOOLCHOICE_AUDIT_EVERY_N_TICKS = 1440; // ~6h with a 15s tick

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
const LOCAL_AUDIO_DELETION_EVERY_N_TICKS = 20; // ~5min with a 15s tick
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
  lastMemorySelfHealDay?: string;
  lastMergeDay?: string;
  lastGoalReapDay?: string;
  lastTaskLedgerHygieneDay?: string;
  lastNotificationReapDay?: string;
  lastCuratorReportDay?: string;
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

// Memory self-heal parity: runs after the nightly DB backup and before the
// older paraphrase merge. It is bounded, audited, reversible, and kill-switched
// independently from the report-only curator and approval UI.
const MEMORY_SELF_HEAL_NIGHTLY_HOUR = 4;
const MEMORY_SELF_HEAL_NIGHTLY_MINUTE = 35;

// Tier C2b — nightly paraphrase merge (default on; CLEMMY_MERGE_ENABLED=false
// to disable). Consolidates semantically identical facts with entity-aware
// guards to prevent merging facts about different tables/clients/accounts.
// Runs once per local day at 4:45, after backup. Fully reversible via audit log.
const MEMORY_MERGE_NIGHTLY_HOUR = 4;
const MEMORY_MERGE_NIGHTLY_MINUTE = 45; // offset from backup's 4:30

// Goal-contract reaper (GOAL-CONTRACT-PLAN.md Phase 1) — daily goal hygiene:
// chat-origin active goals idle >24h expire (one inbox note when mid-flight),
// workflow-origin goals are exempt, terminal records >7d purge. Runs at 5:00,
// offset from the merge's 4:45.
const GOAL_REAP_NIGHTLY_HOUR = 5;
const GOAL_REAP_NIGHTLY_MINUTE = 0;

// Task ledger hygiene — closes execution-owned task rows whose executions are
// already terminal, compacts checked rows out of Pending, and closes only
// unowned rows that were due before today. Runs just before the 5 PM EOD
// workflow so the wrap-up sees a groomed active queue.
const TASK_LEDGER_HYGIENE_DAILY_HOUR = 16;
const TASK_LEDGER_HYGIENE_DAILY_MINUTE = 55;

// Notification hygiene — stale unread approval/execution cards flip to read,
// >30d records purge. Also runs at daemon boot (daemon/runner.ts). 5:15,
// offset from the goal reaper's 5:00.
const NOTIFICATION_REAP_NIGHTLY_HOUR = 5;
const NOTIFICATION_REAP_NIGHTLY_MINUTE = 15;

// Report-only curator. Reads memory/skills/workflows/procedural tool choices and
// writes a daily drift report; it never mutates those stores.
const CURATOR_REPORT_DAILY_HOUR = 5;
const CURATOR_REPORT_DAILY_MINUTE = 30;

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

  // Procedural-memory self-heal (Wave 2 ever-learning robustness). Sweeps the
  // tool-choice store for cross-service / async-task-post mis-bindings and
  // invalidates them (recoverable). Best-effort; no-ops without a known-toolkit
  // baseline so a Composio outage can't quarantine the store.
  if (tickCount % TOOLCHOICE_AUDIT_EVERY_N_TICKS === 0) {
    try {
      const { auditAndHealToolChoices, isToolChoiceAuditEnabled } = await import('./tool-choice-audit.js');
      if (isToolChoiceAuditEnabled()) {
        const hits = await auditAndHealToolChoices();
        if (hits.length > 0) {
          logger.info(
            { healed: hits.length, hits: hits.map((h) => ({ reason: h.reason, identifier: h.identifier })) },
            'tool-choice audit: healed polluted procedural bindings',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'tool-choice audit tick failed');
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
            startCanonicalTranscriptBackfill({
              windowId: record.windowId,
              recordingId: record.recordingId,
              region: record.sdkUploadRegion,
            });
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

  // keepAudio=false is a durable privacy intent. Retry failed/pending
  // deletions during normal daemon maintenance so a transient file lock does
  // not retain raw meeting audio until the next application restart.
  if (tickCount % LOCAL_AUDIO_DELETION_EVERY_N_TICKS === 0) {
    try {
      const cleanup = recoverPendingLocalAudioDeletions({ force: true });
      if (cleanup.deleted > 0 || cleanup.failed > 0) {
        logger.info({ cleanup: { ...cleanup, exhausted: cleanup.exhausted.length } }, 'local meeting audio privacy cleanup tick');
      }
      // A deletion that exhausted its retry cap is surfaced ONCE (durable
      // marker in the record) — silent retry-forever hid the retained audio.
      for (const item of cleanup.exhausted) {
        addNotification({
          id: `local-audio-delete-exhausted-${item.meetingId}`,
          kind: 'system',
          read: false,
          createdAt: new Date().toISOString(),
          title: 'Could not delete a meeting recording',
          body: `The audio for "${item.title ?? 'a recorded meeting'}" could not be deleted after repeated tries (the file may be locked).${item.audioPath ? ` Remove it manually: ${item.audioPath}` : ''}`,
        });
      }
    } catch (err) {
      logger.warn({ err }, 'local meeting audio privacy cleanup tick failed');
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

  // Memory self-heal at 4:35 AM local — AFTER backup, BEFORE merge/curator.
  // This applies only bounded, reversible memory fixes; any thrown error is
  // logged and never blocks the rest of maintenance.
  if (isAtOrAfterDailyTime(now, MEMORY_SELF_HEAL_NIGHTLY_HOUR, MEMORY_SELF_HEAL_NIGHTLY_MINUTE)) {
    if (maintenanceState.lastMemorySelfHealDay !== today) {
      maintenanceState.lastMemorySelfHealDay = today;
      writeMaintenanceState(maintenanceState);
      try {
        const { runMemorySelfHeal } = await import('./self-heal.js');
        const outcome = await runMemorySelfHeal();
        if (outcome.ran && (outcome.proposed > 0 || outcome.applied > 0 || outcome.skipped.length > 0)) {
          logger.info(
            { proposed: outcome.proposed, applied: outcome.applied, skipped: outcome.skipped.length },
            'memory self-heal nightly job completed',
          );
        }
      } catch (err) {
        logger.warn({ err }, 'memory self-heal nightly job failed');
      }
    }
  }

  // Tier C2b — nightly paraphrase merge at 4:45 AM local (default on).
  // Entity-aware consolidation of semantic duplicates. Fully reversible via
  // audit log + soft-delete. Fire-once-per-day, persisted dedupe.
  if (isAtOrAfterDailyTime(now, MEMORY_MERGE_NIGHTLY_HOUR, MEMORY_MERGE_NIGHTLY_MINUTE)) {
    if (maintenanceState.lastMergeDay !== today) {
      maintenanceState.lastMergeDay = today;
      writeMaintenanceState(maintenanceState);
      try {
        const stats = await mergeParaphrases();
        if (stats.clustersFound > 0 || stats.errors > 0) {
          logger.info({ stats }, 'paraphrase merge nightly job completed');
        }
      } catch (err) {
        logger.warn({ err }, 'paraphrase merge nightly job failed');
      }
      // WS2 — refresh stored fact↔entity / fact↔resource links AFTER the merge
      // (merge rewrites/retires facts, so links re-derive against the settled
      // set). Deterministic + idempotent; the graph reads these stored edges.
      try {
        const ent = syncFactEntityLinks();
        const rsc = syncFactResourceLinks();
        if (ent.linksWritten > 0 || rsc.linksWritten > 0) {
          logger.info({ entityLinks: ent.linksWritten, resourceLinks: rsc.linksWritten }, 'relationship link sync completed');
        }
      } catch (err) {
        logger.warn({ err }, 'relationship link sync failed');
      }
      // WS6 — hard-purge facts soft-deleted well beyond the recovery window so
      // consolidated_facts + fact_embeddings stop growing forever (FK CASCADE
      // drops their embeddings + links). Default 180d; floored at 30d.
      try {
        const purged = purgeSoftDeletedFacts();
        if (purged > 0) logger.info({ purged }, 'soft-deleted fact hard-purge completed');
      } catch (err) {
        logger.warn({ err }, 'soft-deleted fact hard-purge failed');
      }
    }
  }

  // Goal-contract reaper at 5:00 AM local (GOAL-CONTRACT-PLAN.md Phase 1).
  // Same fire-once-per-day persisted dedupe as the jobs above.
  if (isAtOrAfterDailyTime(now, GOAL_REAP_NIGHTLY_HOUR, GOAL_REAP_NIGHTLY_MINUTE)) {
    if (maintenanceState.lastGoalReapDay !== today) {
      maintenanceState.lastGoalReapDay = today;
      writeMaintenanceState(maintenanceState);
      try {
        const stats = reapExpiredGoals(now);
        if (stats.expired > 0 || stats.purged > 0) {
          logger.info({ stats }, 'goal reaper nightly job completed');
        }
      } catch (err) {
        logger.warn({ err }, 'goal reaper nightly job failed');
      }
    }
  }

  // Task-ledger hygiene before end-of-day. The cutoff is "yesterday" so a
  // legitimate manual task due today is still visible in the EOD urgent list;
  // only already-stale unowned rows are closed automatically.
  if (isAtOrAfterDailyTime(now, TASK_LEDGER_HYGIENE_DAILY_HOUR, TASK_LEDGER_HYGIENE_DAILY_MINUTE)) {
    const taskHygieneEnabled = (getRuntimeEnv('CLEMMY_TASK_LEDGER_HYGIENE', 'on') || 'on').toLowerCase() !== 'off';
    if (taskHygieneEnabled && maintenanceState.lastTaskLedgerHygieneDay !== today) {
      maintenanceState.lastTaskLedgerHygieneDay = today;
      writeMaintenanceState(maintenanceState);
      try {
        const stats = runTaskLedgerHygiene({
          apply: true,
          closeUnownedBefore: previousLocalDayKey(now),
          now,
        });
        if (stats.repairableTasks > 0 || stats.compactedTaskRows > 0 || stats.updatedBindings > 0) {
          logger.info({ stats }, 'task ledger hygiene daily job completed');
        }
      } catch (err) {
        logger.warn({ err }, 'task ledger hygiene daily job failed');
      }
    }
  }

  // Notification reaper at 5:15 AM local. Same fire-once-per-day dedupe.
  if (isAtOrAfterDailyTime(now, NOTIFICATION_REAP_NIGHTLY_HOUR, NOTIFICATION_REAP_NIGHTLY_MINUTE)) {
    if (maintenanceState.lastNotificationReapDay !== today) {
      maintenanceState.lastNotificationReapDay = today;
      writeMaintenanceState(maintenanceState);
      try {
        const stats = reapStaleNotifications();
        if (stats.markedRead > 0 || stats.purged > 0) {
          logger.info({ stats }, 'notification reaper nightly job completed');
        }
      } catch (err) {
        logger.warn({ err }, 'notification reaper nightly job failed');
      }
      try {
        const closedCheckIns = reapStaleCheckIns();
        if (closedCheckIns > 0) {
          logger.info({ closedCheckIns }, 'check-in reaper nightly job completed');
        }
      } catch (err) {
        logger.warn({ err }, 'check-in reaper nightly job failed');
      }
    }
  }

  // Hermes-inspired curator foundation: report-only and recoverable by design.
  // It produces a small daily JSON report that can later back an approval-gated
  // cleanup UI. No memory, skill, workflow, or tool-choice mutation happens here.
  if (isAtOrAfterDailyTime(now, CURATOR_REPORT_DAILY_HOUR, CURATOR_REPORT_DAILY_MINUTE)) {
    const curatorEnabled = (getRuntimeEnv('CLEMMY_CURATOR_REPORT', 'on') || 'on').toLowerCase() !== 'off';
    if (curatorEnabled && maintenanceState.lastCuratorReportDay !== today) {
      maintenanceState.lastCuratorReportDay = today;
      writeMaintenanceState(maintenanceState);
      try {
        const { report, path: reportPath } = runReportOnlyCurator(now);
        logger.info(
          { reportPath, findings: report.findings.length, counts: report.counts },
          'report-only curator completed',
        );
      } catch (err) {
        logger.warn({ err }, 'report-only curator failed');
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
