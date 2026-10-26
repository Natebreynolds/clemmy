import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClemReplyV1Schema,
  configuredBrainSemanticPort,
  semanticModelRoleForPurpose,
  tokensFromAgentRun,
} from './configured-brain-semantic-port.js';
import type { TurnSemanticHostViewV1 } from './turn-semantic-proposal.js';

test('Clem reads an informational follow-up through the existing typed reply port without promoting it to an action', async () => {
  const calls: Array<{ purpose: string; schemaName: string; system: string; user: string }> = [];
  const port = configuredBrainSemanticPort(async (input) => {
    calls.push(input);
    return { raw: { decision: 'follow_up', instruction: null }, modelIdentity: 'controlled-follow-up-brain',
      inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  });
  const request = {
    purpose: 'clem_reply' as const,
    said: 'The controlled item is waiting on your decision.',
    facts: 'Controlled fixture: proposed for Thursday, with no decision recorded.',
    reply: 'what day is this?',
    evidenceDigest: 'controlled-follow-up-row-digest',
  };
  const result = await port.readClemReply!(request);
  assert.equal(result.decision, 'follow_up');
  assert.equal(result.evidenceDigest, request.evidenceDigest);
  assert.equal(result.modelIdentity, 'controlled-follow-up-brain');
  assert.equal(calls.length, 1, 'no additional classifier, reviewer, or fallback call');
  assert.equal(calls[0]!.purpose, 'clem_reply');
  assert.equal(calls[0]!.schemaName, 'ClemReplyV1');
  assert.deepEqual(JSON.parse(calls[0]!.user), { said: request.said, facts: request.facts, reply: request.reply });
  assert.match(calls[0]!.system, /follow_up/, 'the typed disposition is part of the model contract');
  assert.equal(semanticModelRoleForPurpose('clem_reply'), 'brain');
});

test('the informational-reply schema keeps instruction required and nullable and rejects extra failed-open claims', () => {
  assert.equal(ClemReplyV1Schema.safeParse({ decision: 'done' }).success, false);
  assert.equal(ClemReplyV1Schema.safeParse({ decision: 'done', instruction: null }).success, true);
  assert.equal(ClemReplyV1Schema.safeParse({ decision: 'follow_up', instruction: null }).success, true);
  assert.equal(ClemReplyV1Schema.safeParse({ decision: 'follow_up' }).success, false);
  assert.equal(ClemReplyV1Schema.safeParse({ decision: 'follow_up', instruction: 42 }).success, false);
  assert.equal(ClemReplyV1Schema.safeParse({ decision: 'follow_up', instruction: null, failedOpen: true }).success, false);
});

test('reading what a message asks is a quick check, write judgment stays on the judge, and Clem\'s own voice stays on the brain', () => {
  assert.equal(semanticModelRoleForPurpose('turn_semantics'), 'quick');
  assert.equal(semanticModelRoleForPurpose('calendar_read_operation'), 'quick');
  assert.equal(semanticModelRoleForPurpose('turn_semantics_effect_judge'), 'judge');
  assert.equal(semanticModelRoleForPurpose('turn_semantics_plan_grounding'), 'judge');
  assert.equal(semanticModelRoleForPurpose('clem_voice'), 'brain');
  assert.equal(semanticModelRoleForPurpose('noticing_proposal'), 'brain');
});

test('configured brain receives bounded host capability descriptors, not only IDs', async () => {
  let seen: unknown;
  const port = configuredBrainSemanticPort(async (input) => {
    seen = JSON.parse(input.user);
    return { raw: { version: 1 }, modelIdentity: 'test', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  });
  const host: TurnSemanticHostViewV1 = {
    source: {
      sessionId: 'sess-desc',
      sourceUserSeq: 1,
      inputHash: 'a'.repeat(64),
      audienceHash: 'b'.repeat(64),
    },
    policyRevision: 'c'.repeat(64),
    resumableGoals: [],
    openQuestions: [],
    catalog: {
      capabilityIds: new Set(['cap:host_create:destination']),
      workflowIds: new Set(),
      capabilities: [{
        id: 'cap:host_create:destination',
        effect: 'external_write',
        purpose: 'persist_collection',
        acceptedInputKinds: ['records'],
        producedOutputKinds: ['created_resource'],
        applicableDeliverableKinds: ['created_resource'],
        inputShape: 'records',
        outputShape: 'created_resource',
        outputKind: 'created_resource',
        deliverableKind: 'created_resource',
        destinationPosture: 'create_new',
        evidenceKinds: ['receipt', 'readback'],
        handleRequired: true,
        readbackRequired: true,
        accountScope: 'host:production',
        manifestDigest: 'd'.repeat(64),
      }],
    },
  };
  await port.interpret({
    purpose: 'turn_semantics',
    host,
    acceptedText: 'unused',
  });
  const payload = seen as { host: { capabilities: Array<{ id: string; purpose: string }>; capabilityIds: string[] } };
  assert.deepEqual(payload.host.capabilityIds, ['cap:host_create:destination']);
  assert.equal(payload.host.capabilities[0]?.purpose, 'persist_collection');
  assert.equal(payload.host.capabilities[0]?.id, 'cap:host_create:destination');
});

test('the interpreter is told that an affirmative accepts the one recommended option', async () => {
  // Live 2026-09-14: "Yes" to "…invite Adam (recommended), or create it
  // directly…?" was ruled ambiguous and the identical question was re-asked
  // with zero work. The model reasons about the wording; the host does not
  // pattern-match "yes" versus "heck yeah let's do it".
  let system = '';
  const port = configuredBrainSemanticPort(async (input) => {
    system = input.system;
    return { raw: { version: 1 }, modelIdentity: 'test', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  });
  await port.interpret({
    purpose: 'turn_semantics',
    host: {
      source: { sessionId: 'sess-rec', sourceUserSeq: 1, inputHash: 'a'.repeat(64), audienceHash: 'b'.repeat(64) },
      policyRevision: 'c'.repeat(64),
      resumableGoals: [],
      openQuestions: [],
      catalog: { capabilityIds: new Set(), workflowIds: new Set(), capabilities: [] },
    },
    acceptedText: 'Yes',
  });
  assert.match(system, /exactly one visible option is marked recommended or default/);
  assert.match(system, /any affirmative wording — selects that option/);
  assert.match(system, /more than one is marked, an affirmative alone stays ambiguous/);
});

test('the account judge is told a chosen option may imply the account even when the question was not about accounts', async () => {
  // Live 2026-09-14: the user chose "Send Adam an invite from my Scorpion
  // calendar"; the judge still could not entail the scorpion-labeled account
  // and the host made the model ask "which Outlook account should send?".
  let system = '';
  const port = configuredBrainSemanticPort(async (input) => {
    system = input.system;
    return { raw: { verdict: 'uncertain', proposalDigest: 'f'.repeat(64) }, modelIdentity: 'test', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  });
  await port.judgeAccountSelection?.({
    purpose: 'turn_semantics_account_selection',
    mode: 'explicit_selection',
    sessionId: 'sess-acct',
    sourceUserSeq: 2,
    acceptedText: 'send him a meeting invite',
    sourceQuote: 'send him a meeting invite',
    toolkit: 'outlook',
    accountIdentity: 'owner@example.com',
    accountLabel: 'scorpion',
    establishedSource: null,
    interveningAcceptedSources: [],
    clarification: {
      question: 'Create it directly, or send an invite from your Scorpion calendar?',
      options: ['Create directly (recommended)', 'Send an invite from my Scorpion calendar'],
      answer: 'send him a meeting invite',
      selectedOption: 'Send an invite from my Scorpion calendar',
    },
    proposalDigest: 'f'.repeat(64),
  });
  assert.match(system, /it may be about something else whose options name or imply an account/);
  assert.match(system, /When selectedOption is supplied, the host has already recorded that option as the user's choice/);
  assert.match(system, /identifies the supplied account by its address, label, domain, or workspace name, return entailed/);
  assert.match(system, /When rememberedDefault is supplied in current_source_default mode/);
  assert.match(system, /A remembered preference never overrides current wording/);
  // Wording that selects the very account the host remembered is agreement,
  // not an explicit selection to bounce back as uncertain.
  assert.match(system, /except when rememberedDefault names that same identity/);
  assert.match(system, /or when they select this same remembered account/);
});

test('tokensFromAgentRun reads real Agents SDK and wire usage instead of reporting zero', () => {
  assert.deepEqual(tokensFromAgentRun({
    state: { usage: { inputTokens: 2100, outputTokens: 854 } },
  }), { inputTokens: 2100, outputTokens: 854 });
  assert.deepEqual(tokensFromAgentRun({
    rawResponses: [
      { usage: { input_tokens: 1000, output_tokens: 200 } },
      { usage: { input_tokens: 1100, output_tokens: 654 } },
    ],
  }), { inputTokens: 2100, outputTokens: 854 });
  assert.deepEqual(tokensFromAgentRun({
    runContext: { usage: { requestUsageEntries: [{ inputTokens: 2954, outputTokens: 0 }] } },
  }), { inputTokens: 2954, outputTokens: 0 });
});


test('semantic usage preserves cached inputs across SDK detail rows without counting the aggregate twice', () => {
  const usage = { inputTokens: 100, outputTokens: 10,
    inputTokensDetails: [{ cached_tokens: 15 }, { cacheReadInputTokens: 25 }],
    requestUsageEntries: [{ inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 }] };
  assert.deepEqual(tokensFromAgentRun({ state: { usage }, rawResponses: [{ usage }] }),
    { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 });
  assert.deepEqual(tokensFromAgentRun({ rawResponses: [
    { usage: { input_tokens: 50, output_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } } },
    { usage: { inputTokens: 50, outputTokens: 5, inputTokensDetails: [{ cached_tokens: 20 }] } },
  ] }), { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 });
});


test('approved action wording forwards host lifetime controls without putting them in model input', async () => {
  const controller = new AbortController(); const checkActive = () => {};
  const deadlineAt = Date.now() + 1_000; let called = 0;
  const port = configuredBrainSemanticPort(async input => {
    called++;
    assert.equal(input.signal, controller.signal); assert.equal(input.deadlineAt, deadlineAt);
    assert.equal(input.checkActive, checkActive);
    assert.deepEqual(Object.keys(JSON.parse(input.user)).sort(), ['action', 'asked', 'happened']);
    assert.match(input.system, /may have landed/);
    assert.match(input.system, /never propose a retry, resend or replacement write/);
    assert.match(input.system, /Only never_started proves that nothing ran or changed/);
    return { raw: { message: 'I cannot confirm the result. Shall I check it first?', choices: null },
      modelIdentity: 'controlled', inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  });
  const result = await port.voiceApprovedActionEnding!({ purpose: 'clem_voice', signal: controller.signal,
    deadlineAt, checkActive, asked: 'Controlled owner request.',
    action: { title: 'Controlled action', kind: 'connected_app_change', detail: 'Controlled detail.' },
    happened: { verdict: 'uncertain', reply: '' }, evidenceDigest: 'a'.repeat(64) });
  assert.equal(called, 1); assert.equal(result.evidenceDigest, 'a'.repeat(64));
  assert.match(result.message!, /cannot confirm/);
});
