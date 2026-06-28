/**
 * Run: npx tsx --test src/channels/slack-assistant.test.ts
 *
 * The native AI-Assistant pane's premium touch is the live "Clem is …" status.
 * deriveAssistantStatus maps the harness DisplayState to that one-line status,
 * and the assistant transport's onState pushes it to assistant.threads.setStatus
 * (deduped, never throwing). These pin both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebClient } from '@slack/web-api';
import { deriveAssistantStatus, buildSlackAssistantTransport, renderAssistantProgress } from './slack-harness.js';
import type { DisplayState } from './discord-harness.js';

function state(partial: Partial<DisplayState>): DisplayState {
  return { summary: '', status: '', done: false, toolsCalled: [], toolCount: 0, ...partial };
}

function mockClient() {
  const calls = { post: [] as Array<Record<string, unknown>>, update: [] as Array<Record<string, unknown>> };
  let n = 0;
  const client = {
    chat: {
      postMessage: async (a: Record<string, unknown>) => { calls.post.push(a); n += 1; return { ts: `T${n}` }; },
      update: async (a: Record<string, unknown>) => { calls.update.push(a); return {}; },
    },
  } as unknown as WebClient;
  return { client, calls };
}

// The regression that broke live delivery: the runner delivers the FINAL answer
// through handle.edit() at finalFlush() — it never calls onState with done=true
// (settle() bypasses it). A no-op edit() dropped the answer, freezing the message
// at "thinking…". This pins the real runner sequence: sendInitial → flush
// (onState + handle.edit) → finalFlush (handle.edit only, with state.done flipped
// in place on the SAME object onState captured).
test('assistant transport: ONE message, progress edits it, final answer is delivered via handle.edit', async () => {
  const { client, calls } = mockClient();
  const t = buildSlackAssistantTransport({ client, channel: 'C1', threadTs: 'TH', setStatus: async () => {} });

  const handle = await t.sendInitial('🍊 starting…');           // posts the one message
  const live = state({ currentAgent: 'Clem', status: 'searching the web', toolsCalled: ['web_search'], toolCount: 1 });
  t.onState!(live);                                              // runner flush: capture state…
  await handle.edit('_Clem · working_', {});                    // …then handle.edit (progress)

  // finalFlush: runner mutates the SAME state object then calls handle.edit only.
  live.done = true;
  live.summary = "Here's your plate right now: 3 things need you.";
  await handle.edit("Here's your plate right now: 3 things need you.", {});
  await new Promise((r) => setTimeout(r, 5));

  // Exactly one message ever posted (no double), and it was edited (not re-posted).
  assert.equal(calls.post.length, 1, 'exactly one postMessage');
  assert.ok(calls.update.length >= 1, 'the message is edited in place');
  // The progress edit rendered the RICH play-by-play (not the runner's raw text).
  assert.ok(calls.update.some((u) => String(u.text).includes('web search')), 'rich progress streamed');
  // The FINAL edit carries the real answer — the bug was this never landing.
  assert.match(String(calls.update[calls.update.length - 1].text), /Here's your plate right now/);
});

test('assistant transport: a run that ends with NO progress flush still delivers the answer', async () => {
  // Edge: instant completion — settle()→finalFlush() with onState never having run.
  const { client, calls } = mockClient();
  const t = buildSlackAssistantTransport({ client, channel: 'C1', setStatus: async () => {} });
  const handle = await t.sendInitial('🍊 starting…');
  await handle.edit('Quick answer, no tools.', {});            // latestState null → render verbatim
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.post.length, 1);
  assert.match(String(calls.update[calls.update.length - 1].text), /Quick answer/);
});

test('done clears the status (pane settles on the answer)', () => {
  assert.equal(deriveAssistantStatus(state({ done: true, status: 'wrapping up' })), '');
});

test('pending approval shows a clear waiting line', () => {
  assert.equal(deriveAssistantStatus(state({ pendingApprovalIds: ['apr-1'] })), 'is waiting for your approval…');
  assert.equal(deriveAssistantStatus(state({ pendingApprovalId: 'apr-2' })), 'is waiting for your approval…');
});

test('agent + detail, detail-only, agent-only, tool, and idle all render sensible lines', () => {
  assert.equal(deriveAssistantStatus(state({ currentAgent: 'Researcher', status: 'searching the web' })), 'Researcher: searching the web');
  assert.equal(deriveAssistantStatus(state({ status: 'verifying numbers' })), 'verifying numbers');
  assert.equal(deriveAssistantStatus(state({ currentAgent: 'Writer' })), 'Writer is working…');
  assert.equal(deriveAssistantStatus(state({ toolsCalled: ['dataforseo__labs_ranked_keywords'] })), 'is using labs ranked keywords…');
  assert.equal(deriveAssistantStatus(state({})), 'is thinking…');
});

test('status lines are bounded (Slack status is a short line)', () => {
  const long = 'x'.repeat(400);
  assert.ok(deriveAssistantStatus(state({ status: long })).length <= 100);
});

test('assistant transport keeps the native status STABLE (no per-step flicker) and never throws', async () => {
  const calls: string[] = [];
  const t = buildSlackAssistantTransport({
    client: {} as unknown as WebClient,
    channel: 'C1',
    setStatus: async (s: string) => { calls.push(s); },
  });
  // Per-step detail (status/agent/tool) must NOT churn the native indicator —
  // the rich play-by-play lives in the message, the status stays steady.
  t.onState!(state({ status: 'searching the web' }));
  t.onState!(state({ status: 'verifying numbers' }));   // detail changed → still "is working…"
  t.onState!(state({ currentAgent: 'Writer', toolsCalled: ['web_search'] }));
  // An approval pause is the one working-state transition worth surfacing.
  t.onState!(state({ pendingApprovalIds: ['apr-1'] }));
  t.onState!(state({ done: true }));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, ['is working…', 'is waiting for your approval…', '']);
});

test('renderAssistantProgress streams the rich play-by-play (agent, detail, tools, count)', () => {
  const body = renderAssistantProgress(state({
    currentAgent: 'Researcher',
    status: 'searching the web',
    toolsCalled: ['dataforseo__labs_ranked_keywords', 'web_search'],
    toolCount: 5,
  }));
  assert.match(body, /🍊/);
  assert.match(body, /\*Researcher\*/);          // current agent is the headline
  assert.match(body, /searching the web/);        // what she's doing
  assert.match(body, /`labs ranked keywords`/);   // the actual tools, prettified
  assert.match(body, /`web search`/);
  assert.match(body, /5 tools/);                  // counter once 3+ tools fired
});

test('renderAssistantProgress has a sensible default and caps the tool list at 8', () => {
  assert.match(renderAssistantProgress(state({})), /🍊 \*Clem is working…\*/);
  const many = Array.from({ length: 20 }, (_, i) => `tool_${i}`);
  const body = renderAssistantProgress(state({ toolsCalled: many, toolCount: 20 }));
  const shown = (body.match(/`/g) ?? []).length / 2; // each shown tool is wrapped in a pair of backticks
  assert.ok(shown <= 8, `expected ≤8 tools shown, got ${shown}`);
  assert.match(body, /`tool 19`/); // shows the most recent, not the oldest (prettyTool strips underscores)
});

test('onState swallows a throwing setStatus (progress must never break the run)', () => {
  const t = buildSlackAssistantTransport({
    client: {} as unknown as WebClient,
    channel: 'C1',
    setStatus: () => { throw new Error('slack 429'); },
  });
  assert.doesNotThrow(() => t.onState!(state({ status: 'x' })));
});
