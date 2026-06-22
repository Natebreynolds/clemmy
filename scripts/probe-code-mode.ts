/**
 * probe:code-mode — run a REAL code-mode program against this machine's read-only
 * tools (Lane C Phase 1 live check). Proves the full path end-to-end: the
 * sandbox runs the program, each clem.<tool> call is dispatched through the gated
 * tool path to a REAL read-only tool, and only the distilled value comes back.
 * Safe: read-only allowlist, no external action.
 *
 * Run: CLEMENTINE_HOME="$HOME/.clementine-next" npx tsx scripts/probe-code-mode.ts
 */
import { runCodeModeForSession } from '../src/tools/code-mode-tool.js';

// A program that makes SEVERAL read-only tool calls in a loop and returns ONE
// distilled object — the whole point: intermediate results stay in the sandbox.
const program = `
  const roots = await clem.workspace_roots({});
  let calls = 1;
  // Simulate a data-heavy loop: repeat a read a few times, aggregate in-sandbox.
  for (let i = 0; i < 3; i++) { await clem.workspace_roots({}); calls++; }
  return {
    note: 'computed inside the sandbox; only this object reached the model',
    workspaceRootsResult: roots,
    toolCallsInProgram: calls,
  };
`;

const r = await runCodeModeForSession(program, 'probe:code-mode');
console.log('\n  Code Mode live probe (real read-only tools, real auth)\n');
console.log('  ok:        ', r.ok);
console.log('  rpcCalls:  ', r.rpcCalls, '(all dispatched through the gated tool path)');
if (r.ok) {
  console.log('  return:    ', JSON.stringify(r.value));
} else {
  console.log('  error:     ', r.error);
  if (r.logs.length) console.log('  logs:      ', r.logs.join('').slice(0, 400));
}

// Phase 2: a REAL gated WRITE through code-mode (only when writes are enabled).
// write_file to a workspace path is a local write that passes the gates and
// actually creates the file — proving in-program writes work end-to-end.
if ((process.env.CLEMMY_CODE_MODE_WRITES || '').toLowerCase() === 'on') {
  const { existsSync, readFileSync, rmSync } = await import('node:fs');
  const target = `${process.env.HOME}/.clementine-next/cm-write-probe.txt`;
  try { rmSync(target, { force: true }); } catch { /* ignore */ }
  const writeProgram = `
    const stamp = 'CODE-MODE-WRITE ' + (await clem.workspace_roots({})).slice(0,8);
    await clem.write_file({ path: ${JSON.stringify(target)}, content: stamp, mode: 'overwrite' });
    return { wrote: true };
  `;
  const w = await runCodeModeForSession(writeProgram, 'probe:code-mode-write');
  console.log('\n  Code Mode live WRITE probe (gated write_file through the sandbox)\n');
  console.log('  ok:           ', w.ok, w.ok ? '' : `(${w.error})`);
  console.log('  file created: ', existsSync(target));
  if (existsSync(target)) console.log('  contents:     ', JSON.stringify(readFileSync(target, 'utf8').slice(0, 80)));
}
console.log('');
