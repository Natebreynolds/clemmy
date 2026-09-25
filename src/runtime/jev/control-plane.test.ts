import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const {
  _setSystemOneFetchForTests,
  _setTypesafeKeyForTests,
} = await import('./client.js');
const {
  filterPrimerHitsWithJev,
  nominateReadCapabilitiesWithJev,
  prepareSharedEvidenceDecisionsWithJev,
  rerankNamedCandidatesWithJev,
  routeOperationWithJev,
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

test('read nomination preserves accounts, ambiguity and unavailable outcomes', async () => {
  _setTypesafeKeyForTests('ts_test');
  let choice = 'candidate_0';
  _setSystemOneFetchForTests(async () => ({ status: 200, ok: true,
    text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: {
      which: { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } },
    }, usage: { input_tokens: 40, output_tokens: 4 } }),
  }));
  const rows = [
    { name: 'a', operationId: 'list', description: 'List documentation' },
    { name: 'b', operationId: 'list', description: 'List documentation' },
    { name: 'c', operationId: 'fetch', description: 'Read a page' },
  ];
  assert.deepEqual(await nominateReadCapabilitiesWithJev('List available documentation', rows), ['a', 'b']);
  choice = 'ambiguous';
  assert.deepEqual(await nominateReadCapabilitiesWithJev('List available documentation', rows), ['a', 'b', 'c']);
  choice = 'none';
  assert.deepEqual(await nominateReadCapabilitiesWithJev('List available documentation', rows), []);
  for (choice of ['uncertain', 'candidate_99']) {
    assert.equal(await nominateReadCapabilitiesWithJev('List available documentation', rows), null);
  }
  _setTypesafeKeyForTests(null);
  assert.equal(await nominateReadCapabilitiesWithJev('List available documentation', rows), null);
});

