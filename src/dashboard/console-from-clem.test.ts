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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-from-clem-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { createCheckIn, getCheckIn } = await import('../agents/check-ins.js');
const { emptyNoticingState } = await import('../agents/noticing.js');
const { saveNoticingState } = await import('../agents/noticing-runtime.js');
const { resetEventLog } = await import('../runtime/harness/eventlog.js');
const { addNotification, getNotification } = await import('../runtime/notifications.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

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
      rows: Array<{ key: string; asks: boolean; answer?: { kind: string; questionId?: string }; lifecycle?: { generation?: string } }>;
      covers: { questionIds: string[] };
    };
    const row = fromClem.rows.find((candidate) => candidate.key === 'noticing:p1');
    assert.ok(row, JSON.stringify(fromClem));
    assert.equal(row.asks, true);
    assert.deepEqual(row.answer, { kind: 'words', questionId: `checkin:${checkIn.id}` });
    assert.match(row.lifecycle?.generation ?? '', /^[a-f0-9]{64}$/, 'Today uses the exact question generation');
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

test('question presentation clears attention on every read surface without answering the check-in', async () => {
  const checkIn = createCheckIn({ agentSlug: 'clementine', question: 'Controlled hide-only route fixture', urgency: 'normal' });
  const id = `checkin:${checkIn.id}`;
  const app = await boot();
  try {
    const result = await fetch(`${app.url}/api/console/inbox/questions/${encodeURIComponent(id)}/presentation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dismiss' }),
    });
    assert.equal(result.status, 200);
    assert.equal(getCheckIn(checkIn.id)?.status, 'open');
    const recovery = await (await fetch(`${app.url}/api/console/inbox/questions/presentation`)).json() as {
      questions: Array<{ id: string; action: string; generation: string; mutationToken: string }>;
    };
    const recoverable = recovery.questions.find((row) => row.id === id)!;
    assert.equal(recoverable.action, 'dismiss');
    assert.ok(recoverable.mutationToken);
    const questions = await (await fetch(`${app.url}/api/console/inbox/questions`)).json() as { questions: Array<{ id: string }> };
    assert.equal(questions.questions.some((question) => question.id === id), false);
    const summary = await (await fetch(`${app.url}/api/console/needs-you/summary`)).json() as { keys: string[] };
    assert.equal(summary.keys.includes(id), false);
    const invalid = await fetch(`${app.url}/api/console/inbox/questions/approval:fixture/presentation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dismiss' }),
    });
    assert.equal(invalid.status, 409);
    const restored = await fetch(`${app.url}/api/console/inbox/questions/${encodeURIComponent(id)}/presentation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'restore',
        generation: recoverable.generation, mutationToken: recoverable.mutationToken }),
    });
    assert.equal(restored.status, 200);
    assert.equal(getCheckIn(checkIn.id)?.status, 'open');
  } finally { await app.close(); }
});

test('legacy question dismissal reports a conflict when the question is no longer pending', async () => {
  const app = await boot();
  try {
    for (const kind of ['checkin', 'question']) {
      const result = await fetch(`${app.url}/api/console/inbox/dismiss`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id: 'FRAMEWORK-TEST-no-longer-pending' }),
      });
      assert.equal(result.status, 409);
      assert.equal((await result.json() as { ok: boolean }).ok, false);
    }
  } finally { await app.close(); }
});

test('damaged saved preferences leave Inbox and its count available and refuse changes', async () => {
  const checkIn = createCheckIn({ agentSlug: 'clementine', question: 'Controlled corrupted preference route fixture', urgency: 'normal' });
  const id = `checkin:${checkIn.id}`;
  const file = path.join(TMP_HOME, 'state/question-presentation.json');
  const healthy = readFileSync(file, 'utf8');
  const damaged = '{"version":1,"entries":';
  writeFileSync(file, damaged);
  const app = await boot();
  try {
    const questions = await fetch(`${app.url}/api/console/inbox/questions`);
    assert.equal(questions.status, 200);
    assert.ok((await questions.json() as { questions: Array<{ id: string }> }).questions.some((row) => row.id === id));
    const summary = await fetch(`${app.url}/api/console/needs-you/summary`);
    assert.equal(summary.status, 200);
    assert.ok((await summary.json() as { keys: string[] }).keys.includes(id));
    assert.equal((await fetch(`${app.url}/api/console/inbox/questions/presentation`)).status, 503);
    const mutation = await fetch(`${app.url}/api/console/inbox/questions/${encodeURIComponent(id)}/presentation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dismiss' }),
    });
    assert.equal(mutation.status, 503);
    assert.equal(readFileSync(file, 'utf8'), damaged);
    assert.equal(getCheckIn(checkIn.id)?.status, 'open');
  } finally { writeFileSync(file, healthy); await app.close(); }
});

