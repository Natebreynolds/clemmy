/** Run: npx tsx --test src/runtime/harness/preflight-conversation.test.ts */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-preflight-conversation-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_CONFIRM_BEAT = 'on';

import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const {
  appendConversationPreambleOnce,
  appendEvent,
  closeEventLog,
  createSession,
  listEvents,
  resetEventLog,
} = await import('./eventlog.js');
const {
  classifyTurnPreflight,
  recordTurnPreflightDecision,
} = await import('./turn-control.js');
const {
  DEFAULT_PREFLIGHT_CONVERSATION_AUTHOR_TIMEOUT_MS,
  createAgentsPreflightConversationPort,
  preflightConversationPrompt,
  publishPreflightConversation,
  startSettledPreflightConversationAuthor,
} = await import('./preflight-conversation.js');
const { presentationEventFromCompletionData } = await import('./turn-outcome.js');

beforeEach(() => resetEventLog());

test('the production voice pass has a bounded pre-execution latency ceiling', () => {
  assert.ok(DEFAULT_PREFLIGHT_CONVERSATION_AUTHOR_TIMEOUT_MS <= 6_000);
});

after(() => {
  closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function alignedFixture(id: string) {
  createSession({ id, kind: 'chat', channel: 'desktop', title: id });
  const objective = 'Create a Google Sheet with the five Ventura restaurants, then email me the link.';
  const source = appendEvent({
    sessionId: id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: objective },
  });
  const decision = classifyTurnPreflight({
    message: objective,
    sessionId: id,
    sessionKind: 'chat',
    sourceUserSeq: source.seq,
  });
  assert.equal(decision.phase, 'align');
  recordTurnPreflightDecision(id, decision, source.seq);
  return { objective, source, decision };
}

function identityOf(fixture: ReturnType<typeof alignedFixture>) {
  return {
    sessionId: fixture.source.sessionId,
    turn: fixture.source.turn,
    sourceUserSeq: fixture.source.seq,
  };
}

test('the one-turn no-tool author receives a discriminated OPEN contract', async () => {
  const seen: { tools?: number; maxTurns?: number; prompt?: string; instructions?: string } = {};
  const port = createAgentsPreflightConversationPort({
    model: 'gpt-5.5-codex',
    runner: {
      async run(agent, prompt, options) {
        seen.tools = agent.tools.length;
        seen.maxTurns = options.maxTurns;
        seen.prompt = prompt;
        seen.instructions = String(agent.instructions);
        return { finalOutput: 'Which Google account should own the sheet?' };
      },
    },
  });
  const fixture = alignedFixture('preflight-open-author');
  const text = await port.render({
    version: 1,
    kind: 'ask',
    objective: fixture.objective,
    decision: fixture.decision,
    conversationContext: 'Earlier Ventura work exists, but it is historical only.',
    memoryContext: 'The user prefers one email after the sheet is verified.',
    capabilityContext: 'Google Sheets and email are connected.',
    openness: { open: ['which Google account should own the new sheet'] },
  });
  assert.equal(seen.tools, 0);
  assert.equal(seen.maxTurns, 1);
  assert.match(seen.prompt ?? '', /Load-bearing dimensions independently found OPEN/);
  assert.match(seen.prompt ?? '', /which Google account/);
  assert.match(seen.instructions ?? '', /Ask exactly ONE concrete question/);
  assert.match(seen.instructions ?? '', /Do not ask for generic permission to begin/i);
  assert.equal(text, 'Which Google account should own the sheet?');
});

test('the one-turn no-tool author receives a distinct SETTLED proceed contract', async () => {
  const seen: { prompt?: string; instructions?: string } = {};
  const port = createAgentsPreflightConversationPort({
    model: 'gpt-5.5-codex',
    runner: {
      async run(agent, prompt) {
        seen.prompt = prompt;
        seen.instructions = String(agent.instructions);
        assert.equal(agent.tools.length, 0);
        return { finalOutput: 'I’ll pull five Ventura restaurants with those fields, build a new sheet, and send the link once.' };
      },
    },
  });
  const fixture = alignedFixture('preflight-settled-author');
  const text = await port.render({
    version: 1,
    kind: 'proceed',
    objective: fixture.objective,
    decision: fixture.decision,
    conversationContext: '',
    memoryContext: '',
    capabilityContext: '',
    openness: null,
  });
  assert.match(seen.prompt ?? '', /Openness verdict: SETTLED/);
  assert.match(seen.prompt ?? '', /Execution follows immediately in this same turn/);
  assert.match(seen.instructions ?? '', /same-turn preamble, not a checkpoint/);
  assert.match(seen.instructions ?? '', /Do not ask a question/);
  assert.doesNotMatch(text, /\?/);
});

test('OPEN author outage safely asks for only the first bounded dimension', async () => {
  const port = createAgentsPreflightConversationPort({
    model: 'gpt-5.5-codex',
    timeoutMs: 10,
    runner: { async run() { return await new Promise<never>(() => {}); } },
  });
  const fixture = alignedFixture('preflight-open-timeout');
  const disposition = await publishPreflightConversation({
    identity: identityOf(fixture),
    decision: fixture.decision,
    openness: { open: ['which Google account owns the sheet', 'which email mailbox sends the link'] },
    port,
    transport: 'openai_agents_harness',
  });
  assert.equal(disposition.kind, 'ask');
  if (disposition.kind !== 'ask') assert.fail('OPEN must ask');
  assert.match(disposition.presentation.text, /which Google account owns the sheet/i);
  assert.doesNotMatch(disposition.presentation.text, /email mailbox/i);
  assert.equal(disposition.presentation.status, 'needs_input');
});

test('SETTLED author outage proceeds silently and publishes no terminal', async () => {
  const fixture = alignedFixture('preflight-settled-outage');
  const disposition = await publishPreflightConversation({
    identity: identityOf(fixture),
    decision: fixture.decision,
    openness: null,
    port: { async render() { throw new Error('author unavailable'); } },
    transport: 'claude_agent_sdk_brain',
  });
  assert.deepEqual(disposition, { kind: 'proceed', preamble: '' });
  assert.equal(listEvents(fixture.source.sessionId, { types: ['awaiting_user_input'] }).length, 0);
  assert.equal(listEvents(fixture.source.sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('OPEN publishes one exact-source clarification and typed needs_input terminal without confirmation options', async () => {
  const fixture = alignedFixture('preflight-open-publish');
  const disposition = await publishPreflightConversation({
    identity: identityOf(fixture),
    decision: fixture.decision,
    openness: { open: ['which Google account should own the sheet'] },
    conversationContext: 'The prior conversation was about Ventura restaurants.',
    memoryContext: 'Use the same columns as last time.',
    capabilityContext: 'The relevant Sheet and email connections are proven.',
    port: {
      async render(packet) {
        assert.equal(packet.kind, 'ask');
        assert.match(packet.conversationContext, /Ventura/);
        return 'I have the Ventura handoff in mind. Which Google account should own the new sheet?';
      },
    },
    transport: 'openai_agents_harness',
  });
  assert.equal(disposition.kind, 'ask');
  if (disposition.kind !== 'ask') assert.fail('OPEN must ask');
  assert.equal(disposition.presentation.status, 'needs_input');
  assert.equal(disposition.presentation.kind, 'question');
  assert.equal(disposition.presentation.identity.sourceUserSeq, fixture.source.seq);
  const awaiting = listEvents(fixture.source.sessionId, { types: ['awaiting_user_input'] });
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0]?.data.source, 'preflight_openness');
  assert.equal(awaiting[0]?.data.purpose, 'clarification');
  assert.equal(awaiting[0]?.data.sourceUserSeq, fixture.source.seq);
  assert.equal(awaiting[0]?.data.intentKey, fixture.decision.intentKey);
  assert.equal(awaiting[0]?.data.options, undefined);
  const terminal = listEvents(fixture.source.sessionId, { types: ['conversation_completed'] });
  assert.equal(terminal.length, 1);
  assert.equal(presentationEventFromCompletionData(terminal[0]?.data)?.status, 'needs_input');
});

test('SETTLED returns a model-authored preamble and no awaiting-input or terminal row', async () => {
  const fixture = alignedFixture('preflight-settled-proceed');
  const expected = 'I’ll use Apify for five Ventura restaurants, write name, rating, and address to a new sheet, then email its link once.';
  const disposition = await publishPreflightConversation({
    identity: identityOf(fixture),
    decision: fixture.decision,
    openness: null,
    conversationContext: 'A prior attempt failed before producing a sheet.',
    port: { async render(packet) { assert.equal(packet.kind, 'proceed'); return expected; } },
    transport: 'openai_agents_harness',
  });
  assert.deepEqual(disposition, { kind: 'proceed', preamble: expected });
  assert.equal(listEvents(fixture.source.sessionId, { types: ['awaiting_user_input'] }).length, 0);
  assert.equal(listEvents(fixture.source.sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('a prestarted SETTLED author launches immediately and publish consumes it exactly once', async () => {
  const fixture = alignedFixture('preflight-settled-prestarted');
  const expected = 'I remember the Ventura history and I’ll complete the same sheet-to-email handoff.';
  let authorCalls = 0;
  let authorStarted = false;
  let releaseAuthor!: (value: string) => void;
  const authorResult = new Promise<string>((resolve) => { releaseAuthor = resolve; });
  const port = {
    async render(packet: import('./preflight-conversation.js').PreflightConversationPacketV1) {
      authorCalls += 1;
      authorStarted = true;
      assert.equal(packet.kind, 'proceed');
      assert.match(packet.conversationContext, /prior Ventura run/);
      assert.match(packet.memoryContext, /one verified email/);
      assert.match(packet.capabilityContext, /Apify and Sheets/);
      return await authorResult;
    },
  };
  const common = {
    identity: identityOf(fixture),
    decision: fixture.decision,
    conversationContext: 'The prior Ventura run stopped before delivery.',
    memoryContext: 'The user expects one verified email.',
    capabilityContext: 'Apify and Sheets are proven.',
    port,
  };
  const settledProceedAuthor = startSettledPreflightConversationAuthor(common);
  assert.equal(authorStarted, true, 'the caller can overlap this work with the openness judge');
  const publishing = publishPreflightConversation({
    ...common,
    openness: null,
    settledProceedAuthor,
    transport: 'openai_agents_harness',
  });
  assert.equal(authorCalls, 1, 'publish must reuse, not restart, the in-flight author');
  releaseAuthor(expected);
  assert.deepEqual(await publishing, { kind: 'proceed', preamble: expected });
  assert.equal(authorCalls, 1);
});

test('OPEN discards speculative SETTLED prose and authors its distinct question with the same context', async () => {
  const fixture = alignedFixture('preflight-open-after-speculation');
  const kinds: string[] = [];
  const port = {
    async render(packet: import('./preflight-conversation.js').PreflightConversationPacketV1) {
      kinds.push(packet.kind);
      assert.match(packet.conversationContext, /prior Ventura run/);
      assert.match(packet.memoryContext, /one verified email/);
      assert.match(packet.capabilityContext, /Apify and Sheets/);
      return packet.kind === 'proceed'
        ? 'I’ll complete the prior Ventura handoff.'
        : 'Which connected Google account should own the new sheet?';
    },
  };
  const common = {
    identity: identityOf(fixture),
    decision: fixture.decision,
    conversationContext: 'The prior Ventura run stopped before delivery.',
    memoryContext: 'The user expects one verified email.',
    capabilityContext: 'Apify and Sheets are proven.',
    port,
  };
  const disposition = await publishPreflightConversation({
    ...common,
    openness: { open: ['which connected Google account owns the new sheet'] },
    settledProceedAuthor: startSettledPreflightConversationAuthor(common),
    transport: 'claude_agent_sdk_brain',
  });
  assert.equal(disposition.kind, 'ask');
  if (disposition.kind !== 'ask') assert.fail('OPEN must ask');
  assert.equal(disposition.presentation.text, 'Which connected Google account should own the new sheet?');
  assert.deepEqual(kinds, ['proceed', 'ask']);
});

test('SETTLED exact-source replay reuses the durable preamble without re-authoring', async () => {
  const fixture = alignedFixture('preflight-settled-durable-replay');
  const durableText = 'I remember the Ventura attempt and I’m continuing with the same sheet-to-email handoff.';
  let authorCalls = 0;
  const first = await publishPreflightConversation({
    identity: identityOf(fixture),
    decision: fixture.decision,
    openness: null,
    port: {
      async render() {
        authorCalls += 1;
        return durableText;
      },
    },
    transport: 'claude_agent_sdk_brain',
  });
  assert.deepEqual(first, { kind: 'proceed', preamble: durableText });
  appendConversationPreambleOnce({
    source: fixture.source,
    text: durableText,
    intentKey: fixture.decision.intentKey,
  });

  const replay = await publishPreflightConversation({
    identity: identityOf(fixture),
    decision: fixture.decision,
    openness: null,
    port: {
      async render() {
        authorCalls += 1;
        return 'A different brain authored conflicting prose.';
      },
    },
    transport: 'openai_agents_harness',
  });

  assert.deepEqual(replay, { kind: 'proceed', preamble: durableText });
  assert.equal(authorCalls, 1, 'the durable exact-source opening is the replay authority');
  assert.equal(listEvents(fixture.source.sessionId, { types: ['conversation_preamble'] }).length, 1);
});

test('a SETTLED author cannot manufacture a confirmation checkpoint', async () => {
  const fixture = alignedFixture('preflight-settled-question');
  const disposition = await publishPreflightConversation({
    identity: identityOf(fixture),
    decision: fixture.decision,
    openness: null,
    port: { async render() { return 'I have everything I need. Should I go ahead?'; } },
    transport: 'openai_agents_harness',
  });
  assert.deepEqual(disposition, { kind: 'proceed', preamble: '' });
  assert.equal(listEvents(fixture.source.sessionId, { types: ['awaiting_user_input'] }).length, 0);
  assert.equal(listEvents(fixture.source.sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('prior context is model context, not a regex-triggered canned replacement', async () => {
  const fixture = alignedFixture('preflight-prior-context');
  const authored = 'Which Google account should own the sheet?';
  const disposition = await publishPreflightConversation({
    identity: identityOf(fixture),
    decision: fixture.decision,
    openness: { open: ['which Google account should own the sheet'] },
    conversationContext: '[RELEVANT PRIOR WORK — historical only] A matching Ventura attempt exists.',
    port: { async render() { return authored; } },
    transport: 'openai_agents_harness',
  });
  assert.equal(disposition.kind, 'ask');
  if (disposition.kind !== 'ask') assert.fail('OPEN must ask');
  assert.equal(disposition.presentation.text, authored);
  assert.doesNotMatch(disposition.presentation.text, /exact request has relevant prior history/i);
});

test('OPEN publication is idempotent for the exact source and intent', async () => {
  const fixture = alignedFixture('preflight-open-idempotent');
  let authorCalls = 0;
  const input = {
    identity: identityOf(fixture),
    decision: fixture.decision,
    openness: { open: ['which Google account should own the sheet'] },
    port: { async render() { authorCalls += 1; return 'Which Google account should own the sheet?'; } },
    transport: 'openai_agents_harness' as const,
  };
  const first = await publishPreflightConversation(input);
  const second = await publishPreflightConversation(input);
  assert.equal(first.kind, 'ask');
  assert.equal(second.kind, 'ask');
  assert.equal(authorCalls, 1);
  assert.equal(listEvents(fixture.source.sessionId, { types: ['awaiting_user_input'] }).length, 1);
  assert.equal(listEvents(fixture.source.sessionId, { types: ['conversation_completed'] }).length, 1);
});

test('neither OPEN nor SETTLED can weaken the durable accepted-source anchor', async () => {
  const fixture = alignedFixture('preflight-missing-anchor-seed');
  resetEventLog();
  createSession({ id: 'preflight-missing-anchor', kind: 'chat', channel: 'desktop' });
  const source = appendEvent({
    sessionId: 'preflight-missing-anchor', turn: 1, role: 'user', type: 'user_input_received',
    data: { text: fixture.objective },
  });
  for (const openness of [null, { open: ['which Google account'] }]) {
    await assert.rejects(
      publishPreflightConversation({
        identity: { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq },
        decision: fixture.decision,
        openness,
        port: { async render() { return 'Authored text.'; } },
        transport: 'openai_agents_harness',
      }),
      /not durably anchored/,
    );
  }
  assert.equal(listEvents(source.sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('the exported prompt itself preserves the OPEN/SETTLED discrimination', () => {
  const fixture = alignedFixture('preflight-prompt-discriminant');
  const base = {
    version: 1 as const,
    objective: fixture.objective,
    decision: fixture.decision,
    conversationContext: '',
    memoryContext: '',
    capabilityContext: '',
  };
  assert.match(preflightConversationPrompt({ ...base, kind: 'ask', openness: { open: ['which account'] } }), /OPEN/);
  assert.match(preflightConversationPrompt({ ...base, kind: 'proceed', openness: null }), /SETTLED/);
});
