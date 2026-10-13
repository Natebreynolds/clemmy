/**
 * Run: npx tsx --test src/runtime/harness/stall-retry-directive.test.ts
 *
 * A stall retry is the harness correcting the model, never the owner speaking.
 * Pins: the retry instruction reaches the model as transient system context
 * for that one request, the model-visible user item is a plain continuation,
 * no owner-authored row carries the instruction, and the memory store and the
 * profile are exactly what they were before the retry.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-stall-retry-directive-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
// Legacy terminate-on-stall path with one retry, deterministic same-family
// judging, and the event-based tool counter for scripted runners (the same
// pins loop.test.ts uses for its stall mechanics).
process.env.HARNESS_STALL_ASK_USER = 'off';
process.env.HARNESS_MAX_STALL_RETRIES = '1';
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
process.env.HARNESS_TOOL_BRACKETS = 'off';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AgentInputItem, Runner } from '@openai/agents';

const { listEvents } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runConversation } = await import('./loop.js');
const { openMemoryDb } = await import('../../memory/db.js');
const { loadUserProfile } = await import('../user-profile.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;

after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

// The stall retry's own sentences, as buildStallRetryMessage authors them.
const STALL_INSTRUCTION = [/did not make progress on the directive/i, /was prose, not an action/i, /MUST call a tool now/i];
const carriesStallInstruction = (text: string): boolean => STALL_INSTRUCTION.some((pattern) => pattern.test(text));

function itemText(item: unknown): string {
  const content = (item as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join(' ');
}
const roleOf = (item: unknown): string | undefined => (item as { role?: string }).role;

test('a stall retry carries its instruction as transient system context and leaves memory and the profile untouched', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const profileBefore = loadUserProfile();
  const memory = openMemoryDb();
  const countRows = (table: string): number => (memory.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const candidatesBefore = countRows('memory_reflection_candidates');
  const factsBefore = countRows('consolidated_facts');

  const requests: AgentInputItem[][] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
    // Observe exactly what the model would see: the transient per-request
    // context is applied by the same input filter the SDK invokes.
    const filter = opts.callModelInputFilter as (args: { modelData: { input: AgentInputItem[]; instructions?: string } }) =>
      Promise<{ input: AgentInputItem[] }> | { input: AgentInputItem[] };
    const sent = await filter({ modelData: { input: items, instructions: '' } });
    requests.push(sent.input);
    return {
      history: [],
      lastResponseId: undefined,
      // A generic acknowledgement with zero tools is the stall; the retry answers.
      finalOutput: requests.length === 1 ? 'OK.' : 'Which sheet should I add the rows to?',
    };
  };
  await runConversation({
    agent: {} as never,
    sessionId: sess.id,
    input: 'do work',
    makeRunner: () => new EventEmitter() as unknown as Runner,
    runRunner,
  });

  assert.ok(listEvents(sess.id, { types: ['stall_retry_attempted'] }).length >= 1, 'the first reply stalled and a retry ran');
  assert.ok(requests.length >= 2, 'the retry reached the model');
  const retry = requests[1]!;
  const userItems = retry.filter((item) => roleOf(item) === 'user');
  assert.ok(userItems.length > 0, 'the retry still has a user item');
  for (const item of userItems) {
    assert.equal(carriesStallInstruction(itemText(item)), false, 'no user item carries the stall instruction');
  }
  assert.ok(
    retry.some((item) => roleOf(item) === 'system' && carriesStallInstruction(itemText(item))),
    'the stall instruction rides as system context for that request',
  );
  assert.equal(
    requests[0]!.some((item) => carriesStallInstruction(itemText(item))), false,
    'the instruction is for the retry only',
  );

  // Durable owner rows carry the owner's words only.
  for (const row of listEvents(sess.id, { types: ['user_input_received'] })) {
    assert.equal(carriesStallInstruction(String(row.data.text ?? '')), false, `row ${row.seq} is not a harness instruction`);
  }
  assert.equal(listEvents(sess.id, { types: ['memory_signals_captured'] }).length, 0, 'nothing was captured from the retry');

  // Memory and profile: untouched.
  assert.equal(countRows('memory_reflection_candidates'), candidatesBefore);
  assert.equal(countRows('consolidated_facts'), factsBefore);
  for (const [table, column] of [['memory_reflection_candidates', 'text'], ['consolidated_facts', 'content']] as const) {
    const rows = memory.prepare(`SELECT ${column} AS value FROM ${table}`).all() as Array<{ value: string }>;
    for (const row of rows) assert.equal(carriesStallInstruction(row.value), false, `${table} holds no harness instruction`);
  }
  assert.deepEqual(loadUserProfile(), profileBefore);
});
