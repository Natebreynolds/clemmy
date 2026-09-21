/**
 * The turn's proof, in the owner's words.
 *
 * Every typed terminal the harness publishes can carry `evidenceRefs` —
 * addressable proof of what the turn actually touched: retained tool results,
 * receipts for external writes that settled, artifacts it produced, sources it
 * read, memories it used. The harness validates and normalizes them
 * (src/runtime/harness/turn-outcome.ts) and puts them on the public bus
 * (public-presentation.ts). Until now no client read the field at all, so a
 * turn that had written to two systems, saved a file and learned something
 * ended as a paragraph of prose and a status pill.
 *
 * This module turns those refs into the one line under a settled reply:
 * "2 writes confirmed · 1 file · 3 sources". It counts what is there and says
 * nothing about what is not — an absent kind gets no chip rather than a zero,
 * because "0 writes" reads as a claim the harness never made.
 */
import type { TurnEvidenceKind, TurnEvidenceRef } from './types.js';

export interface EvidenceChip {
  kind: TurnEvidenceKind;
  /** Owner-facing count label, e.g. "2 writes confirmed". */
  label: string;
  count: number;
  /** Refs behind this chip, in harness order — the openable ones carry a uri. */
  refs: TurnEvidenceRef[];
}

/**
 * Singular/plural phrasing per evidence kind. These are deliberately about what
 * the OWNER gets, not what the engine calls it: an `external_receipt` is proof
 * a write landed somewhere real, which is the whole trust question, so it says
 * "confirmed" rather than "receipt".
 */
const PHRASING: Readonly<Record<TurnEvidenceKind, (n: number) => string>> = {
  external_receipt: (n) => `${n} write${n === 1 ? '' : 's'} confirmed`,
  artifact: (n) => `${n} file${n === 1 ? '' : 's'}`,
  source: (n) => `${n} source${n === 1 ? '' : 's'}`,
  memory: (n) => (n === 1 ? '1 remembered' : `${n} remembered`),
  tool_result: (n) => `${n} result${n === 1 ? '' : 's'}`,
};

/** Most-load-bearing first: a confirmed write outranks a file, which outranks
 *  what it read, which outranks internal results. */
const ORDER: readonly TurnEvidenceKind[] = [
  'external_receipt', 'artifact', 'memory', 'source', 'tool_result',
];

/** Group a terminal's evidence into countable, owner-facing chips. Returns an
 *  empty array for a legacy terminal that carried no refs — the caller renders
 *  nothing rather than an empty shell. */
export function evidenceChips(refs: readonly TurnEvidenceRef[] | undefined): EvidenceChip[] {
  if (!refs?.length) return [];
  const byKind = new Map<TurnEvidenceKind, TurnEvidenceRef[]>();
  for (const ref of refs) {
    if (!ref || typeof ref.id !== 'string' || !ref.id) continue;
    if (!(ref.kind in PHRASING)) continue;
    const bucket = byKind.get(ref.kind);
    if (bucket) bucket.push(ref); else byKind.set(ref.kind, [ref]);
  }
  const chips: EvidenceChip[] = [];
  for (const kind of ORDER) {
    const group = byKind.get(kind);
    if (!group?.length) continue;
    chips.push({ kind, count: group.length, label: PHRASING[kind](group.length), refs: group });
  }
  return chips;
}

/** The single-line summary under a settled reply, or '' when the terminal
 *  proved nothing. Never invents a total the refs do not support. */
export function evidenceSummary(refs: readonly TurnEvidenceRef[] | undefined): string {
  return evidenceChips(refs).map((chip) => chip.label).join(' · ');
}

/** A ref that carries somewhere to go. The `uri` is non-optional in the return
 *  type on purpose: callers render an open affordance from it, and a narrowing
 *  that stops at this boundary just moves the non-null assertion into the UI. */
export type OpenableEvidenceRef = TurnEvidenceRef & { uri: string };

/** Refs a surface can actually open. A ref without a uri is still proof the
 *  turn touched something — it just has nowhere to send the owner. */
export function openableEvidence(refs: readonly TurnEvidenceRef[] | undefined): OpenableEvidenceRef[] {
  return (refs ?? []).filter((ref): ref is OpenableEvidenceRef => (
    typeof ref?.uri === 'string' && ref.uri.length > 0
  ));
}

/**
 * The same receipt, derived from what the CLIENT WATCHED instead of from the
 * terminal's refs.
 *
 * evidenceChips above reads `evidenceRefs`, which is the harness's own proof.
 * That field is populated on ~4% of terminals, so the receipt row almost never
 * drew and the reply's "done" went back to resting on its prose — the exact
 * thing the row exists to replace.
 *
 * But the client is not short of evidence. `tool_called`, `tool_returned`,
 * `deliverable_saved` and `external_write_succeeded` are all PROJECTED, and the
 * activity fold already reduces them into rows carrying a write disposition and
 * a rolling file count. So the receipt can be assembled from the same facts the
 * server would have used, arriving by a different route, with no server change.
 *
 * Two honesty rules, because observation and proof are not the same thing:
 *
 *   - A write says "confirmed" ONLY on disposition 'confirmed', which is set by
 *     external_write_succeeded — the very event a server-side receipt would cite.
 *     'reserved' and 'orphaned' are not claims of landing and are left out; a
 *     dispatched-but-unobserved write must never read as a settled one.
 *   - Read work becomes a `tool_result` chip, the weakest kind, and never a
 *     `source` chip. A source claims Clem read a named artifact; all the client
 *     saw was a tool return. Overstating that is how a receipt stops being one.
 *
 * Terminal refs still win when present: they are the harness's own statement.
 */
export function observedEvidenceChips(
  items: readonly ObservedActivity[] | undefined,
): EvidenceChip[] {
  if (!items?.length) return [];
  const counts = new Map<TurnEvidenceKind, number>();
  const bump = (kind: TurnEvidenceKind, by = 1): void => {
    if (by > 0) counts.set(kind, (counts.get(kind) ?? 0) + by);
  };

  for (const item of items) {
    // A settled external write is the one thing here that is genuinely proof.
    if (item.write?.disposition === 'confirmed') bump('external_receipt');
    // The deliverables row is a rolling aggregate, so its own count is the total.
    else if (item.id === 'deliverables') bump('artifact', item.count ?? 1);
    else if (item.effect === 'local_write' && item.status === 'done') bump('artifact');
    else if (item.kind === 'tool' && item.status === 'done' && item.effect !== 'external_write') {
      bump('tool_result', item.repeats ?? 1);
    }
  }

  const chips: EvidenceChip[] = [];
  for (const kind of ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count > 0) chips.push({ kind, label: PHRASING[kind](count), count, refs: [] });
  }
  return chips;
}

/** The fields observedEvidenceChips reads. Structurally a subset of
 *  ActivityItem, declared separately so this module keeps no import cycle. */
export interface ObservedActivity {
  id: string;
  kind: string;
  status: string;
  effect?: string;
  count?: number;
  repeats?: number;
  write?: { disposition: string };
}
