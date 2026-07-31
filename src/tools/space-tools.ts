/**
 * Workspaces ("Spaces") authoring tools — Clem's surface for standing up a
 * persistent, interactive surface for the user. She writes the view code with
 * the existing `write_file` tool; these tools do only the bookkeeping wiring
 * (install the view as the canonical/versioned copy, persist the manifest,
 * record the data sources + re-engage contract). Daily scheduling of a data
 * source is wired in a later phase; the manifest already records it.
 *
 * Registered in BOTH local-runtime-tools.ts (the harness's in-process tool
 * surface) and mcp-server.ts (the standalone MCP server) — mirrors
 * registerWorkflowScheduleTools.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import { textResult } from './shared.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import {
  spaceStore, resolveInSpace, isValidSpaceSlug, runnerFilenameError, mergeSpaceContract,
  type SpaceDataSource, type SpaceAction, type SpaceRecord,
} from '../spaces/store.js';
import { prepareSpaceForWrite } from '../spaces/space-enforce.js';
import { analyzeSpaceGaps, renderSpaceGapQuestions } from '../spaces/space-gap-test.js';
import { runSpaceCreationSmoke } from '../spaces/space-smoke.js';
import { refreshSpaceData } from '../spaces/runner.js';
import { readData, listNotes, listAudit, appendNote, appendAudit } from '../spaces/data-store.js';
import { buildPublishSnapshot } from '../spaces/publish.js';
import { mismatchHint } from '../shared/edit-mismatch.js';
import { deriveRunnerProvenance } from '../shared/runner-provenance.js';
import {
  bootstrapWorkspaceObservationHistory,
  commitWorkspaceObservationBatch,
  indexWorkspaceRecord,
  openWorkspaceDb,
} from '../spaces/workspace-db.js';
import {
  diffWorkspaceObservations,
  getWorkspaceHistoryAvailability,
  listWorkspaceObservationHistory,
} from '../spaces/workspace-observation-query.js';
import {
  enqueueSpaceActionApproval,
  spaceActionNeedsApproval,
  standingSpaceActionAuthority,
} from '../spaces/space-action-gate.js';
import { redactSensitiveText } from '../runtime/security.js';

// Re-exported for back-compat (space-tools.test.ts imports it from here); the
// canonical definition now lives in the shared leaf so workflow_get can reuse it.
export { deriveRunnerProvenance };

const observationBootstrapChecks = new WeakMap<object, Set<string>>();

function safeWorkspaceObservationError(value: unknown): string {
  return redactSensitiveText(value).replace(/\s+/g, ' ').trim().slice(0, 500)
    || 'workspace observation store unavailable';
}

function safeWorkspaceObservationLabel(value: string): string {
  return redactSensitiveText(value).replace(/\s+/g, ' ').trim().slice(0, 160)
    || '[redacted source]';
}

function optionalWorkspaceObservationId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return ['null', 'undefined', 'none'].includes(normalized.toLowerCase())
    ? null
    : normalized;
}

function prepareWorkspaceObservationStore(
  rec: SpaceRecord,
): { ok: true; db: ReturnType<typeof openWorkspaceDb> } | { ok: false; error: string } {
  try {
    const db = openWorkspaceDb();
    const indexed = db.prepare('SELECT 1 FROM workspaces WHERE id = ? LIMIT 1').get(rec.id);
    if (!indexed) {
      indexWorkspaceRecord(rec, {
        db,
        actor: 'workspace-history-bootstrap',
        emitOperational: false,
        appendStateEvent: false,
        payload: { legacyIndex: true },
      });
      const nowIndexed = db.prepare('SELECT 1 FROM workspaces WHERE id = ? LIMIT 1').get(rec.id);
      if (!nowIndexed) return { ok: false, error: 'workspace index could not be prepared' };
    }
    let checked = observationBootstrapChecks.get(db);
    if (!checked) {
      checked = new Set<string>();
      observationBootstrapChecks.set(db, checked);
    }
    if (!checked.has(rec.id)) {
      const bootstrap = bootstrapWorkspaceObservationHistory(rec.id, { db });
      if (!bootstrap.ok) return {
        ok: false,
        error: `legacy comparison baseline could not be imported: ${bootstrap.error}`,
      };
      checked.add(rec.id);
    }
    return { ok: true, db };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function renderWorkspaceHistoryAvailability(
  availability: ReturnType<typeof getWorkspaceHistoryAvailability>,
): string {
  if (availability.observations === 0) {
    return 'Dataset history: no retained observations yet. A successful refresh or manual data commit will create the first comparison baseline.';
  }
  const count = availability.observationsAreLowerBound
    ? `at least ${availability.observations}`
    : String(availability.observations);
  const sourceCount = availability.observationsAreLowerBound
    ? `at least ${availability.sourcesObserved}`
    : String(availability.sourcesObserved);
  const successfulCount = availability.observationsAreLowerBound
    ? `at least ${availability.successfulObservations}`
    : String(availability.successfulObservations);
  const base = `Dataset history: ${count} retained observation${availability.observations === 1 ? '' : 's'} across ${sourceCount} source${availability.sourcesObserved === 1 ? '' : 's'} (${successfulCount} successful).`;
  if (availability.comparableSources.length > 0) {
    return `${base} space_diff is confirmed for: ${availability.comparableSources.join(', ')}; use space_history for exact observation metadata.`;
  }
  if (availability.observationsAreLowerBound) {
    return `${base} This summary is bounded; call space_diff for a source to prove whether a prior successful observation exists.`;
  }
  if (availability.successfulObservations > 0) {
    return `${base} Baseline only: another successful observation is required before space_diff can report change.`;
  }
  return `${base} Failed or awaiting attempts do not create a comparable dataset; inspect them with space_history.`;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** An authored file Clem hands us must live inside the agent-owned BASE_DIR. */
function readAgentOwnedFile(
  filePath: string,
  field = 'view_path',
): { ok: true; content: string; resolved: string } | { ok: false; error: string } {
  let resolved: string;
  try {
    resolved = path.resolve(expandHome(filePath));
  } catch {
    return { ok: false, error: `could not resolve ${field}: ${filePath}` };
  }
  if (!existsSync(resolved)) {
    return { ok: false, error: `${field} does not exist: ${resolved}. Write the file with write_file first.` };
  }
  // macOS exposes /var through /private/var. Canonicalize both sides so a file
  // write reported under one spelling is not falsely rejected under the other;
  // resolving symlinks also prevents an in-home symlink from escaping BASE_DIR.
  try {
    resolved = realpathSync(resolved);
  } catch {
    return { ok: false, error: `could not resolve ${field}: ${filePath}` };
  }
  let base = path.resolve(BASE_DIR);
  try { base = realpathSync(base); } catch { /* BASE_DIR may be created shortly after startup */ }
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `${field} must be inside ${base} (where write_file saves). Got: ${resolved}` };
  }
  try {
    return { ok: true, content: readFileSync(resolved, 'utf-8'), resolved };
  } catch (err) {
    return { ok: false, error: `could not read ${field}: ${(err as Error).message}` };
  }
}

const dataSourceShape = z.object({
  id: z.string().min(1).max(60).describe('Stable id for this data source within the workspace, e.g. "daily_pull".'),
  runner: z.string().max(120).nullish().describe('Legacy compatibility only: an already-installed source may preserve its runner filename, but new runner data sources are refused. Existing runner entrypoint bytes need a time-bounded pinned-entrypoint approval before refresh; live helpers, packages, CLIs, local files, auth, and network stay outside the digest. Use composio_slug for new sources.'),
  runner_path: z.string().max(1000).nullish().describe('Legacy compatibility only: may update the file of an existing runner-backed source, which invalidates its prior entrypoint grant and requires a fresh pinned-entrypoint approval. New data-source runner installation is refused.'),
  composio_slug: z.string().max(120).nullish().describe('A PROVABLY READ-ONLY Composio tool slug (GET/LIST/SEARCH/FETCH/READ) to call server-side for data. Writes, unknown actions, and runners are refused; credentials resolve server-side, never in the view.'),
  composio_args_json: z.string().max(4000).nullish().describe('JSON string of frozen args for composio_slug.'),
  cli_argv: z.array(z.string().min(1).max(1000)).max(64).nullish().describe('OR a frozen READ-ONLY CLI invocation as an argv array (no shell), e.g. ["sf","data","query","-q","SELECT ...","-r","json"]. argv[0] must be a bare installed-command name on PATH. The user approves the exact command once; after that, scheduled and manual refreshes run it unattended. Any argv or schedule change re-asks. Stdout becomes the dataset (JSON parsed when possible, else {stdout}). Declare only commands that read — never ones that create/update/delete.'),
  allow_empty: z.boolean().nullish().describe('Set true only when zero rows is an intentional valid product state (for example a brand-new content calendar). The creation smoke will still run, but will not mislabel that expected empty state as broken.'),
  schedule: z.string().max(60).nullish().describe('Optional 5-field cron for an automatic daily/periodic refresh — LIVE: the in-process scheduler runs it server-side (and harvests _reengage from the output). Omit for on-demand only.'),
  timezone: z.string().max(60).nullish().describe('IANA timezone for the schedule (e.g. "America/Los_Angeles").'),
});

