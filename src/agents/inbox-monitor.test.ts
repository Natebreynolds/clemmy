/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-inbox-mon npx tsx --test src/agents/inbox-monitor.test.ts
 *
 * C2 ambient inbox monitor — general (any user, any connected mail), read-only,
 * surface-only. All deps injected (incl. the user-editable config) so this is
 * deterministic + offline: no real mail, no network, no files, no env juggling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-inbox-mon-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import type { InboxMonitorDeps, UnreadMessage } from './inbox-monitor.js';
const { inboxMonitorInternalsForTest, processInboxMonitor, scoreMessage } = await import('./inbox-monitor.js');

// ── fixtures ──────────────────────────────────────────────────────────────
const outlookResp = (msgs: Array<Partial<UnreadMessage> & { id: string }>): unknown => ({
  data: {
    value: msgs.map((m) => ({
      id: m.id,
      subject: m.subject ?? '(no subject)',
      from: { emailAddress: { name: m.fromName ?? 'Person', address: m.fromAddress ?? 'person@corp.example' } },
      receivedDateTime: m.receivedAt ?? '2026-06-16T10:00:00Z',
      bodyPreview: m.preview ?? '',
      webLink: m.webLink ?? 'https://outlook/x',
    })),
  },
});

function makeDeps(over: Partial<InboxMonitorDeps> & {
  connections?: Array<{ slug: string; connectionId: string; status: string; accountEmail?: string }>;
  resp?: unknown;
  state?: { lastScanAt?: string; surfacedIds: string[]; suppressedConnections?: Record<string, unknown> };
  // config conveniences
  enabled?: boolean;
  intervalMs?: number;
  maxPerScan?: number;
} = {}): { deps: InboxMonitorDeps; notified: any[]; saved: any[]; toolCalls: any[] } {
  const notified: any[] = [];
  const saved: any[] = [];
  const toolCalls: any[] = [];
  let state = over.state ?? { surfacedIds: [] as string[] };
  const deps: InboxMonitorDeps = {
    listConnections: over.listConnections ?? (async () => (over.connections ?? [
      { slug: 'outlook', connectionId: 'ca_1', status: 'ACTIVE', accountEmail: 'alex@corp.example' },
    ]) as any),
    executeTool: over.executeTool ?? (async (slug: string, args: any, conn?: string) => {
      toolCalls.push({ slug, args, conn });
      return over.resp ?? outlookResp([]);
    }),
    notify: over.notify ?? ((n: any) => notified.push(n)),
    config: over.config ?? (() => ({
      enabled: over.enabled ?? true,
      intervalMs: over.intervalMs ?? 15 * 60_000,
      maxPerScan: over.maxPerScan ?? 5,
      fetchTop: 25,
    })),
    proactiveWorkAllowed: over.proactiveWorkAllowed ?? (() => true),
    now: over.now ?? (() => Date.parse('2026-06-16T12:00:00Z')),
    loadState: over.loadState ?? (() => state),
    saveState: over.saveState ?? ((s: any) => { state = s; saved.push(s); }),
    readConnectionSuppressions: over.readConnectionSuppressions,
    saveConnectionSuppressions: over.saveConnectionSuppressions,
  };
  return { deps, notified, saved, toolCalls };
}

