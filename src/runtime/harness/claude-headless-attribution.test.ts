import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { ModelRequest } from '@openai/agents-core';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-headless-attribution-'));
process.env.CLEMENTINE_HOME = home;
const transport = await import('./claude-headless-model.js');
const log = await import('./eventlog.js');
const { harnessRunContextStorage } = await import('./brackets.js');
const usageLog = await import('../usage-log.js');
const metrics = await import('../model-route-metrics.js');
const { measureAcceptedTask } = await import('../../../scripts/session-comparison.js');

const request = { input: 'Check this synthetic fixture.', tools: [], handoffs: [], outputType: 'text',
  modelSettings: {}, tracing: false } as ModelRequest;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
let command: string;
let serial = 0;

beforeEach(() => {
  mkdirSync(path.join(home, 'state'), { recursive: true });
  writeFileSync(path.join(home, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-synthetic-fixture', refreshToken: 'synthetic-fixture',
    expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'],
  }));
  transport.resetClaudeHeadlessModelCache();
  command = transport.resolveClaudeCliPath() ?? 'claude';
  transport._setHeadlessFlagSupportForTests(command, new Set(['--tools']));
});
afterEach(() => {
  transport._setHeadlessFlagSupportForTests(command, null);
  transport.resetClaudeHeadlessModelCache();
});
after(() => {
  metrics.closeModelRouteMetricsDb();
  log.closeEventLog();
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) { if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error; }
});

function mockCli(events: unknown[]): void {
  transport.setClaudeHeadlessSpawnForTest(((_command: string, args: string[]) => {
    assert.equal(args[args.indexOf('--tools') + 1], '', 'the fixture never permits CLI tools');
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.emit('close', null, 'SIGTERM'); return true; };
    child.stdin.on('finish', () => queueMicrotask(() => {
      for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
      child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
    }));
    return child;
  }) as never);
}

