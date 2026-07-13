/**
 * Wave 4 Stage 2 — per-item verification of fan-out worker OUTPUTS (anti-silent-
 * success). The #1 DREAM risk: a fan-out worker returns a confident, artifact-
 * shaped result that enters the parent's aggregate WHOLESALE just because it
 * doesn't start with "ERROR:" — a hollow / promise-shaped / blocked / off-objective
 * / unsupported-claim output slips the trust check.
 *
 * DESIGN (the affordable-at-scale one — a full cross-family judge per item × 100s
 * of workers is the trap that storms providers and blows the token/latency budget):
 *   1. REDUCE-TIME, not the hot fan-out return path — enumerate the ALREADY-DURABLE
 *      per-worker outputs (recordSubagentRun persisted them; NO re-run), so this is
 *      forward-only and never touches the working fan-out.
 *   2. DETERMINISTIC-FIRST tripwire (zero tokens) clears the clean majority.
 *   3. SUSPICION-GATING → only the flagged subset reaches a model.
 *   4. AMORTIZE — the flagged subset is judged in BATCHED cross-family calls
 *      (N verdicts per reply), so model-call cost is O(1) in N, not O(N).
 * A confirmed-fabricated item is recorded as a worker_result ok:false (keyed by the
 * SAME packetKey, last-outcome-wins), so Stage-1's summarizeFanoutCoverage already
 * surfaces it as an honest "M of N failed" — no new report-back plumbing.
 *
 * FAIL-OPEN + MONOTONIC: any tripwire/judge/enumeration hiccup passes items
 * through, so this can only convert a FALSE success into an honest failure — it
 * never wedges the working fan-out. Kill-switch CLEMMY_FANOUT_ITEM_VERIFY.
 *
 * SCOPE (honest): catches the HOLLOW / SHAPE-WRONG / OFF-OBJECTIVE / UNSUPPORTED
 * class. A fabrication that is internally consistent AND evidence-shaped but wrong
 * about the external world has no ground truth at reduce-time without redoing the
 * work — that is Design-3 sampled re-execution, deliberately out of Stage 2.
 */
import { appendEvent } from './eventlog.js';
import { listSubagentRuns, readSubagentOutput, type SubagentRunRecord } from '../../agents/subagent-runs.js';
import { isPromiseShapedReply, runHedgedJudge, clipForJudge, JUDGE_RESPONSE_MAX_CHARS } from './objective-judge.js';
import { matchesBlockedText } from './verify-delivered.js';
import { extractNumericClaims } from './output-grounding-gate.js';
import { getRuntimeEnv } from '../../config.js';

// Default ON — validated behavior is the default; `=off` is the kill-switch.
export function fanoutItemVerifyEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_FANOUT_ITEM_VERIFY', 'on') ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

