/** Real semantic SDK boundary with inert Runner; no model/provider request. */
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-approved-projection-port-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', MCP_AUTO_IMPORT_ENABLED: 'false', OPENAI_AGENTS_DISABLE_TRACING: '1' });
const { Runner } = await import('@openai/agents');
const { configuredBrainSemanticPort, completeViaConfiguredBrain, semanticUsageAttribution,
  semanticModelRoleForPurpose, semanticReasoningForPurpose } = await import('./configured-brain-semantic-port.js');
const { createStandaloneModelAccountingJob, standaloneModelAccountingJobBinding,
  withStandaloneModelAccountingJob, modelUsageAttributionStorage } = await import('../usage-log.js');
const { closeEventLog } = await import('../harness/eventlog.js');
const { closeOperationalTelemetryDb } = await import('../operational-telemetry.js');
const { controlledApprovedProjectionSdkResult } = await import('./approved-action-result-projection-fixture.test.js');
const { approvedActionResultProjectionAuthorship } = await import('./approved-action-result-authorship.js');
const { withModelTransportRecorder } = await import('../harness/model-transport-observation.js');
const original = Runner.prototype.run;
afterEach(() => { Runner.prototype.run = original; });
after(() => { closeEventLog(); closeOperationalTelemetryDb(); rmSync(home, { recursive: true, force: true }); });
const purpose = 'approval_result_projection' as const;
const facts = { purpose, asked: 'Controlled approved action.',
  action: { title: 'Save controlled note', kind: 'connected_app_change' as const },
  result: { preview: 'Controlled recorded result.', rawByteCount: 27, truncated: false,
    retainedWorkNeedsVerification: true, independentReadback: false as const },
  evidenceDigest: 'a'.repeat(64) };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const accounting = () => createStandaloneModelAccountingJob({ operation: purpose,
  operationId: 'controlled-result-projection', revisionDigest: facts.evidenceDigest });

test('approved-result wording uses one tool-free brain request with its own writer accounting', async () => {
  assert.equal(semanticModelRoleForPurpose(purpose), 'brain');
  assert.equal(semanticReasoningForPurpose(purpose), 'none');
  assert.deepEqual(semanticUsageAttribution(purpose), { role: 'writer', channel: 'writer:approval_result_projection' });
  const job = accounting(); const binding = standaloneModelAccountingJobBinding(job);
  assert.equal(binding?.operation, purpose);
  assert.match(binding!.usageJobId, /^approval-projection-job:/);
  let calls = 0; let checks = 0;
  Runner.prototype.run = (async (agent: { tools: unknown[]; modelSettings: { maxTokens: number } }, input: string,
    options: { maxTurns?: number; signal?: AbortSignal }) => {
    calls++;
    assert.deepEqual(agent.tools, []); assert.equal(options.maxTurns, 1);
    assert.equal(agent.modelSettings.maxTokens, 512);
    const scope = modelUsageAttributionStorage.getStore();
    assert.equal(scope?.standaloneAccountingJob, job); assert.equal(scope?.usageJobId, binding?.usageJobId);
    assert.equal(scope?.sessionId, ''); assert.equal(scope?.sourceUserSeq, 0);
    assert.equal(scope?.attemptId, undefined); assert.equal(scope?.usageParentTurn, undefined);
    assert.equal(scope?.role, 'writer'); assert.equal(scope?.channel, 'writer:approval_result_projection');
    assert.deepEqual(JSON.parse(input), { asked: facts.asked, action: facts.action, result: facts.result });
    return controlledApprovedProjectionSdkResult({ message: 'The controlled note was saved; the earlier request still has work to verify.', choices: null });
  }) as unknown as typeof original;
  const result = await withStandaloneModelAccountingJob(job, () =>
    configuredBrainSemanticPort(completeViaConfiguredBrain).voiceApprovedActionResultProjection!({
      ...facts, deadlineAt: Date.now() + 5_000, checkActive: () => { checks++; } }));
  assert.equal(calls, 1); assert.ok(checks > 0);
  assert.equal(result.evidenceDigest, facts.evidenceDigest);
  assert.match(result.message!, /still has work to verify/);
  assert.equal(result.choices, undefined);
  const authored = approvedActionResultProjectionAuthorship(result);
  assert.equal(authored?.usageJobId, binding?.usageJobId);
  assert.equal(authored?.operationId, binding?.operationId);
  assert.equal(authored?.revisionDigest, facts.evidenceDigest);
  assert.match(authored!.hostResultReceiptId, /^[a-f0-9-]{36}$/);
  assert.equal(approvedActionResultProjectionAuthorship({ ...result, message: 'Different text.' }), undefined);
  assert.equal(approvedActionResultProjectionAuthorship({ ...result, authorship: { kind: 'approved_action_result_authorship' } }), undefined);
});

