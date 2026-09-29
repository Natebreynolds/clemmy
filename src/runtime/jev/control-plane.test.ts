import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const {
  _setSystemOneFetchForTests,
  _setTypesafeKeyForTests,
} = await import('./client.js');
const {
  classifyOpenQuestionReplyWithJev,
  labelIdentifierWithJev,
  nameResolvedValueWithJev,
  selectAgentForTaskWithJev,
  classifyApprovalReplyWithJev,
  nominateReadCapabilitiesWithJev,
  prepareSharedEvidenceDecisionsWithJev,
  decideTurnStartWithJev,
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
  assert.deepEqual(await prepareSharedEvidenceDecisionsWithJev(query, { candidates, hits }), { candidates, hits });
  assert.equal(posted.length, 2);
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
  assert.equal(await tryJevGroundingVerdict('payload', [{ excerpt: 'src' }]), null);
  assert.equal(await tryJevCompletionVerdict('write a file', 'Created it.'), null);
  assert.equal(await tryJevOutputGroundingVerdict([{ raw: '18%' }], [{ excerpt: 'src' }]), null);
});

test('selectProvenRunStrategyWithJev picks a matching past run and fails open to none', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        which: { type: 'choice', choice: 'strat-cal', probabilities: { 'strat-cal': 0.82, none: 0.18 }, confidence: 0.82 },
        run_0: { type: 'noul', noul: 0.9 },
      },
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
        run_0: { type: 'noul', noul: 0.1 },
        run_1: { type: 'noul', noul: 0.05 },
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
// when the delivery readings are sure and the reply leans supported by
// evidence Jev saw in full, with no figure Jev finds computed.
function completionAnswers(nouls: Partial<Record<'delivered' | 'unaddressed' | 'unsupported' | 'computed' | 'asksUser' | 'cannotFinish', number>>) {
  const values = { delivered: 0.5, unaddressed: 0.5, unsupported: 0.5, computed: 0.05, asksUser: 0.05, cannotFinish: 0.05, ...nouls };
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
  for (const id of ['delivered', 'unaddressed', 'unsupported', 'computed', 'asksUser', 'cannotFinish']) {
    assert.equal(posted.questions?.[id]?.type, 'noul', `${id} is its own yes/no question`);
  }
  assert.equal(posted.model, 'jev-1.13.0', 'the request names a pinned model, not the moving alias');
  assert.equal(posted.state?.receiptsComplete, true);
  assert.deepEqual(posted.state?.receipts, [{ tool: 'write_file', outcome: 'succeeded', complete: true }]);
  assert.equal(posted.state?.memory, undefined, 'no memory was given, none is claimed');
  assert.match(posted.questions?.unsupported?.instructions ?? '', /nor memory show/, 'a specific memory supports is not unsupported');
  await tryJevCompletionVerdict('Create /tmp/jev.txt containing JEV_OK', 'Created it, under 100 words as you prefer.', {
    coverage: receipts, memory: '[REMEMBERED FACTS]\n- The owner prefers replies under 100 words.',
  });
  assert.match(posted.state?.memory ?? '', /prefers replies under 100 words/, 'the checks see what the brain was told');

  const ask = async (nouls: Parameters<typeof completionAnswers>[0]) => {
    answers = completionAnswers(nouls);
    return tryJevCompletionVerdict('Create /tmp/jev.txt containing JEV_OK', 'Created it.', { coverage: receipts });
  };
  const missing = await ask({ delivered: 0.7, unaddressed: 0.9, unsupported: 0.1 });
  assert.equal(missing?.done, false, 'a sure unaddressed part is kept for the reviewer-unavailable path');
  assert.equal(missing?.requirementCoverage, 'missing');
  const leansSupported = await ask({ delivered: 0.95, unaddressed: 0.05, unsupported: 0.3 });
  assert.equal(leansSupported?.done, true,
    'a read-back Jev leans supported settles: real answers add framing no result states word for word');
  assert.equal(await ask({ delivered: 0.95, unaddressed: 0.05, unsupported: 0.5 }), null,
    'a sure delivery that may state unsupported specifics goes to the reviewer');
  assert.equal(await ask({ delivered: 0.95, unaddressed: 0.05, unsupported: 0.1, computed: 0.9 }), null,
    'an answer resting on a figure Jev finds computed stays with the reviewer');
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
      answers: {
        verdict: { type: 'choice', choice: 'drift', probabilities: { on_track: 0.2, drift: 0.8 }, confidence: 0.77 },
        driftKind: { type: 'choice', choice: 'repeating', probabilities: { repeating: 0.9 }, confidence: 0.9 },
      },
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
  assert.equal(drift?.driftKind, 'repeating', 'Jev names how the work left the goal');

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

test('a completion check over clipped evidence never settles on support', async () => {
  _setTypesafeKeyForTests('ts_test');
  let posted: Record<string, any> = {};
  _setSystemOneFetchForTests(async (_url, init) => {
    posted = JSON.parse(String(init.body));
    return { status: 200, ok: true, text: async () => completionAnswers({ delivered: 0.95, unaddressed: 0.05, unsupported: 0.05 }) };
  });
  const receipts = { complete: true, outcomeEvidence: [{ toolName: 'read_report', outcome: 'succeeded', contentComplete: true }] };
  const whole = await tryJevCompletionVerdict('Summarize the report', 'The report says revenue rose.', {
    toolCallSummary: 'read_report: revenue rose', coverage: receipts,
  });
  assert.equal(whole?.done, true, 'the same readings settle when Jev saw every result in full');
  const clipped = await tryJevCompletionVerdict('Summarize the report', 'The report says revenue rose.', {
    toolCallSummary: 'read_report: ' + 'Row of the report. '.repeat(8_000), coverage: receipts,
  });
  assert.ok(posted.state?.evidenceNote, 'the evidence was elided');
  assert.equal(clipped, null, 'content Jev did not see may be what a specific rests on, so the reviewer decides');
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

// The turn-start questions read the same state and do not depend on each
// other, so they travel in ONE request. A fitting remembered run wins; a
// routed operation needs a sure choice and a sure fit.
test('decideTurnStartWithJev asks both turn-start questions in one request', async () => {
  _setTypesafeKeyForTests('ts_test');
  const posted: Array<Record<string, any>> = [];
  let which = 'none';
  _setSystemOneFetchForTests(async (_url, init) => {
    posted.push(JSON.parse(String(init.body)));
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          which: { type: 'choice', choice: which, confidence: 0.88, probabilities: { [which]: 0.88 } },
          run_0: { type: 'noul', noul: 0.9 },
          select: { type: 'choice', choice: 'op_1', confidence: 0.9, probabilities: { op_1: 0.9 } },
          fit_0: { type: 'noul', noul: 0.1 },
          fit_1: { type: 'noul', noul: 0.92 },
        },
        usage: { input_tokens: 90, output_tokens: 8 },
      }),
    };
  });
  const runs = [{ id: 'strat-build', objective: 'Build the brief space', toolsUsed: ['outlook_get_calendar_view'] }];
  const operations = [
    { id: 'space_save', purpose: 'Save a Space' },
    { id: 'space_preview', purpose: 'Render a Space for review' },
  ];
  const routed = await decideTurnStartWithJev('Show me the brief space', runs, operations, { timeoutMs: 1_000 });
  assert.equal(posted.length, 1, 'one request carries both questions');
  assert.ok(posted[0]!.questions.which && posted[0]!.questions.select && posted[0]!.questions.fit_1);
  assert.equal(routed.strategy, null);
  assert.equal(routed.route.pick?.id, 'space_preview');
  assert.equal(routed.failedOpen, false);

  const longRequest = 'Show the workspace. '.repeat(180) + '\nCorrection: preview only; do not save or send anything.';
  await decideTurnStartWithJev(longRequest, runs, operations, { timeoutMs: 1_000 });
  assert.equal(posted.at(-1)!.state.request, longRequest, 'late corrections and their exact boundaries must reach the routing decision');

  which = 'strat-build';
  const remembered = await decideTurnStartWithJev('Show me the brief space', runs, operations, { timeoutMs: 1_000 });
  assert.equal(remembered.strategy?.id, 'strat-build', 'a fitting remembered run wins');
  assert.deepEqual(remembered.strategyJudgement, { outcome: 'picked', confidence: 0.88, fit: 0.9 });

  _setSystemOneFetchForTests(async () => ({ status: 504, ok: false, text: async () => '' }));
  const unreachable = await decideTurnStartWithJev('Show me the brief space', runs, operations, { timeoutMs: 1_000 });
  assert.equal(unreachable.failedOpen, true);
  assert.equal(unreachable.route.pick, null);
  assert.equal(unreachable.strategyJudgement?.outcome, 'unavailable');
});

