/**
 * Run: npx tsx --test src/dashboard/console-memory-redesign-routes.test.ts
 *
 * Pins for the Memory tab redesign's server seams (2026-09-08):
 *  - GET /api/console/sessions/:id/recall — what she remembered for a
 *    conversation: recall runs joined with their uses, fact text filled in.
 *  - POST /api/console/memory/facts/bulk — one call for many facts.
 *  - GET /api/console/memory/health carries lastHygiene.
 *  - GET /api/console/memory/search-all accepts kind/time facets.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-redesign-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { rememberFact, getFact } = await import('../memory/facts.js');
const { recordRecallRun, recordRecallUse } = await import('../memory/recall-usage.js');
const { appendHygieneAudit } = await import('../memory/hygiene-audit.js');

after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

async function boot() {
  const app = express();
  app.use(express.json());
  const assistant = { getRuntime: () => ({ listPendingApprovals: () => [] }) };
  registerConsoleRoutes(app, () => true, assistant as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => { const s = createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('a session’s recall receipts come back with fact text and used/offered outcomes', async () => {
  const fact = rememberFact({ kind: 'user', content: 'Nate leads with the quiet deals in pipeline summaries', sourceSessionId: 'console:x' } as never) as { id: number } | number;
  const factId = typeof fact === 'number' ? fact : fact.id;
  assert.ok(getFact(factId), 'fixture fact stored');
  const run = recordRecallRun({
    objective: 'who to chase this week', surface: 'chat', answerability: 'supported', sessionId: 'console:recall-test',
    candidateRefs: [{ type: 'fact', id: String(factId) }, { type: 'note', id: 'vault/family-law.md', snippet: 'Family Law tab: 27 geos' }],
  });
  recordRecallUse({ recallId: run.id, refs: [`fact:${factId}`], outcome: 'used' });
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/sessions/${encodeURIComponent('console:recall-test')}/recall?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { runs: Array<{ refs: Array<{ type: string; id: string; text: string; outcome: string }> }>; used: Array<{ type: string; text: string }> };
    assert.equal(body.runs.length, 1);
    const factRef = body.runs[0].refs.find((r) => r.type === 'fact');
    assert.equal(factRef?.text, 'Nate leads with the quiet deals in pipeline summaries', 'fact text is filled in from the store');
    assert.equal(factRef?.outcome, 'used');
    assert.equal(body.runs[0].refs.find((r) => r.type === 'note')?.outcome, 'offered');
    assert.deepEqual(body.used.map((u) => u.type), ['fact'], 'only what was actually used is in `used`');
    const stranger = await fetch(`${h.url}/api/console/sessions/${encodeURIComponent('console:someone-else')}/recall`);
    assert.deepEqual(((await stranger.json()) as { runs: unknown[] }).runs, [], 'another session sees nothing');
  } finally { await h.close(); }
});

test('bulk forget / restore / pin act on many facts in one call and refuse bad input', async () => {
  const a = rememberFact({ kind: 'reference', content: 'bulk alpha', sourceSessionId: 'console:x' } as never) as { id: number } | number;
  const b = rememberFact({ kind: 'reference', content: 'bulk beta', sourceSessionId: 'console:x' } as never) as { id: number } | number;
  const ids = [typeof a === 'number' ? a : a.id, typeof b === 'number' ? b : b.id];
  const h = await boot();
  try {
    const post = (body: unknown) => fetch(`${h.url}/api/console/memory/facts/bulk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const forgot = await (await post({ ids, action: 'forget' })).json() as { done: number[] };
    assert.deepEqual(forgot.done.sort(), [...ids].sort());
    assert.equal(getFact(ids[0])?.active, false);
    const restored = await (await post({ ids, action: 'restore' })).json() as { done: number[] };
    assert.equal(restored.done.length, 2);
    const pinned = await (await post({ ids: [ids[0]], action: 'pin' })).json() as { done: number[] };
    assert.deepEqual(pinned.done, [ids[0]]);
    assert.equal(getFact(ids[0])?.pinned, true);
    assert.equal((await post({ ids, action: 'explode' })).status, 400);
    assert.equal((await post({ ids: [], action: 'forget' })).status, 400);
  } finally { await h.close(); }
});

test('memory health names the last tidy, and search-all accepts kind and time facets', async () => {
  appendHygieneAudit({ at: '2026-09-08T09:40:00.000Z', kind: 'dedup', ids: [1, 2, 3] });
  const h = await boot();
  try {
    const health = await (await fetch(`${h.url}/api/console/memory/health`)).json() as { lastHygiene?: { at: string; kind: string; count: number } | null };
    assert.deepEqual(health.lastHygiene, { at: '2026-09-08T09:40:00.000Z', kind: 'dedup', count: 3 });
    const res = await fetch(`${h.url}/api/console/memory/search-all?q=quiet%20deals&stores=fact,note&asOf=2026-09-08T00:00:00.000Z&purpose=ambient&limit=5`);
    assert.equal(res.status, 200);
    const body = await res.json() as { query: string; hits: unknown[]; diagnostics: { stores: string[] } };
    assert.equal(body.query, 'quiet deals');
    assert.ok(Array.isArray(body.hits));
  } finally { await h.close(); }
});
