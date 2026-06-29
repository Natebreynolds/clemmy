/**
 * Output-grounding gate — NUMERIC integrity at the deliverable boundary.
 *
 * The existing grounding gate (grounding-gate.ts) verifies a write's payload
 * against the session's source artifacts for the write's TARGET (recipient
 * identity, city, name) — born from the Eley Houston→Denver mutation. It does
 * NOT check the FIGURES in a deliverable. A report that says "ad spend was
 * $24.5K and traffic rose 18%" sails through every gate today, because gates
 * fire on the SAFETY of an action (right recipient, approved batch), not on the
 * CONTENT QUALITY of what's delivered. For an agent meant to do a data-analysis
 * JOB unsupervised, a fabricated or mis-derived number is the trust-killer.
 *
 * This gate is grounding's sibling: before a deliverable is committed — a chat-
 * delivered report (loop.ts completion path) OR an irreversible-write payload
 * (brackets.ts send/publish path) — every LOAD-BEARING FIGURE must trace to a
 * real tool result captured THIS session, or the deliverable bounces/flags.
 *
 * Three layers, determinism-first:
 *   1. extractNumericClaims — pure regex pulls load-bearing figures (currency,
 *      percent, count, multiple, duration); filters years/versions/IDs/code.
 *   2. deterministicallyVerify — pure: clears any figure that appears verbatim,
 *      or is derivable by rounding (6460.78→6,461), scaling (12000↔"12K"), or
 *      unit (0.18↔18%). ZERO LLM cost; if every figure clears here, NO judge
 *      call. Aggregation (a total summed from rows) is left to layer 3 — summing
 *      a mixed excerpt deterministically over-matches; the judge is precise.
 *   3. cross-family judge (resolveBoundaryJudge) — only the residual figures,
 *      for the irreducibly-fuzzy "is this derivable (incl. aggregated) from the
 *      sources" call.
 *
 * Posture (north-star: inform, rarely block): a figure that CONTRADICTS a
 * source no rounding reconciles → BOUNCE (the high-precision, trust-killer
 * signal); a load-bearing figure with NO plausible source → ADVISORY (could be
 * a legit derived figure the judge couldn't trace — informing beats a
 * false-positive bounce on legitimately-derived numbers). Fail-open at every
 * step: no figures / no sources / judge error → allow.
 *
 * Env: CLEMMY_OUTPUT_GROUNDING_GATE=off disables; =on (default) gates.
 * DELETE-WHEN-VALIDATED: fold in unconditionally once (a) ≥2 live sessions show
 * a fabricated/contradicted figure bounced and corrected, AND (b) two releases
 * pass with zero false-positive bounces on legitimately derived/rounded/
 * aggregated figures (track output_grounding_judged advisory vs. confirmed
 * false-positive bounces). Until then `=off` is the kill-switch.
 */
import { getRuntimeEnv } from '../../config.js';
import { searchToolOutputs, recentToolOutputs } from './eventlog.js';
import { rankSources, type GroundingSource } from './grounding-gate.js';

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────

export function isOutputGroundingGateEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_OUTPUT_GROUNDING_GATE', 'on') ?? 'on').toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

// ─────────────────────────────────────────────────────────────────
// Numeric-claim extraction (pure, deterministic — no LLM)
// ─────────────────────────────────────────────────────────────────

export type NumericUnit = 'currency' | 'percent' | 'count' | 'multiple' | 'duration' | 'other';

export interface NumericClaim {
  /** The figure as written, e.g. "$24.5K", "18%", "50 contacts". */
  raw: string;
  /** Normalized numeric value (commas stripped, K/M/B applied). */
  value: number;
  unit: NumericUnit;
  /** ±~60-char window around the figure — for the judge + retrieval labels. */
  context: string;
  /** Alphabetic tokens (len≥3) from the context — the SOURCE-RETRIEVAL keys. */
  labels: string[];
}

