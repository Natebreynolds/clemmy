/**
 * What the brain was told from memory this turn, kept for the checks.
 *
 * The per-turn MEMORY PRIMER reaches the model that does the work; until
 * 2026-09-26 nothing of it reached Jev's completion or grounding verdicts, so
 * a check could fail an answer for honoring a preference the owner had stated
 * ("the owner prefers X" looked like an unsupported specific). The primer is
 * remembered here per session, small, and handed to the verdicts as `memory`.
 * Process-local and bounded: it is a courtesy view, never a store of record.
 */
const MAX_SESSIONS = 200;
export const JUDGE_MEMORY_MAX_CHARS = 900;

const bySession = new Map<string, string>();

/** The facts block first (durable, owner-stated), then the rest, clipped. */
export function judgeMemoryView(primerText: string | undefined | null, maxChars = JUDGE_MEMORY_MAX_CHARS): string {
  const text = (primerText ?? '').trim();
  if (!text) return '';
  const blocks = text.split(/\n\s*\n/);
  const facts = blocks.filter((b) => /^\[REMEMBERED FACTS/i.test(b.trim()));
  const others = blocks.filter((b) => !/^\[REMEMBERED FACTS/i.test(b.trim()) && !/^\[MEMORY PRIMER\]/i.test(b.trim()) && !/^A .* memory search ran/i.test(b.trim()));
  const ordered = [...facts, ...others].join('\n\n').trim();
  if (ordered.length <= maxChars) return ordered;
  return `${ordered.slice(0, maxChars - 1).trimEnd()}…`;
}

export function rememberTurnMemoryForJudges(sessionId: string | undefined, primerText: string | undefined | null): void {
  if (!sessionId) return;
  const view = judgeMemoryView(primerText);
  if (!view) { bySession.delete(sessionId); return; }
  bySession.delete(sessionId);
  bySession.set(sessionId, view);
  while (bySession.size > MAX_SESSIONS) {
    const oldest = bySession.keys().next().value;
    if (oldest === undefined) break;
    bySession.delete(oldest);
  }
}

export function judgeMemoryFor(sessionId: string | undefined): string {
  return sessionId ? (bySession.get(sessionId) ?? '') : '';
}

export function _resetJudgeMemoryForTest(): void { bySession.clear(); }
