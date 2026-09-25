/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/coding-agent-claude.test.ts
 *
 * Pins the Claude Code adapter without a live CLI: the session options Clem
 * sends (worktree cwd, clean env, minted session id or resume, project-only
 * settings, no MCP), every tool call crossing Clem's policy at the PreToolUse
 * hook, and the SDK stream mapped onto the shared event vocabulary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'coding-agent-claude-'));

const { claudeCodingAgent, claudeMessageEvents, setClaudeCodingQueryForTests } = await import('./coding-agent-claude.js');
const { decideCodingToolUse } = await import('./coding-run-policy.js');
type CodingAgentEvent = import('./coding-agent-bridge.js').CodingAgentEvent;

interface Captured {
  options: Record<string, any>;
  prompts: any[];
  interrupted: number;
  closed: number;
}

function fakeQuery(script: (captured: Captured) => AsyncGenerator<any>) {
  const captured: Captured = { options: {}, prompts: [], interrupted: 0, closed: 0 };
  const fn = ((params: { prompt: AsyncIterable<any>; options: Record<string, any> }) => {
    captured.options = params.options;
    void (async () => { for await (const prompt of params.prompt) captured.prompts.push(prompt); })();
    const gen = script(captured) as any;
    gen.interrupt = async () => { captured.interrupted += 1; };
    gen.close = () => { captured.closed += 1; };
    return gen;
  }) as any;
  return { fn, captured };
}

