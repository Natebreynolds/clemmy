/**
 * Run: npx tsx --test src/runtime/harness/prompt-composition.test.ts
 *
 * These pins protect a MEASUREMENT, and the thing a measurement has to be is
 * honest about the right quantity. The tempting reading of a 753k-token prompt
 * is "make it smaller"; under prompt caching that is half wrong and the wrong
 * half costs money and speed, because a small VARYING prefix re-pays in full
 * while a large STABLE one is served warm. So the split — not the total — is
 * what these hold.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-prompt-comp-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'comp-machine\n');

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { summarizePromptComposition } = await import('./prompt-composition.js');

after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('identity and tool schemas are STABLE; the per-turn packet is VARIABLE', () => {
  const s = summarizePromptComposition({
    instructions: 'who she is, '.repeat(500),
    contextPacket: 'capability facts for this turn, '.repeat(50),
    currentMessage: 'finalize the airtable base',
    toolNames: ['tool_search', 'memory_recall_all', 'ask_user_question'],
  });
  const byName = Object.fromEntries(s.buckets.map((b) => [b.name, b.stability]));
  assert.equal(byName.instructions, 'stable', 'persona must be cacheable — large is fine when invariant');
  assert.equal(byName.toolSchemas, 'stable', 'a stable tool surface is the point of monotonic JIT');
  assert.equal(byName.contextPacket, 'variable', 'the preflight packet is rebuilt every turn');
  assert.equal(byName.currentMessage, 'variable');
});

test('tool schemas are counted — an unmeasured cost is an unmanaged one', () => {
  const withoutTools = summarizePromptComposition({ instructions: 'x '.repeat(100) });
  const withTools = summarizePromptComposition({
    instructions: 'x '.repeat(100),
    toolNames: Array.from({ length: 40 }, (_, i) => `tool_${i}`),
  });
  assert.equal(withoutTools.toolCount, 0);
  assert.equal(withTools.toolCount, 40);
  assert.ok(withTools.totalTokens > withoutTools.totalTokens,
    'advertising 40 schemas cannot be free in the accounting');
});

test('stableShare is the actionable number: a fat variable layer drags it down', () => {
  const disciplined = summarizePromptComposition({
    instructions: 'stable core, '.repeat(1000),
    currentMessage: 'do the thing',
  });
  const undisciplined = summarizePromptComposition({
    instructions: 'stable core, '.repeat(1000),
    contextPacket: 'rebuilt every single turn, '.repeat(1000),
    currentMessage: 'do the thing',
  });
  assert.ok(disciplined.stableShare > 0.9, 'a small variable layer keeps the prefix warm');
  assert.ok(undisciplined.stableShare < disciplined.stableShare,
    'a large per-turn block is exactly what the number must expose');
});

test('the summary is pure observation — it reports, it never rewrites', () => {
  const instructions = 'persona text';
  const packet = 'turn facts';
  const s = summarizePromptComposition({ instructions, contextPacket: packet, currentMessage: 'hi' });
  // Nothing here may mutate or truncate what is being measured.
  assert.equal(instructions, 'persona text');
  assert.equal(packet, 'turn facts');
  assert.equal(s.stableTokens + s.variableTokens, s.totalTokens, 'the split must account for the whole');
  assert.deepEqual([...s.buckets].sort((a, b) => b.tokens - a.tokens), s.buckets, 'largest first, so the cut is obvious');
});

test('an empty turn measures nothing rather than inventing a reading', () => {
  const s = summarizePromptComposition({});
  assert.equal(s.totalTokens, 0);
  assert.equal(s.stableShare, 0);
  assert.deepEqual(s.buckets, []);
});
