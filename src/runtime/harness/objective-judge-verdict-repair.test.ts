import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const priorHome = process.env.CLEMENTINE_HOME;
const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-judge-verdict-repair-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(testHome, 'state'), { recursive: true });
const { Usage } = await import('@openai/agents');
const { runRoutedJudgeAttempt, parseCompletionVerdict } = await import('./objective-judge.js');
const { closeEventLog } = await import('./eventlog.js');

after(() => {
  closeEventLog();
  rmSync(testHome, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = priorHome;
});

const LONG_REVIEW = [
  'Reviewing the three drafts against the checklist.',
  'Draft 1 uses home services terms, one call to action, 87 words, no banned phrases.',
  'Draft 2 uses legal terms, cites the Local Services Ads gap, 91 words.',
  'Draft 3 uses patient language, contrasts the ratings honestly, 79 words.',
  'All three name the market insight and end with the same question. Nothing was sent.',
].join('\n');

function scripted(texts: string[]): { model: Model; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const model: Model = {
    async getResponse(request): Promise<ModelResponse> {
      requests.push(request);
      const text = texts[Math.min(requests.length - 1, texts.length - 1)]!;
      return { output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, providerData: {} }] }], usage: new Usage(), responseId: `verdict-${requests.length}` };
    },
    async *getStreamedResponse() { throw Error('the judge must not stream'); },
  };
  return { model, requests };
}

const route = (model: Model) => ({
  model, modelId: 'fixture-flagship-judge', judgeFamily: 'claude' as const, brainFamily: 'byo' as const,
  selfJudge: false, ownerSelectedJudge: true,
});

test('a reviewer that wrote a review without the verdict line is asked once for the line from its own words', async () => {
  const { model, requests } = scripted([LONG_REVIEW, 'DONE: all three drafts are present with To, Subject, Body and word counts, nothing sent']);
  const verdict = await runRoutedJudgeAttempt(route(model), 'Audit the accepted objective. Reply with EXACTLY ONE LINE.',
    'Objective: three cold emails for review. Delivered: three drafts with word counts. EVIDENCE PACKET: <sixteen thousand tokens of tool results>', parseCompletionVerdict);
  assert.equal(verdict.done, true);
  assert.match(verdict.reason, /three drafts/);
  assert.equal(requests.length, 2, 'exactly one re-ask');
  const repair = JSON.stringify(requests[1]!.input);
  assert.match(repair, /\[YOUR REVIEW\]/);
  assert.match(repair, /Draft 3 uses patient language/, 'the re-ask carries the reviewer\'s own review');
  assert.doesNotMatch(repair, /EVIDENCE PACKET/, 'the re-ask does not resend the evidence packet');
});

test('a reviewer that still gives no verdict fails with the head of what it wrote, never a silent unreadable', async () => {
  const { model, requests } = scripted([LONG_REVIEW, 'I already explained my assessment above in detail.']);
  await assert.rejects(
    runRoutedJudgeAttempt(route(model), 'Audit the accepted objective.', 'Objective: x. Delivered: y.', parseCompletionVerdict),
    (error: unknown) => error instanceof Error && /did not parse; it began: Reviewing the three drafts/.test(error.message),
  );
  assert.equal(requests.length, 2);
});

test('a verdict that parses the first time is never re-asked', async () => {
  const { model, requests } = scripted(['INCOMPLETE: two of three drafts are missing']);
  const verdict = await runRoutedJudgeAttempt(route(model), 'Audit.', 'Objective: x. Delivered: y.', parseCompletionVerdict);
  assert.equal(verdict.done, false);
  assert.equal(requests.length, 1);
});

 test('verdict repair preserves a late finding beyond the former excerpt boundary', async () => {
  const lateFinding = 'FINAL FINDING: the third draft is missing; the objective is incomplete.';
  const { model, requests } = scripted(['Detailed evidence assessment. '.repeat(300) + lateFinding, 'INCOMPLETE: third draft missing']);
  const verdict = await runRoutedJudgeAttempt(route(model), 'Audit.', 'Three drafts requested.', parseCompletionVerdict);
  assert.equal(verdict.done, false);
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[1]!.input).includes(lateFinding));
});
