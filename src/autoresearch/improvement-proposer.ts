/**
 * Autoresearch — Phase C: human-gated improvement PROPOSER.
 *
 * The observatory (observatory.ts) is observe-only: it computes tool-health,
 * recall hit-rate, and rule-based suggestions, then prints "edit by hand". This
 * module closes the OODA loop's ACT step WITHOUT ever auto-mutating: it turns the
 * observatory's detectors into structured, REVIEWABLE proposals that a human
 * approves with one click — at which point the change is applied through the
 * SAME journaled, reversible primitives the memory-approve flow already uses.
 *
 * Two safety walls, deliberately separate:
 *   - PROPOSE is gated by CLEMMY_IMPROVEMENT_PROPOSER (default OFF). When off,
 *     no proposals are ever drafted and the nightly tick is byte-identical.
 *   - APPLY is gated by approveEnabled() (CLEMMY_MEMORY_APPROVE) AND requires an
 *     explicit human approve call. The proposer's own logic NEVER applies its own
 *     drafts — a separate human gate is the framework's "never self-grade".
 *
 * Apply paths, by kind:
 *   - skill_pitfall → appendSkillPitfall (skill-store) — auto-appliable, reversible
 *                     by editing the skill.
 *   - retire_fact   → retireInternalNoise (memory-approve) — soft-delete, reversible.
 *   - tool_desc     → MANUAL: tool descriptions live in code, so approval only
 *                     ACKNOWLEDGES the suggestion; the human edits the source.
 *
 * Every applied proposal is journaled (hygiene-audit kind 'approve-improve') so
 * it's reviewable and undoable, exactly like the other approve actions.
 *
 * v1 is deterministic + rule-based (testable, no flaky model call in nightly
 * maintenance). `proposedText` is templated from the real numbers; an LLM
 * phrasing-enrichment pass is a future seam (deps.draftText) — the detectors,
 * persistence, gating, and apply paths are the load-bearing parts and are shipped.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { appendHygieneAudit } from '../memory/hygiene-audit.js';
import { approveEnabled, retireInternalNoise } from './memory-approve.js';
import { appendSkillPitfall, listSkills } from '../memory/skill-store.js';
import type { ObservatoryReport } from './observatory.js';

type ToolHealth = ObservatoryReport['toolHealth'][number];

export type ImprovementKind = 'tool_desc' | 'skill_pitfall' | 'retire_fact';
export type ProposalStatus = 'pending' | 'approved' | 'applied' | 'dismissed';
/** auto = appliable through the gated flow; manual = the human edits code, approval only acknowledges. */
export type ApplyMode = 'auto' | 'manual';

export interface ImprovementProposal {
  /** Stable content hash (kind:target:proposedText) — re-proposing the same issue
   *  on a later nightly run yields the SAME id, so the store dedups instead of piling up. */
  id: string;
  kind: ImprovementKind;
  /** Tool name / skill name / fact-class the proposal targets. */
  target: string;
  /** The concrete change: a pitfall line, a description tweak, or a retire summary. */
  proposedText: string;
  rationale: string;
  evidence: string;
  applyMode: ApplyMode;
  status: ProposalStatus;
  proposedAt: string;
  appliedAt?: string;
}

const STORE_DIR = path.join(BASE_DIR, 'state', 'autoresearch');
const STORE_FILE = path.join(STORE_DIR, 'improvement-proposals.json');

/** Phase-C PROPOSE gate (default OFF until live-validated on real reports). */
export function proposerEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_IMPROVEMENT_PROPOSER', 'off') || 'off').toLowerCase() === 'on';
}

function proposalId(kind: ImprovementKind, target: string, proposedText: string): string {
  return createHash('sha1').update(`${kind}:${target}:${proposedText}`).digest('hex').slice(0, 12);
}

function mkProposal(
  p: Pick<ImprovementProposal, 'kind' | 'target' | 'proposedText' | 'rationale' | 'evidence' | 'applyMode'>,
  proposedAt: string,
): ImprovementProposal {
  return { ...p, id: proposalId(p.kind, p.target, p.proposedText), status: 'pending', proposedAt };
}

export interface ProposerDeps {
  /** Installed skills (name + body), for mapping a failing tool to a skill that
   *  references it. Injectable for tests; defaults to the real skill store. */
  listSkills?: () => Array<{ name: string; body: string }>;
  /** Count of soft-deletable internal-noise memory facts. Injectable; defaults to
   *  a dry-run of retireInternalNoise so the proposer reuses the canonical detector. */
  countRetirableNoise?: () => number;
  /** Timestamp for proposedAt (testability). Defaults to now. */
  nowIso?: string;
}

