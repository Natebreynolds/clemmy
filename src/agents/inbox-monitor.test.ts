/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-inbox-mon npx tsx --test src/agents/inbox-monitor.test.ts
 *
 * C2 ambient inbox monitor — general (any user, any connected mail), read-only,
 * surface-only. All deps injected so this is deterministic + offline (no real
 * mail, no network, no files). Env is set/restored per test (shared-process suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-inbox-mon-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import type { InboxMonitorDeps, UnreadMessage } from './inbox-monitor.js';
const { processInboxMonitor, scoreMessage } = await import('./inbox-monitor.js');

// ── fixtures ──────────────────────────────────────────────────────────────
const outlookResp = (msgs: Array<Partial<UnreadMessage> & { id: string }>): unknown => ({
  data: {
    value: msgs.map((m) => ({
      id: m.id,
      subject: m.subject ?? '(no subject)',
      from: { emailAddress: { name: m.fromName ?? 'Person', address: m.fromAddress ?? 'person@corp.com' } },
      receivedDateTime: m.receivedAt ?? '2026-06-16T10:00:00Z',
      bodyPreview: m.preview ?? '',
      webLink: m.webLink ?? 'https://outlook/x',
    })),
  },
});

function makeDeps(over: Partial<InboxMonitorDeps> & {
  connections?: Array<{ slug: string; connectionId: string; status: string; accountEmail?: string }>;
  resp?: unknown;
  notified?: any[];
  state?: { lastScanAt?: string; surfacedIds: string[] };
} = {}): { deps: InboxMonitorDeps; notified: any[]; saved: any[]; toolCalls: any[] } {
  const notified = over.notified ?? [];
  const saved: any[] = [];
  const toolCalls: any[] = [];
  let state = over.state ?? { surfacedIds: [] as string[] };
  const deps: InboxMonitorDeps = {
    listConnections: over.listConnections ?? (async () => (over.connections ?? [
      { slug: 'outlook', connectionId: 'ca_1', status: 'ACTIVE', accountEmail: 'nate@corp.com' },
    ]) as any),
    executeTool: over.executeTool ?? (async (slug: string, args: any, conn?: string) => {
      toolCalls.push({ slug, args, conn });
      return over.resp ?? outlookResp([]);
    }),
    notify: over.notify ?? ((n: any) => notified.push(n)),
    proactiveWorkAllowed: over.proactiveWorkAllowed ?? (() => true),
    now: over.now ?? (() => Date.parse('2026-06-16T12:00:00Z')),
    loadState: over.loadState ?? (() => state),
    saveState: over.saveState ?? ((s: any) => { state = s; saved.push(s); }),
  };
  return { deps, notified, saved, toolCalls };
}

const ON = () => { process.env.CLEMMY_INBOX_MONITOR = 'on'; };
const restore = (v: string | undefined) => { if (v === undefined) delete process.env.CLEMMY_INBOX_MONITOR; else process.env.CLEMMY_INBOX_MONITOR = v; };

// ── scoring ─────────────────────────────────────────────────────────────────
test('scoreMessage: a person asking a question needs you', () => {
  const s = scoreMessage({ id: '1', subject: 'Quick question', fromName: 'Dana', fromAddress: 'dana@corp.com', receivedAt: '', preview: 'Can you review the deck?' });
  assert.equal(s.needsYou, true);
  assert.ok(s.reasons.includes('asks you something'));
});
test('scoreMessage: an urgent message from a person needs you', () => {
  const s = scoreMessage({ id: '2', subject: 'URGENT: contract', fromName: 'Sam', fromAddress: 'sam@corp.com', receivedAt: '', preview: 'Need this signed by EOD.' });
  assert.equal(s.needsYou, true);
  assert.ok(s.reasons.includes('time-sensitive'));
});
test('scoreMessage: a bulk/no-reply sender does NOT need you even if it shouts urgent', () => {
  const s = scoreMessage({ id: '3', subject: 'URGENT: your invoice is ready', fromName: 'Billing', fromAddress: 'no-reply@vendor.com', receivedAt: '', preview: 'Action required?' });
  assert.equal(s.needsYou, false);
});
test('scoreMessage: a person with no ask/urgency does NOT need you', () => {
  const s = scoreMessage({ id: '4', subject: 'FYI notes', fromName: 'Lee', fromAddress: 'lee@corp.com', receivedAt: '', preview: 'Sharing the notes from today.' });
  assert.equal(s.needsYou, false);
});

// ── processInboxMonitor ───────────────────────────────────────────────────
test('processInboxMonitor: runs by DEFAULT when the flag is unset (default-on)', async () => {
  const prev = process.env.CLEMMY_INBOX_MONITOR; delete process.env.CLEMMY_INBOX_MONITOR;
  try {
    const { deps, notified } = makeDeps({ resp: outlookResp([{ id: 'm1', fromName: 'Dana', fromAddress: 'dana@corp.com', subject: 'Need you', preview: 'Can you review today?' }]) });
    assert.equal(await processInboxMonitor(deps), 1, 'default-on: surfaces without an explicit flag');
    assert.equal(notified.length, 1);
  } finally { restore(prev); }
});

test('processInboxMonitor: no-op when the kill-switch is off', async () => {
  const prev = process.env.CLEMMY_INBOX_MONITOR; process.env.CLEMMY_INBOX_MONITOR = 'off';
  try {
    const { deps, notified } = makeDeps({ resp: outlookResp([{ id: 'm1', fromAddress: 'a@corp.com', preview: 'can you help?' }]) });
    assert.equal(await processInboxMonitor(deps), 0);
    assert.equal(notified.length, 0);
  } finally { restore(prev); }
});

test('processInboxMonitor: no-op when proactive work is not allowed (quiet hours)', async () => {
  const prev = process.env.CLEMMY_INBOX_MONITOR; ON();
  try {
    const { deps, notified } = makeDeps({ proactiveWorkAllowed: () => false, resp: outlookResp([{ id: 'm1', fromAddress: 'a@corp.com', preview: 'can you help?' }]) });
    assert.equal(await processInboxMonitor(deps), 0);
    assert.equal(notified.length, 0);
  } finally { restore(prev); }
});

test('processInboxMonitor: surfaces a needs-you card (read-only) labeled by account', async () => {
  const prev = process.env.CLEMMY_INBOX_MONITOR; ON();
  try {
    const { deps, notified, toolCalls } = makeDeps({
      resp: outlookResp([
        { id: 'm1', subject: 'Need your sign-off', fromName: 'Dana', fromAddress: 'dana@corp.com', preview: 'Can you approve the budget today?' },
        { id: 'm2', subject: 'Newsletter', fromName: 'News', fromAddress: 'no-reply@news.com', preview: 'This week in tech?' },
      ]),
    });
    const n = await processInboxMonitor(deps);
    assert.equal(n, 1, 'only the real needs-you message surfaced (newsletter filtered)');
    const card = notified[0];
    assert.equal(card.metadata.needsAttention, true);
    assert.equal(card.metadata.source, 'inbox-monitor');
    assert.equal(card.metadata.account, 'nate@corp.com');
    assert.equal(card.metadata.connectionId, 'ca_1');
    assert.equal(card.silent, true, 'dashboard-only for v1');
    assert.match(card.title, /Dana/);
    // Surface-only by construction: the ONLY tool call is a READ list action.
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].slug, 'OUTLOOK_LIST_MAIL_FOLDER_MESSAGES');
    assert.ok(!/SEND|REPLY|DRAFT|DELETE|MOVE|UPDATE/i.test(toolCalls[0].slug));
  } finally { restore(prev); }
});

