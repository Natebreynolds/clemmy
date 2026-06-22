/**
 * code-mode-sandbox — run an untrusted, model-authored program in a locked-down
 * child process whose ONLY channel to the world is a JSON-RPC pipe back to the
 * parent (Lane C Code Mode, Phase 1). The program loops/filters/paginates
 * internally and returns a DISTILLED value, so intermediate tool results never
 * enter the model's context — the token win.
 *
 * ISOLATION (defense-in-depth, no network/fs/subprocess escape):
 *   - The program is ESM (.mjs) → NO `require`; the only module path is import.
 *   - A `--import` blocker runs FIRST and `module.registerHooks` a resolve hook
 *     that THROWS for fs / child_process / net / http(s) / dns / tls / worker /
 *     vm / module / … — covering static import, dynamic import(), and require.
 *     So the program can load NOTHING dangerous; it cannot touch the filesystem,
 *     spawn, or open a socket via a module.
 *   - The blocker deletes the no-import network globals (fetch / WebSocket / …)
 *     and the process-internal escape hatches (binding / dlopen).
 *   - Bounded: wall-clock timeout (kill), max RPC calls, max return size.
 * The program reaches Clementine ONLY through `clem.<tool>(args)`, which the
 * PARENT dispatches through the real gated tool path — so Phase 2 (gated writes)
 * adds tools to the allowlist with the gates already covering them.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type CodeModeDispatch = (method: string, args: unknown) => Promise<unknown>;

export interface CodeModeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  rpcCalls: number;
  logs: string[];
}

export interface CodeModeOptions {
  timeoutMs?: number;
  maxRpcCalls?: number;
  maxReturnChars?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RPC = 200;
const DEFAULT_MAX_RETURN = 16_000;

// The --import blocker: blocks dangerous module loads (import / import() / require)
// and removes the no-import network/internal escape hatches. Written into the
// sandbox temp dir at runtime (so it ships without a .mjs build step).
const BLOCKER_SRC = `
import module from 'node:module';
const BLOCKED = /^(node:)?(fs|fs\\/promises|child_process|net|http|https|http2|dns|dns\\/promises|tls|dgram|cluster|worker_threads|module|vm|inspector|repl|v8|wasi|perf_hooks|trace_events|diagnostics_channel|os|readline|tty)$/;
try {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (BLOCKED.test(specifier)) throw new Error('code-mode sandbox: module "' + specifier + '" is blocked');
      return nextResolve(specifier, context);
    },
  });
} catch (e) {
  // If registerHooks is unavailable, fail CLOSED: refuse to run rather than run unsandboxed.
  process.stderr.write('code-mode sandbox: registerHooks unavailable (' + ((e && e.message) || e) + ')\\n');
  process.exit(73);
}
for (const g of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'navigator']) {
  try { delete globalThis[g]; } catch {}
}
try { delete process.binding; } catch {}
try { delete process.dlopen; } catch {}
`;

/** Wrap the user program: clem RPC over stdin/stdout, console → stderr (stdout is
 *  protocol-only), run the body, emit the distilled return. ESM (no require). */
function buildProgramSource(userProgram: string): string {
  return `
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\\n');
console.error = console.log; console.warn = console.log; console.info = console.log; console.debug = console.log;
let __seq = 0; const __pending = new Map();
process.stdin.setEncoding('utf8');
let __buf = '';
process.stdin.on('data', (d) => {
  __buf += d; let nl;
  while ((nl = __buf.indexOf('\\n')) >= 0) {
    const line = __buf.slice(0, nl); __buf = __buf.slice(nl + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); const p = __pending.get(m.id); if (p) { __pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); } } catch {}
  }
});
const __rpc = (method, args) => new Promise((resolve, reject) => {
  const id = ++__seq; __pending.set(id, { resolve, reject });
  process.stdout.write(JSON.stringify({ __cm: 'rpc', id, method, args: args === undefined ? null : args }) + '\\n');
});
// clem.<toolName>(args) → one gated tool call, dispatched by the parent.
const clem = new Proxy({}, { get: (_t, prop) => (args) => __rpc(String(prop), args) });
(async () => {
  try {
    const __ret = await (async () => { ${userProgram}\n })();
    process.stdout.write(JSON.stringify({ __cm: 'return', value: __ret === undefined ? null : __ret }) + '\\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ __cm: 'error', error: (e && e.message) || String(e) }) + '\\n');
  }
  process.exit(0);
})();
`;
}

