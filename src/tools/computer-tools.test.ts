/**
 * Run: npx tsx --test src/tools/computer-tools.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-computer-tools-test-'));
process.env.HOME = tmpHome;
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');
// In production the app always creates its home dir; mirror that so the
// existence-checked default cwd resolves to a real directory under test.
mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });

let getComputerTools: typeof import('./computer-tools.js').getComputerTools;
let annotateShellStderr: typeof import('./computer-tools.js').annotateShellStderr;
let annotateSpawnError: typeof import('./computer-tools.js').annotateSpawnError;
let isProtectedInstalledSkillSourcePath: typeof import('./computer-tools.js').isProtectedInstalledSkillSourcePath;
let resolveAllowedCwd: typeof import('./computer-tools.js').resolveAllowedCwd;
let shellMutatesAuthorizationState: typeof import('./computer-tools.js').shellMutatesAuthorizationState;
let shellWritesInstalledSkillSource: typeof import('./computer-tools.js').shellWritesInstalledSkillSource;
let writeTargetsAuthorizationState: typeof import('./computer-tools.js').writeTargetsAuthorizationState;

before(async () => {
  ({
    getComputerTools,
    annotateShellStderr,
    annotateSpawnError,
    isProtectedInstalledSkillSourcePath,
    resolveAllowedCwd,
    shellMutatesAuthorizationState,
    shellWritesInstalledSkillSource,
    writeTargetsAuthorizationState,
  } = await import('./computer-tools.js'));
});

// ─── Recoverable-failure self-recovery hints (2026-06-15) ───
// The loop must self-recover from a failed CLI call (discover the right value
// and retry), not give up. The error annotation is the GENERAL signal that
// shapes how the loop reasons after ANY failed shell call.

test('annotateShellStderr: an HTTP 404 is NOT mislabeled "binary not on PATH" (the false hint that misdirected self-recovery)', () => {
  const out = annotateShellStderr('createSiteInTeam error: 404: Not Found', 'netlify sites:create --name x --account-slug wrong');
  assert.doesNotMatch(out, /is not on PATH/i);                 // the lie is gone
  assert.match(out, /recoverable/i);                            // now a recoverable hint
  assert.match(out, /discover/i);                               // …that says discover-and-retry
  assert.match(out, /do not re-issue the identical failing command/i); // …without thrashing
});

test('annotateShellStderr: a GENUINE command-not-found still gets the install hint (no regression)', () => {
  const out = annotateShellStderr('bash: foo: command not found', 'foo --bar');
  assert.match(out, /not on PATH/i);
  if (process.platform === 'win32') {
    assert.match(out, /native Windows version/);
    assert.doesNotMatch(out, /brew/);
  } else assert.match(out, /brew install foo|npm install -g foo/);
});

test('annotateShellStderr: a CATALOG binary routes to cli_setup (approved install path), not a raw brew guess', () => {
  const out = annotateShellStderr('zsh: railway: command not found', 'railway status');
  assert.match(out, /not on PATH/i);
  assert.match(out, /cli_setup \{"action":"install","catalogId":"railway"\}/, 'the sanctioned fix is the exact tool call');
  assert.match(out, /offer, then on approval/i, 'the hint keeps the ask-first contract');
  assert.doesNotMatch(out, /brew install railway/, 'no raw package-manager guess for catalog CLIs');
});

test('annotateShellStderr: exact-run npx cache materialization failure routes to canonical CLI discovery', () => {
  const stderr = [
    'npm error code EEXIST',
    'npm error syscall rename',
    'npm error path /Users/example/.npm/_cacache/tmp/7e49db14',
    'npm error dest /Users/example/.npm/_cacache/content-v2/sha512/38/ed/cache-entry',
    'npm error errno EEXIST',
    "npm error Invalid response body while trying to fetch https://registry.npmjs.org/gopd: EACCES: permission denied, rename '/Users/example/.npm/_cacache/tmp/7e49db14' -> '/Users/example/.npm/_cacache/content-v2/sha512/38/ed/cache-entry'",
    'npm error File exists: /Users/example/.npm/_cacache/content-v2/sha512/38/ed/cache-entry',
  ].join('\n');
  const out = annotateShellStderr(
    stderr,
    'npx --yes netlify-cli sites:create --name clementine-multi-mode-harness --account-slug example-team',
  );
  assert.ok(out.startsWith(stderr), 'raw stderr is preserved ahead of the hint');
  assert.match(out, /local_cli_list/);
  assert.match(out, /local_cli_probe/);
  assert.match(out, /resolved absolute binary path directly/i);
  assert.match(out, /Do NOT repeat the identical npx\/npm-exec command/i);
  assert.match(out, /before the requested CLI started/i);
});

// ─── resolveAllowedCwd: a stringified-null cwd must not ENOENT-loop ───
// Live failure 2026-06-20: a BYO (GLM) brain emitted cwd:"null" (the literal
// string) for `netlify sites:create`; it resolved to a non-existent dir → every
// spawn failed with ENOENT → the model retried identically 7× → loop-guardrail
// ended the turn. "null"/"undefined"/"None" must degrade to the safe default.
test('resolveAllowedCwd: stringified-null cwd falls back to the default, never a bogus path', () => {
  const def = resolveAllowedCwd(undefined);
  for (const bogus of ['null', 'undefined', 'None', '', '   ']) {
    assert.equal(resolveAllowedCwd(bogus), def, `cwd "${bogus}" → default`);
    assert.doesNotMatch(resolveAllowedCwd(bogus), /\/(null|undefined|None)$/, `cwd "${bogus}" never resolves to a literal dir`);
  }
});

test('resolveAllowedCwd: a real but NON-EXISTENT in-root cwd throws a self-correcting error (not an ENOENT loop)', () => {
  const def = resolveAllowedCwd(undefined); // an existing root (BASE_DIR)
  const missing = path.join(def, 'definitely-does-not-exist-xyz');
  assert.throws(() => resolveAllowedCwd(missing), /does not exist/i);
  // an existing dir is returned unchanged
  assert.equal(resolveAllowedCwd(def), def);
});

// ─── annotateSpawnError: a spawn-LEVEL failure must be self-describing ───
// Before 2026-06-20 the child 'error' event rejected with the RAW error
// (`spawn /bin/sh ENOENT`), which never hit annotateShellStderr and named
// neither the cwd nor the binary — so the model couldn't self-correct and
// re-issued the identical call until the loop guardrail killed the turn.
test('annotateSpawnError: ENOENT names the likely causes (cwd / binary) and says do not repeat', () => {
  const err = Object.assign(new Error('spawn /bin/sh ENOENT'), { code: 'ENOENT' });
  const out = annotateSpawnError(err, 'netlify sites:create --json', '/nope/null');
  assert.match(out, /ENOENT/);
  assert.match(out, /working directory/i);            // names the cwd cause
  assert.match(out, /\/nope\/null/);                   // quotes the offending cwd
  assert.match(out, /not on PATH|binary/i);            // names the binary cause too
  assert.match(out, /do not re-issue the identical command/i); // breaks the loop
});

test('annotateSpawnError: EACCES/EPERM gives a permission hint, not a raw error', () => {
  const out = annotateSpawnError(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }), 'foo');
  assert.match(out, /permission denied/i);
  assert.match(out, /do not re-issue the identical command/i);
});

test('annotateSpawnError: an unknown spawn error still routes through the stderr annotator', () => {
  // A spawn error whose message looks like a recoverable config error should
  // still get the discover-and-retry hint via the stderr annotator fallback.
  const out = annotateSpawnError(new Error('403 Forbidden'), 'gh api /orgs/x');
  assert.match(out, /recoverable/i);
});

test('annotateShellStderr: an interactive-prompt hang nudges a non-interactive re-run', () => {
  const out = annotateShellStderr('? Team: (Use arrow keys)\nWarning: Detected unsettled top-level await', 'netlify sites:create --name x');
  assert.match(out, /recoverable/i);
  assert.match(out, /non-?interactive/i);
});

test('annotateShellStderr: generic no-such-team / 403 is treated as discoverable, not terminal', () => {
  assert.match(annotateShellStderr('Error: no such team: acme', 'somecli deploy --team acme'), /discover/i);
  assert.match(annotateShellStderr('403 Forbidden', 'gh api /orgs/x'), /recoverable/i);
});

after(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeTool(): Extract<ReturnType<typeof getComputerTools>[number], { name: 'write_file' }> {
  return getComputerTools().find((tool) => tool.name === 'write_file') as Extract<ReturnType<typeof getComputerTools>[number], { name: 'write_file' }>;
}

async function invokeWrite(input: { path: string; content: string; mode?: 'create' | 'append' | 'overwrite' | 'replace' | null; append?: boolean | null; find?: string | null }): Promise<string> {
  const tool = writeTool() as unknown as {
    invoke: (runContext: unknown, input: string, details: unknown) => Promise<string>;
  };
  const result = await tool.invoke(
    { context: { sessionId: 'sess-write-test', turn: 0 } },
    JSON.stringify(input),
    { toolCall: { callId: `call_${Date.now()}` } },
  );
  // Legacy acknowledgement checks stay readable; the raw receipt and its
  // current-byte verification are exercised in local-file-revision.test.ts.
  // A typed pre-dispatch refusal carries its text in `output`.
  const text = typeof result === 'string' ? result : ((result as { output?: string }).output ?? String(result));
  return text.replace(/^\[clementine:host-local-write-commit:v1\] [^\n]+\n/, '')
    .split('\n\n').filter(part => !part.startsWith('Previous bytes retained at ')).join('\n\n');
}

async function invokeShell(input: { command: string; cwd?: string | null; timeout_ms?: number | null }): Promise<string> {
  const shell = getComputerTools().find((tool) => tool.name === 'run_shell_command') as unknown as {
    invoke: (runContext: unknown, input: string, details: unknown) => Promise<string>;
  };
  return shell.invoke(
    { context: { sessionId: 'sess-shell-test', turn: 0 } },
    JSON.stringify({ cwd: null, timeout_ms: 10_000, ...input }),
    { toolCall: { callId: `call_${Date.now()}` } },
  );
}

test('write_file create refuses to clobber an existing file', async () => {
  const file = path.join(tmpHome, 'report.md');
  assert.equal(await invokeWrite({ path: file, content: 'first', mode: null }), `Wrote ${file} (5 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'first\n');

  const second = await invokeWrite({ path: file, content: 'second', mode: null });
  assert.match(second, /Refused to overwrite existing file/);
  assert.equal(readFileSync(file, 'utf-8'), 'first\n');
});

test('a saved-file fact keeps the accepted source of the write after asynchronous recording', async () => {
  const { createSession, appendEvent, listEvents } = await import('../runtime/harness/eventlog.js');
  const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
  const { executeLocalFileWrite } = await import('./computer-tools.js');
  const session = createSession({ kind: 'chat', title: 'file receipt source' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Write a draft.' } });
  const file = path.join(tmpHome, 'receipt-source.html');
  await withToolOutputContext({ sessionId: session.id, sourceUserSeq: source.seq }, () => executeLocalFileWrite({
    path: file, content: '<h1>Draft</h1>', mode: 'create', append: null, find: null,
  }));
  let saved = listEvents(session.id, { types: ['deliverable_saved'] });
  for (let attempt = 0; saved.length === 0 && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    saved = listEvents(session.id, { types: ['deliverable_saved'] });
  }
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.data.sourceUserSeq, source.seq);
  assert.equal(saved[0]?.data.name, 'receipt-source.html');
  assert.equal(saved[0]?.data.dir, path.basename(tmpHome));
  assert.equal(saved[0]?.role, 'system');
});

test('write_file append preserves existing content', async () => {
  const file = path.join(tmpHome, 'append.md');
  assert.equal(await invokeWrite({ path: file, content: 'alpha', mode: null }), `Wrote ${file} (5 chars).`);
  assert.equal(await invokeWrite({ path: file, content: 'beta', mode: 'append' }), `Appended ${file} (4 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'alpha\nbeta\n');
});

test('write_file overwrite requires explicit overwrite mode', async () => {
  const file = path.join(tmpHome, 'overwrite.md');
  assert.equal(await invokeWrite({ path: file, content: 'old', mode: null }), `Wrote ${file} (3 chars).`);
  assert.equal(await invokeWrite({ path: file, content: 'new', mode: 'overwrite' }), `Overwrote ${file} (3 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'new\n');
});

test('write_file overwrite is a no-op when content is already identical', async () => {
  const file = path.join(tmpHome, 'overwrite-identical.md');
  assert.equal(await invokeWrite({ path: file, content: 'same', mode: null }), `Wrote ${file} (4 chars).`);
  assert.equal(
    await invokeWrite({ path: file, content: 'same', mode: 'overwrite' }),
    `No changes needed for ${file} (4 chars already present).`,
  );
  assert.equal(readFileSync(file, 'utf-8'), 'same\n');
});

test('write_file replace changes one exact passage and keeps the rest of the file', async () => {
  const file = path.join(tmpHome, 'brief.html');
  const page = '<h1>Brief</h1>\n<p>Miami has 5,896 reviews.</p>\n<footer>keep me</footer>';
  await invokeWrite({ path: file, content: page, mode: null });
  assert.equal(
    await invokeWrite({ path: file, find: 'Miami has 5,896 reviews.', content: 'Miami has 6,012 reviews.', mode: 'replace' }),
    `Replaced one passage in ${file} (24 chars → 24 chars); the rest of the file is unchanged.`,
  );
  assert.equal(readFileSync(file, 'utf-8'), '<h1>Brief</h1>\n<p>Miami has 6,012 reviews.</p>\n<footer>keep me</footer>\n');
});

test('write_file replace refuses a passage that is missing or ambiguous, changing nothing', async () => {
  const file = path.join(tmpHome, 'ambiguous.md');
  await invokeWrite({ path: file, content: 'row\nrow\nend', mode: null });
  assert.match(String(await invokeWrite({ path: file, find: 'row', content: 'line', mode: 'replace' })),
    /appears 2 times .* Include enough surrounding text/);
  assert.match(String(await invokeWrite({ path: file, find: 'absent', content: 'x', mode: 'replace' })),
    /was not found .* copy the passage exactly/);
  assert.match(String(await invokeWrite({ path: path.join(tmpHome, 'nope.md'), find: 'a', content: 'b', mode: 'replace' })),
    /File does not exist/);
  assert.match(String(await invokeWrite({ path: file, find: 'end', content: 'fin', mode: 'replace', append: true })),
    /takes no append flag/);
  assert.equal(readFileSync(file, 'utf-8'), 'row\nrow\nend\n');
});

test('write_file append creates a missing file', async () => {
  const file = path.join(tmpHome, 'missing.md');
  assert.equal(existsSync(file), false);
  assert.equal(await invokeWrite({ path: file, content: 'created by append', mode: 'append' }), `Appended ${file} (17 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'created by append\n');
});

// ─── Chunked-by-construction: append flag + visible size cap ──────────────────

test('write_file append:true appends (creating if absent) — the chunk continuation path', async () => {
  const file = path.join(tmpHome, 'chunked.html');
  // First chunk with append:false starts the file fresh (overwrite semantics).
  assert.equal(await invokeWrite({ path: file, content: '<html>', mode: null, append: false }), `Overwrote ${file} (6 chars).`);
  // Continuation chunks with append:true.
  assert.equal(await invokeWrite({ path: file, content: '<body>', mode: null, append: true }), `Appended ${file} (6 chars).`);
  assert.equal(await invokeWrite({ path: file, content: '</body></html>', mode: null, append: true }), `Appended ${file} (14 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), '<html>\n<body>\n</body></html>\n');
});

test('write_file append:true creates the file when absent', async () => {
  const file = path.join(tmpHome, 'chunk-fresh.txt');
  assert.equal(existsSync(file), false);
  assert.equal(await invokeWrite({ path: file, content: 'first chunk', mode: null, append: true }), `Appended ${file} (11 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'first chunk\n');
});

test('write_file append:false starts a fresh file even when one exists (chunk-restart)', async () => {
  const file = path.join(tmpHome, 'restart.txt');
  assert.equal(await invokeWrite({ path: file, content: 'stale partial', mode: null }), `Wrote ${file} (13 chars).`);
  assert.equal(await invokeWrite({ path: file, content: 'fresh start', mode: null, append: false }), `Overwrote ${file} (11 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'fresh start\n');
});

test('write_file retains complete content above the former cap, including multibyte text', async () => {
  for (const [name, content] of [['large.html', '<p>Complete section</p>\n'.repeat(4000)], ['multibyte.txt', '€'.repeat(12000)]]) {
    const file = path.join(tmpHome, name!);
    const result = await invokeWrite({ path: file, content: content!, mode: null });
    assert.match(result, /^Wrote /);
    assert.equal(readFileSync(file, 'utf8'), content!.endsWith('\n') ? content : content + '\n');
  }
});

test('write_file append:null with mode is byte-identical to prior behavior (backward compatible)', async () => {
  const file = path.join(tmpHome, 'compat.txt');
  // No append field at all → mode drives it exactly as before.
  assert.equal(await invokeWrite({ path: file, content: 'hello', mode: null }), `Wrote ${file} (5 chars).`);
  assert.match(await invokeWrite({ path: file, content: 'again', mode: null }), /Refused to overwrite existing file/);
  assert.equal(readFileSync(file, 'utf-8'), 'hello\n');
});

test('write_file warns that raw workspace files still require space_save', async () => {
  const file = path.join(process.env.CLEMENTINE_HOME!, 'spaces', 'proof-cockpit', 'view', 'index.html');
  const out = await invokeWrite({ path: file, content: '<html><body>Proof</body></html>', mode: null });
  assert.match(out, /^Wrote /);
  assert.match(out, /NOT a registered Console workspace/);
  assert.match(out, /NEXT REQUIRED TOOL CALL/);
  assert.match(out, /space_save/);
  assert.match(out, /\/api\/console\/spaces\/proof-cockpit will return 404/);
  assert.equal(readFileSync(file, 'utf-8'), '<html><body>Proof</body></html>\n');
});

test('write_file warns when a workspace file lands in the wrong Clementine home', async () => {
  const file = path.join(tmpHome, 'other', '.clementine-next', 'spaces', 'proof-cockpit', 'view', 'index.html');
  const out = await invokeWrite({ path: file, content: '<html><body>Wrong home</body></html>', mode: null });
  assert.match(out, /^Wrote /);
  assert.match(out, /wrong home for this run/);
  assert.match(out, new RegExp(process.env.CLEMENTINE_HOME!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out, /\/api\/console\/spaces\/proof-cockpit will still return 404/);
  assert.equal(readFileSync(file, 'utf-8'), '<html><body>Wrong home</body></html>\n');
});

test('write_file refuses raw writes to typed team-agent and pending-action state', async () => {
  const base = process.env.CLEMENTINE_HOME!;
  const cases = [
    {
      file: path.join(base, 'Vault', '00-System', 'agents', 'proof-builder', 'agent.md'),
      tool: /create_agent or update_agent/,
    },
    {
      file: path.join(base, 'team-requests', 'manual.json'),
      tool: /team_request/,
    },
    {
      file: path.join(base, 'delegations', 'proof-builder', 'manual.json'),
      tool: /delegate_task/,
    },
    {
      file: path.join(base, 'pending-actions', 'manual.json'),
      tool: /pending_action_queue or pending_action_record_result/,
    },
  ];
  for (const item of cases) {
    const out = await invokeWrite({ path: item.file, content: '{}', mode: null });
    assert.match(out, /Refused raw write to typed Clementine state/);
    assert.match(out, item.tool);
    assert.equal(existsSync(item.file), false, item.file);
  }

  const log = path.join(base, 'logs', 'team-comms.jsonl');
  const out = await invokeWrite({ path: log, content: '{}', mode: null });
  assert.match(out, /Refused raw write to Clementine team communication log/);
  assert.equal(existsSync(log), false);
});

test('authorization stores reject model-driven writes while read-only inspection stays available', () => {
  const base = process.env.CLEMENTINE_HOME!;
  const pendingFile = path.join(base, 'pending-actions', 'pa-proof.json');
  const harnessDb = path.join(base, 'state', 'harness.db');
  const mutationReceipt = path.join(
    base,
    'Vault',
    '00-System',
    'workflows',
    'proof',
    'runs',
    'run-1',
    'call-mutations',
    'fingerprint',
    'receipt.json',
  );
  assert.equal(writeTargetsAuthorizationState(pendingFile), true);
  assert.equal(writeTargetsAuthorizationState(harnessDb), true);
  assert.equal(writeTargetsAuthorizationState(mutationReceipt), true);

  assert.equal(
    shellMutatesAuthorizationState(
      `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pendingFile)}, '{}')`)}`,
      base,
    ),
    true,
  );
  assert.equal(
    shellMutatesAuthorizationState(`sqlite3 ${JSON.stringify(harnessDb)} "UPDATE pending_approvals SET status='resolved'"`, base),
    true,
  );
  assert.equal(
    shellMutatesAuthorizationState(`cat ${JSON.stringify(pendingFile)}`, base),
    false,
    'read-only inspection is not blocked',
  );
  assert.equal(
    shellMutatesAuthorizationState(`sqlite3 ${JSON.stringify(harnessDb)} "SELECT status FROM pending_approvals"`, base),
    false,
    'read-only database inspection is not blocked',
  );
});

test('run_shell_command hard-denies an interpreter write into pending-action authority', async () => {
  const target = path.join(process.env.CLEMENTINE_HOME!, 'pending-actions', 'pa-shell-proof.json');
  mkdirSync(path.dirname(target), { recursive: true });
  const program = `require('node:fs').writeFileSync(${JSON.stringify(target)}, '{}')`;
  const output = await invokeShell({ command: `node -e ${JSON.stringify(program)}` });
  assert.match(
    output,
    /cannot mutate Clementine authorization state/i,
  );
  assert.equal(existsSync(target), false);
});

test('installed skill source paths are protected while artifact paths stay writable', () => {
  const skillRoot = path.join(process.env.CLEMENTINE_HOME!, 'skills', 'lunar');
  assert.equal(isProtectedInstalledSkillSourcePath(path.join(skillRoot, 'build.cjs')), true);
  assert.equal(isProtectedInstalledSkillSourcePath(path.join(skillRoot, 'src', 'validate-html.js')), true);
  assert.equal(isProtectedInstalledSkillSourcePath(path.join(skillRoot, 'references', 'pipeline.md')), true);
  assert.equal(isProtectedInstalledSkillSourcePath(path.join(skillRoot, 'output', 'index.html')), false);
  assert.equal(isProtectedInstalledSkillSourcePath(path.join(skillRoot, 'runs', '2026-06-25', 'notes.md')), false);
  assert.equal(isProtectedInstalledSkillSourcePath(path.join(tmpHome, 'not-a-skill', 'build.cjs')), false);
});

test('shellWritesInstalledSkillSource blocks obvious source writes but permits report outputs and normal execution', () => {
  const skillRoot = path.join(process.env.CLEMENTINE_HOME!, 'skills', 'lunar');
  assert.equal(shellWritesInstalledSkillSource('cat > build.cjs', skillRoot), true);
  assert.equal(shellWritesInstalledSkillSource("node -e \"require('fs').writeFileSync('src/validate-html.js', 'x')\"", skillRoot), true);
  assert.equal(shellWritesInstalledSkillSource('tee references/pipeline.md', skillRoot), true);
  assert.equal(shellWritesInstalledSkillSource('cp templates/report.html output/index.html', skillRoot), false);
  assert.equal(shellWritesInstalledSkillSource('cat > output/index.html', skillRoot), false);
  assert.equal(shellWritesInstalledSkillSource('node gather.cjs', skillRoot), false);
});

test('write_file refuses installed skill source writes but permits output artifacts', async () => {
  const skillRoot = path.join(process.env.CLEMENTINE_HOME!, 'skills', 'lunar');
  const sourceFile = path.join(skillRoot, 'build.cjs');
  const artifactFile = path.join(skillRoot, 'output', 'index.html');

  const refused = await invokeWrite({ path: sourceFile, content: 'mutated source', mode: null });
  assert.match(refused, /installed skill source files are read-only/i);
  assert.equal(existsSync(sourceFile), false);

  assert.equal(await invokeWrite({ path: artifactFile, content: '<html></html>', mode: null }), `Wrote ${artifactFile} (13 chars).`);
  assert.equal(readFileSync(artifactFile, 'utf-8'), '<html></html>\n');
});

test('shellMutatesMemoryStore: blocks SQL mutation of the facts store, allows read-only + unrelated', async () => {
  const { shellMutatesMemoryStore } = await import('./computer-tools.js');
  // Blocked — mutation against the store.
  assert.equal(shellMutatesMemoryStore("sqlite3 ~/.clementine-next/state/memory.db \"UPDATE consolidated_facts SET pinned=0 WHERE id=1161\""), true);
  assert.equal(shellMutatesMemoryStore("sqlite3 memory.db 'DELETE FROM consolidated_facts WHERE id=5'"), true);
  assert.equal(shellMutatesMemoryStore("sqlite3 state/memory.db 'INSERT INTO fact_embeddings VALUES (1)'"), true);
  assert.equal(shellMutatesMemoryStore("sqlite3 memory.db 'DROP TABLE consolidated_facts'"), true);
  // Allowed — read-only inspection.
  assert.equal(shellMutatesMemoryStore("sqlite3 -readonly memory.db 'SELECT * FROM consolidated_facts LIMIT 5'"), false);
  assert.equal(shellMutatesMemoryStore("sqlite3 memory.db '.schema consolidated_facts'"), false);
  assert.equal(shellMutatesMemoryStore("sqlite3 memory.db '.tables'"), false);
  // Allowed — unrelated commands (no memory-store reference).
  assert.equal(shellMutatesMemoryStore("sqlite3 other.db 'UPDATE foo SET x=1'"), false);
  assert.equal(shellMutatesMemoryStore("echo hello && ls -la"), false);
  assert.equal(shellMutatesMemoryStore(undefined), false);
});

// ---------------------------------------------------------------------------
// Protected own-stores (2026-07-21 break-scenario A): "clean up my disk" must
// never be able to destroy Clementine's own memory/eventlog/audit/secrets.
// ---------------------------------------------------------------------------
// Dynamic imports — this file sets CLEMENTINE_HOME before loading modules;
// a static import here would hoist above that and freeze config to the REAL
// home (it broke the workspace-notice tests exactly that way).
const { shellDestroysOwnStores, writeTargetsProtectedOwnStore } = await import('./computer-tools.js');
const { BASE_DIR } = await import('../config.js');

test('shell guard: destructive verbs against own stores are refused; reads and normal cleanup pass', () => {
  // The disk-cleanup class that used to sail through:
  assert.equal(shellDestroysOwnStores('rm -rf ~/.clementine/state'), true);
  assert.equal(shellDestroysOwnStores('rm ~/.clementine/state/memory.db'), true);
  assert.equal(shellDestroysOwnStores('rm -rf ~/.clementine'), true, 'the WHOLE home is the biggest single miss of the old denylist');
  assert.equal(shellDestroysOwnStores('rm -rf ~/.clementine-next/*'), true);
  assert.equal(shellDestroysOwnStores('find ~/.clementine -mtime +30 -delete'), true, 'a home-root sweep with -delete is destruction');
  assert.equal(shellDestroysOwnStores('rm ~/.clementine/vault/old-note.md'), false, 'deleting one vault note stays legal');
  assert.equal(shellDestroysOwnStores('rm ~/.clementine/files/stale.pdf'), false, 'staging cleanup stays legal');
  assert.equal(shellDestroysOwnStores('find ~/.clementine/state -mtime +30 -delete'), true);
  assert.equal(shellDestroysOwnStores('rm -rf /Users/x/.clementine-next/audit'), true);
  assert.equal(shellDestroysOwnStores('shred memory.db'), true);
  assert.equal(shellDestroysOwnStores('rm ~/.clementine/workflows/lead-gen.md'), true, 'workflow defs delete via proper tools, not shell');
  // Legitimate operations stay open:
  assert.equal(shellDestroysOwnStores('ls -la ~/.clementine/state'), false, 'inspection untouched');
  assert.equal(shellDestroysOwnStores('sqlite3 ~/.clementine/state/harness.db "SELECT count(*) FROM events"'), false, 'reads untouched');
  assert.equal(shellDestroysOwnStores('rm -rf ./node_modules'), false, 'normal workspace cleanup untouched');
  assert.equal(shellDestroysOwnStores('rm /tmp/scratch.txt'), false);
  assert.equal(shellDestroysOwnStores('cp ~/.clementine/state/memory.db /tmp/backup.db'), false, 'copying OUT is fine');
});

test('write_file guard: resolved paths into state/audit/secrets are refused; vault/files stay writable', () => {
  assert.equal(writeTargetsProtectedOwnStore(path.join(BASE_DIR, 'state', 'memory.db')), true);
  assert.equal(writeTargetsProtectedOwnStore(path.join(BASE_DIR, 'state', 'anything.json')), true, 'the whole state dir is the blast zone');
  assert.equal(writeTargetsProtectedOwnStore(path.join(BASE_DIR, 'audit', 'audit-2026-07.jsonl')), true);
  assert.equal(writeTargetsProtectedOwnStore(path.join(BASE_DIR, '.env')), true);
  assert.equal(writeTargetsProtectedOwnStore('/anywhere/else/memory.db'), true, 'named stores protected regardless of location');
  assert.equal(writeTargetsProtectedOwnStore(path.join(BASE_DIR, 'vault', 'notes.md')), false, 'the vault stays writable');
  assert.equal(writeTargetsProtectedOwnStore(path.join(BASE_DIR, 'files', 'documents', 'letter.pdf')), false, 'file pipeline stays writable');
  assert.equal(writeTargetsProtectedOwnStore('/tmp/report.md'), false);
});

test('shellWriteLeadPaths: a relative redirect after an in-command cd resolves against the cd target', async () => {
  const { shellWriteLeadPaths } = await import('./computer-tools.js');
  // The live 2026-08-05 shape: seven files written via `cd DIR && cat > x.md`
  // were invisible because the lead resolved only against the spawn cwd.
  const leads = shellWriteLeadPaths(
    "mkdir -p /tmp/deliver-test && cd /tmp/deliver-test && cat > profile.md <<'EOF'\ncontent\nEOF",
    '/spawn/cwd',
  );
  assert.deepEqual(leads[0], ['/spawn/cwd/profile.md', '/tmp/deliver-test/profile.md'],
    'the redirect target comes first; both bases are candidates, spawn cwd first, cd target second');
  assert.ok(!leads.some((lead) => lead.some((candidate) => candidate.includes('content'))), 'heredoc text is not an argument');
  // Absolute targets need no base juggling.
  const absolute = shellWriteLeadPaths('echo hi > /tmp/out.md', '/spawn/cwd');
  assert.deepEqual(absolute[0], ['/tmp/out.md']);
});

test('shellWriteLeadPaths: a file written through a variable or an output flag is a lead; a stderr log is not', async () => {
  const { shellWriteLeadPaths } = await import('./computer-tools.js');
  const home = os.homedir();
  // The live 2026-10-09 shape: a PDF printed to a path held in a variable.
  const leads = shellWriteLeadPaths(
    'OUT="$HOME/Downloads/slide-7.pdf"; rm -f "$OUT"; "/Applications/Some Browser.app/Contents/MacOS/Some Browser" '
      + '--headless=new --print-to-pdf="$OUT" file:///tmp/slide7.html 2>/tmp/browser.err; ls -la "$OUT"',
    '/spawn/cwd',
  ).flat();
  assert.ok(leads.includes(path.join(home, 'Downloads', 'slide-7.pdf')), JSON.stringify(leads));
  assert.ok(!leads.includes('/tmp/browser.err'), 'a stderr log is not a deliverable');
  assert.ok(!leads.some((lead) => lead.includes('file:')), 'a URL is not a path');
  const forms = shellWriteLeadPaths(
    "export DIR='/tmp/out dir'; NAME=report; cp notes.md \"${DIR}/$NAME.md\" && tool -o result.json",
    '/spawn/cwd',
  ).flat();
  assert.ok(forms.includes('/tmp/out dir/report.md'), JSON.stringify(forms));
  assert.ok(forms.includes('/spawn/cwd/result.json'));
  assert.deepEqual(shellWriteLeadPaths('make build 2>&1', '/spawn/cwd'), []);
});

test('a file a shell command writes through a variable is recorded as saved; its stderr log is not', async () => {
  const { createSession, appendEvent, listEvents } = await import('../runtime/harness/eventlog.js');
  const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
  const session = createSession({ kind: 'chat', title: 'shell deliverable' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Save it as a file.' } });
  const out = path.join(tmpHome, 'deliver', 'slide.txt');
  const log = path.join(tmpHome, 'deliver', 'tool.err');
  const ran = await withToolOutputContext({ sessionId: session.id, sourceUserSeq: source.seq }, () => invokeShell({
    command: `mkdir -p "${path.dirname(out)}" && OUT="${out}"; printf 'slide text' | tee "$OUT" >/dev/null 2>"${log}"`,
    cwd: tmpHome,
  }));
  assert.match(String(ran), /exit_code: 0/, String(ran));
  let saved = listEvents(session.id, { types: ['deliverable_saved'] });
  for (let attempt = 0; saved.length === 0 && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    saved = listEvents(session.id, { types: ['deliverable_saved'] });
  }
  assert.deepEqual(saved.map((event) => event.data.name), ['slide.txt'], 'the written file, not its stderr log');
  assert.equal(saved[0]?.data.sourceUserSeq, source.seq);
});

test('a path the command only reads or assigns is not saved, even when it was written a moment before', async () => {
  const { createSession, appendEvent, listEvents } = await import('../runtime/harness/eventlog.js');
  const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
  const session = createSession({ kind: 'chat', title: 'shell reads' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Check it.' } });
  const dir = path.join(tmpHome, 'reads');
  mkdirSync(dir, { recursive: true });
  const input = path.join(dir, 'recent-input.pdf');
  writeFileSync(input, '%PDF-1.4 just written');
  const unused = path.join(dir, 'never-written.pdf');
  const written = path.join(dir, 'written.txt');
  const ran = await withToolOutputContext({ sessionId: session.id, sourceUserSeq: source.seq }, () => invokeShell({
    command: `IN="${input}"; NOPE="${unused}"; OUT="${written}"; cat "$IN" | wc -c; ls -la "$IN"; cp "$IN" "$OUT"`,
    cwd: tmpHome,
  }));
  assert.match(String(ran), /exit_code: 0/, String(ran));
  let saved = listEvents(session.id, { types: ['deliverable_saved'] });
  for (let attempt = 0; saved.length === 0 && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    saved = listEvents(session.id, { types: ['deliverable_saved'] });
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  saved = listEvents(session.id, { types: ['deliverable_saved'] });
  assert.deepEqual(saved.map((event) => event.data.name), ['written.txt'],
    'only the file the command wrote; the input it read and the path it never wrote are not saved');
});

// ── Credential reads are refused, never carded (owner rule 2026-08-07) ──
test('a credential-touching command is refused outright — an autonomous run is never stopped to be asked', async () => {
  const { assertCommandAllowed, needsApprovalForShellSmart } = await import('./computer-tools.js');

  // Live 2026-08-07: mid-scrape, Clem tried to read ~/.apify/auth.json. The
  // run parked for six silent minutes on an approval whose answer is always
  // no. Refusing costs nothing, keeps the secret out of context entirely, and
  // steers to the connection that already works.
  const credentialCommands = [
    'cat ~/.apify/auth.json',
    'env | grep -i OPENAI_API_KEY',
    'cat .env',
    'security find-generic-password -s composio',
  ];
  for (const command of credentialCommands) {
    assert.throws(
      () => assertCommandAllowed(command),
      /Refused: this reads credential material|safety policy/,
      command,
    );
    // …and it is NOT converted into an approval interrupt.
    assert.equal(
      await needsApprovalForShellSmart()({}, { command }),
      false,
      `${command} must never become an approval`,
    );
  }

  // Ordinary work is untouched: no refusal, no new nagging.
  assert.doesNotThrow(() => assertCommandAllowed('ls ~/Documents'));
  assert.doesNotThrow(() => assertCommandAllowed('git status'));
});

// ── Blocking sleep is refused (live 2026-08-07: ~5 min of a 40-min run) ──
test('a command whose only job is waiting is refused; real work that happens to pause is not', async () => {
  const { assertCommandAllowed, longBlockingSleepSeconds } = await import('./computer-tools.js');

  // The exact live commands.
  for (const command of ['sleep 75 && echo waited', 'sleep 90 && echo waited', 'sleep 115 && echo waited']) {
    assert.throws(() => assertCommandAllowed(command), /Refused: this command just waits/, command);
  }
  // Poll loops built around sleep are the same waste in a bow.
  assert.throws(
    () => assertCommandAllowed('while true; do sleep 30; curl -s https://api.example.test/status; done'),
    /Refused: this command just waits/,
  );

  // Real work is untouched, including a short courtesy pause between calls.
  assert.equal(longBlockingSleepSeconds('sleep 2 && curl -s https://api.example.test/x'), null);
  assert.doesNotThrow(() => assertCommandAllowed('sleep 2 && curl -s https://api.example.test/x'));
  assert.doesNotThrow(() => assertCommandAllowed('npm test'));
  assert.equal(longBlockingSleepSeconds('python3 analyze.py --window 90'), null, 'a number is not a sleep');
  // Aggregate waits count: three chained sleeps are still just waiting.
  assert.equal(longBlockingSleepSeconds('sleep 5; sleep 5; sleep 5; echo done'), 15);
});

test('a refused create is a typed not-started refusal, never a settled mutation', async () => {
  // Live 2026-10-05: create → "Refused to overwrite" → overwrite left the final
  // file exact, yet the turn ended blocked because the refusal, returned as
  // prose, settled as a succeeded write owing a receipt. The nominal carrier is
  // what the settlement reads; the model still gets the repair text.
  const { executeLocalFileWrite } = await import('./computer-tools.js');
  const { InvalidArgumentsPreDispatchResult, attemptSignalsFromTypedResult } = await import('../runtime/harness/attempt-settlement.js');
  const file = path.join(tmpHome, 'refused-create.md');
  assert.equal(await invokeWrite({ path: file, content: 'first', mode: null }), `Wrote ${file} (5 chars).`);
  const refused = await executeLocalFileWrite({ path: file, content: 'second', mode: 'create', append: null, find: null });
  assert.ok(refused instanceof InvalidArgumentsPreDispatchResult, 'typed, not prose');
  assert.match((refused as unknown as { output: string }).output, /Refused to overwrite existing file.*mode="overwrite"/);
  assert.deepEqual(attemptSignalsFromTypedResult(refused), { preDispatch: true, argumentValidationFailed: true, schemaAvailable: true });
  assert.equal(readFileSync(file, 'utf-8'), 'first\n');
  // The sibling revision conflict already rode this carrier; both agree.
  const replaced = await executeLocalFileWrite({ path: file, content: 'x', mode: 'replace', append: null, find: 'absent passage' });
  assert.ok(replaced instanceof InvalidArgumentsPreDispatchResult);
});

test('a shell command whose working folder does not exist is refused before it starts, as a repairable argument', async () => {
  // Live 2026-10-09: an approved command named a folder that does not exist;
  // nothing ran, yet it settled as a possible external write and the owner
  // was told it had run. The folder check is a typed no-dispatch refusal.
  const { InvalidArgumentsPreDispatchResult, attemptSignalsFromTypedResult } = await import('../runtime/harness/attempt-settlement.js');
  const missing = path.join(tmpHome, 'no-such-folder');
  const result = await invokeShell({ command: 'echo should-not-run', cwd: missing }) as unknown;
  assert.ok(result instanceof InvalidArgumentsPreDispatchResult, `got ${typeof result}: ${String((result as { output?: string })?.output ?? result).slice(0, 200)}`);
  assert.match((result as { output: string }).output, /The command did not run: cwd does not exist/);
  const signals = attemptSignalsFromTypedResult(result);
  assert.equal(signals.preDispatch, true);
  assert.equal(signals.argumentValidationFailed, true);
});
