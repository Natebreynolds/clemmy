/**
 * Run: npx tsx --test src/runtime/sandboxed-script.test.ts
 *
 * The shared sandboxed-script substrate is the keystone of Wave 1.3 — both the
 * Workspace runner and the workflow deterministic step route through it, so its
 * safety properties (output cap, EPIPE guard, scrubbed env, timeout) are tested
 * once, here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  interpreterFor, scrubbedChildEnv, electronNodeEnv, spawnSandboxedScript, DEFAULT_MAX_OUTPUT_BYTES,
} from './sandboxed-script.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-sandbox-test-'));

function writeScript(name: string, body: string, exec = false): string {
  const p = path.join(tmp, name);
  writeFileSync(p, body, 'utf-8');
  if (exec) chmodSync(p, 0o755);
  return p;
}

// ── interpreterFor ───────────────────────────────────────────────────────────

test('interpreterFor: .mjs/.js/.cjs run under the node/Electron binary as node', () => {
  for (const ext of ['mjs', 'js', 'cjs']) {
    const i = interpreterFor(`/x/y.${ext}`, '/usr/bin');
    assert.ok(i);
    assert.equal(i.command, process.execPath);
    assert.equal(i.isElectron, true);
    assert.deepEqual(i.args, [`/x/y.${ext}`]);
  }
});

test('interpreterFor: .ts resolves tsx and runs under node (the new capability)', () => {
  const i = interpreterFor('/x/y.ts', '/usr/bin');
  assert.ok(i, 'tsx should resolve in this repo');
  assert.equal(i.command, process.execPath);
  assert.equal(i.isElectron, true);
  // args = [tsxCli, target]
  assert.equal(i.args.length, 2);
  assert.equal(i.args[1], '/x/y.ts');
});

test('interpreterFor: .py and .sh are NOT electron (never get ELECTRON_RUN_AS_NODE)', () => {
  const py = interpreterFor('/x/y.py', '/usr/bin');
  assert.ok(py);
  assert.equal(py.isElectron, false);
  const sh = interpreterFor('/x/y.sh', '/usr/bin');
  assert.ok(sh);
  assert.equal(sh.isElectron, false);
});

test('interpreterFor: a chmod+x extensionless file runs itself; a non-exec unknown ext is unsupported', () => {
  const execFile = writeScript('runnable', '#!/bin/sh\necho hi\n', true);
  const i = interpreterFor(execFile, '/usr/bin');
  assert.ok(i);
  assert.equal(i.command, execFile);
  assert.deepEqual(i.args, []);

  const plain = writeScript('notes.xyz', 'just text', false);
  assert.equal(interpreterFor(plain, '/usr/bin'), null);
});

// ── scrubbedChildEnv ─────────────────────────────────────────────────────────

test('scrubbedChildEnv carries NO daemon secrets, but DOES carry an augmented PATH', () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevTok = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-should-not-leak';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
  try {
    const env = scrubbedChildEnv({ CLEMENTINE_SPACE_SLUG: 'demo' });
    assert.equal(env.OPENAI_API_KEY, undefined, 'must not pass through API keys');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(env.PATH && env.PATH.length > 0, 'PATH present (augmented)');
    assert.equal(env.CLEMENTINE_SPACE_SLUG, 'demo', 'caller extra is layered on');
    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.PYTHONIOENCODING, 'utf-8');
  } finally {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    if (prevTok === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevTok;
  }
});

test('electronNodeEnv sets the flag ONLY for the node/Electron binary', () => {
  assert.deepEqual(electronNodeEnv(process.execPath, true), { ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(electronNodeEnv('/usr/bin/python3', false), {});
  // isElectron true but a different command (defensive) → not set.
  assert.deepEqual(electronNodeEnv('/usr/bin/python3', true), {});
});

// ── spawnSandboxedScript ─────────────────────────────────────────────────────

test('happy path: reads stdin payload, returns code 0 + stdout', async () => {
  const script = writeScript('echo.mjs', [
    'let i = ""; process.stdin.setEncoding("utf-8");',
    'process.stdin.on("data", (c) => i += c);',
    'process.stdin.on("end", () => process.stdout.write("got:" + i));',
  ].join('\n'));
  const out = await spawnSandboxedScript({
    command: process.execPath, args: [script], cwd: tmp,
    env: scrubbedChildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
    stdinPayload: 'PING', timeoutMs: 10_000,
  });
  assert.equal(out.launchError, undefined);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'got:PING');
  assert.equal(out.overflowed, false);
  assert.equal(out.timedOut, false);
});

test('launch failure surfaces as launchError (never rejects)', async () => {
  const out = await spawnSandboxedScript({
    command: path.join(tmp, 'does-not-exist-binary'), args: [], cwd: tmp,
    env: scrubbedChildEnv(), stdinPayload: '', timeoutMs: 5_000,
  });
  assert.ok(out.launchError, 'ENOENT should surface as launchError');
  assert.equal(out.code, null);
});

test('output cap: a runaway writer is killed and flagged overflowed', async () => {
  // Backpressure-respecting steady stream: writes 64KB chunks and only schedules
  // more after 'drain', so the child stays alive and keeps streaming until the
  // PARENT trips the cap and kills it (rather than the child self-crashing on a
  // synchronous mega-burst, which would exit before the cap is reached).
  const script = writeScript('flood.mjs', [
    'const chunk = Buffer.alloc(64 * 1024, 0x78);',
    'function write(){ let ok = true; while (ok) ok = process.stdout.write(chunk); process.stdout.once("drain", write); }',
    'process.stdout.on("error", () => process.exit(0));', // killed pipe → exit cleanly
    'write();',
  ].join('\n'));
  const out = await spawnSandboxedScript({
    command: process.execPath, args: [script], cwd: tmp,
    env: scrubbedChildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
    stdinPayload: '', timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024,
  });
  assert.equal(out.overflowed, true, 'should trip the output cap');
  assert.ok(Buffer.byteLength(out.stdout) <= 2 * 1024 * 1024 + 1024 * 1024, 'stdout bounded near the cap');
});

test('a fast script that exits before stdin is fully written does NOT throw EPIPE', async () => {
  // Reads nothing and exits immediately; the parent still tries to write stdin.
  const script = writeScript('quick.mjs', 'process.stdout.write("done");\n');
  const big = 'y'.repeat(2 * 1024 * 1024); // large enough that the write is mid-flight on exit
  const out = await spawnSandboxedScript({
    command: process.execPath, args: [script], cwd: tmp,
    env: scrubbedChildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
    stdinPayload: big, timeoutMs: 10_000,
  });
  assert.equal(out.launchError, undefined);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'done');
});

test('timeout: a hung script is killed and flagged timedOut', async () => {
  const script = writeScript('hang.mjs', 'setInterval(() => {}, 1000);\n');
  const out = await spawnSandboxedScript({
    command: process.execPath, args: [script], cwd: tmp,
    env: scrubbedChildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
    stdinPayload: '', timeoutMs: 400,
  });
  assert.equal(out.timedOut, true);
  assert.notEqual(out.code, 0);
});

test('DEFAULT_MAX_OUTPUT_BYTES is the 64MB safety cap', () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 64 * 1024 * 1024);
});
