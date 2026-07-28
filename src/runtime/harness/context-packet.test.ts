/**
 * Run: npx tsx --test src/runtime/harness/context-packet.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-context-packet-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

mkdirSync(path.join(TMP_HOME, 'skills', 'proposal-builder'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'skills', 'proposal-builder', 'SKILL.md'),
  [
    '---',
    'name: proposal-builder',
    'description: Build branded SEO audit proposals from site research and meeting notes',
    '---',
    '',
    'Use DataForSEO, local notes, and the proposal HTML framework.',
  ].join('\n'),
  'utf-8',
);

mkdirSync(path.join(TMP_HOME, 'skills', 'email-report-helper'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'skills', 'email-report-helper', 'SKILL.md'),
  [
    '---',
    'name: email-report-helper',
    'description: Build polished email reports for campaign review.',
    'tier: approved',
    '---',
    '',
    'Draft email report artifacts.',
  ].join('\n'),
  'utf-8',
);

mkdirSync(path.join(TMP_HOME, 'skills', 'lunar-audit'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'skills', 'lunar-audit', 'SKILL.md'),
  [
    '---',
    'name: lunar-audit',
    'description: Generate a branded Digital Footprint audit for a prospect URL and deploy the HTML report to Netlify.',
    'tier: approved',
    '---',
    '',
    'Turn one prospect URL into an SEO audit, deploy it to Netlify, and provide a screenshot.',
  ].join('\n'),
  'utf-8',
);

mkdirSync(path.join(TMP_HOME, 'skills', 'generic-worker-helper'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'skills', 'generic-worker-helper', 'SKILL.md'),
  [
    '---',
    'name: generic-worker-helper',
    'description: Run each task with a worker call and return its output',
    'tier: approved',
    '---',
    '',
    'For each item, call a worker and return the output.',
  ].join('\n'),
  'utf-8',
);

mkdirSync(path.join(TMP_HOME, 'skills', 'client-seo-report'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'skills', 'client-seo-report', 'SKILL.md'),
  [
    '---',
    'name: client-seo-report',
    'description: Ready for every client SEO report delivery.',
    'tier: approved',
    '---',
    '',
    'Prepare the client SEO report.',
  ].join('\n'),
  'utf-8',
);

mkdirSync(path.join(TMP_HOME, 'vault', '00-System', 'workflows', 'seo-proposal', 'scripts'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'vault', '00-System', 'workflows', 'seo-proposal', 'SKILL.md'),
  [
    '---',
    'name: SEO Proposal Workflow',
    'description: Build an SEO proposal from website research',
    'enabled: true',
    'when_to_use: Use when the user asks to build a branded SEO audit or proposal from a website.',
    'steps:',
    '  - id: research',
    '---',
    '',
    '## step: research',
    '',
    'Research the site and produce proposal inputs.',
  ].join('\n'),
  'utf-8',
);

mkdirSync(path.join(TMP_HOME, 'vault', '00-System', 'workflows', 'generic-item-loop', 'scripts'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'vault', '00-System', 'workflows', 'generic-item-loop', 'SKILL.md'),
  [
    '---',
    'name: Generic Item Loop',
    'description: Run a call for each item and return worker outputs',
    'enabled: true',
    'when_to_use: Use for each task that needs a worker call.',
    'steps:',
    '  - id: execute',
    '---',
    '',
    '## step: execute',
    '',
    'Run each item and return its output.',
  ].join('\n'),
  'utf-8',
);

const { buildAgentContextPacket, detectMultiItemIntent, detectMultiItemIntentFromConversation } = await import('./context-packet.js');
const { __resetAgentSystemGuidanceCacheForTests } = await import('../agent-system-guidance.js');
const capabilityHealth = await import('./capability-health.js');
const {
  cancelProspectiveIntention,
  closeProspectiveIntentionsDbForTest,
  upsertProspectiveIntention,
} = await import('../prospective-intentions.js');

test.after(() => {
  closeProspectiveIntentionsDbForTest();
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

test.beforeEach(() => {
  capabilityHealth._resetHarnessCapabilityHealthForTest();
});

test('context packet ranks relevant skills and workflows for the current request', () => {
  const packet = buildAgentContextPacket(
    'Can you build a branded SEO audit proposal from this website and my notes?',
    { enabled: true, hitCount: 2, source: 'hybrid', injected: true },
  );

  assert.equal(packet.memory.hitCount, 2);
  assert.equal(packet.skills[0]?.name, 'proposal-builder');
  assert.equal(packet.workflows[0]?.name, 'seo-proposal');
  assert.deepEqual(packet.toolScope.allowedServerSlugs, ['dataforseo']);
  assert.match(packet.text, /AGENT CONTEXT PACKET/);
  assert.match(packet.text, /External MCP scope: dataforseo/);
  assert.match(packet.text, /call skill_read/);
  assert.match(packet.text, /reusable-process candidates/);
  // Journey-1 discovery cue: a vague run request must route to workflow_run
  // (the resolver confirms), while still not auto-running unrequested workflows.
  assert.match(packet.text, /call workflow_run with their exact phrasing/);
  assert.match(packet.text, /Do NOT auto-run a workflow the user did not ask to run/);
});

test('context packet projects only relevant future commitments and conditionally suggests durable capture', () => {
  upsertProspectiveIntention({
    id: 'timer:orchid-launch',
    sourceKind: 'timer',
    sourceId: 'orchid-launch',
    objective: 'Review the Orchid launch dashboard',
    trigger: { kind: 'time', at: '2026-08-01T16:00:00.000Z' },
    action: { kind: 'notify', ref: 'orchid-launch' },
    sessionId: 'chat:orchid',
    risk: 'read',
    approvalMode: 'none',
  });
  try {
    const unrelated = buildAgentContextPacket(
      'What is the capital of France?',
      { enabled: true, hitCount: 0, injected: false },
      { sessionKind: 'chat', sessionId: 'chat:other' },
    );
    assert.equal(unrelated.prospective.injected, false);
    assert.doesNotMatch(unrelated.text, /RELEVANT FUTURE INTENTIONS/);

    const relevant = buildAgentContextPacket(
      'What is next for the Orchid launch?',
      { enabled: true, hitCount: 0, injected: false },
      { sessionKind: 'chat', sessionId: 'chat:orchid' },
    );
    assert.equal(relevant.prospective.injected, true);
    assert.equal(relevant.prospective.count, 1);
    assert.match(relevant.text, /Review the Orchid launch dashboard/);

    const capture = buildAgentContextPacket(
      'Remind me tomorrow to review the Orchid launch dashboard.',
      { enabled: true, hitCount: 0, injected: false },
      { sessionKind: 'chat', sessionId: 'chat:other' },
    );
    assert.equal(capture.prospective.captureSuggested, true);
    assert.match(capture.text, /Do not rely on chat memory or merely promise it/);
  } finally {
    cancelProspectiveIntention('timer:orchid-launch', 'test_cleanup');
  }
});

test('an already-prepared Netlify deploy does not summon an artifact-generation skill', () => {
  const packet = buildAgentContextPacket(
    'Deploy the already-prepared local directory /Users/test/project/artifacts/site to production on https://fixture.netlify.app. Return the deploy URL after verification.',
    { enabled: true, hitCount: 0, source: 'unified', injected: false },
  );
  assert.deepEqual(packet.skills, [], 'paths, URLs, and generic deploy words are payload—not skill intent');
});

// ─── detectMultiItemIntentFromConversation — count carried from prior turns ──

test('conversation carry: "yes" answering the assistant\'s own "18 firms?" proposal inherits the batch', () => {
  // The live 2026-07-07 shape: the ASSISTANT proposed the batch, the user
  // affirmed without repeating the count, and the run serialized 18 firms.
  const proposal = 'Found 20 accounts; 2 have no email on file. Want me to run research on these 18 email-ready firms next?';
  for (const affirmation of [
    'yes',
    'yea lets fan out some robust seo research for these firms please finding where they are missing on page 2.',
    'go ahead and scrape those',
  ]) {
    const r = detectMultiItemIntentFromConversation(affirmation, [proposal]);
    assert.equal(r.isMultiItem, true, `"${affirmation}" must inherit the prior 18-firm batch`);
    assert.equal(r.itemCount, 18);
    assert.equal(r.itemKind, 'firms');
    assert.equal(r.carriedFromPrior, true);
  }
});

test('conversation carry: current-message detection still wins and is not marked carried', () => {
  const r = detectMultiItemIntentFromConversation(
    'Scrape these 44 law firms and pull each one’s contact page.',
    ['Want me to run research on these 18 email-ready firms next?'],
  );
  assert.equal(r.isMultiItem, true);
  assert.equal(r.itemCount, 44, 'the current message\'s own batch wins over history');
  assert.ok(!r.carriedFromPrior);
});

test('conversation carry: a NEW unrelated request does not inherit a stale batch', () => {
  const history = ['Want me to run research on these 18 email-ready firms next?'];
  // No continuation/affirmation shape → no carry.
  const fresh = detectMultiItemIntentFromConversation('what time is my next meeting?', history);
  assert.equal(fresh.isMultiItem, false, 'unrelated question must not inherit the firm batch');
  // Empty/absent history degrades to current-message behavior.
  const noHist = detectMultiItemIntentFromConversation('yes', []);
  assert.equal(noHist.isMultiItem, false);
  const undefHist = detectMultiItemIntentFromConversation('yes', undefined);
  assert.equal(undefHist.isMultiItem, false);
});

// ─── P0: detectMultiItemIntent unit table ──────────────────────────────────

test('detectMultiItemIntent FIRES on independent same-shape multi-item work', () => {
  const prospects = detectMultiItemIntent('Research these 10 prospects and log what each firm does.');
  assert.equal(prospects.isMultiItem, true, '"research these 10 prospects" must fire');
  assert.equal(prospects.itemCount, 10);
  assert.equal(prospects.itemKind, 'prospects');
  assert.equal(prospects.sameShapeWork, true);

  // The 44-firm class — both the inline-count phrasing and a pasted list.
  const firms = detectMultiItemIntent('Scrape these 44 law firms and pull each one’s contact page.');
  assert.equal(firms.isMultiItem, true, '"scrape these 44 firms" must fire');
  assert.equal(firms.itemCount, 44);

  const listInput = [
    'Audit each of these firms:',
    '1. Foo & Bar LLP',
    '2. Baz Law Group',
    '3. Qux Legal',
    '4. Quux Attorneys',
  ].join('\n');
  const listed = detectMultiItemIntent(listInput);
  assert.equal(listed.isMultiItem, true, 'an enumerated 4-item list with a work verb must fire');
  assert.equal(listed.itemCount, 4);
});

test('detectMultiItemIntent uses size-aware boundaries (soft < 8, imperative >= 8)', () => {
  const small = detectMultiItemIntent('Draft outreach emails for these 4 prospects.');
  assert.equal(small.isMultiItem, true);
  assert.equal(small.itemCount, 4);
  assert.equal(small.explicitParallelRequest, false);
  const large = detectMultiItemIntent('Draft outreach emails for these 12 prospects.');
  assert.equal(large.isMultiItem, true);
  assert.equal(large.itemCount, 12);
});

test('detectMultiItemIntent marks explicit parallel/same-shape requests', () => {
  const r = detectMultiItemIntent('For each of these 5 firms, parallelize the same-shape SEO snapshot work.');
  assert.equal(r.isMultiItem, true);
  assert.equal(r.itemCount, 5);
  assert.equal(r.explicitParallelRequest, true);
});

test('detectMultiItemIntent FIRES despite an incidental aggregate verb when per-item work is present (live 2026-06-02 regression)', () => {
  // "research … tell me which failed" was wrongly suppressed by "tell me".
  const r = detectMultiItemIntent(
    'Research these 8 law-firm websites as 8 independent per-item jobs: alpha.example, beta.example — for each return a one-line SEO snapshot. Then tell me which you could not get data for.',
  );
  assert.equal(r.isMultiItem, true, 'a genuine per-item research request must fire even with a trailing "tell me"');
  assert.equal(r.itemCount, 8);
  // The retrieval-only case is still suppressed (no deep-work verb).
  assert.equal(detectMultiItemIntent('Show my last 5 emails.').isMultiItem, false);
  assert.equal(detectMultiItemIntent('Give me my 5 latest invoices.').isMultiItem, false);

  // Live 2026-06-02 #2: an incidental "<n>-sentence analysis of that firm"
  // must NOT be misread as internal cardinality and suppress a per-firm fan-out.
  const heavy = detectMultiItemIntent(
    'For each of these 8 law firms, do a full per-firm SEO audit: pull ranked keywords, backlinks, and competitors, then write a 2-3 sentence analysis of that firm’s SEO position. Firms: alpha.example, beta.example.',
  );
  assert.equal(heavy.isMultiItem, true, '"2-3 sentence analysis of that firm" must not suppress an 8-firm audit');
  assert.equal(heavy.itemCount, 8);
  // The tight possessive internal-cardinality case is still suppressed.
  assert.equal(detectMultiItemIntent("Research this firm's 10 competitors.").isMultiItem, false);
});

test('detectMultiItemIntent does NOT fire on the no-fire cases', () => {
  const cases: Array<[string, string]> = [
    ['Tell me 3 jokes.', 'conversational, no per-item tool work'],
    ['Show my last 5 emails.', 'single paginated collection read'],
    ["Research this firm's 10 competitors.", 'internal cardinality (one parent)'],
    ['First do A, then B, then C.', 'sequential A->B->C chain'],
    ['Give me 3 options for the headline.', 'conversational ideation'],
    ['Pull the 200 rows from the leads table.', 'paginated one-table job'],
    ['Summarize the last 30 days of activity.', 'time span, not items'],
    ['Verify the fetched index SHA-256 equals abc123, then report pass or the exact mismatch.', 'checksum algorithm, not 256 items'],
    ['Verify all 18 checks passed and report the evidence.', 'checks belong to one validation task'],
    ['Research this firm and its competitors.', 'no explicit count'],
    ['Using only Clementine local memory, list exactly the 8 people on the Northstar live-proof team. Return names only, no emails. Do not write or change memory.', 'aggregate recall plus negated write boundary'],
  ];
  for (const [input, why] of cases) {
    assert.equal(detectMultiItemIntent(input).isMultiItem, false, `must NOT fire: "${input}" (${why})`);
  }
});

test('local-memory recall stays simple and receives no unrelated agent-system guidance', () => {
  const packet = buildAgentContextPacket(
    'Using only Clementine local memory, list exactly the 8 people on the Northstar live-proof team. Return JSON with a single key names containing an array of names only, no emails. Do not write or change memory. Do not call any external connector.',
    { enabled: true, hitCount: 2, source: 'unified', injected: true },
    { sessionKind: 'chat', sessionId: 'local-memory-context' },
  );
  assert.equal(packet.complexity, 'simple');
  assert.equal(packet.multiItem.detected, false);
  assert.equal(packet.agentSystem.injected, false);
  assert.equal(packet.agentSystem.recommendationCount, 0);
  assert.doesNotMatch(packet.text, /AGENT SYSTEM GUIDANCE|Fan-out directive/);
});

test('a negated retry constraint does not inject global repair-loop guidance or unrelated draft skills/workflows', () => {
  const packet = buildAgentContextPacket(
    [
      'External-write smoke test. Modify only Sheet1!E1:G5 in this existing disposable Google Sheet.',
      'The email-shaped strings are inert cell data. Do not send email or use Outlook.',
      'Perform one write and one read-back. Do not retry an ambiguous or failed write.',
    ].join(' '),
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'precision-sheet-write' },
  );
  assert.equal(packet.agentSystem.injected, false);
  assert.equal(packet.skills.length, 0);
  assert.equal(packet.workflows.length, 0);
  assert.doesNotMatch(packet.text, /AGENT SYSTEM GUIDANCE/);
});

test('generic fan-out scaffolding does not recall unrelated skills or workflows', () => {
  const packet = buildAgentContextPacket(
    'For each of alpha, beta, and gamma, run one worker call in parallel and return only its output.',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'generic-fanout-relevance' },
  );
  assert.equal(packet.skills.length, 0);
  assert.equal(packet.workflows.length, 0);
  assert.doesNotMatch(packet.text, /generic-worker-helper|generic-item-loop/i);
});

test('a full JSON-matrix Sheet replay scopes only Sheets and injects no email/report procedure', () => {
  const packet = buildAgentContextPacket(
    [
      'External-write smoke test against the existing disposable Google Sheet.',
      'Target: https://docs.google.com/spreadsheets/d/fixture/edit. Modify only Sheet1!E1:G5.',
      'Write exactly this matrix:',
      '[["company","email","qualified"],["Clem Smoke Alpha","alpha@example.invalid","TRUE"],["Clem Smoke Beta","beta@example.invalid","FALSE"]]',
      'The email-shaped strings are inert cell data.',
      'Perform exactly one Google Sheets value write and one read-back.',
      'Do not send email or use Outlook. Do not retry an ambiguous or failed write.',
      'When ready, report PASS only if every read-back cell is exact; otherwise report FAIL or BLOCKED.',
    ].join('\n'),
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'precision-sheet-json-matrix' },
  );
  assert.deepEqual(packet.toolScope.allowedServerSlugs, ['googlesheets', 'google_sheets', 'google']);
  assert.equal(packet.skills.length, 0);
  assert.equal(packet.workflows.length, 0);
  assert.equal(packet.agentSystem.injected, false);
  assert.doesNotMatch(packet.text, /email-report-helper/);
  assert.doesNotMatch(packet.text, /outlook\/email intent/i);
});

test('detectMultiItemIntent is total — never throws, handles junk input', () => {
  assert.equal(detectMultiItemIntent('').isMultiItem, false);
  assert.equal(detectMultiItemIntent('   ').isMultiItem, false);
  // @ts-expect-error intentionally passing a non-string to prove fail-open
  assert.equal(detectMultiItemIntent(undefined).isMultiItem, false);
  // @ts-expect-error intentionally passing a non-string to prove fail-open
  assert.equal(detectMultiItemIntent({ nope: true }).isMultiItem, false);
});

// ─── P0: packet wiring (chat-only directive, size-aware, suppression) ───────

const NO_MEMORY = { enabled: false, hitCount: 0, source: null, injected: false } as const;

test('packet keeps harness capability warnings on QA-lightened turns', () => {
  capabilityHealth.recordHarnessCapabilityHealth({
    id: 'claude_sdk_local_mcp_surface',
    state: 'unavailable',
    summary: 'Claude SDK local MCP surface did not initialize.',
    reason: 'SDK stream ended before emitting an init message.',
    sessionId: 'context-packet-health',
  });

  const packet = buildAgentContextPacket(
    'what is the current harness status?',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'context-packet-health' },
  );

  assert.equal(packet.turnIntent, 'qa');
  assert.equal(packet.mcp.length, 0, 'QA lightening still skips MCP probes');
  assert.ok(packet.healthWarnings.some((warning) => /claude_sdk_local_mcp_surface/.test(warning)));
  assert.match(packet.text, /Harness claude_sdk_local_mcp_surface is unavailable/);
  assert.match(packet.text, /SDK stream ended before emitting an init message/);
});

test('packet injects bounded agent-system guidance for chat turns', () => {
  const packet = buildAgentContextPacket(
    'Can you create an agent swarm to review this workflow retry issue?',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'sess-agent-guidance' },
  );

  assert.equal(packet.agentSystem.injected, true);
  assert.ok(packet.agentSystem.recommendationCount > 0);
  assert.ok(packet.agentSystem.policy);
  assert.match(packet.text, /AGENT SYSTEM GUIDANCE/);
  assert.match(packet.text, /run-shaping guidance only/);
  assert.match(packet.text, /State: Swarm readiness \d+\/100/);
  assert.match(packet.text, /loop effectiveness \d+\/100/);
  assert.match(packet.text, /interventions \d+\/100/);
  assert.match(packet.text, /learning \w+ \d+% recall/);
  assert.match(packet.text, /trend \w+/);
  assert.match(packet.text, /mode [a-z-]+ \([a-z]+\)/);
  assert.match(packet.text, /Recommended mode: [a-z-]+ \([a-z]+, confidence \d+\/100\)/);
  assert.match(packet.text, /Fanout posture: [a-z]+; worker wave size \d+/);
});

test('packet suppresses agent-system guidance for workflow turns', () => {
  const packet = buildAgentContextPacket(
    'Research these 10 prospects and capture each firm’s SEO posture.',
    NO_MEMORY,
    { sessionKind: 'workflow', sessionId: 'workflow:run-x:step' },
  );

  assert.equal(packet.agentSystem.injected, false);
  assert.equal(packet.agentSystem.recommendationCount, 0);
  assert.equal(packet.agentSystem.policy, null);
  assert.doesNotMatch(packet.text, /AGENT SYSTEM GUIDANCE/);
});

test('packet injects the IMPERATIVE fan-out directive for chat sessions with N>=8', () => {
  const packet = buildAgentContextPacket(
    'Research these 10 prospects and capture each firm’s SEO posture.',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'sess-chat-1' },
  );
  assert.equal(packet.multiItem.detected, true);
  assert.equal(packet.multiItem.itemCount, 10);
  assert.equal(packet.multiItem.offered, true);
  assert.equal(packet.multiItem.fanoutPosture, 'soft');
  assert.equal(packet.multiItem.recommendedWorkerWaveSize, 4);
  assert.match(packet.text, /Fan-out directive: this turn names 10 independent same-shape/);
  assert.match(packet.text, /Do NOT serialize/);
  assert.match(packet.text, /parallel waves of up to 4/);
  // P2 — the N>=8 workflow-suggestion clause rides along.
  assert.match(packet.text, /save it as a forEach workflow/);
  // The static reminder must be GONE when the directive is offered.
  assert.ok(!/Parallelism reminder:/.test(packet.text), 'static reminder replaced by directive');
});

test('packet uses the SOFT hint for 3<=N<8 (no imperative, no workflow clause)', () => {
  const packet = buildAgentContextPacket(
    'Research these 4 prospects.',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'sess-chat-soft' },
  );
  assert.equal(packet.multiItem.offered, true);
  assert.equal(packet.multiItem.recommendedWorkerWaveSize, 4);
  assert.match(packet.text, /Fan-out hint: this turn names 4 independent same-shape/);
  assert.match(packet.text, /parallel waves of up to 4/);
  assert.ok(!/Do NOT serialize/.test(packet.text), 'small-N must not be imperative');
  assert.ok(!/save it as a forEach workflow/.test(packet.text), 'small-N must not offer a workflow');
});

test('packet makes small-N fan-out imperative when the user explicitly asks for parallel same-shape work', () => {
  const packet = buildAgentContextPacket(
    'For EACH of these 5 fictional firms, produce the same-shape SEO snapshot and parallelize it.',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'sess-chat-explicit-parallel' },
  );
  assert.equal(packet.multiItem.offered, true);
  assert.equal(packet.multiItem.itemCount, 5);
  assert.match(packet.text, /Fan-out directive: this turn names 5 independent same-shape/);
  assert.match(packet.text, /Do NOT serialize/);
  assert.match(packet.text, /do not collapse this into one aggregate program or one inline batch/);
  assert.ok(!/save it as a forEach workflow/.test(packet.text), 'explicit small-N fan-out does not imply workflow offer');
});

test('repair-loop policy is scoped to repair work and cannot globally block unrelated fan-out', () => {
  mkdirSync(path.join(TMP_HOME, 'workflows', 'runs'), { recursive: true });
  writeFileSync(path.join(TMP_HOME, 'workflows', 'runs', 'repair-loop-run.json'), JSON.stringify({
    id: 'repair-loop-run',
    workflow: 'repair-loop-wf',
    status: 'completed_with_errors',
    createdAt: '2026-06-26T11:00:00.000Z',
    startedAt: '2026-06-26T11:00:10.000Z',
    finishedAt: '2026-06-26T11:03:10.000Z',
    needsAttention: true,
    selfHealAttempt: 1,
    goalAttempt: 1,
    goalOutcome: 'escalate',
    goalReason: 'output contract still failed',
  }), 'utf-8');
  __resetAgentSystemGuidanceCacheForTests();

  const packet = buildAgentContextPacket(
    'Research these 10 prospects and capture each firm’s SEO posture.',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'sess-chat-policy-block' },
  );

  assert.equal(packet.agentSystem.policy, null, 'unrelated new work does not inherit a global workflow repair block');
  assert.equal(packet.multiItem.detected, true);
  assert.equal(packet.multiItem.offered, true);
  assert.equal(packet.multiItem.blockedByPolicy, false);
  assert.match(packet.text, /Fan-out directive: this turn names 10 independent same-shape/);
  assert.doesNotMatch(packet.text, /Fan-out constrained by coordination policy/);

  const negatedRetryPacket = buildAgentContextPacket(
    'Write one exact Google Sheets range and read it back. Do not retry an ambiguous or failed write.',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'sess-chat-policy-negated-retry' },
  );
  assert.equal(
    negatedRetryPacket.agentSystem.policy,
    null,
    'a prohibition against retries is not a request to resume the broken workflow loop',
  );
  assert.equal(negatedRetryPacket.agentSystem.injected, false);
  assert.doesNotMatch(negatedRetryPacket.text, /AGENT SYSTEM GUIDANCE/);

  const genericForEachPacket = buildAgentContextPacket(
    'For each of alpha, beta, and gamma, run one worker call in parallel and return its output.',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'sess-chat-policy-generic-for-each' },
  );
  assert.equal(
    genericForEachPacket.agentSystem.policy,
    null,
    'generic per-item execution is not a request to resume a broken workflow loop',
  );
  assert.equal(
    genericForEachPacket.agentSystem.recommendations.every((recommendation) => recommendation.kind === 'swarm'),
    true,
    'explicit parallel-worker language may receive swarm guidance, but not unrelated loop guidance',
  );

  const repairPacket = buildAgentContextPacket(
    'Retry the failed workflow loop: research these 10 prospects after repairing its verifier.',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'sess-chat-policy-repair' },
  );
  assert.equal(repairPacket.agentSystem.policy?.mode, 'repair-loop');
  assert.equal(repairPacket.agentSystem.policy?.fanoutPosture, 'block');
  assert.equal(repairPacket.multiItem.blockedByPolicy, true);
  assert.match(repairPacket.text, /Fan-out constrained by coordination policy/);

  const ordinaryRunPacket = buildAgentContextPacket(
    'Run the existing workflow named social-manager now and rely on its automatic report-back.',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'sess-chat-ordinary-workflow-run' },
  );
  assert.equal(ordinaryRunPacket.agentSystem.policy, null, 'ordinary workflow execution never inherits unrelated repair policy');
  assert.equal(ordinaryRunPacket.agentSystem.injected, false, 'old loop failures are not injected into a healthy workflow dispatch');
  assert.doesNotMatch(ordinaryRunPacket.text, /AGENT SYSTEM GUIDANCE|repair-loop|replan instead of retrying/i);
});

test('packet keeps the static line (no directive) for NON-chat sessions even when multi-item', () => {
  for (const kind of ['workflow', 'execution', 'agent']) {
    const packet = buildAgentContextPacket(
      'Research these 10 prospects.',
      NO_MEMORY,
      { sessionKind: kind, sessionId: `${kind === 'workflow' ? 'workflow:run-x:step' : kind}-sess` },
    );
    assert.equal(packet.multiItem.detected, true, `${kind}: still detects`);
    assert.equal(packet.multiItem.offered, false, `${kind}: directive suppressed`);
    assert.match(packet.text, /Parallelism reminder:/, `${kind}: static line preserved (zero-regression)`);
    assert.ok(!/Fan-out directive/.test(packet.text), `${kind}: no directive`);
    if (kind === 'workflow') {
      assert.deepEqual(packet.skills, [], 'a pinned workflow node receives no ambient skill candidates');
      assert.deepEqual(packet.workflows, [], 'a pinned workflow node receives no ambient workflow candidates');
      assert.equal(packet.prospective.injected, false, 'proactive chat intentions do not contaminate a constrained workflow node');
      assert.deepEqual(packet.mcp, [], 'workflow nodes rely on their authored tool scope instead of probing unrelated MCP health');
    }
  }
});

test('packet keeps the static line for a single-item / no-count request', () => {
  const packet = buildAgentContextPacket(
    'Audit this law firm’s website and summarize the findings.',
    NO_MEMORY,
    { sessionKind: 'chat', sessionId: 'sess-chat-single' },
  );
  assert.equal(packet.multiItem.detected, false);
  assert.match(packet.text, /Parallelism reminder:/);
});

// Provider-access facts (live 2026-07-24): a run filesystem-hunted for an
// OpenAI key that does not exist instead of using the OAuth lane it had.
test('context packet states provider-access facts: no raw key -> OAuth-lane-only + BYO labels + no-search directive', async () => {
  const { buildAgentContextPacket } = await import('./context-packet.js');
  const prevKey = process.env.OPENAI_API_KEY;
  const prevByo = process.env.BYO_PROVIDERS;
  delete process.env.OPENAI_API_KEY;
  process.env.BYO_PROVIDERS = JSON.stringify([
    { id: 'together-ai', label: 'Together AI' },
    { id: 'moonshot', label: 'Moonshot (Kimi)' },
  ]);
  try {
    const packet = buildAgentContextPacket('check chatgpt visibility for 120 accounts and build a sheet', {
      enabled: false, hitCount: 0, injected: false,
    } as never, { sessionKind: 'chat' });
    assert.match(packet.text, /OAuth model lane ONLY — no raw API key is configured/);
    assert.match(packet.text, /Together AI, Moonshot \(Kimi\)/);
    assert.match(packet.text, /do NOT search the filesystem/);

    process.env.OPENAI_API_KEY = 'sk-test-shape-only';
    const withKey = buildAgentContextPacket('same ask again', {
      enabled: false, hitCount: 0, injected: false,
    } as never, { sessionKind: 'chat' });
    assert.match(withKey.text, /raw API key configured/);
    assert.ok(!withKey.text.includes('sk-test-shape-only'), 'key VALUES never appear in context');

    // Live 2026-07-24: the key lived in the SECRETS VAULT (embeddings/voice)
    // while the env was empty — an env-only check stated a falsehood. The
    // card must read the real accessor (vault first).
    delete process.env.OPENAI_API_KEY;
    const { writeFileSync: writeVault, mkdirSync: mkVault } = await import('node:fs');
    const vaultDir = path.join(process.env.CLEMENTINE_HOME ?? '', 'state');
    mkVault(vaultDir, { recursive: true });
    const vaultPath = path.join(vaultDir, 'secrets-vault.json');
    writeVault(vaultPath, JSON.stringify({ version: 'v1', entries: { openai_api_key: 'sk-vault-shape-only' } }), 'utf-8');
    try {
      const vaultBacked = buildAgentContextPacket('same ask once more', {
        enabled: false, hitCount: 0, injected: false,
      } as never, { sessionKind: 'chat' });
      assert.match(vaultBacked.text, /raw API key configured/, 'vault-held key is KNOWN to the card');
      assert.ok(!vaultBacked.text.includes('sk-vault-shape-only'), 'vault key VALUES never appear in context');
    } finally {
      const { rmSync: rmVault } = await import('node:fs');
      try { rmVault(vaultPath); } catch { /* best effort */ }
    }
  } finally {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    if (prevByo === undefined) delete process.env.BYO_PROVIDERS; else process.env.BYO_PROVIDERS = prevByo;
  }
});
