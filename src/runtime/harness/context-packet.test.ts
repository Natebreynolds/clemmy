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

const { buildAgentContextPacket, detectMultiItemIntent, detectMultiItemIntentFromConversation } = await import('./context-packet.js');
const { __resetAgentSystemGuidanceCacheForTests } = await import('../agent-system-guidance.js');
const capabilityHealth = await import('./capability-health.js');

test.after(() => {
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

test('packet blocks fan-out directive when coordination policy is in repair mode', () => {
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

  assert.equal(packet.agentSystem.policy?.mode, 'repair-loop');
  assert.equal(packet.agentSystem.policy?.fanoutPosture, 'block');
  assert.equal(packet.multiItem.detected, true);
  assert.equal(packet.multiItem.offered, false);
  assert.equal(packet.multiItem.blockedByPolicy, true);
  assert.equal(packet.multiItem.fanoutPosture, 'block');
  assert.equal(packet.multiItem.recommendedWorkerWaveSize, 0);
  assert.match(packet.text, /Fan-out constrained by coordination policy/);
  assert.match(packet.text, /wave size 0/);
  assert.doesNotMatch(packet.text, /Fan-out directive: this turn names 10 independent same-shape/);
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
    assert.match(packet.text, /OAuth model lane ONLY — no raw API key exists/);
    assert.match(packet.text, /Together AI, Moonshot \(Kimi\)/);
    assert.match(packet.text, /do NOT search the filesystem/);

    process.env.OPENAI_API_KEY = 'sk-test-shape-only';
    const withKey = buildAgentContextPacket('same ask again', {
      enabled: false, hitCount: 0, injected: false,
    } as never, { sessionKind: 'chat' });
    assert.match(withKey.text, /raw API key configured/);
    assert.ok(!withKey.text.includes('sk-test-shape-only'), 'key VALUES never appear in context');
  } finally {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    if (prevByo === undefined) delete process.env.BYO_PROVIDERS; else process.env.BYO_PROVIDERS = prevByo;
  }
});
