import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyToMessages } from '../features/conversations/chat/conversation-history';
import type { Turn } from '../features/conversations/types';
import { acceptedApprovalControlResponse, reconcileApprovalDecisionAck, reconcileIdleChatEvent, settleApprovalDecisionControl, type ChatMessage } from './useChat';
import type { HarnessEvent } from './types';

const SESSION = 'desktop-approval-receipt-fixture';
const card: ChatMessage = { id: 'card', role: 'assistant', text: '', status: 'awaiting-approval',
  approval: { approvalId: 'apr-fixture', subject: 'Save the fixture draft' } };
const otherCard: ChatMessage = { ...card, id: 'other-card', approval: { ...card.approval!, approvalId: 'apr-other' } };
function receipt(decision: 'approve' | 'reject' = 'approve'): HarnessEvent {
  return { seq: 13, turn: 1, role: 'system', type: 'conversation_completed', sessionId: SESSION, data: {
    sourceUserSeq: 12, reply: 'Private host receipt with apr-fixture.',
    presentation: { version: 1, audience: 'user', phase: 'final', identity: { sessionId: SESSION, sourceUserSeq: 12, turn: 1 },
      status: 'done', kind: 'answer', text: 'Private host receipt with apr-fixture.', resumable: false },
    turnOutcome: { version: 2, status: 'done', resumable: false }, notice: { code: 'card_decision' },
    approvalDecisionAck: { version: 1, sourceUserSeq: 12, approvalId: 'apr-fixture', decision },
  } };
}
const owner: ChatMessage = { id: 'owner', role: 'assistant', text: 'Still checking the original fixture', status: 'thinking',
  acceptedSource: { sessionId: SESSION, sourceUserSeq: 10, turn: 1 },
  activity: [{ id: 'read', kind: 'tool', label: 'Reading the fixture', status: 'running' }] };
const steer: ChatMessage = { id: 'steer', role: 'user', text: 'Keep the attachment.', steer: 'pending', idempotencyKey: 'steer-fixture' };

test('desktop live and idle receipts decide the exact card without touching a live answer or queued steering', () => {
  for (const decision of ['approve', 'reject'] as const) {
    const event = receipt(decision);
    event.data!.liveApprovalControl = { version: 1, ownerAttemptId: 'original-fixture-owner', ownerSourceUserSeq: 10 };
    const before = [card, otherCard, owner, steer];
    const live = reconcileApprovalDecisionAck(before, event, SESSION)!;
    assert.equal(live.length, 4);
    assert.equal(live[0]?.approval?.resolution, decision === 'approve' ? 'approved' : 'declined');
    assert.equal(live[1], otherCard);
    assert.equal(live[2], owner);
    assert.equal(live[3], steer);
    const idle = reconcileIdleChatEvent(live, event, SESSION, false);
    assert.equal(idle.length, 4);
    assert.deepEqual(idle, live, 'idle observation and duplicate delivery do not append an acknowledgment');
  }
});

test('only an exact decision source placeholder is retired, and a missing card retains clean feedback once', () => {
  const own: ChatMessage = { id: 'decision-placeholder', role: 'assistant', text: '', status: 'thinking',
    acceptedSource: { sessionId: SESSION, sourceUserSeq: 12, turn: 1 } };
  const event = receipt();
  assert.deepEqual(reconcileApprovalDecisionAck([card, owner, own], event, SESSION)?.map(row => row.id), ['card', 'owner']);
  const absent = reconcileApprovalDecisionAck([owner, own], event, SESSION)!;
  assert.deepEqual(absent.map(row => row.text), [owner.text, 'Approved.']);
  assert.equal(reconcileApprovalDecisionAck(absent, event, SESSION)?.length, 2);
  assert.equal(reconcileApprovalDecisionAck([card], { ...event, sessionId: 'another-session' }, SESSION), null);
});

