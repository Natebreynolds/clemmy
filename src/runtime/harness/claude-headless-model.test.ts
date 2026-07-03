import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-headless-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('./claude-headless-model.js');
const {
  ClaudeHeadlessModel,
  buildClaudeHeadlessArgs,
  buildClaudeHeadlessEnv,
  claudeCliModelArg,
  renderClaudeHeadlessPrompt,
  normalizeClaudeHeadlessOutputText,
  resetClaudeHeadlessModelCache,
  setClaudeHeadlessSpawnForTest,
  claudeHeadlessCliAvailable,
  setClaudeHeadlessCliAvailableForTest,
  resolveClaudeCliPath,
  assistantMessage,
} = mod;

const STATE_DIR = path.join(TMP_HOME, 'state');
const CLAUDE_AUTH_FILE = path.join(STATE_DIR, 'claude-auth.json');
mkdirSync(STATE_DIR, { recursive: true });

function writeClaudeToken(): void {
  writeFileSync(
    CLAUDE_AUTH_FILE,
    JSON.stringify({
      accessToken: 'sk-ant-oat01-test-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['user:inference'],
    }),
    'utf-8',
  );
}

test.beforeEach(() => {
  writeClaudeToken();
  resetClaudeHeadlessModelCache();
});

test.after(() => {
  resetClaudeHeadlessModelCache();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('claudeCliModelArg passes a FULL model name through (exact model, fidelity), aliases bare words', () => {
  // Full Anthropic names → passed through so the CLI runs the EXACT model (verified live: the
  // CLI accepts each and resolves it to itself). Fixes the picker-fidelity bug where every
  // claude-sonnet-* collapsed to bare 'sonnet' (= newest), so 4.6 and 5 ran the SAME model.
  assert.equal(claudeCliModelArg('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(claudeCliModelArg('claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(claudeCliModelArg('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(claudeCliModelArg('claude-fable-5'), 'claude-fable-5');
  assert.equal(claudeCliModelArg('claude-haiku-4-5'), 'claude-haiku-4-5');
  // Bare family words → the CLI alias for the LATEST of that family.
  assert.equal(claudeCliModelArg('sonnet'), 'sonnet');
  assert.equal(claudeCliModelArg('opus'), 'opus');
  assert.equal(claudeCliModelArg('fable'), 'fable');
  // An unversioned / unknown claude-* falls back to the sonnet alias (prior default preserved).
  assert.equal(claudeCliModelArg('claude-agent-sdk'), 'sonnet');
  assert.equal(claudeCliModelArg(''), 'sonnet');
});

test('buildClaudeHeadlessArgs uses print-mode stream-json without bare mode', () => {
  const args = buildClaudeHeadlessArgs('claude-opus-4-8');
  assert.deepEqual(args.slice(0, 2), ['-p', '--safe-mode']);
  assert.equal(args.includes('--bare'), false);
  assert.equal(args.includes('--output-format'), true);
  assert.equal(args.includes('stream-json'), true);
  assert.equal(args.includes('--model'), true);
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-4-8');
});

test('buildClaudeHeadlessEnv uses OAuth token and strips API-key envs', async () => {
  const oldApi = process.env.ANTHROPIC_API_KEY;
  const oldAuth = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-should-not-leak';
  process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token-should-not-leak';
  try {
    const env = await buildClaudeHeadlessEnv();
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-test-token');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, 'clementine');
  } finally {
    if (oldApi == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldApi;
    if (oldAuth == null) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = oldAuth;
  }
});

test('renderClaudeHeadlessPrompt preserves system/input and marks text-specialist limits', () => {
  const prompt = renderClaudeHeadlessPrompt({
    systemInstructions: 'Be precise.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Draft a layout critique.' }] }],
    modelSettings: {},
    tools: [{ type: 'function', name: 'read_file', description: 'Read', parameters: {}, strict: false }],
    outputType: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] },
    handoffs: [],
    tracing: false,
  } as any);
  assert.match(prompt, /System instructions:\nBe precise\./);
  assert.match(prompt, /text specialist/);
  assert.match(prompt, /Return only valid JSON/);
  assert.match(prompt, /Do not wrap the JSON in markdown fences/);
  assert.match(prompt, /user:\nDraft a layout critique\./);
});

test('normalizeClaudeHeadlessOutputText strips markdown fences for structured output', () => {
  assert.equal(
    normalizeClaudeHeadlessOutputText('```json\n{"reply":"ok"}\n```', { type: 'object' } as any),
    '{"reply":"ok"}',
  );
  assert.equal(
    normalizeClaudeHeadlessOutputText('Here is the JSON:\n{"reply":"ok"}\nDone.', { type: 'object' } as any),
    '{"reply":"ok"}',
  );
  assert.equal(
    normalizeClaudeHeadlessOutputText('```json\n{"reply":"ok"}\n```', 'text' as any),
    '```json\n{"reply":"ok"}\n```',
  );
});

function installSpawnMock(lines: unknown[], captured: { cmd?: string; args?: string[]; prompt?: string; env?: NodeJS.ProcessEnv }): void {
  setClaudeHeadlessSpawnForTest(((cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    captured.cmd = cmd;
    captured.args = args;
    captured.env = options.env;
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit('close', null, 'SIGTERM');
      return true;
    };
    child.stdin.on('data', (chunk: Buffer) => {
      captured.prompt = (captured.prompt ?? '') + chunk.toString('utf8');
    });
    child.stdin.on('finish', () => {
      queueMicrotask(() => {
        for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
      });
    });
    return child;
  }) as any);
}

