/**
 * Deliverable-grounded completion — DETERMINISTIC readback of the artifacts a
 * goal-bound background run actually produced, BEFORE the run is allowed to report
 * "done".
 *
 * The failure this fixes (2026-07-08, standing feedback #1384 "chronically marks
 * tasks complete before producing required deliverables"): a background run claimed
 * "created and populated 5 Google Sheets" when all five were BLANK (title-only). The
 * completion judge only ever saw the model's CLAIMS, never the artifacts. So we
 * extract the artifact references the session actually emitted (created sheet ids,
 * local file paths, space view paths) and probe each one deterministically. A probe
 * failure blocks completion with the SPECIFIC gap ("sheet 1tMA… exists but has 0
 * data rows"), which feeds the existing not-done/blocked machinery.
 *
 * Best-effort PER CLASS: an artifact type we cannot probe (or a probe that errors)
 * passes through to the existing judge path — we NEVER block on a probe we can't run.
 * Everything is injectable so tests are deterministic with no fs/network dependence.
 */
import { existsSync, statSync } from 'node:fs';
import { listEvents, getToolOutput, type EventRow } from '../runtime/harness/eventlog.js';
import { getRuntimeEnv } from '../config.js';

export type DeliverableKind = 'google_sheet' | 'local_file' | 'space_view';

export interface Deliverable {
  kind: DeliverableKind;
  /** Spreadsheet id, absolute file path, or space view path. */
  ref: string;
  /** The tool call that produced it (telemetry). */
  callId?: string;
  tool?: string;
}

export interface DeliverableVerdict {
  deliverable: Deliverable;
  pass: boolean;
  /** 'probe' = a real readback ran; 'skipped' = unprobeable → passes through. */
  method: 'probe' | 'skipped';
  detail: string;
}

export interface DeliverableProbeResult {
  probed: DeliverableVerdict[];
  /** Only the CONFIRMED-failed deliverables (a skipped/unprobeable one is not here). */
  failures: Array<{ ref: string; gap: string }>;
  /** One-line block reason naming the specific gaps (empty when nothing failed). */
  summary: string;
  /** Hard-evidence lines to fold into the completion judge's evidence, so even the
   *  judge lane can't pass a probe-failed run. Empty when nothing was probed. */
  evidenceText: string;
}

export interface DeliverableProbeDeps {
  listEventsFn?: (sessionId: string, opts: { types: string[] }) => EventRow[];
  getToolOutputFn?: (sessionId: string, callId: string) => { output?: string } | null;
  fileStat?: (p: string) => { exists: boolean; size: number };
  /** Read a spreadsheet's populated row count. Return -1 for "unprobeable" (network
   *  error, bad slug, no connection) → the deliverable is SKIPPED, never failed. */
  readSheetRowCount?: (spreadsheetId: string, sessionId: string) => Promise<number>;
}

/** Kill-switch: CLEMMY_DELIVERABLE_PROBES=off restores pre-probe behavior. */
export function deliverableProbesEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_DELIVERABLE_PROBES', 'on') || 'on').trim().toLowerCase() !== 'off';
}

// ─── Extraction (from the run session's tool_returned events) ─────────────────

