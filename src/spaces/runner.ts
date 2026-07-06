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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveInSpace, runnerFilenameError, spaceStore, type SpaceDataSource, type SpaceAction } from './store.js';
import { readData, writeData, appendAudit, type WriteDataResult, type WriteDataError } from './data-store.js';
import { executeComposioTool } from '../integrations/composio/client.js';
import { augmentPath } from '../runtime/spawn-env.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import {
  interpreterFor, scrubbedChildEnv, electronNodeEnv, spawnSandboxedScript,
} from '../runtime/sandboxed-script.js';

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

/** Run a runner script under the workspace data/ dir and return its parsed JSON
 *  (or an error) WITHOUT persisting. Uses the shared sandboxed-script substrate
 *  (scrubbed env / timeout / output-cap / EPIPE guard) — the same executor the
 *  real refresh path (runSpaceDataSource) and the dry-run tool (space_try_runner)
 *  use, so the dry-run is byte-identical to a real pull, minus the write. */
export async function runScript(slug: string, runner: string, extra?: Record<string, unknown>): Promise<RunSourceResult> {
  const runnerError = runnerFilenameError(runner);
  if (runnerError) return { ok: false, error: runnerError };
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
  const payload = JSON.stringify({ ...(extra ?? {}), slug, runner });
  const env = scrubbedChildEnv({
    CLEMENTINE_SPACE_SLUG: slug,
    ...electronNodeEnv(interp.command, interp.isElectron),
  });
  const outcome = await spawnSandboxedScript({
    command: interp.command, args: interp.args, cwd: spaceDir, env,
    stdinPayload: payload, timeoutMs: RUNNER_TIMEOUT_MS, maxOutputBytes: RUNNER_MAX_OUTPUT_BYTES,
  });
  if (outcome.launchError) return { ok: false, error: `runner failed to launch: ${outcome.launchError.message}` };
  if (outcome.overflowed) return { ok: false, error: `runner output exceeded ${RUNNER_MAX_OUTPUT_BYTES} bytes (print a single JSON document to stdout)` };
  if (outcome.timedOut) return { ok: false, error: `runner timed out after ${RUNNER_TIMEOUT_MS}ms` };
  if (outcome.code !== 0) {
    return { ok: false, error: `runner exited ${outcome.signal ?? outcome.code}: ${[outcome.stderr.trim(), outcome.stdout.trim()].filter(Boolean).join(' | ').slice(0, 2000)}` };
  }
  const out = outcome.stdout.trim();
  if (!out) return { ok: false, error: 'runner produced no output (expected JSON on stdout)' };
  try {
    return { ok: true, data: JSON.parse(out) };
  } catch {
    return { ok: false, error: `runner stdout was not valid JSON: ${out.slice(0, 200)}` };
  }
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

const refreshQueues = new Map<string, Promise<void>>();

function enqueueSpaceRefresh<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const previous = refreshQueues.get(slug) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.then(() => undefined, () => undefined);
  refreshQueues.set(slug, tail);
  tail.finally(() => {
    if (refreshQueues.get(slug) === tail) refreshQueues.delete(slug);
  }).catch(() => undefined);
  return run;
}

/** Test-only: clear pending queue metadata after a fixture run. */
export function _resetSpaceRefreshQueuesForTest(): void {
  refreshQueues.clear();
}

/**
 * Refresh one data source (or the first, if sourceId omitted) and persist into
 * data.json under the source id, with a _meta entry. Returns per-source status.
 */
export interface RefreshSpaceOptions {
  /** Paused-build auto-retry: probe the sources of a PAUSED workspace (the
   *  status gate otherwise makes a retry impossible). Archived stays blocked. */
  allowPaused?: boolean;
}

export async function refreshSpaceData(slug: string, sourceId?: string, opts: RefreshSpaceOptions = {}): Promise<RefreshResult[]> {
  return enqueueSpaceRefresh(slug, () => refreshSpaceDataLocked(slug, sourceId, opts));
}

async function refreshSpaceDataLocked(slug: string, sourceId?: string, opts: RefreshSpaceOptions = {}): Promise<RefreshResult[]> {
  const rec = spaceStore.get(slug);
  if (!rec) return [{ ok: false, sourceId: sourceId ?? '(none)', error: `no workspace "${slug}"` }];
  if (rec.manifestErrors && rec.manifestErrors.length > 0) {
    return [{
      ok: false,
      sourceId: sourceId ?? '(manifest)',
      error: `workspace manifest is invalid; fix with space_save before refreshing: ${rec.manifestErrors.join('; ')}`,
    }];
  }
  if (rec.status === 'archived' || (rec.status === 'paused' && !opts.allowPaused)) {
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

  // Phase A observability: the workspace data-refresh lifecycle on the operator view.
  recordOperationalEvent({ source: 'workspace', type: 'workspace_data_refresh_started', workspaceId: slug, actor: 'space-runner', payload: { sourceCount: sources.length, sourceId } });
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
  const okCount = results.filter((r) => r.ok).length;
  if (write.ok && okCount > 0) spaceStore.update(slug, { lastRefreshedAt: new Date().toISOString() });
  for (const r of results) r.write = write;
  const failedCount = results.length - okCount;
  recordOperationalEvent({
    source: 'workspace',
    type: failedCount > 0 ? 'workspace_data_refresh_failed' : 'workspace_data_refresh_completed',
    severity: failedCount > 0 ? 'error' : 'info',
    workspaceId: slug,
    actor: 'space-runner',
    payload: { okCount: results.length - failedCount, failedCount, total: results.length, writeOk: write.ok },
  });
  return results;
}
