/**
 * The choices a question arrives with.
 *
 * `awaiting_user_input` projects up to eight suggested answers beside the
 * question. They become one-tap replies; typing stays open for anything else.
 * Only real, distinct, readable strings survive, so a malformed option can
 * never render as an empty or duplicate button.
 */

const MAX_OPTIONS = 8;
const MAX_OPTION_CHARS = 120;

export function readQuestionOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const text = entry.replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_OPTION_CHARS) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(text);
    if (options.length === MAX_OPTIONS) break;
  }
  return options;
}