const SHEET_ID_RE = /"spreadsheet_?[iI]d"\s*:\s*"([A-Za-z0-9_-]{20,})"/;
const SHEET_URL_RE = /spreadsheets\/d\/([A-Za-z0-9_-]{20,})/;
const WROTE_FILE_RE = /\b(?:Wrote|Overwrote|Appended)\s+(\/[^\s(]+)/; // computer-tools write_file result

function defaultFileStat(p: string): { exists: boolean; size: number } {
  try {
    if (!existsSync(p)) return { exists: false, size: 0 };
    return { exists: true, size: statSync(p).size };
  } catch {
    return { exists: false, size: 0 };
  }
}

/** Pull the FULL result text for a tool_returned event: the tool-output store holds
 *  the un-clipped payload; the event's own `preview` (≤400 chars) is the fallback. */
function resultTextFor(sessionId: string, ev: EventRow, deps: DeliverableProbeDeps): string {
  const data = (ev.data ?? {}) as { callId?: string; preview?: string };
  const getOut = deps.getToolOutputFn ?? getToolOutput;
  if (data.callId) {
    try {
      const rec = getOut(sessionId, data.callId);
      if (rec?.output) return String(rec.output);
    } catch { /* fall back to preview */ }
  }
  return typeof data.preview === 'string' ? data.preview : '';
}

/**
 * Extract the concrete deliverable references a session produced from its successful
 * tool_returned events. Deterministic + heuristic — only shapes we can probe.
 */
export function extractDeliverables(sessionId: string, deps: DeliverableProbeDeps = {}): Deliverable[] {
  const listFn = deps.listEventsFn ?? listEvents;
  let events: EventRow[];
  try {
    events = listFn(sessionId, { types: ['tool_returned'] });
  } catch {
    return [];
  }
  const out: Deliverable[] = [];
  const seen = new Set<string>();
  const add = (d: Deliverable) => {
    const key = `${d.kind}:${d.ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };
  for (const ev of events) {
    const data = (ev.data ?? {}) as { tool?: string; ok?: boolean; callId?: string };
    if (data.ok === false) continue; // a failed call produced no deliverable
    const tool = (data.tool ?? '').toString();
    const text = resultTextFor(sessionId, ev, deps);
    if (!text) continue;

    // Google Sheet — a composio GOOGLESHEETS_* result carrying a spreadsheet id/URL.
    if (/GOOGLESHEETS|google.?sheets|spreadsheet/i.test(tool + text)) {
      const id = SHEET_ID_RE.exec(text)?.[1] ?? SHEET_URL_RE.exec(text)?.[1];
      if (id) add({ kind: 'google_sheet', ref: id, callId: data.callId, tool });
    }
    // Local file — a write_file result names the absolute path it wrote.
    if (tool === 'write_file' || WROTE_FILE_RE.test(text)) {
      const p = WROTE_FILE_RE.exec(text)?.[1];
      if (p) {
        const isSpaceView = /\/spaces\/[^/]+\/view\//.test(p);
        add({ kind: isSpaceView ? 'space_view' : 'local_file', ref: p, callId: data.callId, tool });
      }
    }
  }
  return out;
}

// ─── Probing ──────────────────────────────────────────────────────────────────

/** Does the objective imply the deliverables must be POPULATED (not just created)? */
export function objectiveImpliesPopulation(objective: string): boolean {
  return /\b(populate|popula|fill(?:ed|ing)?\b|with (?:the )?data|data rows?|enter(?:ed|ing)?|append|add(?:ed|ing)? (?:the )?(?:rows?|data|records?)|write (?:the )?(?:data|rows?|values)|not\s+(?:be\s+)?blank|contents?|records?)\b/i.test(objective);
}

const SPACE_VIEW_MIN_BYTES = 200; // a real view is more than an empty shell

/** Count the populated rows across a GOOGLESHEETS values/batch-get result: the
 *  largest `values` array found anywhere in the payload. -1 when there is no values
 *  array at all (metadata-only / unparseable) → treated as unprobeable. */
export function countSheetRows(result: unknown): number {
  let obj: unknown = result;
  if (typeof result === 'string') {
    if (!result.trim()) return -1;
    try { obj = JSON.parse(result); } catch { return -1; }
  }
  let max = -1;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'values' && Array.isArray(val)) max = Math.max(max, val.length);
        walk(val);
      }
    }
  };
  walk(obj);
  return max;
}

/** Default sheet reader: a composio GOOGLESHEETS_BATCH_GET readback through the
 *  gated dispatch path. Best-effort — any error/unknown shape returns -1 so the
 *  sheet is SKIPPED (passed through to the judge), never falsely failed. Lazily
 *  imported to keep composio/harness off this module's static graph. */
async function defaultSheetRowCount(spreadsheetId: string, sessionId: string): Promise<number> {
  try {
    const [{ dispatchBatchItemTool }, { ToolCallsCounter }] = await Promise.all([
      import('../tools/code-mode-tool.js'),
      import('../runtime/harness/brackets.js'),
    ]);
    const out = await dispatchBatchItemTool(
      'composio_execute_tool',
      { tool_slug: 'GOOGLESHEETS_BATCH_GET', arguments: JSON.stringify({ spreadsheet_id: spreadsheetId }) },
      sessionId,
      new ToolCallsCounter(100),
    );
    return countSheetRows(out);
  } catch {
    return -1;
  }
}

async function probeOne(
  d: Deliverable,
  objective: string,
  sessionId: string,
  deps: DeliverableProbeDeps,
): Promise<DeliverableVerdict> {
  const fileStat = deps.fileStat ?? defaultFileStat;
  if (d.kind === 'local_file') {
    const st = fileStat(d.ref);
    return st.exists && st.size > 0
      ? { deliverable: d, pass: true, method: 'probe', detail: `file exists (${st.size} bytes): ${d.ref}` }
      : { deliverable: d, pass: false, method: 'probe', detail: `file ${st.exists ? 'is EMPTY (0 bytes)' : 'is MISSING'}: ${d.ref}` };
  }
  if (d.kind === 'space_view') {
    const st = fileStat(d.ref);
    return st.exists && st.size > SPACE_VIEW_MIN_BYTES
      ? { deliverable: d, pass: true, method: 'probe', detail: `view exists (${st.size} bytes): ${d.ref}` }
      : { deliverable: d, pass: false, method: 'probe', detail: `view ${st.exists ? `is trivially small (${st.size} bytes)` : 'is MISSING'}: ${d.ref}` };
  }
  // google_sheet — only a POPULATION objective makes an empty sheet a failure.
  if (!objectiveImpliesPopulation(objective)) {
    return { deliverable: d, pass: true, method: 'skipped', detail: `sheet ${d.ref}: objective does not imply population — existence not readback-checked` };
  }
  const reader = deps.readSheetRowCount ?? defaultSheetRowCount;
  let rows: number;
  try {
    rows = await reader(d.ref, sessionId);
  } catch {
    rows = -1;
  }
  if (rows < 0) {
    return { deliverable: d, pass: true, method: 'skipped', detail: `sheet ${d.ref}: unprobeable (read failed) — passed through to the judge` };
  }
  // Populated = more than a bare title/header row.
  return rows > 1
    ? { deliverable: d, pass: true, method: 'probe', detail: `sheet ${d.ref}: ${rows} rows` }
    : { deliverable: d, pass: false, method: 'probe', detail: `sheet ${d.ref} exists but has ${rows === 1 ? 'only a title/header row' : '0 data rows'} — the objective requires it POPULATED` };
}

/** Probe a set of extracted deliverables against the objective. */
export async function probeDeliverables(
  deliverables: Deliverable[],
  objective: string,
  sessionId: string,
  deps: DeliverableProbeDeps = {},
): Promise<DeliverableProbeResult> {
  const probed: DeliverableVerdict[] = [];
  for (const d of deliverables) {
    try {
      probed.push(await probeOne(d, objective, sessionId, deps));
    } catch {
      // A probe that throws is unprobeable → pass through, never block.
      probed.push({ deliverable: d, pass: true, method: 'skipped', detail: `${d.kind} ${d.ref}: probe errored — passed through` });
    }
  }
  const failed = probed.filter((v) => !v.pass);
  const failures = failed.map((v) => ({ ref: v.deliverable.ref, gap: v.detail }));
  const summary = failed.length === 0
    ? ''
    : `Deliverable readback FAILED — the run is not done: ${failed.map((v) => v.detail).slice(0, 4).join('; ')}${failed.length > 4 ? `; +${failed.length - 4} more` : ''}.`;
  const evidenceText = probed.length === 0
    ? ''
    : ['DETERMINISTIC DELIVERABLE PROBE (readback of the artifacts this run produced):',
       ...probed.map((v) => `- ${v.pass ? (v.method === 'skipped' ? 'UNVERIFIED' : 'OK') : 'FAILED'}: ${v.detail}`),
      ].join('\n');
  return { probed, failures, summary, evidenceText };
}

/** Convenience: extract + probe over a session in one call (default fs/eventlog deps). */
export async function probeSessionDeliverables(
  sessionId: string,
  objective: string,
  deps: DeliverableProbeDeps = {},
): Promise<DeliverableProbeResult> {
  return probeDeliverables(extractDeliverables(sessionId, deps), objective, sessionId, deps);
}
