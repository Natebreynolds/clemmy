/**
 * Workspace data-source executor — runs a declared data source SERVER-SIDE
 * with NO LLM (the token-saving core), then persists the result into the
 * Workspace's data.json. Two source shapes:
 *
 *   - runner script: spaces/<slug>/data/<file> (.mjs/.js/.cjs/.py/.sh) — spawned
 *     with a JSON payload on stdin; must print the dataset as JSON to stdout.
 *   - Composio op: executeComposioTool(slug, args) — credentials resolve
 *     server-side via getPreferredUserId; the view never sees a token.
 *
 * Used by the on-demand /refresh route and (later) the scheduled daily poll —
 * one execution path for both. Fail-safe: a source error is captured into
 * data.json under _meta so the view can show "couldn't refresh" without the
 * whole Workspace breaking.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { resolveInSpace, spaceStore, type SpaceDataSource, type SpaceAction } from './store.js';
import { readData, writeData, appendAudit, type WriteDataResult, type WriteDataError } from './data-store.js';
import { executeComposioTool } from '../integrations/composio/client.js';
import { augmentPath } from '../runtime/spawn-env.js';

// Tunable so a heavy data pull can be given more room without a code change.
const RUNNER_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.SPACE_RUNNER_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();
// Hard cap on captured stdout so a runaway runner can't OOM the daemon.
const RUNNER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface RunSourceOk { ok: true; data: unknown }
export interface RunSourceErr { ok: false; error: string }
export type RunSourceResult = RunSourceOk | RunSourceErr;

/** Resolve a bare interpreter name to an absolute path on the augmented PATH so
 *  a minimal-PATH Finder-launched .app still finds python3/bash. */
function resolveOnPath(bin: string, augmentedPath: string): string | null {
  if (path.isAbsolute(bin)) return existsSync(bin) ? bin : null;
  for (const dir of augmentedPath.split(':').filter(Boolean)) {
    const candidate = path.join(dir, bin);
    try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

/** Locate the bundled tsx CLI entry (ships in daemon/node_modules; the .bin
 *  symlink is filtered out of the packaged app, so resolve the package). */
function resolveTsxEntry(): string | null {
  try { return createRequire(import.meta.url).resolve('tsx/cli'); } catch { return null; }
}

/** Decide how to run a runner file. `isElectron` flags the process.execPath case
 *  (node / tsx) so the caller sets ELECTRON_RUN_AS_NODE in the packaged app —
 *  without it, process.execPath (the Electron binary) launches a GUI instance
 *  instead of running the script. python3/bash resolve to absolute paths on the
 *  augmented PATH. Returns null for unsupported shapes. */
function interpreterFor(
  target: string,
  augmentedPath: string,
): { command: string; args: string[]; isElectron: boolean } | null {
  const ext = path.extname(target).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, args: [target], isElectron: true };
  }
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    const tsx = resolveTsxEntry();
    if (!tsx) return null; // surfaces "unsupported runner extension" — graceful
    return { command: process.execPath, args: [tsx, target], isElectron: true };
  }
  if (ext === '.py') {
    return { command: resolveOnPath('python3', augmentedPath) ?? 'python3', args: [target], isElectron: false };
  }
  if (ext === '.sh' || ext === '.bash') {
    return { command: resolveOnPath('bash', augmentedPath) ?? '/bin/bash', args: [target], isElectron: false };
  }
  try {
    if ((statSync(target).mode & 0o111) !== 0) return { command: target, args: [], isElectron: false };
  } catch { /* fallthrough */ }
  return null;
}

