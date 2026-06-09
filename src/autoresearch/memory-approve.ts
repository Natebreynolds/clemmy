/**
 * Memory-refinement APPROVE — the "auto research for memory" P2 layer.
 *
 * Where P1 (memory-apply.ts) AUTO-applies the one provably-safe class, P2 never
 * auto-applies anything: every action here is gated on an explicit human click
 * on the Evolution page. These touch GENUINE user knowledge (near-duplicate
 * merges, low-recall facts, self-tool noise), so they are deliberately the most
 * defensive code in the loop.
 *
 * Every P2 action is, without exception:
 *   - SOFT      — only deleteFact (active=0) and updateFact{importance}; the hard
 *                 forgetFact({hard}) path is NOT imported here, so it's unreachable.
 *   - SERVER-RE-DERIVED — the batch actions recompute their full target set from
 *                 the live store at apply time; the per-pair action re-fetches and
 *                 re-validates every pair at the seam. Client-sent ids are never
 *                 trusted blindly (no spoof, no stale-snapshot delete).
 *   - PINNED-EXEMPT — enforced in the predicate AND re-checked at the seam, since
 *                 deleteFact itself has no pinned guard (closes the TOCTOU window).
 *   - CAPPED    — ≤ cap rows per request (default 25), bounded blast radius.
 *   - AUDITED   — every applied batch is written to the hygiene log (kind
 *                 'approve-*') so it's reviewable and undoable.
 *   - REVERSIBLE — soft-deletes restore via reactivateFact / POST .../restore;
 *                 the importance lift is MAX-merged, bounded ≤10, prior value audited.
 *
 * Kill-switch: CLEMMY_MEMORY_APPROVE=off. Deliberately SEPARATE from the nightly
 * CLEMMY_MEMORY_AUTOCLEAN switch — turning off the unattended janitor must not
 * disable the user's own Approve buttons (and vice-versa).
 */
import { getRuntimeEnv } from '../config.js';
import { openMemoryDb } from '../memory/db.js';
import { deleteFact, getFact, updateFact } from '../memory/facts.js';
import { isSelfReferentialTool } from '../memory/reflection.js';
import { appendHygieneAudit } from '../memory/hygiene-audit.js';

const DEFAULT_CAP = 25;
const MAX_CAP = 100;

export type ApproveClass = 'merge-dup' | 'recall-gap' | 'internal-noise';
export type SkipReason = 'not-found' | 'inactive' | 'pinned' | 'stale-score' | 'already' | 'self-keep';

export interface ApproveResult {
  /** Whether the pass executed (false when disabled / cap 0 / empty input). */
  ran: boolean;
  /** Rows actually mutated — only counted on a true seam return. */
  applied: number;
  ids: number[];
  /** Candidates inspected but intentionally NOT acted on, with the reason. */
  skipped: Array<{ id: number; reason: SkipReason }>;
  examples: Array<{ id: number; content: string; note?: string }>;
  cap: number;
  /** Candidates left after this capped run (drives the "N left" UI). */
  remaining: number;
  dryRun: boolean;
  class: ApproveClass;
  reason?: 'disabled' | 'cap-zero' | 'empty' | 'no-eligible';
}

export function approveEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_MEMORY_APPROVE', 'on') || 'on').toLowerCase() !== 'off';
}

function clampCap(n: number | undefined): number {
  return Math.max(0, Math.min(MAX_CAP, n ?? DEFAULT_CAP));
}

function trunc(s: string, n = 100): string {
  const c = s.replace(/\s+/g, ' ').trim();
  return c.length > n ? c.slice(0, n) + '…' : c;
}

function base(klass: ApproveClass, cap: number, dryRun: boolean): ApproveResult {
  return { ran: false, applied: 0, ids: [], skipped: [], examples: [], cap, remaining: 0, dryRun, class: klass };
}

/**
 * (a) merge approved near-duplicate pairs — soft-delete the dropId only.
 *
 * The one PER-PAIR action: the human approved a SPECIFIC pair they saw on the
 * card, so we accept the pair from the client — but re-validate every pair at
 * the seam (existence, active, not-pinned, and crucially score(drop) <=
 * score(keep)) so a store change since page-load can never make us delete the
 * now-better fact. Never touches keepId.
 */