// A familiar request is worded differently from the run that proved it, and
// runs of the same kind split the choice between them. The choice only has to
// lean toward a run; that run's own yes/no fit has to be sure.
test('a remembered run is taken on a leaning choice and a sure fit of its own, and on nothing less', async () => {
  _setTypesafeKeyForTests('ts_test');
  const posted: Array<Record<string, any>> = [];
  const answer = (which: { choice: string; confidence: number }, fits: number[]) => {
    _setSystemOneFetchForTests(async (_url, init) => {
      posted.push(JSON.parse(String(init.body)));
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            which: { type: 'choice', choice: which.choice, confidence: which.confidence, probabilities: { [which.choice]: which.confidence } },
            ...Object.fromEntries(fits.map((noul, index) => [`run_${index}`, { type: 'noul', noul }])),
          },
          usage: { input_tokens: 40, output_tokens: 4 },
        }),
      };
    });
  };
  const runs = [
    { id: 'strat-links', objective: 'how many backlinks does https://first-firm.example have', toolsUsed: ['metrics__links_summary'] },
    { id: 'strat-rank', objective: 'quick rank overview for https://other-firm.example', toolsUsed: ['metrics__api_request', 'metrics__links_summary'] },
    { id: 'strat-cal', objective: 'whats on my calendar today', toolsUsed: ['calendar_view'] },
  ];
  const request = "what's the backlink count on https://third-firm.example?";

  answer({ choice: 'strat-links', confidence: 0.41 }, [0.93, 0.88, 0.02]);
  const leaning = await decideTurnStartWithJev(request, runs, [], { timeoutMs: 1_000 });
  assert.equal(leaning.strategy?.id, 'strat-links', 'a split choice still picks the run whose own fit is sure');
  assert.deepEqual(leaning.strategyJudgement, { outcome: 'picked', confidence: 0.41, fit: 0.93 });
  const questions = posted.at(-1)!.questions as Record<string, { type: string; instructions: string }>;
  assert.equal(questions.run_0?.type, 'noul', 'each run is asked about on its own');
  assert.match(questions.run_0!.instructions, /metrics__links_summary/);
  assert.equal(Object.keys(questions).filter((key) => key.startsWith('run_')).length, runs.length);
  assert.equal(JSON.stringify(posted.at(-1)!.state), JSON.stringify({ request }), 'the request alone is the decision state');

  answer({ choice: 'strat-links', confidence: 0.9 }, [0.55, 0.3, 0.02]);
  const unsure = await decideTurnStartWithJev(request, runs, [], { timeoutMs: 1_000 });
  assert.equal(unsure.strategy, null, 'a sure choice whose own fit is weak binds nothing');
  assert.deepEqual(unsure.strategyJudgement, { outcome: 'low_fit', confidence: 0.9, fit: 0.55 });

  answer({ choice: 'strat-cal', confidence: 0.3 }, [0.2, 0.2, 0.95]);
  const faint = await decideTurnStartWithJev(request, runs, [], { timeoutMs: 1_000 });
  assert.equal(faint.strategy, null);
  assert.equal(faint.strategyJudgement?.outcome, 'low_confidence');

  answer({ choice: 'none', confidence: 0.8 }, [0.9, 0.9, 0.9]);
  const declined = await decideTurnStartWithJev(request, runs, [], { timeoutMs: 1_000 });
  assert.equal(declined.strategy, null, 'a chosen none is a real no');
  assert.equal(declined.strategyJudgement?.outcome, 'none');
  assert.equal(declined.failedOpen, false);
});


