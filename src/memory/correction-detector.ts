/**
 * Correction detector — the negative half of the memory-credit loop.
 *
 * The auto-credit loop (recall-auto-credit.ts) records which facts fed the last
 * answer. When the user's very next message CORRECTS that answer, those exact
 * facts are suspect. This module turns a correction into a bounded, reversible
 * `not_useful` signal against the implicated refs, so a confidently-wrong memory
 * stops resurfacing instead of earning durability from having been cited.
 *
 * Layered by mutation risk so it works for EVERY user (BINDING: global):
 *  - Tier 1 (this module): record `not_useful`. Runs from deterministic cue
 *    detection alone — no judge required. Reversible: a later genuine use flips
 *    it back via recordRecallUse's `not_useful`->`used` promotion.
 *  - Tier 2 (recall-memory.ts): a bounded, accumulation-gated recall penalty.
 *  - Tier 3 (self-heal.ts): hard retirement, still behind the cross-family veto
 *    judge and revertible — deferred when no different-family judge is bound.
 *
 * The cross-family confirm judge here is an UPGRADE, not a gate: present, it
 * suppresses false positives and unlocks straight-to-retirement confidence;
 * absent (the common single-provider / BYO case), Tiers 1-2 still apply.
 */
import { MODELS } from '../config.js';
import {
  parseRecallRef,
  recordRecallRun,
  recordRecallUse,
  serializeRecallRef,
  type RecallCandidateRef,
} from './recall-usage.js';

export function correctionDetectEnabled(): boolean {
  return (process.env.CLEMMY_CORRECTION_DETECT ?? 'on').toLowerCase() !== 'off';
}

export interface CorrectionCue {
  cued: boolean;
  /** The matched cue text, for audit. */
  span?: string;
}

/**
 * Cue phrases that open a correction of the assistant's PRIOR claim. Deliberately
 * anchored near the start of the message (a correction leads with the negation),
 * and deliberately conservative: this only GATES the (optional) judge and a soft,
 * reversible signal — precision matters more than recall, and a missed correction
 * simply leaves the memory where it was.
 */
