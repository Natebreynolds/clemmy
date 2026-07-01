/**
 * Run: npx tsx --test src/channels/slack-harness.test.ts
 *
 * Deterministic, network-free tests of the Slack glue: the markdown→mrkdwn
 * translator, the Block Kit approval buttons, and the live-edit transport
 * driven against a fake WebClient (no Slack, no LLM, no credentials).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toSlackMrkdwn, approvalBlocksForState, buildSlackHarnessTransport, slackHarnessConversationId } from './slack-harness.js';
import type { DisplayState } from './discord-harness.js';

function state(partial: Partial<DisplayState>): DisplayState {
  return { summary: '', status: 'thinking', done: false, toolsCalled: [], toolCount: 0, ...partial };
}

test('slackHarnessConversationId isolates threads inside the same Slack channel', () => {
  assert.equal(slackHarnessConversationId('C123'), 'C123');
  assert.equal(slackHarnessConversationId('C123', ''), 'C123');
  assert.equal(slackHarnessConversationId('C123', '1717000000.000100'), 'C123:1717000000.000100');
  assert.notEqual(
    slackHarnessConversationId('C123', '1717000000.000100'),
    slackHarnessConversationId('C123', '1717000000.000200'),
  );
});

test('toSlackMrkdwn: converts bold, headings, links, and bullets', () => {
  assert.equal(toSlackMrkdwn('**bold**'), '*bold*');
  assert.equal(toSlackMrkdwn('__also bold__'), '*also bold*');
  assert.equal(toSlackMrkdwn('## Heading'), '*Heading*');
  assert.equal(toSlackMrkdwn('[Clementine](https://example.com)'), '<https://example.com|Clementine>');
  assert.equal(toSlackMrkdwn('* item'), '• item');
});

test('toSlackMrkdwn: leaves plain text and dash bullets intact', () => {
  assert.equal(toSlackMrkdwn('just text'), 'just text');
  assert.equal(toSlackMrkdwn('- already a bullet'), '- already a bullet');
  assert.equal(toSlackMrkdwn(''), '');
});

test('approvalBlocksForState: null when nothing pending', () => {
  assert.equal(approvalBlocksForState(state({})), null);
});

test('approvalBlocksForState: single approval → approve/edit/reject', () => {
  const blocks = approvalBlocksForState(state({ pendingApprovalId: 'apr-1' }));
  assert.ok(blocks);
  const elements = (blocks![0] as { elements: Array<{ action_id: string; text: { text: string } }> }).elements;
  const ids = elements.map((e) => e.action_id);
  assert.deepEqual(ids, ['clementine:approve:apr-1', 'clementine:edit:apr-1', 'clementine:reject:apr-1']);
});

test('approvalBlocksForState: multiple approvals → approve-all/reject-all, no edit', () => {
  const blocks = approvalBlocksForState(state({ pendingApprovalIds: ['apr-1', 'apr-2', 'apr-3'] }));
  const elements = (blocks![0] as { elements: Array<{ action_id: string; text: { text: string } }> }).elements;
  assert.equal(elements.length, 2, 'no Edit button for batch approvals');
  assert.ok(elements[0].text.text.includes('Approve all 3'));
  assert.ok(elements[1].text.text.includes('Reject all 3'));
});

test('buildSlackHarnessTransport: posts a placeholder then live-edits via update', async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const fakeClient = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => { calls.push({ method: 'postMessage', args }); return { ts: '111.222' }; },
      update: async (args: Record<string, unknown>) => { calls.push({ method: 'update', args }); return {}; },
    },
  };
  const transport = buildSlackHarnessTransport({ client: fakeClient as never, channel: 'C123', threadTs: '999.000' });

  const handle = await transport.sendInitial('**starting**');
  assert.equal(calls[0].method, 'postMessage');
  assert.equal(calls[0].args.channel, 'C123');
  assert.equal(calls[0].args.thread_ts, '999.000');
  assert.equal(calls[0].args.text, '*starting*', 'markdown translated to mrkdwn');

  // Edit with no components → text only, blocks cleared.
  await handle.edit('progress…');
  assert.equal(calls[1].method, 'update');
  assert.equal(calls[1].args.ts, '111.222');
  assert.deepEqual(calls[1].args.blocks, []);

  // Edit with approval components → section + the actions block.
  const approvalBlocks = approvalBlocksForState(state({ pendingApprovalId: 'apr-9' }))!;
  await handle.edit('please approve', { components: approvalBlocks });
  const last = calls[2].args;
  const blocks = last.blocks as Array<{ type: string }>;
  assert.equal(blocks[0].type, 'section', 'body section prepended so the user sees the reply');
  assert.equal(blocks[1].type, 'actions', 'approval buttons attached after the body');
});

test('buildSlackHarnessTransport: buildApprovalComponents hook mirrors approvalBlocksForState', () => {
  const transport = buildSlackHarnessTransport({ client: {} as never, channel: 'C1' });
  assert.equal(transport.buildApprovalComponents!(state({})), null);
  const blocks = transport.buildApprovalComponents!(state({ pendingApprovalId: 'apr-7' }));
  assert.ok(blocks && blocks.length === 1);
});