// ── scoring ─────────────────────────────────────────────────────────────────
test('scoreMessage: a person asking a question needs you', () => {
  const s = scoreMessage({ id: '1', subject: 'Quick question', fromName: 'Dana', fromAddress: 'dana@corp.example', receivedAt: '', preview: 'Can you review the deck?' });
  assert.equal(s.needsYou, true);
  assert.ok(s.reasons.includes('asks you something'));
});
test('scoreMessage: an urgent message from a person needs you', () => {
  const s = scoreMessage({ id: '2', subject: 'URGENT: contract', fromName: 'Sam', fromAddress: 'sam@corp.example', receivedAt: '', preview: 'Need this signed by EOD.' });
  assert.equal(s.needsYou, true);
  assert.ok(s.reasons.includes('time-sensitive'));
});
test('scoreMessage: a bulk/no-reply sender does NOT need you even if it shouts urgent', () => {
  const s = scoreMessage({ id: '3', subject: 'URGENT: your invoice is ready', fromName: 'Billing', fromAddress: 'no-reply@vendor.example', receivedAt: '', preview: 'Action required?' });
  assert.equal(s.needsYou, false);
});
test('scoreMessage: a person with no ask/urgency does NOT need you', () => {
  const s = scoreMessage({ id: '4', subject: 'FYI notes', fromName: 'Lee', fromAddress: 'lee@corp.example', receivedAt: '', preview: 'Sharing the notes from today.' });
  assert.equal(s.needsYou, false);
});
test('scoreMessage: promo/marketing content is excluded even from a real-looking sender', () => {
  const s = scoreMessage({ id: '5', subject: 'FREE Premium Tin. Your choice.', fromName: 'Acme', fromAddress: 'orders@acme.example', receivedAt: '', preview: 'Limited time! Can you act now?' });
  assert.equal(s.needsYou, false);
});

// ── processInboxMonitor (config injected) ─────────────────────────────────
test('processInboxMonitor: runs and surfaces a needs-you card (read-only) labeled by account', async () => {
  const { deps, notified, toolCalls } = makeDeps({
    resp: outlookResp([
      { id: 'm1', subject: 'Need your sign-off', fromName: 'Dana', fromAddress: 'dana@corp.example', preview: 'Can you approve the budget today?' },
      { id: 'm2', subject: 'Newsletter', fromName: 'News', fromAddress: 'no-reply@news.example', preview: 'This week in tech?' },
    ]),
  });
  const n = await processInboxMonitor(deps);
  assert.equal(n, 1, 'only the real needs-you message surfaced (newsletter filtered)');
  const card = notified[0];
  assert.equal(card.metadata.needsAttention, true);
  assert.equal(card.metadata.source, 'inbox-monitor');
  assert.equal(card.metadata.account, 'alex@corp.example');
  assert.equal(card.metadata.connectionId, 'ca_1');
  assert.equal(card.silent, true, 'dashboard-only');
  assert.match(card.title, /Dana/);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].slug, 'OUTLOOK_LIST_MAIL_FOLDER_MESSAGES');
  assert.ok(!/SEND|REPLY|DRAFT|DELETE|MOVE|UPDATE/i.test(toolCalls[0].slug), 'never a mutate slug');
});

test('processInboxMonitor: no-op when inbox-watch is toggled OFF (config.enabled=false)', async () => {
  const { deps, notified, toolCalls } = makeDeps({ enabled: false, resp: outlookResp([{ id: 'm1', fromAddress: 'a@corp.example', preview: 'can you help?' }]) });
  assert.equal(await processInboxMonitor(deps), 0);
  assert.equal(notified.length, 0);
  assert.equal(toolCalls.length, 0, 'no mailbox read when disabled');
});

test('processInboxMonitor: no-op when proactive work is not allowed (quiet hours / master off)', async () => {
  const { deps, notified } = makeDeps({ proactiveWorkAllowed: () => false, resp: outlookResp([{ id: 'm1', fromAddress: 'a@corp.example', preview: 'can you help?' }]) });
  assert.equal(await processInboxMonitor(deps), 0);
  assert.equal(notified.length, 0);
});

test('processInboxMonitor: dedups — an already-surfaced message is not re-surfaced', async () => {
  const { deps, notified } = makeDeps({
    state: { surfacedIds: ['ca_1:m1'] },
    resp: outlookResp([{ id: 'm1', subject: 'Re: budget', fromAddress: 'dana@corp.example', preview: 'Can you confirm?' }]),
  });
  assert.equal(await processInboxMonitor(deps), 0);
  assert.equal(notified.length, 0);
});