async function recorded(events: unknown[], streamed = false, selectedModel = 'claude-sonnet-5') {
  mockCli(events);
  const session = log.createSession({ id: `headless-review-fixture-${++serial}`, kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Review the controlled synthetic fixture.' } });
  const attempt = log.beginRunAttempt(session.id);
  log.bindRunAttemptSourceUserEvent(attempt, source.seq);
  const model = metrics.withModelRouteMetrics(new transport.ClaudeHeadlessModel(selectedModel), {
    sessionId: session.id, role: 'judge', requestedModel: selectedModel, resolvedModel: selectedModel,
    provider: 'claude', source: 'explicit',
  });
  const response = await usageLog.withModelUsageAttribution({ sessionId: session.id, sourceUserSeq: source.seq,
    attemptId: attempt.attemptId, role: 'reviewer', channel: 'judge:fixture' }, () =>
    harnessRunContextStorage.run({ sessionId: session.id, sourceUserSeq: source.seq,
      runAttemptId: attempt.attemptId, turn: 1 } as never, async () => {
      if (!streamed) return model.getResponse(request);
      let done: any;
      for await (const event of model.getStreamedResponse(request)) if (event.type === 'response_done') done = event.response;
      assert.ok(done);
      return { ...done, responseId: done.id };
    }));
  const rows = usageLog.readUsageEventsForDate().filter(row => row.source === session.id);
  assert.equal(rows.length, 1, 'one usage summary, never a manufactured physical-call inventory');
  const row = rows[0]!;
  assert.equal(row.trace?.acceptedSource, usageLog.acceptedSourceIdentity(session.id, source.seq));
  assert.equal(row.trace?.attemptId, attempt.attemptId);
  assert.equal(row.role, 'reviewer');
  const outcome = metrics.openModelRouteMetricsDb().prepare(`SELECT o.metadata_json FROM model_route_decisions d
    JOIN model_route_outcomes o ON o.decision_id = d.id WHERE d.session_id = ?`).get(session.id) as { metadata_json: string };
  assert.ok(outcome);
  const route = JSON.parse(outcome.metadata_json) as Record<string, unknown>;
  const metadata = response.providerData as Record<string, unknown>;
  assert.equal(row.responseIdScope, metadata.responseIdScope, 'the ledger preserves the adapter identity scope');
  assert.equal(row.usageScope, metadata.usageScope, 'the ledger preserves the adapter usage scope');
  assert.equal(route.responseIdScope, metadata.responseIdScope, 'the route preserves the same scope as its digest');
  assert.equal(route.usageScope, metadata.usageScope);
  assert.equal(Object.hasOwn(row, 'physicalCallCount'), false, 'a usage summary leaves physical inventory unknown');
  assert.equal(Object.hasOwn(route, 'physicalCallCount'), false);
  return { response, row, route, metadata, sessionId: session.id, sourceUserSeq: source.seq };
}

test('headless aggregate usage and completed reviewer route share one local invocation identity', async () => {
  const { response, row, route, metadata, sessionId, sourceUserSeq } = await recorded([
    { type: 'system', subtype: 'init', session_id: 'cli-session-aggregate' },
    { type: 'assistant', message: { id: 'provider-message-aggregate', model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: 'Controlled verdict.' }], usage: { input_tokens: 2, output_tokens: 1 } } },
    { type: 'result', subtype: 'success', session_id: 'cli-session-aggregate', result: 'Controlled verdict.',
      usage: { input_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 11, output_tokens: 5 } },
  ]);
  assert.equal(row.responseId, response.responseId);
  assert.equal(route.providerResponseIdDigest, hash(row.responseId!));
  assert.match(row.responseId!, /^claude-headless-/);
  assert.notEqual(row.responseId, 'provider-message-aggregate', 'an aggregate does not borrow one message identity');
  assert.notEqual(row.responseId, 'cli-session-aggregate', 'a session is not one response');
  assert.equal(metadata.responseIdScope, 'local_invocation');
  assert.equal(metadata.usageScope, 'cli_result_aggregate');
  assert.equal(metadata.providerMessageId, 'provider-message-aggregate');
  assert.equal(metadata.sessionId, 'cli-session-aggregate');
  assert.equal(row.requestModel, 'claude-sonnet-5');
  assert.equal(row.providerReportedModel, undefined, 'one observed message cannot certify the aggregate model');
  assert.equal(route.providerReportedModel, undefined);
  assert.equal(route.actualModel, undefined);
  assert.equal(row.observedMessageModel, 'claude-haiku-5-5', 'observed substitution remains separately scoped');
  assert.equal(route.observedMessageModel, 'claude-haiku-5-5');
  assert.deepEqual([row.inputTokens, row.cachedInputTokens, row.cacheCreationInputTokens, row.outputTokens], [21, 11, 3, 5]);
  assert.equal(row.totalTokens, 26, 'preserve the reported aggregate and token meter');
  assert.ok(typeof row.durationMs === 'number' && row.durationMs >= 0);
  const measured = measureAcceptedTask(home, sessionId, sourceUserSeq);
  assert.equal(measured.usageRecords, 1, 'canonical accounting reads this exact source-bound summary');
  assert.equal(measured.usageCompleteness.identityGaps.providerReportedModelRows, 1);
  assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
  assert.equal(measured.usageCompleteness.cost.actualBilling, 'not_measured');
});

test('streamed message usage bridges its actual message ID, including metadata-only assistant events', async () => {
  const { response, row, route, metadata } = await recorded([
    { type: 'system', subtype: 'init', session_id: 'cli-session-message' },
    { type: 'assistant', message: { id: 'provider-message-only', model: 'claude-sonnet-5', content: [],
      usage: { input_tokens: 4, output_tokens: 2 } } },
    { type: 'result', subtype: 'success', session_id: 'cli-session-message', result: 'Controlled verdict.' },
  ], true);
  assert.equal(row.responseId, 'provider-message-only');
  assert.equal(response.responseId, row.responseId);
  assert.equal(route.providerResponseIdDigest, hash(row.responseId!));
  assert.equal(metadata.responseIdScope, 'provider_message');
  assert.equal(metadata.usageScope, 'assistant_message');
  assert.equal(row.providerReportedModel, 'claude-sonnet-5');
});

