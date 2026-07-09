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

/** What a failed program still managed to do — so a timeout at fetch 48/50
 *  hands the model 48 results to salvage instead of a bare error that forces
 *  a full redo (strategic-wave Track 4; live 2026-07-07: a 60s kill lost all
 *  10 send confirmations). Populated on any non-ok finish with RPC activity. */
export interface CodeModePartial {
  completed: number;
  failed: number;
  /** Most recent completed calls (bounded ring, previews truncated). */
  recent: Array<{ method: string; ok: boolean; preview: string }>;
}

export interface CodeModeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  rpcCalls: number;
  logs: string[];
  partial?: CodeModePartial;
}

export interface CodeModeOptions {
  /** HARD ceiling. When omitted, CLEMMY_CODEMODE_MAX_MS (default 180s). */
  timeoutMs?: number;
  maxRpcCalls?: number;
  maxReturnChars?: number;
  /** Idle deadline: kill only after this long with NO observable activity
   *  (RPC request/completion, progress, stderr). A program actively completing
   *  tool calls is not stuck — the old flat 60s killed exactly the multi-fetch
   *  programs code mode exists for. 0 disables (ceiling only). Default
   *  CLEMMY_CODEMODE_IDLE_MS or 20s. */
  idleTimeoutMs?: number;
  /** Called for each `clem.progress('...')` the program emits — wired to the
   *  live activity line so long programs read as supervised, not hung. */
  onProgress?: (message: string) => void;
  /** Called when the program's return value exceeds maxReturnChars, with the
   *  FULL JSON (only moment it exists host-side). Return a handle string (e.g.
   *  a tool-output callId retrievable via recall_tool_result) and the result
   *  becomes {handle, preview} instead of a blind mid-structure truncation;
   *  return null to keep the legacy truncation. */
  onLargeResult?: (fullJson: string) => string | null;
  /** Node binary to run the sandbox child. Defaults to process.execPath (the
   *  daemon's own runtime). Overridable so the escape soak can validate the
   *  child under the REAL production runtime (Electron's bundled Node) rather
   *  than system Node. Production never passes it. */
  nodeBin?: string;
}

const DEFAULT_HARD_CEILING_MS = 180_000;
const DEFAULT_IDLE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RPC = 200;
/** In-flight dispatch cap: a program's Promise.all over 50 items must not
 *  stampede one MCP server / rate limit. Excess RPCs queue host-side. */
const DEFAULT_DISPATCH_CONCURRENCY = 8;
const PARTIAL_RECENT_LIMIT = 20;
const PARTIAL_PREVIEW_CHARS = 400;

