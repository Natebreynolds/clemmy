import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const {
  _setSystemOneFetchForTests,
  _setTypesafeKeyForTests,
} = await import('./client.js');
const {
  filterPrimerHitsWithJev,
  prepareSharedEvidenceDecisionsWithJev,
  rerankNamedCandidatesWithJev,
  selectProvenRunStrategyWithJev,
  tryJevCompletionVerdict,
  tryJevGroundingVerdict,
  tryJevOutputGroundingVerdict,
  tryJevTrajectoryVerdict,
} = await import('./control-plane.js');

afterEach(() => {
  _setTypesafeKeyForTests(undefined);
  _setSystemOneFetchForTests(undefined);
});

test('rerankNamedCandidatesWithJev reorders by Choice probabilities', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        which: {
          type: 'choice',
          choice: 'write_file',
          probabilities: { write_file: 0.7, read_file: 0.2, space_save: 0.1 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 40, output_tokens: 4 },
    }),
  }));
  const ranked = await rerankNamedCandidatesWithJev('overwrite the summary file', [
    { name: 'space_save', oneLiner: 'Save a Space' },
    { name: 'read_file', oneLiner: 'Read a file' },
    { name: 'write_file', oneLiner: 'Overwrite a file' },
  ], { label: (c) => c.oneLiner });
  assert.deepEqual(ranked.map((row) => row.name), ['write_file', 'read_file', 'space_save']);
});

test('control-plane adapters fail-open to the original order or Sol when Jev is absent', async () => {
  _setTypesafeKeyForTests(null);
  const original = [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(await rerankNamedCandidatesWithJev('q', original), original);
  const hits = [{ title: 'Salesforce', snippet: 'unrelated', score: 0.2 }];
  assert.equal((await filterPrimerHitsWithJev('write a workflow', hits))[0]?.title, 'Salesforce');
  assert.equal(await tryJevGroundingVerdict('payload', [{ excerpt: 'src' }]), null);
  assert.equal(await tryJevCompletionVerdict('write a file', 'Created it.'), null);
  assert.equal(await tryJevOutputGroundingVerdict([{ raw: '18%' }], [{ excerpt: 'src' }]), null);
});

test('filterPrimerHitsWithJev drops off-topic hits and keeps the top hit if every noul is low', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        hit_0: { type: 'noul', noul: 0.9 },
        hit_1: { type: 'noul', noul: 0.05 },
      },
      usage: { input_tokens: 20, output_tokens: 2 },
    }),
  }));
  const kept = await filterPrimerHitsWithJev('Cedar archive prefix', [
    { title: 'CedarTrial', snippet: 'archive prefix CedarTrial', score: 0.8 },
    { title: 'Salesforce', snippet: 'unrelated CRM', score: 0.3 },
  ]);
  assert.deepEqual(kept.map((hit) => hit.title), ['CedarTrial']);
});

test('selectProvenRunStrategyWithJev picks a matching past run and fails open to none', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: { match: { type: 'noul', noul: 0.82 } },
      usage: { input_tokens: 20, output_tokens: 2 },
    }),
  }));
  const picked = await selectProvenRunStrategyWithJev('whats on my calendar today', [
    { id: 'strat-cal', objective: 'whats on my calendar today', toolsUsed: ['outlook_get_calendar_view'] },
  ]);
  assert.equal(picked.strategy?.id, 'strat-cal');
  assert.equal(picked.failedOpen, false);

  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        which: {
          type: 'choice',
          choice: 'none',
          probabilities: { none: 0.7, 'strat-cal': 0.3 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 20, output_tokens: 2 },
    }),
  }));
  const skipped = await selectProvenRunStrategyWithJev('plan a birthday party', [
    { id: 'strat-cal', objective: 'whats on my calendar today', toolsUsed: ['outlook_get_calendar_view'] },
    { id: 'strat-mail', objective: 'send the standup email', toolsUsed: ['outlook_send_email'] },
  ]);
  assert.equal(skipped.strategy, null);
  assert.equal(skipped.failedOpen, false);

  _setSystemOneFetchForTests(async () => ({
    status: 504,
    ok: false,
    text: async () => '',
  }));
  const timedOut = await selectProvenRunStrategyWithJev('what on my calendar today', [
    { id: 'strat-cal', objective: 'whats on my calendar today', toolsUsed: ['outlook_get_calendar_view'] },
    { id: 'strat-sf', objective: 'find tim in salesforce', toolsUsed: ['salesforce_sf_soql_query'] },
  ]);
  assert.equal(timedOut.strategy, null);
  assert.equal(timedOut.failedOpen, true);
});

