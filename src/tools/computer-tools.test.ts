/**
 * Run: npx tsx --test src/tools/computer-tools.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
let shellWritesInstalledSkillSource: typeof import('./computer-tools.js').shellWritesInstalledSkillSource;

before(async () => {
  ({
    getComputerTools,
    annotateShellStderr,
    annotateSpawnError,
    isProtectedInstalledSkillSourcePath,
    resolveAllowedCwd,
    shellWritesInstalledSkillSource,
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
  assert.match(out, /brew install foo|npm install -g foo/);
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

async function invokeWrite(input: { path: string; content: string; mode: 'create' | 'append' | 'overwrite' | null }): Promise<string> {
  const tool = writeTool() as unknown as {
    invoke: (runContext: unknown, input: string, details: unknown) => Promise<string>;
  };
  return tool.invoke(
    { context: { sessionId: 'sess-write-test', turn: 0 } },
    JSON.stringify(input),
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

test('write_file append creates a missing file', async () => {
  const file = path.join(tmpHome, 'missing.md');
  assert.equal(existsSync(file), false);
  assert.equal(await invokeWrite({ path: file, content: 'created by append', mode: 'append' }), `Appended ${file} (17 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'created by append\n');
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
