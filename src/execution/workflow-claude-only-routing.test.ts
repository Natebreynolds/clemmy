import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Claude-as-the-ONLY-brain workflow execution — the UNIFIED-LANE contract.
 *
 * History: on a Claude-only machine (claude_oauth, no Codex token) an untagged
 * tool-using step once resolved to NO model, fell to a gpt-* id, and remapped
 * to the text-only headless transport — no tool-capable executor. The original
 * fix routed Claude steps to the Claude Agent SDK lane. That lane was REMOVED
 * (owner goal 2026-08-25): a Claude-model step now runs the harness lane, and
 * the host loop runs Claude WITH tools — proven live the same morning
 * (morning-briefing: host_harness + claude-sonnet-5, task_list/goal_list/
 * notify_user executed, run succeeded, AUTH_MODE=claude_oauth).
 *
 * What must survive here: (1) untagged steps on a Claude-only machine still
 * resolve to a claude-* model — never a dead gpt-* fallback; (2) the headless
 * transport remains text-only, so it must never be the workflow executor;
 * (3) the step-approval shapes are lane-independent and unchanged.
 */

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-only-wf-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_TRANSPORT = 'headless';

const { workflowRunnerInternalsForTest } = await import('./workflow-runner.js');
const {
  resolveWorkflowStepModel,
  shouldUseDeclarativeStepApproval,
  exactApprovedSendTools,
} = workflowRunnerInternalsForTest;
const { buildClaudeHeadlessArgs } = await import('../runtime/harness/claude-headless-model.js');
const { getClaudeBrainModel } = await import('../config.js');
const { codexModelsAvailable } = await import('../runtime/harness/model-role-options.js');

const readStep = { id: 'find_page', prompt: 'Find the official page', sideEffect: 'read' as const };

test('pre-req: this run simulates a Claude-only machine (no Codex token)', () => {
  assert.equal(codexModelsAvailable(), false, 'temp home must have no Codex token to simulate Claude-only');
});

test('headless transport is genuinely text-only — it disables tools (--tools "")', () => {
  const args = buildClaudeHeadlessArgs(getClaudeBrainModel());
  const i = args.indexOf('--tools');
  assert.ok(i >= 0, 'headless args carry --tools');
  assert.equal(args[i + 1], '', 'headless explicitly disables tools — it must never be the workflow executor');
});

test('an untagged tool-using workflow step resolves to the Claude brain model under claude_oauth', () => {
  const routed = resolveWorkflowStepModel(readStep as never);
  assert.equal(
    typeof routed.model === 'string' && routed.model.startsWith('claude-'),
    true,
    `untagged step should resolve to a claude-* model under claude_oauth, got ${JSON.stringify(routed)}`,
  );
});

test('generic send steps use the concrete tool card; exact sends keep one declarative grant', () => {
  const workflow = { name: 'approval-shapes', allowedTools: ['composio_execute_tool'] } as never;
  const generic = {
    id: 'generic-send',
    prompt: 'Choose and send the message.',
    sideEffect: 'send' as const,
    requiresApproval: true,
    allowedTools: ['composio_execute_tool'],
  };
  assert.equal(shouldUseDeclarativeStepApproval(workflow, generic as never), false);
  assert.deepEqual(exactApprovedSendTools(workflow, generic as never), []);

  const exact = {
    ...generic,
    id: 'exact-send',
    allowedTools: ['slack__postMessage'],
  };
  assert.equal(shouldUseDeclarativeStepApproval(workflow, exact as never), true);
  assert.deepEqual(exactApprovedSendTools(workflow, exact as never), ['slack__postMessage']);

  const reversible = { ...generic, id: 'draft', sideEffect: 'write' as const };
  assert.equal(shouldUseDeclarativeStepApproval(workflow, reversible as never), true);
});
