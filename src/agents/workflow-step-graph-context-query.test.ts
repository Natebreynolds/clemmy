/**
 * Run:
 *   npx tsx --test src/agents/workflow-step-graph-context-query.test.ts
 *
 * Regression pin for the read_parallel_v1 specialist's ONLY read tool.
 *
 * A graph specialist is granted exactly `workflow_step_result` plus
 * `workspace_artifact_query`, and the compiler offloads any large upstream
 * value into a run-workspace artifact that nothing else can reach. So the
 * offload is only sound if the granted tool can actually be CALLED.
 *
 * The live canary proved it could not. All three specialists issued
 * well-formed queries against a 514-row offloaded artifact and every attempt
 * came back as the SDK's field-less `InvalidToolInputError: Invalid JSON input
 * for tool`.
 *
 * Isolated cause: the schema re-declared numeric bounds (offset>=0, limit<=200,
 * max_chars<=50000) that queryWorkspaceArtifact already clamps. Validation runs
 * before execute, so a clampable overshoot became a hard rejection naming
 * neither the field nor the bound — and a model told the artifact holds 514
 * rows asks for 514. It could not learn what was wrong, retried the same shape,
 * and the whole fan-out blocked.
 *
 * Explicitly NOT the cause: `null` for unused optional properties. This SDK
 * strips nulls before validation, so a nulls-only payload was always admitted.
 * `.nullish()` in the schema is defence in depth and the nulls-are-absent test
 * below pins that behaviour either way.
 *
 * These are the exact argument payloads captured from the blocked run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-graph-context-query-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const { buildWorkflowStepAgent } = await import('./workflow-step-agent.js');
const { runWorkspaceDir } = await import('../execution/workflow-run-workspace.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const WORKFLOW = 'graph-context-query-pin';
const RUN_ID = 'graph-context-query-pin-run';
const ROW_COUNT = 514;
const ARTIFACT_REL = 'artifacts/step-sales_source-pin.json';

function seedArtifact(): string {
  const workspace = runWorkspaceDir(WORKFLOW, RUN_ID);
  const target = path.join(workspace, ARTIFACT_REL);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({
    period: '2026-07',
    record_count: ROW_COUNT,
    transactions: Array.from({ length: ROW_COUNT }, (_, i) => ({
      id: `opp-${String(i).padStart(6, '0')}`,
      amount: 1_000 + i,
      stage: i % 3 === 0 ? 'Closed Won' : 'Closed Lost',
      repCode: `rep-${String((i % 49) + 1).padStart(2, '0')}`,
    })),
  }), 'utf8');
  return target;
}

function bindingFor(target: string): { path: string; sha256: string; bytes: number } {
  const raw = readFileSync(target, 'utf8');
  return {
    path: ARTIFACT_REL,
    sha256: createHash('sha256').update(raw).digest('hex'),
    bytes: Buffer.byteLength(raw, 'utf8'),
  };
}

async function graphQueryTool() {
  const target = seedArtifact();
  const agent = await buildWorkflowStepAgent({
    resultOnlyTools: true,
    graphContext: {
      workflowName: WORKFLOW,
      runId: RUN_ID,
      allowedArtifacts: [bindingFor(target)],
    },
  });
  const tools = (agent as unknown as {
    tools: Array<{ name?: string; invoke?: (ctx: unknown, input: string) => Promise<unknown> }>;
  }).tools;
  const found = tools.find((t) => t.name === 'workspace_artifact_query');
  assert.ok(found?.invoke, 'the graph specialist must be given a callable workspace_artifact_query');
  return found as { invoke: (ctx: unknown, input: string) => Promise<unknown> };
}

test('compiled-project exact authority replaces the generic artifact reader and never inherits notify_user', async () => {
  const allowed = seedArtifact();
  const workspace = runWorkspaceDir(WORKFLOW, RUN_ID);
  const unowned = path.join(workspace, 'artifacts', 'not-owned.json');
  writeFileSync(unowned, JSON.stringify({ rows: [{ secret: 'not event-owned' }] }), 'utf8');

  const agent = await buildWorkflowStepAgent({
    lockTools: ['workflow_step_result', 'workspace_artifact_query', 'list_files'],
    exactTools: true,
    graphContext: {
      workflowName: WORKFLOW,
      runId: RUN_ID,
      allowedArtifacts: [bindingFor(allowed)],
    },
  });
  const tools = (agent as unknown as {
    tools: Array<{ name?: string; invoke?: (ctx: unknown, input: string) => Promise<unknown> }>;
  }).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['list_files', 'workflow_step_result', 'workspace_artifact_query'],
    'the native lane must expose the compiled grant byte-for-byte',
  );
  assert.equal(tools.some((tool) => tool.name === 'notify_user'), false);
  const query = tools.find((tool) => tool.name === 'workspace_artifact_query');
  assert.ok(query?.invoke);
  assert.match(String(await query.invoke({}, JSON.stringify({ path: allowed }))), /Artifact /);
  assert.match(
    String(await query.invoke({}, JSON.stringify({ path: unowned }))),
    /not rendered into the active workflow step context/,
    'same-run files that are not bound to a completed event remain unreadable',
  );
});

/** The SDK reports schema rejection with this field-less shape. */
const isSchemaRejection = (out: string) =>
  /InvalidToolInputError|Invalid JSON input for tool/i.test(out);

