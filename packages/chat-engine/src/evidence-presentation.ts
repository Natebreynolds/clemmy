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
