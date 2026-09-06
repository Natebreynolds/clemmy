/**
 * The write ledger — one row per external write, settled.
 *
 * THE DEFECT THIS EXISTS TO FIX. `external_write` is appended with
 * `preDispatch: true` BEFORE the call leaves this machine
 * (src/runtime/harness/external-write-event-projection.ts, the reservation
 * append). Both client reducers stamped that event `status: 'done',
 * tone: 'success'` — so a green "Created a draft" appeared for a call that had
 * not yet been attempted, and appeared again when its terminal arrived. For a
 * product whose stated positioning is "completion is graded on a durable effect
 * ledger", rendering an intention as a receipt is the one lie that matters.
 *
 * HOW PAIRING WORKS. The reservation writes `callId` and `canonicalCallId` set
 * to the same value; every terminal writes that same pair back
 * (`callId: reservation.callId`). Only `callId`/`call_id` are on the public
 * allowlist — `canonicalCallId` and `parentEventId` are not — so `callId` is
 * the client's one honest handle, and it is sufficient because the two are
 * equal by construction at both ends.
 *
 * WHAT IS NOT DERIVABLE HERE, AND IS NOT FAKED.
 *  - `refused` (stopped before it left the Mac). The engine has this state, and
 *    it is a real `external_write_failed`, but nothing distinguishes it on the
 *    public bus: no caller of projectExternalWriteTerminal passes `preDispatch`
 *    into a terminal's data, and `reason` is not allowlisted. It therefore
 *    renders as `failed` until the emitter sets the flag it is already allowed
 *    to send. Inventing the distinction client-side would be a guess wearing a
 *    receipt's clothes.
 *  - `irreversible`. Written durably by the projection, stripped by the public
 *    allowlist, so it is ALWAYS absent here. It stays `null`, and a null must
 *    never be read as "irreversible" — that is the false statement in the
 *    alarming direction that the mobile run view was making about every draft.
 */
import { describeExternalWrite } from './tool-labels.js';

/**
 * The ledger reads exactly three fields, so it asks for exactly three. Both
 * surfaces' HarnessEvent satisfy this structurally — which matters, because
 * their two declarations have already drifted (the console's `createdAt` is
 * `string | number`, the shared one's is `number`). A function that demanded
 * the whole event would import that drift for no reason.
 */
export interface WriteEventInput {
  seq: number;
  type: string;
  data?: Record<string, unknown>;
}

/** Where one call sits in the effect ledger. */
export type WriteDisposition =
  /** Reserved before dispatch, no terminal yet. NEVER renders as done. */
  | 'reserved'
  /** The provider returned a trusted clean acknowledgement. */
  | 'confirmed'
  /** A decisive failure terminal. */
  | 'failed'
  /** Dispatched, outcome unobserved — it may have landed. */
  | 'orphaned'
  /** Ambiguous ownership, or a reservation the turn never settled. */
  | 'unknown';

export interface WriteLedgerRow {
  callId: string;
  shapeKey?: string;
  toolName?: string;
  targets: string[];
  disposition: WriteDisposition;
  /** null = the public projection did not carry it. NEVER defaults to true. */
  irreversible: boolean | null;
  /** Wire position of the event that set the current disposition. */
  settledAtSeq?: number;
}

const WRITE_TYPES = new Set([
  'external_write',
  'external_write_succeeded',
  'external_write_failed',
  'external_write_orphaned',
]);

export function isWriteEvent(type: string): boolean {
  return WRITE_TYPES.has(type);
}