async function collect(events: AsyncIterable<CodingAgentEvent>): Promise<CodingAgentEvent[]> {
  const out: CodingAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const worktree = mkdtempSync(path.join(os.tmpdir(), 'coding-agent-claude-wt-'));

test('a fresh start runs in the worktree with a clean env, the minted session id, and no MCP', async () => {
  const { fn, captured } = fakeQuery(async function* () {
    yield { type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111', model: 'claude-sonnet' };
  });
  setClaudeCodingQueryForTests(fn);
  try {
    const session = claudeCodingAgent.start({
      cwd: worktree,
      message: 'Task: add greet()',
      agentSessionId: '11111111-1111-4111-8111-111111111111',
      resume: false,
      model: null,
      env: { PATH: '/usr/bin', HOME: '/tmp/h' },
      instructions: 'Work only inside the worktree.',
      decide: (tool, input) => decideCodingToolUse({ tool, input, worktreePath: worktree }),
    });
    const events = await collect(session.events);
    assert.deepEqual(events, [{ kind: 'session', agentSessionId: '11111111-1111-4111-8111-111111111111', model: 'claude-sonnet' }]);
    const o = captured.options;
    assert.equal(o.cwd, worktree);
    assert.deepEqual(o.env, { PATH: '/usr/bin', HOME: '/tmp/h' });
    assert.equal(o.sessionId, '11111111-1111-4111-8111-111111111111');
    assert.equal(o.resume, undefined);
    assert.equal(o.persistSession, true);
    assert.deepEqual(o.settingSources, ['project', 'local']);
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(o.mcpServers, {});
    assert.equal(o.permissionMode, 'default');
    assert.notEqual(o.permissionMode, 'bypassPermissions');
    assert.equal(o.systemPrompt.append, 'Work only inside the worktree.');
    assert.equal(captured.prompts[0].message.content, 'Task: add greet()');
  } finally {
    setClaudeCodingQueryForTests(null);
  }
});

test('a resume passes the stored session id as resume, never as a new id', async () => {
  const { fn, captured } = fakeQuery(async function* () {});
  setClaudeCodingQueryForTests(fn);
  try {
    const session = claudeCodingAgent.start({
      cwd: worktree, message: 'Clem here — carry on', agentSessionId: 'abc', resume: true, model: 'claude-opus',
      env: {}, instructions: '', decide: () => ({ decision: 'allow', effect: 'local', reason: '' }),
    });
    await collect(session.events);
    assert.equal(captured.options.resume, 'abc');
    assert.equal(captured.options.sessionId, undefined);
    assert.equal(captured.options.model, 'claude-opus');
  } finally {
    setClaudeCodingQueryForTests(null);
  }
});

test('every tool call crosses Clem\'s policy at the PreToolUse hook; a refusal is visible', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { fn, captured } = fakeQuery(async function* () { await gate; });
  setClaudeCodingQueryForTests(fn);
  try {
    const session = claudeCodingAgent.start({
      cwd: worktree, message: 'go', agentSessionId: 'x', resume: false, model: null, env: {}, instructions: '',
      decide: (tool, input) => decideCodingToolUse({ tool, input, worktreePath: worktree }),
    });
    const hook = captured.options.hooks.PreToolUse[0].hooks[0];
    const signal = new AbortController().signal;
    const push = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' }, tool_use_id: 'tu-1' }, 'tu-1', { signal });
    assert.equal(push.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(push.hookSpecificOutput.permissionDecisionReason, /off this machine/);
    const test = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu-2' }, 'tu-2', { signal });
    assert.equal(test.hookSpecificOutput.permissionDecision, 'allow');

    const backstop = await captured.options.canUseTool('Write', { file_path: '/etc/hosts' }, { signal, toolUseID: 'tu-3' });
    assert.equal(backstop.behavior, 'deny');

    session.send('Also update the README', 'steer');
    session.send('Now add a test', 'follow_up');
    release();
    const events = await collect(session.events);
    const refusal = events.find((event) => event.kind === 'permission');
    assert.ok(refusal && refusal.kind === 'permission');
    assert.equal(refusal.decision, 'deny');
    assert.equal(refusal.effect, 'off_machine');
    assert.equal(refusal.stepId, 'tu-1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(captured.prompts.map((p) => p.priority), ['next', 'now', 'next']);
  } finally {
    setClaudeCodingQueryForTests(null);
  }
});

test('stop controls reach the SDK query', async () => {
  const { fn, captured } = fakeQuery(async function* () { await new Promise(() => {}); });
  setClaudeCodingQueryForTests(fn);
  try {
    const session = claudeCodingAgent.start({
      cwd: worktree, message: 'go', agentSessionId: 'y', resume: false, model: null, env: {}, instructions: '',
      decide: () => ({ decision: 'allow', effect: 'local', reason: '' }),
    });
    await session.interrupt();
    session.close();
    session.close();
    assert.equal(captured.interrupted, 1);
    assert.equal(captured.closed, 1);
  } finally {
    setClaudeCodingQueryForTests(null);
  }
});

test('the SDK stream maps onto messages, plans, steps and a turn receipt', () => {
  const assistant = claudeMessageEvents({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [
        { type: 'text', text: 'I will add greet() and a test.' },
        { type: 'tool_use', id: 'tu-plan', name: 'TodoWrite', input: { todos: [
          { content: 'Write greet()', status: 'in_progress' },
          { content: 'Add a test', status: 'pending' },
        ] } },
        { type: 'tool_use', id: 'tu-edit', name: 'Write', input: { file_path: 'src/greet.ts', content: 'x' } },
        { type: 'thinking', thinking: 'hidden' },
      ],
    },
  } as any);
  assert.deepEqual(assistant, [
    { kind: 'message', text: 'I will add greet() and a test.', nested: false },
    { kind: 'plan', items: [{ text: 'Write greet()', status: 'in_progress' }, { text: 'Add a test', status: 'pending' }] },
    { kind: 'step_started', stepId: 'tu-edit', tool: 'Write', detail: 'src/greet.ts', nested: false },
  ]);
  const result = claudeMessageEvents({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-edit', is_error: true, content: [{ type: 'text', text: 'EACCES' }] }] },
  } as any);
  assert.deepEqual(result, [{ kind: 'step_finished', stepId: 'tu-edit', ok: false, output: 'EACCES' }]);
  const done = claudeMessageEvents({
    type: 'result', subtype: 'success', is_error: false, result: 'Added greet() with a passing test.',
    total_cost_usd: 0.12,
    modelUsage: { 'claude-sonnet': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 900, cacheCreationInputTokens: 10, webSearchRequests: 0, costUSD: 0.12, contextWindow: 200000, maxOutputTokens: 8000 } },
  } as any);
  assert.deepEqual(done, [{
    kind: 'turn_completed',
    ok: true,
    finalMessage: 'Added greet() with a passing test.',
    usage: [{ model: 'claude-sonnet', inputTokens: 100, cachedInputTokens: 900, cacheCreationInputTokens: 10, outputTokens: 50 }],
    costUsd: 0.12,
  }]);
  const failed = claudeMessageEvents({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] } as any);
  assert.equal((failed[0] as any).ok, false);
  assert.equal((failed[0] as any).finalMessage, 'boom');
});