async function runScript(slug: string, runner: string, extra?: Record<string, unknown>): Promise<RunSourceResult> {
  let target: string;
  try {
    target = resolveInSpace(slug, path.join('data', runner));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (!existsSync(target)) return { ok: false, error: `runner script not found: data/${runner}` };
  const augmentedPath = augmentPath(process.env.PATH);
  const interp = interpreterFor(target, augmentedPath);
  if (!interp) return { ok: false, error: `unsupported runner extension for data/${runner} (use .mjs/.js/.cjs/.ts/.py/.sh or an executable)` };

  const spaceDir = resolveInSpace(slug, 'data');
  const payload = JSON.stringify({ slug, runner, ...(extra ?? {}) });
  return await new Promise<RunSourceResult>((resolve) => {
    // Safe, complete-enough baseline for AGENT-AUTHORED runner code. We do NOT
    // spread process.env (it carries the daemon's OAuth tokens / API keys); we
    // DO carry what any generic CLI needs — binary resolution (augmented PATH),
    // $HOME-based auth (e.g. sf → ~/.sfdx), UTF-8 I/O, XDG config dirs, and
    // Clementine identity. None of these is a secret.
    const home = process.env.HOME ?? '';
    const childEnv: Record<string, string> = {
      PATH: augmentedPath,
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      SHELL: process.env.SHELL ?? '/bin/bash',
      USER: process.env.USER ?? process.env.LOGNAME ?? '',
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      NO_COLOR: '1',
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? (home ? path.join(home, '.config') : ''),
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? (home ? path.join(home, '.cache') : ''),
      XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? (home ? path.join(home, '.local', 'share') : ''),
      CLEMENTINE_HOME: process.env.CLEMENTINE_HOME ?? '',
      CLEMENTINE_SPACE_SLUG: slug,
    };
    // Make the packaged Electron binary behave as Node. Guarded on
    // === process.execPath so it is NEVER set for python/bash/executable runners.
    if (interp.isElectron && interp.command === process.execPath) {
      childEnv.ELECTRON_RUN_AS_NODE = '1';
    }
    const child = spawn(interp.command, interp.args, {
      cwd: spaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflowed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
    }, RUNNER_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c) => {
      if (overflowed) return;
      stdout += String(c);
      if (Buffer.byteLength(stdout) > RUNNER_MAX_OUTPUT_BYTES) {
        overflowed = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
      }
    });
    child.stderr.on('data', (c) => { if (stderr.length < 100_000) stderr += String(c); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: `runner failed to launch: ${err.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (overflowed) { resolve({ ok: false, error: `runner output exceeded ${RUNNER_MAX_OUTPUT_BYTES} bytes (print a single JSON document to stdout)` }); return; }
      if (timedOut) { resolve({ ok: false, error: `runner timed out after ${RUNNER_TIMEOUT_MS}ms` }); return; }
      if (code !== 0) { resolve({ ok: false, error: `runner exited ${signal ?? code}: ${[stderr.trim(), stdout.trim()].filter(Boolean).join(' | ').slice(0, 2000)}` }); return; }
      const out = stdout.trim();
      if (!out) { resolve({ ok: false, error: 'runner produced no output (expected JSON on stdout)' }); return; }
      try {
        resolve({ ok: true, data: JSON.parse(out) });
      } catch {
        resolve({ ok: false, error: `runner stdout was not valid JSON: ${out.slice(0, 200)}` });
      }
    });
    // A fast runner (e.g. a shell echo) can exit before we finish writing the
    // payload, closing its stdin — that surfaces as an ASYNC 'error' (EPIPE) on
    // the stream, which the try/catch below can't catch and would otherwise
    // become an uncaughtException. Swallow it: stdin is optional input.
    child.stdin.on('error', () => { /* child closed stdin early — fine */ });
    try { child.stdin.end(payload); } catch { /* stdin optional */ }
  });
}

/** Run a single declared data source (no persistence). */
export async function runSpaceDataSource(slug: string, source: SpaceDataSource): Promise<RunSourceResult> {
  if (source.runner && source.runner.trim()) {
    return runScript(slug, source.runner.trim());
  }
  if (source.composioSlug && source.composioSlug.trim()) {
    try {
      const data = await executeComposioTool(source.composioSlug.trim(), source.composioArgs ?? {});
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: `composio call failed: ${(err as Error).message}` };
    }
  }
  return { ok: false, error: `data source "${source.id}" declares neither a runner nor a composio_slug` };
}

/** Execute one declared action with caller-supplied args merged over its template. */
export async function runSpaceAction(slug: string, action: SpaceAction, callerArgs: Record<string, unknown>): Promise<RunSourceResult> {
  const args = { ...(action.argsTemplate ?? {}), ...(callerArgs ?? {}) };
  if (action.composioSlug && action.composioSlug.trim()) {
    try {
      const data = await executeComposioTool(action.composioSlug.trim(), args);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: `action failed: ${(err as Error).message}` };
    }
  }
  if (action.runner && action.runner.trim()) {
    return runScript(slug, action.runner.trim(), { args });
  }
  return { ok: false, error: `action "${action.id}" declares neither a runner nor a composio_slug` };
}

export interface RefreshResult {
  ok: boolean;
  sourceId: string;
  error?: string;
  write?: WriteDataResult | WriteDataError;
}

/**
 * Refresh one data source (or the first, if sourceId omitted) and persist into
 * data.json under the source id, with a _meta entry. Returns per-source status.
 */
export async function refreshSpaceData(slug: string, sourceId?: string): Promise<RefreshResult[]> {
  const rec = spaceStore.get(slug);
  if (!rec) return [{ ok: false, sourceId: sourceId ?? '(none)', error: `no workspace "${slug}"` }];
  if (rec.status === 'paused' || rec.status === 'archived') {
    return [{ ok: false, sourceId: sourceId ?? '(none)', error: `workspace is ${rec.status}` }];
  }
  const sources = sourceId
    ? rec.dataSources.filter((s) => s.id === sourceId)
    : rec.dataSources;
  if (sources.length === 0) {
    return [{ ok: false, sourceId: sourceId ?? '(none)', error: 'no matching data source' }];
  }

  const current = (() => {
    const d = readData(slug);
    return (d && typeof d === 'object') ? { ...(d as Record<string, unknown>) } : {};
  })();
  const meta = (current._meta && typeof current._meta === 'object') ? { ...(current._meta as Record<string, unknown>) } : {};
  const results: RefreshResult[] = [];

  for (const source of sources) {
    const run = await runSpaceDataSource(slug, source);
    if (run.ok) {
      current[source.id] = run.data;
      meta[source.id] = { refreshedAt: new Date().toISOString(), ok: true };
      results.push({ ok: true, sourceId: source.id });
    } else {
      meta[source.id] = { refreshedAt: new Date().toISOString(), ok: false, error: run.error };
      results.push({ ok: false, sourceId: source.id, error: run.error });
    }
    appendAudit(slug, { method: 'REFRESH', path: `/refresh/${source.id}`, outcome: run.ok ? 'ok' : 'error', note: run.ok ? undefined : run.error });
  }

  current._meta = meta;
  const write = writeData(slug, current);
  if (write.ok) spaceStore.update(slug, { lastRefreshedAt: new Date().toISOString() });
  for (const r of results) r.write = write;
  return results;
}