test('classifyOpenQuestionReplyWithJev reads a reply to Clem\'s question as one choice and fails open without Jev', async () => {
  _setTypesafeKeyForTests('ts_test');
  const posted: Record<string, any>[] = [];
  let choice = 'asks';
  let confidence = 0.91;
  _setSystemOneFetchForTests(async (_url, init) => {
    posted.push(JSON.parse(String(init.body)));
    return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: {
      reply: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } },
    }, usage: { input_tokens: 60, output_tokens: 4 } }) };
  });
  const input = {
    question: 'Draft — not sent, holding for your go:\n\n```\n:fire: Friday\n```\n\nWhich channel?',
    reply: 'sorry to confirm what channel are you going to send to',
  };
  assert.deepEqual(await classifyOpenQuestionReplyWithJev(input), { kind: 'asks', confidence: 0.91, failedOpen: false });
  const body = posted[0]!;
  assert.deepEqual(Object.keys(body.questions), ['reply'], 'one question, one request');
  assert.equal(body.questions.reply.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.reply.criteria).sort(), ['answers', 'asks', 'none', 'other']);
  assert.match(JSON.stringify(body.state), /what channel are you going to send to/);

  choice = 'answers'; confidence = 0.97;
  assert.deepEqual(await classifyOpenQuestionReplyWithJev(input), { kind: 'answers', confidence: 0.97, failedOpen: false });
  choice = 'none'; confidence = 0.8;
  assert.deepEqual(await classifyOpenQuestionReplyWithJev(input), { kind: null, confidence: 0.8, failedOpen: false });
  _setTypesafeKeyForTests(null);
  assert.deepEqual(await classifyOpenQuestionReplyWithJev(input), { kind: null, failedOpen: true });
});


