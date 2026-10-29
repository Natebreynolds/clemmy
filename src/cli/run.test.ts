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

test('a retained or ownership-lost turn is unfinished, not an answered task', () => {
  for (const sessionId of ['console:run-held', 'console:run-owner-changed']) {
    const text = 'The run is still in progress in this conversation.';
    const outcome = run.runOutcomeFromFrames([
      { type: 'done', sessionId, text, stoppedReason: 'in-progress', pendingApprovalId: null },
    ]);
    assert.deepEqual(outcome, {
      status: 'failed', exitCode: 1, sessionId, text,
      stoppedReason: 'in-progress', pendingApprovalId: null, error: null,
    });
    assert.deepEqual(JSON.parse(run.formatRunOutcome(outcome, true)), outcome);
    const plain = run.formatRunOutcome(outcome, false);
    assert.match(plain, /The turn did not finish \(in-progress\)/);
    assert.ok(plain.includes(`conversation ${sessionId}`));
    assert.doesNotMatch(plain, /Clem asked a question|Clem needs your OK|run --approve/);
  }
});

test('a held headless request keeps its conversation and is never resubmitted', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const out: string[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ type: 'done', sessionId: 'console:run-held',
      text: 'The run is still in progress.', stoppedReason: 'in-progress', pendingApprovalId: null }) + '\n');
  }) as typeof fetch;
  const code = await run.runCliTask({ task: 'Finish the controlled brief', chat: 'console:run-held',
    json: true, timeoutSeconds: 5 }, { fetch: fake, stdout: (text) => out.push(text) });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/api\/console\/home\/chat\/stream$/);
  assert.equal(calls[0]!.body.sessionId, 'console:run-held');
  assert.equal(code, 1);
  const outcome = JSON.parse(out[0]!);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.sessionId, 'console:run-held');
  assert.equal(outcome.stoppedReason, 'in-progress');
});

test('legacy replies and explicit approval cards keep their existing outcomes', () => {
  for (const stoppedReason of [undefined, null, 'success']) {
    const frame = { type: 'done', sessionId: 'console:run-legacy', text: 'Done.', stoppedReason };
    const outcome = run.runOutcomeFromFrames(run.parseChatStreamFrames(JSON.stringify(frame)));
    assert.equal(outcome.status, 'answered');
    assert.equal(outcome.exitCode, 0);
  }
  const card = run.runOutcomeFromFrames([{ type: 'done', sessionId: 'console:run-card',
    stoppedReason: 'in-progress', pendingApprovalId: 'apr-ab12' }]);
  assert.equal(card.status, 'needs_you');
  assert.equal(card.exitCode, 2);
  assert.equal(card.pendingApprovalId, 'apr-ab12');
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

test('a card is answered through the app\'s own button route, never as chat text', async () => {
  const { parseRunArgs, runCliTask } = await import('./run.js');
  const parsed = parseRunArgs(['--approve', 'APR-i6br', '--json']);
  assert.ok(!('error' in parsed) && parsed.decide?.decision === 'approve' && parsed.decide.approvalId === 'apr-i6br');
  assert.ok('error' in parseRunArgs(['--approve', 'nope']));
  const calls: Array<{ url: string; method: string }> = [];
  const out: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: true, status: 'resuming', approval: { sessionId: 'console:run-abc', subject: 'cua-driver__launch_app' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const code = await runCliTask(parsed as Parameters<typeof runCliTask>[0], { fetch: fetchImpl, stdout: (t) => out.push(t) });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/console\/harness-approvals\/apr-i6br\/approve$/);
  assert.equal(calls[0].method, 'POST');
  assert.equal(JSON.parse(out[0]).sessionId, 'console:run-abc');
});
