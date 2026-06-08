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
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveInSpace, spaceStore, type SpaceDataSource, type SpaceAction } from './store.js';
import { readData, writeData, appendAudit, type WriteDataResult, type WriteDataError } from './data-store.js';
import { executeComposioTool } from '../integrations/composio/client.js';

const RUNNER_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunSourceOk { ok: true; data: unknown }
export interface RunSourceErr { ok: false; error: string }
export type RunSourceResult = RunSourceOk | RunSourceErr;

function interpreterFor(target: string): { command: string; args: string[] } | null {
  const ext = path.extname(target).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { command: process.execPath, args: [target] };
  if (ext === '.py') return { command: 'python3', args: [target] };
  if (ext === '.sh' || ext === '.bash') return { command: 'bash', args: [target] };
  try {
    if ((statSync(target).mode & 0o111) !== 0) return { command: target, args: [] };
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
  const interp = interpreterFor(target);
  if (!interp) return { ok: false, error: `unsupported runner extension for data/${runner} (use .mjs/.js/.cjs/.py/.sh or an executable)` };

  const spaceDir = resolveInSpace(slug, 'data');
  const payload = JSON.stringify({ slug, runner, ...(extra ?? {}) });
  return await new Promise<RunSourceResult>((resolve) => {
    const child = spawn(interp.command, interp.args, {
      cwd: spaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
        CLEMENTINE_HOME: process.env.CLEMENTINE_HOME ?? '',
        CLEMENTINE_SPACE_SLUG: slug,
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
    }, RUNNER_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: `runner failed to launch: ${err.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) { resolve({ ok: false, error: `runner timed out after ${RUNNER_TIMEOUT_MS}ms` }); return; }
      if (code !== 0) { resolve({ ok: false, error: `runner exited ${signal ?? code}: ${(stderr || stdout).slice(0, 500)}` }); return; }
      const out = stdout.trim();
      if (!out) { resolve({ ok: false, error: 'runner produced no output (expected JSON on stdout)' }); return; }
      try {
        resolve({ ok: true, data: JSON.parse(out) });
      } catch {
        resolve({ ok: false, error: `runner stdout was not valid JSON: ${out.slice(0, 200)}` });
      }
    });
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
