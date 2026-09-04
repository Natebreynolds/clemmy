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
 * Verification is requirement-sensitive: an unprobeable artifact may preserve
 * durable creation evidence for an existence-only objective, but it can NEVER
 * prove a requirement to populate that artifact. Everything is injectable so
 * tests are deterministic with no fs/network dependence.
 */
import { existsSync, statSync } from 'node:fs';
import {
  listEvents,
  getToolOutput,
  openEventLog,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import { getRuntimeEnv } from '../config.js';

export type DeliverableKind = 'google_sheet' | 'local_file' | 'space_view';

export interface Deliverable {
  kind: DeliverableKind;
  /** Spreadsheet id, absolute file path, or space view path. */
  ref: string;
  /** Exact accepted user source that owned the producing tool call. The
   * default remote readback refuses when this durable attribution is absent. */
  sourceUserSeq?: number;
  /** The tool call that produced it (telemetry). */
  callId?: string;
  tool?: string;
  /** Durable destination posture of the exact producing capability. Reads are
   * never deliverables; a named-existing mutation is verified against its
   * frozen mutation/readback proof instead of being treated as a newly-created
   * blank artifact. Missing/legacy posture remains fail-closed through the
   * historical population probe. */
  resourcePosture?: 'created' | 'named_existing';
}

export interface DeliverableVerdict {
  deliverable: Deliverable;
  pass: boolean;
  /** 'probe' = a real readback ran; 'skipped' = no readback was required;
   * 'unverified' = required readback could not run and therefore blocks done. */
  method: 'probe' | 'skipped' | 'unverified';
  detail: string;
}

export interface DeliverableProbeResult {
  probed: DeliverableVerdict[];
  /** Confirmed failures plus required deliverables whose readback is unavailable. */
  failures: Array<{ ref: string; gap: string }>;
  /** One-line block reason naming the specific gaps (empty when nothing failed). */
  summary: string;
  /** Hard-evidence lines for diagnostics and any caller that needs a compact
   * deterministic readback summary. Empty when nothing was probed. */
  evidenceText: string;
}

export interface DeliverableProbeDeps {
  listEventsFn?: (sessionId: string, opts: { types: string[] }) => EventRow[];
  getToolOutputFn?: (sessionId: string, callId: string) => { output?: string } | null;
  fileStat?: (p: string) => { exists: boolean; size: number };
  /** Read a spreadsheet's populated row count. Return -1 for "unprobeable" (network
   *  error, bad slug, no connection). If population is required, this blocks done
   *  because creation evidence alone cannot prove populated contents. */
  readSheetRowCount?: (spreadsheetId: string, sessionId: string) => Promise<number>;
  /** Test seam for the provider-neutral frozen mutation/readback proof. The
   * production path reopens the exact owner write, verifier settlement/result,
   * and issued readback receipt and performs no provider I/O. */
  verifyNamedExistingMutation?: (
    deliverable: Deliverable,
    sessionId: string,
  ) => Promise<boolean>;
  /** Test seam for the durable destination posture of an accepted call. */
  resourcePostureForCall?: (
    sessionId: string,
    sourceUserSeq: number,
    callId: string,
  ) => 'created' | 'named_existing' | 'unknown';
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

function defaultResourcePostureForCall(
  sessionId: string,
  sourceUserSeq: number,
  callId: string,
): 'created' | 'named_existing' | 'unknown' {
  try {
    const row = openEventLog().prepare(`
      SELECT b.manifest_id, b.manifest_digest, m.digest, m.manifest_json
        FROM host_call_capability_bindings b
        JOIN capability_manifests m ON m.manifest_id = b.manifest_id
       WHERE b.session_id = ? AND b.source_user_seq = ?
         AND b.logical_tool_call_id = ? AND b.binding_kind = 'catalog_manifest'
    `).get(sessionId, sourceUserSeq, callId) as {
      manifest_id: string;
      manifest_digest: string;
      digest: string;
      manifest_json: string;
    } | undefined;
    if (!row || row.manifest_digest !== row.digest) return 'unknown';
    const manifest = JSON.parse(row.manifest_json) as {
      manifestId?: unknown;
      destination?: { posture?: unknown };
    };
    if (manifest.manifestId !== row.manifest_id) return 'unknown';
    if (manifest.destination?.posture === 'create_new') return 'created';
    if (manifest.destination?.posture === 'named_existing') return 'named_existing';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function populatedExactContent(content: unknown): boolean {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return false;
  const entries = (content as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const values = (entry as { values?: unknown }).values;
    return Array.isArray(values) && values.some((row) =>
      Array.isArray(row) && row.some((cell) =>
        cell !== null && cell !== undefined && (typeof cell !== 'string' || cell.trim().length > 0)));
  });
}

async function defaultVerifyNamedExistingMutation(
  deliverable: Deliverable,
  sessionId: string,
): Promise<boolean> {
  if (
    !deliverable.callId
    || !Number.isSafeInteger(deliverable.sourceUserSeq)
    || (deliverable.sourceUserSeq ?? 0) <= 0
  ) return false;
  try {
    const { proveFrozenMutationVerification } = await import(
      '../runtime/harness/mutation-verification-proof.js'
    );
    const proof = proveFrozenMutationVerification({
      sessionId,
      sourceUserSeq: deliverable.sourceUserSeq!,
      ownerLogicalToolCallId: deliverable.callId,
    });
    if (
      proof.status !== 'verified'
      || proof.resourceId !== deliverable.ref
      || proof.recipe.proof !== 'exact_content_v1'
      || proof.recipe.mutation.target.source !== 'provider_arguments'
      || !populatedExactContent(proof.expectedContent)
    ) return false;

    const receipt = openEventLog().prepare(`
      SELECT receipt_id
        FROM host_write_receipts
       WHERE session_id = ? AND source_user_seq = ?
         AND logical_tool_call_id = ? AND kind = 'readback'
         AND created_id = ?
    `).get(
      sessionId,
      deliverable.sourceUserSeq,
      deliverable.callId,
      deliverable.ref,
    ) as { receipt_id: string } | undefined;
    if (!receipt) return false;
    const { redeemEvidenceReceipt } = await import(
      '../runtime/harness/evidence-receipts.js'
    );
    return redeemEvidenceReceipt(sessionId, receipt.receipt_id, {
      expectKind: 'readback',
      sourceUserSeq: deliverable.sourceUserSeq,
    }).ok;
  } catch {
    return false;
  }
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
    const data = (ev.data ?? {}) as {
      tool?: string;
      ok?: boolean;
      callId?: string;
      sourceUserSeq?: number;
      accounting?: string;
      effect?: string;
    };
    if (data.accounting === 'transport_mirror') continue;
    if (data.ok === false) continue; // a failed call produced no deliverable
    const tool = (data.tool ?? '').toString();
    // Discovery returns schemas, examples, and documentation that can contain
    // realistic spreadsheet ids/URLs. Those bytes are metadata, never evidence
    // that this accepted request created or touched the referenced artifact.
    if (tool.trim().toLowerCase() === 'tool_search') continue;
    const text = resultTextFor(sessionId, ev, deps);
    if (!text) continue;

    // Google Sheet — a result carrying a spreadsheet id/URL. A read observed
    // an already-existing resource; it did not produce a deliverable. For a
    // mutation, the exact durable manifest destination decides whether this is
    // a newly-created artifact or a named-existing target. This is deliberately
    // capability/manifest-driven rather than an operation-name allowlist.
    if (/GOOGLESHEETS|google.?sheets|spreadsheet/i.test(tool + text)) {
      const id = SHEET_ID_RE.exec(text)?.[1] ?? SHEET_URL_RE.exec(text)?.[1];
      if (id && data.effect !== 'read') {
        const sourceUserSeq = Number.isSafeInteger(data.sourceUserSeq)
          && (data.sourceUserSeq ?? 0) > 0
          ? data.sourceUserSeq
          : undefined;
        const posture = sourceUserSeq !== undefined && data.callId
          ? (deps.resourcePostureForCall ?? defaultResourcePostureForCall)(
              sessionId,
              sourceUserSeq,
              data.callId,
            )
          : 'unknown';
        add({
          kind: 'google_sheet',
          ref: id,
          ...(sourceUserSeq !== undefined ? { sourceUserSeq } : {}),
          callId: data.callId,
          tool,
          ...(posture === 'created' || posture === 'named_existing'
            ? { resourcePosture: posture }
            : {}),
        });
      }
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
      const record = v as Record<string, unknown>;
      const grid = record.grid;
      if (grid && typeof grid === 'object' && !Array.isArray(grid)) {
        const header = (grid as Record<string, unknown>).header;
        const rows = (grid as Record<string, unknown>).rows;
        if (Array.isArray(rows)) {
          // The exact production Sheet adapter separates the header from data
          // rows. Preserve the historical row-count contract: a header-only
          // sheet is 1, and a populated sheet is greater than 1.
          max = Math.max(max, rows.length + (Array.isArray(header) && header.length > 0 ? 1 : 0));
        }
      }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'values' && Array.isArray(val)) max = Math.max(max, val.length);
        walk(val);
      }
    }
  };
  walk(obj);
  return max;
}