test('an accepted control POST binds only its exact local presentation and cannot adopt execution authority', () => {
  const response = { sessionId: SESSION, streamUrl: '/fixture/events', status: 'completed', mode: 'approval-control',
    clientRequestId: 'exact-fixture-request', sinceSeq: 11, sourceUserSeq: 12 };
  const source = acceptedApprovalControlResponse(response, 'exact-fixture-request', SESSION)!;
  assert.deepEqual(source, { sessionId: SESSION, sourceUserSeq: 12 });
  for (const change of [{ clientRequestId: 'other-request' }, { mode: 'resuming' }, { status: 'started' },
    { sourceUserSeq: 11 }, { sourceUserSeq: undefined }, { sinceSeq: undefined }, { sessionId: 'other-session' }]) {
    assert.equal(acceptedApprovalControlResponse({ ...response, ...change }, 'exact-fixture-request', SESSION), null);
  }
  const local: ChatMessage = { id: 'local-control', role: 'assistant', text: '', status: 'thinking', approvalControlSource: source };
  assert.deepEqual(reconcileApprovalDecisionAck([card, owner, local], receipt(), SESSION)?.map(row => row.id), ['card', 'owner']);
  const control = { assistantId: local.id, ...source };
  const exact = { sessionId: SESSION, activeAssistantId: local.id, callbackAssistantId: local.id, control };
  let settled = 0;
  assert.equal(settleApprovalDecisionControl(receipt(), exact, () => { settled += 1; }), true);
  assert.equal(settled, 1);
  for (const altered of [{ ...exact, activeAssistantId: 'newer-human' }, { ...exact, callbackAssistantId: 'old-callback' },
    { ...exact, control: { ...control, sourceUserSeq: 99 } }, { ...exact, executionAssistantId: local.id },
    { ...exact, sessionId: 'other-session' }, { ...exact, control: null }]) {
    assert.equal(settleApprovalDecisionControl(receipt(), altered, () => { settled += 1; }), false);
  }
  assert.equal(settled, 1, 'stale control callbacks cannot clear a human owner or newer Stop target');
});

test('changed cards, genuine questions, real execution answers and failed decisions remain visible', () => {
  const changed: ChatMessage = { ...card, approval: { ...card.approval!, resolution: 'changed' } };
  const late = reconcileApprovalDecisionAck([changed], receipt(), SESSION)!;
  assert.equal(late[0], changed);
  assert.equal(late[1]?.text, 'Approved.');
  for (const [status, kind, text] of [
    ['done', 'answer', 'The draft for apr-fixture is saved and verified.'],
    ['needs_input', 'question', 'Which fixture account?'],
    ['failed', 'answer', 'The fixture could not be saved.'],
  ] as const) {
    const event = receipt();
    event.data = { ...event.data, notice: undefined, reply: text,
      presentation: { ...(event.data!.presentation as object), status, kind, text },
      turnOutcome: { version: 2, status, resumable: status === 'needs_input' } };
    const own: ChatMessage = { ...owner, id: 'result', acceptedSource: { sessionId: SESSION, sourceUserSeq: 12, turn: 1 } };
    assert.equal(reconcileApprovalDecisionAck([card, own], event, SESSION), null);
    const rows = reconcileIdleChatEvent([card, own], event, SESSION);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.text, text);
    assert.equal(rows[0], card);
  }
});

function historyAck(decision: 'approve' | 'reject' = 'approve'): Turn {
  const event = receipt(decision);
  return { role: 'assistant', text: 'Private host receipt with apr-fixture.', createdAt: '2026-10-15T00:00:00Z',
    terminal: { ...event.data, terminalSeq: event.seq } } as Turn;
}
const historyCard: Turn = { role: 'assistant', text: '', createdAt: '2026-10-15T00:00:00Z',
  approval: { approvalId: 'apr-fixture', subject: 'Save the fixture draft' } };

test('desktop reopen folds only exact receipts into the matching card and retains an absent-card fallback', () => {
  for (const decision of ['approve', 'reject'] as const) {
    const rows = historyToMessages([historyCard, historyAck(decision)]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.approval?.resolution, decision === 'approve' ? 'approved' : 'declined');
    const absent = historyToMessages([historyAck(decision)]);
    assert.equal(absent.length, 1);
    assert.equal(absent[0]?.text, decision === 'approve' ? 'Approved.' : 'Declined.');
  }
  for (const resolution of ['approved', 'declined', 'changed', 'expired']) {
    assert.equal(historyToMessages([{ ...historyCard, approval: { ...historyCard.approval!, resolution } }])[0]?.approval?.resolution, resolution);
  }
});

test('reopen preserves useful answers and rejects copied or mismatched receipt bindings', () => {
  const real: Turn = { role: 'assistant', text: 'The fixture attachment is saved.', createdAt: '2026-10-15T00:00:00Z',
    files: [{ name: 'fixture.txt', dir: 'fixtures' }] };
  const bad = historyAck();
  (bad.terminal as Record<string, unknown>).sourceUserSeq = 99;
  const rows = historyToMessages([historyCard, bad, real]);
  assert.equal(rows.length, 3, 'an invalid receipt is not silently discarded');
  assert.equal(rows[0]?.approval?.resolution, undefined);
  assert.equal(rows[2]?.text, real.text);
  assert.equal(rows[2]?.activity?.[0]?.deliverable?.name, 'fixture.txt');
});
