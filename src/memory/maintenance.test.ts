/**
 * Run: npx tsx --test src/memory/maintenance.test.ts
 *
 * Characterizes isAtOrAfterDailyTime — the catch-up gate that replaced the
 * exact-minute nightly gate. The old gate (getHours()===H && getMinutes()===M)
 * fired ONLY during the one matching minute, so a laptop asleep across 4:30 AM
 * lost that day's memory.db backup. The new gate fires on the first tick at or
 * after the target time, guarded by the existing per-day fire-once stamp.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-maint-test-'));

const {
  finalizeGroundedEntityLinksOnBoot,
  finalizeGroundedResourceLinksOnBoot,
  finalizeLegacyReflectionCandidatesOnBoot,
  finalizeMemoryIdentityOnBoot,
  isAtOrAfterDailyTime,
} = await import('./maintenance.js');
const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { rememberFact } = await import('./facts.js');
const { resolveCanonicalEntityId, upsertEntity } = await import('./entity-identity.js');
const { setFactEntityLinks, setFactResourceLinks } = await import('./relations.js');
const { upsertResourcePointer } = await import('./source-map.js');
const { linkFactEvidence, recordMemoryEpisode } = await import('./temporal-memory.js');

// Build a local-time Date at the given hour:minute (date itself is irrelevant).
const at = (hour: number, minute: number) => new Date(2026, 5, 8, hour, minute, 0, 0);

test('isAtOrAfterDailyTime: fires from the target minute onward (4:30 job)', () => {
  const H = 4, M = 30;
  // Before the gate → does not fire.
  assert.equal(isAtOrAfterDailyTime(at(3, 0), H, M), false, '3:00 is before 4:30');
  assert.equal(isAtOrAfterDailyTime(at(4, 29), H, M), false, '4:29 is before 4:30');
  // At the gate minute → fires (parity with the old exact-minute gate).
  assert.equal(isAtOrAfterDailyTime(at(4, 30), H, M), true, '4:30 is the gate');
  // AFTER the gate → fires (the catch-up the old gate silently dropped).
  assert.equal(isAtOrAfterDailyTime(at(4, 31), H, M), true, '4:31 catches up');
  assert.equal(isAtOrAfterDailyTime(at(7, 0), H, M), true, 'woke at 7:00 → still backs up');
  assert.equal(isAtOrAfterDailyTime(at(23, 59), H, M), true, 'late evening still catches up');
});

test('isAtOrAfterDailyTime: top-of-hour jobs (3:00, 4:00)', () => {
  assert.equal(isAtOrAfterDailyTime(at(2, 59), 3, 0), false);
  assert.equal(isAtOrAfterDailyTime(at(3, 0), 3, 0), true);
  assert.equal(isAtOrAfterDailyTime(at(3, 1), 3, 0), true);
  assert.equal(isAtOrAfterDailyTime(at(4, 0), 4, 0), true);
  assert.equal(isAtOrAfterDailyTime(at(3, 59), 4, 0), false);
});

test('isAtOrAfterDailyTime: memory self-heal slot catches up after 4:35', () => {
  assert.equal(isAtOrAfterDailyTime(at(4, 34), 4, 35), false);
  assert.equal(isAtOrAfterDailyTime(at(4, 35), 4, 35), true);
  assert.equal(isAtOrAfterDailyTime(at(4, 45), 4, 35), true);
});

test('boot identity finalization backs up first, then converges only a stable personal-email duplicate', () => {
  resetMemoryDb();
  const canonical = upsertEntity({
    type: 'person', name: 'Nathan Reynolds', aliases: ['nathan@example.com'],
  });
  const db = openMemoryDb();
  const now = '2026-07-15T12:00:00.000Z';
  const duplicate = Number(db.prepare(`
    INSERT INTO entities
      (entity_type, canonical_name, canonical_name_lc, aliases_json,
       first_seen_at, last_seen_at, mention_count)
    VALUES ('person', 'Nate Reynolds', 'nate reynolds', '[]', ?, ?, 1)
  `).run(now, now).lastInsertRowid);
  db.prepare(`
    INSERT INTO entity_identifiers
      (entity_id, scheme, value, value_norm, confidence,
       evidence_episode_id, source_uri, first_seen_at, last_seen_at)
    VALUES (?, 'email', 'nathan@example.com', 'nathan@example.com', 0.99,
            NULL, NULL, ?, ?)
  `).run(duplicate, now, now);
  const sharedA = upsertEntity({ type: 'person', name: 'Sales One', aliases: ['sales@example.com'] });
  const sharedB = upsertEntity({ type: 'person', name: 'Sales Two', aliases: ['sales@example.com'] });

  const result = finalizeMemoryIdentityOnBoot();
  assert.equal(result.reason, 'reconciled');
  assert.equal(result.ran, true);
  assert.equal(result.pendingBefore, 1);
  assert.equal(result.pendingAfter, 0);
  assert.equal(result.reconciliation?.groupsMerged, 1);
  assert.equal(result.reconciliation?.entitiesRedirected, 1);
  assert.ok(result.backupPath && existsSync(result.backupPath), 'reversible backup exists before redirect repair');
  assert.equal(
    resolveCanonicalEntityId(duplicate),
    resolveCanonicalEntityId(canonical),
    'both historical ids resolve to one canonical person',
  );
  assert.notEqual(resolveCanonicalEntityId(sharedA), resolveCanonicalEntityId(sharedB), 'shared inbox remains review-only');

  const repeat = finalizeMemoryIdentityOnBoot();
  assert.equal(repeat.reason, 'already_converged');
  assert.equal(repeat.ran, false, 'restart is idempotent once strong identifiers converge');
});

test('boot reflection finalization preserves exact pre-ledger claims before bounded expiry', () => {
  resetMemoryDb();
  const db = openMemoryDb();
  const episode = recordMemoryEpisode({
    kind: 'tool_result',
    sourceApp: 'crm_lookup',
    sessionId: 'legacy-session-live',
    callId: 'legacy-call-live',
    sourceUri: 'tool://legacy-session-live/legacy-call-live',
    occurredAt: '2026-07-14T10:00:00.000Z',
    content: 'Dana Smith is the billing contact for Acme.',
    status: 'pending',
  });
  const insert = db.prepare(`
    INSERT INTO reflection_pending_extractions
      (session_id, call_id, tool, extraction_json, importance, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  insert.run(
    'legacy-session-live',
    'legacy-call-live',
    'crm_lookup',
    JSON.stringify({
      facts: [
        { kind: 'reference', text: 'Dana Smith is the billing contact for Acme.', importance: 6 },
        { kind: 'project', text: 'Acme renews in September.', importance: 5 },
      ],
      entities: [],
      pointers: [],
    }),
    11,
    '2026-07-14T10:00:00.000Z',
    '2026-07-21T10:00:00.000Z',
  );
  insert.run(
    'legacy-session-expired',
    'legacy-call-expired',
    'read_file',
    JSON.stringify({
      facts: [{ kind: 'reference', text: 'The retired amber archive belonged to Project Quorvex.', importance: 4 }],
      entities: [],
      pointers: [],
    }),
    4,
    '2026-07-01T10:00:00.000Z',
    '2026-07-08 10:00:00',
  );

  const result = finalizeLegacyReflectionCandidatesOnBoot('2026-07-15T12:00:00.000Z');
  assert.equal(result.reason, 'reconciled');
  assert.equal(result.ran, true);
  assert.equal(result.missingBatchesBefore, 2);
  assert.equal(result.missingBatchesAfter, 0);
  assert.equal(result.backfill?.candidatesInserted, 3);
  assert.equal(result.backfill?.missingEpisodes, 1);
  assert.equal(result.expiredBatches, 1);
  assert.ok(result.backupPath && existsSync(result.backupPath), 'legacy lifecycle projection is backed up first');

  const candidates = db.prepare(`
    SELECT text, status, reason, episode_id
    FROM memory_reflection_candidates
    ORDER BY text
  `).all() as Array<{ text: string; status: string; reason: string | null; episode_id: string | null }>;
  assert.deepEqual(candidates, [
    { text: 'Acme renews in September.', status: 'pending', reason: null, episode_id: episode.id },
    { text: 'Dana Smith is the billing contact for Acme.', status: 'pending', reason: null, episode_id: episode.id },
    { text: 'The retired amber archive belonged to Project Quorvex.', status: 'expired', reason: 'threshold_expired', episode_id: null },
  ]);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM reflection_pending_extractions WHERE session_id = 'legacy-session-expired'`).get() as { count: number }).count,
    0,
    'expired payload is deleted only after its exact claims enter the audit ledger',
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM reflection_pending_extractions WHERE session_id = 'legacy-session-live'`).get() as { count: number }).count,
    1,
    'unexpired threshold payload remains available for normal promotion',
  );

  const repeat = finalizeLegacyReflectionCandidatesOnBoot('2026-07-15T12:00:00.000Z');
  assert.equal(repeat.reason, 'already_auditable');
  assert.equal(repeat.ran, false);
});

test('boot graph finalization backs up first and promotes only excerpt-grounded legacy links once', () => {
  resetMemoryDb();
  const fact = rememberFact({ kind: 'project', content: 'The Northstar launch review is Friday.' });
  const episode = recordMemoryEpisode({
    kind: 'user_turn',
    sourceApp: 'chat',
    occurredAt: '2026-07-15T12:00:00.000Z',
    content: 'The Northstar launch review is Friday.',
  });
  linkFactEvidence({ factId: fact.id, episodeId: episode.id, excerpt: 'The Northstar launch review is Friday.' });
  const northstar = upsertEntity({ type: 'project', name: 'Northstar' });
  setFactEntityLinks(fact.id, [northstar], { linkType: 'inferred_text', confidence: 0.55 });

  const result = finalizeGroundedEntityLinksOnBoot();
  assert.equal(result.reason, 'reconciled');
  assert.equal(result.ran, true);
  assert.equal(result.candidatesBefore, 1);
  assert.equal(result.reconciliation?.promoted, 1);
  assert.ok(result.backupPath && existsSync(result.backupPath), 'reversible backup exists before graph promotion');
  const db = openMemoryDb();
  const groundedLink = db.prepare(`
    SELECT link_type, evidence_episode_id FROM fact_entities WHERE fact_id = ? AND entity_id = ?
  `).get(fact.id, northstar) as { link_type: string; evidence_episode_id: string | null };
  assert.equal(groundedLink.link_type, 'extracted');
  assert.ok(groundedLink.evidence_episode_id, 'the promoted edge names its exact supporting episode');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM entity_observations WHERE entity_id = ? AND episode_id = ?`).get(northstar, groundedLink.evidence_episode_id) as { count: number }).count,
    1,
  );

  const repeat = finalizeGroundedEntityLinksOnBoot();
  assert.equal(repeat.reason, 'already_finalized');
  assert.equal(repeat.ran, false, 'restart never replays the one-time migration repair');
});

test('boot resource finalization backs up first and promotes only unique excerpt-grounded links once', () => {
  resetMemoryDb();
  const resource = upsertResourcePointer({
    app: 'Google Drive', kind: 'folder', providerId: 'q3-planning', name: 'Q3 Planning',
  });
  const fact = rememberFact({
    kind: 'project',
    content: 'The Northstar launch plan is stored in the Q3 Planning folder.',
    derivedFrom: { sessionId: 'resource-boot-session', callId: 'resource-boot-call', tool: 'drive_search' },
  });
  const episode = recordMemoryEpisode({
    kind: 'tool_result',
    sessionId: 'resource-boot-session',
    callId: 'resource-boot-call',
    sourceApp: 'Google Drive',
    occurredAt: '2026-07-15T12:00:00.000Z',
    content: 'The Northstar launch plan is stored in the Q3 Planning folder.',
  });
  linkFactEvidence({
    factId: fact.id,
    episodeId: episode.id,
    excerpt: 'The Northstar launch plan is stored in the Q3 Planning folder.',
  });
  setFactResourceLinks(fact.id, [resource.id], { linkType: 'inferred_text', confidence: 0.55 });

  const result = finalizeGroundedResourceLinksOnBoot();
  assert.equal(result.reason, 'reconciled');
  assert.equal(result.ran, true);
  assert.equal(result.candidatesBefore, 1);
  assert.equal(result.reconciliation?.promoted, 1);
  assert.ok(result.backupPath && existsSync(result.backupPath), 'reversible backup exists before resource promotion');
  const groundedLink = openMemoryDb().prepare(`
    SELECT link_type, evidence_episode_id FROM fact_resources WHERE fact_id = ? AND resource_id = ?
  `).get(fact.id, resource.id) as { link_type: string; evidence_episode_id: string | null };
  assert.deepEqual(groundedLink, { link_type: 'extracted', evidence_episode_id: episode.id });

  const repeat = finalizeGroundedResourceLinksOnBoot();
  assert.equal(repeat.reason, 'already_finalized');
  assert.equal(repeat.ran, false, 'restart never replays the resource migration repair');
});