test('candidate and primer routing preserve late request constraints and retain fallback on rejection', async () => {
  _setTypesafeKeyForTests('ts_test');
  const posted: Record<string, any>[] = [];
  _setSystemOneFetchForTests(async (_url, init) => {
    posted.push(JSON.parse(String(init.body)));
    return { status: 413, ok: false, text: async () => 'request rejected' };
  });
  const query = 'Background on the requested research. '.repeat(35)
    + '\nOnly read existing records. Do not send email or create a workflow.\n'
    + 'Preserve the exact search string: "two  spaces".';
  const candidates = [{ name: 'read_records' }, { name: 'send_email' }];
  const hits = [{ title: 'Research preference', snippet: 'Read existing records', score: 0.8 }];
  assert.deepEqual(await rerankNamedCandidatesWithJev(query, candidates), candidates);
  assert.deepEqual(await filterPrimerHitsWithJev(query, hits), hits);
  assert.deepEqual(await prepareSharedEvidenceDecisionsWithJev(query, { candidates, hits }), { candidates, hits });
  assert.equal(posted.length, 3);
  for (const request of posted) assert.equal(request.state.request, query);
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

// The completion check asks Jev the typed questions it is built for: a few
// independent yes/no readings over compact state. It settles a review only
// when every reading it rests on is sure.
function completionAnswers(nouls: Partial<Record<'delivered' | 'unaddressed' | 'unsupported' | 'asksUser' | 'cannotFinish', number>>) {
  const values = { delivered: 0.5, unaddressed: 0.5, unsupported: 0.5, asksUser: 0.05, cannotFinish: 0.05, ...nouls };
  return JSON.stringify({
    model: 'jev-1.13.0',
    answers: Object.fromEntries(Object.entries(values).map(([id, noul]) => [id, { type: 'noul', noul }])),
    usage: { input_tokens: 40, output_tokens: 5 },
  });
}

test('tryJevCompletionVerdict settles only when every yes/no reading is sure', async () => {
  _setTypesafeKeyForTests('ts_test');
  let posted: Record<string, any> = {};
  let answers = completionAnswers({ delivered: 0.93, unaddressed: 0.05, unsupported: 0.06 });
  _setSystemOneFetchForTests(async (_url, init) => {
    posted = JSON.parse(String(init.body));
    return { status: 200, ok: true, text: async () => answers };
  });
  const receipts = { complete: true, outcomeEvidence: [{ toolName: 'write_file', outcome: 'succeeded', contentComplete: true }] };
  const accepted = await tryJevCompletionVerdict(
    'Create /tmp/jev.txt containing JEV_OK',
    'Created /tmp/jev.txt with exactly JEV_OK plus one newline.',
    { coverage: receipts },
  );
  assert.equal(accepted?.done, true);
  assert.equal(accepted?.judgeModelId, 'jev-1.13.0');
  assert.equal(accepted?.replyMatchesReceipts, 0.94);
  assert.equal(accepted?.requirementCoverage, 'satisfied');
  for (const id of ['delivered', 'unaddressed', 'unsupported', 'asksUser', 'cannotFinish']) {
    assert.equal(posted.questions?.[id]?.type, 'noul', `${id} is its own yes/no question`);
  }
  assert.equal(posted.model, 'jev-1.13.0', 'the request names a pinned model, not the moving alias');
  assert.equal(posted.state?.receiptsComplete, true);
  assert.deepEqual(posted.state?.receipts, [{ tool: 'write_file', outcome: 'succeeded', complete: true }]);

  const ask = async (nouls: Parameters<typeof completionAnswers>[0]) => {
    answers = completionAnswers(nouls);
    return tryJevCompletionVerdict('Create /tmp/jev.txt containing JEV_OK', 'Created it.', { coverage: receipts });
  };
  const missing = await ask({ delivered: 0.7, unaddressed: 0.9, unsupported: 0.1 });
  assert.equal(missing?.done, false, 'a sure unaddressed part is kept for the reviewer-unavailable path');
  assert.equal(missing?.requirementCoverage, 'missing');
  assert.equal(await ask({ delivered: 0.95, unaddressed: 0.05, unsupported: 0.4 }), null,
    'a sure delivery that may state unsupported specifics goes to the reviewer');
  assert.equal(await ask({ delivered: 0.7, unaddressed: 0.3, unsupported: 0.3 }), null, 'unsure readings settle nothing');
  const question = await ask({ asksUser: 0.92 });
  assert.equal(question?.awaitingUser, true);
  const blocked = await ask({ cannotFinish: 0.9, delivered: 0.3 });
  assert.equal(blocked?.blocked, true);
  assert.equal(blocked?.done, false);
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

test('completion state stays inside Jev\'s budget and still lists every receipt', async () => {
  _setTypesafeKeyForTests('ts_test');
  let posted: Record<string, any> = {};
  _setSystemOneFetchForTests(async (_url, init) => {
    posted = JSON.parse(String(init.body));
    return { status: 503, ok: false, text: async () => 'unavailable' };
  });
  const objective = 'Retained requirement. '.repeat(90) + '\nThen disable the workflow.';
  const response = 'Verified result. '.repeat(450) + '\nWorkflow disabled: false is the saved enabled value.';
  const verifiedReads = 'Earlier successful receipt. '.repeat(180) + '\nFINAL READ: enabled=false';
  const evidence = 'FIRST RESULT. ' + 'Earlier settled work. '.repeat(12_000) + '\nLAST WRITE: enabled=false';
  const outcomes = Array.from({ length: 16 }, (_, index) => ({
    toolName: `operation_${index}`, outcome: 'succeeded', contentComplete: true,
  }));
  assert.equal(await tryJevCompletionVerdict(objective, response, {
    verifiedReads, toolCallSummary: evidence, coverage: { complete: true, outcomeEvidence: outcomes },
  }), null, 'transport unavailability still falls back to the existing reviewer');
  assert.ok(JSON.stringify(posted.state).length < 80_000, 'the state stays well inside the documented request budget');
  assert.equal(posted.state.receipts.length, 16, 'every receipt is listed even when evidence text is elided');
  assert.match(posted.state.request, /Then disable the workflow\.$/, 'the end of the request survives');
  assert.match(posted.state.response, /saved enabled value\.$/, 'the end of the reply survives');
  assert.match(posted.state.evidence, /^FIRST RESULT\./);
  assert.match(posted.state.evidence, /LAST WRITE: enabled=false/, 'the latest write survives the elision');
  assert.match(posted.state.evidence, /FINAL READ: enabled=false$/, 'and so does the final read');
  assert.match(posted.state.evidence, /middle elided for length/);
  assert.ok(posted.state.evidenceNote, 'the elision is disclosed');
});

test('completion sends an identical embedded read block once without dropping distinct evidence', async () => {
  _setTypesafeKeyForTests('ts_test');
  let posted: Record<string, any> = {};
  _setSystemOneFetchForTests(async (_url, init) => {
    posted = JSON.parse(String(init.body));
    return { status: 503, ok: false, text: async () => 'unavailable' };
  });
  const reads = 'VERIFIED RECEIPT: current enabled=false; source=exact';
  const evidence = 'Write receipt.\n' + reads + '\nPending approval remains pending.';
  await tryJevCompletionVerdict('Inspect status', 'Disabled', { verifiedReads: reads, toolCallSummary: evidence });
  assert.equal(posted.state.evidence, evidence);
  await tryJevCompletionVerdict('Inspect status', 'Disabled', { verifiedReads: reads + ' distinct tail', toolCallSummary: evidence });
  assert.equal(posted.state.evidence, `${evidence}\n\n${reads} distinct tail`);
});

// Turn-start routing counts a pick only when Jev is sure of the choice AND of
// that operation's own fit; every other answer leaves discovery to the brain.
test('routeOperationWithJev applies a sure, well-fitting pick and nothing else', async () => {
  _setTypesafeKeyForTests('ts_test');
  const operations = [
    { id: 'workflow_create', purpose: 'Create a new saved workflow' },
    { id: 'workflow_get', purpose: 'Read one saved workflow' },
  ];
  let posted: Record<string, unknown> | null = null;
  const answer = (select: { choice: string; confidence: number }, fits: number[]) => {
    _setSystemOneFetchForTests(async (_url, init) => {
      posted = JSON.parse(init.body) as Record<string, unknown>;
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            select: { type: 'choice', choice: select.choice, confidence: select.confidence, probabilities: { [select.choice]: select.confidence } },
            ...Object.fromEntries(fits.map((noul, index) => [`fit_${index}`, { type: 'noul', noul }])),
          },
          usage: { input_tokens: 60, output_tokens: 6 },
        }),
      };
    });
  };
  const request = "Create a workflow named 'Invite digest' that reads my calendar every morning";

  answer({ choice: 'op_0', confidence: 0.9 }, [0.93, 0.2]);
  const picked = await routeOperationWithJev(request, operations, { timeoutMs: 1_000 });
  assert.equal(picked.outcome, 'picked');
  assert.equal(picked.pick?.id, 'workflow_create');
  assert.equal(picked.fit, 0.93);
  const sent = JSON.stringify(posted);
  assert.match(sent, /Invite digest/, 'the request text is the decision state');
  assert.match(sent, /op_0/, 'candidates travel as opaque host ids');

  answer({ choice: 'op_0', confidence: 0.9 }, [0.55, 0.2]);
  assert.equal((await routeOperationWithJev(request, operations, { timeoutMs: 1_000 })).outcome, 'low_fit',
    'a sure choice whose own fit is weak is not applied');
  answer({ choice: 'op_0', confidence: 0.4 }, [0.95, 0.2]);
  assert.equal((await routeOperationWithJev(request, operations, { timeoutMs: 1_000 })).outcome, 'low_confidence');
  answer({ choice: 'none', confidence: 0.9 }, [0.1, 0.1]);
  assert.equal((await routeOperationWithJev(request, operations, { timeoutMs: 1_000 })).pick, null);
  answer({ choice: 'op_7', confidence: 0.9 }, [0.9, 0.9]);
  assert.equal((await routeOperationWithJev(request, operations, { timeoutMs: 1_000 })).outcome, 'unavailable',
    'a choice outside the offered list is never applied');
  _setSystemOneFetchForTests(async () => ({ status: 504, ok: false, text: async () => '' }));
  assert.equal((await routeOperationWithJev(request, operations, { timeoutMs: 1_000 })).outcome, 'unavailable');
  assert.equal((await routeOperationWithJev(request, [], { timeoutMs: 1_000 })).outcome, 'none');
});

