import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeRootSessionId, parseClaudeAssistantUsage, updateClaudeMeta } from './parse-claude.js';
import { parseCodexTokenUsage } from './parse-codex.js';
import { clementineRootSessionId, parseClementineUsage } from './parse-clementine.js';
import { acceptCall, armTrial, bindLane, createTrial, dedupeCalls, rollupLane, sealLane, verdictFor } from './trial.js';
import type { CanonicalCall } from './types.js';

const claudeUsage = {
  type: 'assistant',
  timestamp: '2026-09-18T12:00:00.000Z',
  sessionId: 'sess-native',
  entrypoint: 'cli',
  message: {
    id: 'msg_1',
    model: 'claude-sonnet-5',
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 50,
      output_tokens: 4,
      output_tokens_details: { thinking_tokens: 1 },
    },
  },
};

test('Claude assistant usage is exclusive and dedupes by message.id', () => {
  const meta = updateClaudeMeta(claudeUsage, {});
  const a = parseClaudeAssistantUsage(claudeUsage, meta, {
    source: 'claude-code', rootSessionId: 'sess-native', skipSdk: true,
  });
  const later = parseClaudeAssistantUsage({
    ...claudeUsage,
    timestamp: '2026-09-18T12:00:01.000Z',
    message: { ...claudeUsage.message, usage: { ...claudeUsage.message.usage, output_tokens: 9 } },
  }, meta, { source: 'claude-code', rootSessionId: 'sess-native', skipSdk: true });
  assert.ok(a);
  assert.equal(a.uncachedWorkTokens, 2 + 4 + 1);
  const unique = dedupeCalls([a, later!]);
  assert.equal(unique.length, 1);
  assert.equal(unique[0].outputTokens, 9);
});

test('sdk-cli is excluded from the Claude Code lane', () => {
  const line = { ...claudeUsage, entrypoint: 'sdk-cli', promptSource: 'sdk' };
  const meta = updateClaudeMeta(line, {});
  const call = parseClaudeAssistantUsage(line, meta, {
    source: 'claude-code', rootSessionId: 'sess-sdk', skipSdk: true,
  });
  assert.equal(call, null);
});

test('Cowork audit.jsonl uses the same exclusive parser and keeps sdk rows (skipSdk false)', () => {
  const line = {
    type: 'assistant',
    _audit_timestamp: '2026-04-01T17:21:29.835Z',
    session_id: '431c1ce2',
    message: {
      id: 'msg_cowork',
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 29047,
        cache_read_input_tokens: 8201,
        output_tokens: 9,
      },
    },
  };
  const call = parseClaudeAssistantUsage(line, {}, {
    source: 'cowork', rootSessionId: 'c8060d9f', skipSdk: false,
  });
  assert.ok(call);
  assert.equal(call.source, 'cowork');
  assert.equal(call.uncachedWorkTokens, 12);
  assert.equal(call.rootSessionId, '431c1ce2');
});

test('claudeRootSessionId prefers parent folder for subagents and local_ for cowork', () => {
  assert.equal(
    claudeRootSessionId('/x/projects/foo/347a498f-6255-4337-9f55-205df95a99a5.jsonl'),
    '347a498f-6255-4337-9f55-205df95a99a5',
  );
  assert.equal(
    claudeRootSessionId('/x/347a498f-6255-4337-9f55-205df95a99a5/subagents/agent-abc.jsonl'),
    '347a498f-6255-4337-9f55-205df95a99a5',
  );
  assert.equal(
    claudeRootSessionId('/Claude/local-agent-mode-sessions/a/b/local_c8060d9f-bf50/audit.jsonl'),
    'c8060d9f-bf50',
  );
});

test('Claude sidechain usage rolls up to the parent sessionId, not the agent file name', () => {
  const line = {
    type: 'assistant',
    isSidechain: true,
    agentId: 'a3395312c1a828e96',
    timestamp: '2026-08-24T03:29:35.105Z',
    sessionId: '347a498f-6255-4337-9f55-205df95a99a5',
    entrypoint: 'cli',
    message: {
      id: 'msg_sub',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 8 },
    },
  };
  const call = parseClaudeAssistantUsage(line, {}, {
    source: 'claude-code',
    rootSessionId: 'agent-a3395312c1a828e96',
    skipSdk: true,
    fromSubagentPath: true,
  });
  assert.ok(call);
  assert.equal(call.rootSessionId, '347a498f-6255-4337-9f55-205df95a99a5');
  assert.equal(call.isSubagent, true);
  assert.equal(call.model, 'claude-haiku-4-5');
});