// A figure-bearing output that cites NO evidence is a fabrication tell; an output
// with URLs / quoted values / tabular data / "source:" is presenting support.
const EVIDENCE_MARKER_RE = /https?:\/\/|www\.|\bsources?\b|according to|\bper the\b|```|\|\s*-{3,}|\brows?\s*\d|"[^"]{10,}"/i;

/**
 * Zero-LLM tripwire: is this OK-status worker output suspicious enough to spend a
 * (batched) judge on? High-precision by design — a genuine, evidence-bearing
 * result trips nothing, so a clean 100-worker batch pays ZERO judge calls. Pure.
 */
export function fanoutItemTripwire(output: string | null | undefined): { flagged: boolean; reason: string } {
  const t = (output ?? '').trim();
  if (t.length < 4) return { flagged: false, reason: '' }; // empty/near-empty is already ERROR-handled upstream
  if (matchesBlockedText(t)) return { flagged: true, reason: 'self-reported blocked / needs-input (slipped the ERROR: check)' };
  if (isPromiseShapedReply(t)) return { flagged: true, reason: 'promise-shaped (future-tense intent, no delivered artifact)' };
  if (extractNumericClaims(t).length > 0 && !EVIDENCE_MARKER_RE.test(t)) {
    return { flagged: true, reason: 'load-bearing figures asserted with no evidence markers' };
  }
  return { flagged: false, reason: '' };
}

export interface FanoutItemVerdict { fabricated: boolean; reason: string }

/**
 * Parse the batched judge reply: exactly `count` lines, "<n>: GENUINE" or
 * "<n>: FABRICATED: <reason>". Returns null unless every item got a verdict
 * (the caller fails OPEN on null — never marks an item failed on an unparseable
 * reply). Modeled on parseCriteriaVerdicts.
 */
export function parseFanoutVerdicts(finalOutput: unknown, count: number): FanoutItemVerdict[] | null {
  const raw = String(finalOutput ?? '').trim();
  if (!raw || count <= 0) return null;
  const verdicts = new Map<number, FanoutItemVerdict>();
  // Intra-line whitespace is [ \t]* (NOT \s*) so a reasonless marker line
  // ("2: GENUINE\n…") can't let \s* eat the newline and swallow the next line.
  const re = /^[ \t]*(\d{1,3})[ \t]*[:.)\-][ \t]*(GENUINE|FABRICATED|OK|BAD|PASS|FAIL)\b[ \t]*[:—–-]?[ \t]*(.*)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const idx = Number.parseInt(m[1], 10);
    if (idx < 1 || idx > count || verdicts.has(idx)) continue;
    const fabricated = /^(FABRICATED|BAD|FAIL)$/i.test(m[2]);
    verdicts.set(idx, { fabricated, reason: (m[3] || '').trim().slice(0, 200) });
  }
  if (verdicts.size !== count) return null;
  return Array.from({ length: count }, (_, i) => verdicts.get(i + 1) as FanoutItemVerdict);
}

const FANOUT_VERIFY_SYSTEM_PROMPT = [
  'You audit fan-out WORKER OUTPUTS for SILENT SUCCESS — an output that reads as done but is NOT a real completion of its item.',
  'For each numbered output, decide:',
  '- GENUINE: a substantive, on-objective completion of THAT item (a real result/artifact/answer for it).',
  '- FABRICATED: hollow or a future-tense promise ("I will…"), a blocked / needs-input / could-not-complete report, off-objective or generic filler unrelated to the item, or load-bearing claims asserted with no supporting basis in the output itself.',
  'You are NOT re-doing the work or fact-checking against the world — judge ONLY whether the text is a genuine self-contained completion vs a hollow/evasive/off-objective non-completion. When genuinely unsure, answer GENUINE (never fail a plausible real result).',
  'Reply with EXACTLY one line per output, in order: "<n>: GENUINE" or "<n>: FABRICATED: <short reason>". No other text.',
].join('\n');

const CHUNK = 20; // batched verdicts per judge call — keeps each reply parseable
const MAX_JUDGE_CALLS = 12; // hard ceiling (200-item fan-out cap ÷ CHUNK) — bounds spend

// Seam for tests: override the batched judge.
export type FanoutBatchJudgeFn = (objective: string, outputs: { item: string; output: string }[]) => Promise<(FanoutItemVerdict | null)[]>;
let batchJudgeForTests: FanoutBatchJudgeFn | null = null;
export function _setFanoutBatchJudgeForTests(fn: FanoutBatchJudgeFn | null): void { batchJudgeForTests = fn; }

/** ONE cross-family HEDGED judge call over a chunk of flagged outputs. */
async function judgeFanoutChunk(objective: string, outputs: { item: string; output: string }[]): Promise<(FanoutItemVerdict | null)[]> {
  if (batchJudgeForTests) return batchJudgeForTests(objective, outputs);
  const perItemBudget = Math.max(300, Math.floor(JUDGE_RESPONSE_MAX_CHARS / Math.max(1, outputs.length)));
  const prompt = [
    `OBJECTIVE (what the fan-out was for):\n${objective.trim().slice(0, 800)}`,
    '',
    'WORKER OUTPUTS to audit:',
    ...outputs.map((o, i) => `--- ${i + 1}. item="${o.item.slice(0, 120)}" ---\n${clipForJudge(o.output, perItemBudget).text}`),
    '',
    `Audit each and reply with exactly ${outputs.length} numbered lines as instructed.`,
  ].join('\n');
  const run = await runHedgedJudge(
    FANOUT_VERIFY_SYSTEM_PROMPT,
    prompt,
    (o) => parseFanoutVerdicts(o, outputs.length),
    (v) => v.every((x) => !x.fabricated),
    'completion',
  );
  // Fail OPEN: a null/timeout/unparseable judge yields all-null (no item marked failed).
  return run.value ?? outputs.map(() => null);
}

export interface FanoutFabrication { item: string; reason: string }

/**
 * Verify the OK-status worker outputs of a fan-out run and record each confirmed
 * fabrication as a worker_result ok:false (so honest coverage counts it failed).
 * Returns the confirmed fabrications. Best-effort / fail-open throughout.
 */
export async function verifyFanoutItems(runSessionId: string, objective: string): Promise<FanoutFabrication[]> {
  try {
    if (!fanoutItemVerifyEnabled() || !runSessionId || !objective.trim()) return [];
    // Enumerate the durable per-worker records; dedup by packetKey (a reused/
    // retried item collapses to its latest OK run — align with summarizeFanoutCoverage).
    const byKey = new Map<string, SubagentRunRecord>();
    for (const r of listSubagentRuns(runSessionId)) {
      if (r.status !== 'ok') continue;
      byKey.set(r.packetKey ? `pk:${r.packetKey}` : `it:${r.task}`, r);
    }
    if (byKey.size === 0) return [];

    // Zero-LLM tripwire → only the flagged subset is judged.
    const flagged: { run: SubagentRunRecord; output: string }[] = [];
    for (const run of byKey.values()) {
      const output = (run.outputRef ? readSubagentOutput(runSessionId, run.id) : null) ?? run.outputPreview ?? '';
      if (fanoutItemTripwire(output).flagged) flagged.push({ run, output });
    }
    if (flagged.length === 0) return []; // the clean-batch common case — ZERO model calls

    // Batched cross-family judge (chunked + bounded). Untested overflow beyond the
    // ceiling is left as-is (fail-open) — never silently marked failed.
    const fabricated: FanoutFabrication[] = [];
    const chunks = Math.min(MAX_JUDGE_CALLS, Math.ceil(flagged.length / CHUNK));
    for (let c = 0; c < chunks; c += 1) {
      const slice = flagged.slice(c * CHUNK, c * CHUNK + CHUNK);
      const verdicts = await judgeFanoutChunk(objective, slice.map((f) => ({ item: f.run.task, output: f.output })));
      slice.forEach((f, i) => {
        const v = verdicts[i];
        if (!v || !v.fabricated) return;
        // Record ok:false under the SAME packetKey → last-outcome-wins in
        // summarizeFanoutCoverage flips this item to failed.
        try {
          appendEvent({
            sessionId: runSessionId,
            turn: 0,
            role: 'system',
            type: 'worker_result',
            data: {
              item: f.run.task,
              ok: false,
              ...(f.run.packetKey ? { packetKey: f.run.packetKey } : {}),
              reason: `stage2-verify: ${v.reason || 'output not a genuine completion'}`.slice(0, 200),
              lane: 'stage2_verify',
            },
          });
        } catch { /* durable trace is best-effort */ }
        fabricated.push({ item: f.run.task, reason: v.reason });
      });
    }
    return fabricated;
  } catch {
    return []; // fail-open — a verify hiccup never blocks a run
  }
}
