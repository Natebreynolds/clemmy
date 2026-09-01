/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-local-tools npx tsx --test src/tools/local-runtime-tools.test.ts
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { RunContext } from '@openai/agents';

const TEST_HOME = '/tmp/clemmy-test-local-tools';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  getLocalToolCatalog,
  getLocalRuntimeTools,
  recoverMemoryRememberRequiredPrefix,
  describeInvalidToolInput,
  buildLocalToolErrorFunction,
  buildScopedLocalToolSearch,
} = await import('./local-runtime-tools.js');
const { toolOutputContextFromSdk } = await import('../runtime/harness/tool-output-context.js');
const {
  InvalidArgumentsPreDispatchResult,
  attemptSignalsFromTypedResult,
} = await import('../runtime/harness/attempt-settlement.js');

test('OpenAI local-runtime context preserves the exact accepted source turn', () => {
  const context = toolOutputContextFromSdk(
    'workflow_run',
    new RunContext({ sessionId: 'local-source-authority', sourceUserSeq: 73 }),
    { toolCall: { call_id: 'call-source-authority' } },
  );
  assert.equal(context.sessionId, 'local-source-authority');
  assert.equal(context.sourceUserSeq, 73);
  assert.equal(context.callId, 'call-source-authority');
});

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

test('local runtime preserves file_query argument refusal as a nominal invalid-arguments carrier', async () => {
  const fileQuery = getLocalRuntimeTools()
    .find((candidate) => (candidate as { name?: string }).name === 'file_query');
  assert.ok(fileQuery && fileQuery.type === 'function');

  const output = await fileQuery.invoke(
    new RunContext({ sessionId: 'local-file-query-invalid-arguments' }),
    JSON.stringify({
      query: 'missing sources',
      file: null,
      call_id: null,
      top_k: null,
    }),
  );

  assert.ok(output instanceof InvalidArgumentsPreDispatchResult,
    'the adapter must not flatten the marked MCP refusal into success-shaped text');
  assert.equal(output.outcomeKind, 'invalid_arguments');
  assert.deepEqual(attemptSignalsFromTypedResult(output), {
    preDispatch: true,
    argumentValidationFailed: true,
    schemaAvailable: true,
  });
  assert.match(String(output), /pass exactly ONE of `file` \/ `call_id`/i,
    'the model-facing corrective text remains unchanged');
});

test('space_save collision is a no-effect invalid-arguments result and a new slug can commit once', async () => {
  const spaceSave = getLocalRuntimeTools()
    .find((candidate) => (candidate as { name?: string }).name === 'space_save');
  assert.ok(spaceSave && spaceSave.type === 'function');
  const store = await import('../spaces/store.js');
  const context = new RunContext({ sessionId: 'local-space-save-collision-repair' });
  const base = {
    title: 'Local LLM Content Calendar',
    objective: 'Create a cited calendar and five posts.',
    success_criteria: ['Exactly five posts'],
    invariants: ['Keep source citations'],
    view_html: '<html><body><h1>Local LLM calendar</h1></body></html>',
    view_path: null,
    data_sources: null,
    actions: null,
    reengage_triggers: null,
    reengage_guidance: null,
    origin_session_id: null,
  };
  const occupiedData = JSON.stringify({ posts: [{ id: 'existing' }] });
  const intendedData = JSON.stringify({
    posts: Array.from({ length: 5 }, (_, index) => ({ id: index + 1, body: `Post ${index + 1}` })),
  });

  const setup = await spaceSave.invoke(context, JSON.stringify({
    ...base,
    slug: 'occupied-content-calendar',
    initial_data_json: occupiedData,
  }));
  assert.match(String(setup), /Created workspace/);
  const occupiedBefore = readFileSync(store.resolveInSpace('occupied-content-calendar', 'data.json'), 'utf8');

  const collision = await spaceSave.invoke(context, JSON.stringify({
    ...base,
    slug: 'occupied-content-calendar',
    initial_data_json: intendedData,
  }));
  assert.ok(collision instanceof InvalidArgumentsPreDispatchResult,
    'an existing-slug mismatch must never be flattened into a successful local write');
  assert.deepEqual(attemptSignalsFromTypedResult(collision), {
    preDispatch: true,
    argumentValidationFailed: true,
    schemaAvailable: true,
  });
  assert.equal(
    readFileSync(store.resolveInSpace('occupied-content-calendar', 'data.json'), 'utf8'),
    occupiedBefore,
    'the collided destination remains byte-identical',
  );

  const repaired = await spaceSave.invoke(context, JSON.stringify({
    ...base,
    slug: 'local-llm-content-calendar-retry',
    initial_data_json: intendedData,
  }));
  assert.match(String(repaired), /Created workspace/);
  assert.equal(store.spaceStore.get('local-llm-content-calendar-retry')?.version, 1);
  assert.equal(
    readFileSync(store.resolveInSpace('local-llm-content-calendar-retry', 'data.json'), 'utf8'),
    intendedData,
  );
});