/**
 * Run a model-authored program in the sandbox. `dispatch(method, args)` is how a
 * `clem.<method>(args)` call is fulfilled — the caller decides which tools are
 * reachable (Phase 1: read-only allowlist). Returns the distilled value or an
 * error. Never throws (a sandbox/dispatch failure is reported in the result).
 */
export async function runCodeModeProgram(
  program: string,
  dispatch: CodeModeDispatch,
  opts: CodeModeOptions = {},
): Promise<CodeModeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRpc = opts.maxRpcCalls ?? DEFAULT_MAX_RPC;
  const maxReturn = opts.maxReturnChars ?? DEFAULT_MAX_RETURN;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-codemode-'));
  const blockerPath = path.join(dir, 'blocker.mjs');
  const progPath = path.join(dir, 'program.mjs');
  writeFileSync(blockerPath, BLOCKER_SRC, 'utf8');
  writeFileSync(progPath, buildProgramSource(program), 'utf8');

  const logs: string[] = [];
  let rpcCalls = 0;
  let result: CodeModeResult | null = null;

  return await new Promise<CodeModeResult>((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', '--import', blockerPath, progPath], {
      cwd: dir,
      // Minimal env — NO inherited secrets/tokens. Only what Node needs to boot.
      env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    const finish = (r: CodeModeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      resolve(r);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `code-mode program exceeded ${timeoutMs}ms and was killed`, rpcCalls, logs });
    }, timeoutMs);

    let outBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      outBuf += d;
      let nl: number;
      while ((nl = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, nl); outBuf = outBuf.slice(nl + 1);
        if (!line) continue;
        let msg: { __cm?: string; id?: number; method?: string; args?: unknown; value?: unknown; error?: string };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.__cm === 'rpc' && typeof msg.id === 'number' && typeof msg.method === 'string') {
          rpcCalls += 1;
          if (rpcCalls > maxRpc) {
            try { child.stdin.write(JSON.stringify({ id: msg.id, error: `code-mode RPC budget exceeded (${maxRpc})` }) + '\n'); } catch { /* ignore */ }
            finish({ ok: false, error: `code-mode program exceeded the RPC budget (${maxRpc} tool calls)`, rpcCalls, logs });
            return;
          }
          const id = msg.id; const method = msg.method; const args = msg.args;
          void Promise.resolve()
            .then(() => dispatch(method, args))
            .then((res) => { try { child.stdin.write(JSON.stringify({ id, result: res ?? null }) + '\n'); } catch { /* child gone */ } })
            .catch((e: unknown) => { try { child.stdin.write(JSON.stringify({ id, error: e instanceof Error ? e.message : String(e) }) + '\n'); } catch { /* child gone */ } });
        } else if (msg.__cm === 'return') {
          const json = JSON.stringify(msg.value ?? null);
          const value = json.length > maxReturn ? JSON.parse(JSON.stringify(`${json.slice(0, maxReturn)}…[truncated ${json.length - maxReturn} chars]`)) : msg.value ?? null;
          result = { ok: true, value, rpcCalls, logs };
        } else if (msg.__cm === 'error') {
          result = { ok: false, error: String(msg.error ?? 'unknown program error'), rpcCalls, logs };
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { if (logs.join('').length < 8000) logs.push(d); });

    child.on('error', (e) => finish({ ok: false, error: `code-mode spawn failed: ${e.message}`, rpcCalls, logs }));
    child.on('exit', (code) => {
      if (result) return finish(result);
      if (code === 73) return finish({ ok: false, error: 'code-mode sandbox failed to initialize (registerHooks unavailable) — refused to run unsandboxed', rpcCalls, logs });
      finish({ ok: false, error: `code-mode program exited (${code ?? 'signal'}) without returning a value`, rpcCalls, logs });
    });
  });
}
