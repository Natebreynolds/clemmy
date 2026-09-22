/**
 * A reviewer's change request is only honoured when the revised output
 * actually applies it. Live 2026-09-22: the note asked for one added
 * sentence in one email and nothing else changed; the revised draft dropped
 * the sentence and rewrote the subject, and the gate asked again as if the
 * note had been applied. The host now asks Jev, before re-asking the human,
 * whether the revision applies the note and leaves the rest alone.
 *
 * Jev first (fast, cheap); no Jev, a slow answer or a low-confidence one is
 * "unverified", never "applied": the card then says so.
 */
import { evaluateSystemOne } from '../runtime/jev/client.js';
import type { ChoiceAnswer, SystemOneQuestions } from '../runtime/jev/system-one.js';
import { recordJudgeMetric } from '../runtime/harness/judge-family.js';

export const REVISION_JUDGE_TIMEOUT_MS = 4_000;
export const REVISION_JUDGE_CONFIDENCE_MIN = 0.6;
const MAX_TEXT_CHARS = 6_000;

export interface RevisionVerdict {
  verdict: 'applied' | 'not_applied' | 'unverified';
  confidence?: number;
  reason: string;
  judge: 'jev' | 'model' | 'none';
  modelId?: string;
  durationMs: number;
}

/** Parse the backstop judge's one-line verdict; anything else is unverified. */
export function parseRevisionModelVerdict(raw: string): { verdict: 'applied' | 'not_applied' | 'unverified'; reason: string } {
  const text = (raw ?? '').trim();
  const match = /^\s*(APPLIED|NOT_APPLIED)\s*:?\s*(.*)$/im.exec(text);
  if (!match) return { verdict: 'unverified', reason: text ? `no APPLIED/NOT_APPLIED verdict (got: ${text.slice(0, 120)})` : 'judge timeout' };
  const reason = (match[2] || '').trim().slice(0, 400) || (match[1] === 'APPLIED' ? 'the revised draft applies the change request' : 'the revised draft does not apply the change request as written');
  return { verdict: match[1].toUpperCase() === 'APPLIED' ? 'applied' : 'not_applied', reason };
}

/** The judge model backstops Jev: when the fast judge is absent, slow or
 *  unsure, the configured judge answers the same question in one line. */
export async function judgeRevisionWithModel(input: {
  note: string;
  previous?: string;
  revised: unknown;
}): Promise<{ verdict: 'applied' | 'not_applied' | 'unverified'; reason: string; modelId?: string }> {
  try {
    const { Agent, run } = await import('@openai/agents');
    const { resolveRoleModel } = await import('../runtime/harness/model-roles.js');
    const { withJudgeTimeout } = await import('../runtime/harness/judge-family.js');
    const judge = resolveRoleModel('judge');
    if (!judge?.modelId) return { verdict: 'unverified', reason: 'no judge model bound' };
    const agent = new Agent({
      name: 'RevisionJudge',
      instructions: [
        'A reviewer declined a draft and wrote a change request. The author produced a revised draft.',
        'Decide whether the revised draft APPLIES the change request: everything the reviewer asked for is present, and what the reviewer did not mention was left as it was.',
        'A revision that adds what was asked but also rewrites unrelated parts is NOT applied. A revision that leaves the request out is NOT applied.',
        'Reply with EXACTLY ONE LINE: "APPLIED: <one-sentence reason>" or "NOT_APPLIED: <one-sentence reason>".',
      ].join('\n'),
      model: judge.modelId,
      modelSettings: { reasoning: { effort: 'low' } },
      tools: [],
    });
    const prompt = [
      `Change request: ${input.note}`,
      ...(input.previous ? [`Previous draft:\n${clip(input.previous)}`] : []),
      `Revised draft:\n${clip(renderRevisionText(input.revised))}`,
    ].join('\n\n');
    const result = await withJudgeTimeout(run(agent, prompt));
    const parsed = parseRevisionModelVerdict(String((result as { finalOutput?: unknown } | undefined)?.finalOutput ?? ''));
    return { ...parsed, modelId: judge.modelId };
  } catch (error) {
    return { verdict: 'unverified', reason: error instanceof Error ? error.message : String(error) };
  }
}

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

