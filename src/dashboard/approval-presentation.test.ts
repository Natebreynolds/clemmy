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

test('a content fingerprint is left out of the card; one plain line says the version is locked', async () => {
  const { detailLinesFor } = await import('./approval-presentation.js');
  const lines = detailLinesFor({
    workspaceId: 'fixture-workspace',
    runner: 'refresh.mjs',
    sourceDigest: '8a0e902258ec55766e93f65a892f9360f2d47681f290ea9415a2f149c0ffee01',
    scriptSha256: 'sha256:02a43064b823687f3695a795ef82823169e36bee267e9aa49eb1afc0ffee0123',
  });
  assert.equal(lines.some((line) => /[0-9a-f]{32}/i.test(line.value)), false, 'no digest is shown');
  assert.deepEqual(lines.map((line) => line.label), ['Workspace id', 'Runner', 'Version check']);
  assert.equal(lines.at(-1)?.value, 'Locked to this exact version');
  assert.equal(detailLinesFor({ message: 'Hello' }).some((line) => line.label === 'Version check'), false, 'only when something was left out');
});
