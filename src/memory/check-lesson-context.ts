/**
 * The lessons Clem learned from her checks (check-lessons.ts), at turn start.
 *
 * A lesson names a kind of work, not a subject, so the ranked recall that
 * answers "what is known about this" rarely surfaces it: topic facts outrank
 * it every time (live 2026-10-18), and the local embedding model cannot tell
 * a matching lesson from an unrelated one reliably enough to gate on. So the
 * few nearest lessons ride in their own short section, ranked by the same
 * scoped recall score memory uses for the request, and the model applies one
 * only when its situation matches. Each says it came from a check, never from
 * the owner. Lightweight on purpose: the prompt builder imports this.
 */
import { listActiveFacts } from './facts.js';

/** The prefix every kept lesson carries, so recall never presents it as
 *  something the owner said. */
export const CHECK_LESSON_PREFIX = 'Learned from a past check:';
const MAX_SHOWN = 5;
const MAX_SECTION_CHARS = 1_400;

export function isCheckLesson(text: string): boolean {
  return text.startsWith(CHECK_LESSON_PREFIX);
}

/** The section, or '' when there is no lesson to show. Never throws. */
export function renderCheckLessonsForContext(request: string, limit = MAX_SHOWN): string {
  let lessons: string[] = [];
  try {
    lessons = listActiveFacts({ kind: 'feedback', ranking: 'stanford', objective: request, limit: 1_000 })
      .map((fact) => fact.content)
      .filter(isCheckLesson)
      .map((text) => text.slice(CHECK_LESSON_PREFIX.length).trim())
      .filter(Boolean)
      .slice(0, Math.max(0, limit));
  } catch { return ''; }
  if (lessons.length === 0) return '';
  const lines: string[] = [];
  let size = 0;
  for (const lesson of lessons) {
    if (size + lesson.length + 3 > MAX_SECTION_CHARS) break;
    lines.push(`- ${lesson}`);
    size += lesson.length + 3;
  }
  return [
    '## Lessons From Past Checks',
    'Learned when a check caught a problem in earlier work; not said by the owner. Apply one only when its situation matches this request.',
    ...lines,
  ].join('\n');
}
