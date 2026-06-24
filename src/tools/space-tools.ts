/**
 * Workspaces ("Spaces") authoring tools — Clem's surface for standing up a
 * persistent, interactive surface for the user. She writes the view code with
 * the existing `write_file` tool; these tools do only the bookkeeping wiring
 * (install the view as the canonical/versioned copy, persist the manifest,
 * record the data sources + re-engage contract). Daily scheduling of a data
 * source is wired in a later phase; the manifest already records it.
 *
 * Registered in BOTH local-runtime-tools.ts (the harness's in-process tool
 * surface) and mcp-server.ts (the standalone MCP server), gated by the
 * CLEMENTINE_SPACES flag — mirrors registerWorkflowScheduleTools.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import { textResult } from './shared.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import {
  spaceStore, resolveInSpace, isValidSpaceSlug, type SpaceDataSource, type SpaceAction,
} from '../spaces/store.js';
import { prepareSpaceForWrite } from '../spaces/space-enforce.js';
import { analyzeSpaceGaps, renderSpaceGapQuestions } from '../spaces/space-gap-test.js';
import { runSpaceCreationSmoke } from '../spaces/space-smoke.js';
import { refreshSpaceData, runScript } from '../spaces/runner.js';
import { readData, writeData, listNotes, listAudit, appendNote, appendAudit } from '../spaces/data-store.js';

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** A view_path Clem hands us must live inside the agent-owned BASE_DIR. */
function readAgentOwnedFile(viewPath: string): { ok: true; content: string; resolved: string } | { ok: false; error: string } {
  let resolved: string;
  try {
    resolved = path.resolve(expandHome(viewPath));
  } catch {
    return { ok: false, error: `could not resolve view_path: ${viewPath}` };
  }
  const base = path.resolve(BASE_DIR);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `view_path must be inside ${base} (where write_file saves). Got: ${resolved}` };
  }
  if (!existsSync(resolved)) {
    return { ok: false, error: `view_path does not exist: ${resolved}. Write the HTML with write_file first.` };
  }
  try {
    return { ok: true, content: readFileSync(resolved, 'utf-8'), resolved };
  } catch (err) {
    return { ok: false, error: `could not read view_path: ${(err as Error).message}` };
  }
}

const dataSourceShape = z.object({
  id: z.string().min(1).max(60).describe('Stable id for this data source within the workspace, e.g. "daily_pull".'),
  runner: z.string().max(120).nullable().describe('Filename of a deterministic script you authored (e.g. "refresh.mjs") that prints JSON to stdout. Runs server-side with NO LLM. Mutually exclusive with composio_slug.'),
  composio_slug: z.string().max(120).nullable().describe('A Composio tool slug to call server-side for data (credentials resolve server-side, never in the view). Mutually exclusive with runner.'),
  composio_args_json: z.string().max(4000).nullable().describe('JSON string of frozen args for composio_slug.'),
  schedule: z.string().max(60).nullable().describe('Optional 5-field cron for an automatic daily/periodic refresh. Omit for on-demand only. (Scheduling activates in a later build phase.)'),
  timezone: z.string().max(60).nullable().describe('IANA timezone for the schedule (e.g. "America/Los_Angeles").'),
});

const actionShape = z.object({
  id: z.string().min(1).max(60).describe('Stable id for this action, e.g. "send_followup".'),
  label: z.string().max(80).nullable().describe('Button label shown in the view, e.g. "Send follow-up".'),
  composio_slug: z.string().max(120).nullable().describe('Composio tool to call server-side, e.g. OUTLOOK_SEND_EMAIL. Mutually exclusive with runner.'),
  runner: z.string().max(120).nullable().describe('OR a script under data/ that performs the side effect.'),
  args_template_json: z.string().max(4000).nullable().describe('JSON string of base args. The view supplies the variable parts (e.g. {to, subject, body}) at click time, merged over this template.'),
  confirm: z.boolean().nullable().describe('Hint that the view should confirm before firing (advisory).'),
});

function toAction(raw: z.infer<typeof actionShape>): SpaceAction {
  const a: SpaceAction = { id: raw.id.trim() };
  if (raw.label && raw.label.trim()) a.label = raw.label.trim();
  if (raw.composio_slug && raw.composio_slug.trim()) a.composioSlug = raw.composio_slug.trim();
  if (raw.runner && raw.runner.trim()) a.runner = raw.runner.trim();
  if (raw.args_template_json && raw.args_template_json.trim()) {
    try { a.argsTemplate = JSON.parse(raw.args_template_json) as Record<string, unknown>; } catch { /* ignore bad json */ }
  }
  if (raw.confirm) a.confirm = true;
  return a;
}

