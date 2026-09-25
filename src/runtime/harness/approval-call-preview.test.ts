/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approval-call-preview.test.ts
 *
 * Live 2026-09-25: two Slack approvals read "Slack open dm" and "Send Slack
 * message". The message text sat in the frozen arguments and never reached the
 * card, and the owner approved without knowing what.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-preview-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { approvalCallPreview } = await import('./loop.js');
const { projectHarnessEventForPublic } = await import('./public-presentation.js');

test.after(() => rmSync(HOME, { recursive: true, force: true }));

const message = 'You\'re on the 4:15–4:45 PM review today. Would you be willing to run that one on your own?';
function workCall(slug: string, args: Record<string, unknown>) {
  return {
    toolName: 'work_call',
    rawArgs: '{}',
    args: {
      requirement_id: `cap:resolved:${slug.toLowerCase()}`,
      name: 'composio_execute_tool',
      args_json: JSON.stringify({ tool_slug: slug, arguments: JSON.stringify(args) }),
    },
  };
}

test('an approval shows the operation and every argument it would send, message text whole', () => {
  const send = approvalCallPreview(workCall('SLACK_SEND_MESSAGE', { channel: 'D0FIXTURE1', markdown_text: message }));
  assert.ok(send);
  assert.match(send!.operation, /slack/i);
  assert.deepEqual(send!.fields, [
    { name: 'channel', value: 'D0FIXTURE1' },
    { name: 'markdown_text', value: message },
  ]);
  const open = approvalCallPreview(workCall('SLACK_OPEN_DM', { users: 'U0FIXTURE1' }));
  assert.deepEqual(open?.fields, [{ name: 'users', value: 'U0FIXTURE1' }]);
});

test('a secret-looking value is withheld, long text is bounded, empty values are skipped', () => {
  const preview = approvalCallPreview(workCall('SLACK_SEND_MESSAGE', {
    channel: 'C1', markdown_text: 'token xoxb-1234567890-abcdefghij', blocks: [], thread_ts: '',
    note: 'x'.repeat(2_500),
  }));
  assert.deepEqual(preview?.fields.map((field) => field.name), ['channel', 'markdown_text', 'note']);
  assert.equal(preview?.fields[1]?.value, '[withheld: looks like a secret]');
  assert.match(preview?.fields[2]?.value ?? '', /… \(500 more characters\)$/);
});

test('a local tool shows its own arguments; a malformed carrier shows nothing', () => {
  const local = approvalCallPreview({ toolName: 'send_note', rawArgs: '{}', args: { to: 'team@example.com', body: 'Thanks all' } });
  assert.deepEqual(local, { operation: 'send_note', fields: [{ name: 'to', value: 'team@example.com' }, { name: 'body', value: 'Thanks all' }] });
  assert.equal(approvalCallPreview({ toolName: 'work_call', rawArgs: '{}', args: { name: 'composio_execute_tool' } }), null);
});

test('the public approval event carries a well-formed preview and drops a malformed one', () => {
  const preview = { operation: 'Send Slack message', fields: [{ name: 'markdown_text', value: message }] };
  const event = (data: Record<string, unknown>) => ({ id: 'e', seq: 1, sessionId: 's', turn: 1, role: 'Clem',
    type: 'approval_requested', createdAt: new Date().toISOString(),
    data: { approvalId: 'apr-1', subject: 'Send Slack message', tool: 'work_call', ...data } });
  const shown = projectHarnessEventForPublic(event({ preview }) as never);
  assert.deepEqual((shown?.data as Record<string, unknown> | undefined)?.preview, preview);
  const malformed = projectHarnessEventForPublic(event({ preview: { operation: 'x', fields: [{ name: 1, value: 'y' }] } }) as never);
  assert.equal((malformed?.data as Record<string, unknown> | undefined)?.preview, undefined);
});
