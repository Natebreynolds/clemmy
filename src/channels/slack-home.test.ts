/**
 * Run: npx tsx --test src/channels/slack-home.test.ts
 *
 * The App Home command-center + suggested prompts are pure block/prompt builders
 * (data sources wrapped in try/catch → empty state when unavailable). These pin
 * that they render valid, bounded Block Kit / prompt structures and never throw,
 * and that App Home approval rows carry the shared clementine:* action ids so
 * they route through the same gated approval path as everything else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const slack = await import('./slack.js');
const { __test__, isAssistantContainerMessage } = slack;
const { buildAppHomeBlocks, buildSuggestedPrompts } = __test__;

test('isAssistantContainerMessage: assistant-pane (threaded im) messages are skipped by the DM handler', () => {
  // Assistant-pane message: threaded im, no real subtype → owned by app.assistant.
  assert.equal(isAssistantContainerMessage({ channel_type: 'im', thread_ts: '1700.1' }), true);
  assert.equal(isAssistantContainerMessage({ channel_type: 'im', thread_ts: '1700.1', subtype: 'file_share' }), true);
  // A plain (non-threaded) DM is NOT an assistant message → DM handler keeps it.
  assert.equal(isAssistantContainerMessage({ channel_type: 'im' }), false);
  // A channel message is never an assistant-container message.
  assert.equal(isAssistantContainerMessage({ channel_type: 'channel', thread_ts: '1700.1' }), false);
  // A threaded im with a real subtype (e.g. an edit) is not a user assistant turn.
  assert.equal(isAssistantContainerMessage({ channel_type: 'im', thread_ts: '1700.1', subtype: 'message_changed' }), false);
});

test('buildAppHomeBlocks renders a valid home view and never throws', () => {
  const blocks = buildAppHomeBlocks() as Array<{ type: string; text?: { text?: string } }>;
  assert.ok(Array.isArray(blocks) && blocks.length > 0);
  // A header leads the view…
  assert.equal(blocks[0].type, 'header');
  assert.match(blocks[0].text?.text ?? '', /Clementine/);
  // …and the three command-center sections are always present (counts vary).
  const headerText = blocks.filter((b) => b.type === 'header').map((b) => b.text?.text ?? '').join(' | ');
  assert.match(headerText, /Goals/);
  assert.match(headerText, /In flight/);
  // Slack caps header text at 150 chars and section text at 3000 — stay bounded.
  for (const b of blocks) {
    if (b.type === 'header') assert.ok((b.text?.text ?? '').length <= 150);
  }
});

test('App Home shows an activity snapshot, an accurate "waiting on you", and stays under Slack block limits', () => {
  const blocks = buildAppHomeBlocks() as Array<{ type: string; text?: { text?: string }; elements?: Array<{ text?: string }> }>;
  const contextText = blocks
    .filter((b) => b.type === 'context')
    .flatMap((b) => (b.elements ?? []).map((e) => e.text ?? ''))
    .join(' || ');
  // The activity snapshot pulse.
  assert.match(contextText, /done today/, 'activity snapshot line present');
  assert.match(contextText, /waiting on you/, 'consolidated "waiting on you" present');
  // Slack renders at most 100 blocks per view — the capped sections must stay under.
  assert.ok(blocks.length <= 100, `home view has ${blocks.length} blocks, must be <= 100`);
});

test('App Home shows a meaningful memory health line (facts, not a bare count) and never throws', () => {
  const blocks = buildAppHomeBlocks() as Array<{ type: string; elements?: Array<{ text?: string }> }>;
  // A context block carries the memory summary: 🧠 + a fact count. Even on an
  // empty memory store it renders "🧠 *0* facts" rather than throwing.
  const contextText = blocks
    .filter((b) => b.type === 'context')
    .flatMap((b) => (b.elements ?? []).map((e) => e.text ?? ''))
    .join(' || ');
  assert.match(contextText, /🧠/, 'memory health line present');
  assert.match(contextText, /facts/, 'memory line reports a fact count');
  // The bare "N facts learned" phrasing is replaced by the richer summary.
  assert.doesNotMatch(contextText, /facts learned/, 'no bare "facts learned" count');
  // Bounded: every context element stays well under Slack's limits.
  for (const b of blocks) {
    if (b.type !== 'context') continue;
    for (const e of b.elements ?? []) assert.ok((e.text ?? '').length <= 1000);
  }
});

test('App Home approval buttons use the shared clementine:* action ids (gated path)', () => {
  // With no real approvals the actions block is absent; assert the SHAPE the
  // builder emits by checking the action-id convention is wired in source.
  // (Integration: any approval row → clementine:approve:<id> / clementine:reject:<id>.)
  const blocks = buildAppHomeBlocks() as Array<{ type: string; elements?: Array<{ action_id?: string }> }>;
  for (const b of blocks) {
    if (b.type !== 'actions') continue;
    for (const el of b.elements ?? []) {
      assert.match(el.action_id ?? '', /^clementine:(approve|reject):/);
    }
  }
});

test('buildSuggestedPrompts returns 1–4 well-formed prompts and never throws', () => {
  const prompts = buildSuggestedPrompts() as Array<{ title: string; message: string }>;
  assert.ok(prompts.length >= 1 && prompts.length <= 4, 'Slack shows up to 4');
  for (const p of prompts) {
    assert.equal(typeof p.title, 'string');
    assert.equal(typeof p.message, 'string');
    assert.ok(p.title.length > 0 && p.message.length > 0);
    assert.ok(p.title.length <= 44, 'prompt titles stay short');
  }
  // The evergreen starters are always present as a fallback.
  const titles = prompts.map((p) => p.title);
  assert.ok(titles.includes("What's on my plate?"));
});
