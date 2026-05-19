/**
 * One-shot repair: find sessions whose __interrupt_state metadata is
 * set but have NO matching row in pending_approvals, and backfill the
 * registry rows from the last approval_requested event so the reaper +
 * addressable approvals can act on them.
 *
 * Why this exists: pending_approvals was introduced in migration v2
 * (release 0.4.20). Sessions that paused BEFORE that migration are
 * orphans — the interrupt state is set on the session row, but no
 * pending_approvals row exists, so the registry treats them as
 * non-existent. The reaper would never expire them; addressable
 * "approve apr-xxx" can't find them; the user's "approve" reply
 * silently routes to whichever session the channelSessions map points
 * at — which is exactly the failure mode the audit found.
 *
 * Run: npx tsx scripts/repair-orphan-pauses.ts [--apply]
 *
 * Without --apply, it's a dry run that lists what would be repaired.
 * With --apply, it actually inserts the registry rows.
 *
 * Safe to re-run — already-registered sessions are skipped.
 */
import { argv, exit } from 'node:process';
import { openEventLog } from '../src/runtime/harness/eventlog.js';
import * as approvalRegistry from '../src/runtime/harness/approval-registry.js';

interface OrphanRow {
  sessionId: string;
  channel: string | null;
  interruptState: string;
  lastApprovalRequested?: {
    seq: number;
    createdAt: string;
    data: Record<string, unknown>;
  };
}

function findOrphans(): OrphanRow[] {
  const db = openEventLog();

  // A session is an orphan when:
  //   (a) its metadata_json has a non-empty `__interrupt_state` key, AND
  //   (b) there is NO row in pending_approvals for this session_id with
  //       status='pending'.
  //
  // SQLite's json_extract on metadata_json gives us (a) cheaply.
  const rows = db.prepare(`
    SELECT s.id           AS sessionId,
           s.channel      AS channel,
           json_extract(s.metadata_json, '$.__interrupt_state') AS interruptState
      FROM sessions s
     WHERE interruptState IS NOT NULL AND interruptState != ''
       AND NOT EXISTS (
             SELECT 1 FROM pending_approvals pa
              WHERE pa.session_id = s.id AND pa.status = 'pending'
           )
  `).all() as Array<{ sessionId: string; channel: string | null; interruptState: string }>;

  const orphans: OrphanRow[] = [];
  for (const row of rows) {
    // Find the most recent approval_requested event for this session
    // so we can recover the subject + tool + args.
    const lastEv = db.prepare(`
      SELECT seq, created_at AS createdAt, data_json AS dataJson
        FROM events
       WHERE session_id = ? AND type = 'approval_requested'
       ORDER BY seq DESC
       LIMIT 1
    `).get(row.sessionId) as { seq: number; createdAt: string; dataJson: string } | undefined;

    let lastApprovalRequested: OrphanRow['lastApprovalRequested'];
    if (lastEv) {
      try {
        lastApprovalRequested = {
          seq: lastEv.seq,
          createdAt: lastEv.createdAt,
          data: JSON.parse(lastEv.dataJson) as Record<string, unknown>,
        };
      } catch {
        // Drop malformed events — we'll fall back to a generic subject.
      }
    }

    orphans.push({
      sessionId: row.sessionId,
      channel: row.channel,
      interruptState: row.interruptState,
      lastApprovalRequested,
    });
  }
  return orphans;
}

function repair(orphan: OrphanRow): void {
  const subject = (orphan.lastApprovalRequested?.data.subject as string | undefined)
    ?? (orphan.lastApprovalRequested?.data.tool as string | undefined)
    ?? `Recovered approval for ${orphan.sessionId}`;
  const tool = orphan.lastApprovalRequested?.data.tool as string | undefined;
  const args = orphan.lastApprovalRequested?.data.args as Record<string, unknown> | undefined;
  approvalRegistry.register({
    sessionId: orphan.sessionId,
    channel: orphan.channel,
    subject,
    tool: tool ?? null,
    args: args ?? null,
    // Don't auto-expire the recovered rows immediately — give the user
    // 24h to address them. The reaper will pick them up after that.
  });
}

function main(): void {
  const apply = argv.includes('--apply');
  const orphans = findOrphans();

  if (orphans.length === 0) {
    console.log('No orphan paused sessions found. Nothing to repair.');
    return;
  }

  console.log(`Found ${orphans.length} orphan paused session(s):`);
  for (const orphan of orphans) {
    const last = orphan.lastApprovalRequested;
    const subj = (last?.data.subject as string | undefined) ?? '(unknown)';
    console.log(`  • session=${orphan.sessionId}  channel=${orphan.channel ?? '—'}  subject="${subj}"`);
    if (last) console.log(`    last approval_requested at ${last.createdAt}`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write the registry rows.');
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const orphan of orphans) {
    try {
      repair(orphan);
      ok++;
    } catch (err) {
      console.error(`Failed to repair ${orphan.sessionId}: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }
  console.log(`\nRepair complete. Inserted ${ok} registry row(s); failed ${failed}.`);
}

main();
exit(0);