test('labelIdentifierWithJev names an id only when Jev is sure, and never offers the id itself', async () => {
  _setTypesafeKeyForTests('ts_test');
  const posted: Record<string, any>[] = [];
  let choice = 'c1';
  let confidence = 0.93;
  _setSystemOneFetchForTests(async (_url, init) => {
    posted.push(JSON.parse(String(init.body)));
    return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: {
      label: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } },
    }, usage: { input_tokens: 30, output_tokens: 2 } }) };
  });
  const input = {
    operation: 'Open Slack dm', field: 'users', value: 'U0FIXTURE1',
    candidates: ['sam', 'Sam Rivera', 'U0FIXTURE1', 'America/Los_Angeles', 'sam'],
  };
  assert.equal(await labelIdentifierWithJev(input), 'Sam Rivera');
  const body = posted[0]!;
  assert.deepEqual(Object.keys(body.questions), ['label']);
  assert.deepEqual(body.questions.label.criteria, {
    c0: 'sam', c1: 'Sam Rivera', c2: 'America/Los_Angeles', none: 'None of these names it.',
  }, 'duplicates and the id itself are not choices');
  confidence = 0.6;
  assert.equal(await labelIdentifierWithJev(input), null, 'an unsure pick shows the id alone');
  choice = 'none'; confidence = 0.99;
  assert.equal(await labelIdentifierWithJev(input), null);
  assert.equal(await labelIdentifierWithJev({ ...input, candidates: ['U0FIXTURE1'] }), null, 'nothing to choose from asks nothing');
  assert.equal(posted.length, 3);
  _setTypesafeKeyForTests(null);
  assert.equal(await labelIdentifierWithJev(input), null, 'no Jev, no name');
});


// Live 2026-09-29: asked the card's question, the router leaned to the right
// name at 0.72 and the learner was told nothing. The learner's question is its
// own, about the request's words, and the reading comes back with no bar applied.
test('nameResolvedValueWithJev returns the chosen name with its confidence, whatever the confidence is', async () => {
  _setTypesafeKeyForTests('ts_test');
  const posted: Record<string, any>[] = [];
  let choice = 'c1';
  let confidence = 0.72;
  _setSystemOneFetchForTests(async (_url, init) => {
    posted.push(JSON.parse(String(init.body)));
    return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: {
      name: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } },
    }, usage: { input_tokens: 40, output_tokens: 2 } }) };
  });
  const input = {
    request: 'Open the Harbor Ledger and count its entries.',
    operation: 'read_file', field: 'path', value: '/fixtures/ledger-7f3a.json',
    candidates: ['2026-09-01', 'Harbor Ledger', '/fixtures/ledger-7f3a.json', 'Harbor Ledger'],
  };
  assert.deepEqual(await nameResolvedValueWithJev(input), { name: 'Harbor Ledger', confidence: 0.72, failedOpen: false });
  const body = posted[0]!;
  assert.deepEqual(Object.keys(body.questions), ['name']);
  assert.deepEqual(body.questions.name.criteria, {
    c0: '2026-09-01', c1: 'Harbor Ledger', none: 'None of these is what the request called it.',
  }, 'duplicates and the value itself are not choices');
  assert.match(JSON.stringify(body.state), /Open the Harbor Ledger/, 'the question is asked beside the request\'s own words');
  assert.doesNotMatch(body.questions.name.instructions, /approval card/);
  confidence = 0.31;
  assert.deepEqual(await nameResolvedValueWithJev(input), { name: 'Harbor Ledger', confidence: 0.31, failedOpen: false });
  choice = 'none'; confidence = 0.97;
  assert.deepEqual(await nameResolvedValueWithJev(input), { name: null, confidence: 0.97, failedOpen: false });
  assert.deepEqual(await nameResolvedValueWithJev({ ...input, candidates: [input.value] }), { name: null, failedOpen: false },
    'nothing to choose from asks nothing');
  assert.equal(posted.length, 3);
  _setTypesafeKeyForTests(null);
  assert.deepEqual(await nameResolvedValueWithJev(input), { name: null, failedOpen: true }, 'no router, no reading');
});


