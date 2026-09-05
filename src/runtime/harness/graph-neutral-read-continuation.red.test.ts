/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/graph-neutral-read-continuation.red.test.ts
 *
 * Plan-optional delegation gave the unique-workflow nomination a continuation
 * (pendingUniqueWorkflowNameFromHistory) and left its read sibling behind:
 * plan_task refuses one graph-neutral read as `plan_not_required` and
 * nominates call_tool, the model answers in prose instead, and the host
 * published that prose as the turn — zero settlements, a dead end. A read the
 * host has already pinned cannot stop at prose (D1 ledger truth, no dead ends).
 *
 * Re-break:
 *   (i)  a completed step after the call_tool nomination is terminal
 *   (ii) spend on planning/discovery/ask (none of those is the read)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const HOST = new URL('./host-turn-runner.ts', import.meta.url);

const nomination = [
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
        detail: 'plan_task is only for action work or an exact reviewed Clementine-local read; use a graph-neutral read otherwise.',
        repair: 'Call call_tool exactly once with the exact graph-neutral read operation and schema already disclosed for this request. Do not call plan_task for this read.',
        recoveryTool: 'call_tool',
      }),
    },
  },
];

test('NEGATIVE: a completed step after a graph-neutral read nomination continues into the read', async () => {
  const { pendingGraphNeutralReadFromHistory } = await import('./host-turn-runner.js');
  assert.equal(pendingGraphNeutralReadFromHistory(nomination as never), true);
  assert.equal(pendingGraphNeutralReadFromHistory([] as never), false);
  assert.equal(
    pendingGraphNeutralReadFromHistory([
      ...nomination,
      { type: 'function_call', callId: 'c2', name: 'call_tool', arguments: '{"name":"outlook__query_emails","args_json":"{}"}' },
    ] as never),
    false,
    'once the nominated carrier is issued the continuation is spent',
  );
  assert.equal(
    pendingGraphNeutralReadFromHistory([
      ...nomination,
      { type: 'function_call', callId: 'c3', name: 'work_call', arguments: '{"name":"outlook__query_emails","args_json":"{}"}' },
    ] as never),
    false,
    'the other read carrier is the same attempt',
  );
  assert.equal(
    pendingGraphNeutralReadFromHistory([
      ...nomination,
      { type: 'function_call', callId: 'c4', name: 'outlook__query_emails', arguments: '{}' },
    ] as never),
    false,
    'a first-class read call is the attempt itself',
  );
  assert.equal(
    pendingGraphNeutralReadFromHistory([
      ...nomination,
      { type: 'function_call', callId: 'c5', name: 'tool_search', arguments: '{"query":"outlook"}' },
    ] as never),
    true,
    'discovery after the nomination is not the read',
  );
  assert.equal(
    pendingGraphNeutralReadFromHistory([
      ...nomination,
      { type: 'function_call', callId: 'c6', name: 'plan_task', arguments: '{}' },
    ] as never),
    true,
    'replanning after the nomination is not the read',
  );
  assert.equal(
    pendingGraphNeutralReadFromHistory([
      ...nomination,
      {
        type: 'function_call',
        callId: 'c7',
        name: 'ask_user_question',
        arguments: '{"question":"Which mailbox?"}',
      },
    ] as never),
    true,
    'asking after the nomination does not read',
  );
  assert.equal(
    pendingGraphNeutralReadFromHistory([
      nomination[0],
      {
        ...nomination[1],
        output: {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            code: 'plan_not_required',
            detail: 'this accepted request uniquely names an existing workflow; call workflow_run with that exact name',
            workflowName: 'platform-49-slack-channel-review',
            repair: 'Call workflow_run with name "platform-49-slack-channel-review".',
            recoveryTool: 'workflow_run',
          }),
        },
      },
    ] as never),
    false,
    'the unique-workflow nomination keeps its own continuation',
  );
});

test('re-break (i): host-turn-runner continues instead of completing, on the single read budget', () => {
  const src = readFileSync(HOST, 'utf8');
  const at = src.indexOf('pendingGraphNeutralReadFromHistory(history)');
  assert.ok(at >= 0, 'the completed-frame branch consults the nomination');
  const guard = src.slice(Math.max(0, at - 200), at);
  assert.match(guard, /!acceptedReadPlanContinuationUsed/,
    'one read continuation per turn, whichever shape pinned the read');
  assert.match(src.slice(at, at + 1200), /ACCEPTED READ EXECUTION/);
  assert.match(src.slice(at, at + 1200), /Call call_tool now/);
});
