import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLiveApprovalControl } from './live-approval-control.js';
import { ChatEngine, foldTranscript, inFlightTurnSince } from './engine.js';
import { reduceActivity } from './reduce-activity.js';
import type { HarnessEvent } from './types.js';
import type { StreamTransport } from './stream.js';

const marker = { version: 1, ownerAttemptId: 'attempt:mobile:live-owner', ownerSourceUserSeq: 10 };
const event = (seq: number, type: string, data: Record<string, unknown> = {}): HarnessEvent => ({ seq, type, sessionId: 'owner-session', data });
const source = event(10, 'user_input_received', { text: 'Prepare the exact plan', taskMode: { version: 1, kind: 'plan' } });
const control = event(12, 'user_input_received', { text: 'Approve apr-exact.', synthetic: true, liveApprovalControl: marker });
const acknowledgement = event(13, 'conversation_completed', { sourceUserSeq: 12, reply: 'Approved.', liveApprovalControl: marker, presentation: { identity: { sessionId: 'owner-session', sourceUserSeq: 12 }, status: 'done', resumable: false } });
const final = event(14, 'conversation_completed', { sourceUserSeq: 10, reply: 'The original work finished.', presentation: { status: 'done', resumable: false } });

test('only a structurally valid public control relationship changes presentation scope', () => {
  assert.deepEqual(readLiveApprovalControl(control), marker);
  assert.deepEqual(readLiveApprovalControl(acknowledgement), marker);
  for (const altered of [
    { ...marker, version: 2 }, { ...marker, ownerAttemptId: '' },
    { ...marker, ownerSourceUserSeq: 0 }, { ...marker, ownerSourceUserSeq: 12 },
  ]) assert.equal(readLiveApprovalControl({ ...acknowledgement, data: { ...acknowledgement.data, liveApprovalControl: altered } }), null);
  assert.equal(readLiveApprovalControl(event(12, 'user_input_received', { text: 'Approve', liveApprovalControl: marker })), null);
  assert.equal(readLiveApprovalControl({ ...acknowledgement, data: { ...acknowledgement.data, sourceUserSeq: 20, presentation: { identity: { sessionId: 'owner-session', sourceUserSeq: 20 } } } }), null);
  assert.equal(readLiveApprovalControl({ ...acknowledgement, seq: 12 }), null);
  assert.equal(readLiveApprovalControl({ ...acknowledgement, data: { ...acknowledgement.data, turnOutcome: { status: 'failed' } } }), null);
  assert.equal(readLiveApprovalControl({ ...acknowledgement, data: { ...acknowledgement.data, presentation: { identity: { sessionId: 'other-session', sourceUserSeq: 12 }, status: 'done' } } }), null);
  assert.equal(readLiveApprovalControl({ ...acknowledgement, data: { ...acknowledgement.data, presentation: { identity: { sessionId: 'owner-session', sourceUserSeq: 11 }, status: 'done' } } }), null);
  assert.deepEqual(readLiveApprovalControl({ ...acknowledgement, data: { ...acknowledgement.data, turnOutcome: { status: 'done' } } }), marker);
  assert.equal(readLiveApprovalControl(event(13, 'tool_returned', { sourceUserSeq: 12, liveApprovalControl: marker })), null);
});

test('replay retains the original mode and activity; the control ack is a separate row', () => {
  const write = event(11, 'external_write', { callId: 'write-owner', tool: 'OUTLOOK_CREATE_DRAFT' });
  const prefix = [source, write, control, acknowledgement];
  assert.equal(inFlightTurnSince(prefix), 9);
  assert.equal(inFlightTurnSince([...prefix, final]), null);
  const activity = reduceActivity([], write);
  assert.equal(reduceActivity(activity, acknowledgement), activity);
  const rows = foldTranscript([...prefix, final]);
  assert.equal(rows.filter(row => row.role === 'user').length, 1);
  assert.equal(rows.find(row => row.id === 'control-ack-13')?.text, 'Approved.');
  const owner = rows.find(row => row.text === 'The original work finished.');
  assert.equal(owner?.taskMode?.kind, 'plan');
  assert.equal(owner?.activity?.filter(item => item.write?.callId === 'write-owner').length, 1);
});

test('live acknowledgement does not close the stream, replace active mode or release busy work', async () => {
  let live: Parameters<StreamTransport['connect']>[0] | undefined;
  let closes = 0;
  const transport: StreamTransport = {
    connect: async input => { live = input; queueMicrotask(() => input.onReplay({ events: [] })); return { close: () => { closes += 1; } }; },
    fetchRecent: async () => ({ events: [] }),
  };
  const engine = new ChatEngine({ transport, api: {
    send: async () => ({ sessionId: 'owner-session', accepted: true }),
    loadSession: async () => ({ events: [], latestSeq: 0 }),
  } });
  try {
    await engine.send('Prepare the exact plan', { version: 1, kind: 'plan' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(live);
    live.onEvent(source);
    live.onEvent(control);
    live.onEvent(acknowledgement);
    live.onEvent(acknowledgement); // SSE reconnect replay is idempotent.
    assert.equal(engine.snapshot().busy, true);
    assert.equal(engine.snapshot().activeTaskMode?.kind, 'plan');
    assert.equal(engine.snapshot().messages.filter(row => row.id === 'control-ack-13').length, 1);
    assert.equal(closes, 0);
    live.onEvent(final);
    assert.equal(engine.snapshot().busy, false);
    assert.equal(engine.snapshot().messages.find(row => row.text === 'The original work finished.')?.taskMode?.kind, 'plan');
  } finally { engine.dispose(); }
});
