/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/worker-parent-actions.test.ts
 *
 * A worker refused an outside action because only its parent may run it did
 * not do that action. The host records the refusal where it happens and adds
 * its own line to the worker's result, whatever the worker wrote; a worker
 * that correctly returned the payload is not marked failed for it.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-parent-actions-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const actions = await import('./worker-parent-actions.js');
const { createSession, closeEventLog } = await import('../runtime/harness/eventlog.js');
const { harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
const { workerResultIndicatesFailure } = await import('./worker-job-packet.js');

after(() => { closeEventLog(); try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

const inRun = <T>(context: Record<string, unknown>, work: () => T): T => harnessRunContextStorage.run(context as never, work);

test('a refusal inside a worker is recorded for that worker; outside a worker nothing is recorded', () => {
  const parent = createSession({ id: 'parent-actions-chat', kind: 'chat' });
  const since = actions.sessionHighWater(parent.id);
  inRun({ sessionId: parent.id, workerScope: true, behaviorScopeId: 'w-one' }, () => actions.recordWorkerComposeOnly('provider__create_record'));
  inRun({ sessionId: parent.id, workerScope: true, behaviorScopeId: 'w-two' }, () => actions.recordWorkerComposeOnly('provider__send'));
  inRun({ sessionId: parent.id }, () => actions.recordWorkerComposeOnly('provider__parent_call'));
  assert.deepEqual(actions.workerComposeOnlyActions({ sessionId: parent.id, sinceSeq: since, scopeId: 'w-one' }), ['provider__create_record'],
    'a sibling worker\'s refusal is not this worker\'s');
  assert.deepEqual(actions.workerComposeOnlyActions({ sessionId: parent.id, sinceSeq: since }).sort(), ['provider__create_record', 'provider__send']);
  assert.deepEqual(actions.workerComposeOnlyActions({ sessionId: parent.id, sinceSeq: actions.sessionHighWater(parent.id) }), []);
});

test('the host line names what was not done and leaves a returned payload a success', () => {
  assert.equal(actions.parentActionsNote([]), '');
  const one = actions.parentActionsNote(['provider__create_record']);
  assert.match(one, /^\[Host record\] 1 outside action was refused in this worker because only the parent may run it: provider__create_record\./);
  assert.match(one, /Unless the result above includes their exact payloads, it was not done; nothing was sent\./);
  assert.match(actions.parentActionsNote(['a', 'a', 'b']), /3 outside actions were refused .*: a, b\./);
  assert.equal(workerResultIndicatesFailure(`{"id":"1","composioSlug":"X","args":{}}\n\n${one}`), false,
    'a worker that returned the payload as asked is not counted failed');
});

test('PINS: both refusal points record, and every worker result path adds the host line', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const runner = read('../runtime/harness/host-turn-runner.ts');
  assert.match(runner, /recordWorkerComposeOnly\(exact\.logicalToolName \|\| name\);\s*return `WORKER_COMPOSE_ONLY/);
  assert.match(read('../tools/composio-tools.ts'), /=== 'read'\) return null;\s*recordWorkerComposeOnly\(toolSlug\);/);
  assert.match(read('../runtime/harness/worker-host-runner.ts'), /onParentActions\?\.\(workerComposeOnlyActions\(\{ sessionId: session\.id, sinceSeq: childSource\.seq \}\)\)/);
  assert.match(read('../tools/worker-tools.ts'), /parentActionsNote\(parentActions\)/);
  assert.match(read('./orchestrator.ts'), /parentActionsNote\(parentActions\)/);
  assert.match(read('./sub-agents.ts'), /onParentActions: \(tools\) => \{ parentActions = tools; \}/);
});