test('prepareSharedEvidenceDecisionsWithJev ranks skills and filters primer hits in one request', async () => {
  _setTypesafeKeyForTests('ts_test');
  let posted = 0;
  _setSystemOneFetchForTests(async () => {
    posted += 1;
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          which: {
            type: 'choice',
            choice: 'write_file',
            probabilities: { write_file: 0.8, read_file: 0.2 },
            confidence: 0.9,
          },
          hit_0: { type: 'noul', noul: 0.05 },
          hit_1: { type: 'noul', noul: 0.9 },
        },
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    };
  });
  const prepared = await prepareSharedEvidenceDecisionsWithJev('overwrite the summary file', {
    candidates: [
      { name: 'read_file', description: 'Read a file' },
      { name: 'write_file', description: 'Overwrite a file' },
    ],
    hits: [
      { title: 'Salesforce', snippet: 'unrelated CRM', score: 0.3 },
      { title: 'summary.md', snippet: 'the summary file', score: 0.4 },
    ],
    label: (row) => row.description,
  });
  assert.equal(posted, 1);
  assert.deepEqual(prepared.candidates.map((row) => row.name), ['write_file', 'read_file']);
  assert.deepEqual(prepared.hits.map((hit) => hit.title), ['summary.md']);
});

test('tryJevGroundingVerdict returns a typed verdict only when confidence is high', async () => {
  _setTypesafeKeyForTests('ts_test');
  let posted: { questions?: { verdict?: { instructions?: string } }; state?: { sources?: string[] } } = {};
  _setSystemOneFetchForTests(async (_url, init) => {
    posted = JSON.parse(String(init.body));
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          verdict: {
            type: 'choice',
            choice: 'ungrounded',
            probabilities: { ungrounded: 0.92, grounded: 0.08 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 30, output_tokens: 3 },
      }),
    };
  });
  const blocked = await tryJevGroundingVerdict('Houston', [{ excerpt: `${'Denver '.repeat(800)}` }]);
  assert.equal(blocked?.grounded, false);
  assert.match(posted.questions?.verdict?.instructions ?? '', /send-confirmation|SUCCESS:/);
  assert.match(posted.questions?.verdict?.instructions ?? '', /contradict/i);
  assert.ok((posted.state?.sources?.[0]?.length ?? 0) <= 5000);
  assert.ok((posted.state?.sources?.[0]?.length ?? 0) > 2000);

  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: {
          type: 'choice',
          choice: 'ungrounded',
          probabilities: { ungrounded: 0.51, grounded: 0.49 },
          confidence: 0.2,
        },
      },
      usage: { input_tokens: 30, output_tokens: 3 },
    }),
  }));
  assert.equal(await tryJevGroundingVerdict('maybe', [{ excerpt: 'src' }]), null);
});