test('processInboxMonitor: a still-unread surfaced message stays in the dedup window (no re-card)', async () => {
  // The major-review fix: persisted ids are refreshed by seen-this-scan so a
  // sticky unread message can't age out and re-surface.
  const { deps, saved } = makeDeps({
    state: { surfacedIds: ['ca_1:m1'] },
    resp: outlookResp([{ id: 'm1', subject: 'Re: budget', fromAddress: 'dana@corp.example', preview: 'Can you confirm?' }]),
  });
  await processInboxMonitor(deps);
  assert.ok(saved[0].surfacedIds.includes('ca_1:m1'), 'still-unread surfaced id retained');
});

test('processInboxMonitor: respects the per-scan cap (config.maxPerScan)', async () => {
  const msgs = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, fromAddress: `p${i}@corp.example`, subject: 'Need you', preview: 'Can you review?' }));
  const { deps, notified } = makeDeps({ maxPerScan: 2, resp: outlookResp(msgs) });
  assert.equal(await processInboxMonitor(deps), 2, 'capped at 2');
  assert.equal(notified.length, 2);
});

test('processInboxMonitor: skips within the cadence window (config.intervalMs)', async () => {
  const { deps, notified } = makeDeps({
    state: { lastScanAt: '2026-06-16T11:58:00Z', surfacedIds: [] }, // 2 min before now(12:00); interval 15m
    resp: outlookResp([{ id: 'm1', fromAddress: 'a@corp.example', preview: 'can you help?' }]),
  });
  assert.equal(await processInboxMonitor(deps), 0);
  assert.equal(notified.length, 0);
});

test('processInboxMonitor: watches ALL mailboxes status-agnostically, labels each (general, no pin)', async () => {
  const respByConn: Record<string, unknown> = {
    ca_a: outlookResp([{ id: 'x', fromName: 'Ada', fromAddress: 'ada@alpha.example', subject: 'Need you', preview: 'Can you reply?' }]),
    ca_b: outlookResp([{ id: 'y', fromName: 'Bo', fromAddress: 'bo@beta.example', subject: 'Urgent', preview: 'Need this by EOD.' }]),
    ca_c: outlookResp([{ id: 'z', fromName: 'Cy', fromAddress: 'cy@site.example', subject: 'Re: contract', preview: 'Can you sign today?' }]),
  };
  const { deps, notified } = makeDeps({
    connections: [
      { slug: 'outlook', connectionId: 'ca_a', status: 'ACTIVE', accountEmail: 'me@alpha.example' },
      { slug: 'outlook', connectionId: 'ca_b', status: 'EXPIRED', accountEmail: 'me@beta.example' }, // works despite EXPIRED label
      { slug: 'outlook', connectionId: 'ca_c', status: 'UNKNOWN', accountEmail: 'me@site.example' },
    ],
    executeTool: async (_slug: string, _args: any, conn?: string) => respByConn[conn ?? ''] ?? outlookResp([]),
  });
  const n = await processInboxMonitor(deps);
  assert.equal(n, 3, 'every mailbox watched regardless of status label');
  assert.deepEqual(notified.map((x) => x.metadata.account).sort(), ['me@alpha.example', 'me@beta.example', 'me@site.example']);
});

