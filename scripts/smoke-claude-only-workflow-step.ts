#!/usr/bin/env tsx
/**
 * LIVE smoke — Claude as the ONLY brain EXECUTES a workflow step's tool.
 *
 * Simulates a Claude-only machine (AUTH_MODE=claude_oauth, NO Codex token) and
 * drives an UNTAGGED (no-intent) tool-using workflow step through the real runner
 * (executeStep). Before the fix this step routed to MODELS.primary → text-only
 * headless and could call NO tool. With the full gated lane (default on) it must
 * route to the Claude Agent SDK workflow-step lane and actually run a gated tool
 * (run_shell_command) on the subscription.
 *
 * Proof asserted:
 *   - a worker_model_routed event with transport 'claude_agent_sdk_workflow_step'
 *   - the routed model is a claude-* id (Claude, not gpt-*)
 *   - toolUses includes run_shell_command (Claude executed a gated tool, read-only echo)
 *
 * Run:  npx tsx scripts/smoke-claude-only-workflow-step.ts
 * Needs: a real ~/.clementine-next/state/claude-auth.json + the `claude` CLI.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Run against the REAL home so the live, auto-refreshed subscription token + keychain
// are available (a copied snapshot goes stale). The fix routes untagged steps to
// Claude under claude_oauth REGARDLESS of Codex presence, and the unit test already
// covers the codex-absent routing — so this live run proves the EXECUTION half.
const realHome = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
const realClaudeAuth = path.join(realHome, 'state', 'claude-auth.json');
if (!existsSync(realClaudeAuth)) {
  console.error(`✗ Claude auth not found at ${realClaudeAuth} — cannot run the subscription smoke.`);
  process.exit(1);
}

process.env.CLEMENTINE_HOME = realHome;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_WORKFLOW_FULL_LANE = 'on'; // the fix (default on)
process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'on';
process.env.CLEMMY_CLAUDE_TRANSPORT = 'headless'; // prove the fix wins even with headless configured
process.env.CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const SENTINEL = `CLAUDE_ONLY_WF_${process.pid}`;

try {
  const [
    { executeStep },
    { listEvents },
    { resetHarnessRuntimeConfig },
    { codexModelsAvailable },
    { loadFreshClaudeAccessToken },
  ] = await Promise.all([
    import('../src/execution/workflow-runner.js'),
    import('../src/runtime/harness/eventlog.js'),
    import('../src/runtime/harness/codex-client.js'),
    import('../src/runtime/harness/model-role-options.js'),
    import('../src/runtime/claude-oauth.js'),
  ]);
  resetHarnessRuntimeConfig();

  // The stored vault token may have lapsed; refresh it via the rotating refresh
  // token (same call the production request path makes) so this fresh process has
  // a valid subscription token before the pre-flight auth check.
  try {
    await loadFreshClaudeAccessToken();
    console.log('  (refreshed Claude subscription token for this run)');
  } catch (err) {
    console.error(`✗ Could not refresh the Claude subscription token: ${err instanceof Error ? err.message : String(err)}`);
    console.error('  Re-open Claude Code / re-login, then re-run this smoke.');
    process.exit(3);
  }

  // Informational: the fix routes to Claude under claude_oauth even WITH a Codex
  // token present (it keys on the active brain, not codex-absence). The unit test
  // covers the codex-absent case deterministically.
  console.log(`  (Codex token present on this machine: ${codexModelsAvailable()} — fix routes to Claude regardless)`);

  // UNTAGGED step (no intent, no explicit model) — the path that broke before.
  const step = {
    id: 'claude_only_probe',
    prompt: [
      'You are running one workflow step on a Claude-only machine.',
      `Run the shell command: echo ${SENTINEL}`,
      'Then return the workflow output as JSON: {"report":"<the exact line the shell printed>"}.',
    ].join(' '),
    sideEffect: 'read' as const,
    allowedTools: ['run_shell_command'],
    output: { type: 'object' as const, required_keys: ['report'], non_empty: ['report'] },
  };

  const runId = `wf-claude-only-${Date.now()}`;
  const ctx = {
    workflow: { name: 'Claude-Only Workflow Step Live Smoke', description: 'live smoke', enabled: true, steps: [step], trigger: { manual: true }, allowedTools: ['run_shell_command'] },
    workflowSlug: 'claude-only-workflow-step-live-smoke',
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: { respond: async () => { throw new Error('legacy assistant should not be called'); } },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];

  console.log(`\n→ Running untagged step on Claude-only (claude_oauth, no Codex), model ${process.env.CLAUDE_MODEL}…\n`);
  const output = await executeStep(step, ctx);

  const sessionId = `workflow:${runId}:claude_only_probe`;
  const routed = listEvents(sessionId, { types: ['worker_model_routed'] });
  const sdkEvent = routed.find((e) => (e.data as { transport?: string }).transport === 'claude_agent_sdk_workflow_step');
  const data = (sdkEvent?.data ?? {}) as { transport?: string; modelId?: string; sdkModel?: string; toolUses?: unknown };
  const toolUses = Array.isArray(data.toolUses) ? (data.toolUses as string[]) : [];
  const ranShell = toolUses.some((t) => typeof t === 'string' && t.endsWith('run_shell_command'));
  const onClaude = typeof data.modelId === 'string' && data.modelId.startsWith('claude-');

  const pass = Boolean(sdkEvent) && onClaude && ranShell;
  console.log('─────────────────────────────────────────');
  console.log(JSON.stringify({
    pass,
    routedToClaudeSdkWorkflowLane: Boolean(sdkEvent),
    modelId: data.modelId ?? null,
    sdkModel: data.sdkModel ?? null,
    ranShellTool: ranShell,
    toolUses,
    output,
  }, null, 2));
  console.log('─────────────────────────────────────────');

  if (!sdkEvent) { console.error('✗ FAIL: untagged step did NOT route to the Claude SDK workflow-step lane.'); process.exit(1); }
  if (!onClaude) { console.error(`✗ FAIL: routed model is not Claude (got ${data.modelId}).`); process.exit(1); }
  if (!ranShell) { console.error(`✗ FAIL: Claude did not execute run_shell_command. toolUses=${JSON.stringify(toolUses)}`); process.exit(1); }
  console.log('✓ PASS — Claude executed a gated workflow-step tool on the subscription (untagged step, claude_oauth).\n');
} catch (err) {
  console.error(`\n✗ SMOKE ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
}
