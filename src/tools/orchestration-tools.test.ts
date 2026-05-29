/**
 * Run: npx tsx --test src/tools/orchestration-tools.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-orchestration-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { registerOrchestrationTools } = await import('./orchestration-tools.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('./shared.js');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const handlers = new Map<string, ToolHandler>();
registerOrchestrationTools({
  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
  },
} as never);

function resetState(): void {
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
}

function workflowRun(): ToolHandler {
  const handler = handlers.get('workflow_run');
  assert.ok(handler, 'workflow_run registered');
  return handler;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text).join('\n');
}

function writeAuditWorkflow(): void {
  writeWorkflow('proposal-audit-brief', {
    name: 'proposal-audit-brief',
    description: 'Generate an audit brief from a URL.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'normalize_input',
        prompt: 'Normalize the prospect. Required input: {{url}}. If missing, stop with status=blocked.',
      },
    ],
  });
}

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  resetState();
});

test('workflow_run rejects missing required legacy template inputs without queueing', async () => {
  writeAuditWorkflow();

  const result = await workflowRun()({ name: 'proposal-audit-brief', inputs: {} });
  const text = resultText(result);

  assert.match(text, /was not queued/);
  assert.match(text, /"url"/);
  assert.throws(() => readdirSync(WORKFLOW_RUNS_DIR), /ENOENT/);
});

test('workflow_run queues with normalized URL aliases', async () => {
  writeAuditWorkflow();

  const result = await workflowRun()({
    name: 'proposal-audit-brief',
    inputs: { website: ' https://www.aldouslaw.com/ ' },
  });
  const text = resultText(result);

  assert.match(text, /Queued workflow "proposal-audit-brief"/);
  const files = readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'));
  assert.equal(files.length, 1);
  const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, files[0]), 'utf-8')) as {
    inputs: Record<string, string>;
  };
  assert.equal(run.inputs.url, 'https://www.aldouslaw.com/');
  assert.equal(run.inputs.website, 'https://www.aldouslaw.com/');
});

test('workflow_run does not queue duplicate active runs for identical inputs', async () => {
  writeAuditWorkflow();

  const first = await workflowRun()({
    name: 'proposal-audit-brief',
    inputs: { url: 'https://www.aldouslaw.com/' },
  });
  assert.match(resultText(first), /Queued workflow/);

  const second = await workflowRun()({
    name: 'proposal-audit-brief',
    inputs: { url: 'https://www.aldouslaw.com/' },
  });
  assert.match(resultText(second), /already queued/);
  assert.match(resultText(second), /No duplicate was queued/);

  const files = readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'));
  assert.equal(files.length, 1);
});
