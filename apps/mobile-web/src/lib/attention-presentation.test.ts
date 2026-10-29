import assert from 'node:assert/strict';
import test from 'node:test';
import { listAttentionPresentations, presentInboxAttention, type AttentionItem, type AttentionPresentationItem, type InboxNotification, type QuestionPresentationItem } from './api';
import { attentionFallbackRows, matchesSavedAttention, restoreSavedAttention, sameAttentionReceipt, savedAttentionItems } from './attention-presentation';

const lifecycle = { canDismiss: true, canDefer: true, effect: 'hide_only' as const, dismissLabel: 'Dismiss', deferLabel: 'Tomorrow', generation: 'generation-visible', explanation: 'The work is unchanged.' };
const attention: AttentionPresentationItem = { key: 'calendar:account|invite|meeting / one', kind: 'calendar', title: 'Choose a time for the review',
  detail: 'Two recorded times overlap.', createdAt: '2026-10-29T17:00:00Z', lifecycle, action: 'dismiss', generation: lifecycle.generation, mutationToken: 'new-choice' };

test('generic attention sends exact calendar identities and fences changed or malformed restore receipts', async () => {
  const savedFetch = globalThis.fetch;
  const savedWindow = globalThis.window;
  const requests: Array<{ path: string; body: Record<string, unknown>; cache?: RequestCache }> = [];
  const events: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (event: Event) => { events.push(event.type); return true; } } });
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ path: String(input), body, cache: init?.cache });
    if (body.mutationToken === 'stale-choice') return Response.json({ error: 'The attention setting changed.' }, { status: 409 });
    if (body.generation === 'unexpected-response') return Response.json({ ok: true, key: body.key, action: body.action, generation: 'different-generation', mutationToken: 'new-choice' });
    return Response.json({ ok: true, key: body.key, action: body.action, generation: body.generation, mutationToken: 'new-choice' });
  };
  try {
    const receipt = await presentInboxAttention(attention.key, 'dismiss', lifecycle.generation);
    assert.deepEqual(requests[0], { path: '/m/api/inbox/attention/presentation', body: { key: attention.key, action: 'dismiss', generation: lifecycle.generation }, cache: undefined });
    await restoreSavedAttention({ source: 'attention', id: receipt.key, generation: receipt.generation, mutationToken: receipt.mutationToken });
    assert.deepEqual(requests[1]?.body, { key: attention.key, action: 'restore', generation: lifecycle.generation, mutationToken: 'new-choice' });
    assert.equal(events.length, 2);
    await assert.rejects(presentInboxAttention(attention.key, 'restore', lifecycle.generation, 'stale-choice'), (error: unknown) => (error as { status: number }).status === 409);
    await assert.rejects(presentInboxAttention(attention.key, 'dismiss', 'unexpected-response'), /could not confirm/);
    assert.equal(events.length, 2, 'refused or mismatched changes cannot publish a successful count refresh');
    const before = requests.length;
    await assert.rejects(presentInboxAttention(attention.key, 'restore', lifecycle.generation), /Refresh Inbox/);
    await assert.rejects(presentInboxAttention(attention.key, 'dismiss', ''), /Refresh Inbox/);
    assert.equal(requests.length, before, 'missing authority is rejected before sending');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: savedWindow });
  }
});

test('generic recovery is a fresh authenticated read and retains the exact server receipt', async () => {
  const savedFetch = globalThis.fetch;
  let observed: { path: string; cache?: RequestCache } | null = null;
  globalThis.fetch = async (input, init) => { observed = { path: String(input), cache: init?.cache }; return Response.json({ items: [attention], count: 1 }); };
  try {
    const result = await listAttentionPresentations();
    assert.deepEqual(observed, { path: '/m/api/inbox/attention/presentation', cache: 'no-store' });
    assert.deepEqual(result.items[0], attention);
  } finally { globalThis.fetch = savedFetch; }
});

test('question and generic recovery retain distinct identities, searchable context and exact undo generations', () => {
  const question = { id: 'task:question-one', question: 'Which version should I use?', context: 'Project Cedar', askedAt: '2026-10-29T18:00:00Z',
    source: 'background_task', agentLabel: 'Researcher', sessionId: 'session-one', action: 'defer', until: '2026-10-30T15:00:00Z', generation: 'question-generation', mutationToken: 'question-choice' } as QuestionPresentationItem;
  const rows = savedAttentionItems([question], [attention]);
  assert.equal(rows[0]?.source, 'question');
  assert.equal(rows[1]?.source, 'attention');
  assert.equal(rows[1]?.id, attention.key);
  assert.equal(rows[1]?.title, attention.title);
  assert.ok(matchesSavedAttention(rows[0]!, 'later', 'cedar version'));
  assert.ok(matchesSavedAttention(rows[1]!, 'dismissed', 'calendar overlap'));
  assert.equal(matchesSavedAttention(rows[1]!, 'later', ''), false);
  const receipt = rows[1]!;
  assert.equal(sameAttentionReceipt(receipt, { ...receipt }), true);
  assert.equal(sameAttentionReceipt({ ...receipt, mutationToken: 'another-device' }, receipt), false);
  assert.equal(sameAttentionReceipt({ ...receipt, generation: 'revised-item' }, receipt), false);
  assert.equal(sameAttentionReceipt({ ...receipt, source: 'question' }, receipt), false);
});

test('canonical fallback items remain reachable beyond the notification cap without duplicate counts', () => {
  const flow: AttentionItem = { ...attention, key: 'flow:controlled-review', kind: 'workflow', title: 'Review stopped work' };
  const notice = { id: 'notice-one', needsYouKey: flow.key, context: { actionItemId: null } } as InboxNotification;
  const rows = attentionFallbackRows([flow, attention, attention], [notice], [
    { key: flow.key, kind: 'workflow_paused', title: flow.title, detail: '' },
  ]);
  assert.deepEqual(rows.map(row => row.key), [attention.key]);
  assert.equal(rows[0]?.lifecycle?.generation, lifecycle.generation);
  assert.equal(rows[0]?.kind, 'attention');
  assert.equal(rows[0]?.title, attention.title);
});
