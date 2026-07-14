#!/usr/bin/env tsx
/**
 * Live smoke: simulate the Codex brain calling run_worker(intent:"design") with
 * a Claude worker binding. The worker must run through Claude Agent SDK, call
 * Clementine's local skill_read MCP tool, and return the skill-mandated output.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expected = 'CLAUDE_AGENT_SDK_WORKER_SKILL_OK';
const realHome = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
const realClaudeAuth = path.join(realHome, 'state', 'claude-auth.json');
if (!existsSync(realClaudeAuth)) {
  console.error(`Claude auth not found at ${realClaudeAuth}`);
  process.exit(1);
}

const tmpHome = path.join(os.tmpdir(), `clemmy-claude-sdk-worker-${Date.now()}`);
mkdirSync(path.join(tmpHome, 'state'), { recursive: true });
mkdirSync(path.join(tmpHome, 'skills', 'claude-worker-smoke'), { recursive: true });
writeFileSync(path.join(tmpHome, 'state', 'claude-auth.json'), readFileSync(realClaudeAuth, 'utf-8'), 'utf-8');
writeFileSync(
  path.join(tmpHome, 'state', 'auth.json'),
  JSON.stringify({
    source: 'native',
    codexOauth: {
      grantProvenance: 'clementine-oauth-v1',
      grantId: 'grant-smoke-claude-worker-skill',
      accessToken: 'codex-smoke-access',
      refreshToken: 'codex-smoke-refresh',
    },
  }),
  'utf-8',
);
writeFileSync(
  path.join(tmpHome, 'skills', 'claude-worker-smoke', 'SKILL.md'),
  [
    '---',
    'name: Claude Worker Smoke',
    'description: A live smoke skill that proves Claude SDK workers can load skill instructions.',
    '---',
    '',
    '# Claude Worker Smoke',
    '',
    `When this skill is used, the final worker output must be exactly: ${expected}`,
  ].join('\n'),
  'utf-8',
);

process.env.CLEMENTINE_HOME = tmpHome;
process.env.AUTH_MODE = 'codex_oauth';
process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER = 'on';
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
  { role: 'worker', modelId: process.env.CLEMMY_LIVE_WORKER_MODEL || 'claude-sonnet-4-6', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
]);

try {
  const [{ buildOrchestratorAgent }, { createSession, listEvents }, { RunContext }] = await Promise.all([
    import('../src/agents/orchestrator.js'),
    import('../src/runtime/harness/eventlog.js'),
    import('@openai/agents'),
  ]);

  const session = createSession({ kind: 'chat', title: 'claude sdk worker skill smoke', channel: 'smoke' });
  const agent = await buildOrchestratorAgent({
    userInput: 'Use Claude for design and use the claude-worker-smoke skill.',
    sessionId: session.id,
  });
  const runWorker = (agent.tools ?? []).find((t) => (t as { name?: string }).name === 'run_worker') as
    | { invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown> }
    | undefined;
  if (!runWorker) throw new Error('run_worker was not present on the orchestrator tool surface');

  const packet = {
    objective: 'Design one report section using an installed skill.',
    item: 'report hero',
    resolvedTools: 'skill_read(name="claude-worker-smoke")',
    context: 'Use the installed skill named claude-worker-smoke.',
    instructions: `Call skill_read for claude-worker-smoke, then follow it exactly. Final output must be ${expected}.`,
    expectedOutput: `Exactly ${expected}, or ERROR: <reason>.`,
    intent: 'design',
  };
  const input = JSON.stringify(packet);
  const result = String(await runWorker.invoke(
    new RunContext({ sessionId: session.id }),
    input,
    { toolCall: { name: 'run_worker', callId: 'call_worker_skill_smoke', arguments: input } },
  )).trim();

  if (/^\s*ERROR:/i.test(result)) {
    throw new Error(`worker returned an error result: ${JSON.stringify(result)}`);
  }
  if (!result.includes(expected)) {
    throw new Error(`unexpected worker result: ${JSON.stringify(result)}`);
  }
  const routed = listEvents(session.id, { types: ['worker_model_routed'] });
  const sdkEvent = routed.find((event) => (event.data as { transport?: string }).transport === 'claude_agent_sdk_worker');
  if (!sdkEvent) throw new Error('missing claude_agent_sdk_worker routing event');
  const data = sdkEvent.data as { toolUses?: unknown; modelId?: unknown; sdkModel?: unknown; sdkSessionId?: unknown };
  const toolUses = Array.isArray(data.toolUses) ? data.toolUses : [];
  if (!toolUses.some((tool) => typeof tool === 'string' && tool.endsWith('__skill_read'))) {
    throw new Error(`Claude SDK worker did not call skill_read. toolUses=${JSON.stringify(toolUses)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    sentinel: expected,
    result,
    sessionId: session.id,
    modelId: data.modelId,
    sdkModel: data.sdkModel,
    sdkSessionId: data.sdkSessionId,
    toolUses,
  }, null, 2));
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
