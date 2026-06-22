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
console.log('');