test('scoped tool_search tells the model to dispatch deferred tools through call_tool', async () => {
  const search = buildScopedLocalToolSearch(new Set(['write_file']));
  const output = await search.invoke(
    new RunContext({ sessionId: 'scoped-tool-search-dispatch' }),
    JSON.stringify({ query: 'write_file', role_key: null, limit: null }),
  );
  const payload = JSON.parse(String(output)) as { hint?: string; schemas?: Record<string, unknown> };
  assert.ok(payload.schemas?.write_file, 'the exact deferred tool schema is returned');
  assert.match(String(payload.hint), /call_tool\(name, args_json\)/);
  assert.doesNotMatch(String(payload.hint), /available on this turn's active surface/);
});

test('scoped planning-control lookup stays local and never discloses provider catalog noise', async () => {
  let providerSearches = 0;
  const search = buildScopedLocalToolSearch(
    new Set(['space_save', 'workflow_run']),
    'work_call',
    undefined,
    [{
      kind: 'authorized_composio',
      search: async () => {
        providerSearches += 1;
        return [
          { name: 'AIRTABLE_CREATE_BASE', summary: 'irrelevant table provider row', carrier: 'work_call' },
          { name: 'APIFY_RUN_ACTOR', summary: 'irrelevant actor provider row', carrier: 'work_call' },
        ];
      },
    }],
  );
  const output = await search.invoke(
    new RunContext({ sessionId: 'scoped-structural-planning-lookup' }),
    JSON.stringify({
      query: 'create a plan for multi-step dependent work and execute work calls',
      role_key: null,
      limit: 5,
    }),
  );
  const payload = JSON.parse(String(output)) as {
    kind?: string;
    results?: Array<{ name?: string }>;
    hint?: string;
  };

  assert.equal(providerSearches, 0, 'host structural controls never spend a provider discovery crossing');
  assert.equal(payload.kind, 'host_structural_control_lookup_v1');
  assert.deepEqual(payload.results?.map((row) => row.name), ['plan_task', 'work_call']);
  assert.doesNotMatch(String(output), /AIRTABLE|APIFY/);
  assert.match(String(payload.hint), /host-local control/i);
  assert.match(String(payload.hint), /not.*capabilityRef/i);
  assert.ok(Buffer.byteLength(String(output), 'utf8') <= 2_048, 'the structural answer stays bounded');
});

test('ordinary planning prose cannot bypass scoped discovery', async () => {
  let providerSearches = 0;
  const search = buildScopedLocalToolSearch(
    new Set<string>(),
    'work_call',
    undefined,
    [{
      kind: 'authorized_composio',
      search: async () => {
        providerSearches += 1;
        return [{
          name: 'SALESFORCE_QUERY_OPPORTUNITIES',
          summary: 'Read Salesforce opportunities.',
          schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          carrier: 'work_call',
        }];
      },
    }],
  );
  const output = await search.invoke(
    new RunContext({ sessionId: 'ordinary-content-plan-lookup' }),
    JSON.stringify({
      query: 'create a multi-step sales plan for the open opportunities',
      role_key: 'clause-0:read',
      limit: 1,
    }),
  );

  assert.equal(providerSearches, 1, 'non-control intent still reaches ordinary scoped discovery');
  assert.match(String(output), /SALESFORCE_QUERY_OPPORTUNITIES/);
  assert.doesNotMatch(String(output), /host_structural_control_lookup_v1/);
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
