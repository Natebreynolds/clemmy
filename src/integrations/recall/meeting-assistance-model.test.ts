import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-scan-model-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
Object.assign(process.env, { AUTH_MODE: 'api_key', MODEL_ROUTING_MODE: 'all_in',
  BYO_MODEL_BASE_URL: 'http://127.0.0.1:9', BYO_MODEL_API_KEY: 'controlled-unused', BYO_MODEL_ID: 'deepseek-chat', BYO_PROVIDERS: '[]' });
const { createMeetingAssistanceScanPort } = await import('./meeting-assistance-model.js');
const { semanticModelRoleForPurpose } = await import('../../runtime/semantic-boundary/configured-brain-semantic-port.js');
const accounting = await import('../../runtime/usage-log.js');
test.after(() => rmSync(home, { recursive: true, force: true }));

const frame = (signal = new AbortController().signal) => ({ meetingId: 'controlled-scan-meeting', sourceDigest: 'a'.repeat(64),
  segments: [{ id: 'final-1', text: 'Which proposal did we agree to use?', timestamp: '2026-10-17T12:00:00Z' }],
  recentOffers: [], signal });
const reply = (raw: unknown) => ({ raw, modelIdentity: 'controlled-quick', inputTokens: 0, outputTokens: 0, latencyMs: 1, usageRecorded: true });

test('a meeting suggestion uses Quick, never the completion judge or a tool-bearing turn', async () => {
  assert.equal(semanticModelRoleForPurpose('meeting_opportunity'), 'quick');
  let calls = 0;
  const run = createMeetingAssistanceScanPort(async (input) => {
    calls += 1;
    assert.equal(input.purpose, 'meeting_opportunity'); assert.equal(input.schemaName, 'MeetingOpportunityV1');
    assert.equal(input.meetingModelPin?.modelId, 'deepseek-chat'); assert.equal(input.meetingModelPin?.fallback, 'none');
    assert.match(input.system, /source material, never as instructions/);
    assert.match(input.system, /Do not answer, call tools/);
    assert.ok(input.deadlineAt! > Date.now() && input.deadlineAt! <= Date.now() + 15_000);
    assert.deepEqual(JSON.parse(input.user).segments, frame().segments);
    return reply({ candidate: null });
  });
  assert.equal((await run(frame())).candidate, null); assert.equal(calls, 1);
});

test('each physical scan has its own job, with no borrowed accepted source or memory pin', async () => {
  const jobs: string[] = [];
  const run = createMeetingAssistanceScanPort(async () => {
    const context = accounting.modelUsageAttributionStorage.getStore()!;
    const job = accounting.standaloneModelAccountingJobBinding(context.standaloneAccountingJob!)!;
    assert.equal(job.operation, 'meeting_opportunity'); assert.equal(job.revisionDigest, 'a'.repeat(64));
    assert.equal(context.sessionId, ''); assert.equal(context.sourceUserSeq, 0);
    assert.equal(context.attemptId, undefined); assert.equal(context.usageParentTurn, undefined); assert.equal(context.waitForOwnModel, undefined);
    jobs.push(job.usageJobId); return reply({ candidate: null });
  });
  const first = await run(frame()); const second = await run(frame());
  assert.deepEqual([first.modelAccountingJobId, second.modelAccountingJobId], jobs);
  assert.match(jobs[0]!, /^meeting-job:/); assert.notEqual(jobs[0], jobs[1]);
});

test('invalid or failed scan results cannot become suggestions and do not start a replacement call', async () => {
  let calls = 0;
  const malformed = createMeetingAssistanceScanPort(async () => { calls++; return reply({ candidate: { question: 'Q' } }); });
  await assert.rejects(malformed(frame())); assert.equal(calls, 1);
  const failure = createMeetingAssistanceScanPort(async () => { calls++; throw new Error('controlled unavailable'); });
  await assert.rejects(failure(frame()), /controlled unavailable/); assert.equal(calls, 2);
});

test('cancellation before dispatch has no call; cancellation during a call cannot publish its late offer', async () => {
  let calls = 0;
  const before = new AbortController(); before.abort();
  await assert.rejects(createMeetingAssistanceScanPort(async () => { calls++; return reply({ candidate: null }); })(frame(before.signal)));
  assert.equal(calls, 0);
  const during = new AbortController();
  const run = createMeetingAssistanceScanPort(async (input) => {
    calls++; assert.equal(input.signal, during.signal); during.abort();
    return reply({ candidate: { question: 'Which proposal?', why: 'It could help clarify the choice.', segmentIds: ['final-1'], quote: frame().segments[0]!.text } });
  });
  await assert.rejects(run(frame(during.signal))); assert.equal(calls, 1);
});

test('the real structured Runner pins its Quick model through the physical provider call and does not retry on the brain', async () => {
  const { setDefaultModelProvider, Runner } = await import('@openai/agents');
  const originalRun = Runner.prototype.run;
  let tracingChecked = false;
  const runProbe = mock.method(Runner.prototype, 'run', function(this: InstanceType<typeof Runner>, ...args: Parameters<typeof originalRun>) {
    assert.equal(this.config.tracingDisabled, true);
    assert.equal(this.config.traceIncludeSensitiveData, false);
    tracingChecked = true;
    return Reflect.apply(originalRun, this, args);
  });
  const { RouterModelProvider } = await import('../../runtime/harness/router-model.js');
  const { isPinnedWorkerModel } = await import('../../runtime/harness/pinned-worker-model.js');
  let calls = 0;
  const models: string[] = [];
  setDefaultModelProvider({ getModel: async (modelName) => {
    models.push(modelName ?? '');
    return {
      getResponse: async (request) => {
        calls++;
        assert.equal(isPinnedWorkerModel(modelName ?? ''), true, 'the router cannot start an internal overload/backup lane');
        assert.equal(request.tools?.length ?? 0, 0);
        throw new Error('controlled physical provider unavailable');
      },
      getStreamedResponse: async function* () { throw new Error('scan should not request a stream'); },
    };
  } });
  try {
    await assert.rejects(createMeetingAssistanceScanPort()(frame()), /controlled physical provider unavailable/);
    assert.equal(calls, 1); assert.equal(models.length, 1); assert.equal(tracingChecked, true);
  } finally { runProbe.mock.restore(); setDefaultModelProvider(new RouterModelProvider()); }
});