test('selectAgentForTaskWithJev hands a task to an agent only when Jev is sure it is responsible', async () => {
  _setTypesafeKeyForTests('ts_test');
  const posted: Record<string, any>[] = [];
  let choice = 'c1';
  let confidence = 0.91;
  _setSystemOneFetchForTests(async (_url, init) => {
    posted.push(JSON.parse(String(init.body)));
    return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: {
      agent: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } },
    }, usage: { input_tokens: 60, output_tokens: 2 } }) };
  });
  const candidates = [
    { id: 'hiring-desk', name: 'Hiring Desk', handles: 'Summarise applicants.' },
    { id: 'sales-assistant', name: 'Sales Assistant', handles: 'Prepare the weekly briefing.' },
  ];
  const picked = await selectAgentForTaskWithJev('Draft this week\'s sales briefing.', candidates);
  assert.deepEqual(picked, { agent: candidates[1], confidence: 0.91, failedOpen: false });
  const body = posted[0]!;
  assert.deepEqual(Object.keys(body.questions), ['agent']);
  assert.deepEqual(body.questions.agent.criteria, {
    c0: 'Hiring Desk: Summarise applicants.', c1: 'Sales Assistant: Prepare the weekly briefing.',
    none: 'None of these is responsible for this kind of work.',
  });
  confidence = 0.79;
  assert.deepEqual(await selectAgentForTaskWithJev('Draft the briefing.', candidates), { agent: null, confidence: 0.79, failedOpen: false });
  choice = 'none'; confidence = 0.97;
  assert.deepEqual(await selectAgentForTaskWithJev('Book a flight.', candidates), { agent: null, confidence: 0.97, failedOpen: false });
  choice = 'c9';
  assert.equal((await selectAgentForTaskWithJev('x', candidates)).agent, null, 'a choice outside the list is no choice');
  assert.deepEqual(await selectAgentForTaskWithJev('x', []), { agent: null, failedOpen: false }, 'nobody to choose from asks nothing');
  assert.equal(posted.length, 4);
  _setTypesafeKeyForTests(null);
  assert.deepEqual(await selectAgentForTaskWithJev('x', candidates), { agent: null, failedOpen: true });
});


test('classifyApprovalReplyWithJev reads a written reply to a waiting card as one choice and fails open without Jev', async () => {
  _setTypesafeKeyForTests('ts_test');
  const posted: Record<string, any>[] = [];
  let choice = 'changes';
  let confidence = 0.92;
  _setSystemOneFetchForTests(async (_url, init) => {
    posted.push(JSON.parse(String(init.body)));
    return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: {
      reply: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } },
    }, usage: { input_tokens: 50, output_tokens: 3 } }) };
  });
  const input = {
    pending: 'Send Slack message\nmarkdown_text: Could you run the 4:15 review on your own today?',
    reply: 'go ahead but make it shorter',
  };
  assert.deepEqual(await classifyApprovalReplyWithJev(input), { kind: 'changes', confidence: 0.92, failedOpen: false });
  const body = posted[0]!;
  assert.deepEqual(Object.keys(body.questions), ['reply']);
  assert.deepEqual(Object.keys(body.questions.reply.criteria).sort(), ['approves', 'changes', 'declines', 'none', 'other']);
  assert.match(JSON.stringify(body.state), /4:15 review/);
  assert.match(JSON.stringify(body.state), /make it shorter/);
  choice = 'none'; confidence = 0.9;
  assert.deepEqual(await classifyApprovalReplyWithJev(input), { kind: null, confidence: 0.9, failedOpen: false });
  _setTypesafeKeyForTests(null);
  assert.deepEqual(await classifyApprovalReplyWithJev(input), { kind: null, failedOpen: true });
});