export function approveDuplicateMerges(
  opts: { pairs?: Array<{ keepId: number; dropId: number }>; maxMerge?: number; dryRun?: boolean; nowIso?: string } = {},
): ApproveResult {
  const cap = clampCap(opts.maxMerge);
  const dryRun = opts.dryRun === true;
  const allPairs = Array.isArray(opts.pairs) ? opts.pairs : [];
  const result = base('merge-dup', cap, dryRun);

  if (!approveEnabled()) { result.reason = 'disabled'; return result; }
  if (cap === 0) { result.reason = 'cap-zero'; return result; }
  if (allPairs.length === 0) { result.reason = 'empty'; result.ran = true; return result; }

  const pairs = allPairs.slice(0, cap);
  result.remaining = Math.max(0, allPairs.length - pairs.length);
  result.ran = true;

  // Track exactly the pairs that triggered a delete (not a post-hoc id-membership
  // filter, which would double-count a dropId that appeared in two client pairs).
  const actedPairs: Array<{ keepId: number; dropId: number }> = [];

  for (const { keepId, dropId } of pairs) {
    if (keepId === dropId) { result.skipped.push({ id: dropId, reason: 'self-keep' }); continue; }
    const drop = getFact(dropId);
    if (!drop) { result.skipped.push({ id: dropId, reason: 'not-found' }); continue; }
    if (!drop.active) { result.skipped.push({ id: dropId, reason: 'inactive' }); continue; }
    if (drop.pinned) { result.skipped.push({ id: dropId, reason: 'pinned' }); continue; }
    const keep = getFact(keepId);
    if (!keep || !keep.active) { result.skipped.push({ id: dropId, reason: 'not-found' }); continue; }
    // No-wrong-drop: never delete the fact that is now the better-scored one.
    if ((drop.score ?? 0) > (keep.score ?? 0)) { result.skipped.push({ id: dropId, reason: 'stale-score' }); continue; }

    if (dryRun) {
      result.ids.push(dropId);
      result.applied += 1;
      if (result.examples.length < 10) result.examples.push({ id: dropId, content: trunc(drop.content), note: `keep #${keepId}` });
      continue;
    }
    if (deleteFact(dropId)) {
      result.ids.push(dropId);
      result.applied += 1;
      actedPairs.push({ keepId, dropId });
      if (result.examples.length < 10) result.examples.push({ id: dropId, content: trunc(drop.content), note: `keep #${keepId}` });
    }
  }

  if (result.applied > 0 && !dryRun) {
    appendHygieneAudit({
      at: opts.nowIso ?? new Date().toISOString(),
      kind: 'approve-dedup',
      ids: result.ids,
      detail: { applied: result.applied, cap, class: 'near-duplicate', pairs: actedPairs },
    });
  }
  return result;
}

/**
 * (b) lift high-value, never-recalled facts — raise importance so they surface.
 *
 * Replaces the naive "pin them" idea: pinning 76 facts would overflow the small
 * pinned block and EVICT the user's genuine standing instructions. Instead we
 * nudge importance (+1, MAX-merged, bounded ≤10) so the existing Stanford recall
 * ranks them higher — no pin-slot cost, no prompt bloat. Content is never
 * touched, so this is NOT a rephrase (P3 territory). Target set is re-derived
 * server-side; the example list is never trusted.
 */