const actionShape = z.object({
  id: z.string().min(1).max(60).describe('Stable id for this action, e.g. "send_followup".'),
  label: z.string().max(80).nullish().describe('Button label shown in the view, e.g. "Send follow-up".'),
  composio_slug: z.string().max(120).nullish().describe('Composio tool to call server-side, e.g. OUTLOOK_SEND_EMAIL. Mutually exclusive with runner.'),
  runner: z.string().max(120).nullish().describe('OR the installed filename of a script under data/ that performs the side effect. Use runner_path to install a newly-authored script in this call.'),
  runner_path: z.string().max(1000).nullish().describe(`Optional source path to the action runner you authored with write_file (inside ${BASE_DIR}). space_save copies it into the Workspace data/ directory. If runner is omitted, its basename is used.`),
  args_template_json: z.string().max(4000).nullish().describe('JSON string of base args. The view supplies the variable parts (e.g. {to, subject, body}) at click time, merged over this template.'),
  confirm: z.boolean().nullish().describe('Hint that the view should confirm before firing (advisory).'),
});

interface StagedRunner {
  owner: string;
  runner: string;
  source: string;
  content: string;
}

function declaredRunner(
  rawRunner: string | null | undefined,
  rawRunnerPath: string | null | undefined,
  owner: string,
  errors: string[],
  staged: StagedRunner[],
): string | undefined {
  let runner = rawRunner?.trim() || undefined;
  const sourcePath = rawRunnerPath?.trim();
  if (sourcePath) {
    const read = readAgentOwnedFile(sourcePath, `${owner} runner_path`);
    if (!read.ok) {
      errors.push(read.error);
      return runner;
    }
    runner ??= path.basename(read.resolved);
    staged.push({ owner, runner, source: read.resolved, content: read.content });
  }
  if (runner) {
    const filenameError = runnerFilenameError(runner);
    if (filenameError) errors.push(`${owner} ${filenameError}.`);
  }
  return runner;
}