test('processInboxMonitor: dedups — an already-surfaced message is not re-surfaced', async () => {
  const prev = process.env.CLEMMY_INBOX_MONITOR; ON();
  try {
    const { deps, notified } = makeDeps({
      state: { surfacedIds: ['ca_1:m1'] },
      resp: outlookResp([{ id: 'm1', subject: 'Re: budget', fromAddress: 'dana@corp.com', preview: 'Can you confirm?' }]),
    });
    assert.equal(await processInboxMonitor(deps), 0);
    assert.equal(notified.length, 0);
  } finally { restore(prev); }
});

test('processInboxMonitor: respects the per-scan cap', async () => {
  const prev = process.env.CLEMMY_INBOX_MONITOR; ON();
  process.env.CLEMMY_INBOX_MONITOR_MAX = '2';
  try {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, fromAddress: `p${i}@corp.com`, subject: 'Need you', preview: 'Can you review?' }));
    const { deps, notified } = makeDeps({ resp: outlookResp(msgs) });
    assert.equal(await processInboxMonitor(deps), 2, 'capped at 2');
    assert.equal(notified.length, 2);
  } finally { restore(prev); delete process.env.CLEMMY_INBOX_MONITOR_MAX; }
});

test('processInboxMonitor: skips within the cadence window', async () => {
  const prev = process.env.CLEMMY_INBOX_MONITOR; ON();
  try {
    const { deps, notified } = makeDeps({
      state: { lastScanAt: '2026-06-16T11:58:00Z', surfacedIds: [] }, // 2 min before now(12:00); cadence default 15m
      resp: outlookResp([{ id: 'm1', fromAddress: 'a@corp.com', preview: 'can you help?' }]),
    });
    assert.equal(await processInboxMonitor(deps), 0);
    assert.equal(notified.length, 0);
  } finally { restore(prev); }
});

