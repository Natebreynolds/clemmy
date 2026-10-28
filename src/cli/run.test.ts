/** Run: node scripts/run-tests-isolated.mjs src/cli/run.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-run-'));
const run = await import('./run.js');

test('run arguments: the task, a conversation to continue, json and a timeout', () => {
  assert.deepEqual(run.parseRunArgs(['Summarize', 'my', 'inbox']), { task: 'Summarize my inbox', json: false, timeoutSeconds: 900 });
  assert.deepEqual(run.parseRunArgs(['--json', '--chat', 'console:run-abc', '--timeout', '30', 'and the rest?']),
    { task: 'and the rest?', chat: 'console:run-abc', json: true, timeoutSeconds: 30 });
  assert.deepEqual(run.parseRunArgs([]), { error: 'run needs the task to do, in quotes' });
  assert.deepEqual(run.parseRunArgs(['--chat']), { error: '--chat needs a conversation id' });
  assert.deepEqual(run.parseRunArgs(['--nope', 'x']), { error: 'unknown option --nope' });
});

test('the exit code says how the turn ended: answered, needs you, failed, unreachable', () => {
  const frames = (body: string) => run.parseChatStreamFrames(body);
  const answered = run.runOutcomeFromFrames(frames('{"type":"status","text":"Clementine run started."}\n{"type":"done","sessionId":"console:run-1","text":"Three unread, none urgent.","pendingApprovalId":null,"stoppedReason":"success"}\n'));
  assert.equal(answered.exitCode, 0); assert.equal(answered.status, 'answered'); assert.equal(answered.text, 'Three unread, none urgent.');
  const question = run.runOutcomeFromFrames(frames('{"type":"done","sessionId":"console:run-2","text":"Which account?","pendingApprovalId":null,"stoppedReason":"awaiting-input"}'));
  assert.equal(question.exitCode, 2); assert.equal(question.status, 'needs_you');
  const card = run.runOutcomeFromFrames(frames('{"type":"done","sessionId":"console:run-3","text":"Ready to send; say the word.","pendingApprovalId":"apr-1","stoppedReason":"pending-approval"}'));
  assert.equal(card.exitCode, 2); assert.equal(card.pendingApprovalId, 'apr-1');
  const budget = run.runOutcomeFromFrames(frames('{"type":"done","sessionId":"console:run-4","text":"","pendingApprovalId":null,"stoppedReason":"token-budget"}'));
  assert.equal(budget.exitCode, 1); assert.equal(budget.status, 'failed');
  const errored = run.runOutcomeFromFrames(frames('{"type":"status","text":"x"}\n{"type":"error","error":"Something went wrong."}\nnot json\n'), 'console:run-5');
  assert.equal(errored.exitCode, 1); assert.equal(errored.error, 'Something went wrong.'); assert.equal(errored.sessionId, 'console:run-5');
  assert.match(run.formatRunOutcome(question, false), /clementine run --chat console:run-2/);
  assert.equal(JSON.parse(run.formatRunOutcome(card, true)).exitCode, 2);
});

test('a task reaches the running app through its chat route and nothing else', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>).Authorization) });
    return new Response('{"type":"done","sessionId":"console:run-x","text":"Done.","pendingApprovalId":null,"stoppedReason":"success"}\n', { status: 200 });
  }) as unknown as typeof fetch;
  const out: string[] = [];
  const code = await run.runCliTask({ task: 'Say done', json: true, timeoutSeconds: 5 }, { fetch: fake, stdout: (text) => out.push(text) });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/api\/console\/home\/chat\/stream$/);
  assert.equal(calls[0]!.body.message, 'Say done');
  assert.match(String(calls[0]!.body.sessionId), /^console:run-/);
  assert.match(calls[0]!.auth, /^Bearer /);
  assert.equal(JSON.parse(out[0]!).text, 'Done.');
  const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const unreachable = await run.runCliTask({ task: 'x', json: true, timeoutSeconds: 5 }, { fetch: down, stdout: (text) => out.push(text) });
  assert.equal(unreachable, 4);
});
