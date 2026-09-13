/** Preparation reads have no item/read allowance. Existing effect authority remains. */
import test from 'node:test';
import assert from 'node:assert/strict';
const { createSession, appendEvent } = await import('./eventlog.js');
const { planModeCallRefusal } = await import('./accepted-task-mode.js');

test('Plan preparation remains readable after many receipts across all carriers', () => {
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: {
    text: 'Read the supplied inputs and prepare the plan.', taskMode: { version: 1, kind: 'plan' },
  } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  // Learning-worker and direct-adapter receipt shapes, including more than
  // three supplied inputs. Neither producer may exhaust preparation.
  for (let i = 0; i < 50; i++) appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'read_receipt', data: {
    sourceUserSeq: source.seq, record: { receiptId: `read-${i}`, effectClass: 'read', dispatchOutcome: 'succeeded', source: identity },
  } });
  const read = { name: 'composio_execute_tool', args_json: JSON.stringify({ tool_slug: 'ACME_GET_RESOURCE', arguments: '{"id":"next-input"}' }) };
  for (const [toolName, args] of [
    ['composio_execute_tool', { tool_slug: 'ACME_GET_RESOURCE', arguments: '{"id":"next-input"}' }],
    ['call_tool', read],
    ['call_tool', { name: 'call_tool', args_json: JSON.stringify(read) }],
    ['work_call', read],
    ['mcp__fixture__get_resource', { id: 'next-input' }],
    ['run_shell_command', { command: 'cat /tmp/fixture-input.txt' }],
  ] as const) assert.equal(planModeCallRefusal({ mode: { version: 1, kind: 'plan' }, identity, toolName, args, attestedEffect: 'read' }), undefined, toolName);
  // Removing the read allowance never admits a write, even on a long turn.
  assert.match(planModeCallRefusal({ mode: { version: 1, kind: 'plan' }, identity, toolName: 'space_save', args: {}, attestedEffect: 'local_write' }) ?? '', /PLAN_MODE_READ_ONLY/);
});