function toDataSource(raw: z.infer<typeof dataSourceShape>): SpaceDataSource {
  const ds: SpaceDataSource = { id: raw.id.trim() };
  if (raw.runner && raw.runner.trim()) ds.runner = raw.runner.trim();
  if (raw.composio_slug && raw.composio_slug.trim()) ds.composioSlug = raw.composio_slug.trim();
  if (raw.composio_args_json && raw.composio_args_json.trim()) {
    try { ds.composioArgs = JSON.parse(raw.composio_args_json) as Record<string, unknown>; } catch { /* ignore bad json */ }
  }
  if (raw.schedule && raw.schedule.trim()) ds.schedule = raw.schedule.trim();
  if (raw.timezone && raw.timezone.trim()) ds.timezone = raw.timezone.trim();
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

/** On a missed space_edit_view find, pinpoint WHERE it diverged: the longest
 *  prefix of `find` that IS in the view, and what the view has at that point.
 *  Surfaces the trailing-space/indent bug the model otherwise re-reads blind for.
 *  Strings are JSON-quoted so whitespace (\t vs spaces) is visible. */
function editMismatchHint(html: string, find: string): { matchedChars: number; findHad: string; viewHad: string } | null {
  if (!find) return null;
  // Largest k with html.includes(find.slice(0,k)) — monotonic, so binary-search it.
  let lo = 0;
  let hi = find.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (html.includes(find.slice(0, mid))) lo = mid; else hi = mid - 1;
  }
  const k = lo;
  if (k >= find.length) return null; // fully present (shouldn't happen on a miss)
  const pos = html.indexOf(find.slice(0, k));
  const quote = (s: string): string => JSON.stringify(s.slice(0, 24));
  return {
    matchedChars: k,
    findHad: quote(find.slice(k)),
    viewHad: pos >= 0 ? quote(html.slice(pos + k, pos + k + 24)) : '(prefix not located)',
  };
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
function renderViewForRead(html: string, opts: { slug: string; grep?: string; around?: number }): string {
  const lines = html.split('\n');
  const total = lines.length;
  const width = String(total).length;
  const fmt = (i: number): string => `${String(i + 1).padStart(width)}\t${lines[i]}`;
  const around = Number.isFinite(opts.around as number) ? Math.max(0, Math.min(40, opts.around as number)) : 6;

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
        `View of "${opts.slug}" — ${hits.length} line${hits.length === 1 ? '' : 's'} matching "${opts.grep}" (±${around} context), of ${total} total. The "<n>\\t" prefix is the line number, NOT part of the view — copy a VERBATIM snippet (whitespace included) into space_edit_view.`,
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

  // No grep, or grep matched nothing → the full view (capped).
  const out: string[] = [
    opts.grep
      ? `No view line matched "${opts.grep}". Full view of "${opts.slug}" (${total} lines) follows — the "<n>\\t" prefix is the line number, NOT part of the view; copy a VERBATIM snippet into space_edit_view.`
      : `View of "${opts.slug}" (${total} lines). The "<n>\\t" prefix is the line number, NOT part of the view — copy a VERBATIM snippet (whitespace included) into space_edit_view.`,
  ];
  let budget = VIEW_READ_CHAR_CAP;
  for (let i = 0; i < total; i++) {
    const row = fmt(i);
    budget -= row.length + 1;
    if (budget < 0) {
      out.push(`  … view is large (${total} lines) — pass grep:'<nearby text>' to target the region you want to edit.`);
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
      'FIRST write the self-contained view with write_file (inline CSS/JS only — external CDNs are blocked by CSP). Save it under ~/.clementine-next/spaces/<slug>/view/index.html (or any path inside ~/.clementine-next), then call this with view_path pointing at it.',
      'The view calls same-origin data routes the user opens in the desktop: GET /api/console/spaces/<slug>/data, POST /api/console/spaces/<slug>/notes. It can call any /api endpoint (it inherits the session).',
      'A helper `clem` is auto-injected into every served view — PREFER it over hand-writing fetch (fewer wrong-slug/wrong-key bugs): `await clem.data()` → the dataset (keyed by sourceId); `await clem.refresh(sourceId?)`; `await clem.compose(instructions, context)` → a grounded draft (e.g. a personalized email from a row); `await clem.action(actionId, args)`; `await clem.note(text, kind?, meta?)`.',
      'APPROVAL CONTRACT: an action that SENDS or writes to an external system takes ONE user approval before it fires — for those `clem.action()` returns {pending:true, approvalId} (it surfaces in the user\'s inbox/board and runs when approved); a read-only action returns {ok:true, result} immediately. Build the view to show a "waiting for approval" state on a pending result — never tell the user it sent until it actually ran.',
      'Optionally declare data_sources (a deterministic script that prints JSON, or a Composio op) so the workspace can refresh its data server-side without spending tokens.',
      'RUNNER CONTRACT (when a data source is a script — .mjs/.js/.ts/.py/.sh): it runs SERVER-SIDE with NO LLM and a SCRUBBED env (PATH/HOME/locale only — NO API keys or daemon secrets). It receives a JSON payload on stdin and MUST print the dataset as JSON to stdout and NOTHING else (a stray console.log/print corrupts the parse). Exit non-zero on failure. Use only language built-ins + (node) global fetch — there is NO node_modules, so no npm imports. It MAY shell out to CLIs on PATH (e.g. `sf`, `gh`), which read their own auth from $HOME. For anything that needs a secret/OAuth, declare a Composio op (composio_slug) instead of a runner. The view reads each source at data["<sourceId>"] from GET /api/console/spaces/<slug>/data.',
      'PROACTIVE WAKE (optional): a SCHEDULED runner can ping the user when something crosses a threshold — include `_reengage: { fire: true, message: "<what changed>", key: "<stable-condition-id>" }` in its JSON output. The scheduler fires a re-engage when `fire` is true and dedups by `key` (a persistent condition pings ONCE, not every refresh; it can re-fire after the condition clears). Requires reengage_triggers to include "threshold"; omit `_reengage` (or set fire:false) when nothing is notable.',
      'Changing a data source (or editing its runner file) auto-refreshes on save and reports the row count, so you can confirm the new data before telling the user it is done.',
      'Returns the workspace URL and a summary. The prior view is snapshotted for one-click revert.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('Workspace id, lowercase kebab-case (e.g. "sf-daily-report"). Reuse to update.'),
      title: z.string().min(1).max(200).describe('Human title shown in the Workspaces gallery.'),
      view_path: z.string().max(1000).nullable().describe('Path to the HTML file you wrote with write_file (inside ~/.clementine-next). Required when first creating; omit to update only metadata.'),
      data_sources: z.array(dataSourceShape).nullable().describe('Optional declared data sources for server-side (token-free) refresh.'),
      actions: z.array(actionShape).nullable().describe('Optional declared ACTIONS the view can trigger server-side (e.g. send an email via an Outlook Composio tool). The view POSTs {actionId, args} to /api/console/spaces/<slug>/action; credentials resolve server-side. Build the buttons/forms for these into the view.'),
      reengage_triggers: z.array(z.enum(['note', 'ask', 'threshold'])).nullable().describe('Which in-workspace events should wake you to reason: "note" (user left a note), "ask" (user asked in the workspace chat), "threshold" (data crossed a limit).'),
      reengage_guidance: z.string().max(2000).nullable().describe('What you should do when re-engaged (e.g. "draft a follow-up for any deal stalled >14 days").'),
      origin_session_id: z.string().max(200).nullable().describe('Usually omit — defaults to the current chat session so the workspace stays tied to this conversation.'),
    },
    async ({ slug, title, view_path, data_sources, actions, reengage_triggers, reengage_guidance, origin_session_id }) => {
      if (!isValidSpaceSlug(slug)) {
        return textResult(`Error: "${slug}" is not a valid workspace slug. Use lowercase kebab-case, 2-63 chars (e.g. "sf-daily-report").`);
      }
      const existing = spaceStore.get(slug);
      if (!existing && (!view_path || !view_path.trim())) {
        return textResult('Error: view_path is required when creating a new workspace. Write the HTML with write_file first, then pass its path.');
      }

      // Authoring-reliability gate (mirror of prepareWorkflowForWrite): auto-repair
      // + validate the declared data sources/actions BEFORE installing the view or
      // persisting. Refuse a Workspace set up to fail; repairs surface as advisories.
      const dsList = data_sources ? data_sources.map(toDataSource) : (existing?.dataSources ?? []);
      const actList = actions ? actions.map(toAction) : (existing?.actions ?? []);
      const prep = prepareSpaceForWrite({ slug, dataSources: dsList, actions: actList, status: existing?.status });
      if (!prep.ok) {
        return textResult(`Workspace "${slug}" was NOT saved — fix these first, then call space_save again:\n- ${prep.errors.join('\n- ')}`);
      }

      // Install the view (snapshot the prior canonical first, for revert).
      if (view_path && view_path.trim()) {
        const read = readAgentOwnedFile(view_path.trim());
        if (!read.ok) return textResult(`Error: ${read.error}`);
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
      const advisories = (prep.repairs.length > 0 || prep.warnings.length > 0)
        ? `\n\nHeads up (the workspace was saved):\n- ${[...prep.repairs, ...prep.warnings].join('\n- ')}`
        : '';
      let smokeNote = '';
      if (smoke) {
        const parts: string[] = [];
        // Per-source refresh outcome (row counts) so a data edit is never reported
        // "done" while the surface still shows stale rows.
        const failedIds = new Set(smoke.failed.map((f) => f.id));
        const dataNow = (() => { try { return readData(slug) as Record<string, unknown>; } catch { return {}; } })();
        const refreshed = record.dataSources
          .filter((s) => !failedIds.has(s.id))
          .map((s) => { const n = countRows(dataNow?.[s.id]); return `${s.id} (${n == null ? 'ok' : `${n} row${n === 1 ? '' : 's'}`})`; });
        if (refreshed.length > 0) parts.push(`Data refreshed: ${refreshed.join(', ')}.`);
        if (smoke.failed.length > 0) {
          parts.push(`Creation smoke PARKED this Workspace as PAUSED — fix and re-save:\n- ${smoke.failed.map((f) => `source "${f.id}": ${f.error}`).join('\n- ')}`);
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
        meta: { gaps: gaps.map((g) => ({ question: g.question, why: g.why })) },
      });
      const gapQuestions = renderSpaceGapQuestions(gaps);
      return textResult(
        `${verb} workspace "${record.title}" (${slug}) — status ${record.status}. Open it at /workspaces/${slug} in the desktop.${dsNote}`
        + ` The view is versioned (v${record.version}) — prior versions are revertible.${advisories}${smokeNote}${gapQuestions}`,
      );
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
          const hint = editMismatchHint(html, e.find);
          detailLines.push(
            hint && hint.matchedChars > 0
              ? `edit ${i + 1}: NOT applied — matched the first ${hint.matchedChars} char(s), then your find had ${hint.findHad} but the view has ${hint.viewHad}. Re-read with space_get_view and copy the exact characters (watch tabs vs spaces), then retry just this edit.`
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
      return textResult(`Applied ${applied} edit${applied === 1 ? '' : 's'} to the "${slug}" view (now v${after?.version}). The open Workspace auto-refreshes — no need to space_save.${detail}`);
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
        if (!r.ok) return `- ${r.sourceId}: FAILED — ${r.error}`;
        const n = countRows(dataNow?.[r.sourceId]);
        return `- ${r.sourceId}: ok${n == null ? '' : ` (${n} row${n === 1 ? '' : 's'})`}`;
      });
      const anyOk = results.some((r) => r.ok);
      const allOk = results.every((r) => r.ok);
      return textResult(`${allOk ? 'Refreshed' : anyOk ? 'Partially refreshed' : 'Refresh failed for'} "${slug}":\n${lines.join('\n')}`);
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
      const notes = listNotes(slug, 10);
      const audit = listAudit(slug, 5);
      let dataPreview = '';
      try {
        dataPreview = JSON.stringify(readData(slug)).slice(0, 1500);
      } catch { dataPreview = '(unreadable)'; }
      const parts = [
        `Workspace "${rec.title}" (${slug}) — ${rec.status}, v${rec.version}.`,
        rec.reengage ? `Re-engage on: ${rec.reengage.triggers.join(', ')}${rec.reengage.guidance ? ` — ${rec.reengage.guidance}` : ''}` : 'Re-engage: not configured.',
        rec.dataSources.length > 0 ? `Data sources: ${rec.dataSources.map((d) => d.id).join(', ')}` : 'Data sources: none.',
        rec.actions.length > 0 ? `Actions: ${rec.actions.map((a) => a.label ?? a.id).join(', ')}` : 'Actions: none.',
        `Dataset (truncated): ${dataPreview}`,
        notes.length > 0 ? `Recent notes:\n${notes.map((n) => `  - [${n.kind ?? 'note'}] ${n.text}`).join('\n')}` : 'No notes yet.',
        audit.length > 0 ? `Recent activity: ${audit.length} data-plane call(s).` : '',
      ].filter(Boolean);
      return textResult(parts.join('\n'));
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
    'space_try_runner',
    [
      'DRY-RUN a data runner you wrote (a .mjs/.js/.ts/.py/.sh under the workspace data/ dir) and SEE its output — WITHOUT persisting. This is the native, sanctioned replacement for running `node data/x.mjs` in the shell or scribbling a /tmp script: it runs the runner through the SAME scrubbed-env executor a real refresh uses, then returns the row count, the column keys, and the first few rows (or the full error). Iterate here until the shape is right.',
      'When the output looks correct, call space_refresh(slug, source_id) to actually pull + persist it (or space_set_data for a known inline fix). This tool writes NOTHING to data.json.',
    ].join('\n'),
    {
      slug: z.string().min(2).max(63).describe('The workspace slug.'),
      runner_path: z.string().min(1).max(120).describe('Runner filename under the workspace data/ dir, e.g. "refresh.mjs".'),
      payload_json: z.string().max(4000).nullable().describe('Optional JSON object merged into the stdin payload (test inputs). Omit to run as a scheduled refresh would.'),
    },
    async ({ slug, runner_path, payload_json }) => {
      if (!isValidSpaceSlug(slug)) return textResult(`Error: invalid workspace slug "${slug}".`);
      const rec = spaceStore.get(slug);
      if (!rec) return textResult(`No workspace named "${slug}".`);
      const runner = runner_path.trim();
      let extra: Record<string, unknown> | undefined;
      if (payload_json && payload_json.trim()) {
        let parsed: unknown;
        try { parsed = JSON.parse(payload_json); }
        catch (err) { return textResult(`Error: payload_json is not valid JSON: ${(err as Error).message}`); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return textResult('Error: payload_json must be a JSON object (it is merged into the stdin payload).');
        }
        extra = parsed as Record<string, unknown>;
      }
      const run = await runScript(slug, runner, extra);
      if (!run.ok) {
        return textResult(`Dry run of data/${runner} FAILED (nothing persisted):\n${run.error}\n\nFix the runner and call space_try_runner again.`);
      }
      const rows = rowCollection(run.data);
      const bytes = (() => { try { return Buffer.byteLength(JSON.stringify(run.data)); } catch { return 0; } })();
      const firstRow = rows && rows.length > 0 ? rows[0] : undefined;
      const keys = firstRow && typeof firstRow === 'object' && !Array.isArray(firstRow)
        ? Object.keys(firstRow as Record<string, unknown>) : [];
      const sample = rows ? rows.slice(0, 3) : run.data;
      const sampleStr = (() => { try { return JSON.stringify(sample, null, 2).slice(0, 3000); } catch { return '(unserializable)'; } })();
      const shape = rows
        ? `${rows.length} row${rows.length === 1 ? '' : 's'}${keys.length ? ` · keys: ${keys.join(', ')}` : ''}`
        : 'a non-array payload (no rows)';
      return textResult(
        `Dry run of data/${runner} OK — ${shape} (${bytes} bytes). NOTHING persisted.\n`
        + `Sample (first ${rows ? Math.min(3, rows.length) : 1}):\n${sampleStr}\n\n`
        + `If this is right, call space_refresh('${slug}', '<source_id>') to pull + persist it.`,
      );
    },
  );

  server.tool(
    'space_set_data',
    [
      'Commit a dataset you ALREADY HAVE IN HAND directly into the workspace under a source id — the sanctioned path for a one-off fix (e.g. correcting one bad row) where you already know the right value. Use this INSTEAD of a /tmp scrub script.',
      'For the normal case — pulling fresh data — write/edit a runner and use space_refresh. This tool bypasses the runner and is stamped "manual", so a scheduled refresh would later overwrite it; reserve it for fixes and inline results.',
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
      const sid = source_id.trim();
      let parsed: unknown;
      try { parsed = JSON.parse(data_json); }
      catch (err) { return textResult(`Error: data_json is not valid JSON: ${(err as Error).message}`); }
      const current = (() => {
        const d = readData(slug);
        return (d && typeof d === 'object') ? { ...(d as Record<string, unknown>) } : {};
      })();
      current[sid] = parsed;
      const meta = (current._meta && typeof current._meta === 'object') ? { ...(current._meta as Record<string, unknown>) } : {};
      meta[sid] = { refreshedAt: new Date().toISOString(), ok: true, provenance: 'manual' };
      current._meta = meta;
      const write = writeData(slug, current);
      if (!write.ok) return textResult(`Could not save data for "${slug}": ${write.error}`);
      appendAudit(slug, { method: 'SET_DATA', path: `/set_data/${sid}`, outcome: 'ok', bytes: write.bytes });
      const n = countRows(parsed);
      return textResult(`Saved ${n == null ? 'data' : `${n} row${n === 1 ? '' : 's'}`} under "${sid}" (${write.bytes} bytes, marked manual). The open Workspace auto-refreshes.`);
    },
  );
}