export function renderRevisionText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}

export async function judgeRevisionApplied(input: {
  note: string;
  previous?: string;
  revised: unknown;
  sessionId?: string;
  evaluate?: typeof evaluateSystemOne;
  /** Test seam for the judge-model backstop. */
  modelJudge?: typeof judgeRevisionWithModel;
}): Promise<RevisionVerdict> {
  const fast = await judgeRevisionWithJev(input);
  if (fast.verdict !== 'unverified') return fast;
  const started = Date.now();
  const backstop = await (input.modelJudge ?? judgeRevisionWithModel)({ note: input.note, previous: input.previous, revised: input.revised });
  const durationMs = fast.durationMs + (Date.now() - started);
  if (backstop.verdict === 'unverified') {
    return { ...fast, reason: `${fast.reason}; the judge model could not decide either (${backstop.reason})`, durationMs };
  }
  try { recordJudgeMetric({ lane: 'revision', outcome: backstop.verdict === 'applied' ? 'passed' : 'blocked', durationMs: Date.now() - started, modelId: backstop.modelId }); } catch { /* metrics never block */ }
  return { verdict: backstop.verdict, reason: backstop.reason, judge: 'model', ...(backstop.modelId ? { modelId: backstop.modelId } : {}), durationMs };
}

async function judgeRevisionWithJev(input: {
  note: string;
  previous?: string;
  revised: unknown;
  sessionId?: string;
  evaluate?: typeof evaluateSystemOne;
}): Promise<RevisionVerdict> {
  const questions: SystemOneQuestions = {
    verdict: {
      type: 'choice',
      instructions: [
        'A reviewer declined a draft and wrote a change request. The author produced a revised draft.',
        'Decide whether the revised draft APPLIES the change request: everything the reviewer asked for is present, and what the reviewer did not mention was left as it was.',
        'A revision that adds what was asked but also rewrites unrelated parts is NOT applied. A revision that leaves the request out is NOT applied.',
      ].join(' '),
      criteria: {
        applied: 'The revised draft contains every change the reviewer asked for and changes nothing the reviewer did not ask about.',
        not_applied: 'The revised draft misses part of the request, or changes things the reviewer did not ask to change.',
      },
    },
  };
  const started = Date.now();
  const evaluate = input.evaluate ?? evaluateSystemOne;
  try {
    const result = await evaluate({
      state: {
        changeRequest: input.note,
        ...(input.previous ? { previousDraft: clip(input.previous) } : {}),
        revisedDraft: clip(renderRevisionText(input.revised)),
      },
      questions,
      timeoutMs: REVISION_JUDGE_TIMEOUT_MS,
      sessionId: input.sessionId,
      channel: 'jev-revision',
    });
    const durationMs = Date.now() - started;
    if (!result.ok) return { verdict: 'unverified', reason: 'the fast judge was unavailable', judge: 'none', durationMs };
    const answer = result.answers.verdict as ChoiceAnswer | undefined;
    if (!answer || answer.confidence < REVISION_JUDGE_CONFIDENCE_MIN) {
      return { verdict: 'unverified', confidence: answer?.confidence, reason: 'the fast judge was not sure', judge: 'jev', durationMs };
    }
    const applied = answer.choice === 'applied';
    try { recordJudgeMetric({ lane: 'revision', outcome: applied ? 'passed' : 'blocked', durationMs, modelId: 'jev', fast: true }); } catch { /* metrics never block */ }
    return {
      verdict: applied ? 'applied' : 'not_applied',
      confidence: answer.confidence,
      reason: applied ? 'the revised draft applies the change request' : 'the revised draft does not apply the change request as written',
      judge: 'jev',
      durationMs,
    };
  } catch (error) {
    return { verdict: 'unverified', reason: error instanceof Error ? error.message : String(error), judge: 'none', durationMs: Date.now() - started };
  }
}