const CUE_PATTERNS: RegExp[] = [
  // Leading "no", but not the reassurance idioms ("no worries", "no rush"...).
  /^\s*(?:no|nope|nah)\b(?!\s+(?:worries|worry|problem|prob|rush|thanks?|need|biggie))[,.!\s]/i,
  /^\s*(?:that'?s|thats|this is|it'?s)\s+(?:not\s+right|wrong|incorrect|not\s+correct|not\s+true|inaccurate)\b/i,
  /^\s*(?:that'?s|thats)\s+not\b/i,
  /\b(?:actually|correction)[:,]?\s+(?:it|it'?s|its|that'?s|thats|the|he|she|they|we|i|was|were)\b/i,
  /\bthat'?s\s+(?:wrong|incorrect|not\s+right)\b/i,
  /\b(?:wrong|incorrect|not\s+what\s+i\s+said|not\s+what\s+i\s+meant)\b/i,
  /\b(?:should\s+be|it\s+should\s+say|the\s+correct\s+\w+\s+is)\b/i,
  /\byou'?re\s+(?:wrong|mistaken|confusing)\b/i,
];

/** Pure, deterministic matcher — the unit-test surface. */
export function detectCorrectionCue(text: string): CorrectionCue {
  const value = String(text ?? '').trim();
  if (!value) return { cued: false };
  // Ignore very long messages: a correction is short and pointed; a long
  // message reusing "wrong" in passing is not a correction of the last answer.
  const head = value.slice(0, 400);
  for (const re of CUE_PATTERNS) {
    const match = re.exec(head);
    if (match) return { cued: true, span: match[0].trim().slice(0, 80) };
  }
  return { cued: false };
}

export interface CorrectionSignalResult {
  ok: boolean;
  recordedRefs: string[];
  factIds: number[];
  reason?: string;
}

/**
 * Record a correction as a `not_useful` signal against the implicated refs.
 *
 * A correction is its own recall event with a negative outcome, so we mint a
 * dedicated `correction_signal` run carrying the refs as candidates and record
 * `not_useful` against it. This is intentional: recordRecallUse never demotes an
 * existing `used` row within a single run, and the aggregate signal reader counts
 * DISTINCT recall_ids per outcome — so a fact used in run A and corrected in run B
 * correctly reads used=1, notUseful=1. Best-effort; never throws.
 */
export function recordCorrectionSignal(input: {
  objective: string;
  refs: RecallCandidateRef[];
  detail: string;
  nowIso?: string;
}): CorrectionSignalResult {
  const refs = dedupeRefs(input.refs);
  if (refs.length === 0) return { ok: false, recordedRefs: [], factIds: [], reason: 'no refs' };
  try {
    const run = recordRecallRun({
      objective: input.objective.slice(0, 240) || 'correction',
      surface: 'correction_signal',
      answerability: 'insufficient',
      candidateRefs: refs,
      // A correction signal is short-lived bookkeeping; the durable effect is the
      // recorded not_useful outcome, not the run.
      ttlHours: 24,
      nowIso: input.nowIso,
    });
    const result = recordRecallUse({
      recallId: run.id,
      refs: refs.map(serializeRecallRef),
      outcome: 'not_useful',
      detail: input.detail.slice(0, 200),
      nowIso: input.nowIso,
    });
    if (!result.ok) return { ok: false, recordedRefs: [], factIds: [], reason: result.reason };
    const recordedRefs = result.recorded.map(serializeRecallRef);
    const factIds = result.recorded
      .filter((r) => (r.type === 'fact' || r.type === 'policy') && /^\d+$/.test(r.id))
      .map((r) => Number(r.id));
    return { ok: true, recordedRefs, factIds };
  } catch (err) {
    return { ok: false, recordedRefs: [], factIds: [], reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Parse serialized `type:id` refs (as stored in the recall_auto_credit event)
 *  into candidate refs, dropping anything unparseable. */
export function parseSerializedRefs(values: Array<string | null | undefined>): RecallCandidateRef[] {
  const out: RecallCandidateRef[] = [];
  for (const value of values) {
    const ref = value ? parseRecallRef(value) : null;
    if (ref) out.push(ref);
  }
  return dedupeRefs(out);
}

function dedupeRefs(refs: RecallCandidateRef[]): RecallCandidateRef[] {
  const seen = new Set<string>();
  const out: RecallCandidateRef[] = [];
  for (const ref of refs) {
    const key = serializeRecallRef(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export type CorrectionVerdict = 'approve' | 'veto' | 'unavailable';

/**
 * Cross-family confirm judge for a cued correction. Mirrors the plain-text
 * APPROVE/VETO contract and fail-closed shape of judgeMemoryFixCrossFamily
 * (self-heal.ts): a no-marker / empty / errored / no-different-family response is
 * 'unavailable'. The CALLER decides what unavailable means — for the soft Tier-1
 * signal it means "proceed on the deterministic cue"; for Tier-3 retirement it
 * means "defer". So the judge upgrades confidence, it never gates the loop.
 */
export interface CorrectionJudgeInput {
  priorAnswer: string;
  correction: string;
  targetFacts: Array<{ id: string; content: string }>;
}
export type CorrectionJudgeFn = (input: CorrectionJudgeInput) => Promise<{ verdict: CorrectionVerdict; reason?: string }>;

let judgeOverride: CorrectionJudgeFn | null = null;
/** Test seam: force the judge verdict without a live cross-family model. */
export function setCorrectionJudgeForTest(fn: CorrectionJudgeFn | null): void {
  judgeOverride = fn;
}

export async function judgeCorrectionCrossFamily(
  input: CorrectionJudgeInput,
): Promise<{ verdict: CorrectionVerdict; reason?: string }> {
  if (judgeOverride) return judgeOverride(input);
  try {
    const { Agent, run } = await import('@openai/agents');
    const { resolveRoleModel } = await import('../runtime/harness/model-roles.js');
    const { resolveProvider } = await import('../runtime/harness/model-wire-registry.js');
    const { withJudgeTimeout } = await import('../runtime/harness/judge-family.js');
    const judge = resolveRoleModel('judge');
    const detectorProvider = resolveProvider(MODELS.fast);
    if (!judge?.modelId || String(judge.provider) === String(detectorProvider)) {
      return { verdict: 'unavailable', reason: 'no different-family judge bound' };
    }
    const agent = new Agent({
      name: 'MemoryCorrectionJudge',
      instructions: [
        "You decide whether a user's latest message CORRECTS a factual claim the",
        'assistant just made from remembered facts — meaning those remembered facts',
        'are now suspect.',
        'APPROVE only if the message rejects or contradicts the prior answer or the',
        'listed facts (e.g. "no, it\'s X", "that\'s wrong", "should be Y").',
        'VETO if the message is NOT such a correction: a new/unrelated request, the',
        'user correcting their OWN wording, a clarifying question, agreement, or',
        'small talk. When uncertain, VETO — a vetoed correction just leaves memory',
        'unchanged.',
        'Reply with EXACTLY ONE LINE: "APPROVE: <one-sentence reason>" or "VETO: <one-sentence reason>".',
      ].join('\n'),
      model: judge.modelId,
      modelSettings: { reasoning: { effort: 'low' } },
      tools: [],
    });
    const prompt = [
      `Prior assistant answer: ${input.priorAnswer.slice(0, 600) || '(unavailable)'}`,
      'Remembered facts that fed that answer:',
      ...input.targetFacts.map((f) => `#${f.id}: ${f.content.slice(0, 200)}`),
      `User's latest message: ${input.correction.slice(0, 600)}`,
    ].join('\n');
    const result = await withJudgeTimeout(run(agent, prompt));
    return parseCorrectionVerdict(String((result as { finalOutput?: unknown } | undefined)?.finalOutput ?? ''));
  } catch (err) {
    return { verdict: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Parse the judge's ONE-LINE verdict deterministically (see self-heal's
 *  parseMemoryVetoVerdict). Anything without an APPROVE/VETO marker is
 *  'unavailable' — a fail-closed signal, not a decision. */
export function parseCorrectionVerdict(raw: string): { verdict: CorrectionVerdict; reason?: string } {
  const text = (raw ?? '').trim();
  if (!text) return { verdict: 'unavailable', reason: 'judge timeout' };
  const match = /^\s*(APPROVE|VETO)\s*:?\s*(.*)$/im.exec(text);
  if (!match) return { verdict: 'unavailable', reason: `no APPROVE/VETO verdict (got: ${text.slice(0, 120)})` };
  const reason = (match[2] || '').trim().slice(0, 400);
  return match[1].toUpperCase() === 'APPROVE' ? { verdict: 'approve', reason } : { verdict: 'veto', reason };
}
