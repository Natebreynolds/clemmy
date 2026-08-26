/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/dynamic-tools-containment.test.ts
 *
 * Production-surface containment for user-installed custom scripts. Discovery
 * may retain the installed name/description, but no model, worker, workflow, or
 * standalone MCP surface may start the raw .py/.sh body until it is represented
 * by the shared exact logical/physical authority kernel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const TEST_HOME = process.env.CLEMENTINE_HOME;
if (!TEST_HOME) throw new Error('isolated test runner did not provide CLEMENTINE_HOME');

// Exercise the full direct worker/workflow surfaces. The invariant under test
// lives inside the installed-tool handler, so kill switches cannot reopen it.
process.env.HARNESS_TOOL_BRACKETS = 'off';
process.env.CLEMMY_WORKER_SLIM_TOOLS = 'off';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'off';

const TOOLS_DIR = path.join(TEST_HOME, 'tools');
const PY_CANARY = path.join(TEST_HOME, 'acca-send-batch-spawned');
const SH_CANARY = path.join(TEST_HOME, 'legacy-shell-spawned');
mkdirSync(TOOLS_DIR, { recursive: true });

// Mirrors the currently installed effectful custom tool by name and declared
// behavior, but the fixture's only "effect" is a file inside the disposable
// test home. Before containment this proves the production handler really
// crossed the child-process edge.
writeFileSync(
  path.join(TOOLS_DIR, 'acca_send_batch.py'),
  [
    'from pathlib import Path',
    `Path(${JSON.stringify(PY_CANARY)}).write_text("spawned", encoding="utf-8")`,
    'print("{\\"ok\\":true,\\"sent\\":true}")',
    '',
  ].join('\n'),
  'utf8',
);
writeFileSync(
  path.join(TOOLS_DIR, 'acca_send_batch.py.meta.json'),
  JSON.stringify({
    description: 'Execute ACCA email sends, create Salesforce tasks, and post results to Discord',
    args_description: 'No arguments',
  }),
  'utf8',
);

const shellPath = path.join(TOOLS_DIR, 'legacy_effect.sh');
writeFileSync(
  shellPath,
  `#!/bin/sh\nprintf spawned > ${JSON.stringify(SH_CANARY)}\nprintf '{"ok":true,"sent":true}\\n'\n`,
  'utf8',
);
chmodSync(shellPath, 0o700);
writeFileSync(
  `${shellPath}.meta.json`,
  JSON.stringify({ description: 'Legacy effectful shell custom tool', args_description: 'No arguments' }),
  'utf8',
);

const { RunContext } = await import('@openai/agents');
const { getCoreTools } = await import('./registry.js');
const { createClementineMcpServer } = await import('./mcp-server.js');
const { buildWorkerAgent } = await import('../agents/sub-agents.js');
const { buildWorkflowStepAgent } = await import('../agents/workflow-step-agent.js');
const {
  DynamicScriptExecutionUnavailableResult,
  listDynamicToolNames,
} = await import('./dynamic-tools.js');
const { attemptSignalsFromTypedResult } = await import('../runtime/harness/attempt-settlement.js');

interface InvokableTool {
  name?: string;
  description?: string;
  invoke?: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
}

function removeCanaries(): void {
  rmSync(PY_CANARY, { force: true });
  rmSync(SH_CANARY, { force: true });
}

function toolNamed(tools: readonly unknown[], name: string): InvokableTool {
  const found = (tools as InvokableTool[]).find((candidate) => candidate.name === name);
  assert.ok(found?.invoke, `${name} was not present as an invokable typed-unavailable tool`);
  return found;
}

async function invoke(tool: InvokableTool, callId: string): Promise<unknown> {
  return tool.invoke!(
    new RunContext({ sessionId: 'dynamic-script-containment' }),
    JSON.stringify({ args: null }),
    { toolCall: { callId } },
  );
}

function textFromResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const output = (result as { output?: unknown }).output;
    if (typeof output === 'string') return output;
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((part) => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '')
        .filter(Boolean)
        .join('\n');
    }
  }
  return String(result);
}