function parseJsonObjectField(raw: string | null | undefined, label: string, errors: string[]): Record<string, unknown> | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    errors.push(`${label} must be a JSON object (for example {"max":10}), not ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`);
  } catch (err) {
    errors.push(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`);
  }
  return undefined;
}

function toAction(
  raw: z.infer<typeof actionShape>,
  errors: string[] = [],
  staged: StagedRunner[] = [],
): SpaceAction {
  const a: SpaceAction = { id: raw.id.trim() };
  if (raw.label && raw.label.trim()) a.label = raw.label.trim();
  if (raw.composio_slug && raw.composio_slug.trim()) a.composioSlug = raw.composio_slug.trim();
  const runner = declaredRunner(raw.runner, raw.runner_path, `Action "${a.id}"`, errors, staged);
  if (runner) a.runner = runner;
  const argsTemplate = parseJsonObjectField(raw.args_template_json, `Action "${a.id}" args_template_json`, errors);
  if (argsTemplate) a.argsTemplate = argsTemplate;
  if (raw.confirm) a.confirm = true;
  return a;
}

function toDataSource(
  raw: z.infer<typeof dataSourceShape>,
  errors: string[] = [],
  staged: StagedRunner[] = [],
): SpaceDataSource {
  const ds: SpaceDataSource = { id: raw.id.trim() };
  const runner = declaredRunner(raw.runner, raw.runner_path, `Data source "${ds.id}"`, errors, staged);
  if (runner) ds.runner = runner;
  if (raw.composio_slug && raw.composio_slug.trim()) ds.composioSlug = raw.composio_slug.trim();
  if (raw.cli_argv && raw.cli_argv.length > 0) ds.cliArgv = raw.cli_argv.map((item) => item.trim()).filter(Boolean);
  const composioArgs = parseJsonObjectField(raw.composio_args_json, `Data source "${ds.id}" composio_args_json`, errors);
  if (composioArgs) ds.composioArgs = composioArgs;
  if (raw.schedule && raw.schedule.trim()) ds.schedule = raw.schedule.trim();
  if (raw.timezone && raw.timezone.trim()) ds.timezone = raw.timezone.trim();
  if (raw.allow_empty === true) ds.allowEmpty = true;
  return ds;
}

/** Best-effort row count for a refreshed source's data — an array's length, or
 *  the first array one level down (e.g. {contacts:[...]} → contacts.length).
 *  null when there's no obvious row collection (a scalar/object payload). */
function countRows(val: unknown): number | null {
  if (Array.isArray(val)) return val.length;
  if (val && typeof val === 'object') {
    for (const k of Object.keys(val as Record<string, unknown>)) {
      if (k === '_meta') continue;
      const v = (val as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v.length;
    }
  }
  return null;
}

/** The row collection inside a runner's parsed output (mirrors countRows): the
 *  array itself, or the first array one level down — for a dry-run summary. */
function rowCollection(val: unknown): unknown[] | null {
  if (Array.isArray(val)) return val;
  if (val && typeof val === 'object') {
    for (const k of Object.keys(val as Record<string, unknown>)) {
      if (k === '_meta') continue;
      const v = (val as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}

/** Max chars of view HTML space_get_view returns in one call. Sized just under
 *  read_file's 50000 ceiling so (a) the model has the SAME budget the shell
 *  read_file gives it — no reason to defect to shell to read a view — and (b) our
 *  own "view is large, grep" note survives textResult's clip (we pass maxChars
 *  50000 below). Above this we tell the model to grep instead of dumping the file. */
const VIEW_READ_CHAR_CAP = 48_000;
/** textResult's per-call clip for space_get_view — matches read_file's max_chars
 *  ceiling so a whole typical view reads in one call (the 12000 default would cut
 *  most views and our grep note). */
const VIEW_READ_RESULT_MAX_CHARS = 50_000;

/**
 * Render a view's HTML for space_get_view: cat -n style line numbers so the model
 * can craft a VERBATIM space_edit_view find string. With `grep`, returns only the
 * matching lines plus `around` context lines (overlapping windows merged); without
 * it, the whole view capped at VIEW_READ_CHAR_CAP. A no-match grep falls through to
 * the full view (never a dead end). The "<n>\t" prefix is NOT part of the file.
 */
function renderViewForRead(
  html: string,
  opts: { slug: string; grep?: string; around?: number; noun?: string; editTool?: string },
): string {
  const lines = html.split('\n');
  const total = lines.length;
  const width = String(total).length;
  const fmt = (i: number): string => `${String(i + 1).padStart(width)}\t${lines[i]}`;
  const around = Number.isFinite(opts.around as number) ? Math.max(0, Math.min(40, opts.around as number)) : 6;
  // noun/editTool default to view wording so the space_get_view caller is
  // byte-identical; space_get_runner passes 'runner' / 'space_edit_runner'.
  const noun = opts.noun ?? 'view';
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const editTool = opts.editTool ?? 'space_edit_view';

  if (opts.grep) {
    const needle = opts.grep.toLowerCase();
    const hits: number[] = [];
    for (let i = 0; i < total; i++) if (lines[i].toLowerCase().includes(needle)) hits.push(i);
    if (hits.length > 0) {
      // Merge overlapping/adjacent context windows into regions.
      const ranges: Array<[number, number]> = [];
      for (const h of hits) {
        const lo = Math.max(0, h - around);
        const hi = Math.min(total - 1, h + around);
        const last = ranges[ranges.length - 1];
        if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
        else ranges.push([lo, hi]);
      }
      const out: string[] = [
        `${Noun} of "${opts.slug}" — ${hits.length} line${hits.length === 1 ? '' : 's'} matching "${opts.grep}" (±${around} context), of ${total} total. The "<n>\\t" prefix is the line number, NOT part of the ${noun} — copy a VERBATIM snippet (whitespace included) into ${editTool}.`,
      ];
      let budget = VIEW_READ_CHAR_CAP;
      for (let r = 0; r < ranges.length; r++) {
        if (r > 0) out.push('  ⋮');
        const [lo, hi] = ranges[r];
        for (let i = lo; i <= hi; i++) {
          const row = fmt(i);
          budget -= row.length + 1;
          if (budget < 0) { out.push('  … (more matches — narrow your grep)'); return out.join('\n'); }
          out.push(row);
        }
      }
      return out.join('\n');
    }
  }

  // No grep, or grep matched nothing → the full source (capped).
  const out: string[] = [
    opts.grep
      ? `No ${noun} line matched "${opts.grep}". Full ${noun} of "${opts.slug}" (${total} lines) follows — the "<n>\\t" prefix is the line number, NOT part of the ${noun}; copy a VERBATIM snippet into ${editTool}.`
      : `${Noun} of "${opts.slug}" (${total} lines). The "<n>\\t" prefix is the line number, NOT part of the ${noun} — copy a VERBATIM snippet (whitespace included) into ${editTool}.`,
  ];
  let budget = VIEW_READ_CHAR_CAP;
  for (let i = 0; i < total; i++) {
    const row = fmt(i);
    budget -= row.length + 1;
    if (budget < 0) {
      out.push(`  … ${noun} is large (${total} lines) — pass grep:'<nearby text>' to target the region you want to edit.`);
      break;
    }
    out.push(row);
  }
  return out.join('\n');
}

export function registerSpaceTools(server: McpServer): void {
  server.tool(
    'space_save',
    [
      'Create or update a Workspace — a persistent, interactive HTML surface you build for the user (a live report, a CRM mini-app, a daily planner, a tracker). Idempotent: pass an existing slug to UPDATE it.',
      `FIRST write the self-contained view with write_file (inline CSS/JS only — external CDNs are blocked by CSP). It may live at ANY path inside ${BASE_DIR}; pass that path as view_path and space_save installs it.`,
      'The view calls same-origin data routes the user opens in the desktop: GET /api/console/spaces/<slug>/data, POST /api/console/spaces/<slug>/notes. It can call any /api endpoint (it inherits the session).',
      'A helper `clem` is auto-injected into every served view. For declared data, PREFER `const data = await clem.data()` and read the exact declared id as `data["<sourceId>"]`; `await clem.refresh(sourceId?)` also returns `{ results, data }`. Legacy placeholders such as `{{tasks}}` are NOT expanded and embedded seeds are static. Existing absolute `/api/console/spaces/<slug>/data` views remain supported through the same scoped RPC bridge. Also available: `await clem.compose(instructions, context)` → a grounded draft; `await clem.action(actionId, args)`; `await clem.note(text, kind?, meta?)`.',
      'APPROVAL CONTRACT: an action that SENDS or writes to an external system takes ONE user approval before it fires — for those `clem.action()` returns {pending:true, approvalId} (it surfaces in the user\'s inbox/board and runs when approved); a read-only action returns {ok:true, result} immediately. Build the view to show a "waiting for approval" state on a pending result — never tell the user it sent until it actually ran.',
      'Optionally declare NEW data_sources as PROVABLY READ-ONLY Composio operations so the workspace can refresh server-side without spending tokens. Only GET/LIST/SEARCH/FETCH/READ-class actions are accepted. Unknown or mutating slugs and new arbitrary runner scripts are refused.',
      'When the data lives behind a LOCAL CLI the user already authenticated (sf, gh, netlify, aws…), declare the source with cli_argv instead: a frozen read-only argv the user approves ONCE, after which every scheduled/manual refresh runs it unattended. Prefer the CLI\'s JSON output flag so stdout parses into a dataset.',
      'Compatibility: an already-installed runner-backed data source may retain the same source id + filename. Its first refresh requests one time-bounded human approval bound to the runner entrypoint hash + schedule; entrypoint edits invalidate that grant. Helpers, packages, CLIs, local files, auth state, and network services remain live outside the digest, so this is not a read-only sandbox. Prefer migrating it to read-only Composio. Executable ACTION runners remain per-invocation approval-gated under the same pinned-entrypoint boundary.',
      'PROACTIVE WAKE (optional): a scheduled read-only source can be paired with threshold re-engagement guidance; the scheduler dedups a persistent condition so it does not ping on every refresh.',
      'PHONE VIEW (recommended): the authored HTML view is loopback-only and never reaches the phone, so the mobile app otherwise has to GUESS what matters by sniffing the JSON — and it cannot recover a number your view computes but the data does not contain. Write a `_mobile` key into the dataset so the phone shows what you would have shown: `_mobile: { headline: [{label, value}], breakdowns: [{label, entries:[{label, value}]}], records: { label, total, items: [{primary, fields:[{label, value}]}] } }`. Values are display strings you already computed — pre-format money and dates, keep labels short enough for a 390px screen, and cap it at roughly 6 tiles and 40 records. Every part is optional and a missing or malformed block simply falls back to inference, so it can never make a workspace worse. Prioritise: the two or three numbers someone would want standing in a parking lot, then the rows they would scan.',
      'OPERATING CONTRACT: persist the Workspace\'s user-owned objective, concrete success criteria, and semantic invariants (things later edits/refreshes must never drift). This is a compact north star, not a procedure or an extra judge. Omit fields on later saves to preserve them.',
      'Changing a Composio data source auto-refreshes on save and reports the row count. Editing an installed legacy runner requests fresh pinned-entrypoint approval and leaves the Workspace active with its prior dataset until approved.',
      'Returns the workspace URL and a summary. The prior view is snapshotted for one-click revert.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('Workspace id, lowercase kebab-case (e.g. "sf-daily-report"). Reuse to update.'),
      title: z.string().min(1).max(200).describe('Human title shown in the Workspaces gallery.'),
      objective: z.string().min(4).max(1200).nullish().describe('Durable user outcome this Workspace exists to advance. Set from the agreed request; omit on later saves to preserve it.'),
      success_criteria: z.array(z.string().min(1).max(500)).max(12).nullish().describe('Optional observable definition of good/done (counts, freshness, required views/actions, quality checks). An explicit [] clears the list; omit to preserve it.'),
      invariants: z.array(z.string().min(1).max(500)).max(12).nullish().describe('Optional user/product rules that later edits must never violate, e.g. "Salesforce remains read-only" or "Never publish without approval". An explicit [] clears; omit to preserve.'),
      view_path: z.string().max(1000).nullish().describe(`Path to the HTML file you wrote with write_file (inside ${BASE_DIR}). Required when first creating; omit to update only metadata.`),
      data_sources: z.array(dataSourceShape).nullish().describe('Optional declared data sources for server-side (token-free) refresh.'),
      actions: z.array(actionShape).nullish().describe('Optional declared ACTIONS the view can trigger server-side (e.g. send an email via an Outlook Composio tool). The view POSTs {actionId, args} to /api/console/spaces/<slug>/action; credentials resolve server-side. Build the buttons/forms for these into the view.'),
      reengage_triggers: z.array(z.enum(['note', 'ask', 'threshold'])).nullish().describe('Which in-workspace events should wake you to reason: "note" (user left a note), "ask" (user asked in the workspace chat), "threshold" (data crossed a limit).'),
      reengage_guidance: z.string().max(2000).nullish().describe('What you should do when re-engaged (e.g. "draft a follow-up for any deal stalled >14 days").'),
      origin_session_id: z.string().max(200).nullish().describe('Usually omit — defaults to the current chat session so the workspace stays tied to this conversation.'),
    },
    async ({
      slug, title, objective, success_criteria, invariants, view_path, data_sources, actions,
      reengage_triggers, reengage_guidance, origin_session_id,
    }) => {
      if (!isValidSpaceSlug(slug)) {
        return textResult(`Error: "${slug}" is not a valid workspace slug. Use lowercase kebab-case, 2-63 chars (e.g. "sf-daily-report").`);
      }
      const existing = spaceStore.get(slug);
      if (!existing && (!view_path || !view_path.trim())) {
        return textResult('Error: view_path is required when creating a new workspace. Write the HTML with write_file first, then pass its path.');
      }
      if (existing?.manifestErrors && existing.manifestErrors.length > 0) {
        const needsSources = existing.manifestErrors.some((e) => /^Data source /.test(e));
        const needsActions = existing.manifestErrors.some((e) => /^Action /.test(e));
        const missing: string[] = [];
        if (needsSources && data_sources == null) missing.push('data_sources');
        if (needsActions && actions == null) missing.push('actions');
        if (missing.length > 0) {
          return textResult(
            `Workspace "${slug}" was NOT saved — its existing manifest has invalid fields. `
            + `Pass corrected ${missing.join(' and ')} to space_save so I do not silently drop the broken values:\n- ${existing.manifestErrors.join('\n- ')}`,
          );
        }
      }

      // Authoring-reliability gate (mirror of prepareWorkflowForWrite): auto-repair
      // + validate the declared data sources/actions BEFORE installing the view or
      // persisting. Refuse a Workspace set up to fail; repairs surface as advisories.
      let authoredView: ReturnType<typeof readAgentOwnedFile> | null = null;
      if (view_path && view_path.trim()) {
        authoredView = readAgentOwnedFile(view_path.trim());
        if (!authoredView.ok) return textResult(`Error: ${authoredView.error}`);
      }

      const parseErrors: string[] = [];
      const stagedRunners: StagedRunner[] = [];
      const dsList = data_sources ? data_sources.map((src) => toDataSource(src, parseErrors, stagedRunners)) : (existing?.dataSources ?? []);
      const actList = actions ? actions.map((act) => toAction(act, parseErrors, stagedRunners)) : (existing?.actions ?? []);
      const runnerSources = new Map<string, StagedRunner>();
      for (const staged of stagedRunners) {
        const prior = runnerSources.get(staged.runner);
        if (prior && (prior.source !== staged.source || prior.content !== staged.content)) {
          parseErrors.push(
            `${staged.owner} and ${prior.owner} both install "data/${staged.runner}" from different source files — use distinct runner filenames.`,
          );
        } else {
          runnerSources.set(staged.runner, staged);
        }
      }
      if (parseErrors.length > 0) {
        return textResult(`Workspace "${slug}" was NOT saved — fix these first, then call space_save again:\n- ${parseErrors.join('\n- ')}`);
      }
      const prep = prepareSpaceForWrite({
        slug,
        dataSources: dsList,
        actions: actList,
        status: existing?.status,
        availableRunnerFiles: new Set(runnerSources.keys()),
        existingDataSources: existing?.dataSources,
      });
      if (!prep.ok) {
        return textResult(`Workspace "${slug}" was NOT saved — fix these first, then call space_save again:\n- ${prep.errors.join('\n- ')}`);
      }

      // Code/runtime gaps are Clementine's responsibility, not questions for
      // the user. Refuse them BEFORE installing runners, copying the view, or
      // persisting an ACTIVE manifest. Genuine data/product clarifications
      // (for example a valid query returning zero rows) still happen after the
      // creation smoke below.
      let candidateView = authoredView?.ok ? authoredView.content : '';
      if (!candidateView && existing) {
        try { candidateView = readFileSync(resolveInSpace(slug, existing.viewEntry), 'utf-8'); } catch { /* gap test reports it */ }
      }
      const now = new Date().toISOString();
      const contract = mergeSpaceContract(existing?.contract, {
        objective,
        successCriteria: success_criteria,
        invariants,
      });
      const prospective: SpaceRecord = existing
        ? {
          ...existing, title, dataSources: prep.dataSources, actions: prep.actions,
          ...(contract ? { contract } : {}),
        }
        : {
          id: slug,
          title,
          status: 'active',
          ...(contract ? { contract } : {}),
          viewEntry: 'view/index.html',
          dataSources: prep.dataSources,
          actions: prep.actions,
          version: 1,
          revisions: [],
          createdAt: now,
          updatedAt: now,
        };
      const implementationGaps = analyzeSpaceGaps(prospective, candidateView, [])
        .filter((gap) => gap.resolution === 'fix');
      if (implementationGaps.length > 0) {
        return textResult(
          `Workspace "${slug}" was NOT saved — its view has implementation gaps.${renderSpaceGapQuestions(implementationGaps)}`,
        );
      }

      // Install newly-authored runners only after every source path and manifest
      // field has validated. The model never needs to discover or pre-create our
      // private spaces/<slug>/data convention.
      const usedRunners = new Set(
        [...prep.dataSources, ...prep.actions]
          .map((entry) => entry.runner)
          .filter((runner): runner is string => Boolean(runner)),
      );
      const runnerInstallRepairs: string[] = [];
      for (const [runner, staged] of runnerSources) {
        if (!usedRunners.has(runner)) continue; // auto-repair may prefer Composio and drop it
        const target = resolveInSpace(slug, path.join('data', runner));
        mkdirSync(path.dirname(target), { recursive: true });
        if (staged.source !== target || !existsSync(target)) {
          // A repair tool edits the installed runner in place. If a later
          // metadata save repeats the original runner_path, do not silently
          // restore that now-stale authoring copy over the newer repair.
          if (existing && staged.source !== target && existsSync(target)) {
            const installed = readFileSync(target, 'utf-8');
            const installedMtime = statSync(target).mtimeMs;
            const sourceMtime = statSync(staged.source).mtimeMs;
            if (installed !== staged.content && installedMtime > sourceMtime) {
              runnerInstallRepairs.push(
                `Preserved newer edited runner "data/${runner}" instead of reinstalling stale runner_path "${path.basename(staged.source)}".`,
              );
              continue;
            }
          }
          writeFileSync(target, staged.content, 'utf-8');
        }
      }

      // Install the view (snapshot the prior canonical first, for revert).
      if (authoredView?.ok) {
        const read = authoredView;
        const canonical = resolveInSpace(slug, existing?.viewEntry ?? 'view/index.html');
        const prior = existsSync(canonical) ? readFileSync(canonical, 'utf-8') : null;
        if (prior !== null && prior !== read.content) {
          spaceStore.recordRevision(slug); // snapshot the prior view + bump version
        }
        if (read.resolved !== canonical) {
          mkdirSync(path.dirname(canonical), { recursive: true });
          writeFileSync(canonical, read.content, 'utf-8');
        }
      }

      const ambientSession = getToolOutputContext()?.sessionId;
      const reengage = (reengage_triggers && reengage_triggers.length > 0)
        ? { triggers: reengage_triggers, guidance: reengage_guidance?.trim() || undefined }
        : undefined;

      let record = spaceStore.save({
        id: slug,
        title,
        // A fresh validated save is a candidate to be live — start 'active'
        // (unless archived), then the creation smoke decides if it stays active.
        status: existing?.status === 'archived' ? 'archived' : 'active',
        ...(contract ? { contract } : {}),
        viewEntry: 'view/index.html',
        dataSources: prep.dataSources,
        actions: prep.actions,
        reengage: reengage ?? existing?.reengage,
        originSessionId: (origin_session_id?.trim() || ambientSession || existing?.originSessionId) ?? undefined,
      });

      // Creation smoke (mirror of the workflow read-only creation test): run each
      // data source once to confirm it returns real data, and verify each
      // action's Composio toolkit is authed. A source that ERRORED parks the
      // Workspace 'paused'; a zero-row source stays active but becomes a gap
      // question. Only run when sources were declared/changed (keeps view-only
      // edits fast).
      let smoke: Awaited<ReturnType<typeof runSpaceCreationSmoke>> | null = null;
      // Also refresh when a runner FILE changed since the last pull, even if
      // data_sources wasn't re-passed — so editing the data-pull script and
      // re-saving actually re-runs it (the "I edited the filter but the data
      // didn't change" gap). View-only metadata re-saves stay fast.
      const lastRefreshMs = existing?.lastRefreshedAt ? Date.parse(existing.lastRefreshedAt) : 0;
      const runnerChanged = !!existing && record.dataSources.some((s) => {
        if (!s.runner) return false;
        try { return statSync(resolveInSpace(slug, path.join('data', s.runner))).mtimeMs > (Number.isFinite(lastRefreshMs) ? lastRefreshMs : 0); }
        catch { return false; }
      });
      const shouldSmoke = record.dataSources.length > 0 && (!existing || data_sources != null || actions != null || runnerChanged);
      if (shouldSmoke) {
        smoke = await runSpaceCreationSmoke(slug);
        if (smoke.failed.length > 0) {
          record = spaceStore.update(slug, { status: 'paused' }) ?? record;
        }
      }

      const verb = existing ? 'Updated' : 'Created';
      const dsNote = record.dataSources.length > 0
        ? ` ${record.dataSources.length} data source${record.dataSources.length === 1 ? '' : 's'} declared.`
        : '';
      const advisories = (prep.repairs.length > 0 || prep.warnings.length > 0 || runnerInstallRepairs.length > 0)
        ? `\n\nHeads up (the workspace was saved):\n- ${[...prep.repairs, ...prep.warnings, ...runnerInstallRepairs].join('\n- ')}`
        : '';
      let smokeNote = '';
      if (smoke) {
        const parts: string[] = [];
        // Per-source refresh outcome (row counts) so a data edit is never reported
        // "done" while the surface still shows stale rows.
        const failedIds = new Set(smoke.failed.map((f) => f.id));
        const awaitingApprovalIds = new Set(smoke.awaitingApproval.map((item) => item.id));
        const dataNow = (() => { try { return readData(slug) as Record<string, unknown>; } catch { return {}; } })();
        const refreshed = record.dataSources
          .filter((s) => !failedIds.has(s.id) && !awaitingApprovalIds.has(s.id))
          .map((s) => { const n = countRows(dataNow?.[s.id]); return `${s.id} (${n == null ? 'ok' : `${n} row${n === 1 ? '' : 's'}`})`; });
        if (refreshed.length > 0) parts.push(`Data refreshed: ${refreshed.join(', ')}.`);
        if (smoke.failed.length > 0) {
          parts.push(`Creation smoke PARKED this Workspace as PAUSED — fix and re-save:\n- ${smoke.failed.map((f) => `source "${f.id}": ${f.error}`).join('\n- ')}`);
        }
        if (smoke.awaitingApproval.length > 0) {
          parts.push(
            `Data refresh is waiting for your one-time approval (the Workspace stays active): ${smoke.awaitingApproval.map((item) => `${item.id} · ${item.approvalId}`).join(', ')}.`,
          );
        }
        if (smoke.actionWarnings.length > 0) parts.push(smoke.actionWarnings.map((w) => `- ${w}`).join('\n'));
        if (parts.length > 0) smokeNote = `\n\n${parts.join('\n\n')}`;
      }
      // Soft gap test (mirror of renderWorkflowGapQuestions) — clarifying
      // questions for the gaps that won't fail validation but produce a
      // wrong/empty surface (incl. zero-row sources from the smoke).
      let installedView = '';
      try { installedView = readFileSync(resolveInSpace(slug, record.viewEntry), 'utf-8'); } catch { /* no view */ }
      const gaps = analyzeSpaceGaps(record, installedView, smoke?.empty ?? []);
      // Record the gaps as a durable note so the desktop build panel can surface
      // them (not only in this tool result). Always recorded — an empty set on a
      // later clean save clears the panel (the UI reads the latest gap note).
      appendNote(slug, {
        text: gaps.length > 0 ? `Gap test flagged ${gaps.length} item${gaps.length === 1 ? '' : 's'} to confirm.` : 'Gap test: clean.',
        kind: 'gap',
        meta: { gaps: gaps.map((g) => ({ resolution: g.resolution, question: g.question, why: g.why })) },
      });
      const gapQuestions = renderSpaceGapQuestions(gaps);
      const contractListsDropped =
        !record.contract && ((success_criteria?.length ?? 0) > 0 || (invariants?.length ?? 0) > 0);
      const contractNote = record.contract
        ? ` Operating contract pinned: "${record.contract.objective}".`
        : contractListsDropped
          ? ' Operating contract NOT saved: success criteria/invariants need an objective — re-save with objective to pin them.'
          : ' Operating contract is not pinned yet; preserve the user\'s stated purpose on the next substantive save.';
      return textResult(
        `${verb} workspace "${record.title}" (${slug}) — status ${record.status}. Open it at /workspaces/${slug} in the desktop.${dsNote}`
        + `${contractNote} The view is versioned (v${record.version}) — prior versions are revertible.${advisories}${smokeNote}${gapQuestions}`,
      );
    },
  );

  server.tool(
    'space_action_prepare',
    [
      'Prepare ONE action already declared in a Workspace for the user to approve.',
      'This tool never dispatches the action. It only creates/reuses the same exact approval card used by the Workspace button; execution remains owned by the existing Workspace approval + receipt path.',
      'The approval is bound to the exact Workspace, declared action manifest, runner digest when applicable, and caller arguments. You cannot supply or override a Composio slug, runner, or wildcard authority here.',
      'Use only after Workspace evidence supports the proposed action and the user asked you to take or prepare it. Report it as waiting for approval — never as executed.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('Exact existing Workspace slug.'),
      action_id: z.string().min(1).max(120).describe('Exact id of an action already declared in that Workspace.'),
      args_json: z.string().max(20_000).nullish().describe('Optional JSON object of caller-supplied arguments for this one action. Omit for {}. The declared action template remains authoritative.'),
    },
    async ({ slug, action_id, args_json }) => {
      if (!isValidSpaceSlug(slug)) {
        return textResult(`Error: "${slug}" is not a valid workspace slug.`);
      }
      const rec = spaceStore.get(slug);
      if (!rec) {
        return textResult(`No workspace named "${slug}".`);
      }
      if (rec.status !== 'active') {
        return textResult(
          `Workspace "${slug}" is ${rec.status}; action "${action_id}" was not prepared or run.`,
        );
      }
      if (rec.manifestErrors && rec.manifestErrors.length > 0) {
        return textResult(
          `Workspace "${slug}" has an invalid manifest; action "${action_id}" was not prepared or run. `
          + `Fix it with space_save first:\n- ${rec.manifestErrors.join('\n- ')}`,
        );
      }
      const action = rec.actions.find((candidate) => candidate.id === action_id);
      if (!action) {
        return textResult(
          `Workspace "${slug}" has no declared action "${action_id}". Nothing was prepared or run.`,
        );
      }
      if (!spaceActionNeedsApproval(action)) {
        return textResult(
          `Workspace action "${action_id}" is read-only and does not use the approval-gated action path. `
          + 'Nothing was prepared or run; use the Workspace control for this read-only action.',
        );
      }

      let callerArgs: Record<string, unknown> = {};
      if (args_json != null && args_json.trim()) {
        try {
          const parsed = JSON.parse(args_json) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return textResult('Error: args_json must be one JSON object. Nothing was prepared or run.');
          }
          callerArgs = parsed as Record<string, unknown>;
        } catch (err) {
          return textResult(
            `Error: args_json is not valid JSON: ${(err as Error).message}. Nothing was prepared or run.`,
          );
        }
      }

      // Standing trust: a prior approval whose exact authority still holds
      // (same action + args, byte-identical runner) covers this invocation.
      const standing = standingSpaceActionAuthority(rec, action, callerArgs);
      if (standing?.ok) {
        const { runSpaceAction } = await import('../spaces/runner.js');
        const { randomUUID } = await import('node:crypto');
        const result = await runSpaceAction(rec.id, action, callerArgs, {
          approvalId: standing.approvalId,
          executionNonce: randomUUID(),
        });
        return textResult(result.ok
          ? `Ran "${action.label ?? action.id}" in workspace "${rec.title}" under standing approval ${standing.approvalId} `
            + '(the user already approved this exact runner version; no new approval was needed).'
          : `"${action.label ?? action.id}" was covered by standing approval ${standing.approvalId} but failed: ${result.error}`);
      }
      try {
        const prepared = enqueueSpaceActionApproval(rec, action, callerArgs);
        return textResult(
          `Prepared "${action.label ?? action.id}" in workspace "${rec.title}" for user approval `
          + `(${prepared.approvalId}). It was not run or dispatched. The approval is bound to this `
          + 'Workspace, declared action, current action manifest, and exact caller arguments. '
          + 'Report it as waiting for approval, not completed.',
        );
      } catch (err) {
        return textResult(
          `Action "${action_id}" was not prepared or run: ${redactSensitiveText(
            err instanceof Error ? err.message : String(err),
          )}`,
        );
      }
    },
  );

  server.tool(
    'space_edit_view',
    [
      'Make a TARGETED edit to an existing Workspace view — FAST, for small tweaks (a button, label, color, a bit of logic). Use this instead of rewriting the whole file with write_file + space_save: it sends only the changed snippet, so it is far cheaper and quicker.',
      'Provide one or more {find, replace} pairs; each `find` must appear VERBATIM in the current view — call space_get_view first (optionally grep for the spot) to read the exact current text. It snapshots the prior version (revertible) and bumps the version — the open Workspace auto-refreshes, so you do NOT need to call space_save after.',
      'Use write_file + space_save instead only for a large rewrite, or when changing data sources / actions.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      edits: z.array(z.object({
        find: z.string().min(1).max(8000).describe('Exact substring currently in the view to replace.'),
        replace: z.string().max(8000).describe('Replacement text (may be empty to delete).'),
      })).min(1).max(20).describe('Targeted find/replace edits, applied in order.'),
    },
    async ({ slug, edits }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}". Create it with space_save first.`);
      if (rec.manifestErrors && rec.manifestErrors.length > 0) {
        return textResult(
          `Workspace "${slug}" was NOT edited — its manifest is invalid, so I cannot create a reliable view revision. `
          + `Fix it with space_save first:\n- ${rec.manifestErrors.join('\n- ')}`,
        );
      }
      const viewFile = resolveInSpace(slug, rec.viewEntry);
      if (!existsSync(viewFile)) return textResult(`Workspace "${slug}" has no view yet — use space_save with a view_path.`);
      let html = readFileSync(viewFile, 'utf-8');
      const detailLines: string[] = [];
      let applied = 0;
      // Apply in order — a later find operates on the already-edited html (same as
      // before). Per-edit: report occurrences + a precise mismatch hint on a miss
      // so the model sees the whitespace divergence instead of re-reading blind.
      edits.forEach((e, i) => {
        const occurrences = e.find ? html.split(e.find).length - 1 : 0;
        if (occurrences === 0) {
          const hint = mismatchHint(html, e.find);
          detailLines.push(
            hint && hint.matchedChars > 0
              ? `edit ${i + 1}: NOT applied — matched the first ${hint.matchedChars} char(s), then your find had ${hint.findHad} but the view has ${hint.haystackHad}. Re-read with space_get_view and copy the exact characters (watch tabs vs spaces), then retry just this edit.`
              : `edit ${i + 1}: NOT applied — that find string isn't in the view; re-read with space_get_view and copy an exact snippet.`,
          );
          return;
        }
        html = html.split(e.find).join(e.replace);
        applied += 1;
        if (occurrences > 1) detailLines.push(`edit ${i + 1}: applied to ALL ${occurrences} occurrences.`);
      });
      const detail = detailLines.length ? `\n${detailLines.join('\n')}` : '';
      if (applied === 0) {
        return textResult(`No edits applied — none of the find strings were in the view. Call space_get_view('${slug}', '<nearby text>') to read the exact current view lines, then match a find string EXACTLY (whitespace included).${detail}`);
      }
      spaceStore.recordRevision(slug); // snapshot the prior view + bump version (revertible)
      writeFileSync(viewFile, html, 'utf-8');
      const after = spaceStore.get(slug);
      // Re-run the gap test on EVERY edit and record the fresh verdict — the
      // gap note is what the desktop banner renders, and before this it was
      // only ever re-evaluated by space_save. A model that fixed the view with
      // this tool (the recommended one!) left a STALE note as the newest — the
      // banner could never clear and models re-"fixed" working views for hours
      // (2026-07-16 james-english-pipeline incident). Advisory only; a note
      // failure never fails the edit.
      let gapNote = '';
      try {
        const gaps = analyzeSpaceGaps(after ?? rec, html, []);
        appendNote(slug, {
          text: gaps.length > 0 ? `Gap test flagged ${gaps.length} item${gaps.length === 1 ? '' : 's'} to confirm.` : 'Gap test: clean.',
          kind: 'gap',
          meta: { gaps: gaps.map((g) => ({ question: g.question, why: g.why })) },
        });
        gapNote = gaps.length > 0 ? renderSpaceGapQuestions(gaps) : '\n\nGap test: clean — the confirm banner clears on next load.';
      } catch { /* the verdict is best-effort; the edit already landed */ }
      return textResult(`Applied ${applied} edit${applied === 1 ? '' : 's'} to the "${slug}" view (now v${after?.version}). The open Workspace auto-refreshes — no need to space_save.${detail}${gapNote}`);
    },
  );

  server.tool(
    'space_list',
    'List the user\'s Workspaces (persistent interactive surfaces you built). Returns slug · title · status · #data-sources · last updated.',
    {},
    async () => {
      const spaces = spaceStore.list();
      if (spaces.length === 0) return textResult('No workspaces yet. Use space_save to create one.');
      const lines = spaces.map((s) =>
        `- ${s.id} · "${s.title}" · ${s.status} · ${s.dataSources.length} source${s.dataSources.length === 1 ? '' : 's'} · updated ${s.updatedAt}`,
      );
      return textResult(`${spaces.length} workspace${spaces.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
    },
  );

  server.tool(
    'space_refresh',
    [
      'Re-run a Workspace\'s data source(s) NOW (server-side, no LLM) and persist the fresh dataset. Use this RIGHT AFTER you edit a data runner (e.g. you changed the query/filter/fields for better data) so the open surface shows the new rows — and so you can report the new row count to the user instead of saying "done" while it still shows old data.',
      'Returns per-source ok + row count + any error. For layout/copy changes use space_edit_view; for adding/replacing a data source use space_save.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      source_id: z.string().max(120).nullable().describe('Optional: refresh just this data source id; omit to refresh all sources.'),
    },
    async ({ slug, source_id }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      if (rec.dataSources.length === 0) return textResult(`Workspace "${slug}" has no data sources to refresh.`);
      const results = await refreshSpaceData(slug, source_id?.trim() || undefined);
      const dataNow = (() => { try { return readData(slug) as Record<string, unknown>; } catch { return {}; } })();
      const lines = results.map((r) => {
        if (r.pendingApprovalId) {
          return `- ${r.sourceId}: AWAITING APPROVAL (${r.pendingApprovalId}) — runner not executed; approve it, then call space_refresh once.`;
        }
        if (!r.ok) return `- ${r.sourceId}: FAILED — ${r.error}`;
        const n = countRows(dataNow?.[r.sourceId]);
        return `- ${r.sourceId}: ok${n == null ? '' : ` (${n} row${n === 1 ? '' : 's'})`}`;
      });
      const anyOk = results.some((r) => r.ok);
      const allOk = results.every((r) => r.ok);
      const pendingCount = results.filter((r) => r.pendingApprovalId).length;
      const hardFailureCount = results.filter((r) => !r.ok && !r.pendingApprovalId).length;
      const heading = allOk
        ? 'Refreshed'
        : anyOk
          ? 'Partially refreshed'
          : pendingCount > 0 && hardFailureCount === 0
            ? 'Refresh awaiting approval for'
            : pendingCount > 0
              ? 'Refresh incomplete for'
              : 'Refresh failed for';
      return textResult(`${heading} "${slug}":\n${lines.join('\n')}`);
    },
  );

  server.tool(
    'space_get',
    'Read a Workspace: its manifest (title, status, data sources, re-engage contract), a snapshot of its current dataset, and recent user notes. Use this when re-engaged to see what the workspace shows and what the user did in it.',
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
    },
    async ({ slug }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      const observationStore = prepareWorkspaceObservationStore(rec);
      const notes = listNotes(slug, 10);
      const audit = listAudit(slug, 5);
      let dataPreview = '';
      try {
        dataPreview = JSON.stringify(readData(slug)).slice(0, 1500);
      } catch { dataPreview = '(unreadable)'; }
      const parts = [
        `Workspace "${rec.title}" (${slug}) — ${rec.status}, v${rec.version}.`,
        rec.contract
          ? [
            `Objective: ${rec.contract.objective}`,
            ...(rec.contract.successCriteria.length > 0
              ? [`Success criteria: ${rec.contract.successCriteria.map((item) => `• ${item}`).join(' ')}`]
              : []),
            ...(rec.contract.invariants.length > 0
              ? [`Invariants: ${rec.contract.invariants.map((item) => `• ${item}`).join(' ')}`]
              : []),
          ].join('\n')
          : 'Operating contract: not pinned yet.',
        rec.manifestErrors && rec.manifestErrors.length > 0
          ? `Manifest errors: fix with space_save before refresh/actions run.\n  - ${rec.manifestErrors.join('\n  - ')}`
          : '',
        rec.reengage ? `Re-engage on: ${rec.reengage.triggers.join(', ')}${rec.reengage.guidance ? ` — ${rec.reengage.guidance}` : ''}` : 'Re-engage: not configured.',
        rec.dataSources.length > 0
          ? `Data sources: ${rec.dataSources.map((d) => `${d.id}${d.runner ? ` → ${d.runner}` : ''}`).join(', ')}`
          : 'Data sources: none.',
        rec.actions.length > 0
          ? `Actions: ${rec.actions.map((a) => `${a.label ?? a.id}${a.runner ? ` → ${a.runner}` : ''}`).join(', ')}`
          : 'Actions: none.',
        (rec.dataSources.some((d) => d.runner) || rec.actions.some((a) => a.runner))
          ? 'To see HOW a runner pulls its data (which connector/query) — and to edit it — use space_get_runner / space_edit_runner.'
          : '',
        observationStore.ok
          ? renderWorkspaceHistoryAvailability(getWorkspaceHistoryAvailability(rec.id, observationStore.db))
          : `Dataset history is temporarily unavailable: ${safeWorkspaceObservationError(observationStore.error)}. Do not infer a delta from the current snapshot.`,
        `Dataset (truncated): ${dataPreview}`,
        notes.length > 0 ? `Recent notes:\n${notes.map((n) => `  - [${n.kind ?? 'note'}] ${n.text}`).join('\n')}` : 'No notes yet.',
        audit.length > 0 ? `Recent activity: ${audit.length} data-plane call(s).` : '',
      ].filter(Boolean);
      return textResult(parts.join('\n'));
    },
  );

  server.tool(
    'space_history',
    [
      'Read retained observation METADATA for a Workspace: source, status, changed/unchanged, cause, timestamp, and a scrubbed provenance summary.',
      'This is intentionally schema-on-demand and never returns raw retained datasets. Filter by source/status or lower the limit when you only need a narrow window. Use space_diff to inspect bounded value changes between two successful observations.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      source_id: z.string().max(120).nullable().describe('Optional source id filter. Omit to list observations across this Workspace.'),
      status: z.enum(['ok', 'error', 'awaiting_approval']).nullable().describe('Optional observation status filter.'),
      limit: z.number().int().min(1).max(25).nullable().describe('Maximum metadata rows to return (default 12, hard cap 25).'),
    },
    async ({ slug, source_id, status, limit }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      const sourceKey = source_id?.trim() || undefined;
      if (source_id != null && !sourceKey) return textResult('Error: source_id cannot be blank.');
      const observationStore = prepareWorkspaceObservationStore(rec);
      if (!observationStore.ok) {
        return textResult(JSON.stringify({
          status: 'history_unavailable',
          workspace: slug,
          reason: safeWorkspaceObservationError(observationStore.error),
        }));
      }
      try {
        const result = listWorkspaceObservationHistory(rec.id, {
          db: observationStore.db,
          ...(sourceKey ? { sourceKey } : {}),
          ...(status ? { status } : {}),
          limit,
        });
        return textResult(JSON.stringify(result), { maxChars: 36_000 });
      } catch (err) {
        return textResult(JSON.stringify({
          status: 'history_unavailable',
          workspace: slug,
          reason: safeWorkspaceObservationError(err),
        }));
      }
    },
  );

  server.tool(
    'space_diff',
    [
      'Compare retained successful observations for ONE Workspace data source. With no observation ids, compares the current successful observation with its prior successful observation.',
      'The result is a deterministic, bounded structural diff—not model judgment—and explicitly reports insufficient_history or unchanged. Optional ids are accepted only when they belong to this same Workspace and source; failed/awaiting observations are not comparable.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      source_id: z.string().min(1).max(120).describe('The exact data source id to compare.'),
      from_observation_id: z.string().max(200).nullable().describe('Optional older successful observation id. Omit to use the successful observation immediately before `to`.'),
      to_observation_id: z.string().max(200).nullable().describe('Optional newer successful observation id. Omit to use the current successful observation.'),
      max_changes: z.number().int().min(1).max(25).nullable().describe('Maximum bounded change entries (default 15, hard cap 25).'),
    },
    async ({ slug, source_id, from_observation_id, to_observation_id, max_changes }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      const sourceKey = source_id.trim();
      if (!sourceKey) return textResult('Error: source_id cannot be blank.');
      const modelFacingSource = safeWorkspaceObservationLabel(sourceKey);
      const observationStore = prepareWorkspaceObservationStore(rec);
      if (!observationStore.ok) {
        return textResult(JSON.stringify({
          status: 'history_unavailable',
          workspace: slug,
          source: modelFacingSource,
          reason: safeWorkspaceObservationError(observationStore.error),
        }));
      }
      try {
        const result = diffWorkspaceObservations(rec.id, sourceKey, {
          db: observationStore.db,
          fromObservationId: optionalWorkspaceObservationId(from_observation_id),
          toObservationId: optionalWorkspaceObservationId(to_observation_id),
          maxChanges: max_changes,
        });
        return textResult(JSON.stringify(result), { maxChars: 36_000 });
      } catch (err) {
        return textResult(JSON.stringify({
          status: 'history_unavailable',
          workspace: slug,
          source: modelFacingSource,
          reason: safeWorkspaceObservationError(err),
        }));
      }
    },
  );

  server.tool(
    'space_get_view',
    [
      'Read the CURRENT view HTML of a Workspace, line-numbered — this is the EXACT text you need to craft a space_edit_view find string. Use this BEFORE editing a view. (space_get returns the manifest + dataset, NOT the view HTML, so it can not give you an editable snippet.)',
      'Pass `grep` to get only the matching region(s) plus a few lines of context — far cheaper than the whole file, and the right move on a large view. Omit `grep` to read the whole view (large views are capped — above the cap it tells you to grep).',
      'The "<n>\\t" prefix on each line is the LINE NUMBER, not part of the view — strip it, then copy a VERBATIM snippet (whitespace and all) into space_edit_view({find, replace}). No need to shell out to read_file/grep — this is the sanctioned way to read a view.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      grep: z.string().max(200).nullable().describe('Optional case-insensitive substring to locate (e.g. a label or class near your edit). Returns only matching regions + context lines. Omit to read the whole view.'),
      around: z.number().int().min(0).max(40).nullable().describe('Context lines to show around each grep match (default 6).'),
    },
    async ({ slug, grep, around }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      const viewFile = resolveInSpace(slug, rec.viewEntry);
      if (!existsSync(viewFile)) return textResult(`Workspace "${slug}" has no view yet — use space_save with a view_path.`);
      let html: string;
      try { html = readFileSync(viewFile, 'utf-8'); }
      catch (err) { return textResult(`Error reading the "${slug}" view: ${(err as Error).message}`); }
      return textResult(
        renderViewForRead(html, { slug, grep: grep?.trim() || undefined, around: around ?? undefined }),
        { maxChars: VIEW_READ_RESULT_MAX_CHARS },
      );
    },
  );

  server.tool(
    'space_get_runner',
    [
      "Read the SOURCE of a Workspace data/action RUNNER (the .mjs/.py/.sh script under data/ that pulls or computes the data), line-numbered — the EXACT text to craft a space_edit_runner find string. Use this BEFORE editing a runner, and to SEE where it actually pulls data from.",
      'space_get shows the manifest + dataset (NOT runner source); space_try_runner EXECUTES a runner but does not show its code. This is the sanctioned way to READ a runner — never read_file/grep/ls it from the shell.',
      'Omit runner_path to LIST every runner the workspace declares, each with its data source / action and a one-line data-source provenance. Pass grep to target a region of a large runner.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      runner_path: z.string().max(120).nullable().describe('Runner filename under data/, e.g. "deepwhy.mjs". Omit to LIST all runners + their provenance.'),
      grep: z.string().max(200).nullable().describe('Optional case-insensitive substring to locate a region. Omit to read the whole runner.'),
      around: z.number().int().min(0).max(40).nullable().describe('Context lines around each grep match (default 6).'),
    },
    async ({ slug, runner_path, grep, around }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      const declaredBy = (runner: string): string[] => {
        const where: string[] = [];
        for (const d of rec.dataSources) if (d.runner === runner) where.push(`data source "${d.id}"${d.schedule ? ` (schedule ${d.schedule})` : ''}`);
        for (const a of rec.actions) if (a.runner === runner) where.push(`action "${a.label ?? a.id}"`);
        return where;
      };
      const allRunners = Array.from(new Set([
        ...rec.dataSources.map((d) => d.runner),
        ...rec.actions.map((a) => a.runner),
      ].filter((r): r is string => Boolean(r))));

      if (!runner_path || !runner_path.trim()) {
        if (allRunners.length === 0) return textResult(`Workspace "${slug}" declares no runners (no data source / action has a runner script).`);
        const lines = allRunners.map((r) => {
          const f = resolveInSpace(slug, path.join('data', r));
          let prov: string[] = [];
          try { prov = existsSync(f) ? deriveRunnerProvenance(readFileSync(f, 'utf-8')) : ['(file missing)']; } catch { prov = ['(unreadable)']; }
          return `- ${r} ← ${declaredBy(r).join(', ') || '(declared but unreferenced)'}\n    data: ${prov.join(' · ') || '(no external calls detected)'}`;
        });
        return textResult(`Runners in "${slug}" — read one in full with space_get_runner("${slug}", "<file>"):\n${lines.join('\n')}`);
      }

      const runner = runner_path.trim();
      const ferr = runnerFilenameError(runner);
      if (ferr) return textResult(`Error: ${ferr}`);
      const file = resolveInSpace(slug, path.join('data', runner));
      if (!existsSync(file)) {
        return textResult(`Workspace "${slug}" has no runner "data/${runner}". Declared runners: ${allRunners.map((r) => `"${r}"`).join(', ') || '(none)'}.`);
      }
      let src: string;
      try { src = readFileSync(file, 'utf-8'); }
      catch (err) { return textResult(`Error reading runner "data/${runner}": ${(err as Error).message}`); }
      const where = declaredBy(runner);
      const prov = deriveRunnerProvenance(src);
      const header = [
        `Runner data/${runner} of "${slug}"${where.length ? ` — used by ${where.join(', ')}` : ' (not referenced by any data source/action)'}.`,
        `data: ${prov.join(' · ') || '(no external calls detected)'}`,
      ].join('\n');
      return textResult(
        `${header}\n${renderViewForRead(src, { slug, grep: grep?.trim() || undefined, around: around ?? undefined, noun: 'runner', editTool: 'space_edit_runner' })}`,
        { maxChars: VIEW_READ_RESULT_MAX_CHARS },
      );
    },
  );

  server.tool(
    'space_edit_runner',
    [
      "Make a TARGETED, reversible edit to a Workspace runner's SOURCE — FAST, for changing what/how a runner pulls (a query, a field, a filter, a data source). Use this instead of rewriting the whole file.",
      'Provide runner_path + one or more {find, replace}; each `find` must appear VERBATIM in the current runner — call space_get_runner first to read the exact text. It snapshots the prior source (revert with space_revert_runner) before writing.',
      'If the runner backs an installed DATA SOURCE, editing its entrypoint invalidates the prior pinned-entrypoint grant; space_refresh will request one fresh time-bounded approval before the new bytes can run. Helpers, packages, CLIs, local files, auth, and network remain live outside that digest. New data sources must use a provably read-only Composio source. If it backs an ACTION, test it only through the normal Workspace action + approval path. Reserve write_file + space_save for a full rewrite.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      runner_path: z.string().min(1).max(120).describe('Runner filename under data/, e.g. "deepwhy.mjs".'),
      edits: z.array(z.object({
        find: z.string().min(1).max(8000).describe('Exact substring currently in the runner to replace.'),
        replace: z.string().max(8000).describe('Replacement text (may be empty to delete).'),
      })).min(1).max(20).describe('Targeted find/replace edits, applied in order.'),
    },
    async ({ slug, runner_path, edits }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      const runner = runner_path.trim();
      const ferr = runnerFilenameError(runner);
      if (ferr) return textResult(`Error: ${ferr}`);
      const file = resolveInSpace(slug, path.join('data', runner));
      if (!existsSync(file)) return textResult(`Workspace "${slug}" has no runner "data/${runner}". Read one with space_get_runner("${slug}").`);
      let src: string;
      try { src = readFileSync(file, 'utf-8'); }
      catch (err) { return textResult(`Error reading runner "data/${runner}": ${(err as Error).message}`); }

      let next = src;
      const detailLines: string[] = [];
      let applied = 0;
      edits.forEach((e, i) => {
        const occurrences = e.find ? next.split(e.find).length - 1 : 0;
        if (occurrences === 0) {
          const hint = mismatchHint(next, e.find);
          detailLines.push(
            hint && hint.matchedChars > 0
              ? `edit ${i + 1}: NOT applied — matched the first ${hint.matchedChars} char(s), then your find had ${hint.findHad} but the runner has ${hint.haystackHad}. Re-read with space_get_runner and copy the exact characters (watch tabs vs spaces), then retry just this edit.`
              : `edit ${i + 1}: NOT applied — that find string isn't in the runner; re-read with space_get_runner and copy an exact snippet.`,
          );
          return;
        }
        next = next.split(e.find).join(e.replace);
        applied += 1;
        if (occurrences > 1) detailLines.push(`edit ${i + 1}: applied to ALL ${occurrences} occurrences.`);
      });
      const detail = detailLines.length ? `\n${detailLines.join('\n')}` : '';
      if (applied === 0) {
        return textResult(`No edits applied to "data/${runner}" — none of the find strings were in the runner. Call space_get_runner('${slug}', '${runner}') to read the exact source, then match a find EXACTLY (whitespace included).${detail}`);
      }
      if (!next.trim()) return textResult(`That edit would empty the runner; a runner must keep its source. Nothing changed.${detail}`);

      // Snapshot prior source (reversible) BEFORE writing — traversal-guarded by resolveInSpace.
      let backedUp = false;
      try {
        mkdirSync(resolveInSpace(slug, path.join('data', '.runner-history')), { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        writeFileSync(resolveInSpace(slug, path.join('data', '.runner-history', `${runner}.${stamp}.bak`)), src, 'utf-8');
        backedUp = true;
      } catch { backedUp = false; }
      writeFileSync(file, next, 'utf-8');

      const backedSources = rec.dataSources.filter((d) => d.runner === runner);
      const backedActions = rec.actions.filter((a) => a.runner === runner);
      let refreshNote = '';
      if (backedSources.length > 0) {
        try {
          const results = await refreshSpaceData(slug, backedSources[0].id);
          const r = results.find((x) => x.sourceId === backedSources[0].id) ?? results[0];
          refreshNote = r?.pendingApprovalId
            ? `\nThe changed runner was NOT executed. Pinned-entrypoint approval ${r.pendingApprovalId} is waiting; after approval, call space_refresh once to pull the new data.`
            : r && r.ok
              ? `\nRe-pulled data source "${backedSources[0].id}" — the open Workspace auto-refreshes.`
              : `\n⚠️ Re-pull of "${backedSources[0].id}" FAILED: ${r?.error ?? 'unknown'} (the edit saved; fix it and call space_refresh, or space_revert_runner).`;
        } catch (err) { refreshNote = `\n⚠️ Re-pull failed: ${(err as Error).message} (edit saved).`; }
      } else if (backedActions.length > 0) {
        refreshNote = `\nThis runner backs action "${backedActions[0].label ?? backedActions[0].id}" — not auto-run. Invoke the Workspace action normally so its human approval and durable receipt stay intact.`;
      }
      const revertNote = backedUp ? ` Revert with space_revert_runner('${slug}', '${runner}').` : ' (backup unavailable — not reversible.)';
      return textResult(`Applied ${applied} edit${applied === 1 ? '' : 's'} to "data/${runner}".${revertNote}${refreshNote}${detail}`);
    },
  );

  server.tool(
    'space_revert_runner',
    'Undo the most recent space_edit_runner on a runner, restoring its prior source from the snapshot taken before the edit. Re-pulls the data if the runner backs a data source.',
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      runner_path: z.string().min(1).max(120).describe('Runner filename under data/, e.g. "deepwhy.mjs".'),
    },
    async ({ slug, runner_path }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      const runner = runner_path.trim();
      const ferr = runnerFilenameError(runner);
      if (ferr) return textResult(`Error: ${ferr}`);
      const histDir = resolveInSpace(slug, path.join('data', '.runner-history'));
      let backups: string[] = [];
      try { backups = existsSync(histDir) ? readdirSync(histDir).filter((f) => f.startsWith(`${runner}.`) && f.endsWith('.bak')).sort() : []; } catch { backups = []; }
      if (backups.length === 0) return textResult(`No reversible edit found for "data/${runner}".`);
      const latest = backups[backups.length - 1];
      const file = resolveInSpace(slug, path.join('data', runner));
      try {
        writeFileSync(file, readFileSync(path.join(histDir, latest), 'utf-8'), 'utf-8');
        try { unlinkSync(path.join(histDir, latest)); } catch { /* best effort */ }
      } catch (err) { return textResult(`Couldn't revert "data/${runner}": ${(err as Error).message}`); }
      const backedSources = rec.dataSources.filter((d) => d.runner === runner);
      let refreshNote = '';
      if (backedSources.length > 0) {
        try {
          const results = await refreshSpaceData(slug, backedSources[0].id);
          const result = results.find((entry) => entry.sourceId === backedSources[0].id) ?? results[0];
          refreshNote = result?.pendingApprovalId
              ? ` Restored entrypoint was NOT executed; pinned-entrypoint approval ${result.pendingApprovalId} is waiting.`
            : result?.ok
              ? ` Re-pulled "${backedSources[0].id}".`
              : ` Re-pull failed: ${result?.error ?? 'unknown error'}.`;
        } catch (error) {
          refreshNote = ` Re-pull failed: ${error instanceof Error ? error.message : String(error)}.`;
        }
      }
      return textResult(`Reverted "data/${runner}" to its pre-edit source.${refreshNote}`);
    },
  );

  server.tool(
    'space_try_runner',
    [
      'STATICALLY inspect a legacy Workspace runner without executing it. Arbitrary scripts can use network access and authenticated CLIs, so there is no truthful generic "dry run": even when data.json is untouched, the script could mutate an external system.',
      'This tool verifies the file and reports its declared role/provenance. An installed data runner can continue only after space_refresh creates a pinned-entrypoint, time-bounded human approval. That digest does not freeze helpers, packages, CLIs, local files, auth, or network services and does not make arbitrary code read-only; migrate it to a provably read-only Composio source to remove the compatibility grant. Test action runners only through the normal Workspace action approval path.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      runner_path: z.string().min(1).max(120).describe('Runner filename under the workspace data/ dir, e.g. "refresh.mjs".'),
      payload_json: z.string().max(4000).nullable().describe('Legacy compatibility field. It is validated but never executed because this inspection does not spawn the runner.'),
    },
    async ({ slug, runner_path, payload_json }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      const runner = runner_path.trim();
      const filenameError = runnerFilenameError(runner);
      if (filenameError) return textResult(`Error: ${filenameError}`);
      if (payload_json && payload_json.trim()) {
        let parsed: unknown;
        try { parsed = JSON.parse(payload_json); }
        catch (err) { return textResult(`Error: payload_json is not valid JSON: ${(err as Error).message}`); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return textResult('Error: payload_json must be a JSON object.');
        }
      }
      const file = resolveInSpace(slug, path.join('data', runner));
      if (!existsSync(file)) {
        return textResult(`Workspace "${slug}" has no runner "data/${runner}".`);
      }
      let source = '';
      try { source = readFileSync(file, 'utf-8'); }
      catch (err) { return textResult(`Error reading "data/${runner}": ${(err as Error).message}`); }
      const dataSources = rec.dataSources.filter((entry) => entry.runner === runner);
      const actions = rec.actions.filter((entry) => entry.runner === runner);
      const provenance = deriveRunnerProvenance(source);
      const roles = [
        ...dataSources.map((entry) => `data source "${entry.id}"`),
        ...actions.map((entry) => `action "${entry.label ?? entry.id}"`),
      ];
      const guidance = dataSources.length > 0
        ? 'This installed legacy data runner is compatibility-gated. space_refresh requests one time-bounded approval bound to its pinned entrypoint hash and schedule; entrypoint edits invalidate that grant. Helpers, packages, CLIs, local files, auth, and network remain live outside the digest. Replace it with a GET/LIST/SEARCH/FETCH/READ Composio action to remove the compatibility exception.'
        : actions.length > 0
          ? 'This is an action runner. Test it only by invoking the Workspace action; the normal human-approval path binds its arguments and pinned entrypoint bytes before execution while live dependencies remain outside the digest.'
          : 'This runner is not declared. Add a provably read-only Composio data source, or declare it as an action that will execute only after human approval.';
      return textResult(
        `Static safety inspection of data/${runner} — DID NOT execute arbitrary runner code.\n`
        + `Declared role: ${roles.join(', ') || 'none'}.\n`
        + `Observed provenance: ${provenance.join(' · ') || 'no obvious connector tokens (not proof of safety)'}.\n`
        + guidance,
      );
    },
  );

  server.tool(
    'space_set_data',
    [
      'Commit a dataset you ALREADY HAVE IN HAND directly into the workspace under a source id — the sanctioned path for a one-off fix (e.g. correcting one bad row) where you already know the right value. Use this INSTEAD of a /tmp scrub script.',
      'For the normal case, use a provably read-only Composio source and space_refresh. An installed legacy runner may still refresh under its pinned-entrypoint compatibility grant. This tool bypasses either backend and is stamped "manual", so a later scheduled refresh can overwrite it; reserve it for fixes and inline results.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      source_id: z.string().min(1).max(120).describe('The data source id to write under (the key the view reads at data["<source_id>"]).'),
      data_json: z.string().min(1).max(5_000_000).describe('The dataset as a JSON string (an array of rows, or an object). Replaces the current value for this source_id.'),
    },
    async ({ slug, source_id, data_json }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      if (rec.status !== 'active') return textResult(`Workspace "${slug}" is ${rec.status}; data writes are disabled until it is active.`);
      const sid = source_id.trim();
      if (sid === '_meta') return textResult('Error: "_meta" is a reserved key (it tracks per-source provenance). Use the data source id your view reads, e.g. data["deals"].');
      let parsed: unknown;
      try { parsed = JSON.parse(data_json); }
      catch (err) { return textResult(`Error: data_json is not valid JSON: ${(err as Error).message}`); }
      const observationStore = prepareWorkspaceObservationStore(rec);
      if (!observationStore.ok) {
        return textResult(`Could not save data for "${slug}": ${safeWorkspaceObservationError(observationStore.error)}`);
      }
      let bytes: number;
      try {
        const committed = commitWorkspaceObservationBatch({
          db: observationStore.db,
          workspaceId: rec.id,
          observations: [{
            sourceKey: sid,
            refreshId: randomUUID(),
            cause: 'manual',
            status: 'ok',
            data: parsed,
            provenance: { adapter: 'manual', initiatedBy: 'model' },
          }],
        });
        bytes = committed.projection.bytes;
        try {
          const { finalizeWorkspaceObservationCommit } = await import(
            '../spaces/workspace-observation-finalize.js'
          );
          await finalizeWorkspaceObservationCommit(rec.id, committed);
        } catch {
          // The observation + data.json projection are already durable.
          // Memory/retention finalization is deliberately best-effort.
        }
      } catch (err) {
        return textResult(`Could not save data for "${slug}": ${safeWorkspaceObservationError(err)}`);
      }
      appendAudit(slug, { method: 'SET_DATA', path: `/set_data/${sid}`, outcome: 'ok', bytes });
      const n = countRows(parsed);
      return textResult(`Saved ${n == null ? 'data' : `${n} row${n === 1 ? '' : 's'}`} under "${sid}" (${bytes} bytes, marked manual). The open Workspace auto-refreshes.`);
    },
  );

  server.tool(
    'space_publish',
    [
      'Export a Workspace as a STATIC, share-ready snapshot — the shareable counterpart to the loopback-only live view ("send my client the dashboard").',
      'The snapshot is a self-contained directory: the current dataset is INLINED (reserved _meta provenance stripped), and refresh/actions/compose/notes are replaced by a clear "published snapshot" notice — no credentials, no daemon URL, nothing live.',
      'It does NOT deploy. To put it online, deploy the returned directory with your usual site-deploy flow (e.g. a static host) — that deploy is an external write and takes the normal approval. Or just tell the user where the folder is.',
      'SHARE-CONSCIOUSLY: everything in the inlined dataset becomes readable by anyone with the link. Say so when you hand over the result, and if the data looks sensitive (emails, deal amounts, personal info), ask before deploying.',
      'Re-publish after data changes to refresh the shared copy — each export is a new timestamped folder (prior exports are kept).',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug to publish.'),
    },
    async ({ slug }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const result = buildPublishSnapshot(slug);
      if (!result.ok) return textResult(`Could not publish "${slug}": ${result.error}`);
      const rows = Object.entries(result.rowsBySource)
        .map(([k, n]) => `${k}${n == null ? '' : ` (${n} rows)`}`)
        .join(', ') || 'no data sources';
      return textResult(
        `Published a static snapshot of "${slug}" → ${result.dir}\n`
        + `${result.files.length} file${result.files.length === 1 ? '' : 's'}, ${result.bytes} bytes. Inlined data: ${rows}.\n`
        + 'This folder is self-contained and safe to host anywhere (no tokens, actions disabled). '
        + 'Deploy it with the usual flow if the user wants a link — and remind them the inlined data is visible to anyone who has it.',
      );
    },
  );
}
