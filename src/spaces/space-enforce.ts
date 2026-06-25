/**
 * Workspace authoring-reliability layer — the Space mirror of
 * workflow-enforce.ts. A single chokepoint (`prepareSpaceForWrite`) that
 * AUTO-REPAIRS the mechanically-fixable, then VALIDATES the result, so
 * space_save can never persist a Workspace set up to fail.
 *
 *  - autoRepairSpaceManifest — pure, intent-preserving fixes (coerce confirm on
 *    a send-like action; drop a redundant/invalid field) + a human-readable
 *    repairs list. Never mutates the input.
 *  - checkSpaceForWrite — unconditional validation gate. ERRORS describe a real
 *    runtime failure (a source/action with no backend; a runner file that isn't
 *    on disk; a scheduled source with an invalid cron).
 *  - prepareSpaceForWrite — autoRepair → check; callers persist the repaired
 *    lists, refuse on !ok, and surface repairs/warnings.
 *
 * Conservative by design (the owner's "don't make simple workflows hard"): a
 * thin one-source read-only Space with no actions passes clean, untouched.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { validateCronExpression } from '../shared/cron.js';
import { resolveInSpace, runnerFilenameError, type SpaceDataSource, type SpaceAction, type SpaceStatus } from './store.js';

/** A Composio action whose name/label implies an irreversible outbound send —
 *  it should always confirm before firing. */
const SEND_LIKE_RE = /\b(send|reply|email|message|publish|post|tweet|dm|invite|sms|notify)\b/i;

function looksLikeSend(action: SpaceAction): boolean {
  // Normalize underscores to spaces so \b matches inside Composio slugs like
  // OUTLOOK_OUTLOOK_SEND_EMAIL (underscores are word chars → no boundary).
  const hay = `${action.composioSlug ?? ''} ${action.runner ?? ''} ${action.label ?? ''} ${action.id}`.replace(/_/g, ' ');
  return SEND_LIKE_RE.test(hay);
}

function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function hasBackend(x: { runner?: string; composioSlug?: string }): boolean {
  return Boolean((x.runner && x.runner.trim()) || (x.composioSlug && x.composioSlug.trim()));
}

export interface SpaceAutoRepair {
  dataSources: SpaceDataSource[];
  actions: SpaceAction[];
  repairs: string[];
}

/**
 * Pure auto-repair of the data sources + actions. Returns repaired CLONES and a
 * list of what changed; never mutates the inputs.
 */
export function autoRepairSpaceManifest(
  dataSources: SpaceDataSource[],
  actions: SpaceAction[],
): SpaceAutoRepair {
  const repairs: string[] = [];

  const repairedSources = (dataSources ?? []).map((src) => {
    const s: SpaceDataSource = { ...src };
    // A source that declares BOTH a runner and a Composio slug is ambiguous.
    // Prefer the Composio op: it is the credentials-aware backend, and the
    // runner path is intentionally scrubbed of daemon secrets.
    if (s.runner && s.composioSlug) {
      repairs.push(`Data source "${s.id}" declared both a runner and a composio_slug — kept the composio op, dropped the runner.`);
      delete s.runner;
    }
    // A bad IANA timezone would silently misfire the daily refresh — drop it
    // (the scheduler falls back to host/profile tz) rather than fail the save.
    if (s.timezone && !isValidTimezone(s.timezone)) {
      repairs.push(`Dropped invalid timezone "${s.timezone}" from source "${s.id}" — it would misfire; re-add a valid IANA zone (e.g. America/Los_Angeles).`);
      delete s.timezone;
    }
    return s;
  });

  const repairedActions = (actions ?? []).map((act) => {
    const a: SpaceAction = { ...act };
    // A send-like action must confirm before firing (the costliest thing to get
    // wrong is a send to the wrong person).
    if (looksLikeSend(a) && a.confirm !== true) {
      a.confirm = true;
      repairs.push(`Set confirm:true on action "${a.id}" — it looks like an outbound send, so the view should confirm before firing.`);
    }
    // An action that declares BOTH a runner and a composio slug is ambiguous —
    // keep the Composio op (runSpaceAction prefers it) and drop the runner.
    if (a.runner && a.composioSlug) {
      repairs.push(`Action "${a.id}" declared both a runner and a composio_slug — kept the composio op, dropped the runner.`);
      delete a.runner;
    }
    return a;
  });

  return { dataSources: repairedSources, actions: repairedActions, repairs };
}

export interface SpaceWriteCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the (already auto-repaired) sources + actions. ERRORS block the save;
 * each one is a real runtime failure the Workspace would hit.
 */
export function checkSpaceForWrite(
  slug: string,
  dataSources: SpaceDataSource[],
  actions: SpaceAction[],
): SpaceWriteCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const s of dataSources ?? []) {
    if (!hasBackend(s)) {
      errors.push(`Data source "${s.id}" declares neither a runner nor a composio_slug — it can't return anything. Add a runner script (under data/) or a composio_slug.`);
      continue;
    }
    if (s.runner && s.runner.trim()) {
      const runnerError = runnerFilenameError(s.runner);
      if (runnerError) {
        errors.push(`Data source "${s.id}" ${runnerError}.`);
        continue;
      }
      let target = '';
      try { target = resolveInSpace(slug, path.join('data', s.runner.trim())); } catch { /* invalid path */ }
      if (!target || !existsSync(target)) {
        errors.push(`Data source "${s.id}" points at runner "data/${s.runner}" but that file doesn't exist — write it with write_file before saving the Workspace.`);
      }
    }
    if (s.schedule && s.schedule.trim() && !validateCronExpression(s.schedule.trim())) {
      errors.push(`Data source "${s.id}" has an invalid schedule "${s.schedule}" — use a 5-field cron (minute hour day-of-month month day-of-week), or omit it for on-demand only.`);
    }
  }

  for (const a of actions ?? []) {
    if (!hasBackend(a)) {
      errors.push(`Action "${a.id}" declares neither a composio_slug nor a runner — it can't do anything. Give it the Composio tool slug to call (discover it with composio_search_tools) or a runner script.`);
      continue;
    }
    if (a.runner && a.runner.trim()) {
      const runnerError = runnerFilenameError(a.runner);
      if (runnerError) {
        errors.push(`Action "${a.id}" ${runnerError}.`);
        continue;
      }
      let target = '';
      try { target = resolveInSpace(slug, path.join('data', a.runner.trim())); } catch { /* invalid */ }
      if (!target || !existsSync(target)) {
        errors.push(`Action "${a.id}" points at runner "data/${a.runner}" but that file doesn't exist — write it first.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export interface SpaceWritePrep extends SpaceWriteCheck {
  dataSources: SpaceDataSource[];
  actions: SpaceAction[];
  repairs: string[];
}

/**
 * The single entry every Space write should use: auto-repair, then validate the
 * repaired lists. Callers persist the returned dataSources/actions (not their
 * originals), refuse on !ok, and surface repairs + warnings as advisories.
 */
export function prepareSpaceForWrite(input: {
  slug: string;
  dataSources: SpaceDataSource[];
  actions: SpaceAction[];
  status?: SpaceStatus;
}): SpaceWritePrep {
  const { dataSources, actions, repairs } = autoRepairSpaceManifest(input.dataSources ?? [], input.actions ?? []);
  const check = checkSpaceForWrite(input.slug, dataSources, actions);
  return { dataSources, actions, ok: check.ok, errors: check.errors, warnings: check.warnings, repairs };
}
