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

const { recordDeliverable, searchDeliverables, renderDeliverableHit, deliverableKindForShape } = await import('./deliverable-index.js');

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