const MAX_CLAIMS = 40;
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9, mn: 1e6 };
const DURATION_RE = /^(days?|hours?|hrs?|mins?|minutes?|weeks?|months?|years?|yrs?|seconds?|secs?)$/i;
const COUNT_NOUN_RE = /^[A-Za-z][A-Za-z-]{2,}s?$/; // a plural-ish noun following a bare integer
const LABEL_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'was', 'were', 'are', 'this', 'that', 'from', 'about',
  'have', 'has', 'had', 'over', 'into', 'than', 'then', 'they', 'them', 'their', 'our',
  'you', 'your', 'per', 'out', 'all', 'now', 'but', 'not', 'his', 'her', 'its',
]);

/** Char ranges occupied by fenced/inline code — figures inside are not claims. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /```[\s\S]*?```|`[^`\n]*`/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
function inRanges(idx: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([a, b]) => idx >= a && idx < b);
}

// A figure: optional currency prefix, a digit core (with comma groups + decimals),
// optional scale/percent/x suffix. The trailing `(?![A-Za-z])` forces the suffix
// to a word boundary so "7 months" is not read as "7M" (7,000,000) and "5 boxes"
// is not "5B" — the K/M/B/x letters only count when not glued to a word. The
// engine backtracks `\s?`/the suffix to land on the bare number in those cases.
// Classification + further noise-filtering happen after.
const FIGURE_RE =
  /([$€£])?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(%|percent|pp|bn|mn|[KMBkmb]|x)?(?![A-Za-z])/g;

function extractLabels(context: string): string[] {
  const out: string[] = [];
  for (const w of context.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []) {
    if (LABEL_STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Pull load-bearing figures from a deliverable. Pure. Conservative: a bare
 * small integer with no unit/currency is NOT a claim (list noise); years,
 * version strings, ordinals, IDs and code-fenced numbers are dropped.
 */