/** Default sheet reader redeems a readback that the originating accepted
 * source already executed through the shared exact kernel. The background
 * verifier runs after that source's host authority has closed, so it must never
 * invent a new call or recover source seq 0. Missing identity/settlement/live
 * binding returns -1 and blocks population readiness with zero provider I/O.
 * Lazily imported to keep the harness off this module's static graph. */
async function defaultSheetRowCount(deliverable: Deliverable, sessionId: string): Promise<number> {
  try {
    if (!Number.isSafeInteger(deliverable.sourceUserSeq) || (deliverable.sourceUserSeq ?? 0) <= 0) {
      return -1;
    }
    const { redeemAcceptedSourceReadback } = await import(
      '../runtime/harness/accepted-source-readback.js'
    );
    const redeemed = redeemAcceptedSourceReadback({
      sessionId,
      sourceUserSeq: deliverable.sourceUserSeq!,
      resourceId: deliverable.ref,
    });
    return redeemed.status === 'ok' ? countSheetRows(redeemed.payload) : -1;
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
  if (d.resourcePosture === 'named_existing') {
    const verified = deps.verifyNamedExistingMutation
      ? await deps.verifyNamedExistingMutation(d, sessionId)
      : await defaultVerifyNamedExistingMutation(d, sessionId);
    return verified
      ? {
          deliverable: d,
          pass: true,
          method: 'probe',
          detail: `sheet ${d.ref}: exact committed mutation and authoritative readback verified`,
        }
      : {
          deliverable: d,
          pass: false,
          method: 'unverified',
          detail: `sheet ${d.ref}: exact named-existing mutation readback could not be verified`,
        };
  }
  let rows: number;
  try {
    rows = deps.readSheetRowCount
      ? await deps.readSheetRowCount(d.ref, sessionId)
      : await defaultSheetRowCount(d, sessionId);
  } catch {
    rows = -1;
  }
  if (rows < 0) {
    return {
      deliverable: d,
      pass: false,
      method: 'unverified',
      detail: `sheet ${d.ref}: required population could not be verified because authoritative readback failed`,
    };
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
      const populationRequired = d.kind === 'google_sheet' && objectiveImpliesPopulation(objective);
      // A probe crash cannot manufacture proof. It blocks only when readback is
      // part of the objective's completion contract; existence-only artifacts
      // retain their durable creation evidence.
      probed.push(populationRequired
        ? {
            deliverable: d,
            pass: false,
            method: 'unverified',
            detail: `sheet ${d.ref}: required population could not be verified because the readback probe errored`,
          }
        : {
            deliverable: d,
            pass: true,
            method: 'skipped',
            detail: `${d.kind} ${d.ref}: optional probe errored — durable creation evidence preserved`,
          });
    }
  }
  const failed = probed.filter((v) => !v.pass);
  const failures = failed.map((v) => ({ ref: v.deliverable.ref, gap: v.detail }));
  const summary = failed.length === 0
    ? ''
    : `Deliverable readback FAILED or remains UNVERIFIED — the run is not done: ${failed.map((v) => v.detail).slice(0, 4).join('; ')}${failed.length > 4 ? `; +${failed.length - 4} more` : ''}.`;
  const evidenceText = probed.length === 0
    ? ''
    : ['DETERMINISTIC DELIVERABLE PROBE (readback of the artifacts this run produced):',
       ...probed.map((v) => `- ${v.pass
         ? (v.method === 'skipped' ? 'NOT REQUIRED' : 'OK')
         : (v.method === 'unverified' ? 'UNVERIFIED (BLOCKING)' : 'FAILED')}: ${v.detail}`),
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
