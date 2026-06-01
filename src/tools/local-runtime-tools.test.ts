/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-local-tools npx tsx --test src/tools/local-runtime-tools.test.ts
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-local-tools';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { getLocalRuntimeTools } = await import('./local-runtime-tools.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

function toolNames(): Set<string> {
  return new Set(
    getLocalRuntimeTools()
      .map((tool) => (tool as unknown as { name?: string }).name)
      .filter((name): name is string => Boolean(name)),
  );
}

test('local runtime tools include autonomy, execution, run tracking, and profile surfaces', () => {
  const names = toolNames();
  for (const required of [
    'ask_user_question',
    'notify_user',
    'share_plan',
    'execution_update_step',
    'execution_complete',
    'execution_pause',
    'execution_resume',
    'execution_focus',
    'execution_clear_focus',
    'agent_runs_recent',
    'background_tasks_recent',
    'background_task_status',
    'user_profile_read',
    'user_profile_update',
    'check_capability',
    'list_capabilities',
    'mcp_status',
  ]) {
    assert.equal(names.has(required), true, `expected local runtime tool ${required}`);
  }
});
