/**
 * Run: npx tsx --test src/tools/vault-tools.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-vault-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerVaultTools } = await import('./vault-tools.js');
const { TASKS_FILE, ensureTasksFile } = await import('./shared.js');

const EXECUTIONS_FILE = path.join(TMP_HOME, 'state', 'executions.json');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test.beforeEach(() => {
  mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
  writeFileSync(EXECUTIONS_FILE, '[]', 'utf-8');
  ensureTasksFile();
});

function registeredToolHandlers(): Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const server = {
    tool(name: string, ...args: unknown[]) {
      const handler = args.at(-1);
      if (typeof handler !== 'function') throw new Error(`tool ${name} missing handler`);
      handlers.set(name, handler as (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>);
    },
  };
  registerVaultTools(server as never);
  return handlers;
}

function seedTaskList(): void {
  writeFileSync(
    TASKS_FILE,
    [
      '---',
      'type: tasks',
      '---',
      '',
      '# Tasks',
      '',
      '## Pending',
      '',
      '- [ ] {T-001} Fresh high-priority follow-up !!high',
      '- [ ] {T-002} Medium-priority backlog item !!medium',
      '',
      '## Completed',
      '',
      '- [x] {T-003} Completed today !!high',
      '- [x] {T-004} Old completed item !!high',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function seedExecutionMetadata(): void {
  const now = new Date().toISOString();
  const old = '2000-01-01T00:00:00.000Z';
  const base = {
    sessionId: 'sess-vault-tools',
    userId: 'user-test',
    channel: 'test',
    title: 'task metadata',
    objective: 'task metadata',
    reason: 'test',
    confidence: 0.9,
    reasons: ['test'],
    startedFromMessage: 'test',
    lastActivityAt: now,
  };
  writeFileSync(
    EXECUTIONS_FILE,
    JSON.stringify([
      {
        ...base,
        id: 'exec-new',
        status: 'completed',
        createdAt: now,
        updatedAt: now,
        taskBindings: [
          { taskId: 'T-003', description: 'Completed today', status: 'completed', createdAt: now, completedAt: now },
        ],
      },
      {
        ...base,
        id: 'exec-old',
        status: 'completed',
        createdAt: old,
        updatedAt: old,
        lastActivityAt: old,
        taskBindings: [
          { taskId: 'T-004', description: 'Old completed item', status: 'completed', createdAt: old, completedAt: old },
        ],
      },
    ], null, 2),
    'utf-8',
  );
}

test('task_list supports priority and since filters used by daily workflows', async () => {
  seedTaskList();
  seedExecutionMetadata();
  const handler = registeredToolHandlers().get('task_list');
  assert.ok(handler, 'task_list should be registered');

  const pendingHigh = await handler({ status: 'pending', priority: 'high' });
  assert.match(pendingHigh.content[0].text, /T-001/);
  assert.doesNotMatch(pendingHigh.content[0].text, /T-002/);
  assert.match(pendingHigh.content[0].text, /priority=high/);

  const completedToday = await handler({ status: 'completed', priority: 'high', since: 'today' });
  assert.match(completedToday.content[0].text, /T-003/);
  assert.doesNotMatch(completedToday.content[0].text, /T-004/);
  assert.match(completedToday.content[0].text, /since filtering uses execution task-binding timestamps/);
});

test('task_hygiene is exposed as a dry-run cleanup tool for workflows', async () => {
  seedTaskList();
  seedExecutionMetadata();
  const handler = registeredToolHandlers().get('task_hygiene');
  assert.ok(handler, 'task_hygiene should be registered');

  const result = await handler({});
  assert.match(result.content[0].text, /Task ledger hygiene \(dry-run\)/);
  assert.match(result.content[0].text, /Repaired:/);
});