test('Codex subagent thread rolls up to session_id and keeps per-call usage', () => {
  const line = {
    timestamp: '2026-09-06T03:43:50.781Z',
    type: 'token_usage_record',
    payload: {
      thread_id: 'thread-sub',
      session_id: 'session-parent',
      response_id: 'resp_sub',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 80,
        output_tokens: 10,
        total_tokens: 110,
      },
      thread_token_usage: { input_tokens: 999999, total_tokens: 1000000 },
    },
  };
  const call = parseCodexTokenUsage(line, { model: 'gpt-5.6-terra', isSubagent: true, agentId: 'Goodall' }, 'rollout-sub');
  assert.ok(call);
  assert.equal(call.rootSessionId, 'session-parent');
  assert.equal(call.sessionId, 'thread-sub');
  assert.equal(call.isSubagent, true);
  assert.equal(call.model, 'gpt-5.6-terra');
  assert.equal(call.uncachedWorkTokens, 30);
});

test('Codex uses per-call usage, not thread totals', () => {
  const line = {
    timestamp: '2026-09-06T03:43:50.781Z',
    type: 'token_usage_record',
    payload: {
      thread_id: 'thread-1',
      response_id: 'resp_1',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 80,
        cache_write_input_tokens: 0,
        output_tokens: 10,
        reasoning_output_tokens: 0,
        total_tokens: 110,
      },
      thread_token_usage: {
        input_tokens: 999999,
        cached_input_tokens: 1,
        output_tokens: 1,
        total_tokens: 1000000,
      },
    },
  };
  const call = parseCodexTokenUsage(line, {}, 'thread-1');
  assert.ok(call);
  assert.equal(call.uncachedWorkTokens, 110 - 80);
  assert.ok(call.uncachedWorkTokens < 1000);
});

test('Clementine chat row uses stored canonical; workflow is rejected by trial bind', () => {
  const chat = parseClementineUsage({
    at: '2026-09-18T12:00:00.000Z',
    source: 'sess-clem',
    kind: 'chat',
    model: 'gpt-5.6-terra',
    cacheDialect: 'inclusive',
    trace: { brain: 'codex' },
    canonical: { certified: true, promptTokens: 1000, cachedReadTokens: 900, uncachedWorkTokens: 150 },
    inputTokens: 1000,
    cachedInputTokens: 900,
    outputTokens: 50,
    totalTokens: 1050,
    responseId: 'resp_clem',
    promptComponents: { instructions: 400, tools: 500 },
  });
  const workflow = parseClementineUsage({
    at: '2026-09-18T12:00:01.000Z',
    source: 'workflow:abc:step',
    kind: 'workflow',
    model: 'gpt-5.6-terra',
    trace: { brain: 'codex' },
    canonical: { certified: true, promptTokens: 10, cachedReadTokens: 0, uncachedWorkTokens: 9999 },
    inputTokens: 10,
    outputTokens: 1,
    responseId: 'resp_wf',
  });
  assert.ok(chat);
  assert.equal(chat.uncachedWorkTokens, 150);
  assert.equal(clementineRootSessionId('workflow:trigger-abc:wrap_up', 'trigger-abc'), 'run:trigger-abc');
  const wfParsed = parseClementineUsage({
    at: '2026-09-18T12:00:01.000Z',
    source: 'workflow:trigger-abc:wrap_up',
    kind: 'workflow',
    model: 'gpt-5.6-luna',
    runId: 'trigger-abc',
    stepId: 'wrap_up',
    trace: { brain: 'codex' },
    canonical: { certified: true, promptTokens: 10, cachedReadTokens: 0, uncachedWorkTokens: 11 },
    inputTokens: 10,
    outputTokens: 1,
    responseId: 'resp_step',
  });
  assert.equal(wfParsed?.rootSessionId, 'run:trigger-abc');
  assert.equal(wfParsed?.isSubagent, true);
  let trial = createTrial({ name: 't', pairing: 'codex', nativeSource: 'codex', now: new Date('2026-09-18T11:00:00Z') });
  trial = armTrial(trial, '2026-09-18T11:59:00.000Z');
  trial = bindLane(trial, 'clementine', 'sess-clem');
  trial = bindLane(trial, 'native', 'thread-1');
  assert.equal(acceptCall(trial, chat), true);
  assert.equal(acceptCall(trial, workflow!), false);
});

