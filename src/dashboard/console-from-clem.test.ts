/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/console-from-clem.test.ts
 *
 * A Noticing proposal asks once on Home: in From Clem, answerable in words.
 * Its check-in used to appear twice in Needs you — the question and its
 * carrier notification ("Question from clementine: …") — because the carrier
 * filter dropped approval, plan and trust carriers but not a check-in's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-from-clem-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { createCheckIn } = await import('../agents/check-ins.js');
const { emptyNoticingState } = await import('../agents/noticing.js');
const { saveNoticingState } = await import('../agents/noticing-runtime.js');
const { resetEventLog } = await import('../runtime/harness/eventlog.js');

test.after(() => {
  resetEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot() {
  const app = express();
  app.use(express.json());
  const assistant = { respond: async () => { throw new Error('no model'); }, getRuntime: () => ({ listPendingApprovals: () => [] }) };
  registerConsoleRoutes(app, () => true, assistant as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => { const s = createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((done) => server.close(() => done())) };
}

test('a Noticing proposal is one row in From Clem and one question in Needs you, never its carrier too', async () => {
  const checkIn = createCheckIn({ agentSlug: 'clementine', question: 'Settle the panel goal — close it or re-scope it', urgency: 'normal', contextSummary: 'noticing:p1' });
  const state = emptyNoticingState();
  state.proposals.p1 = {
    id: 'p1', title: 'Settle the panel goal — close it or re-scope it', why: 'It is blocked on a decision.', action: 'Close it',
    evidence: ['goal 249a'], goalId: null, confidence: 0.9, shapeKey: 'k', createdAt: new Date().toISOString(),
    checkInId: checkIn.id, status: 'open',
  } as never;
  saveNoticingState(state);
  const app = await boot();
  try {
    const fromClem = await (await fetch(`${app.url}/api/console/home/from-clem`)).json() as {
      rows: Array<{ key: string; asks: boolean; answer?: { kind: string; questionId?: string } }>;
      covers: { questionIds: string[] };
    };
    const row = fromClem.rows.find((candidate) => candidate.key === 'noticing:p1');
    assert.ok(row, JSON.stringify(fromClem));
    assert.equal(row.asks, true);
    assert.deepEqual(row.answer, { kind: 'words', questionId: `checkin:${checkIn.id}` });
    assert.deepEqual(fromClem.covers.questionIds, [`checkin:${checkIn.id}`]);

    const center = await (await fetch(`${app.url}/api/console/home/command-center`)).json() as {
      needsYou: Array<{ kind?: string; title?: string; questionId?: string; notifId?: string }>;
    };
    const aboutIt = center.needsYou.filter((item) => /Settle the panel goal/.test(item.title ?? ''));
    assert.equal(aboutIt.length, 1, JSON.stringify(aboutIt));
    assert.equal(aboutIt[0]!.questionId, `checkin:${checkIn.id}`);
  } finally {
    await app.close();
  }
});