function defaultListSkills(): Array<{ name: string; body: string }> {
  try {
    return listSkills().map((s) => ({ name: s.name, body: s.body }));
  } catch {
    return [];
  }
}

function defaultCountRetirableNoise(): number {
  try {
    return retireInternalNoise({ dryRun: true }).applied;
  } catch {
    return 0;
  }
}

/**
 * Turn an observatory report into structured improvement proposals. Pure +
 * deterministic given its deps. Detectors mirror the observatory's own
 * generateSuggestions thresholds so the proposals line up with the report a human
 * already reads, but emit an actionable, applyable artifact instead of prose.
 */
export function buildImprovementProposals(report: ObservatoryReport, deps: ProposerDeps = {}): ImprovementProposal[] {
  const skills = (deps.listSkills ?? defaultListSkills)();
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const out: ImprovementProposal[] = [];

  for (const h of report.toolHealth as ToolHealth[]) {
    if (h.calls < 5) continue;
    const errorRate = h.calls > 0 ? h.errors / h.calls : 0;
    const emptyRate = h.calls > 0 ? h.emptyResults / h.calls : 0;
    const wrongPickRate = h.calls > 0 ? h.wrongPickHints / h.calls : 0;
    const pct = (n: number) => `${Math.round(n * 100)}%`;

    if (errorRate >= 0.3) {
      // Prefer a skill_pitfall when an installed skill references this tool — that
      // path is auto-appliable and reversible. Otherwise the tool lives in code,
      // so the proposal is a manual tool-description tightening.
      const owning = skills.find((s) => s.body.includes(h.toolName));
      if (owning) {
        out.push(mkProposal({
          kind: 'skill_pitfall',
          target: owning.name,
          applyMode: 'auto',
          proposedText: `\`${h.toolName}\` failed ${pct(errorRate)} of ${h.calls} calls — confirm its preconditions are met before invoking it.`,
          rationale: `Skill "${owning.name}" references ${h.toolName}, which is erroring frequently; a pitfall note steers future runs to check preconditions first.`,
          evidence: `error rate ${pct(errorRate)} over ${h.calls} calls${h.sampleError ? ` · sample: "${h.sampleError}"` : ''}`,
        }, nowIso));
      } else {
        out.push(mkProposal({
          kind: 'tool_desc',
          target: h.toolName,
          applyMode: 'manual',
          proposedText: `Tighten ${h.toolName}'s description to state the precondition that avoids its ${pct(errorRate)} error rate (e.g. "only call when <X> is connected/non-empty").`,
          rationale: `A ${pct(errorRate)} error rate over ${h.calls} calls suggests the agent reaches for ${h.toolName} when its preconditions aren't met.`,
          evidence: `error rate ${pct(errorRate)} over ${h.calls} calls${h.sampleError ? ` · sample: "${h.sampleError}"` : ''}`,
        }, nowIso));
      }
    }

    if (emptyRate >= 0.3 && wrongPickRate >= 0.2) {
      out.push(mkProposal({
        kind: 'tool_desc',
        target: h.toolName,
        applyMode: 'manual',
        proposedText: `Clarify when NOT to use ${h.toolName}: ${pct(emptyRate)} of calls returned empty and ${pct(wrongPickRate)} were wrong-pick hints — name the better-fit tool for that intent.`,
        rationale: `${h.toolName} is being picked when a different tool would have data.`,
        evidence: `empty ${pct(emptyRate)} · wrong-pick ${pct(wrongPickRate)} over ${h.calls} calls`,
      }, nowIso));
    }
  }

  const noise = (deps.countRetirableNoise ?? defaultCountRetirableNoise)();
  if (noise > 0) {
    out.push(mkProposal({
      kind: 'retire_fact',
      target: 'internal-noise',
      applyMode: 'auto',
      proposedText: `Retire ${noise} self-referential internal-tool memory fact${noise === 1 ? '' : 's'} (soft-delete, reversible) — they dilute recall without representing user knowledge.`,
      rationale: 'Facts derived from Clementine\'s own introspective tools crowd the recall window without adding user value.',
      evidence: `${noise} candidate internal-noise fact${noise === 1 ? '' : 's'}`,
    }, nowIso));
  }

  // Dedup by id (same issue detected twice in one pass → one proposal).
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

// ── persistence ──────────────────────────────────────────────────────────────

function readStore(): ImprovementProposal[] {
  try {
    if (!existsSync(STORE_FILE)) return [];
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
    return Array.isArray(raw) ? (raw as ImprovementProposal[]) : [];
  } catch {
    return [];
  }
}

function writeStore(list: ImprovementProposal[]): void {
  try {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch {
    /* best-effort — proposal persistence must never break the nightly tick */
  }
}

/**
 * Merge freshly-drafted proposals into the store. A proposal whose id already
 * exists is LEFT AS-IS (its status — applied/dismissed/approved — is preserved, so
 * a resolved item never resurrects as pending). Returns counts for the tick log.
 */
export function recordProposals(fresh: ImprovementProposal[]): { added: number; total: number } {
  const existing = readStore();
  const byId = new Map(existing.map((p) => [p.id, p]));
  let added = 0;
  for (const p of fresh) {
    if (!byId.has(p.id)) {
      byId.set(p.id, p);
      added += 1;
    }
  }
  const merged = [...byId.values()];
  writeStore(merged);
  return { added, total: merged.length };
}

export function listProposals(status?: ProposalStatus): ImprovementProposal[] {
  const all = readStore();
  return status ? all.filter((p) => p.status === status) : all;
}

export function listPendingProposals(): ImprovementProposal[] {
  return listProposals('pending');
}

/**
 * Draft proposals from a report and persist them — the nightly tick's entry point.
 * No-op (and no model/skill reads) unless proposerEnabled(). Best-effort.
 */
export function proposeFromReport(report: ObservatoryReport, deps: ProposerDeps = {}): { ran: boolean; added: number; total: number } {
  if (!proposerEnabled()) return { ran: false, added: 0, total: 0 };
  try {
    const fresh = buildImprovementProposals(report, deps);
    const { added, total } = recordProposals(fresh);
    return { ran: true, added, total };
  } catch {
    return { ran: false, added: 0, total: 0 };
  }
}

// ── apply (human-gated) ────────────────────────────────────────────────────────

export interface ApplyProposalResult {
  ok: boolean;
  status: ProposalStatus;
  /** Rows actually mutated (skill pitfalls = 0/1; retire = N). */
  applied: number;
  dryRun: boolean;
  reason?: 'disabled' | 'not-found' | 'already' | 'manual-acknowledged' | 'apply-failed';
}

/**
 * Approve (and, for auto kinds, APPLY) one proposal. Gated by approveEnabled()
 * and an explicit human call. dryRun previews the effect without mutating or
 * advancing status. Manual (tool_desc) proposals can only be ACKNOWLEDGED here —
 * the actual edit is the human's, in code. Every real apply is journaled.
 */
export function approveProposal(id: string, opts: { dryRun?: boolean; nowIso?: string } = {}): ApplyProposalResult {
  const dryRun = opts.dryRun === true;
  if (!approveEnabled()) return { ok: false, status: 'pending', applied: 0, dryRun, reason: 'disabled' };

  const list = readStore();
  const p = list.find((x) => x.id === id);
  if (!p) return { ok: false, status: 'pending', applied: 0, dryRun, reason: 'not-found' };
  if (p.status === 'applied') return { ok: true, status: 'applied', applied: 0, dryRun, reason: 'already' };

  const at = opts.nowIso ?? new Date().toISOString();

  // Manual: tool descriptions live in code — approval only acknowledges.
  if (p.applyMode === 'manual') {
    if (!dryRun) {
      p.status = 'approved';
      writeStore(list);
      appendHygieneAudit({ at, kind: 'approve-improve', ids: [], detail: { proposalId: p.id, kind: p.kind, target: p.target, mode: 'manual-ack' } });
    }
    return { ok: true, status: 'approved', applied: 0, dryRun, reason: 'manual-acknowledged' };
  }

  // Auto: apply through the canonical, reversible mutators.
  let applied = 0;
  if (p.kind === 'skill_pitfall') {
    if (dryRun) return { ok: true, status: 'pending', applied: 0, dryRun };
    const updated = appendSkillPitfall(p.target, p.proposedText);
    applied = updated ? 1 : 0;
    if (applied === 0) return { ok: false, status: 'pending', applied: 0, dryRun, reason: 'apply-failed' };
  } else if (p.kind === 'retire_fact') {
    const r = retireInternalNoise({ dryRun });
    applied = r.applied;
    if (dryRun) return { ok: true, status: 'pending', applied, dryRun };
  }

  p.status = 'applied';
  p.appliedAt = at;
  writeStore(list);
  appendHygieneAudit({ at, kind: 'approve-improve', ids: [], detail: { proposalId: p.id, kind: p.kind, target: p.target, applied } });
  return { ok: true, status: 'applied', applied, dryRun };
}

/** Dismiss a pending proposal (won't resurface — its id stays in the store as
 *  'dismissed'). Reversible by editing the store; never mutates user data. */
export function dismissProposal(id: string): { ok: boolean; reason?: 'not-found' } {
  const list = readStore();
  const p = list.find((x) => x.id === id);
  if (!p) return { ok: false, reason: 'not-found' };
  p.status = 'dismissed';
  writeStore(list);
  return { ok: true };
}
