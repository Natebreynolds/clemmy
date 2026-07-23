/**
 * Stall judge — ONE cross-family judge question replacing the verb-regex
 * rabbit hole (Nathan, 2026-07-24: "all these one off verbs trying to match
 * in the code" — every live incident added a pattern, then a suppressor,
 * then a suppressor on the suppressor).
 *
 * Scope: fires ONLY in the ambiguous slot — a zero-tool text turn whose
 * decision did not parse and whose text is NOT a deterministically-detected
 * bad shape (fake tool transcript, tool-unavailable lie, false action claim;
 * those anchor on harness-owned facts and stay deterministic in
 * turn-decision.ts). In that slot the regexes are demoted from verdict to
 * trigger: they still decide WHEN to ask, the judge decides WHAT it was.
 *
 * Direction of authority: the judge can only override toward DELIVERY (the
 * text was a real reply — hand it to the user). On 'stall' or any judge
 * failure the existing machinery proceeds unchanged — whose terminal is now
 * the recovery-summary turn + human floor (v2.5.6), never a meta-banner. So
 * a judge outage degrades to exactly the pre-judge behavior.
 *
 * Kill-switch: CLEMMY_STALL_JUDGE=off restores pure-deterministic behavior.
 */
import { getRuntimeEnv } from '../../config.js';

export type StallJudgeVerdict = 'deliver' | 'stall' | 'unavailable';

export type StallJudgeFn = (opts: { userInput: string; replyText: string }) => Promise<StallJudgeVerdict>;

let stallJudgeForTests: StallJudgeFn | null = null;
export function _setStallJudgeForTests(fn: StallJudgeFn | null): void {
  stallJudgeForTests = fn;
}

export function stallJudgeEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_STALL_JUDGE', 'on') ?? 'on').toLowerCase() !== 'off';
}

const INSTRUCTIONS = [
  'You are a strict referee for a single assistant chat turn.',
  'You will see the user\'s message and the assistant\'s reply. The assistant made ZERO tool calls this turn.',
  'Decide which one this reply is:',
  '- "reply": a complete conversational response the user should read now. This includes answers, acknowledgments, plans presented for discussion, questions back to the user, requests for material only the user can provide, and content presented for review.',
  '- "punt": the assistant announced, promised, or claimed tool work it should have performed itself THIS turn, and produced nothing the user can act on.',
  'The bar for "punt" is high: if a reasonable person would read the text as the assistant talking WITH them rather than stalling, it is a "reply".',
  'Answer with STRICT JSON only: {"verdict":"reply"} or {"verdict":"punt"}. No other text.',
].join('\n');

function parseVerdict(finalOutput: unknown): 'reply' | 'punt' | null {
  if (typeof finalOutput !== 'string') return null;
  const match = finalOutput.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { verdict?: unknown };
    return parsed.verdict === 'reply' || parsed.verdict === 'punt' ? parsed.verdict : null;
  } catch {
    return null;
  }
}

/** Ask the boundary judge whether an ambiguous zero-tool text turn is a real
 *  reply. Never throws; every failure shape returns 'unavailable'. */
export async function judgeAmbiguousStallReply(opts: { userInput: string; replyText: string }): Promise<StallJudgeVerdict> {
  if (!stallJudgeEnabled()) return 'unavailable';
  if (stallJudgeForTests) {
    try {
      return await stallJudgeForTests(opts);
    } catch {
      return 'unavailable';
    }
  }
  try {
    const { runHedgedJudge, clipForJudge } = await import('./objective-judge.js');
    const prompt = [
      `USER MESSAGE:\n${clipForJudge(opts.userInput, 1_500).text}`,
      '',
      `ASSISTANT REPLY (zero tool calls):\n${clipForJudge(opts.replyText, 4_000).text}`,
    ].join('\n');
    const run = await runHedgedJudge<'reply' | 'punt'>(
      INSTRUCTIONS,
      prompt,
      parseVerdict,
      (v) => v === 'reply',
      'completion',
    );
    if (run.value === null) return 'unavailable';
    return run.value === 'reply' ? 'deliver' : 'stall';
  } catch {
    return 'unavailable';
  }
}

/** The ambiguous slot: A_zero_tools stalls with no deterministic-bad marker.
 *  Detected-bad shapes carry a `kind` (tool_unavailable_self_report,
 *  structured_* …) or the fakeToolTranscript flag; the announcement and
 *  short-generic branches — the prose-shape guesses — carry neither. */
export function stallIsJudgeAmbiguous(stallInfo: { signal: string; detail?: Record<string, unknown> }): boolean {
  if (stallInfo.signal !== 'A_zero_tools') return false;
  const detail = stallInfo.detail ?? {};
  if (typeof detail.kind === 'string' && detail.kind.length > 0) return false;
  if (detail.fakeToolTranscript === true) return false;
  return true;
}
