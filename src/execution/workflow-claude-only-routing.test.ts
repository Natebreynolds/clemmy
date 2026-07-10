import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Claude-as-the-ONLY-brain workflow execution.
 *
 * The gap (found 2026-06-19): when Claude is the brain (AUTH_MODE=claude_oauth)
 * and there is NO Codex token, an UNTAGGED (no-intent) tool-using workflow step
 * resolves to NO model (resolveWorkflowStepModel → {}), falls back to
 * MODELS.primary (a gpt-* id), and the router — with Codex absent — remaps it to
 * the Claude brain id served by the HEADLESS transport, which is text-only
 * (`claude -p --tools ''`) and CANNOT call tools. So a Claude-only user's
 * tool-using workflows have no tool-capable executor.
 *
 * The fix (CLEMMY_CLAUDE_WORKFLOW_FULL_LANE, default on): under claude_oauth,
 * untagged workflow steps resolve to the Claude brain model so the tool-capable,
 * gated Claude Agent SDK workflow-step lane engages — for read AND write/send.
 *
 * This file asserts the FIXED behavior: it is RED before the fix (proving the
 * gap) and GREEN after. A regression guard pins the Codex path byte-identical.
 */

// Fresh temp home BEFORE imports ⇒ no stored Codex token ⇒ codexModelsAvailable()
// is false, exactly the "Claude is my only model" machine we need to simulate.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-only-wf-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_TRANSPORT = 'headless';
delete process.env.CLEMMY_CLAUDE_WORKFLOW_FULL_LANE; // default-on

const { workflowRunnerInternalsForTest } = await import('./workflow-runner.js');
const {
  resolveWorkflowStepModel,
  workflowStepCanRunOnClaudeAgentSdk,
  workflowStepUsesFullClaudeLane,
  shouldUseDeclarativeStepApproval,
  exactApprovedSendTools,
} = workflowRunnerInternalsForTest;
const { claudeAgentSdkWorkflowStepEnabled } = await import('../runtime/harness/claude-agent-workflow-step.js');
const { buildClaudeHeadlessArgs } = await import('../runtime/harness/claude-headless-model.js');
const { getClaudeBrainModel, MODELS } = await import('../config.js');
const { codexModelsAvailable } = await import('../runtime/harness/model-role-options.js');

const readStep = { id: 'find_page', prompt: 'Find the official page', sideEffect: 'read' as const };
const sendStep = { id: 'notify_nate', prompt: 'Notify Nate with the read', sideEffect: 'send' as const };

test('pre-req: this run simulates a Claude-only machine (no Codex token)', () => {
  assert.equal(codexModelsAvailable(), false, 'temp home must have no Codex token to simulate Claude-only');
});

test('headless transport is genuinely text-only — it disables tools (--tools "")', () => {
  const args = buildClaudeHeadlessArgs(getClaudeBrainModel());
  const i = args.indexOf('--tools');
  assert.ok(i >= 0, 'headless args carry --tools');
  assert.equal(args[i + 1], '', 'headless explicitly disables tools — cannot execute a tool-using step');
});

test('FIX: an untagged tool-using workflow step resolves to the Claude brain model under claude_oauth', () => {
  // Before the fix this returns {} (no model) ⇒ falls to MODELS.primary (gpt-*).
  const routed = resolveWorkflowStepModel(readStep as never);
  assert.equal(
    typeof routed.model === 'string' && routed.model.startsWith('claude-'),
    true,
    `untagged step should resolve to a claude-* model under claude_oauth, got ${JSON.stringify(routed)}`,
  );
});

test('FIX: the resolved untagged-step model engages the tool-capable Claude SDK workflow lane', () => {
  const routed = resolveWorkflowStepModel(readStep as never);
  assert.equal(
    claudeAgentSdkWorkflowStepEnabled(routed.model),
    true,
    'the resolved untagged-step model must enable the tool-capable Claude workflow-step lane',
  );
});

