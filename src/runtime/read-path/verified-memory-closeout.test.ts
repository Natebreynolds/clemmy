/**
 * Run: npx tsx --test src/runtime/read-path/verified-memory-closeout.test.ts
 *
 * A-series closeout: learning is a SETTLEMENT act, not a dispatch side effect.
 * Every test drives the real governed Composio gateway (only the final network
 * function replaced) and the real event-log acceptance path. What these pin:
 *
 *   - learning happens only after canonical failure detection, async-receipt
 *     resolution, durable receipt creation, and data verification;
 *   - the durable receipt is the learning authority, and it exists on disk;
 *   - identity (scope + account) and the live schema contract ride the whole
 *     way through learning and retrieval;
 *   - one phrase may prove MANY capabilities (multi-read turn, two accounts);
 *   - a newly learned paraphrase is retrievable on the next turn of the SAME
 *     daemon process — no restart, no manual warm call.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-verified-memory-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
// These suites are ABOUT the local semantic tier — ask for it explicitly.
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const composio = await import('../../tools/composio-tools.js');
const schemaCache = await import('../../tools/composio-schema-cache.js');
const toolChoice = await import('../../memory/tool-choice-store.js');
const eventlog = await import('../harness/eventlog.js');
const candidates = await import('./capability-candidates.js');

const CAL_SLUG = 'SCHEDULERCO_LIST_EVENTS';
const CAL_SCHEMA_V1 = { type: 'object', properties: { timeMin: { type: 'string' }, timeMax: { type: 'string' } } };

let seq = 0;
function freshSession(prefix: string): string {
  return `${prefix}-${(seq += 1)}`;
}

function acceptSource(sessionId: string, text: string): { sourceUserSeq: number } {
  if (!eventlog.getSession(sessionId)) {
    eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: text.slice(0, 60) });
  }
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  const event = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text, attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  return { sourceUserSeq: event.seq };
}

function payloadWithItems() {
  return { successful: true, data: { items: [{ id: 'evt-1', summary: 'Standup' }] } };
}

async function governedRead(
  sessionId: string,
  slug: string,
  payload: unknown,
  options: { schema?: Record<string, unknown> | null } = {},
): Promise<string> {
  if (options.schema !== null) schemaCache.rememberToolSchema(slug, options.schema ?? CAL_SCHEMA_V1);
  const exec = (async () => payload) as never;
  return composio.runComposioExecuteForTestInSession(slug, { timeMin: '2026-08-06' }, exec, sessionId);
}

function retrievedIdentifiers(phrase: string): string[] {
  return toolChoice.matchToolChoicesForStep(phrase, { limit: 8 }).map((m) => m.identifier);
}

// ─── settlement ordering ─────────────────────────────────────────────────────

test('a 4xx/5xx-shaped payload never learns, even when nothing threw', async () => {
  const sessionId = freshSession('sess-429');
  const phrase = 'pull the throttled report for the board';
  acceptSource(sessionId, phrase);
  // No `successful` marker at all — the canonical failure detector flags the
  // HTTP status; a data-shaped check alone would happily accept this object.
  await governedRead(sessionId, 'SCHEDULERCO_FETCH_REPORT', {
    data: { status_code: 429, message: 'rate limited', retry_after: 30 },
  });
  assert.equal(retrievedIdentifiers(phrase).includes('SCHEDULERCO_FETCH_REPORT'), false,
    'a rate-limit payload was learned as a proven capability');
});

test('a thrown provider error never learns', async () => {
  const sessionId = freshSession('sess-throw');
  const phrase = 'fetch the flaky upstream numbers';
  acceptSource(sessionId, phrase);
  const exec = (async () => { throw new Error('upstream unreachable'); }) as never;
  schemaCache.rememberToolSchema('SCHEDULERCO_FETCH_NUMBERS', CAL_SCHEMA_V1);
  await composio.runComposioExecuteForTestInSession('SCHEDULERCO_FETCH_NUMBERS', {}, exec, sessionId).catch(() => '');
  assert.equal(retrievedIdentifiers(phrase).includes('SCHEDULERCO_FETCH_NUMBERS'), false,
    'a thrown dispatch was learned as a proven capability');
});

test('a queued receipt that never resolves never learns', async () => {
  const sessionId = freshSession('sess-queued');
  const phrase = 'export the quarterly usage data';
  acceptSource(sessionId, phrase);
  // A read-verbed slug whose provider answered with a job HANDLE (a receipt
  // status outside the obvious queued/pending/running words) — the async
  // detector recognizes it; the settlement never resolved to data.
  await governedRead(sessionId, 'SCHEDULERCO_FETCH_EXPORT', {
    successful: true,
    data: { job_id: 'job-77', status: 'PROCESSING' },
  });
  assert.equal(retrievedIdentifiers(phrase).includes('SCHEDULERCO_FETCH_EXPORT'), false,
    'an unresolved job receipt was learned as a proven read');
});

// ─── the durable receipt is the authority ────────────────────────────────────

test('a verified read leaves a typed durable receipt, and learning cites it', async () => {
  const sessionId = freshSession('sess-receipt');
  const phrase = "what's on my calendar tomorrow?";
  acceptSource(sessionId, phrase);
  await governedRead(sessionId, CAL_SLUG, payloadWithItems());

  const receipts = eventlog.listEvents(sessionId).filter((e) => e.type === 'read_receipt');
  assert.equal(receipts.length, 1, 'a settled verified read produced no durable receipt');
  const record = (receipts[0]!.data as { record?: Record<string, unknown> }).record;
  assert.ok(record, 'the receipt event carries no typed record');
  assert.equal(record!.identifier, CAL_SLUG);
  assert.equal(record!.effectClass, 'read');
  assert.equal(record!.dispatchOutcome, 'succeeded');
  assert.ok(typeof record!.readEvidenceRef === 'string' && record!.readEvidenceRef.length > 0,
    'the receipt proves no read evidence');
  assert.ok(typeof record!.schemaFingerprint === 'string' && record!.schemaFingerprint.length > 0,
    'the receipt is not bound to the live schema contract');

  assert.equal(retrievedIdentifiers(phrase).includes(CAL_SLUG), true, 'the verified read did not learn');
});

test('with no live schema contract for the identifier, learning fails closed', async () => {
  const sessionId = freshSession('sess-noschema');
  const phrase = 'look up the venue booking sheet';
  acceptSource(sessionId, phrase);
  await governedRead(sessionId, 'SCHEDULERCO_FETCH_VENUES', payloadWithItems(), { schema: null });
  assert.equal(retrievedIdentifiers(phrase).includes('SCHEDULERCO_FETCH_VENUES'), false,
    'a capability was learned with no live schema contract to bind to');
});

test('a capability learned under one contract stops serving when the live contract moves', async () => {
  const sessionId = freshSession('sess-drift');
  const phrase = 'check the parking reservations list';
  acceptSource(sessionId, phrase);
  await governedRead(sessionId, 'SCHEDULERCO_LIST_PARKING', payloadWithItems(), {
    schema: { type: 'object', properties: { lot: { type: 'string' } } },
  });
  assert.equal(retrievedIdentifiers(phrase).includes('SCHEDULERCO_LIST_PARKING'), true,
    'the verified read did not learn under contract v1');

  // The provider ships a NEW contract for the same identifier.
  schemaCache.rememberToolSchema('SCHEDULERCO_LIST_PARKING', {
    type: 'object', properties: { lot: { type: 'string' }, level: { type: 'number' } },
  });
  assert.equal(retrievedIdentifiers(phrase).includes('SCHEDULERCO_LIST_PARKING'), false,
    'a stale capability was served after its provider contract changed');
});

// ─── one phrase, many capabilities ───────────────────────────────────────────

test('a multi-read turn learns every verified capability, and the phrase retrieves them all', async () => {
  const sessionId = freshSession('sess-multi');
  const phrase = 'brief me for tomorrow: calendar and weather';
  acceptSource(sessionId, phrase);
  await governedRead(sessionId, CAL_SLUG, payloadWithItems());
  await governedRead(sessionId, 'WEATHERCO_GET_FORECAST', {
    successful: true, data: { forecast: [{ day: 'tomorrow', high: 21 }] },
  }, { schema: { type: 'object', properties: { city: { type: 'string' } } } });

  const identifiers = retrievedIdentifiers(phrase);
  assert.equal(identifiers.includes(CAL_SLUG), true, 'the first read of the turn was not retrievable');
  assert.equal(identifiers.includes('WEATHERCO_GET_FORECAST'), true,
    'the second read of the turn displaced the first — one phrase can only remember one capability');
});

test('the same phrase proven against two accounts keeps both, each with its own provenance', async () => {
  const sessionId = freshSession('sess-accounts');
  const phrase = 'any new invoices in the inbox?';
  acceptSource(sessionId, phrase);
  await composio._settleVerifiedComposioReadForTest({
    toolSlug: 'MAILCO_FETCH_INVOICES', sessionId,
    result: { successful: true, data: { items: [{ id: 'i-1' }] } },
    accountIdentity: 'ap@northco.example',
  });
  await composio._settleVerifiedComposioReadForTest({
    toolSlug: 'MAILCO_FETCH_INVOICES', sessionId,
    result: { successful: true, data: { items: [{ id: 'i-9' }] } },
    accountIdentity: 'billing@southco.example',
  });

  const aliasIndex = await import('../../memory/capability-alias-index.js');
  const rows = aliasIndex.listCapabilityAliases({ scope: aliasIndex.daemonAliasScope() })
    .filter((row) => row.identifier === 'MAILCO_FETCH_INVOICES');
  const accounts = new Set(rows.map((row) => row.accountIdentity));
  assert.equal(accounts.has('ap@northco.example') && accounts.has('billing@southco.example'), true,
    'two accounts proved the same phrase but only one identity survived — the second write erased the first');
});

// ─── the paraphrase works on the NEXT turn of the same daemon ────────────────

test('a learned paraphrase is semantically retrievable without restart or a manual warm call', async () => {
  // The daemon warmed at boot; this learning happens LATER in its life.
  assert.equal(await candidates.warmCapabilityRetrieval(), true, 'the local model did not load');

  const sessionId = freshSession('sess-nextturn');
  // A capability no earlier test has touched, so nothing pre-warmed can serve
  // this paraphrase — only an embedding attached AFTER this settlement can.
  const phrase = 'how are our support queues holding up right now?';
  acceptSource(sessionId, phrase);
  await governedRead(sessionId, 'DESKCO_LIST_TICKET_QUEUES', {
    successful: true, data: { queues: [{ id: 'q1', backlog: 4 }] },
  }, { schema: { type: 'object', properties: { view: { type: 'string' } } } });

  // The next turn arrives shortly after settlement. Bounded wait, no warm call.
  const paraphrase = 'is the helpdesk backlog under control?';
  let found = false;
  for (let i = 0; i < 30 && !found; i += 1) {
    const resolved = await candidates.resolveTurnCapabilityCandidates({ userInput: paraphrase });
    found = resolved.candidates.some((c) => c.identifier === 'DESKCO_LIST_TICKET_QUEUES');
    if (!found) await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(found, true,
    'the paraphrase retrieved nothing — the new alias waits for a daemon restart to be embedded');
});
