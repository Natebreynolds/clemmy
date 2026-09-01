/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/unique-workflow-continuation.red.test.ts
 *
 * OPEN-THE-GATES C. Live sess-desktop-ca4779 / 7702e0: plan_task returned
 * plan_not_required with the exact workflow name, then the model completed
 * without calling workflow_run. The unique-run refusal must be a closed
 * plan_task result (repair + workflowName), and a completed model step after
 * that nomination must continue into workflow_run, not a false success.
 *
 * Re-break:
 *   (i)  plan_not_required rejects the unique-run payload's extra keys
 *   (ii) a completed step after plan_not_required is terminal
 *   (iii) spend on any function_call except plan_task/tool_search (live 97439
 *         ask_user_question then retired the continuation)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const CONTRACT = new URL('./plan-task-result-contract.ts', import.meta.url);
const HOST = new URL('./host-turn-runner.ts', import.meta.url);
const PLAN = new URL('../../tools/plan-tools.ts', import.meta.url);

test('NEGATIVE: unique-run plan_not_required is a closed settled refusal', () => {
  const src = readFileSync(CONTRACT, 'utf8');
  const block = src.slice(
    src.indexOf("payload.code === 'plan_not_required'"),
    src.indexOf("payload.code === 'plan_incomplete_missing_write'"),
  );
  assert.match(block, /workflowName/);
  assert.match(block, /repair/);
});

test('NEGATIVE: a completed step after unique-run nomination continues into workflow_run', async () => {
  const { pendingUniqueWorkflowNameFromHistory } = await import('./host-turn-runner.js');
  const history = [
    {
      type: 'function_call',
      callId: 'c1',
      name: 'plan_task',
      arguments: '{}',
    },
    {
      type: 'function_call_result',
      callId: 'c1',
      name: 'plan_task',
      status: 'completed',
      output: {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code: 'plan_not_required',
          detail: 'this accepted request uniquely names an existing workflow; call workflow_run with that exact name',
          workflowName: 'platform-49-slack-channel-review',
          repair: 'Call workflow_run with name "platform-49-slack-channel-review".',
        }),
      },
    },
  ];
  assert.equal(
    pendingUniqueWorkflowNameFromHistory(history as never),
    'platform-49-slack-channel-review',
  );
  assert.equal(
    pendingUniqueWorkflowNameFromHistory([
      ...history,
      { type: 'function_call', callId: 'c2', name: 'workflow_run', arguments: '{}' },
    ] as never),
    null,
    'once workflow_run is issued the continuation is spent',
  );
  assert.equal(
    pendingUniqueWorkflowNameFromHistory([
      ...history,
      { type: 'function_call', callId: 'c3', name: 'dispatch_background_task', arguments: '{}' },
    ] as never),
    null,
    'a background dispatch after the nomination is already an act',
  );
  assert.equal(
    pendingUniqueWorkflowNameFromHistory([
      ...history,
      {
        type: 'function_call',
        callId: 'c4',
        name: 'ask_user_question',
        arguments: '{"question":"The workflow dispatcher is refusing to start"}',
      },
    ] as never),
    'platform-49-slack-channel-review',
    'asking after nomination does not queue the run (live seq 97439)',
  );
  assert.equal(
    pendingUniqueWorkflowNameFromHistory([
      ...history,
      {
        type: 'function_call',
        callId: 'c5',
        name: 'workflow_get',
        arguments: '{"name":"platform-49-slack-channel-review"}',
      },
    ] as never),
    'platform-49-slack-channel-review',
    'inspect after nomination does not queue the run',
  );
  assert.equal(
    pendingUniqueWorkflowNameFromHistory([
      ...history,
      {
        type: 'function_call',
        callId: 'c6',
        name: 'work_call',
        arguments: JSON.stringify({ name: 'workflow_run', args_json: '{"name":"platform-49-slack-channel-review"}' }),
      },
    ] as never),
    null,
    'work_call wrapping workflow_run still spends the continuation',
  );
});

test('re-break (i): unique-run payload still carries workflowName + repair', () => {
  const src = readFileSync(PLAN, 'utf8');
  assert.match(src, /workflowName: uniqueWorkflow\.name/);
  assert.match(src, /Call workflow_run with name "\$\{uniqueWorkflow\.name\}"/);
});

test('re-break (ii): host-turn-runner continues instead of completing', () => {
  const src = readFileSync(HOST, 'utf8');
  assert.match(src, /acceptedUniqueWorkflowContinuationUsed/);
  assert.match(src, /Call workflow_run now with name/);
});

test('NEGATIVE: unique-run is host-dispatched before the model loop', () => {
  const src = readFileSync(HOST, 'utf8');
  const dispatchAt = src.indexOf('tryHostDispatchNamedWorkflow');
  const loopAt = src.indexOf('for (let stepIndex = currentHostStepIndex;');
  assert.ok(dispatchAt >= 0 && loopAt > dispatchAt, 'host dispatch must precede the model loop');
  assert.match(src, /uniqueDispatch\.status === 'dispatched'/);
});

test('NEGATIVE: a prepared unique-run cannot fall through a swallowed projection failure', () => {
  const src = readFileSync(HOST, 'utf8');
  const owner = src.slice(
    src.indexOf('if (hostProduction && !resumedHostState && !resumedRecoveryState)'),
    src.indexOf('let remainingPreContentStallRetries'),
  );
  const probeCatch = owner.indexOf('} catch {');
  const dispatch = owner.indexOf('tryHostDispatchNamedWorkflow');
  const completion = owner.indexOf('return await completedOutcome(uniqueDispatch.message)');
  assert.ok(probeCatch >= 0 && dispatch > probeCatch && completion > dispatch,
    'only accepted-source identity probing may be swallowed; queue + projection stay outside');
});
