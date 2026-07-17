/**
 * Run: npx tsx --test src/assistant/instructions-learned.test.ts
 *
 * Learned-context placement + tiered-context (north-star: lean, cacheable prompt).
 *  - `renderLearnedBlocks` is the shared helper both assemblers use.
 *  - With tiered context OFF (default): the chat instructions carry the dynamic
 *    blocks inline (legacy), and the turn-context tail is empty.
 *  - With tiered context ON: the stable Constitution (voice + reasoning + SOUL)
 *    stays in `instructions`, and the DYNAMIC blocks (facts, tool-choices,
 *    working-memory) move to the per-turn input tail (buildTurnContextBlock).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-instr-learned-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryContext } from '../types.js';

const { buildAssistantInstructions, buildTurnContextBlock } = await import('./instructions.js');
const { renderLearnedBlocks } = await import('../agents/harness-context.js');
const { rememberToolChoice } = await import('../memory/tool-choice-store.js');
const { rememberFact, setFactPinned, renderFactsForInstructions } = await import('../memory/facts.js');

function installSkill(name: string, description: string): void {
  const dir = path.join(TMP_HOME, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), [
    '---', `name: ${name}`, `description: ${description}`, '---', '', 'Full body is loaded only by skill_read.',
  ].join('\n'));
}

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
  delete process.env.CLEMMY_TIERED_CONTEXT;
});

const ctx: MemoryContext = { soul: 'Clementine is sharp and proactive.', identity: 'I am Clementine.', memory: '', workingMemory: '' } as MemoryContext;

test('renderLearnedBlocks returns section-wrapped Remembered Tool Choices + Recently Learned', () => {
  rememberToolChoice({
    intent: 'outlook.send_email',
    description: 'Send an Outlook email.',
    choice: { kind: 'composio', identifier: 'OUTLOOK_OUTLOOK_SEND_EMAIL' },
  });
  const { recentlyLearned, toolChoices } = renderLearnedBlocks('send an outlook email');
  assert.match(toolChoices, /## Remembered Tool Choices/, 'tool-choices block is section-wrapped');
  assert.match(toolChoices, /OUTLOOK_OUTLOOK_SEND_EMAIL/, 'the proven tool is present');
  assert.equal(typeof recentlyLearned, 'string', 'recently-learned is always a string (may be empty), never throws');
});

test('tiered OFF (default): dynamic blocks inline in instructions; turn-context tail empty', () => {
  delete process.env.CLEMMY_TIERED_CONTEXT;
  const out = buildAssistantInstructions(ctx, 'dashboard', 'action', 'send an outlook email');
  assert.match(out, /Core Personality/, 'SOUL present');
  assert.match(out, /Persistent Facts|Data Landscape|Connected Tools/, 'dynamic/legacy blocks inline when off');
  assert.equal(buildTurnContextBlock(ctx, 'action', 'send an outlook email'), '', 'no turn-context tail when off');
});

test('tiered ON: Constitution (voice+reasoning+SOUL) stays in instructions; dynamic context moves to the tail', () => {
  process.env.CLEMMY_TIERED_CONTEXT = 'on';
  try {
    const instr = buildAssistantInstructions(ctx, 'dashboard', 'action', 'send an outlook email');
    // Tier-1 always present (personality + reasoning never stripped):
    assert.match(instr, /Core Personality/, 'SOUL stays in the cached instructions');
    assert.match(instr, /Ask ONE clarifying question/, 'reasoning rules stay in instructions');
    // Dynamic blocks are NOT in the instructions prefix anymore:
    assert.doesNotMatch(instr, /Remembered Tool Choices/, 'tool-choices left the cached prefix');
    assert.doesNotMatch(instr, /## Working Memory/, 'working-memory left the cached prefix');

    // …they ride the per-turn tail instead:
    const tail = buildTurnContextBlock(ctx, 'action', 'send an outlook email');
    assert.match(tail, /Context for this turn/, 'tail has the turn-context header');
    assert.match(tail, /Remembered Tool Choices/, 'learned tool-choices now in the tail');
    assert.match(tail, /OUTLOOK_OUTLOOK_SEND_EMAIL/, 'the proven tool reaches the model via the tail');
  } finally {
    delete process.env.CLEMMY_TIERED_CONTEXT;
  }
});

test('tiered prompt keeps skill discovery stable and injects only query-relevant summaries per turn', () => {
  installSkill('firm-document', 'Create polished Google Docs and Word document briefs for firms.');
  installSkill('calendar-operator', 'Schedule meetings and coordinate calendar availability.');
  process.env.CLEMMY_TIERED_CONTEXT = 'on';
  try {
    const instructions = buildAssistantInstructions(ctx, 'dashboard', 'action', 'Create a Google Doc about a firm.');
    assert.match(instructions, /## Skill Discovery/);
    assert.match(instructions, /skill_list\(\)/);
    assert.equal((instructions.match(/## Relevant Skills/g) ?? []).length, 0, 'tiered system prompt contains no per-turn skill menu');
    assert.doesNotMatch(instructions, /firm-document|calendar-operator/, 'installed names stay out of the cacheable prefix');

    const tail = buildTurnContextBlock(ctx, 'action', 'Create a Google Doc about a firm.');
    assert.match(tail, /## Relevant Skills/);
    assert.equal((tail.match(/## Relevant Skills/g) ?? []).length, 1, 'tiered turn context injects one relevant-skill menu');
    assert.doesNotMatch(tail, /## Skill Discovery/, 'tiered turn context does not repeat the stable discovery pointer');
    assert.match(tail, /firm-document/);
    assert.doesNotMatch(tail, /calendar-operator/);
    assert.match(tail, /skill_read/);
  } finally {
    delete process.env.CLEMMY_TIERED_CONTEXT;
  }

  const legacy = buildAssistantInstructions(ctx, 'dashboard', 'action', 'Create a Google Doc about a firm.');
  assert.equal((legacy.match(/## Relevant Skills/g) ?? []).length, 1, 'legacy unsplit prompt injects one relevant-skill menu');
  assert.equal(buildTurnContextBlock(ctx, 'action', 'Create a Google Doc about a firm.'), '', 'legacy path has no second turn-context injection');
});

test('renderFactsForInstructions mode split: pinned vs scored vs all', () => {
  const pin = rememberFact({ kind: 'feedback', content: 'ALWAYS keep replies terse — no bullet bloat.', importance: 9 });
  setFactPinned(pin.id, true);
  rememberFact({ kind: 'user', content: 'Nathan runs a coaching business in California.', importance: 6 });

  const pinned = renderFactsForInstructions(12, 800, undefined, 'pinned');
  const scored = renderFactsForInstructions(12, 1600, undefined, 'scored');
  const all = renderFactsForInstructions(12, 1600, undefined, 'all');

  assert.match(pinned, /Standing preferences/, 'pinned mode renders the typed standing-preferences section');
  assert.match(pinned, /terse/, 'pinned mode includes the pinned rule');
  assert.doesNotMatch(pinned, /coaching business/, 'pinned mode excludes scored facts');
  assert.doesNotMatch(scored, /Standing preferences/, 'scored mode excludes the pinned section');
  // Regression guard (review must-fix): a SALIENT pinned fact must not also leak
  // into the scored by-kind groups — that would double-send it (Tier-1 + Tier-2).
  assert.doesNotMatch(scored, /terse/, 'scored mode excludes the pinned fact CONTENT, not just its header');
  assert.match(scored, /coaching business/, 'scored mode still includes ordinary scored facts');
  assert.match(all, /Standing preferences/, 'all mode keeps both policy and scored context');
});

test('CANON-SELFASM: chat instructions carry the Now/date block (legacy mode)', () => {
  delete process.env.CLEMMY_TIERED_CONTEXT;
  const out = buildAssistantInstructions(ctx, 'dashboard', 'action', 'what should I do today');
  assert.match(out, /## Now/, 'chat now carries the Now block (was harness-only — chat did date math against the training cutoff)');
  assert.match(out, /Today is \d{4}-\d{2}-\d{2}/, 'the real current date is injected');
});

test('CANON-SELFASM: the kill-switch removes the parity blocks', () => {
  const prev = process.env.CLEMMY_CHAT_CONTEXT_PARITY;
  delete process.env.CLEMMY_TIERED_CONTEXT;
  try {
    process.env.CLEMMY_CHAT_CONTEXT_PARITY = 'off';
    const out = buildAssistantInstructions(ctx, 'dashboard', 'action', 'what should I do today');
    assert.doesNotMatch(out, /## Now/, 'flag off → no Now block (exact prior behavior)');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CHAT_CONTEXT_PARITY;
    else process.env.CLEMMY_CHAT_CONTEXT_PARITY = prev;
  }
});

test('CANON-SELFASM: in tiered mode the dynamic Now block rides the per-turn tail', () => {
  process.env.CLEMMY_TIERED_CONTEXT = 'on';
  try {
    const tail = buildTurnContextBlock(ctx, 'action', 'pull my accounts');
    assert.match(tail, /## Now/, 'Now rides the per-turn tail in tiered mode (it changes daily — must not be cached)');
  } finally {
    delete process.env.CLEMMY_TIERED_CONTEXT;
  }
});

test('Step 2: casual turn skips the tail BUT standing/pinned facts stay in Tier-1', () => {
  process.env.CLEMMY_TIERED_CONTEXT = 'on';
  try {
    // pinned fact created in the previous test persists in the shared temp store.
    const casualTail = buildTurnContextBlock(ctx, 'casual', 'hey');
    assert.match(casualTail, /memory_recall_all/, 'casual turn → unified-recall POINTER (insurance), not the heavy blocks');
    assert.doesNotMatch(casualTail, /## Working Memory|## Persistent Facts/, 'casual turn omits the heavy working blocks');
    assert.doesNotMatch(casualTail, /Remembered Tool Choices/, 'casual turn omits the inlined tool-choices');
    assert.match(buildTurnContextBlock(ctx, 'meta_clarify', 'what can you do'), /memory_recall_all/, 'meta turn → pointer too');

    const casualInstr = buildAssistantInstructions(ctx, 'dashboard', 'casual', 'hey');
    assert.match(casualInstr, /Standing preferences/, 'pinned facts present even on a casual turn (never dropped)');
    assert.match(casualInstr, /terse/, 'the durable standing rule survives the lean turn');

    // A working turn still gets the full tail.
    assert.notEqual(buildTurnContextBlock(ctx, 'action', 'pull my accounts'), '', 'action turn → non-empty tail');
  } finally {
    delete process.env.CLEMMY_TIERED_CONTEXT;
  }
});