function hardCeilingMs(): number {
  const raw = Number.parseInt(process.env.CLEMMY_CODEMODE_MAX_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HARD_CEILING_MS;
}
function idleTimeoutMsDefault(): number {
  const raw = Number.parseInt(process.env.CLEMMY_CODEMODE_IDLE_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_IDLE_TIMEOUT_MS;
}
function dispatchConcurrency(): number {
  const raw = Number.parseInt(process.env.CLEMMY_CODEMODE_CONCURRENCY ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DISPATCH_CONCURRENCY;
}
const DEFAULT_MAX_RETURN = 16_000;
// Consecutive-failure breaker (2026-07-08): a model-written program with a type
// bug iterated a PATH STRING char-by-char — 199 one-character list_files calls,
// every one failing, until the RPC budget finally stopped it 4 minutes later.
// Failures are the signal a program is broken: after this many tool-call
// failures IN A ROW (no intervening success), abort the program and hand the
// last error back to the model so it can fix its code in seconds. A healthy
// program that probes-and-misses resets the count on its first success.
const DEFAULT_MAX_CONSECUTIVE_RPC_FAILURES = 10;

function maxConsecutiveRpcFailures(): number {
  const raw = Number.parseInt(process.env.CLEMMY_CODEMODE_FAIL_BREAKER ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_CONSECUTIVE_RPC_FAILURES;
}

function toolResultFailureReason(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.ok === false) {
      const err = typeof record.error === 'string'
        ? record.error
        : typeof record.stderr === 'string' && record.stderr.trim()
          ? record.stderr
          : JSON.stringify(record);
      return err.slice(0, 300);
    }
    if (typeof record.exit_code === 'number' && record.exit_code !== 0) {
      const stderr = typeof record.stderr === 'string' && record.stderr.trim() ? ` stderr: ${record.stderr.trim()}` : '';
      return `exit_code ${record.exit_code}${stderr}`.slice(0, 300);
    }
    return null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (
    /^exit_code:\s*[1-9]\d*/i.test(text) ||
    /^(Directory|File) does not exist:/i.test(text) ||
    /^Not a file:/i.test(text) ||
    /^No path provided\b/i.test(text) ||
    /^Tool call (?:refused|blocked) by harness\b/i.test(text) ||
    /^An error occurred while running the tool\b/i.test(text) ||
    /^\s*(?:ERROR|Error|InvalidToolInputError)\b/i.test(text) ||
    /^MCP error\b/i.test(text) ||
    /^⚠️|^FAILED \(slug=/i.test(text) ||
    /^NOT CONNECTED\b/i.test(text)
  ) {
    return text.slice(0, 300);
  }
  return null;
}

// The blocked module set — shared by both blocker mechanisms below.
const BLOCKED_RE = `/^(node:)?(fs|fs\\/promises|child_process|net|http|https|http2|dns|dns\\/promises|tls|dgram|cluster|worker_threads|module|vm|inspector|repl|v8|wasi|perf_hooks|trace_events|diagnostics_channel|os|readline|tty)$/`;

// The off-thread loader (Node 20.6+ path): registered via module.register, runs in
// a worker thread, and THROWS for a blocked specifier so the import rejects. This
// is the production path under Electron's bundled Node 20.x (no registerHooks).
const BLOCKER_LOADER_SRC = `
const BLOCKED = ${BLOCKED_RE};
export async function resolve(specifier, context, nextResolve) {
  if (BLOCKED.test(specifier)) throw new Error('code-mode sandbox: module "' + specifier + '" is blocked');
  return nextResolve(specifier, context);
}
`;

// The --import blocker: blocks dangerous module loads (import / import() / require)
// and removes the no-import network/internal escape hatches. DUAL-MECHANISM so the
// sandbox works on BOTH Node 22 (dev: synchronous registerHooks) and Node 20.6+
// (Electron's bundled Node: off-thread module.register loader). Fails CLOSED if
// neither is available. Written into the sandbox temp dir at runtime.
const BLOCKER_SRC = `
import module from 'node:module';
const BLOCKED = ${BLOCKED_RE};
let __blocked = false;
if (typeof module.registerHooks === 'function') {
  try {
    module.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (BLOCKED.test(specifier)) throw new Error('code-mode sandbox: module "' + specifier + '" is blocked');
        return nextResolve(specifier, context);
      },
    });
    __blocked = true;
  } catch {}
}
if (!__blocked && typeof module.register === 'function') {
  try { module.register('./blocker-loader.mjs', import.meta.url); __blocked = true; } catch {}
}
if (!__blocked) {
  // Fail CLOSED: no blocker available → refuse to run rather than run unsandboxed.
  process.stderr.write('code-mode sandbox: no module blocker (registerHooks/register) — refused to run unsandboxed\\n');
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
  const timeoutMs = opts.timeoutMs ?? hardCeilingMs();
  const idleMs = opts.idleTimeoutMs ?? idleTimeoutMsDefault();
  const maxRpc = opts.maxRpcCalls ?? DEFAULT_MAX_RPC;
  const maxReturn = opts.maxReturnChars ?? DEFAULT_MAX_RETURN;
  const maxConcurrent = dispatchConcurrency();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-codemode-'));
  const blockerPath = path.join(dir, 'blocker.mjs');
  const loaderPath = path.join(dir, 'blocker-loader.mjs');
  const progPath = path.join(dir, 'program.mjs');
  writeFileSync(blockerPath, BLOCKER_SRC, 'utf8');
  writeFileSync(loaderPath, BLOCKER_LOADER_SRC, 'utf8'); // off-thread loader for the Node 20.6+ path
  writeFileSync(progPath, buildProgramSource(program), 'utf8');

  const logs: string[] = [];
  let rpcCalls = 0;
  let result: CodeModeResult | null = null;

  return await new Promise<CodeModeResult>((resolve) => {
    const child = spawn(opts.nodeBin ?? process.execPath, ['--no-warnings', '--import', blockerPath, progPath], {
      cwd: dir,
      // Minimal env — NO inherited secrets/tokens. Only what Node needs to boot.
      // ELECTRON_RUN_AS_NODE=1 makes process.execPath run as Node in the packaged
      // app (where execPath is the Electron binary — without it, it would launch a
      // GUI instead of the sandbox). No-op under plain Node. (Mirrors spaces/runner.ts.)
      env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    let consecutiveRpcFailures = 0;
    const failBreaker = maxConsecutiveRpcFailures();
    // Partial-result capture: completed/failed tallies + a bounded ring of the
    // most recent completed calls, attached to any non-ok finish so the model
    // can salvage instead of redoing every call.
    let rpcCompleted = 0;
    let rpcFailed = 0;
    const recentResults: CodeModePartial['recent'] = [];
    const recordPartial = (method: string, ok: boolean, payload: unknown): void => {
      let preview: string;
      try { preview = JSON.stringify(payload ?? null).slice(0, PARTIAL_PREVIEW_CHARS); } catch { preview = String(payload).slice(0, PARTIAL_PREVIEW_CHARS); }
      recentResults.push({ method, ok, preview });
      if (recentResults.length > PARTIAL_RECENT_LIMIT) recentResults.shift();
    };
    const partialOnFailure = (): CodeModePartial | undefined =>
      (rpcCompleted + rpcFailed) > 0 ? { completed: rpcCompleted, failed: rpcFailed, recent: [...recentResults] } : undefined;

    // A dispatch that resolves AFTER finish() killed the child would write to a
    // closed stdin — EPIPE arrives asynchronously on the stream and, unhandled,
    // becomes an uncaughtException. Swallow it: the child is gone by design.
    child.stdin.on('error', () => { /* child killed mid-write — expected */ });
    const finish = (r: CodeModeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(ceilingTimer);
      if (idleTimer) clearTimeout(idleTimer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      resolve(r);
    };

    // Two deadlines: a HARD ceiling, and an IDLE deadline that resets on any
    // observable activity (RPC traffic, progress, stderr). A program actively
    // completing calls runs up to the ceiling; a wedged one dies in ~idleMs.
    const ceilingTimer = setTimeout(() => {
      finish({ ok: false, error: `code-mode program exceeded the ${timeoutMs}ms ceiling and was killed`, rpcCalls, logs, partial: partialOnFailure() });
    }, timeoutMs);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const touchActivity = (): void => {
      if (idleMs <= 0 || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish({ ok: false, error: `code-mode program was idle for ${idleMs}ms (no tool activity) and was killed`, rpcCalls, logs, partial: partialOnFailure() });
      }, idleMs);
    };
    touchActivity();

    // Host-side dispatch semaphore — Promise.all over N items must not
    // stampede a provider; beyond maxConcurrent, dispatches queue in order.
    let inFlight = 0;
    const dispatchQueue: Array<() => void> = [];
    // After finish(), NOTHING new may start: a queued write dispatched post-kill
    // would be a real side effect the (dead) program can never observe. Pending
    // acquires simply never resolve — the promise chain is abandoned with the
    // child.
    const acquireSlot = (): Promise<void> => new Promise((grant) => {
      if (settled) return;
      if (inFlight < maxConcurrent) { inFlight += 1; grant(); return; }
      dispatchQueue.push(() => { inFlight += 1; grant(); });
    });
    const releaseSlot = (): void => {
      inFlight -= 1;
      if (settled) return;
      const next = dispatchQueue.shift();
      if (next) next();
    };

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
          touchActivity();
          // clem.progress('…') — host-handled narration, never a tool dispatch;
          // doesn't count against the RPC budget (it IS the liveness signal).
          if (msg.method === 'progress') {
            const text = typeof msg.args === 'string' ? msg.args : JSON.stringify(msg.args ?? '');
            try { opts.onProgress?.(text.slice(0, 300)); } catch { /* narration is best-effort */ }
            try { child.stdin.write(JSON.stringify({ id: msg.id, result: null }) + '\n'); } catch { /* child gone */ }
            continue;
          }
          rpcCalls += 1;
          if (rpcCalls > maxRpc) {
            try { child.stdin.write(JSON.stringify({ id: msg.id, error: `code-mode RPC budget exceeded (${maxRpc})` }) + '\n'); } catch { /* ignore */ }
            finish({ ok: false, error: `code-mode program exceeded the RPC budget (${maxRpc} tool calls)`, rpcCalls, logs, partial: partialOnFailure() });
            return;
          }
          const id = msg.id; const method = msg.method; const args = msg.args;
          void acquireSlot()
            .then(() => dispatch(method, args))
            .then((res) => {
              releaseSlot();
              touchActivity();
              const softFailure = toolResultFailureReason(res);
              if (softFailure) {
                consecutiveRpcFailures += 1;
                rpcFailed += 1;
                recordPartial(method, false, softFailure);
                if (consecutiveRpcFailures >= failBreaker) {
                  try { child.stdin.write(JSON.stringify({ id, error: softFailure }) + '\n'); } catch { /* ignore */ }
                  finish({
                    ok: false,
                    error: `code-mode program aborted: ${consecutiveRpcFailures} consecutive tool calls returned tool-error results (last: ${method} → ${softFailure.slice(0, 300)}). The program is likely iterating bad input or ignoring a tool error — fix the program and re-run.`,
                    rpcCalls, logs, partial: partialOnFailure(),
                  });
                  return;
                }
              } else {
                consecutiveRpcFailures = 0;
                rpcCompleted += 1;
                recordPartial(method, true, res);
              }
              try { child.stdin.write(JSON.stringify({ id, result: res ?? null }) + '\n'); } catch { /* child gone */ }
            })
            .catch((e: unknown) => {
              releaseSlot();
              touchActivity();
              const errMsg = e instanceof Error ? e.message : String(e);
              consecutiveRpcFailures += 1;
              rpcFailed += 1;
              recordPartial(method, false, errMsg);
              if (consecutiveRpcFailures >= failBreaker) {
                try { child.stdin.write(JSON.stringify({ id, error: errMsg }) + '\n'); } catch { /* ignore */ }
                finish({
                  ok: false,
                  error: `code-mode program aborted: ${consecutiveRpcFailures} consecutive tool calls failed (last: ${method} → ${errMsg.slice(0, 300)}). The program is likely iterating bad input (e.g. a string where an array was intended) — fix the program and re-run.`,
                  rpcCalls, logs, partial: partialOnFailure(),
                });
                return;
              }
              try { child.stdin.write(JSON.stringify({ id, error: errMsg }) + '\n'); } catch { /* child gone */ }
            });
        } else if (msg.__cm === 'return') {
          const json = JSON.stringify(msg.value ?? null);
          let value: unknown;
          if (json.length <= maxReturn) {
            value = msg.value ?? null;
          } else {
            // Oversized: prefer a durable handle (full value parked in the
            // tool-output store, retrievable via recall_tool_result) over a
            // blind mid-structure truncation.
            let handle: string | null = null;
            try { handle = opts.onLargeResult?.(json) ?? null; } catch { handle = null; }
            value = handle
              ? { resultHandle: handle, note: `full result is ${json.length} chars — call recall_tool_result with callId "${handle}" for the complete value`, preview: json.slice(0, Math.min(maxReturn, 2_000)) }
              : `${json.slice(0, maxReturn)}…[truncated ${json.length - maxReturn} chars]`;
          }
          result = { ok: true, value, rpcCalls, logs };
        } else if (msg.__cm === 'error') {
          result = { ok: false, error: String(msg.error ?? 'unknown program error'), rpcCalls, logs };
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      touchActivity(); // console output is liveness — a computing program isn't idle
      if (logs.join('').length < 8000) logs.push(d);
    });

    child.on('error', (e) => finish({ ok: false, error: `code-mode spawn failed: ${e.message}`, rpcCalls, logs }));
    child.on('exit', (code) => {
      if (result) return finish(result);
      if (code === 73) return finish({ ok: false, error: 'code-mode sandbox failed to initialize (registerHooks unavailable) — refused to run unsandboxed', rpcCalls, logs });
      finish({ ok: false, error: `code-mode program exited (${code ?? 'signal'}) without returning a value`, rpcCalls, logs, partial: partialOnFailure() });
    });
  });
}