test('tryJevCompletionVerdict returns a typed verdict only when confidence is high', async () => {
  _setTypesafeKeyForTests('ts_test');
  let posted: { questions?: { matches?: unknown }; state?: { coverage?: { complete?: boolean } } } = {};
  _setSystemOneFetchForTests(async (_url, init) => {
    posted = JSON.parse(String(init.body));
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          verdict: {
            type: 'choice',
            choice: 'done',
            probabilities: { done: 0.88, incomplete: 0.08, awaiting: 0.02, blocked: 0.01, revise_reply: 0.01 },
            confidence: 0.86,
          },
          matches: { type: 'noul', noul: 0.91 },
        },
        usage: { input_tokens: 40, output_tokens: 4 },
      }),
    };
  });
  const accepted = await tryJevCompletionVerdict(
    'Create /tmp/jev.txt containing JEV_OK',
    'Created /tmp/jev.txt with exactly JEV_OK plus one newline.',
    {
      coverage: {
        complete: true,
        outcomeEvidence: [{ toolName: 'write_file', outcome: 'succeeded', contentComplete: true }],
      },
    },
  );
  assert.equal(accepted?.done, true);
  assert.equal(accepted?.judgeModelId, 'jev-1.13.0');
  assert.equal(accepted?.replyMatchesReceipts, 0.91);
  assert.ok(posted.questions?.matches);
  assert.equal(posted.state?.coverage?.complete, true);

  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: {
          type: 'choice',
          choice: 'incomplete',
          probabilities: { incomplete: 0.8, done: 0.2 },
          confidence: 0.86,
        },
        matches: { type: 'noul', noul: 0.91 },
      },
      usage: { input_tokens: 40, output_tokens: 4 },
    }),
  }));
  const incomplete = await tryJevCompletionVerdict(
    'Create /tmp/jev.txt containing JEV_OK',
    'Created /tmp/jev.txt with exactly JEV_OK plus one newline.',
    {
      coverage: {
        complete: true,
        outcomeEvidence: [{ toolName: 'write_file', outcome: 'succeeded', contentComplete: true }],
      },
    },
  );
  assert.equal(incomplete?.done, false);
  assert.equal(incomplete?.replyMatchesReceipts, 0.91);

  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: {
          type: 'choice',
          choice: 'done',
          probabilities: { done: 0.55, incomplete: 0.45 },
          confidence: 0.3,
        },
      },
      usage: { input_tokens: 40, output_tokens: 4 },
    }),
  }));
  assert.equal(await tryJevCompletionVerdict('write a file', 'Created it.'), null);
});

test('tryJevOutputGroundingVerdict returns a typed rollup only when confidence is high', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        verdict: {
          type: 'choice',
          choice: 'grounded',
          probabilities: { grounded: 0.9, contradicted: 0.05, unverifiable: 0.05 },
          confidence: 0.82,
        },
      },
      usage: { input_tokens: 30, output_tokens: 3 },
    }),
  }));
  const ok = await tryJevOutputGroundingVerdict(
    [{ raw: '18%', context: 'traffic rose' }],
    [{ excerpt: 'traffic +18 percent' }],
  );
  assert.equal(ok?.verdict, 'grounded');
});


test('tryJevTrajectoryVerdict returns a typed on_track/drift reading and fails open on anything else', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200, ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: { verdict: { type: 'choice', choice: 'drift', probabilities: { on_track: 0.2, drift: 0.8 }, confidence: 0.77 } },
      usage: { input_tokens: 40, output_tokens: 3 },
    }),
  }));
  const drift = await tryJevTrajectoryVerdict({
    objective: 'list tomorrow\'s calendar', toolCallSummary: 'tool_search ×12 for tool_output_query',
    latestAssistantNote: 'Searching for the query tool again.', toolCallCount: 13,
  });
  assert.equal(drift?.onTrack, false);
  assert.equal(drift?.confidence, 0.77);
  assert.equal(drift?.model, 'jev-1.13.0');

  _setSystemOneFetchForTests(async () => ({ status: 500, ok: false, text: async () => 'nope' }));
  assert.equal(await tryJevTrajectoryVerdict({
    objective: 'x', toolCallSummary: '', latestAssistantNote: '', toolCallCount: 1,
  }), null, 'a Jev miss changes nothing');
});