test('ClaudeHeadlessModel streams deltas and emits a conformant done event', async () => {
  const captured: { args?: string[]; prompt?: string; env?: NodeJS.ProcessEnv } = {};
  installSpawnMock([
    { type: 'system', subtype: 'init', session_id: 'session-1' },
    { type: 'assistant', message: { id: 'msg-1', model: 'claude-opus', content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 3, output_tokens: 1 } } },
    { type: 'assistant', message: { id: 'msg-1', model: 'claude-opus', content: [{ type: 'text', text: 'Hello world' }], usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 2 } } },
    { type: 'result', subtype: 'success', session_id: 'session-1', result: 'Hello world', total_cost_usd: 0 },
  ], captured);

  const model = new ClaudeHeadlessModel('claude-opus-4-8');
  const events = [];
  for await (const event of model.getStreamedResponse({
    systemInstructions: 'Speak plainly.',
    input: 'Say hello.',
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  } as any)) {
    events.push(event as any);
  }

  assert.equal(captured.args?.[captured.args.indexOf('--model') + 1], 'claude-opus-4-8');
  assert.match(captured.prompt ?? '', /Speak plainly/);
  assert.equal(captured.env?.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-test-token');
  assert.deepEqual(events.map((e) => e.type), ['response_started', 'output_text_delta', 'output_text_delta', 'response_done']);
  assert.equal(events[1].delta, 'Hello');
  assert.equal(events[2].delta, ' world');
  const done = events[3];
  assert.equal(done.response.id, 'session-1');
  assert.equal(done.response.output[0].content[0].text, 'Hello world');
  assert.equal(done.response.usage.inputTokens, 5);
  assert.equal(done.response.usage.outputTokens, 2);
});

test('ClaudeHeadlessModel.getResponse returns assistant output and usage', async () => {
  const captured: { args?: string[]; prompt?: string; env?: NodeJS.ProcessEnv } = {};
  installSpawnMock([
    { type: 'system', subtype: 'init', session_id: 'session-2' },
    { type: 'result', subtype: 'success', session_id: 'session-2', result: 'Final only', usage: { input_tokens: 7, output_tokens: 3 } },
  ], captured);

  const model = new ClaudeHeadlessModel('claude-sonnet-4-6');
  const response = await model.getResponse({
    input: 'Answer once.',
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  } as any);

  assert.equal(response.responseId, 'session-2');
  assert.equal((response.output[0] as any).content[0].text, 'Final only');
  assert.equal(response.usage.inputTokens, 7);
  assert.equal(response.usage.outputTokens, 3);
});