test('result-only CLI usage remains locally attributable without inventing a served model', async () => {
  const { response, row, route, metadata } = await recorded([
    { type: 'result', subtype: 'success', session_id: 'cli-session-no-model', result: 'Controlled verdict.',
      usage: { input_tokens: 7, output_tokens: 3 } },
  ]);
  assert.equal(row.responseId, response.responseId);
  assert.equal(route.providerResponseIdDigest, hash(row.responseId!));
  assert.equal(metadata.responseIdScope, 'local_invocation');
  assert.equal(metadata.usageScope, 'cli_result_aggregate');
  assert.equal(row.requestModel, 'claude-sonnet-5');
  assert.equal(row.providerReportedModel, undefined);
  assert.equal(route.providerReportedModel, undefined);
  assert.equal(metadata.providerMessageId, undefined);
});

test('mixed provider models cannot qualify an aggregate as one served model or physical message', async () => {
  const { response, row, route, metadata } = await recorded([
    { type: 'assistant', message: { id: 'provider-message-first', model: 'claude-sonnet-5', content: [],
      usage: { input_tokens: 2, output_tokens: 1 } } },
    { type: 'assistant', message: { id: 'provider-message-second', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Controlled verdict.' }],
      usage: { input_tokens: 4, output_tokens: 2 } } },
    { type: 'result', subtype: 'success', session_id: 'cli-session-mixed', result: 'Controlled verdict.',
      usage: { input_tokens: 6, output_tokens: 3 } },
  ]);
  assert.equal(row.responseId, response.responseId);
  assert.match(row.responseId!, /^claude-headless-/);
  assert.equal(metadata.usageScope, 'cli_result_aggregate');
  assert.equal(metadata.providerReportedModelUnqualified, true);
  assert.equal(row.providerReportedModel, undefined);
  assert.equal(route.providerReportedModel, undefined);
  assert.deepEqual([row.inputTokens, row.outputTokens], [6, 3]);
});

test('missing message identity never borrows the previous message identity for later usage', async () => {
  const { response, row, metadata } = await recorded([
    { type: 'assistant', message: { id: 'provider-message-before', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Initial.' }],
      usage: { input_tokens: 2, output_tokens: 1 } } },
    { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Controlled verdict.' }],
      usage: { input_tokens: 4, output_tokens: 2 } } },
    { type: 'result', subtype: 'success', session_id: 'cli-session-missing-id', result: 'Controlled verdict.' },
  ]);
  assert.equal(row.responseId, response.responseId);
  assert.match(row.responseId!, /^claude-headless-/);
  assert.equal(metadata.responseIdScope, 'local_invocation');
  assert.equal(metadata.providerMessageId, undefined);
  assert.deepEqual([row.inputTokens, row.outputTokens], [4, 2]);
});

test('the outgoing CLI alias and repeated session ID cannot masquerade as served model or response identity', async () => {
  const events = [{ type: 'result', subtype: 'success', session_id: 'reused-cli-session', result: 'Controlled verdict.',
    usage: { input_tokens: 3, output_tokens: 1 } }];
  const first = await recorded(events, false, 'claude-agent-sdk');
  const second = await recorded(events, true, 'claude-agent-sdk');
  for (const { row, response, route } of [first, second]) {
    assert.equal(row.requestModel, 'sonnet', 'record the actual outgoing alias, not the configured adapter label');
    assert.equal(row.providerReportedModel, undefined);
    assert.equal(route.providerReportedModel, undefined);
    assert.equal(row.responseId, response.responseId);
  }
  assert.notEqual(first.row.responseId, second.row.responseId, 'each local invocation keeps its own bridge');
});

test('unreported or malformed assistant models keep aggregate provider attribution unqualified', async () => {
  for (const model of [undefined, 'not a provider identity']) {
    const { row, route, metadata } = await recorded([
      { type: 'assistant', message: { id: 'known-message', model: 'claude-sonnet-5', content: [],
        usage: { input_tokens: 2, output_tokens: 1 } } },
      { type: 'assistant', message: { id: 'unknown-model-message', ...(model === undefined ? {} : { model }), content: [],
        usage: { input_tokens: 4, output_tokens: 2 } } },
      { type: 'result', subtype: 'success', result: 'Controlled verdict.', usage: { input_tokens: 6, output_tokens: 3 } },
    ]);
    assert.equal(row.providerReportedModel, undefined);
    assert.equal(route.providerReportedModel, undefined);
    assert.equal(metadata.providerReportedModelUnqualified, true);
    assert.equal(metadata.model, undefined);
  }
});