function fakeCall(partial: Partial<CanonicalCall> & Pick<CanonicalCall, 'id' | 'lane' | 'source' | 'sessionId'>): CanonicalCall {
  return {
    at: '2026-09-18T12:00:00.000Z',
    rootSessionId: partial.sessionId,
    model: 'gpt-5.6-terra',
    inputTokens: 100,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    promptTokens: 100,
    uncachedWorkTokens: 110,
    hitRate: 0,
    certified: true,
    ...partial,
  };
}

test('trial: only bound chat rows; seal freezes; mismatched models incomparable', () => {
  let trial = createTrial({ name: 'seo', pairing: 'codex', nativeSource: 'codex', now: new Date('2026-09-18T11:00:00Z') });
  trial = armTrial(trial, '2026-09-18T12:00:00.000Z');
  trial = bindLane(trial, 'native', 'n1');
  trial = bindLane(trial, 'clementine', 'c1');
  const nativeCall = fakeCall({
    id: 'n', lane: 'native', source: 'codex', sessionId: 'n1',
    model: 'gpt-5.6-terra', uncachedWorkTokens: 200, at: '2026-09-18T12:01:00.000Z',
  });
  const clemCall = fakeCall({
    id: 'c', lane: 'clementine', source: 'clementine', sessionId: 'c1',
    model: 'gpt-5.6-terra', brain: 'codex', kind: 'chat',
    uncachedWorkTokens: 80, at: '2026-09-18T12:01:01.000Z',
  });
  assert.equal(acceptCall(trial, nativeCall), true);
  assert.equal(acceptCall(trial, clemCall), true);
  trial = sealLane(trial, 'native', '2026-09-18T12:02:00.000Z');
  trial = sealLane(trial, 'clementine', '2026-09-18T12:02:00.000Z');
  const late = fakeCall({
    id: 'late', lane: 'native', source: 'codex', sessionId: 'n1',
    at: '2026-09-18T12:03:00.000Z', uncachedWorkTokens: 9999,
  });
  assert.equal(acceptCall(trial, late), false);
  const native = rollupLane([nativeCall]);
  const clem = rollupLane([clemCall]);
  const v = verdictFor(trial, native, clem);
  assert.equal(v.kind, 'clem-less');
  assert.equal(v.modelsMatch, true);
  assert.ok(v.sentence.includes('40%'));

  const other = rollupLane([fakeCall({
    id: 'x', lane: 'clementine', source: 'clementine', sessionId: 'c1',
    model: 'gpt-5.6-luna', uncachedWorkTokens: 80,
  })]);
  const bad = verdictFor(trial, native, other);
  assert.equal(bad.kind, 'incomparable');
});

test('warm start flags a first call with high cache hit', () => {
  const cold = rollupLane([fakeCall({
    id: '1', lane: 'native', source: 'codex', sessionId: 'n',
    hitRate: 0, uncachedWorkTokens: 10,
  })]);
  const warm = rollupLane([fakeCall({
    id: '2', lane: 'native', source: 'codex', sessionId: 'n',
    hitRate: 0.9, uncachedWorkTokens: 10,
  })]);
  assert.equal(cold.warmStart, false);
  assert.equal(warm.warmStart, true);
});

test('Cowork cliSessionId matching a Claude Code path is a different root unless bound', () => {
  const coworkId = claudeRootSessionId('/Claude/local_abc-def/audit.jsonl');
  const codeId = claudeRootSessionId('/.claude/projects/foo/abc-def.jsonl');
  assert.equal(coworkId, 'abc-def');
  assert.equal(codeId, 'abc-def');
  let trial = createTrial({ name: 't', pairing: 'claude', nativeSource: 'cowork', now: new Date('2026-09-18T11:00:00Z') });
  trial = armTrial(trial, '2026-09-18T11:00:00.000Z');
  trial = bindLane(trial, 'native', coworkId);
  const codeCall = fakeCall({
    id: 'code', lane: 'native', source: 'claude-code', sessionId: codeId,
    at: '2026-09-18T12:00:00.000Z',
  });
  assert.equal(acceptCall(trial, codeCall), false, 'wrong native source cannot inflate Cowork');
});