function assertTypedUnavailable(result: unknown, toolName: string, script: string): void {
  const record = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : {};
  if ('isError' in record) assert.equal(record.isError, true);
  const payload = JSON.parse(textFromResult(result)) as Record<string, unknown>;
  assert.deepEqual(payload, {
    ok: false,
    status: 'unavailable',
    code: 'dynamic_script_execution_authority_unrepresented',
    dispatch_state: 'not_started',
    processStarted: false,
    tool: toolName,
    script,
    reason: 'Installed custom script execution is unavailable until its local process and every downstream effect are represented by Clementine\'s shared exact logical/physical authority kernel.',
  });
}

test.after(() => {
  removeCanaries();
});

test('installed .py/.sh inventory remains discoverable without making either body executable', () => {
  assert.deepEqual(listDynamicToolNames().sort(), ['acca_send_batch', 'legacy_effect']);
});

test('typed unavailable result settles as an exact pre-dispatch policy refusal', () => {
  const result = new DynamicScriptExecutionUnavailableResult('acca_send_batch', 'acca_send_batch.py');
  assert.deepEqual(attemptSignalsFromTypedResult(result), {
    preDispatch: true,
    policyRefused: true,
  });
});

test('model/core surface returns typed unavailable for the current effectful Python shape with zero spawn', async () => {
  removeCanaries();
  const tool = toolNamed(getCoreTools(), 'acca_send_batch');
  const result = await invoke(tool, 'dynamic-core-python');
  assert.equal(existsSync(PY_CANARY), false, 'the model/core surface started the effectful Python body');
  assert.match(tool.description ?? '', /ACCA email sends/);
  assert.match(tool.description ?? '', /execution unavailable/i);
  assertTypedUnavailable(result, 'acca_send_batch', 'acca_send_batch.py');
});

test('model/core surface returns typed unavailable for an installed shell body with zero spawn', async () => {
  removeCanaries();
  const result = await invoke(toolNamed(getCoreTools(), 'legacy_effect'), 'dynamic-core-shell');
  assert.equal(existsSync(SH_CANARY), false, 'the model/core surface started the shell body');
  assertTypedUnavailable(result, 'legacy_effect', 'legacy_effect.sh');
});

test('worker surface cannot reopen the installed effectful Python body', async () => {
  removeCanaries();
  const worker = await buildWorkerAgent();
  const result = await invoke(toolNamed(worker.tools, 'acca_send_batch'), 'dynamic-worker-python');
  assert.equal(existsSync(PY_CANARY), false, 'the worker surface started the effectful Python body');
  assertTypedUnavailable(result, 'acca_send_batch', 'acca_send_batch.py');
});

test('workflow-step surface cannot reopen the installed effectful Python body', async () => {
  removeCanaries();
  const workflowStep = await buildWorkflowStepAgent({
    exactTools: true,
    lockTools: ['acca_send_batch'],
    userInput: 'Run the installed ACCA batch tool.',
  });
  const result = await invoke(toolNamed(workflowStep.tools, 'acca_send_batch'), 'dynamic-workflow-python');
  assert.equal(existsSync(PY_CANARY), false, 'the workflow-step surface started the effectful Python body');
  assertTypedUnavailable(result, 'acca_send_batch', 'acca_send_batch.py');
});

test('standalone MCP surface returns an MCP error with zero Python or shell spawn', async () => {
  removeCanaries();
  const server = createClementineMcpServer({
    allowedTools: ['acca_send_batch', 'legacy_effect'],
  });
  const registered = (server as unknown as {
    _registeredTools: Record<string, {
      description?: string;
      handler: (input: Record<string, unknown>) => Promise<unknown>;
    }>;
  })._registeredTools;

  const python = await registered.acca_send_batch.handler({ args: null });
  const shell = await registered.legacy_effect.handler({ args: null });
  assert.equal(existsSync(PY_CANARY), false, 'standalone MCP started the effectful Python body');
  assert.equal(existsSync(SH_CANARY), false, 'standalone MCP started the shell body');
  assert.match(registered.acca_send_batch?.description ?? '', /execution unavailable/i);
  assertTypedUnavailable(python, 'acca_send_batch', 'acca_send_batch.py');
  assertTypedUnavailable(shell, 'legacy_effect', 'legacy_effect.sh');
});