test('processInboxMonitor: suppresses hard Composio auth failures by connection id', async () => {
  let now = Date.parse('2026-06-16T12:00:00Z');
  const calls: string[] = [];
  const sharedSaves: any[] = [];
  const { deps, saved } = makeDeps({
    now: () => now,
    intervalMs: 15 * 60_000,
    connections: [
      { slug: 'outlook', connectionId: 'ca_good', status: 'ACTIVE', accountEmail: 'good@example.com' },
      { slug: 'outlook', connectionId: 'ca_bad', status: 'EXPIRED', accountEmail: 'bad@example.com' },
    ],
    executeTool: async (_slug: string, _args: any, conn?: string) => {
      calls.push(conn ?? '');
      if (conn === 'ca_bad') {
        throw new Error("ConnectedAccountExpired: Connected account ca_bad for toolkit 'outlook' is in EXPIRED state. code: 1820");
      }
      return outlookResp([]);
    },
    saveConnectionSuppressions: (s: any) => sharedSaves.push(s),
  });

  assert.equal(await processInboxMonitor(deps), 0);
  assert.deepEqual(calls, ['ca_good', 'ca_bad']);
  assert.equal(saved.at(-1)?.suppressedConnections?.ca_bad?.reason, 'expired');
  assert.equal(sharedSaves.at(-1)?.suppressedConnections?.ca_bad?.reason, 'expired');

  calls.length = 0;
  now += 16 * 60_000;
  assert.equal(await processInboxMonitor(deps), 0);
  assert.deepEqual(calls, ['ca_good'], 'the hard-failed stale connection is skipped on the next scan');
});

test('processInboxMonitor: skips connections suppressed by the shared Composio store', async () => {
  const sharedSaves: any[] = [];
  const { deps, toolCalls } = makeDeps({
    connections: [
      { slug: 'outlook', connectionId: 'ca_good', status: 'ACTIVE', accountEmail: 'good@example.com' },
      { slug: 'outlook', connectionId: 'ca_bad', status: 'ACTIVE', accountEmail: 'bad@example.com' },
    ],
    readConnectionSuppressions: () => ({
      suppressedConnections: {
        ca_bad: {
          reason: 'entity-mismatch',
          suppressUntil: '2026-06-17T12:00:00.000Z',
          lastErrorAt: '2026-06-16T12:00:00.000Z',
          failures: 1,
        },
      },
    }),
    saveConnectionSuppressions: (s: any) => sharedSaves.push(s),
  });

  assert.equal(await processInboxMonitor(deps), 0);
  assert.deepEqual(toolCalls.map((call) => call.conn), ['ca_good']);
  assert.equal(sharedSaves.at(-1)?.suppressedConnections?.ca_bad?.reason, 'entity-mismatch');
});

test('inbox monitor real state loader preserves persisted connection suppressions', () => {
  const stateFile = path.join(TMP, 'state', 'inbox-monitor.json');
  writeFileSync(stateFile, JSON.stringify({
    lastScanAt: '2026-06-16T12:00:00.000Z',
    surfacedIds: ['ca_good:m1'],
    suppressedConnections: {
      ca_bad: {
        reason: 'entity-mismatch',
        suppressUntil: '2026-06-17T00:00:00.000Z',
        lastErrorAt: '2026-06-16T12:00:00.000Z',
        failures: 3,
      },
    },
  }), 'utf-8');

  const loaded = inboxMonitorInternalsForTest.loadStateReal();
  assert.deepEqual(loaded.surfacedIds, ['ca_good:m1']);
  assert.equal(loaded.suppressedConnections?.ca_bad?.reason, 'entity-mismatch');
  assert.equal(loaded.suppressedConnections?.ca_bad?.failures, 3);
});

test('processInboxMonitor: excludes promo/survey content even from a real-looking sender', async () => {
  const { deps, notified } = makeDeps({
    resp: outlookResp([
      { id: 'p1', subject: 'FREE Premium Tin. Your choice.', fromName: 'Acme', fromAddress: 'orders@acme.example', preview: 'Limited time! Can you act now?' },
      { id: 'p2', subject: 'How was our support?', fromName: 'Stripe', fromAddress: 'no-reply@payments.example', preview: 'Rate your experience?' },
      { id: 'real', subject: 'Re: budget sign-off', fromName: 'Dana', fromAddress: 'dana@corp.example', preview: 'Can you approve by EOD?' },
    ]),
  });
  const n = await processInboxMonitor(deps);
  assert.equal(n, 1, 'only the genuine ask surfaced; promo + survey filtered');
  assert.match(notified[0].title, /Dana/);
});
