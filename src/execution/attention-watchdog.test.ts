/**
 * Run: npx tsx --test src/execution/attention-watchdog.test.ts
 *
 * Swallowed-state class pins (2026-08-11): a durable store that records a
 * typed bad terminal state — a failed fan-out plan, a dead-ended trigger
 * delivery — must produce exactly one user notification. Before this
 * watchdog, both states died as log lines.
 *
 * Per-test temp dir via CLEMENTINE_HOME (BINDING), set BEFORE any src import.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-attention-watchdog-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-attn\n');

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;

const {
  attentionNotificationId,
  clearRegisteredAttentionSourcesForTest,
  registerAttentionSource,
  runAttentionWatchdog,
  selectAttentionAlerts,
} = await import('./attention-watchdog.js');
const { loadNotifications } = await import('../runtime/notifications.js');
const fanout = await import('./durable-fanout.js');
const engine = await import('./workflow-trigger-engine.js');
const eventlog = await import('../runtime/harness/eventlog.js');

const T0 = 1_780_000_000_000;
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString();

// ─── pure selector ───────────────────────────────────────────────────────────

test('selectAttentionAlerts: dedupes on existing ids, bounds backlog age, skips bad timestamps', () => {
  const state = (id: string, recordedAt: string) => ({
    source: 'src-a',
    state: { id, title: 't', body: 'b', recordedAt },
  });
  const picked = selectAttentionAlerts(
    [
      state('fresh', iso(60_000)),
      state('already-notified', iso(60_000)),
      state('ancient', iso(13 * 60 * 60_000)), // beyond the 12h first-ship guard
      state('garbage-time', 'not-a-date'),
    ],
    new Set([attentionNotificationId('src-a', 'already-notified')]),
    T0,
  );
  assert.deepEqual(picked.map((p) => p.state.id), ['fresh']);
  assert.equal(picked[0].id, 'attention-src-a-fresh');
});

// ─── connection pin: failed fan-out plan → one non-silent notification ──────

test('a fan-out plan that fails past its retry cap surfaces exactly one notification', async () => {
  clearRegisteredAttentionSourcesForTest();
  const sessionId = 'sess-attn-fanout';
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: sessionId });
  const admitted = fanout.admitDurableFanoutPlan(
    {
      kind: 'durable_manifest',
      objective: 'enrich 4 accounts overnight',
      successCriteria: ['every account enriched'],
      missingRequiredInputs: [],
      effectCeiling: 'read',
      estimatedActivations: 4,
      manifest: {
        manifestId: 'mf-attn-4',
        contractVersion: 'v1',
        canonicalItems: Array.from({ length: 4 }, (_, i) => ({ id: `acct-${i}` })),
        phases: [{ id: 'execute', dependsOn: [], runnerClass: 'worker' as const }],
        reducer: { id: 'reduce', requiredPhases: ['execute'], outputContract: 'report@1' },
      },
    },
    { originSessionId: sessionId, route: { source: 'desktop' } },
  );
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;
  assert.ok(fanout.scheduleDurableFanout(planId)?.workerTasks.length, 'plan claimed no worker window');

  // Every worker is dead; reconcile retries the window to its cap, then the
  // plan honestly fails — the state that used to die as a discarded log array.
  let failed: string[] = [];
  for (let round = 0; round < 8 && failed.length === 0; round += 1) {
    failed = fanout.reconcileDurableFanout({ taskState: () => 'missing' }).failedPlans;
  }
  assert.deepEqual(failed, [planId], 'plan never reached failed via the retry cap');
  assert.equal(fanout.loadFanoutPlan(planId)?.status, 'failed');

  const before = loadNotifications().length;
  assert.equal(runAttentionWatchdog().surfaced >= 1, true, 'failed plan produced no notification');
  const card = loadNotifications().slice(before).find(
    (n) => n.id === attentionNotificationId('fanout-plan-failed', planId),
  );
  assert.ok(card, 'failed fan-out plan must surface a notification — silent failure is the bug');
  assert.match(card.title, /needs attention/i);
  assert.match(card.body, /enrich 4 accounts overnight/);
  assert.match(card.body, /re-run|resume/i);
  assert.notEqual((card as { silent?: boolean }).silent, true, 'attention cards must never be silent');

  // One-shot: a second sweep re-lists the same failed plan but adds nothing.
  const again = loadNotifications().length;
  runAttentionWatchdog();
  assert.equal(loadNotifications().length, again, 'attention alerts must dedupe per state');
});

// ─── connection pin: dead-ended trigger deliveries → notifications ──────────

test('needs_verification and perpetually-failing trigger deliveries surface notifications', async () => {
  clearRegisteredAttentionSourcesForTest();
  engine.closeWorkflowTriggerDbForTest();
  engine.syncWorkflowTriggerRegistry(); // ensures the schema exists in the temp home
  const db = new Database(path.join(TMP_HOME, 'state', 'workflow-triggers.db'));
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO workflow_triggers (id, workflow_name, kind, webhook_path, created_at, updated_at)
    VALUES ('trg-attn', 'Facebook Trends', 'webhook', 'hooks/fb-trends', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO workflow_trigger_events
      (id, trigger_id, fired_at, dedupe_key, payload_hash, state, attempt_count, last_error, updated_at)
    VALUES
      ('evt-verify', 'trg-attn', ?, 'k1', 'h1', 'needs_verification', 0, NULL, ?),
      ('evt-stuck', 'trg-attn', ?, 'k2', 'h2', 'pending', 12, 'run queue rejected the receipt', ?),
      ('evt-young', 'trg-attn', ?, 'k3', 'h3', 'pending', 2, NULL, ?)
  `).run(now, now, now, now, now, now);
  db.close();

  const states = engine.workflowTriggerAttentionSource.listAttentionStates();
  assert.deepEqual(states.map((s) => s.id).sort(), ['evt-stuck', 'evt-verify'],
    'a young pending receipt must NOT alert; the two dead-end shapes must');

  const before = loadNotifications().length;
  runAttentionWatchdog();
  const fresh = loadNotifications().slice(before);
  const verify = fresh.find((n) => n.id === attentionNotificationId('workflow-trigger', 'evt-verify'));
  const stuck = fresh.find((n) => n.id === attentionNotificationId('workflow-trigger', 'evt-stuck'));
  assert.ok(verify, 'needs_verification delivery must notify — it never retries on its own');
  assert.match(verify.body, /Facebook Trends/);
  assert.match(verify.body, /review/i);
  assert.ok(stuck, 'a receipt failing forever on capped backoff must escalate');
  assert.match(stuck.body, /12 times/);
  assert.match(stuck.body, /run queue rejected the receipt/);
});

// ─── registry: extra sources sweep too; a broken source never blocks others ─

test('registered sources sweep alongside built-ins and a throwing source is isolated', () => {
  clearRegisteredAttentionSourcesForTest();
  registerAttentionSource({
    name: 'broken-store',
    listAttentionStates() { throw new Error('reader exploded'); },
  });
  registerAttentionSource({
    name: 'future-store',
    listAttentionStates() {
      return [{
        id: 'row-1',
        title: 'Future store needs attention',
        body: 'A registered reader is one line per store.',
        recordedAt: new Date().toISOString(),
      }];
    },
  });
  const before = loadNotifications().length;
  runAttentionWatchdog();
  const fresh = loadNotifications().slice(before);
  assert.ok(
    fresh.some((n) => n.id === attentionNotificationId('future-store', 'row-1')),
    'a registered source must surface through the shared sweep',
  );
  clearRegisteredAttentionSourcesForTest();
});

// ─── wiring pin: the daemon actually calls the sweep ─────────────────────────

test('daemon runner wires runAttentionWatchdog into the watchdog tick (who-calls-this pin)', () => {
  const runner = readFileSync(path.join(process.cwd(), 'src/daemon/runner.ts'), 'utf-8');
  assert.match(runner, /runAttentionWatchdog\(\)/,
    'attention watchdog exists but nothing calls it — a green unit test would be a silent no-op');
});