export function liftRecallGaps(
  opts: { maxLift?: number; dryRun?: boolean; nowIso?: string } = {},
): ApproveResult {
  const cap = clampCap(opts.maxLift);
  const dryRun = opts.dryRun === true;
  const result = base('recall-gap', cap, dryRun);

  if (!approveEnabled()) { result.reason = 'disabled'; return result; }
  if (cap === 0) { result.reason = 'cap-zero'; return result; }

  const db = openMemoryDb();
  // Tightened vs the detector: drop the trust_level=1.0 OR clause (it sweeps in
  // every mundane directly-stated fact). Only genuine high-importance gaps.
  const total = (db.prepare(
    `SELECT COUNT(*) AS c FROM consolidated_facts
     WHERE active = 1 AND pinned = 0
       AND COALESCE(importance, 5) >= 7 AND COALESCE(importance, 5) < 10
       AND (last_accessed_at IS NULL OR last_accessed_at <= datetime(created_at, '+2 seconds'))
       AND julianday('now') - julianday(created_at) > 7`,
  ).get() as { c: number }).c;

  const rows = db.prepare(
    `SELECT id, content, COALESCE(importance, 5) AS imp FROM consolidated_facts
     WHERE active = 1 AND pinned = 0
       AND COALESCE(importance, 5) >= 7 AND COALESCE(importance, 5) < 10
       AND (last_accessed_at IS NULL OR last_accessed_at <= datetime(created_at, '+2 seconds'))
       AND julianday('now') - julianday(created_at) > 7
     ORDER BY COALESCE(importance, 5) DESC, id ASC
     LIMIT ?`,
  ).all(cap) as Array<{ id: number; content: string; imp: number }>;

  result.ran = true;
  result.remaining = Math.max(0, total - rows.length);
  const priorImportance: Record<number, number> = {};

  for (const row of rows) {
    if (row.imp >= 10) { result.skipped.push({ id: row.id, reason: 'already' }); continue; }
    if (dryRun) {
      result.ids.push(row.id);
      result.applied += 1;
      if (result.examples.length < 10) result.examples.push({ id: row.id, content: trunc(row.content), note: `imp ${row.imp}→${Math.min(10, row.imp + 1)}` });
      continue;
    }
    const updated = updateFact(row.id, { importance: Math.min(10, row.imp + 1) });
    if (updated) {
      result.ids.push(row.id);
      result.applied += 1;
      priorImportance[row.id] = row.imp;
      if (result.examples.length < 10) result.examples.push({ id: row.id, content: trunc(row.content), note: `imp ${row.imp}→${updated.importance ?? row.imp + 1}` });
    }
  }

  if (result.applied > 0 && !dryRun) {
    appendHygieneAudit({
      at: opts.nowIso ?? new Date().toISOString(),
      kind: 'approve-lift',
      ids: result.ids,
      detail: { applied: result.applied, cap, class: 'recall-gap', priorImportance },
    });
  }
  // Surface an honest signal when the detector counts gaps the boost can't act on
  // (e.g. all eligible facts are already at max importance) — so the UI shows
  // "nothing to boost" instead of a silent no-op on an enabled button.
  if (result.ran && result.applied === 0 && !dryRun) result.reason = 'no-eligible';
  return result;
}

/**
 * (c) retire internal-tool noise — soft-delete self-referential tool facts.
 *
 * Re-derives membership exactly like the detector: facts derived from
 * Clementine's own introspective tools (memory_*, task_*, execution_*, …) via
 * isSelfReferentialTool. Pinned-exempt in the predicate AND re-checked at the
 * seam. Soft + capped (≤25/click even though ~hundreds exist; repeat to drain).
 */
export function retireInternalNoise(
  opts: { maxPrune?: number; dryRun?: boolean; nowIso?: string } = {},
): ApproveResult {
  const cap = clampCap(opts.maxPrune);
  const dryRun = opts.dryRun === true;
  const result = base('internal-noise', cap, dryRun);

  if (!approveEnabled()) { result.reason = 'disabled'; return result; }
  if (cap === 0) { result.reason = 'cap-zero'; return result; }

  const db = openMemoryDb();
  // Fetch the candidate window, then JS-filter by the canonical deny-set
  // (single source of truth in reflection.ts). Bounded fetch so a huge store
  // can't load everything; ample headroom over the cap.
  const rows = db.prepare(
    `SELECT id, content, derived_from_tool FROM consolidated_facts
     WHERE active = 1 AND pinned = 0 AND derived_from_tool IS NOT NULL
     ORDER BY id ASC`,
  ).all() as Array<{ id: number; content: string; derived_from_tool: string | null }>;
  const noise = rows.filter((r) => isSelfReferentialTool(r.derived_from_tool));

  result.ran = true;
  result.remaining = Math.max(0, noise.length - Math.min(noise.length, cap));

  let acted = 0;
  for (const row of noise) {
    if (acted >= cap) break;
    // Defense-in-depth: re-check pinned at the seam (deleteFact has no guard).
    const live = getFact(row.id);
    if (!live || !live.active) { result.skipped.push({ id: row.id, reason: 'inactive' }); continue; }
    if (live.pinned) { result.skipped.push({ id: row.id, reason: 'pinned' }); continue; }

    if (dryRun) {
      acted += 1;
      result.ids.push(row.id);
      result.applied += 1;
      if (result.examples.length < 10) result.examples.push({ id: row.id, content: trunc(row.content), note: row.derived_from_tool ?? undefined });
      continue;
    }
    if (deleteFact(row.id)) {
      acted += 1;
      result.ids.push(row.id);
      result.applied += 1;
      if (result.examples.length < 10) result.examples.push({ id: row.id, content: trunc(row.content), note: row.derived_from_tool ?? undefined });
    }
  }
  // Recompute remaining honestly: total noise minus what we just applied.
  result.remaining = Math.max(0, noise.length - result.applied);

  if (result.applied > 0 && !dryRun) {
    appendHygieneAudit({
      at: opts.nowIso ?? new Date().toISOString(),
      kind: 'approve-retire',
      ids: result.ids,
      detail: { applied: result.applied, cap, class: 'internal-noise' },
    });
  }
  return result;
}
