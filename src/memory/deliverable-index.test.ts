/**
 * Run: npx tsx --test src/memory/deliverable-index.test.ts
 *
 * Deliverable index — durable "where did I put the user's work" memory.
 * Golden case = the live 2026-07-23 incident: "find those emails we crafted
 * yesterday" must recall ~/Desktop/ML-30-AI-Search-Drafts.md instead of
 * grinding through mailbox searches.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-deliverable-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { recordDeliverable, searchDeliverables, listRecentDeliverables, renderDeliverableHit, deliverableKindForShape, deliverableContextBlock } = await import('./deliverable-index.js');

after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('golden: "find those emails we crafted" recalls the drafted md file with its live path', () => {
  const draftsPath = path.join(TMP_HOME, 'ML-30-AI-Search-Drafts.md');
  writeFileSync(draftsPath, '# Market Leader Outreach — 30 Drafts\n', 'utf-8');
  const rec = recordDeliverable({
    kind: 'file',
    target: draftsPath,
    why: 'Market Leader outreach — 30 personalized AI-search email drafts for review',
    sessionId: 'sess-origin',
    lane: 'local',
  });
  assert.ok(rec, 'record persists');

  const hits = searchDeliverables('hey can you find those emails we crafted yesterday but never put in my drafts');
  assert.ok(hits.length >= 1, 'the drafts file is recalled');
  assert.equal(hits[0].target, draftsPath);
  assert.equal(hits[0].stillExists, true);
  assert.match(renderDeliverableHit(hits[0]), /ML-30-AI-Search-Drafts\.md/);

  // Unrelated asks recall nothing.
  assert.equal(searchDeliverables('what is the weather in denver').length, 0);
});

test('the index points, the filesystem decides: a deleted file is flagged, never asserted', () => {
  const ghostPath = path.join(TMP_HOME, 'deleted-report.md');
  recordDeliverable({ kind: 'file', target: ghostPath, why: 'quarterly deleted report' });
  const hits = searchDeliverables('where is the quarterly deleted report');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].stillExists, false);
  assert.match(renderDeliverableHit(hits[0]), /no longer exists/);
});

test('upsert: chunked writes to the same path keep ONE row with the freshest why', () => {
  const p = path.join(TMP_HOME, 'chunked.html');
  recordDeliverable({ kind: 'file', target: p, why: 'first chunk of the landing page' });
  recordDeliverable({ kind: 'file', target: p, why: 'landing page complete with pricing section' });
  const hits = searchDeliverables('landing page pricing');
  const rows = hits.filter((h) => h.target === p);
  assert.equal(rows.length, 1, 'one row per (kind, target)');
  assert.match(rows[0].why, /pricing/);
});

test('external-write kinds map sensibly', () => {
  assert.equal(deliverableKindForShape('OUTLOOK_CREATE_DRAFT'), 'draft');
  assert.equal(deliverableKindForShape('GMAIL_SEND_EMAIL'), 'send');
  assert.equal(deliverableKindForShape('GOOGLESHEETS_VALUES_UPDATE'), 'external_doc');
  assert.equal(deliverableKindForShape(undefined), 'external_write');
});

test('capture seam: an external_write event tees into the index for every lane', async () => {
  const { createSession, appendEvent } = await import('../runtime/harness/eventlog.js');
  const sess = createSession({ kind: 'chat', title: 'send the weekly digest to the board' });
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'system', type: 'external_write',
    data: { shapeKey: 'GOOGLESHEETS_VALUES_UPDATE', targets: ['spreadsheet:board-digest-1234'] },
  });
  // The tee is fire-and-forget (dynamic import) — give it a beat.
  for (let i = 0; i < 40; i++) {
    if (searchDeliverables('weekly board digest spreadsheet').some((h) => h.target === 'spreadsheet:board-digest-1234')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const hits = searchDeliverables('weekly board digest spreadsheet');
  const hit = hits.find((h) => h.target === 'spreadsheet:board-digest-1234');
  assert.ok(hit, 'external write captured into durable memory');
  assert.equal(hit!.kind, 'external_doc');
  assert.match(hit!.why, /weekly digest/);
});

test('capture seam: pre-dispatch reservations enter durable memory only after exact success', async () => {
  const { createSession, appendEvent } = await import('../runtime/harness/eventlog.js');
  const sess = createSession({ kind: 'chat', title: 'settlement truth canary ledger' });
  const target = 'spreadsheet:settlement-truth-canary-7788';
  const reservation = {
    shapeKey: 'GOOGLESHEETS_VALUES_UPDATE',
    targets: [target],
    preDispatch: true,
    callId: 'deliverable-call-a',
    canonicalCallId: 'deliverable-call-a',
  };
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: reservation,
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(
    searchDeliverables('settlement truth canary ledger').some((hit) => hit.target === target),
    false,
    'a reservation is not a delivered artifact',
  );

  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'external_write_succeeded',
    data: { ...reservation, callId: 'deliverable-call-other', canonicalCallId: 'deliverable-call-other' },
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(
    searchDeliverables('settlement truth canary ledger').some((hit) => hit.target === target),
    false,
    'a different call cannot settle this reservation',
  );

  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'external_write_succeeded',
    data: reservation,
  });
  for (let i = 0; i < 40; i += 1) {
    if (searchDeliverables('settlement truth canary ledger').some((hit) => hit.target === target)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(
    searchDeliverables('settlement truth canary ledger').some((hit) => hit.target === target),
    'the exact success records the durable deliverable',
  );

  const failedTarget = 'spreadsheet:settlement-truth-failed-8899';
  const failedReservation = {
    ...reservation,
    targets: [failedTarget],
    callId: 'deliverable-call-failed',
    canonicalCallId: 'deliverable-call-failed',
  };
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: failedReservation,
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'external_write_failed',
    data: failedReservation,
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'external_write_succeeded',
    data: failedReservation,
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(
    searchDeliverables('settlement truth canary ledger').some((hit) => hit.target === failedTarget),
    false,
    'a demonstrable no-dispatch terminal cannot later be repainted as delivered',
  );
});

// Known-artifacts block for planning surfaces (live 2026-07-24): the planner
// asked "where is the banked research stored?" while this ledger held the
// research files, the target sheet, and the template — every question it
// asked. The block supplies the facts; its rubric forbids re-asking them.
test('deliverableContextBlock: relevant ledger rows with the never-ask rubric; empty on no hits', () => {
  recordDeliverable({
    kind: 'external_doc',
    target: 'https://docs.google.com/spreadsheets/d/test-outreach-sheet',
    why: 'ChatGPT-ads outreach sheet for the new firms — SF contact, keyword, mention status, draft',
  });
  recordDeliverable({
    kind: 'file',
    target: path.join(TMP_HOME, 'outreach-recovery-research-batch-1.json'),
    why: 'banked keyword research for the new-firms outreach run',
  });
  const block = deliverableContextBlock('finish my ChatGPT-Ads outreach sheet for the new firms using the banked keyword research');
  assert.match(block, /KNOWN ARTIFACTS/);
  assert.match(block, /never ask the user where prior work/i);
  assert.match(block, /test-outreach-sheet|research-batch-1/, 'ledger rows are in the block');

  assert.equal(deliverableContextBlock('completely unrelated quantum basket weaving'), '', 'no hits, no block');
});

test('Delivered shelf read: newest first, limit honored, missing files flagged not hidden', () => {
  // The console Work screen's shelf reads this — finished work must never go
  // dark even when the file moved (flag it) or nothing matches a query.
  const ghost = path.join(TMP_HOME, 'moved-away.html');
  recordDeliverable({ kind: 'file', target: ghost, why: 'a brief whose file later moved' });
  const url = 'https://sheets.example.test/shelf-check';
  recordDeliverable({ kind: 'url', target: url, why: 'the shelf-check sheet', lane: 'workflow' });

  const recent = listRecentDeliverables(50);
  assert.ok(recent.length >= 2);
  const times = recent.map((r) => Date.parse(r.createdAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  assert.equal(recent[0].target, url, 'the most recent write leads the shelf');
  const ghostRow = recent.find((r) => r.target === ghost);
  assert.ok(ghostRow, 'a moved file still appears');
  assert.equal(ghostRow.stillExists, false, 'flagged as moved, never silently dropped');
  assert.equal(listRecentDeliverables(1).length, 1, 'limit honored');
});
