#!/usr/bin/env tsx
/**
 * Live smoke: a real workflow-step model receives a large upstream output as an
 * offloaded __clementine_context_ref, uses workspace_artifact_query to retrieve
 * a tail record that is not in the prompt, and returns structured output.
 *
 * This is deliberately non-mutating: temp Clementine home, local JSON artifact,
 * read-only workflow step, no external writes/sends.
 *
 * Run:
 *   AUTH_MODE=codex_oauth CLEMMY_LIVE_WORKER_MODEL=claude-sonnet-4-6 \
 *     npx tsx scripts/smoke-workflow-context-artifact-query-live.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const realHome = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
const realClaudeAuth = path.join(realHome, 'state', 'claude-auth.json');
if (!existsSync(realClaudeAuth)) {
  console.error(`Claude auth not found at ${realClaudeAuth}`);
  process.exit(1);
}

const tmpHome = path.join(os.tmpdir(), `clemmy-context-artifact-live-${Date.now()}`);
mkdirSync(path.join(tmpHome, 'state'), { recursive: true });
writeFileSync(path.join(tmpHome, 'state', 'claude-auth.json'), readFileSync(realClaudeAuth, 'utf-8'), 'utf-8');
writeFileSync(
  path.join(tmpHome, 'state', 'auth.json'),
  JSON.stringify({
    source: 'native',
    codexOauth: {
      grantProvenance: 'clementine-oauth-v1',
      grantId: 'grant-smoke-context-artifact-query',
      accessToken: 'codex-context-smoke-access',
      refreshToken: 'codex-context-smoke-refresh',
    },
  }),
  'utf-8',
);

process.env.CLEMENTINE_HOME = tmpHome;
process.env.AUTH_MODE = 'codex_oauth';
process.env.WORKFLOW_STEP_AGENT = 'on';
process.env.CLEMMY_RUN_WORKSPACE_OFFLOAD = 'on';
process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'on';
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
  {
    role: 'worker',
    modelId: process.env.CLEMMY_LIVE_WORKER_MODEL || 'claude-sonnet-4-6',
    whenIntent: 'analysis',
    scope: 'durable',
    source: 'chat-rule',
  },
]);

try {
  const [
    { executeStep },
    { listEvents },
    { resetHarnessRuntimeConfig },
  ] = await Promise.all([
    import('../src/execution/workflow-runner.js'),
    import('../src/runtime/harness/eventlog.js'),
    import('../src/runtime/harness/codex-client.js'),
  ]);
  resetHarnessRuntimeConfig();

  const needleId = `needle-${randomUUID().slice(0, 8)}`;
  const expected = {
    id: needleId,
    email: `${randomUUID().slice(0, 12)}@artifact-smoke.example`,
    domain: `${randomUUID().slice(0, 10)}.artifact-smoke.example`,
    score: 987,
  };
  const rows = Array.from({ length: 3999 }, (_, i) => ({
    id: `acct-${i}`,
    email: `person${i}@ordinary.example`,
    domain: `ordinary-${i}.example`,
    score: i % 100,
    notes: `filler row ${i} ${'x'.repeat(55)}`,
  }));
  rows.push({
    ...expected,
    notes: `target row ${'z'.repeat(80)}`,
  });
  const upstream = { rows, count: rows.length };
  if (JSON.stringify(upstream).length < 200_000) {
    throw new Error('fixture is too small to prove offloaded artifact querying');
  }

  const step = {
    id: 'select_tail_account',
    prompt: [
      'Select one account from the structured workflow context.',
      `The target account id is "${needleId}".`,
      'The upstream fetch_accounts output is intentionally too large to inline.',
      'You must call workspace_artifact_query on the __clementine_context_ref path with json_path "rows",',
      'filter_field "id", filter_equals equal to the target id, and fields ["id","email","domain","score"].',
      'Return the selected id, email, domain, and score exactly as JSON.',
    ].join(' '),
    intent: 'analysis',
    dependsOn: ['fetch_accounts'],
    sideEffect: 'read' as const,
    allowedTools: ['workspace_artifact_query', 'read_file'],
    output: {
      type: 'object' as const,
      required_keys: ['id', 'email', 'domain', 'score'],
      non_empty: ['id', 'email', 'domain'],
    },
  };
  const runId = `wf-context-artifact-live-${Date.now()}`;
  const ctx = {
    workflow: {
      name: 'Context Artifact Query Live Smoke',
      description: 'live smoke for offloaded workflow context querying',
      enabled: true,
      steps: [{ id: 'fetch_accounts' }, step],
      trigger: { manual: true },
    },
    workflowSlug: 'context-artifact-query-live-smoke',
    runId,
    inputs: {},
    stepOutputs: { fetch_accounts: upstream },
    assistant: { respond: async () => { throw new Error('legacy assistant should not be called'); } },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];

  const output = await executeStep(step, ctx) as Record<string, unknown>;
  const sessionId = `workflow:${runId}:select_tail_account`;
  const routed = listEvents(sessionId, { types: ['worker_model_routed'] });
  const route = routed.find((event) => (event.data as { transport?: string }).transport === 'claude_agent_sdk_workflow_step');
  const routeData = (route?.data ?? {}) as { toolUses?: unknown; modelId?: unknown; sdkModel?: unknown; sdkSessionId?: unknown };
  const toolUses = Array.isArray(routeData.toolUses) ? routeData.toolUses.map(String) : [];
  const usedArtifactQuery = toolUses.some((toolName) => toolName.endsWith('__workspace_artifact_query') || toolName === 'workspace_artifact_query');

  const mismatches: string[] = [];
  for (const key of ['id', 'email', 'domain'] as const) {
    if (output[key] !== expected[key]) mismatches.push(`${key}: expected ${expected[key]}, got ${String(output[key])}`);
  }
  if (Number(output.score) !== expected.score) mismatches.push(`score: expected ${expected.score}, got ${String(output.score)}`);
  if (!route) mismatches.push('missing claude_agent_sdk_workflow_step routing event');
  if (!usedArtifactQuery) mismatches.push(`workspace_artifact_query was not called; toolUses=${JSON.stringify(toolUses)}`);

  const result = {
    ok: mismatches.length === 0,
    runId,
    sessionId,
    expected,
    output,
    modelId: routeData.modelId,
    sdkModel: routeData.sdkModel,
    sdkSessionId: routeData.sdkSessionId,
    toolUses,
    mismatches,
  };
  console.log(JSON.stringify(result, null, 2));
  if (mismatches.length > 0) process.exit(1);
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
