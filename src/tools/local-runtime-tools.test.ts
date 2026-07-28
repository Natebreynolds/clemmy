/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-local-tools npx tsx --test src/tools/local-runtime-tools.test.ts
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { RunContext } from '@openai/agents';

const TEST_HOME = '/tmp/clemmy-test-local-tools';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  getLocalToolCatalog,
  getLocalRuntimeTools,
  recoverMemoryRememberRequiredPrefix,
  describeInvalidToolInput,
  buildLocalToolErrorFunction,
} = await import('./local-runtime-tools.js');

test('invalid tool input returns the violated paths and a tool_search pointer, never a blind retry prompt', async () => {
  const { z } = await import('zod');
  const schema = z.strictObject({
    slug: z.string(),
    data_sources: z.array(z.object({ id: z.string(), runner_path: z.string() })),
  });
  const parsed = schema.safeParse({ slug: 'proof-cockpit', data_sources: [{ id: 1 }], extra_key: true });
  assert.equal(parsed.success, false);
  const invalidInput = {
    name: 'InvalidToolInputError',
    originalError: parsed.success ? undefined : parsed.error,
    toolInvocation: { input: '{"slug":"proof-cockpit"' },
  };

  const guidance = describeInvalidToolInput(invalidInput, 'space_save');
  assert.ok(guidance);
  assert.match(guidance!, /space_save/);
  assert.match(guidance!, /data_sources/);
  assert.match(guidance!, /tool_search/);

  const errorFunction = buildLocalToolErrorFunction({
    name: 'space_save',
    description: 'test',
    parameters: {},
    handler: async () => { throw new Error('handler must not run on input errors'); },
  });
  const message = await errorFunction(undefined, Object.assign(new Error('Invalid JSON input for tool'), invalidInput));
  // Keeps the SDK default prefix (failure detection keys on it) AND adds guidance.
  assert.match(message, /^An error occurred while running the tool/);
  assert.match(message, /did not match its schema/);
  assert.match(message, /tool_search/);

  // A plain execution error keeps the exact SDK default shape — no guidance.
  const executionMessage = await errorFunction(undefined, new Error('disk full'));
  assert.equal(executionMessage, 'An error occurred while running the tool. Please try again. Error: Error: disk full');

  // Unparseable JSON (no zod issues) gets the single-escaping guidance.
  const parseGuidance = describeInvalidToolInput(
    { name: 'InvalidToolInputError', originalError: new SyntaxError('Unexpected token') },
    'space_save',
  );
  assert.ok(parseGuidance);
  assert.match(parseGuidance!, /not parseable JSON/);
});

test('local tool catalog is the exact loaded surface without schemas', () => {
  const tools = getLocalRuntimeTools();
  const catalog = getLocalToolCatalog();
  assert.equal(catalog.length, tools.length);
  assert.deepEqual(
    catalog.map((entry) => entry.name),
    tools.map((entry) => entry.name),
  );
  assert.ok(catalog.every((entry) => typeof entry.description === 'string'));
});

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
    'pending_action_queue',
    'pending_action_list',
    'pending_action_get',
    'pending_action_execute',
    'pending_action_record_result',
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
    'check_capability',
    'mcp_status',
    'mcp_list_tools',
    'harness_status',
  ]) {
    assert.equal(names.has(required), true, `expected local runtime tool ${required}`);
  }
});

test('memory input recovery salvages only a complete safe kind/content prefix', () => {
  const raw = '{"kind":"project","content":"The Falcon codeword is \\"tangerine-osprey-42\\".",'
    + '"entities":null,"relationships":[{"validFrom":"2026-07-26\'}]}garbage';
  const recovered = recoverMemoryRememberRequiredPrefix({
    name: 'InvalidToolInputError',
    toolInvocation: { input: raw },
  });
  assert.deepEqual(recovered, {
    kind: 'project',
    content: 'The Falcon codeword is "tangerine-osprey-42".',
  });

  assert.equal(recoverMemoryRememberRequiredPrefix({
    name: 'InvalidToolInputError',
    toolInvocation: { input: '{"kind":"constraint","content":"Never send mail from prod",' },
  }), null, 'hard constraints are never recovered from partial input');
  assert.equal(recoverMemoryRememberRequiredPrefix({
    name: 'InvalidToolInputError',
    toolInvocation: { input: '{"kind":"project","content":"unterminated' },
  }), null, 'an incomplete required field is never guessed');
});

test('memory_remember executes once from a valid prefix when optional annotations are malformed', async () => {
  const memoryTool = getLocalRuntimeTools()
    .find((candidate) => (candidate as { name?: string }).name === 'memory_remember');
  assert.ok(memoryTool && memoryTool.type === 'function');
  const marker = `Recovered memory marker ${Date.now()}-falcon.`;
  const malformed = JSON.stringify({ kind: 'project', content: marker }).slice(0, -1)
    + ',"entities":null,"relationships":[{"validFrom":"2026-07-26\'}]}garbage';

  const output = await memoryTool.invoke(
    new RunContext({ sessionId: 'local-runtime-memory-recovery' }),
    malformed,
  );
  assert.match(String(output), /Remembered|Reinforced an existing fact|Already known/);
  assert.match(String(output), /Recovered valid kind\/content/);
  assert.doesNotMatch(String(output), /InvalidToolInputError/);
});
