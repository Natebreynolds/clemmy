import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-work-call-inner-schema-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const { buildCallTool } = await import('./call-tool.js');
const schemaCache = await import('./composio-schema-cache.js');

after(() => {
  schemaCache.resetToolSchemaCache();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('semantic admission sees exact Composio action args/schema while logical identity stays on the carrier', async () => {
  const slug = 'PROOF_LIST_TASKS';
  const exactActionSchema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  };
  schemaCache.rememberToolSchema(slug, exactActionSchema, Date.now());

  let observed: {
    targetName: string;
    targetArgs: unknown;
    targetInputSchema: unknown;
    evidenceArgs?: unknown;
    evidenceInputSchema?: unknown;
  } | undefined;
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['composio_execute_tool']),
    aroundResolvedDispatch: async (input) => {
      observed = input;
      return { successful: true, captured: true };
    },
  }) as unknown as {
    invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
  };

  const output = await callTool.invoke(
    { context: { sessionId: 'inner-schema-test' } },
    JSON.stringify({
      name: 'composio_execute_tool',
      args_json: JSON.stringify({
        tool_slug: slug,
        arguments: { query: 'alpha' },
      }),
    }),
    { toolCall: { callId: 'inner-schema-call' } },
  );

  assert.deepEqual(JSON.parse(String(output)), { successful: true, captured: true });
  assert.ok(observed);
  assert.equal(observed!.targetName, 'composio_execute_tool');
  assert.deepEqual(observed!.targetArgs, {
    tool_slug: slug,
    arguments: JSON.stringify({ query: 'alpha' }),
    connected_account_id: null,
  }, 'logical dispatch remains the trusted generic carrier contract');
  assert.deepEqual(observed!.evidenceArgs, { query: 'alpha' });
  assert.deepEqual(observed!.evidenceInputSchema, exactActionSchema,
    'evidence refinement receives the exact provider action schema, not the carrier schema');
  assert.notDeepEqual(observed!.targetInputSchema, exactActionSchema);
});

test('the count-only example in the work_call description is a VALID proposal (two-teeth pin)', async () => {
  // Tooth 1: the example must parse against the real proposal schema — schema
  // drift breaks this test, never the model's first call.
  const { WORK_CALL_COUNT_ONLY_EXAMPLE, WorkProposalSchema } = await import('./work-call.js');
  const parsed = WorkProposalSchema.safeParse(WORK_CALL_COUNT_ONLY_EXAMPLE);
  assert.equal(parsed.success, true, JSON.stringify(('error' in parsed && parsed.error) || null));
  // Tooth 2: the example must actually ride the tool description — a valid
  // constant nobody renders is a silent no-op.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./work-call.ts', import.meta.url), 'utf-8');
  assert.match(source, /JSON\.stringify\(WORK_CALL_COUNT_ONLY_EXAMPLE\)/, 'the example constant must be embedded in the work_call description');
  const sealed = WORK_CALL_COUNT_ONLY_EXAMPLE.universes[0];
  assert.equal(sealed.seal, 'complete_source_receipt', 'the example teaches the sealed-universe shape, not accepted_input');
});