// Live 2026-09-28 (source 325491): Jev leaned to the right remembered run
// (0.56, fit 0.67) and to the right operation (0.49, fit 0.63). Neither
// cleared its own bar, nothing was handed over, and the brain spent 9.5 s
// rediscovering an operation it had used nine times two hours earlier.
test('two unsure answers that name the same operation are reported as corroborated, never as a pick', async () => {
  _setTypesafeKeyForTests('ts_test');
  let answers: Record<string, unknown> = {};
  _setSystemOneFetchForTests(async () => ({
    status: 200, ok: true,
    text: async () => JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 90, output_tokens: 8 } }),
  }));
  const choice = (value: string, confidence: number) => ({ type: 'choice', choice: value, confidence, probabilities: { [value]: confidence } });
  const noul = (value: number) => ({ type: 'noul', noul: value });
  const runs = [
    { id: 'strat-events', objective: 'add events to the shared calendar', toolsUsed: ['CALENDAR_LIST_VIEW', 'CALENDAR_CREATE_EVENT'] },
    { id: 'strat-mail', objective: 'draft a reply', toolsUsed: ['mail_create_draft'] },
  ];
  const operations = [
    { id: 'calendar_create_event', purpose: 'Create a calendar event' },
    { id: 'mail_create_draft', purpose: 'Create a mail draft' },
  ];
  const decide = () => decideTurnStartWithJev('Prepare two invitations for next week', runs, operations, { timeoutMs: 1_000 });

  answers = { which: choice('strat-events', 0.56), run_0: noul(0.67), run_1: noul(0.05),
    select: choice('op_0', 0.49), fit_0: noul(0.63), fit_1: noul(0.02) };
  const agreed = await decide();
  assert.equal(agreed.strategy, null, 'neither answer is a pick by itself');
  assert.equal(agreed.route.pick, null);
  assert.equal(agreed.route.outcome, 'low_confidence');
  assert.equal(agreed.corroborated?.strategy.id, 'strat-events');
  assert.equal(agreed.corroborated?.operation.id, 'calendar_create_event', 'operation identity is matched without regard to case');
  assert.deepEqual(agreed.corroborated?.run, { confidence: 0.56, fit: 0.67 });
  assert.deepEqual(agreed.corroborated?.route, { confidence: 0.49, fit: 0.63 });

  // The run Jev leans to did not use the operation Jev would run first.
  answers = { which: choice('strat-mail', 0.56), run_0: noul(0.05), run_1: noul(0.67),
    select: choice('op_0', 0.49), fit_0: noul(0.63), fit_1: noul(0.02) };
  assert.equal((await decide()).corroborated, undefined, 'answers that point at different operations corroborate nothing');

  // Each answer must lean by itself; agreement cannot rescue a faint one.
  answers = { which: choice('strat-events', 0.56), run_0: noul(0.49), run_1: noul(0.05),
    select: choice('op_0', 0.49), fit_0: noul(0.63), fit_1: noul(0.02) };
  assert.equal((await decide()).corroborated, undefined, 'a run whose fit does not lean yes');
  answers = { which: choice('strat-events', 0.56), run_0: noul(0.67), run_1: noul(0.05),
    select: choice('op_0', 0.2), fit_0: noul(0.63), fit_1: noul(0.02) };
  assert.equal((await decide()).corroborated, undefined, 'a faint operation choice');
  answers = { which: choice('none', 0.9), run_0: noul(0.67), run_1: noul(0.05),
    select: choice('op_0', 0.49), fit_0: noul(0.63), fit_1: noul(0.02) };
  assert.equal((await decide()).corroborated, undefined, 'no remembered run chosen');

  // A sure answer is a pick and is never also reported as corroborated.
  answers = { which: choice('strat-events', 0.9), run_0: noul(0.92), run_1: noul(0.05),
    select: choice('op_0', 0.49), fit_0: noul(0.63), fit_1: noul(0.02) };
  const sure = await decide();
  assert.equal(sure.strategy?.id, 'strat-events');
  assert.equal(sure.corroborated, undefined);

  // With only one question asked there is nothing to agree with.
  answers = { which: choice('strat-events', 0.56), run_0: noul(0.67), run_1: noul(0.05) };
  assert.equal((await decideTurnStartWithJev('Prepare two invitations', runs, [], { timeoutMs: 1_000 })).corroborated, undefined);
});
