/**
 * Run: npx tsx --test src/execution/guest-harness.test.ts
 *
 * Pins the guest-harness contract: arg profiles for both harnesses (Claude
 * agent-mode must NEVER carry skip-permissions and must inherit the
 * project's own MCP servers into --allowedTools; Codex must run sandboxed
 * in the project dir), stream-json parsing to a final message + narration
 * events, changed-file collection, and the live-model guard on the real
 * spawn edge. Offline, deterministic — every run goes through the spawn
 * test seam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-guest-harness-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  buildGuestArgs,
  defaultClaudeAllowedTools,
  runGuestHarness,
  scanChangedFiles,
  setGuestHarnessSpawnForTest,
  setGuestHarnessBinaryResolverForTest,
  resolveGuestHarnessBinary,
} = await import('./guest-harness.js');

function makeProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-guest-project-'));
  writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}');
  return dir;
}

/** A fake child process that replays scripted stdout lines then exits.
 *  onSpawn runs synchronously at spawn time, before any output — the place
 *  to emulate side effects the real CLI performs mid-run. */
function fakeSpawn(lines: string[], exitCode = 0, onSpawn?: (call: { binary: string; args: string[] }) => void) {
  const calls: Array<{ binary: string; args: string[]; cwd?: string }> = [];
  const impl = ((binary: string, args: string[], options: { cwd?: string }) => {
    const call = { binary, args, cwd: options?.cwd };
    calls.push(call);
    onSpawn?.(call);
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`));
      child.emit('close', exitCode);
    });
    return child;
  }) as any;
  return { impl, calls };
}

test('claude args: agent profile — stream-json, explicit allows, never skip-permissions', (t) => {
  const project = makeProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { dataforseo: {}, chart: {} } }));

  const args = buildGuestArgs({ harness: 'claude', projectPath: project, prompt: '/seo-audit example.com' });
  assert.deepEqual(args.slice(0, 2), ['-p', '/seo-audit example.com']);
  assert.ok(args.includes('stream-json') && args.includes('--verbose'), 'print-mode stream-json requires --verbose');
  assert.ok(args.includes('--allowedTools'));
  assert.ok(args.includes('mcp__dataforseo') && args.includes('mcp__chart'), 'project .mcp.json servers must be allowed');
  assert.ok(!args.some((a) => /dangerously|bypassPermissions/.test(a)), 'guest runs must never skip permissions');
});

test('claude allows: no .mcp.json → base profile only', (t) => {
  const project = makeProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const allows = defaultClaudeAllowedTools(project);
  assert.ok(allows.includes('Bash') && allows.includes('WebFetch'));
  assert.ok(!allows.some((a) => a.startsWith('mcp__')));
});

test('codex args: sandboxed exec in the project dir with JSONL + last-message capture', (t) => {
  const project = makeProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const args = buildGuestArgs({
    harness: 'codex', projectPath: project, prompt: 'summarize this repo', lastMessageFile: '/tmp/x.txt',
  });
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--json'));
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write']);
  assert.deepEqual(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2), ['-C', project]);
  assert.equal(args[args.length - 1], 'summarize this repo');
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  // Long flag only — the -o alias is missing from older codex versions
  // (0.36.0 rejected it live) and regressing this re-breaks them.
  assert.ok(args.includes('--output-last-message'));
  assert.ok(!args.includes('-o'));
});

test('claude run: parses stream-json into events + final message, collects changed files', async (t) => {
  const project = makeProject();
  process.env.CLAUDE_CLI_PATH = process.execPath; // any existing binary satisfies resolution
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    delete process.env.CLAUDE_CLI_PATH;
    setGuestHarnessSpawnForTest(null);
  });

  const outputFile = path.join(project, 'audit.html');
  const { impl, calls } = fakeSpawn([
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebFetch', input: {} }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Crunching the audit…' }] } }),
    // The fake writes the artifact "mid-run" via this marker line hack: written below before run resolves.
    JSON.stringify({
      type: 'result', subtype: 'success', result: 'Audit complete — audit.html written.',
      usage: { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 450 },
    }),
  ]);
  setGuestHarnessSpawnForTest(impl);

  const events: string[] = [];
  const runPromise = runGuestHarness({
    harness: 'claude',
    projectPath: project,
    prompt: '/seo-audit example.com',
    onEvent: (e) => events.push(`${e.kind}:${e.text}`),
  });
  writeFileSync(outputFile, '<html>audit</html>');
  const result = await runPromise;

  assert.equal(result.ok, true);
  assert.equal(result.finalMessage, 'Audit complete — audit.html written.');
  assert.ok(events.includes('tool:WebFetch'));
  assert.ok(events.includes('assistant:Crunching the audit…'));
  assert.ok(result.changedFiles.includes('audit.html'), `changed files: ${result.changedFiles.join(', ')}`);
  assert.equal(calls[0].cwd, project);
});

test('codex run: final message read from the -o last-message file', async (t) => {
  const project = makeProject();
  // Resolution happens BEFORE the spawn seam, against the real PATH — so
  // without this stub the test only passes on a machine that has codex
  // installed (green on a dev Mac, red on a CI runner). Stub the resolver so
  // the test exercises the codex ARG/last-message contract hermetically.
  setGuestHarnessBinaryResolverForTest(() => process.execPath);
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    setGuestHarnessBinaryResolverForTest(null);
    setGuestHarnessSpawnForTest(null);
  });

  // Emulate codex writing the -o last-message file mid-run, before exit.
  const { impl, calls } = fakeSpawn([JSON.stringify({ type: 'turn.completed' })], 0, (call) => {
    const oIndex = call.args.indexOf('--output-last-message');
    assert.ok(oIndex > 0, 'codex args must include last-message capture');
    writeFileSync(call.args[oIndex + 1], 'Done: repo summarized.\n');
  });
  setGuestHarnessSpawnForTest(impl);

  const result = await runGuestHarness({ harness: 'codex', projectPath: project, prompt: 'do the thing' });
  assert.equal(calls.length, 1);
  assert.equal(result.finalMessage, 'Done: repo summarized.');
  assert.ok(!result.changedFiles.some((f) => f.startsWith('.clem-guest-last-message-')), 'capture file must not leak into changed files');
});

test('run refuses when the harness binary is absent, naming cli_setup', async (t) => {
  const project = makeProject();
  // augmentPath re-adds the user's real bin dirs, so an installed claude
  // can't be hidden via PATH — stub the resolver (and the spawn seam as a
  // belt-and-braces guard: this test must never reach a real spawn).
  setGuestHarnessBinaryResolverForTest(() => null);
  setGuestHarnessSpawnForTest(fakeSpawn([]).impl);
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    setGuestHarnessBinaryResolverForTest(null);
    setGuestHarnessSpawnForTest(null);
  });
  await assert.rejects(
    runGuestHarness({ harness: 'claude', projectPath: project, prompt: 'x' }),
    /not installed.*cli_setup/s,
  );
});

test('live-model guard: real spawn edge is blocked inside the isolated suite', async (t) => {
  const project = makeProject();
  const prev = process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
  process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
  process.env.CLAUDE_CLI_PATH = process.execPath;
  setGuestHarnessSpawnForTest(null); // force the REAL spawn path
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    if (prev === undefined) delete process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
    else process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = prev;
    delete process.env.CLAUDE_CLI_PATH;
  });
  await assert.rejects(
    runGuestHarness({ harness: 'claude', projectPath: project, prompt: 'x' }),
    (err: Error) => err.name === 'LiveModelTransportDisabledError',
  );
});

test('binary resolution: the user\'s real PATH outranks augmented discovery dirs', (t) => {
  // Live 07-30: augmentPath prepended nvm v24's stale codex 0.36.0 over the
  // active shell's 0.144.3, which then choked on the user's current
  // ~/.codex/config.toml. The user's own PATH must win when it has the CLI.
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-guest-bin-'));
  const fake = path.join(binDir, 'codex');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;
  t.after(() => {
    process.env.PATH = prevPath;
    rmSync(binDir, { recursive: true, force: true });
  });
  assert.equal(resolveGuestHarnessBinary('codex'), fake);
});

test('scanChangedFiles: bounded, skips dependency dirs, honors mtime floor', (t) => {
  const project = makeProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const before = Date.now() - 60_000;
  writeFileSync(path.join(project, 'old.txt'), 'old');
  utimesSync(path.join(project, 'old.txt'), new Date(before), new Date(before));
  mkdirSync(path.join(project, 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(project, 'node_modules', 'x', 'new.js'), 'fresh');
  writeFileSync(path.join(project, 'fresh.html'), 'fresh');

  const changed = scanChangedFiles(project, Date.now() - 10_000);
  assert.ok(changed.includes('fresh.html'));
  assert.ok(!changed.includes('old.txt'), 'files untouched since the run started must not appear');
  assert.ok(!changed.some((f) => f.includes('node_modules')), 'dependency dirs are never scanned');
});