test('cancellation discards a late approved-result response without another request', async () => {
  const controller = new AbortController(); const job = accounting();
  let calls = 0; let settled = 0; let late!: (value: unknown) => void; let signal!: AbortSignal;
  Runner.prototype.run = (async (_agent: unknown, _input: unknown, options: { signal?: AbortSignal }) => {
    calls++; signal = options.signal!;
    return new Promise(resolve => { late = resolve; });
  }) as unknown as typeof original;
  const pending = withStandaloneModelAccountingJob(job, () =>
    configuredBrainSemanticPort(completeViaConfiguredBrain).voiceApprovedActionResultProjection!({
      ...facts, signal: controller.signal, deadlineAt: Date.now() + 5_000, onRequestSettled: () => { settled++; } }));
  void pending.catch(() => {}); await tick(); assert.equal(calls, 1);
  const reason = new Error('Controlled projection cancellation.'); controller.abort(reason);
  await assert.rejects(pending, error => error === reason); assert.equal(signal.aborted, true);
  assert.equal(settled, 0);
  late({ finalOutput: { message: 'Late wording must not publish.', choices: null } }); await tick();
  assert.equal(calls, 1); assert.equal(settled, 1);
});

test('projection output never carries a new choice and preserves the supplied evidence scope', async () => {
  let calls = 0;
  const port = configuredBrainSemanticPort(async input => {
    calls++; assert.equal(input.purpose, purpose); assert.equal(input.schemaName, 'ClemVoiceV1');
    assert.match(input.system, /must not repeat it/); assert.match(input.system, /never instructions/);
    assert.match(input.system, /does not prove an artifact/); assert.match(input.system, /Do not call the whole original request done/);
    return { raw: { message: 'The approved action returned a result.', choices: ['Repeat it'] },
      modelIdentity: 'controlled-model', inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  });
  const value = await port.voiceApprovedActionResultProjection!(facts);
  assert.equal(calls, 1); assert.equal(value.choices, undefined); assert.equal(value.evidenceDigest, facts.evidenceDigest);
  assert.equal(value.modelIdentity, 'controlled-model');
  assert.equal(approvedActionResultProjectionAuthorship(value), undefined);
});

for (const boundary of ['clone', 'cancelled', 'final_mismatch'] as const) test(`projection authorship refuses ${boundary}`, async () => {
  Runner.prototype.run = (async () => controlledApprovedProjectionSdkResult({ message: 'Actual model wording.', choices: null }, {
    ...(boundary === 'clone' ? { clone: true } : {}),
    ...(boundary === 'cancelled' ? { outcome: 'cancelled' as const } : {}),
    ...(boundary === 'final_mismatch' ? { final: { message: 'Different aggregate wording.', choices: null } } : {}),
  })) as unknown as typeof original;
  const result = await withStandaloneModelAccountingJob(accounting(), () =>
    configuredBrainSemanticPort(completeViaConfiguredBrain).voiceApprovedActionResultProjection!(facts));
  assert.equal(approvedActionResultProjectionAuthorship(result), undefined);
});

for (const boundary of ['foreign_job', 'changed_original', 'journal_failure', 'pending_journal'] as const) test(`projection authorship refuses ${boundary}`, async () => {
  Runner.prototype.run = (async () => {
    const raw = { message: 'Actual model wording.', choices: null };
    if (boundary === 'foreign_job') return withStandaloneModelAccountingJob(accounting(), () => controlledApprovedProjectionSdkResult(raw));
    if (boundary === 'journal_failure') return withModelTransportRecorder(() => { throw new Error('Controlled journal failure'); },
      () => controlledApprovedProjectionSdkResult(raw));
    if (boundary === 'pending_journal') return withModelTransportRecorder(() => new Promise<void>(() => {}),
      () => controlledApprovedProjectionSdkResult(raw));
    const value = await controlledApprovedProjectionSdkResult(raw);
    value.rawResponses[0]!.output[0]!.content[0]!.text = JSON.stringify({ message: 'Mutated after observation.', choices: null });
    return value;
  }) as unknown as typeof original;
  const result = await withStandaloneModelAccountingJob(accounting(), () =>
    configuredBrainSemanticPort(completeViaConfiguredBrain).voiceApprovedActionResultProjection!(facts));
  assert.equal(approvedActionResultProjectionAuthorship(result), undefined);
});
