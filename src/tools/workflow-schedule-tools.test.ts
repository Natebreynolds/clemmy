/**
 * Run: npx tsx --test src/tools/workflow-schedule-tools.test.ts
 *
 * Proves workflow_schedule respects the same send/publish safety policy as
 * workflow_create: autonomous sends are allowed by default, but strict mode
 * requires an approval gate and disabled drafts can still be saved.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-schedule-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { registerWorkflowScheduleTools } = await import('./workflow-schedule-tools.js');
const { readWorkflow, writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const handlers = new Map<string, ToolHandler>();
registerWorkflowScheduleTools({
  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
  },
} as never);

function scheduleTool(): ToolHandler {
  const handler = handlers.get('workflow_schedule');
  assert.ok(handler, 'workflow_schedule registered');
  return handler;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text).join('\n');
}

beforeEach(() => {
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
});

test('enabled ungated-send schedule is saved DISABLED pending readiness answers', async () => {
  // Approval gates are opt-in (allowSends: true by default), but readiness
  // questions still keep unclear outbound sends from going live blind.
  const result = await scheduleTool()({
    name: 'midday-sender',
    description: 'Compose and send the outreach emails at midday.',
    cron: '0 12 * * *',
    instructions: 'Compose and send the outreach emails to the prospect list.',
    enabled: true,
    toolCall: null,
    timezone: null,
  });
  const text = resultText(result);
  assert.ok(/Created workflow/.test(text), `expected creation, got: ${text}`);
  assert.match(text, /Currently DISABLED/);
  assert.match(text, /outside world/);
  assert.match(text, /Workflow visual contract:/);
  const written = readWorkflow('midday-sender')?.data;
  assert.ok(written, 'workflow must be written');
  assert.equal(written.enabled, false);
});

test('strict send mode refuses a send-looking schedule without an approval gate', async () => {
  const result = await scheduleTool()({
    name: 'instagram-weekly-strict',
    description: 'Draft and post a weekly Instagram update for the firm.',
    cron: '0 10 * * 1',
    instructions: 'Draft and post the weekly Instagram content for the firm.',
    allowSends: false,
    requiresApproval: false,
    enabled: true,
    toolCall: null,
    timezone: null,
  });
  const text = resultText(result);
  assert.match(text, /NOT scheduled/);
  assert.match(text, /allowSends: false/);
  assert.equal(readWorkflow('instagram-weekly-strict'), null, 'invalid enabled strict workflow must not be written');
});

test('strict scheduled social workflow can be saved with a declarative approval gate', async () => {
  const result = await scheduleTool()({
    name: 'instagram-weekly-approved',
    description: 'Draft and post a weekly Instagram update for the firm.',
    cron: '0 10 * * 1',
    instructions: 'Draft and post the weekly Instagram content for the firm.',
    allowSends: false,
    requiresApproval: true,
    approvalPreview: 'Review the Instagram caption and creative before posting.',
    enabled: true,
    toolCall: null,
    timezone: null,
  });
  const text = resultText(result);
  assert.match(text, /Created workflow "instagram-weekly-approved"/);
  const written = readWorkflow('instagram-weekly-approved')?.data;
  assert.ok(written, 'workflow must be written');
  assert.equal(written.allowSends, false);
  assert.equal(written.steps[0].requiresApproval, true);
  assert.equal(written.steps[0].approvalPreview, 'Review the Instagram caption and creative before posting.');
});

test('workflow_schedule does NOT clobber an existing MULTI-step workflow — P1-8', async () => {
  // Seed a real 2-step pipeline.
  writeWorkflow('multi-pipe', {
    name: 'multi-pipe',
    description: 'two steps',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Pull the data.' },
      { id: 'summarize', prompt: 'Summarize {{steps.pull.output}}.', dependsOn: ['pull'] },
    ],
  });
  const result = await scheduleTool()({
    name: 'multi-pipe',
    description: 'two steps',
    cron: '0 9 * * *',
    instructions: 'Do the whole thing.',
    enabled: true,
    toolCall: null,
    timezone: null,
  });
  // Must refuse + redirect to workflow_update, and the pipeline must be intact.
  assert.match(resultText(result), /steps|workflow_update/i);
  const after = readWorkflow('multi-pipe')!.data;
  assert.equal(after.steps.length, 2, 'multi-step pipeline preserved, not clobbered to one step');
  assert.equal(after.steps[1].id, 'summarize');
});

test('same workflow saved DISABLED is allowed (drafting)', async () => {
  const result = await scheduleTool()({
    name: 'midday-sender-draft',
    description: 'Compose and send the outreach emails at midday.',
    cron: '0 12 * * *',
    instructions: 'Compose and send the outreach emails to the prospect list.',
    enabled: false,
    toolCall: null,
    timezone: null,
  });
  const text = resultText(result);
  assert.ok(!/NOT scheduled/.test(text), `expected save, got: ${text}`);
  assert.ok(readWorkflow('midday-sender-draft'), 'disabled draft must be written');
});

test('a clean research/report schedule is written and may surface gap questions', async () => {
  const result = await scheduleTool()({
    name: 'daily-digest',
    description: 'Summarize overnight signups every morning.',
    cron: '0 8 * * *',
    instructions: 'Summarize the overnight signups and notify Nate.',
    enabled: true,
    toolCall: null,
    timezone: null,
  });
  const text = resultText(result);
  assert.ok(/Created workflow "daily-digest"/.test(text), `expected create, got: ${text}`);
  assert.match(text, /Workflow visual contract:/);
  assert.ok(readWorkflow('daily-digest'), 'workflow must be written');
});