/** The public allowlist ships both spellings; prefer the canonical one. */
export function writeCallId(data: Record<string, unknown>): string {
  const raw = typeof data.callId === 'string' && data.callId
    ? data.callId
    : typeof data.call_id === 'string' ? data.call_id : '';
  return raw.trim();
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function targetsOf(data: Record<string, unknown>): string[] {
  return Array.isArray(data.targets)
    ? data.targets.filter((t): t is string => typeof t === 'string')
    : [];
}

/**
 * A terminal is decisive; an orphan is an ambiguity observation that a later
 * read-back may still resolve. So a decisive terminal always wins, whichever
 * order the two arrive in, and never downgrades back to orphaned.
 */
function settle(prior: WriteDisposition, next: WriteDisposition): WriteDisposition {
  if (prior === 'confirmed' || prior === 'failed') return prior;
  return next;
}

function dispositionFor(type: string): WriteDisposition {
  if (type === 'external_write_succeeded') return 'confirmed';
  if (type === 'external_write_failed') return 'failed';
  if (type === 'external_write_orphaned') return 'orphaned';
  return 'reserved';
}

/** The stable row id for a call, shared by both reducers so the reservation and
 *  its terminal address the same row instead of appending twice. */
export function writeRowKey(data: Record<string, unknown>, seq: number): string {
  return writeCallId(data) || `unpaired:${seq}`;
}

/**
 * Apply ONE write event to the row it belongs to. This is the single
 * derivation: the streaming reducers call it per event, and foldWriteLedger
 * reduces the whole array through it, so a live turn and a reloaded transcript
 * cannot disagree.
 */
export function applyWriteEvent(
  prior: WriteLedgerRow | undefined,
  ev: WriteEventInput,
): WriteLedgerRow {
  const data = (ev.data ?? {}) as Record<string, unknown>;
  const callId = writeCallId(data);
  const key = writeRowKey(data, ev.seq);
  const next = dispositionFor(ev.type);
  const toolName = stringOf(data.toolName) ?? stringOf(data.tool);

  if (!prior) {
    return {
      callId: key,
      ...(stringOf(data.shapeKey) ? { shapeKey: stringOf(data.shapeKey) } : {}),
      ...(toolName ? { toolName } : {}),
      targets: targetsOf(data),
      disposition: next,
      irreversible: typeof data.irreversible === 'boolean' ? data.irreversible : null,
      ...(next === 'reserved' ? {} : { settledAtSeq: ev.seq }),
    };
  }

  // A second reservation on a call whose first is still open means two writes
  // share one handle: neither can be attributed to a terminal. Never resolve
  // that to "never dispatched" -- on a product whose thesis is "when Clem says
  // it landed, it landed", claiming a successful send never happened is the
  // worse of the two available lies.
  if (next === 'reserved' && prior.disposition === 'reserved' && callId) {
    return { ...prior, disposition: 'unknown' };
  }

  const disposition = settle(prior.disposition, next);
  return {
    ...prior,
    // Terminals carry the authoritative descriptor; a reservation's targets can
    // over-state what actually went out.
    ...(next !== 'reserved' ? { targets: targetsOf(data) } : {}),
    ...(typeof data.irreversible === 'boolean' ? { irreversible: data.irreversible } : {}),
    disposition,
    ...(disposition === prior.disposition ? {} : { settledAtSeq: ev.seq }),
  };
}

/**
 * Fold every write event in wire order into one row per call. Pure and total;
 * a terminal arriving without its reservation still produces one settled row.
 */
export function foldWriteLedger(events: readonly WriteEventInput[]): Map<string, WriteLedgerRow> {
  const rows = new Map<string, WriteLedgerRow>();
  for (const ev of events) {
    if (!isWriteEvent(ev.type)) continue;
    const key = writeRowKey((ev.data ?? {}) as Record<string, unknown>, ev.seq);
    rows.set(key, applyWriteEvent(rows.get(key), ev));
  }
  return rows;
}

/**
 * A reservation still open when the turn ends never received an answer. That is
 * genuinely unknown — not a failure, and emphatically not a success.
 */
export function sealOpenWrites(rows: Map<string, WriteLedgerRow>): Map<string, WriteLedgerRow> {
  const sealed = new Map(rows);
  for (const [key, row] of sealed) {
    if (row.disposition === 'reserved') sealed.set(key, { ...row, disposition: 'unknown' });
  }
  return sealed;
}

/** The one sentence a write row says, in Clem's ledger voice: third person. */
export function writeRowLabel(row: WriteLedgerRow): string {
  const base = describeExternalWrite(row.shapeKey, row.toolName ?? '', row.targets, {
    ...(row.irreversible === null ? {} : { irreversible: row.irreversible }),
    ...(row.disposition === 'reserved' ? { tense: 'present' as const } : {}),
  });
  switch (row.disposition) {
    case 'reserved':
      return base;
    case 'confirmed':
      return base;
    case 'failed':
      return `${base} — failed`;
    case 'orphaned':
      return `${base} — timed out, may have landed`;
    case 'unknown':
      return `${base} — couldn't confirm this one`;
  }
}

/** How the row reads as state. A reservation is live work, never a receipt. */
export function writeRowStatus(row: WriteLedgerRow): 'running' | 'done' | 'failed' | 'interrupted' {
  switch (row.disposition) {
    case 'reserved': return 'running';
    case 'confirmed': return 'done';
    case 'failed': return 'failed';
    default: return 'interrupted';
  }
}

export function writeRowTone(row: WriteLedgerRow): 'success' | 'danger' | 'warning' | 'live' {
  switch (row.disposition) {
    case 'reserved': return 'live';
    case 'confirmed': return 'success';
    case 'failed': return 'danger';
    default: return 'warning';
  }
}

/**
 * Reversibility for display. Three values, because the public bus carries two
 * and silence is the third. `null` means the ledger did not say — which is the
 * current state of every write on the chat plane — and an omitted phrase is the
 * only honest rendering of that.
 */
export function writeReversibilityLabel(row: WriteLedgerRow): string | null {
  if (row.irreversible === null) return null;
  return row.irreversible ? "can't be undone" : 'reversible';
}
