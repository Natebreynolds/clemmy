/**
 * Run: npx tsx --test src/agents/workflow-step-recall.test.ts
 *
 * R1 — an UNBOUND workflow step inherits the "Remembered Tool Choices" recall that
 * chat already gets (so it uses the proven tool for the step's intent). A step whose
 * allowedTools LOCK the surface does NOT get the recall (its tool is already chosen).
 * Isolated CLEMENTINE_HOME so seeding the tool-choice store never touches real state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-step-recall-'));

const { buildWorkflowStepAgent } = await import('./workflow-step-agent.js');
const { rememberToolChoice } = await import('../memory/tool-choice-store.js');

const INTENT = 'scrape competitor pricing pages for a pricing analysis';
const instr = async (a: { instructions?: unknown }): Promise<string> => {
  if (typeof a.instructions === 'function') {
    return String(await (a.instructions as (ctx: unknown, agent: unknown) => unknown)({ context: {} }, a));
  }
  return String(a.instructions ?? '');
};

test('an UNBOUND step surfaces the remembered tool; a LOCKED step does not', async () => {
  rememberToolChoice({
    intent: INTENT,
    choice: { kind: 'composio', identifier: 'FIRECRAWL_SCRAPE', testedAt: new Date().toISOString(), testEvidence: 'returned markdown' },
  });

  const unbound = await buildWorkflowStepAgent({ userInput: INTENT, lockTools: ['*'] });
  const locked = await buildWorkflowStepAgent({ userInput: INTENT, lockTools: ['GMAIL_SEND_EMAIL'] });

  assert.match(await instr(unbound), /FIRECRAWL_SCRAPE/, 'the unbound step sees the proven tool for its intent');
  assert.doesNotMatch(await instr(locked), /FIRECRAWL_SCRAPE/, 'a surface-locked step is not given the recall noise');
});

test('a step with NO userInput gets the plain static instructions (no store read)', async () => {
  const a = await buildWorkflowStepAgent({ lockTools: ['*'] });
  assert.doesNotMatch(await instr(a), /FIRECRAWL_SCRAPE/);
});