export function extractNumericClaims(text: string): NumericClaim[] {
  if (!text || typeof text !== 'string') return [];
  const codes = codeRanges(text);
  const claims: NumericClaim[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  FIGURE_RE.lastIndex = 0;
  while ((m = FIGURE_RE.exec(text))) {
    const [whole, cur, digits, suf] = m;
    if (!digits) continue;
    const start = m.index + (whole.length - whole.trimStart().length);
    if (inRanges(start, codes)) continue;

    const before = text.slice(Math.max(0, start - 16), start);
    const after = text.slice(start + whole.trimStart().length, start + whole.trimStart().length + 16);

    // ── noise filters ───────────────────────────────────────────
    // URL / path-embedded number.
    if (/[/=?&#]\s*$/.test(before) || /https?:\/\/\S*$/.test(before)) continue;
    // Version string (v1.2, 0.5.20, or "version 3").
    if (/[vV]\.?\s*$/.test(before) || /version\s*$/i.test(before)) continue;
    if (/^\.\d/.test(after) && /\.\d/.test(digits)) continue; // x.y.z chain (head)
    if (/\d\.$/.test(before)) continue; // tail of a dotted version/sequence (the "20" in 0.5.20)
    // Ordinal (1st, 3rd).
    if (/^(st|nd|rd|th)\b/i.test(after)) continue;
    // List enumerator ("1." / "2)") at a line start.
    if (/(^|\n)\s*$/.test(before) && /^[.)]\s/.test(after) && !cur && !suf) continue;

    const hasComma = digits.includes(',');
    const core = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(core)) continue;

    // Classify.
    let unit: NumericUnit = 'other';
    let value = core;
    const sufLow = (suf ?? '').toLowerCase();
    const trailingWord = (after.match(/^\s*([A-Za-z][A-Za-z-]+)/)?.[1] ?? '');
    if (cur || /\b(USD|EUR|GBP|dollars?|usd)\s*$/i.test(before)) {
      unit = 'currency';
      if (sufLow && SCALE[sufLow]) value = core * SCALE[sufLow];
    } else if (sufLow === '%' || sufLow === 'percent' || sufLow === 'pp') {
      unit = 'percent';
    } else if (sufLow === 'x') {
      unit = 'multiple';
    } else if (sufLow && SCALE[sufLow]) {
      unit = 'count';
      value = core * SCALE[sufLow];
    } else if (DURATION_RE.test(trailingWord)) {
      unit = 'duration';
    } else if (
      trailingWord && COUNT_NOUN_RE.test(trailingWord)
      // A bare integer is a COUNT only with a genuine quantity noun: a plural
      // ("50 sessions", "17 emails", "3 deals") OR a big/grouped number. This
      // rejects "step 2 done" / "pick 5 things" noise where the trailing word
      // is an adjective/verb, not a counted unit.
      && (/s$/i.test(trailingWord) || hasComma || sufLow !== '' || core > 10)
    ) {
      unit = 'count';
    } else {
      // Bare number. Drop years and small unlabeled integers (list noise).
      const isYear = /^(19|20)\d{2}$/.test(digits) && !hasComma;
      if (isYear) continue;
      if (!hasComma && !digits.includes('.') && core <= 10) continue;
      unit = 'other';
    }

    const raw = whole.trim();
    const key = `${unit}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const context = text.slice(Math.max(0, start - 60), start + whole.trimStart().length + 60).replace(/\s+/g, ' ').trim();
    claims.push({ raw, value, unit, context, labels: extractLabels(context) });
    if (claims.length >= MAX_CLAIMS) break;
  }
  return claims;
}

// ─────────────────────────────────────────────────────────────────
// Deterministic verification (pure — rounding / scaling / aggregation)
// ─────────────────────────────────────────────────────────────────

/** Pull normalized numbers from arbitrary source text (commas + K/M/B scaling). */
export function extractNumbersFromText(text: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?([KMBkmb]|bn|mn)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const s = (m[2] ?? '').toLowerCase();
    out.push(s && SCALE[s] ? n * SCALE[s] : n);
  }
  return out;
}

/** True if `claim` is the same quantity as `src` up to rounding / unit scaling.
 *  Scale-aware tolerance: ≥1 values get a rounding floor (0.5) + 1% precision;
 *  sub-1 fractions get a tight relative band so a percent stored as a fraction
 *  (0.18) doesn't loosely match any small source number. */
function valueMatches(claim: NumericClaim, src: number): boolean {
  const tol = (v: number) => {
    const a = Math.abs(v);
    return a >= 1 ? Math.max(0.5, a * 0.01) : a * 0.02 + 1e-6;
  };
  // Candidate representations of the claimed value (percent may be stored as a fraction).
  const candidates = claim.unit === 'percent' ? [claim.value, claim.value / 100, claim.value * 100] : [claim.value];
  return candidates.some((c) => Math.abs(c - src) <= tol(Math.max(Math.abs(c), Math.abs(src))));
}

export interface DeterministicResult { verified: NumericClaim[]; residual: NumericClaim[] }

/**
 * Split claims into those provably derivable from the sources (the figure
 * appears verbatim, or matches a source number up to rounding / unit scaling)
 * and the residual that needs the judge. Pure. AGGREGATION (a total derived by
 * summing rows) is deliberately left to the judge — deterministically summing a
 * mixed excerpt's numbers over-matches (it would sum unrelated metrics), so the
 * judge (which sees the rows) is the precise arbiter. Erring toward "residual"
 * only costs a judge call; never toward a false bounce.
 */
export function deterministicallyVerify(claims: NumericClaim[], sources: GroundingSource[]): DeterministicResult {
  const verified: NumericClaim[] = [];
  const residual: NumericClaim[] = [];
  const allText = sources.map((s) => s.excerpt).join('\n');
  const allNumbers = extractNumbersFromText(allText);
  const normalizedText = allText.replace(/,/g, '');
  for (const claim of claims) {
    const rawDigits = claim.raw.replace(/[^0-9.]/g, '');
    const verbatim = rawDigits.length >= 3 && normalizedText.includes(rawDigits);
    const direct = allNumbers.some((n) => valueMatches(claim, n));
    if (verbatim || direct) verified.push(claim);
    else residual.push(claim);
  }
  return { verified, residual };
}

// ─────────────────────────────────────────────────────────────────
// Judge (only the residual claims) — cross-family, fail-open
// ─────────────────────────────────────────────────────────────────

export type OutputGroundingRollup = 'grounded' | 'contradicted' | 'unverifiable';

export interface OutputGroundingVerdict {
  verdict: OutputGroundingRollup;
  offending: Array<{ figure: string; kind: 'contradicted' | 'no_source'; note: string }>;
  reason: string;
}

export type OutputGroundingJudgeFn = (claims: NumericClaim[], sources: GroundingSource[]) => Promise<OutputGroundingVerdict>;

let judgeOverride: OutputGroundingJudgeFn | null = null;
export function _setOutputGroundingJudgeForTests(fn: OutputGroundingJudgeFn | null): void { judgeOverride = fn; }

export function buildOutputGroundingPrompt(claims: NumericClaim[], sources: GroundingSource[]): string {
  return [
    'You are a NUMERIC INTEGRITY judge. An agent is about to DELIVER a report/message to a user.',
    "Verify every LOAD-BEARING FIGURE listed below traces to the agent's own captured tool results from THIS session.",
    '',
    'CRITICAL — numbers are usually DERIVED, not copied verbatim. Treat a figure as GROUNDED when it is plausibly derivable from the sources by:',
    '  • rounding (raw 6460.78 reported as 6,461 — grounded)',
    '  • aggregation (a reported total ≈ the sum of source rows)',
    '  • unit conversion / scaling (12,000 → "12K"; 0.18 → "18%")',
    '  • simple arithmetic between source values (difference, ratio, growth %)',
    'Do NOT require the digits to appear verbatim.',
    '',
    'Mark a figure CONTRADICTED only when a source gives a DIFFERENT value for the same quantity that no rounding/aggregation reconciles (e.g. the report says "$24.5K spend" but the spend rows sum to $11K).',
    'Mark a figure NO_SOURCE only when NOTHING in the sources could plausibly produce it (a number invented out of thin air).',
    'If the sources are silent or ambiguous about a figure but it is internally plausible → treat it as grounded (FAIL OPEN). When in doubt, grounded.',
    '',
    "Roll up: verdict='contradicted' if ANY figure is contradicted; else 'unverifiable' if a load-bearing figure has NO plausible source; else 'grounded'.",
    '',
    '=== FIGURES TO VERIFY ===',
    ...claims.map((c) => `- ${c.raw} (${c.unit}) — context: ${c.context}`),
    '',
    '=== SOURCE TOOL RESULTS (this session; research before confirmations) ===',
    ...sources.map((s) => `--- ${s.callId} (${s.tool ?? 'unknown'}, ${s.createdAt}) ---\n${s.excerpt}`),
    '',
    'Respond with the structured verdict.',
  ].join('\n');
}

async function runOutputGroundingJudge(claims: NumericClaim[], sources: GroundingSource[]): Promise<OutputGroundingVerdict> {
  const [{ Agent, Runner }, { z }, { MODELS }, { normalizeZodForCodexStrict }, { resolveBoundaryJudge }, { withJudgeTimeout, recordJudgeMetric }] = await Promise.all([
    import('@openai/agents'),
    import('zod'),
    import('../../config.js'),
    import('../schema-normalizer.js'),
    import('./debate-model.js'),
    import('./judge-family.js'),
  ]);
  const VerdictSchema = z.object({
    verdict: z.enum(['grounded', 'contradicted', 'unverifiable']).describe("'contradicted' if any figure conflicts with a source; 'unverifiable' if a load-bearing figure has no plausible source; else 'grounded'."),
    offending: z.array(z.object({
      figure: z.string().describe('The figure as written, e.g. "$24.5K".'),
      kind: z.enum(['contradicted', 'no_source']),
      note: z.string().describe('One short phrase: the conflicting source value, or why no source.'),
    })).describe('Only the figures that failed; empty when grounded.'),
    reason: z.string().describe('One short sentence: the contradiction found, or why the figures are consistent.'),
  });
  const routing = resolveBoundaryJudge();
  const agent = new Agent({
    name: 'OutputGroundingJudge',
    instructions: "Verify a deliverable's numeric claims against the session's own captured tool results. Accept derived/rounded/aggregated figures. Output only the structured verdict.",
    model: routing.model ?? MODELS.fast,
    modelSettings: { reasoning: { effort: 'low' } },
    outputType: normalizeZodForCodexStrict(VerdictSchema) as typeof VerdictSchema,
    tools: [],
  });
  const runner = new Runner({ workflowName: 'clementine-output-grounding-judge' });
  const startedAt = Date.now();
  let recorded = false;
  const record = (outcome: 'passed' | 'blocked' | 'advisory' | 'timeout' | 'invalid' | 'error') => {
    recorded = true;
    recordJudgeMetric({
      lane: 'output_grounding',
      outcome,
      durationMs: Date.now() - startedAt,
      modelId: routing.modelId,
      judgeFamily: routing.judgeFamily,
      brainFamily: routing.brainFamily,
      selfJudge: routing.selfJudge,
    });
  };
  try {
    const result = await withJudgeTimeout(runner.run(agent, buildOutputGroundingPrompt(claims, sources), { maxTurns: 1 }));
    if (!result) {
      record('timeout');
      throw new Error('output-grounding judge timed out');
    }
    const parsed = VerdictSchema.safeParse(result.finalOutput);
    if (!parsed.success) {
      record('invalid');
      throw new Error('output-grounding judge output did not parse');
    }
    record(parsed.data.verdict === 'grounded' ? 'passed' : (parsed.data.verdict === 'unverifiable' ? 'advisory' : 'blocked'));
    return parsed.data;
  } catch (err) {
    if (!recorded) record('error');
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────
// Gate evaluation
// ─────────────────────────────────────────────────────────────────

/** Per-(session,figure) consecutive bounces — after 2, the message escalates
 *  to "stop and ask the user". In-memory; a restart only makes it gentler. */
const failureCounts = new Map<string, number>();
export function _resetOutputGroundingStateForTests(): void { failureCounts.clear(); }

export interface OutputGroundingGateResult {
  action: 'allow' | 'bounce' | 'advisory';
  reason: string;
  /** Offending figures (telemetry / recovery message). */
  figures: string[];
  /** Source call ids consulted (telemetry). */
  sourceCallIds: string[];
  /** Consecutive bounces for the first offending figure including this one. */
  failureCount?: number;
  /** Set ONLY when evaluated with { deferCommit: true } (the parallel pre-write
   *  path): persists the bounce increment. The caller invokes it exactly when it
   *  surfaces this bounce — so an eagerly-started verdict discarded because an
   *  earlier gate short-circuited never bumps the counter (integrity audit #2.4).
   *  Undefined on the inline path (already committed). */
  commitFailure?: () => void;
}

/**
 * Evaluate numeric grounding for a deliverable. Fail-open at every step:
 * no claims / no sources / all-deterministically-verified / judge error → allow.
 */
export async function evaluateOutputGrounding(
  sessionId: string,
  deliverableText: string,
  _opts: { kind?: 'chat' | 'write'; toolName?: string; deferCommit?: boolean } = {},
): Promise<OutputGroundingGateResult> {
  const deferCommit = _opts.deferCommit === true;
  const claims = extractNumericClaims(deliverableText);
  if (claims.length === 0) {
    return { action: 'allow', reason: 'no load-bearing figures in the deliverable', figures: [], sourceCallIds: [] };
  }
  // Retrieve sources by the figures' LABEL tokens (numbers themselves can't be
  // searched: searchToolOutputs drops <3-char terms and LIKE over-matches).
  let sources: GroundingSource[] = [];
  try {
    const labelTerms = [...new Set(claims.flatMap((c) => c.labels))].slice(0, 24);
    const byLabel = labelTerms.length > 0 ? searchToolOutputs(sessionId, labelTerms, { limit: 12 }) : [];
    // A figure often derives from a row whose vocabulary differs from the
    // report's wording — also look at the most recent captured data.
    const merged = new Map<string, { callId: string; tool: string | null; output: string; createdAt: string }>();
    for (const r of byLabel) merged.set(r.callId, r);
    if (merged.size < 2) for (const r of recentToolOutputs(sessionId, { limit: 8 })) merged.set(r.callId, r);
    sources = rankSources([...merged.values()], { limit: 8 });
  } catch {
    return { action: 'allow', reason: 'source retrieval failed — fail open', figures: [], sourceCallIds: [] };
  }
  if (sources.length === 0) {
    return { action: 'allow', reason: 'no captured tool results to verify figures against', figures: [], sourceCallIds: [] };
  }
  // Deterministic pre-pass: clear verbatim/rounded/scaled/aggregated figures.
  const { residual } = deterministicallyVerify(claims, sources);
  const sourceCallIds = sources.map((s) => s.callId);
  if (residual.length === 0) {
    return { action: 'allow', reason: 'every figure traces to captured tool results (deterministic)', figures: [], sourceCallIds };
  }
  let verdict: OutputGroundingVerdict;
  try {
    verdict = await (judgeOverride ?? runOutputGroundingJudge)(residual, sources);
  } catch {
    return { action: 'allow', reason: 'output-grounding judge unavailable — fail open', figures: [], sourceCallIds };
  }
  if (verdict.verdict === 'grounded') {
    return { action: 'allow', reason: verdict.reason, figures: [], sourceCallIds };
  }
  const figures = (verdict.offending ?? []).map((o) => o.figure).filter(Boolean);
  if (verdict.verdict === 'unverifiable') {
    // No plausible source — could be a legit derived figure the judge couldn't
    // trace. INFORM, don't wedge (avoids false-positives on derived numbers).
    return { action: 'advisory', reason: verdict.reason, figures, sourceCallIds };
  }
  // Contradicted — the trust-killer. Bounce + escalate on repeat.
  const figKey = `${sessionId}::${figures[0] ?? 'deliverable'}`;
  // Deferred-commit (integrity audit #2.4): on the parallel eager-start path do
  // NOT persist the increment here — return a commitFailure thunk the caller runs
  // only if it actually surfaces this bounce. Inline path commits now (identical).
  const failures = (failureCounts.get(figKey) ?? 0) + 1;
  if (!deferCommit) {
    failureCounts.set(figKey, failures);
    return { action: 'bounce', reason: verdict.reason, figures, sourceCallIds, failureCount: failures };
  }
  return { action: 'bounce', reason: verdict.reason, figures, sourceCallIds, failureCount: failures, commitFailure: () => failureCounts.set(figKey, failures) };
}

/**
 * Thrown for a numeric contradiction at the irreversible-write boundary.
 * Surfaced to the model as a SOFT tool error (same path as
 * GroundingCheckFailedError) so it recovers — recompute the figure from the
 * verbatim source — instead of the run aborting. Escalates after repeats.
 */
export class OutputGroundingCheckFailedError extends Error {
  public readonly toolName: string;
  public readonly figures: string[];
  public readonly failureCount: number;
  constructor(opts: { toolName: string; reason: string; figures: string[]; sourceCallIds: string[]; failureCount: number }) {
    const escalate = opts.failureCount >= 2;
    const figs = opts.figures.length ? opts.figures.slice(0, 4).join(', ') : 'a figure';
    super(
      `OUTPUT_GROUNDING_CHECK_FAILED: ${figs} in this ${opts.toolName} deliverable contradicts your own captured tool results. ` +
        `Judge: ${opts.reason} ` +
        `Sources consulted: ${opts.sourceCallIds.slice(0, 4).join(', ')}. ` +
        (escalate
          ? 'This figure has now failed repeatedly — STOP. Do NOT retry. Use ask_user_question to show the user the discrepancy and let them decide.'
          : 'Recover: recall_tool_result the source rows above and RECOMPUTE the figure from the VERBATIM data — do not retype from memory — then correct or cite it. If the sources themselves conflict, reconcile or ask the user before delivering.'),
    );
    this.name = 'OutputGroundingCheckFailedError';
    this.toolName = opts.toolName;
    this.figures = opts.figures;
    this.failureCount = opts.failureCount;
  }
}

/** Recovery instruction injected on the CHAT path (no throw — the loop just
 *  continues with this as the next input, like the objective-judge bounce). */
export function buildOutputGroundingChatRetry(result: OutputGroundingGateResult): string {
  const figs = result.figures.length ? result.figures.slice(0, 4).join(', ') : 'a figure';
  const escalate = (result.failureCount ?? 1) >= 2;
  return (
    `Before you deliver this: ${figs} in your report does not match your own captured tool results. ` +
    `${result.reason} ` +
    (escalate
      ? 'You have tried to correct this repeatedly — STOP and use ask_user_question to show the user the discrepancy.'
      : 'recall_tool_result the source data and RECOMPUTE the figure from the verbatim values — do not retype from memory — then re-state the report with the corrected figure.')
  );
}