test('the specialist read tool admits the exact strict-mode payload the live canary sent', async () => {
  const absolute = seedArtifact();
  const tool = await graphQueryTool();

  // Captured verbatim from the blocked canary run: nulls for every unused
  // optional, plus limit/max_chars above the schema's former bounds.
  const liveArgs = JSON.stringify({
    path: absolute,
    json_path: '$.transactions',
    fields: null,
    filter_field: null,
    filter_contains: null,
    filter_equals: null,
    offset: 0,
    limit: 514,
    max_chars: 500_000,
  });

  const out = String(await tool.invoke({}, liveArgs));
  assert.ok(!isSchemaRejection(out), `the tool must not reject its own strict-mode call shape: ${out}`);
  assert.ok(!/Refused:/.test(out), `the seeded artifact is event-owned and must be readable: ${out}`);
  assert.match(out, /of 514 matching/, 'the query must reach the offloaded rows');
});

test('an over-large page request is clamped and told exactly how to continue', async () => {
  const absolute = seedArtifact();
  const tool = await graphQueryTool();

  const out = String(await tool.invoke({}, JSON.stringify({
    path: absolute, json_path: '$.transactions', offset: 0, limit: 514, max_chars: 500_000,
  })));

  assert.ok(!isSchemaRejection(out), out);
  // Clamped to the executor's ceiling rather than refused...
  assert.match(out, /showing 200 record\(s\) \[0-200\] of 514 matching/);
  // ...and the reply itself carries the escape hatch, so a weak model converges.
  assert.match(out, /call again with offset: 200/);
});

test('null-valued optionals are treated as absent, not as bad input', async () => {
  const absolute = seedArtifact();
  const tool = await graphQueryTool();

  const out = String(await tool.invoke({}, JSON.stringify({
    path: absolute,
    json_path: '$.transactions',
    fields: null,
    filter_field: null,
    filter_contains: null,
    filter_equals: null,
    offset: null,
    limit: null,
    max_chars: null,
  })));

  assert.ok(!isSchemaRejection(out), out);
  // Defaults apply exactly as if the keys had been omitted.
  assert.match(out, /showing 50 record\(s\) \[0-50\] of 514 matching/);
  assert.match(out, /"repCode": "rep-01"/, 'projection is unfiltered when fields is null');
});

test('filters still work when supplied, and the run-workspace boundary still holds', async () => {
  const absolute = seedArtifact();
  const tool = await graphQueryTool();

  const filtered = String(await tool.invoke({}, JSON.stringify({
    path: absolute,
    json_path: '$.transactions',
    fields: ['id', 'stage'],
    filter_field: 'stage',
    filter_equals: 'Closed Won',
    offset: null,
    limit: 5,
    max_chars: null,
  })));
  assert.ok(!isSchemaRejection(filtered), filtered);
  assert.match(filtered, /showing 5 record\(s\)/);
  assert.ok(!/"amount"/.test(filtered), 'fields projection must still narrow the record');
  assert.ok(!/Closed Lost/.test(filtered), 'filter_equals must still exclude non-matching rows');

  // Relaxing the schema must NOT relax the containment guarantees.
  const escape = String(await tool.invoke({}, JSON.stringify({
    path: path.join(os.tmpdir(), 'definitely-not-in-this-run.json'),
    json_path: null, fields: null, filter_field: null, filter_contains: null,
    filter_equals: null, offset: null, limit: null, max_chars: null,
  })));
  assert.ok(
    /Refused:|Graph context query failed/.test(escape),
    `a path outside the run workspace must still be refused: ${escape}`,
  );
});

test('an allowed path whose bytes change after binding fails closed', async () => {
  const absolute = seedArtifact();
  const bound = bindingFor(absolute);
  const agent = await buildWorkflowStepAgent({
    resultOnlyTools: true,
    graphContext: {
      workflowName: WORKFLOW,
      runId: RUN_ID,
      allowedArtifacts: [bound],
    },
  });
  const query = (agent as unknown as {
    tools: Array<{ name?: string; invoke?: (ctx: unknown, input: string) => Promise<unknown> }>;
  }).tools.find((toolRef) => toolRef.name === 'workspace_artifact_query');
  assert.ok(query?.invoke);

  writeFileSync(absolute, JSON.stringify({ transactions: [{ secret: 'replacement' }] }), 'utf8');
  const out = String(await query.invoke({}, JSON.stringify({ path: absolute })));
  assert.match(out, /byte length mismatch|SHA-256 mismatch/i);
  assert.doesNotMatch(out, /replacement/, 'tampered bytes are never parsed or returned');
});
