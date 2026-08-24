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
  // Live 2026-08-11 run 5: the model proposed a compute op for drafting, then
  // composed in-model — an undischargeable requirement that blocked the writes
  // for 800s. The description must carry the composition rule; rewording it is
  // fine, deleting the teaching is not.
  assert.match(source, /compute ONLY for work a tool will perform/,
    'the description must teach that model-composed content is not a compute operation');
});

test('the collect-then-construct example is a VALID once-write proposal and rides the description', async () => {
  const {
    WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE,
    WorkProposalSchema,
  } = await import('./work-call.js');
  const parsed = WorkProposalSchema.safeParse(WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE);
  assert.equal(parsed.success, true, JSON.stringify(('error' in parsed && parsed.error) || null));
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./work-call.ts', import.meta.url), 'utf-8');
  assert.match(
    source,
    /JSON\.stringify\(WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE\)/,
    'the collect-then-construct example must ride the work_call description',
  );
  assert.equal(WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE.operations[1]?.cardinality.kind, 'once');
  assert.equal(WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE.universes.length, 0);
});

test('work_call inherits the proven-resolution remap by construction (two-teeth pin)', async () => {
  // The 2026-08-18 consumption fix lives in buildCallTool; work_call consumes
  // it only because its dispatcher IS buildCallTool. Tooth 1: the forwarding
  // must survive refactors — a work_call that resolves names itself would
  // silently regress the proven-slug remap for every carrier built on it.
  const { readFileSync } = await import('node:fs');
  const workCallSource = readFileSync(new URL('./work-call.ts', import.meta.url), 'utf-8');
  assert.match(
    workCallSource,
    /buildCallTool\(\{\s*\.\.\.dispatcherOptions/,
    'work_call must construct its dispatcher through buildCallTool — the proven-resolution remap lives there',
  );
  // Tooth 2: the remap itself must still be consumed inside that dispatcher.
  const callToolSource = readFileSync(new URL('./call-tool.ts', import.meta.url), 'utf-8');
  assert.match(
    callToolSource,
    /provenComposioSlugForTurn/,
    "the dispatcher must consume the turn's proven resolution at the decision point",
  );
});

test('a bound collection refuses shell/curl before its callback while admitting the exact Composio carrier', async () => {
  const { evaluateSourceStrategyWorkCarrier } = await import('./work-call.js');
  const binding = {
    version: 1,
    primary: {
      capabilityId: 'capability:composio:APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET',
      accountIdentity: 'research@example.com',
      schemaFingerprint: 'schema:apify:live',
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'a'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  const requirement = { role: 'collection', effect: 'read' } as const;
  let shellCallbacks = 0;
  const shell = evaluateSourceStrategyWorkCarrier({
    requirement,
    binding,
    bindingRequired: true,
    targetName: 'run_shell_command',
    targetArgs: { command: 'curl https://example.invalid/alternate-source' },
  });
  if (shell.status === 'admitted') shellCallbacks += 1;
  assert.equal(shell.status, 'refused');
  assert.equal(shellCallbacks, 0, 'a generic network process never starts for a bound collection');

  let composioCallbacks = 0;
  const composio = evaluateSourceStrategyWorkCarrier({
    requirement,
    binding,
    bindingRequired: true,
    targetName: 'composio_execute_tool',
    targetArgs: {
      tool_slug: 'APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET',
      arguments: JSON.stringify({ actorId: 'still-physically-verified-downstream' }),
      connected_account_id: null,
    },
  });
  if (composio.status === 'admitted') composioCallbacks += 1;
  assert.deepEqual(composio, {
    status: 'admitted',
    capabilityId: 'capability:composio:APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET',
    match: 'primary',
  });
  assert.equal(composioCallbacks, 1, 'the exact bound carrier continues to the physical account/schema gate');
});
