/** Scripted SDK boundary only; no provider request or application runtime. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-preparation-port-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  MCP_AUTO_IMPORT_ENABLED: 'false', OPENAI_AGENTS_DISABLE_TRACING: '1' });
const { Runner } = await import('@openai/agents');
const { completeViaConfiguredBrain, _setQuickCheckDeadlineMsForTests } = await import('./configured-brain-semantic-port.js');
const { resolveRoleModel } = await import('../harness/model-roles.js');
const { closeEventLog } = await import('../harness/eventlog.js');
const original = Runner.prototype.run;
after(() => { Runner.prototype.run = original; _setQuickCheckDeadlineMsForTests(null); closeEventLog(); rmSync(home, { recursive: true, force: true }); });
const request = { purpose: 'workflow_step_effect' as const, system: 'controlled preparation fixture',
  user: '{"prompt":"read the fixture"}', schemaName: 'WorkflowStepEffectV1' as const };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('Stop during the Quick request prevents brain fallback even if the SDK ignores abort and later answers', async () => {
  const controller = new AbortController(); let signal!: AbortSignal; let calls = 0;
  let late!: (value: unknown) => void;
  Runner.prototype.run = (async (_agent: unknown, _input: unknown, options: { signal?: AbortSignal }) => {
    calls++; signal = options.signal!;
    return new Promise(resolve => { late = resolve; });
  }) as unknown as typeof original;
  try {
    const running = completeViaConfiguredBrain({ ...request, signal: controller.signal, deadlineAt: Date.now() + 5_000 });
    void running.catch(() => {});
    await tick();
    const reason = new Error('controlled preparation Stop'); controller.abort(reason);
    await assert.rejects(running, error => error === reason);
    assert.equal(signal.aborted, true); assert.equal(calls, 1);
    late({ finalOutput: { effect: 'write' } });
    await tick(); assert.equal(calls, 1, 'a late stopped request cannot start another role');
  } finally { Runner.prototype.run = original; }
});

test('one absolute preparation budget covers Quick and the brain fallback without resetting it', async () => {
  const quick = resolveRoleModel('quick').modelId; const brain = resolveRoleModel('brain').modelId;
  assert.notEqual(quick, brain);
  const asked: string[] = []; const signals: AbortSignal[] = [];
  Runner.prototype.run = (async (agent: { model?: string }, _input: unknown, options: { signal?: AbortSignal }) => {
    asked.push(String(agent.model)); signals.push(options.signal!); return new Promise(() => {});
  }) as unknown as typeof original;
  _setQuickCheckDeadlineMsForTests(20);
  const started = Date.now();
  try {
    await assert.rejects(completeViaConfiguredBrain({ ...request, deadlineAt: started + 300 }), /deadline reached/);
    assert.deepEqual(asked, [quick, brain]);
    assert.ok(Date.now() - started < 2_000, 'the fallback cannot hold an expired preparation open');
    assert.ok(signals.every(signal => signal.aborted));
  } finally { Runner.prototype.run = original; _setQuickCheckDeadlineMsForTests(null); }
});

test('a Stop observed at the first failure starts no fallback and an already expired budget starts no request', async () => {
  const controller = new AbortController(); let calls = 0;
  Runner.prototype.run = (async () => {
    calls++; controller.abort(new Error('controlled Stop at failure')); throw new Error('controlled Quick failure');
  }) as unknown as typeof original;
  try {
    await assert.rejects(completeViaConfiguredBrain({ ...request, signal: controller.signal, deadlineAt: Date.now() + 5_000 }), /controlled Stop at failure/);
    assert.equal(calls, 1);
    await assert.rejects(completeViaConfiguredBrain({ ...request, deadlineAt: Date.now() - 1 }), /deadline reached/);
    assert.equal(calls, 1);
  } finally { Runner.prototype.run = original; }
});