test('FIX: write/send steps may run on the full gated Claude lane (gates enforce safety)', () => {
  assert.equal(
    workflowStepCanRunOnClaudeAgentSdk(sendStep as never),
    true,
    'a send step should be allowed on the full gated Claude lane (grounding/approval gates still apply)',
  );
});

test('approved requiresApproval Claude step uses the full SDK lane after the runner gate resolves', () => {
  const approved = {
    id: 'send_approved',
    prompt: 'Send the approved message with composio_execute_tool.',
    model: 'claude-sonnet-4-6',
    sideEffect: 'send' as const,
    requiresApproval: true,
  };
  assert.equal(claudeAgentSdkWorkflowStepEnabled(approved.model), true);
  assert.equal(workflowStepCanRunOnClaudeAgentSdk(approved as never), true);
  assert.equal(workflowStepUsesFullClaudeLane(approved as never), true, 'fullLane keeps the real workflow session/plan scope');
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

test('HEADLINE: under a CODEX brain, the full Claude lane is still available for an INJECTED Claude step', () => {
  // "Codex starts a workflow and injects Claude where needed." Untagged steps stay
  // on Codex (byte-identical), but a step the user routed to Claude (intent) gets
  // the SAME tool-capable, write/send-capable, 24-turn lane as a Claude-brain step.
  process.env.AUTH_MODE = 'codex_oauth';
  try {
    // Untagged step under a Codex brain → NOT moved to Claude (Codex path intact).
    assert.deepEqual(resolveWorkflowStepModel(readStep as never), {}, 'Codex-brain untagged steps stay on Codex');
    // But the lane capability is brain-agnostic: an injected Claude send step (the
    // dispatch only consults this once the step model is already a claude-* id) may
    // run the full gated lane — so injected Claude isn't second-classed to read-only.
    assert.equal(workflowStepCanRunOnClaudeAgentSdk(sendStep as never), true, 'injected Claude send step gets the full lane under a Codex brain');
    assert.equal(workflowStepCanRunOnClaudeAgentSdk(readStep as never), true, 'injected Claude read step too');
  } finally {
    process.env.AUTH_MODE = 'claude_oauth';
  }
});

test('REGRESSION GUARD: with Codex/api_key auth, untagged steps are byte-identical (no model picked)', () => {
  process.env.AUTH_MODE = 'api_key';
  try {
    const routed = resolveWorkflowStepModel(readStep as never);
    assert.deepEqual(routed, {}, 'non-claude_oauth untagged steps must keep returning {} (Codex path untouched)');
  } finally {
    process.env.AUTH_MODE = 'claude_oauth';
  }
});

test('REGRESSION GUARD: kill-switch off ⇒ Claude-only routing disabled (untagged → {})', () => {
  process.env.CLEMMY_CLAUDE_WORKFLOW_FULL_LANE = 'off';
  try {
    const routed = resolveWorkflowStepModel(readStep as never);
    assert.deepEqual(routed, {}, 'with the kill-switch off, behavior reverts to the prior {} default');
  } finally {
    delete process.env.CLEMMY_CLAUDE_WORKFLOW_FULL_LANE;
  }
});

test('FIX: codex_oauth with a BYO id polluting OPENAI_MODEL_PRIMARY steers untagged steps to the Codex default (not the BYO endpoint)', () => {
  // The 2026-06-29 incident: AUTH_MODE=codex_oauth but OPENAI_MODEL_PRIMARY=glm-5.2
  // (a BYO id) → a {} fallback would route the step to the Z.ai endpoint. The
  // surgical guard returns the canonical Codex default instead. Healthy Codex
  // (gpt primary) still returns {} (proven by the HEADLINE/REGRESSION guards above).
  process.env.AUTH_MODE = 'codex_oauth';
  process.env.OPENAI_MODEL_PRIMARY = 'glm-5.2';
  try {
    const routed = resolveWorkflowStepModel(readStep as never);
    assert.equal(routed.model, 'gpt-5.4', 'polluted Codex brain steers untagged steps to the Codex default, not glm-5.2');
  } finally {
    process.env.AUTH_MODE = 'claude_oauth';
    delete process.env.OPENAI_MODEL_PRIMARY;
  }
});