test('processInboxMonitor: watches ALL mailboxes status-agnostically, labels each (general, no pin)', async () => {
  // The major fix: Composio status is unreliable, so we do NOT pre-filter by it.
  // An EXPIRED/UNKNOWN-labeled connection that still works must be watched.
  const prev = process.env.CLEMMY_INBOX_MONITOR; ON();
  try {
    const respByConn: Record<string, unknown> = {
      ca_a: outlookResp([{ id: 'x', fromName: 'Ada', fromAddress: 'ada@a.com', subject: 'Need you', preview: 'Can you reply?' }]),
      ca_b: outlookResp([{ id: 'y', fromName: 'Bo', fromAddress: 'bo@b.com', subject: 'Urgent', preview: 'Need this by EOD.' }]),
      ca_c: outlookResp([{ id: 'z', fromName: 'Cy', fromAddress: 'cy@x.com', subject: 'Re: contract', preview: 'Can you sign today?' }]),
    };
    const { deps, notified } = makeDeps({
      connections: [
        { slug: 'outlook', connectionId: 'ca_a', status: 'ACTIVE', accountEmail: 'me@a.com' },
        { slug: 'outlook', connectionId: 'ca_b', status: 'EXPIRED', accountEmail: 'me@b.com' }, // works despite EXPIRED label
        { slug: 'outlook', connectionId: 'ca_c', status: 'UNKNOWN', accountEmail: 'me@x.com' },
      ],
      executeTool: async (_slug: string, _args: any, conn?: string) => respByConn[conn ?? ''] ?? outlookResp([]),
    });
    const n = await processInboxMonitor(deps);
    assert.equal(n, 3, 'every mailbox watched regardless of status label');
    const accounts = notified.map((x) => x.metadata.account).sort();
    assert.deepEqual(accounts, ['me@a.com', 'me@b.com', 'me@x.com']);
  } finally { restore(prev); }
});

test('processInboxMonitor: excludes promo/marketing/survey content even from a real-looking sender', async () => {
  const prev = process.env.CLEMMY_INBOX_MONITOR; ON();
  try {
    const { deps, notified } = makeDeps({
      resp: outlookResp([
        { id: 'p1', subject: 'FREE Premium Tin. Your choice.', fromName: 'Acme', fromAddress: 'orders@acme.com', preview: 'Limited time! Can you act now?' },
        { id: 'p2', subject: 'How was our support?', fromName: 'Stripe', fromAddress: 'noreply@stripe.com', preview: 'Rate your experience?' },
        { id: 'real', subject: 'Re: budget sign-off', fromName: 'Dana', fromAddress: 'dana@corp.com', preview: 'Can you approve by EOD?' },
      ]),
    });
    const n = await processInboxMonitor(deps);
    assert.equal(n, 1, 'only the genuine ask surfaced; FREE promo + satisfaction survey filtered out');
    assert.match(notified[0].title, /Dana/);
  } finally { restore(prev); }
});
