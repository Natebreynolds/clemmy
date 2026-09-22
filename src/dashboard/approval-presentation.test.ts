/**
 * Run: npx tsx --test src/dashboard/approval-presentation.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentApprovalForHumans, unwrapApprovalCall } from './approval-presentation.js';

const workCall = {
  requirement_id: 'cap:resolved:slack_send_message:definition:1d9e',
  universe_item_id: null,
  name: 'composio_execute_tool',
  args_json: JSON.stringify({ tool_slug: 'SLACK_SEND_MESSAGE', arguments: JSON.stringify({ channel: 'U0123456', text: 'Clementine desktop mirror test 16:29 UTC. Nothing else.', markdown_text: 'Clementine desktop mirror test 16:29 UTC. Nothing else.' }) }),
};

test('a work_call → composio send unwraps to the provider arguments, named in words', () => {
  const p = presentApprovalForHumans({ tool: 'work_call', args: workCall, subject: 'Send Slack message' });
  assert.equal(p.operation, 'SLACK_SEND_MESSAGE');
  assert.equal(p.unwrapped, true);
  assert.match(p.action, /^Send message via \w+$/);
  const labels = p.details.map((d) => d.label);
  assert.deepEqual(labels.slice(0, 1), ['Channel']);
  assert.ok(p.details.some((d) => d.label === 'Text' && d.value.startsWith('Clementine desktop mirror test')));
  assert.ok(!JSON.stringify(p.details).includes('requirement_id'), 'no carrier fields reach the reviewer');
});

test('a direct composio call and a local tool present too; unknown shapes fall back to a details line', () => {
  const direct = presentApprovalForHumans({ tool: 'composio_execute_tool', args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@x.example', subject: 'Hi', body: 'x'.repeat(200) } } });
  assert.equal(direct.operation, 'GMAIL_SEND_EMAIL');
  assert.equal(direct.details.find((d) => d.label === 'Body')?.long, true);
  assert.equal(direct.details[direct.details.length - 1].label, 'Body', 'long text last');
  const local = presentApprovalForHumans({ tool: 'write_file', args: { path: '/tmp/a.txt', content: 'hello' } });
  assert.equal(local.action, 'Write file');
  assert.equal(local.unwrapped, false);
  assert.deepEqual(local.details.map((d) => `${d.label}=${d.value}`), ['Path=/tmp/a.txt', 'Content=hello']);
  const odd = presentApprovalForHumans({ tool: 'x', args: 'plain text', subject: 'Do it' });
  assert.deepEqual(odd.details, [{ label: 'Details', value: 'plain text', long: false }]);
  assert.deepEqual(unwrapApprovalCall('work_call', { name: 'read_file', args_json: '{"path":"/p"}' }), { tool: 'read_file', args: { path: '/p' }, unwrapped: true });
});
