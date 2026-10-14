import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { h } from 'preact';
import type { ChatMessage } from '@clem/chat-engine';
(globalThis as { React?: unknown }).React = { createElement: h };
const { SteerReceiptStatus } = await import('./SteerReceiptStatus.js');

test('phone steer presentation shows acknowledgement, adoption and unconfirmed ending without fulfillment claims', () => {
  const base: ChatMessage = { id: 'synthetic-note', role: 'user', text: 'Synthetic addition', steer: 'delivered' };
  const receipt = { version: 1 as const, sessionId: 'sess-phone-steer', sourceUserSeq: 10, noteSeq: 11, changedAtSeq: 11 };
  const cases: Array<[ChatMessage, string]> = [
    [{ ...base, steer: 'pending' }, 'Reaching her mid-run…'],
    [{ ...base, steerReceipt: { ...receipt, state: 'accepted' } }, 'Received for this run'],
    [{ ...base, steerReceipt: { ...receipt, state: 'adopted', changedAtSeq: 12 } }, 'Added to this run’s context'],
    [{ ...base, steerReceipt: { ...receipt, state: 'unhandled', changedAtSeq: 13 } }, 'Run ended — use of this addition wasn’t confirmed; your message is kept'],
  ];
  for (const [message, label] of cases) {
    const node = SteerReceiptStatus({ message });
    assert.equal(node?.props.children, label); assert.equal(node?.props.role, 'status');
    assert.doesNotMatch(String(node?.props.children), /queued|next step|completed/i);
  }
  assert.equal(SteerReceiptStatus({ message: { ...base, steer: undefined } }), null);
  const screen = readFileSync(new URL('../screens/Chat.tsx', import.meta.url), 'utf8');
  assert.match(screen, /<SteerReceiptStatus message=\{message\} \/>/, 'the actual phone user row mounts the status view');
});