test('ClaudeHeadlessModel spawns the resolved CLAUDE_CLI_PATH override, not a literal PATH lookup', async () => {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-spawn-override-'));
  const overrideBin = path.join(binDir, 'claude-custom');
  writeFileSync(overrideBin, '#!/bin/sh\necho stub', { mode: 0o755 });
  const prevOverride = process.env.CLAUDE_CLI_PATH;
  const captured: { cmd?: string; args?: string[]; prompt?: string; env?: NodeJS.ProcessEnv } = {};
  try {
    process.env.CLAUDE_CLI_PATH = overrideBin;
    installSpawnMock([
      { type: 'system', subtype: 'init', session_id: 'session-override' },
      { type: 'result', subtype: 'success', session_id: 'session-override', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } },
    ], captured);

    const model = new ClaudeHeadlessModel('claude-sonnet-4-6');
    await model.getResponse({
      input: 'Answer once.',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    } as any);

    assert.equal(captured.cmd, overrideBin);
  } finally {
    if (prevOverride === undefined) delete process.env.CLAUDE_CLI_PATH;
    else process.env.CLAUDE_CLI_PATH = prevOverride;
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('ClaudeHeadlessModel.getResponse normalizes fenced JSON for structured contracts', async () => {
  const captured: { args?: string[]; prompt?: string; env?: NodeJS.ProcessEnv } = {};
  installSpawnMock([
    { type: 'system', subtype: 'init', session_id: 'session-3' },
    { type: 'result', subtype: 'success', session_id: 'session-3', result: '```json\n{"reply":"ok"}\n```', usage: { input_tokens: 7, output_tokens: 3 } },
  ], captured);

  const model = new ClaudeHeadlessModel('claude-sonnet-4-6');
  const response = await model.getResponse({
    input: 'Return JSON.',
    modelSettings: {},
    tools: [],
    outputType: { type: 'object' },
    handoffs: [],
    tracing: false,
  } as any);

  assert.equal((response.output[0] as any).content[0].text, '{"reply":"ok"}');
});

test('claudeHeadlessCliAvailable: test override forces the value; null restores the real PATH scan', () => {
  setClaudeHeadlessCliAvailableForTest(true);
  assert.equal(claudeHeadlessCliAvailable(), true);
  setClaudeHeadlessCliAvailableForTest(false);
  assert.equal(claudeHeadlessCliAvailable(), false);
  setClaudeHeadlessCliAvailableForTest(null);
});

test('resolveClaudeCliPath: finds a `claude` binary on the (augmented) PATH', () => {
  setClaudeHeadlessCliAvailableForTest(null);
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-bin-'));
  const claudeBin = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  writeFileSync(claudeBin, '#!/bin/sh\necho stub', { mode: 0o755 });
  const prevPath = process.env.PATH;
  const prevOverride = process.env.CLAUDE_CLI_PATH;
  try {
    delete process.env.CLAUDE_CLI_PATH;
    process.env.PATH = binDir;
    // resolveClaudeCliPath scans the AUGMENTED PATH, so it finds claude in
    // binDir (and would also find a real ~/.local/bin/claude — the whole point:
    // a minimal /Applications launch PATH no longer hides the CLI). We can't
    // assert a pure "absent" case here precisely because of that widening.
    assert.equal(claudeHeadlessCliAvailable(), true, 'finds claude on PATH');
    const resolved = resolveClaudeCliPath();
    assert.ok(typeof resolved === 'string' && resolved.length > 0, 'returns an absolute path');
  } finally {
    process.env.PATH = prevPath;
    if (prevOverride === undefined) delete process.env.CLAUDE_CLI_PATH;
    else process.env.CLAUDE_CLI_PATH = prevOverride;
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('resolveClaudeCliPath: an explicit CLAUDE_CLI_PATH override wins when it exists', () => {
  setClaudeHeadlessCliAvailableForTest(null);
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-override-'));
  const overrideBin = path.join(binDir, 'my-claude');
  writeFileSync(overrideBin, '#!/bin/sh\necho stub', { mode: 0o755 });
  const prevOverride = process.env.CLAUDE_CLI_PATH;
  try {
    process.env.CLAUDE_CLI_PATH = overrideBin;
    assert.equal(resolveClaudeCliPath(), overrideBin, 'override path wins');
    process.env.CLAUDE_CLI_PATH = path.join(binDir, 'does-not-exist');
    assert.notEqual(resolveClaudeCliPath(), path.join(binDir, 'does-not-exist'),
      'a non-existent override falls through to the PATH scan');
  } finally {
    if (prevOverride === undefined) delete process.env.CLAUDE_CLI_PATH;
    else process.env.CLAUDE_CLI_PATH = prevOverride;
    rmSync(binDir, { recursive: true, force: true });
  }
});

// ── SDK protocol conformance for response items ────────────────────────────
// Regression guard for the @openai/agents 0.12 bump (live incident 2026-07-03,
// first hit on the codex lane): agents-core validates the response_done payload
// against its zod protocol. This headless transport is a custom Model, so the
// items it hands the runner must satisfy that protocol directly. Unlike codex,
// this lane emits exactly ONE output-item shape — an assistant message with an
// `output_text` part (reasoning/compaction are never produced here; empty turns
// emit no item at all) — so validating `assistantMessage()` against the INSTALLED
// protocol covers every producible shape. A future SDK bump that shifts the
// protocol (e.g. requiring `annotations` on output_text, which we omit) fails
// here — in CI — instead of live on the user's first real question.
test('assistantMessage output validates against the installed SDK protocol', async (t) => {
  const { protocol } = await import('@openai/agents-core');
  const check = (label: string, text: string) => {
    const parsed = protocol.OutputModelItem.safeParse(assistantMessage(text));
    assert.ok(
      parsed.success,
      `${label} failed protocol validation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`,
    );
  };

  await t.test('a normal free-text reply', () => check('text', 'The capital of France is Paris.'));
  await t.test('a structured-output reply (raw JSON string, no fences)', () => check('json', '{"reply":"hi","done":true}'));
  await t.test('multiline + unicode content', () => check('multiline', 'Line one\nLíne two — ✅\nLine three'));
  // Production only calls assistantMessage() for truthy text (empty turns emit
  // []), but an empty output_text part must still be protocol-legal — guard it.
  await t.test('an empty-string content part', () => check('empty', ''));
});