test('generic attention HTTP controls share exact generations across Home, From Clem and recovery without settling work', async () => {
  const prefix = 'FRAMEWORK-TEST-generic-http';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${prefix}.json`);
  const runBytes = JSON.stringify({ id: prefix, workflow: prefix, workflowSlug: prefix, status: 'blocked', createdAt: new Date().toISOString() });
  writeFileSync(runFile, runBytes);
  const fixtures = [
    { id: `${prefix}-flow`, key: `flow:${prefix.toLowerCase()}`, metadata: { workflow: prefix, runId: prefix, heartbeatId: 'work-review', itemKey: `run_failed:${prefix}`, refType: 'workflow_run', refId: prefix, changeKind: 'run_failed', needsAttention: true } },
    { id: `${prefix}-chat`, key: `session:${prefix}`, metadata: { sessionId: prefix, status: 'needs_input', heartbeatId: 'work-review', needsAttention: true } },
    { id: `${prefix}-calendar`, key: `calendar:${prefix}|invite_unanswered|event`, metadata: { watch: 'calendar', itemKey: `${prefix}|invite_unanswered|event`, changeKind: 'invite_unanswered', startsAt: new Date(Date.now() + 86_400_000).toISOString(), needsAttention: true } },
  ];
  for (const fixture of fixtures) addNotification({ id: fixture.id, kind: fixture.key.startsWith('flow:') ? 'workflow' : 'execution', title: fixture.id, body: 'Controlled pending source; no external work.',
    createdAt: new Date().toISOString(), read: false, metadata: fixture.metadata });
  const app = await boot();
  const endpoint = `${app.url}/api/console/inbox/attention/presentation`;
  const post = (body: unknown) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const summary = async () => (await (await fetch(`${app.url}/api/console/needs-you/summary`)).json()) as {
    total: number; keys: string[]; unreadUpdates: number; attentionItems: Array<{ key: string; lifecycle: { generation: string } }> };
  try {
    const before = await summary();
    for (const fixture of fixtures) {
      const item = before.attentionItems.find(row => row.key === fixture.key)!;
      assert.ok(item, fixture.key);
      const stream = await (await fetch(`${app.url}/api/console/home/from-clem`)).json() as { rows: Array<{ attentionKey?: string; lifecycle?: { generation?: string } }> };
      if (!fixture.key.startsWith('session:')) {
        assert.equal(stream.rows.find(row => row.attentionKey === fixture.key)?.lifecycle?.generation, item.lifecycle.generation);
      }
      const activeCenter = await (await fetch(`${app.url}/api/console/home/command-center`)).json() as {
        needsYou: Array<{ attentionKey?: string; lifecycle?: { generation?: string } }> };
      assert.equal(activeCenter.needsYou.find(row => row.attentionKey === fixture.key)?.lifecycle?.generation, item.lifecycle.generation);
      assert.equal((await post({ key: fixture.key, action: 'dismiss' })).status, 409, 'the old render must supply its exact generation');
      const hidden = await post({ key: fixture.key, action: 'dismiss', generation: item.lifecycle.generation });
      assert.equal(hidden.status, 200);
      const receipt = await hidden.json() as { generation: string; mutationToken: string };
      const recovered = await (await fetch(endpoint)).json() as { count: number; items: Array<{ key: string; mutationToken: string }> };
      assert.equal(recovered.count, recovered.items.length);
      assert.equal(recovered.items.find(row => row.key === fixture.key)?.mutationToken, receipt.mutationToken);
      const after = await summary();
      assert.equal(after.keys.includes(fixture.key), false);
      assert.equal(after.total, before.total - 1);
      assert.equal(after.unreadUpdates, before.unreadUpdates);
      const center = await (await fetch(`${app.url}/api/console/home/command-center`)).json() as { needsYou: Array<{ attentionKey?: string }> };
      assert.equal(center.needsYou.some(row => row.attentionKey === fixture.key), false);
      const hiddenStream = await (await fetch(`${app.url}/api/console/home/from-clem`)).json() as { rows: Array<{ attentionKey?: string }> };
      assert.equal(hiddenStream.rows.some(row => row.attentionKey === fixture.key), false);
      assert.equal(getNotification(fixture.id)?.read, false);
      assert.equal(readFileSync(runFile, 'utf8'), runBytes);
      assert.equal((await post({ key: fixture.key, action: 'restore', generation: receipt.generation })).status, 409);
      assert.equal((await post({ key: fixture.key, action: 'restore', generation: receipt.generation, mutationToken: receipt.mutationToken })).status, 200);
      assert.equal((await summary()).keys.includes(fixture.key), true);
    }
    assert.equal((await post({ key: 'approval:FRAMEWORK-TEST', action: 'dismiss', generation: 'a'.repeat(64) })).status, 409);
    const target = before.attentionItems.find(row => row.key === fixtures[0]!.key)!;
    const oldDismiss = await fetch(`${app.url}/api/console/inbox/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'notif', id: fixtures[0]!.id }) });
    assert.equal(oldDismiss.status, 409, 'legacy clear must not acknowledge an ask without its exact generation');
    assert.equal(getNotification(fixtures[0]!.id)?.read, false);
    const saved = path.join(TMP_HOME, 'state', 'attention-presentation.json');
    const healthy = readFileSync(saved, 'utf8');
    const damaged = '{"version":1,"entries":';
    writeFileSync(saved, damaged);
    try {
      assert.equal((await fetch(endpoint)).status, 503);
      assert.equal((await post({ key: target.key, action: 'dismiss', generation: target.lifecycle.generation })).status, 503);
      assert.equal((await summary()).keys.includes(target.key), true);
      assert.equal(readFileSync(saved, 'utf8'), damaged);
    } finally { writeFileSync(saved, healthy); }
  } finally { await app.close(); }
});
